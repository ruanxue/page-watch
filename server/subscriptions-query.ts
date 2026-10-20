import { db } from './db.js';

/**
 * 订阅列表的读模型：把订阅、规则组名称与各队列进度合成一次查询的结果。
 *
 * 运行中心需要用订阅名称做任务标签，订阅页直接展示这份数据，因此独立成模块，
 * 避免任一领域反向依赖另一个领域的路由文件。
 */
export async function listSubscriptions() {
  // 列表只回传展示需要的列：last_content 是上次抓取的完整正文，页面上并不使用，
  // 逐条回传会让列表接口多出几百 KB。这里显式列出字段，last_content 固定为 null
  // 以保持响应结构不变。新增订阅字段时记得同步补进这份清单。
  return db.all(`SELECT s.id, s.name, s.url, s.selector, s.render_mode, s.content_source, s.attribute_name,
    s.match_pattern, s.title_selector, s.title_content_source, s.title_attribute_name, s.title_match_pattern,
    s.result_mode, s.interval_minutes, s.schedule_type, s.schedule_interval_hours, s.schedule_time, s.schedule_weekday,
    s.is_active, s.rule_family, s.preset_id, s.render_mode_override, s.last_checked_at, s.last_hash,
    NULL AS last_content, s.last_error, s.last_scan_added_count, s.last_scan_seen_at,
    s.pagination_selector, s.pagination_parameter, s.pagination_match_pattern, s.initial_scan_completed,
    s.initial_scan_total, s.initial_scan_pages_completed, s.initial_scan_run_id, s.initial_scan_next_page,
    s.next_scheduled_at, s.created_at, s.updated_at,
    rule.name AS preset_name,
    COALESCE(p.archive_total, 0) AS archive_count,
    COALESCE(p.jellyfin_available, 0) AS jellyfin_available_count,
    JSON_OBJECT(
      'check', JSON_OBJECT('done', 0, 'total', (SELECT COUNT(*) FROM jobs j WHERE j.subscription_id = s.id AND j.status IN ('queued','running'))),
      'release', JSON_OBJECT('done', COALESCE(p.release_done, 0), 'total', COALESCE(p.release_total, 0)),
      'magnet', JSON_OBJECT('done', COALESCE(p.magnet_done, 0), 'total', COALESCE(p.magnet_total, 0)),
      'library', JSON_OBJECT('done', COALESCE(p.library_done, 0), 'total', COALESCE(p.library_total, 0)),
      'download', JSON_OBJECT('done', COALESCE(p.download_done, 0), 'total', COALESCE(p.download_total, 0))
    ) AS queue_summary,
    CASE
      WHEN s.pagination_selector IS NOT NULL
        AND s.initial_scan_completed = 0
        AND (s.initial_scan_run_id IS NOT NULL OR EXISTS(SELECT 1 FROM jobs j WHERE j.subscription_id = s.id AND j.status IN ('queued', 'running')))
      THEN 1 ELSE NULL
    END AS full_scan_active
    FROM subscriptions s
    LEFT JOIN subscription_presets rule ON rule.id = s.preset_id
    LEFT JOIN subscription_progress p ON p.subscription_id = s.id
    ORDER BY s.id ASC`);
}
