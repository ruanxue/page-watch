import type { FastifyInstance } from 'fastify';
import { JOB_PRIORITY, appendRuntimeLog, db, getQbittorrentSettings, getSubscription, queueDownloadJob, queueMagnetJob, queueReleaseJob } from '../db.js';
import { getInspectionRules } from '../inspection-rules.js';
import { assertQbittorrentConfig, getQbittorrentTorrentStates, torrentHashFromMagnet } from '../qbittorrent.js';

/**
 * 归档领域：内容档案的查询、发行日期与磁力链接补全、以及把磁力提交给 qBittorrent。
 *
 * 这里只负责「入队」与状态回写；真正的抓取、检索和下载由后台 Worker 执行。
 * 订阅自身的增删改在 subscriptions 领域，规则配置在 rules 领域。
 */
export function registerArchiveRoutes(app: FastifyInstance) {
  app.get('/api/archive', async (request) => {
    const query = request.query as { subscriptionId?: string; page?: string; pageSize?: string; q?: string; releaseFrom?: string; releaseTo?: string };
    const subscriptionId = Number(query.subscriptionId);
    const hasSubscriptionId = Number.isInteger(subscriptionId) && subscriptionId > 0;
    const pageInput = Number(query.page ?? 1);
    const page = Number.isInteger(pageInput) ? Math.max(1, pageInput) : 1;
    const pageSizeInput = Number(query.pageSize ?? 50);
    const pageSize = Number.isInteger(pageSizeInput) ? Math.min(Math.max(pageSizeInput, 20), 200) : 50;
    const keyword = (query.q ?? '').trim().slice(0, 120);
    const releaseFrom = /^\d{4}-\d{2}-\d{2}$/.test(query.releaseFrom ?? '') ? query.releaseFrom! : '';
    const releaseTo = /^\d{4}-\d{2}-\d{2}$/.test(query.releaseTo ?? '') ? query.releaseTo! : '';
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (hasSubscriptionId) { clauses.push('a.subscription_id = ?'); params.push(subscriptionId); }
    // PostgreSQL 的 LIKE 区分大小写，这里用 ILIKE 保持原来「输入小写也能搜到」的行为。
    if (keyword) { clauses.push('(a.content ILIKE ? OR a.title ILIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (releaseFrom) { clauses.push('a.release_date >= ?'); params.push(releaseFrom); }
    if (releaseTo) { clauses.push('a.release_date <= ?'); params.push(releaseTo); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = await db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM archive_entries a ${where}`, params);
    const total = Number(totalRow?.total ?? 0);
    const items = await db.all(`SELECT a.id, a.content, a.title, a.detail_url, a.first_seen_at, a.release_date, a.release_status, a.release_error, a.magnet_status, a.magnet_value, a.magnet_checked_at, a.magnet_error,
        a.download_status, a.download_queued_at, a.download_added_at, a.download_torrent_hash, a.download_checked_at, a.download_error,
        a.download_progress, a.download_speed, a.download_size, a.downloaded_bytes, a.download_save_path, a.download_content_path, a.download_removed_at, a.download_filter_min_size_bytes,
        a.jellyfin_status, a.jellyfin_item_id, a.jellyfin_item_name, a.jellyfin_matched_at, a.jellyfin_error,
        s.id AS subscription_id, s.name AS subscription_name, s.url AS subscription_url
      FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id
      ${where}
      ORDER BY a.release_date IS NULL ASC, a.release_date DESC, a.id ASC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    return { items, total, page, pageSize };
  });

  app.post('/api/subscriptions/:id/magnet-backfill', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const subscription = await getSubscription(id);
    if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
    if (subscription.rule_family !== 'missav') return reply.code(400).send({ error: '此订阅不使用 MissAV 磁力规则。' });
    if (!getInspectionRules().magnet.enabled) return reply.code(400).send({ error: '磁力检索规则当前已停用，请先在“检查规则”中启用。' });
    const candidates = await db.all<{ id: number }>(`SELECT id FROM archive_entries
      WHERE subscription_id = ? AND magnet_status IN ('unsearched', 'failed', 'skipped') ORDER BY id ASC`, [id]);
    let queued = 0;
    await db.transaction(async (tx) => {
      for (const entry of candidates) {
        await tx.run(`UPDATE archive_entries
          SET magnet_status = 'pending', magnet_value = NULL, magnet_checked_at = NULL, magnet_error = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), entry.id]);
        if ((await queueMagnetJob(entry.id, tx, JOB_PRIORITY.manual)).queued) queued += 1;
      }
    });
    if (queued) {
      await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, message: `磁力检索补全已开始：${queued} 项已加入检索队列。` });
    }
    return reply.code(202).send({ queued, skipped: candidates.length - queued });
  });

  app.post('/api/subscriptions/:id/release-backfill', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const subscription = await getSubscription(id);
    if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
    if (subscription.rule_family !== 'missav') return reply.code(400).send({ error: '此订阅不使用 MissAV 发行日期规则。' });
    if (!getInspectionRules().releaseDate.enabled) return reply.code(400).send({ error: '发行日期规则当前已停用，请先在“检查规则”中启用。' });
    const candidates = await db.all<{ id: number }>(`SELECT id FROM archive_entries
      WHERE subscription_id = ? AND release_status IN ('unsearched', 'unavailable', 'failed') ORDER BY id ASC`, [id]);
    let queued = 0;
    await db.transaction(async (tx) => {
      for (const entry of candidates) {
        const now = new Date().toISOString();
        await tx.run(`UPDATE archive_entries
          SET release_date = NULL, release_status = 'pending', release_checked_at = NULL, release_error = NULL, updated_at = ? WHERE id = ?`, [now, entry.id]);
        if ((await queueReleaseJob(entry.id, tx, JOB_PRIORITY.manual)).queued) queued += 1;
      }
    });
    if (queued) {
      await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, message: `发行日期检索已开始：${queued} 项已加入读取队列。` });
    }
    return reply.code(202).send({ queued, skipped: candidates.length - queued });
  });

  app.post('/api/archive/:id/magnet-retry', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const entry = await db.get<{ id: number; subscription_id: number; content: string; magnet_status: string; subscription_name: string; rule_family: string }>(`SELECT a.id, a.subscription_id, a.content, a.magnet_status, s.name AS subscription_name, s.rule_family
      FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.id = ?`, [id]);
    if (!entry) return reply.code(404).send({ error: '归档内容不存在。' });
    if (entry.rule_family !== 'missav') return reply.code(400).send({ error: '此档案不使用 MissAV 磁力规则。' });
    if (!getInspectionRules().magnet.enabled) return reply.code(400).send({ error: '磁力检索规则当前已停用，请先在“检查规则”中启用。' });
    if (entry.magnet_status === 'found') return reply.code(409).send({ error: '该内容已找到磁力链接，无需重试。' });
    if (entry.magnet_status === 'pending') return reply.code(409).send({ error: '该内容正在检索中。' });
    let queued = false;
    let jobId = 0;
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE archive_entries SET magnet_status = 'pending', magnet_value = NULL, magnet_checked_at = NULL, magnet_error = NULL, updated_at = ?
        WHERE id = ?`, [new Date().toISOString(), entry.id]);
      const result = await queueMagnetJob(entry.id, tx, JOB_PRIORITY.manual);
      queued = result.queued;
      jobId = result.id;
    });
    await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: entry.subscription_id, message: queued ? `已重新加入“${entry.content}”的磁力检索队列。` : `“${entry.content}”已在磁力检索队列中。` });
    return reply.code(202).send({ queued, jobId });
  });

  async function ensureQbittorrentEnabled(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
    const settings = getQbittorrentSettings();
    if (!settings.enabled) {
      reply.code(409).send({ error: 'qBittorrent 下载尚未启用。请先在“下载设置”中完成配置。' });
      return null;
    }
    try { return assertQbittorrentConfig(settings); }
    catch (error) {
      reply.code(409).send({ error: error instanceof Error ? error.message : 'qBittorrent 配置不完整。' });
      return null;
    }
  }

  app.post('/api/subscriptions/:id/download-backfill', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const subscription = await getSubscription(id);
    if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
    if (!await ensureQbittorrentEnabled(reply)) return;
    const candidates = await db.all<{ id: number; download_status: string }>(`SELECT id, download_status FROM archive_entries
      WHERE subscription_id = ? AND magnet_status = 'found' AND magnet_value IS NOT NULL
        AND download_status IN ('not_queued', 'failed', 'filtered', 'removed') ORDER BY id ASC`, [id]);
    let queued = 0;
    await db.transaction(async (tx) => {
      for (const entry of candidates) {
        const result = await queueDownloadJob(entry.id, tx, JOB_PRIORITY.manual);
        if (result.queued) {
          queued += 1;
          const now = new Date().toISOString();
          if (entry.download_status === 'filtered') {
            await tx.run(`UPDATE archive_entries SET download_queued_at = ?,
              download_error = '已排队手动下载，将恢复种子内全部文件。', updated_at = ? WHERE id = ?`, [now, now, entry.id]);
          } else {
            await tx.run(`UPDATE archive_entries SET download_status = 'queued', download_queued_at = ?, download_error = NULL,
              download_filter_min_size_bytes = NULL, download_removed_at = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
          }
        }
      }
    });
    if (queued) await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, message: `已将 ${queued} 项磁力链接加入 qBittorrent 下载队列。` });
    return reply.code(202).send({ queued, skipped: candidates.length - queued });
  });

  app.post('/api/archive/:id/download', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const entry = await db.get<{ id: number; subscription_id: number; content: string; magnet_status: string; magnet_value: string | null; download_status: string; download_torrent_hash: string | null }>(
      'SELECT id, subscription_id, content, magnet_status, magnet_value, download_status, download_torrent_hash FROM archive_entries WHERE id = ?', [id]);
    if (!entry) return reply.code(404).send({ error: '归档内容不存在。' });
    if (!await ensureQbittorrentEnabled(reply)) return;
    if (entry.magnet_status !== 'found' || !entry.magnet_value) return reply.code(400).send({ error: '该内容尚未找到可用的磁力链接。' });
    if (entry.download_status === 'added') return reply.code(409).send({ error: '该内容已提交给 qBittorrent。' });
    if (entry.download_status === 'completed') {
      const hash = entry.download_torrent_hash || torrentHashFromMagnet(entry.magnet_value);
      if (hash) {
        try {
          if ((await getQbittorrentTorrentStates(getQbittorrentSettings(), [hash])).length) {
            return reply.code(409).send({ error: 'qBittorrent 中仍存在这个已完成的种子。请先在 qBittorrent 中删除种子，再点击下载。' });
          }
        } catch (error) {
          return reply.code(502).send({ error: error instanceof Error ? error.message : '无法确认 qBittorrent 中的种子状态。' });
        }
      }
    }
    let queued = false;
    let jobId = 0;
    await db.transaction(async (tx) => {
      const result = await queueDownloadJob(entry.id, tx, JOB_PRIORITY.manual);
      queued = result.queued;
      jobId = result.id;
      if (queued) {
        const now = new Date().toISOString();
        if (entry.download_status === 'filtered') {
          await tx.run(`UPDATE archive_entries SET download_queued_at = ?,
            download_error = '已排队手动下载，将恢复种子内全部文件。', updated_at = ? WHERE id = ?`, [now, now, entry.id]);
        } else {
          await tx.run(`UPDATE archive_entries SET download_status = 'queued', download_queued_at = ?, download_error = NULL,
            download_filter_min_size_bytes = NULL, download_removed_at = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
        }
      }
    });
    await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: entry.subscription_id, jobId, message: queued ? `已将“${entry.content}”加入 qBittorrent 下载队列。` : `“${entry.content}”已在 qBittorrent 下载队列中。` });
    return reply.code(202).send({ queued, jobId });
  });
}
