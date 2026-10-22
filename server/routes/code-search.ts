import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { JOB_PRIORITY, db, getJellyfinSettings, getSubscription, queueLibraryJob, queueMagnetJob, queueReleaseJob, rebuildSubscriptionProgress } from '../db.js';
import { getInspectionRules } from '../inspection-rules.js';
import { BUILTIN_GROUP_NAME, legacyMissavGroupName } from '../rule-groups.js';
import { normalizePayload } from '../subscription-payload.js';
import { findArchiveCodeMatches, replaceArchiveCodes } from '../archive-code-index.js';
import { buildMissavActressSubscriptionUrl, normalizeMissavActressIdentity, normalizeProductCode, productCodeKeys } from '../code-search-parser.js';
import { emitLive } from '../sse-hub.js';
import { webExecutor } from '../web-executor-client.js';

/**
 * 番号检索领域：按番号先查本地档案，没有命中再让执行引擎访问站点检索，
 * 并支持从检索结果直接订阅女优作品。
 *
 * 检索结果暂存在本进程内存里（15 分钟、最多 100 条），因为后续「女优」「磁力」
 * 两个动作要复用同一次检索的上下文；这些数据丢了只会让用户重新检索一次。
 */
export function registerCodeSearchRoutes(app: FastifyInstance) {
  type SearchRelease =
    | { status: 'found'; releaseDate: string }
    | { status: 'unavailable' | 'failed'; reason: string }
    | { status: 'pending' };
  type SearchMagnet =
    | { status: 'found'; value: string }
    | { status: 'not_found' | 'failed' | 'disabled'; reason: string }
    | { status: 'pending' };
  type CodeSearchSession = {
    id: string;
    code: string;
    title: string | null;
    detailUrl: string;
    releaseDate: SearchRelease;
    magnet: SearchMagnet;
    performers: Array<{ name: string; url: string }>;
    performerError: string | null;
    createdAt: number;
  };
  const codeSearchSessions = new Map<string, CodeSearchSession>();
  const codeSearchSessionTtlMs = 15 * 60_000;
  const codeSearchSessionLimit = 100;
  const codeSearchSubscriptionLocks = new Map<string, Promise<void>>();

  function rememberCodeSearchSession(session: Omit<CodeSearchSession, 'id' | 'createdAt'>) {
    const now = Date.now();
    for (const [id, item] of codeSearchSessions) if (now - item.createdAt > codeSearchSessionTtlMs) codeSearchSessions.delete(id);
    while (codeSearchSessions.size >= codeSearchSessionLimit) codeSearchSessions.delete(codeSearchSessions.keys().next().value!);
    const item: CodeSearchSession = { ...session, id: randomUUID(), createdAt: now };
    codeSearchSessions.set(item.id, item);
    return item;
  }

  function getCodeSearchSession(id: unknown) {
    if (typeof id !== 'string') return null;
    const session = codeSearchSessions.get(id);
    if (!session) return null;
    if (Date.now() - session.createdAt > codeSearchSessionTtlMs) { codeSearchSessions.delete(id); return null; }
    return session;
  }

  async function withCodeSearchSubscriptionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = codeSearchSubscriptionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    codeSearchSubscriptionLocks.set(key, current);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (codeSearchSubscriptionLocks.get(key) === current) codeSearchSubscriptionLocks.delete(key);
    }
  }

  app.post('/api/code-search', async (request, reply) => {
    const input = (request.body ?? {}) as { code?: unknown };
    const code = typeof input.code === 'string' ? normalizeProductCode(input.code) : null;
    if (!code) return reply.code(400).send({ error: '请输入有效番号，例如 MEYD-568 或 meyd568。' });
    const codeKey = code.toLowerCase();
    const matches = await findArchiveCodeMatches(db, [codeKey]);
    const ids = [...new Set(matches.map((row) => row.id))];
    // 结果最终只用前 100 条，所以这里也只取 100 行正文：a.content 是这批数据里
    // 最大的字段，按 500 行取回来再丢掉 400 行是纯浪费（单次请求可能多占几十 MB）。
    const archivedCandidates = ids.length ? await db.all<{
      id: number; content: string; archive_code: string | null; title: string | null; detail_url: string | null; first_seen_at: string;
      release_date: string | null; release_status: string; release_error: string | null;
      magnet_status: string; magnet_value: string | null; magnet_error: string | null;
      subscription_id: number; subscription_name: string; subscription_url: string;
    }>(`SELECT a.id, a.content, a.title, a.detail_url, a.first_seen_at, a.release_date, a.release_status, a.release_error,
        a.archive_code, a.magnet_status, a.magnet_value, a.magnet_error, s.id AS subscription_id, s.name AS subscription_name, s.url AS subscription_url
      FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id
      WHERE a.id IN (${ids.map(() => '?').join(', ')})
      ORDER BY a.first_seen_at DESC, a.id DESC LIMIT 100`, ids) : [];
    const archived = archivedCandidates.filter((item) => item.archive_code?.toLowerCase() === codeKey || productCodeKeys(item.content).includes(codeKey) || productCodeKeys(item.title ?? '').includes(codeKey)).slice(0, 100);
    if (archived.length) return { source: 'archive', code, items: archived };

    try {
      const result = await webExecutor.codeSearch(code, JOB_PRIORITY.manual);
      if (result.status === 'not_found') return { source: 'not_found', code: result.code };
      const film = result.film;
      const rules = getInspectionRules();
      const session = rememberCodeSearchSession({
        code: film.code,
        title: film.title,
        detailUrl: film.detailUrl,
        releaseDate: result.releaseDate,
        magnet: rules.magnet.enabled ? { status: 'pending' } : { status: 'disabled', reason: '磁力检索规则已停用。' },
        performers: film.performers,
        performerError: film.performerError
      });
      return {
        source: 'missav', searchId: session.id, code: session.code, title: session.title,
        detailUrl: session.detailUrl, releaseDate: session.releaseDate,
        magnet: session.magnet, performers: session.performers, performerError: session.performerError
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'MissAV 番号检索失败。' });
    }
  });

  app.post('/api/code-search/performers', async (request, reply) => {
    const input = (request.body ?? {}) as { archiveEntryId?: unknown };
    const archiveEntryId = Number(input.archiveEntryId);
    if (!Number.isInteger(archiveEntryId) || archiveEntryId < 1) return reply.code(400).send({ error: '档案记录标识无效。' });
    const item = await db.get<{
      id: number; content: string; title: string | null; detail_url: string | null;
      release_date: string | null; release_status: string; release_error: string | null;
      magnet_status: string; magnet_value: string | null; magnet_error: string | null;
    }>('SELECT id, content, title, detail_url, release_date, release_status, release_error, magnet_status, magnet_value, magnet_error FROM archive_entries WHERE id = ?', [archiveEntryId]);
    if (!item) return reply.code(404).send({ error: '内容档案记录不存在。' });
    if (!item.detail_url) return reply.code(409).send({ error: '这条档案没有详情页链接，无法读取女优信息。' });
    const code = normalizeProductCode(item.content);
    if (!code) return reply.code(409).send({ error: `档案内容“${item.content}”不是可检索番号。` });
    try {
      const performers = await webExecutor.performers(item.detail_url);
      const releaseDate: SearchRelease = item.release_status === 'found' && item.release_date
        ? { status: 'found', releaseDate: item.release_date }
        : item.release_status === 'unsearched' || item.release_status === 'pending'
          ? { status: 'pending' }
          : { status: item.release_status === 'failed' ? 'failed' : 'unavailable', reason: item.release_error || '没有可用的发行日期。' };
      const magnet: SearchMagnet = item.magnet_status === 'found' && item.magnet_value
        ? { status: 'found', value: item.magnet_value }
        : item.magnet_status === 'not_found'
          ? { status: 'not_found', reason: item.magnet_error || '没有找到磁力链接。' }
          : item.magnet_status === 'failed'
            ? { status: 'failed', reason: item.magnet_error || '磁力检索失败。' }
            : { status: 'pending' };
      const session = rememberCodeSearchSession({ code, title: item.title, detailUrl: item.detail_url, releaseDate, magnet, performers, performerError: performers.length ? null : '影片详情页没有找到“女优”字段或女优链接。' });
      return { searchId: session.id, performers, performerError: session.performerError };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : '无法读取影片详情页的女优信息。' });
    }
  });

  app.post('/api/code-search/magnet', async (request, reply) => {
    const input = (request.body ?? {}) as { searchId?: unknown; retry?: unknown };
    const session = getCodeSearchSession(input.searchId);
    if (!session) return reply.code(410).send({ error: '检索结果已过期，请重新检索番号。' });
    const rule = getInspectionRules().magnet;
    if (!rule.enabled) {
      session.magnet = { status: 'disabled', reason: '磁力检索规则已停用。' };
      return { magnet: session.magnet };
    }
    if (session.magnet.status !== 'pending' && !(input.retry === true && session.magnet.status === 'failed')) return { magnet: session.magnet };
    try {
      const result = await webExecutor.magnet(session.code, rule);
      session.magnet = result.status === 'found' ? { status: 'found', value: result.value } : { status: 'not_found', reason: result.reason };
      return { magnet: session.magnet };
    } catch (error) {
      session.magnet = { status: 'failed', reason: error instanceof Error ? error.message : '磁力检索失败。' };
      return { magnet: session.magnet };
    }
  });

  app.post('/api/code-search/subscribe', async (request, reply) => {
    const input = (request.body ?? {}) as { searchId?: unknown; actressUrl?: unknown };
    const session = getCodeSearchSession(input.searchId);
    if (!session) return reply.code(410).send({ error: '检索结果已过期，请重新检索番号。' });
    if (typeof input.actressUrl !== 'string') return reply.code(400).send({ error: '缺少女优链接。' });
    const actressIdentity = normalizeMissavActressIdentity(input.actressUrl);
    const performer = actressIdentity ? session.performers.find((item) => normalizeMissavActressIdentity(item.url) === actressIdentity) : undefined;
    if (!performer || !actressIdentity) return reply.code(400).send({ error: '该女优链接不属于本次影片检索结果，请重新读取女优信息。' });

    let actress: { name: string; profileUrl: string };
    try { actress = await webExecutor.actressName(performer.url); }
    catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : '无法读取女优页面名称。' }); }
    return withCodeSearchSubscriptionLock(actressIdentity, async () => {
      const subscriptionUrl = buildMissavActressSubscriptionUrl(performer.url);
      try {
      const existingUrls = await db.all<{ id: number; url: string; initial_scan_completed: number; initial_scan_run_id: string | null; pagination_selector: string | null; last_hash: string | null }>('SELECT id, url, initial_scan_completed, initial_scan_run_id, pagination_selector, last_hash FROM subscriptions');
      const duplicate = existingUrls.find((item) => {
        try {
          const url = new URL(item.url);
          return url.searchParams.get('filters') === 'individual' && normalizeMissavActressIdentity(item.url) === actressIdentity;
        } catch { return false; }
      });
      let presetValues: Awaited<ReturnType<typeof normalizePayload>> | null = null;
      let presetIdForNewSubscription: number | null = null;
      if (!duplicate) {
        const preset = await db.get<{
          id: number;
          selector: string; render_mode: string; content_source: string; attribute_name: string | null; match_pattern: string | null;
          title_selector: string | null; title_content_source: string; title_attribute_name: string | null; title_match_pattern: string | null;
          result_mode: string; interval_minutes: number; pagination_selector: string | null; pagination_parameter: string; pagination_match_pattern: string | null;
        }>("SELECT id, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern FROM subscription_presets ORDER BY CASE WHEN name IN (?, ?) THEN 0 ELSE 1 END, id ASC LIMIT 1", [BUILTIN_GROUP_NAME, legacyMissavGroupName]);
        if (!preset) return reply.code(409).send({ error: `找不到“${BUILTIN_GROUP_NAME}”规则组，请在检查规则中恢复该规则组后重试。` });
        presetValues = await normalizePayload({
          name: actress.name, url: subscriptionUrl, selector: preset.selector,
          renderMode: preset.render_mode === 'dynamic' ? 'dynamic' : 'static',
          contentSource: preset.content_source === 'attribute' ? 'attribute' : 'text',
          attributeName: preset.attribute_name ?? '', matchPattern: preset.match_pattern ?? '',
          titleSelector: preset.title_selector ?? '', titleContentSource: preset.title_content_source === 'attribute' ? 'attribute' : 'text',
          titleAttributeName: preset.title_attribute_name ?? '', titleMatchPattern: preset.title_match_pattern ?? '',
          resultMode: preset.result_mode === 'all' ? 'all' : 'first', intervalMinutes: preset.interval_minutes,
          scheduleType: 'hourly', scheduleIntervalHours: Math.max(1, Math.min(168, Math.round(preset.interval_minutes / 60))),
          isActive: true, paginationSelector: preset.pagination_selector ?? '', paginationParameter: preset.pagination_parameter ?? 'page',
          paginationMatchPattern: preset.pagination_match_pattern ?? ''
        });
        presetIdForNewSubscription = preset.id;
      }

      let fullScanBatchId: string | null = null;
      if (duplicate && !duplicate.initial_scan_completed && duplicate.pagination_selector) {
        const pendingBatch = await db.get<{ id: string }>(`SELECT id FROM full_scan_batches WHERE subscription_id = ? AND status = 'scanning' ORDER BY created_at DESC, id DESC LIMIT 1`, [duplicate.id]);
        fullScanBatchId = duplicate.initial_scan_run_id ?? pendingBatch?.id ?? randomUUID();
      } else if (!duplicate && presetValues?.paginationSelector) {
        fullScanBatchId = randomUUID();
      }

      const now = new Date().toISOString();
      const rules = getInspectionRules();
      const jellyfin = getJellyfinSettings();
      const result = await db.transaction(async (tx) => {
        let subscriptionId = duplicate?.id ?? 0;
        let created = false;
        if (!subscriptionId && presetValues) {
          const inserted = await tx.run(`INSERT INTO subscriptions
            (name, url, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, schedule_type, schedule_interval_hours, schedule_time, schedule_weekday, is_active, pagination_selector, pagination_parameter, pagination_match_pattern, rule_family, preset_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [actress.name, subscriptionUrl, presetValues.selector, presetValues.renderMode, presetValues.contentSource, presetValues.attributeName, presetValues.matchPattern, presetValues.titleSelector, presetValues.titleContentSource, presetValues.titleAttributeName, presetValues.titleMatchPattern, presetValues.resultMode, presetValues.interval, presetValues.scheduleType, presetValues.scheduleIntervalHours, presetValues.scheduleTime, presetValues.scheduleWeekday, presetValues.isActive, presetValues.paginationSelector, presetValues.paginationParameter, presetValues.paginationMatchPattern, 'missav', presetIdForNewSubscription, now, now]);
          subscriptionId = inserted.lastInsertRowid;
          created = true;
        }

        if (fullScanBatchId) {
          await tx.run(`INSERT INTO full_scan_batches (id, subscription_id, subscription_name, status, is_initial, page_count, scanned_count, archived_count, created_at)
            VALUES (?, ?, ?, 'scanning', ?, NULL, 0, 0, ?) ON CONFLICT (id) DO NOTHING`,
          [fullScanBatchId, subscriptionId, actress.name, duplicate?.last_hash ? 0 : 1, now]);
        }

        const existingCandidates = await findArchiveCodeMatches(tx, [session.code.toLowerCase()], subscriptionId, false);
        const existingEntry = existingCandidates[0];
        let archiveEntryId = existingEntry?.id ?? 0;
        const addedToArchive = !existingEntry;
        if (!existingEntry) {
          const useLibraryFirst = session.magnet.status === 'pending' && rules.magnet.enabled && jellyfin.enabled && jellyfin.libraryIds.length > 0 && jellyfin.skipMagnetWhenAvailable;
          const magnetStatus = session.magnet.status === 'found' ? 'found'
            : session.magnet.status === 'not_found' ? 'not_found'
              : session.magnet.status === 'failed' ? 'failed'
                : session.magnet.status === 'disabled' || !rules.magnet.enabled || useLibraryFirst ? 'unsearched' : 'pending';
          const releaseStatus = session.releaseDate.status === 'found' ? 'found'
            : session.releaseDate.status === 'pending' && rules.releaseDate.enabled ? 'pending'
              : session.releaseDate.status === 'failed' ? 'failed' : 'unavailable';
          const releaseError = session.releaseDate.status === 'found' ? null
            : session.releaseDate.status === 'pending' && !rules.releaseDate.enabled ? '发行日期检索规则已停用。'
              : session.releaseDate.status === 'pending' ? null : session.releaseDate.reason;
          const magnetError = session.magnet.status === 'found' ? null
            : session.magnet.status === 'pending' && !rules.magnet.enabled ? '磁力检索规则已停用。'
              : session.magnet.status === 'pending' && useLibraryFirst ? null
                : session.magnet.status === 'pending' ? null : session.magnet.reason;
          const inserted = await tx.run(`INSERT INTO archive_entries
            (subscription_id, content, title, archive_code, content_hash, first_seen_at, detail_url, release_date, release_status, release_checked_at, release_error, magnet_status, magnet_value, magnet_checked_at, magnet_error, auto_download_suppressed, jellyfin_status, full_scan_batch_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          [subscriptionId, session.code, session.title, session.code.toLowerCase(), createHash('sha256').update(session.code.toLowerCase()).digest('hex'), now, session.detailUrl,
            session.releaseDate.status === 'found' ? session.releaseDate.releaseDate : null, releaseStatus, releaseStatus === 'pending' ? null : now, releaseError,
            magnetStatus, session.magnet.status === 'found' ? session.magnet.value : null, magnetStatus === 'pending' ? null : now, magnetError,
            useLibraryFirst ? 'pending' : 'unconfigured', fullScanBatchId, now]);
          archiveEntryId = inserted.lastInsertRowid;
          await replaceArchiveCodes(tx, [{ id: archiveEntryId, subscription_id: subscriptionId, content: session.code, title: session.title }]);
          if (releaseStatus === 'pending') await queueReleaseJob(archiveEntryId, tx);
          if (useLibraryFirst) await queueLibraryJob(archiveEntryId, tx);
          else if (magnetStatus === 'pending') await queueMagnetJob(archiveEntryId, tx);
        } else if (fullScanBatchId) {
          await tx.run('UPDATE archive_entries SET full_scan_batch_id = ? WHERE id = ? AND full_scan_batch_id IS NULL', [fullScanBatchId, archiveEntryId]);
        }
        await rebuildSubscriptionProgress(subscriptionId, tx);
        return { subscriptionId, archiveEntryId, created, addedToArchive };
      });
      emitLive('subscriptions');
      emitLive('archive', result.subscriptionId);
      emitLive('tasks');
      const subscription = await getSubscription(result.subscriptionId);
      return reply.code(result.created ? 201 : 200).send({ ...result, subscription, actressName: actress.name });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建女优订阅。' });
      }
    });
  });
}
