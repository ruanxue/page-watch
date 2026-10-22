import type { Pool } from 'pg';

/**
 * PostgreSQL 数据结构与索引。
 *
 * 「一个订阅/条目同时只能有一个在途任务」仍然靠生成列 + 唯一索引实现：
 * 唯一索引允许多条终态任务的生成列为 NULL。
 *
 * 每条语句都写成 IF NOT EXISTS，可重复执行；API 与执行引擎同时启动也不会冲突。
 */
export async function ensurePostgresSchema(pool: Pool) {
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      selector TEXT NOT NULL,
      render_mode VARCHAR(16) NOT NULL DEFAULT 'static',
      content_source VARCHAR(16) NOT NULL DEFAULT 'text',
      attribute_name VARCHAR(255) NULL,
      match_pattern VARCHAR(1024) NULL,
      title_selector TEXT NULL,
      title_content_source VARCHAR(16) NOT NULL DEFAULT 'text',
      title_attribute_name VARCHAR(255) NULL,
      title_match_pattern VARCHAR(1024) NULL,
      result_mode VARCHAR(16) NOT NULL DEFAULT 'first',
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      schedule_type VARCHAR(16) NOT NULL DEFAULT 'hourly',
      schedule_interval_hours INTEGER NOT NULL DEFAULT 1,
      schedule_time VARCHAR(5) NOT NULL DEFAULT '09:00',
      schedule_weekday SMALLINT NOT NULL DEFAULT 1,
      is_active SMALLINT NOT NULL DEFAULT 1,
      rule_family VARCHAR(32) NOT NULL DEFAULT 'legacy_custom',
      preset_id INTEGER NULL,
      render_mode_override VARCHAR(16) NULL,
      last_checked_at VARCHAR(40) NULL,
      last_hash CHAR(64) NULL,
      last_content TEXT NULL,
      last_error TEXT NULL,
      last_scan_added_count INTEGER NOT NULL DEFAULT 0,
      last_scan_seen_at VARCHAR(40) NULL,
      pagination_selector TEXT NULL,
      pagination_parameter VARCHAR(64) NOT NULL DEFAULT 'page',
      pagination_match_pattern VARCHAR(1024) NULL,
      initial_scan_completed SMALLINT NOT NULL DEFAULT 0,
      initial_scan_total INTEGER NULL,
      initial_scan_pages_completed INTEGER NOT NULL DEFAULT 0,
      initial_scan_run_id VARCHAR(64) NULL,
      initial_scan_next_page INTEGER NOT NULL DEFAULT 1,
      next_scheduled_at VARCHAR(40) NULL,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_active_schedule ON subscriptions (is_active, next_scheduled_at)`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_rule_group ON subscriptions (rule_family, preset_id)`,

    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      subscription_id INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      requested_at VARCHAR(40) NOT NULL,
      started_at VARCHAR(40) NULL,
      finished_at VARCHAR(40) NULL,
      error TEXT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_after VARCHAR(40) NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      active_subscription_id INTEGER GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN subscription_id ELSE NULL END) STORED
    )`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, requested_at)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs (status, priority, requested_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_subscription ON jobs (active_subscription_id)`,

    `CREATE TABLE IF NOT EXISTS runtime_logs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      level VARCHAR(16) NOT NULL,
      source VARCHAR(16) NOT NULL,
      subscription_id INTEGER NULL,
      job_id INTEGER NULL,
      message TEXT NOT NULL,
      created_at VARCHAR(40) NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_logs_subscription_id_id ON runtime_logs (subscription_id, id DESC)`,

    `CREATE TABLE IF NOT EXISTS archive_entries (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      subscription_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      title TEXT NULL,
      archive_code VARCHAR(32) NULL,
      content_hash CHAR(64) NOT NULL,
      first_seen_at VARCHAR(40) NOT NULL,
      detail_url TEXT NULL,
      release_date VARCHAR(10) NULL,
      release_status VARCHAR(16) NOT NULL DEFAULT 'unsearched',
      release_checked_at VARCHAR(40) NULL,
      release_error TEXT NULL,
      full_scan_batch_id VARCHAR(64) NULL,
      magnet_status VARCHAR(16) NOT NULL DEFAULT 'unsearched',
      magnet_value TEXT NULL,
      magnet_checked_at VARCHAR(40) NULL,
      magnet_error TEXT NULL,
      auto_download_suppressed SMALLINT NOT NULL DEFAULT 0,
      download_status VARCHAR(16) NOT NULL DEFAULT 'not_queued',
      download_completion_notified_at VARCHAR(40) NULL,
      download_queued_at VARCHAR(40) NULL,
      download_added_at VARCHAR(40) NULL,
      download_torrent_hash CHAR(40) NULL,
      download_checked_at VARCHAR(40) NULL,
      download_error TEXT NULL,
      download_progress DECIMAL(7,6) NULL,
      download_speed BIGINT NULL,
      download_size BIGINT NULL,
      downloaded_bytes BIGINT NULL,
      download_save_path TEXT NULL,
      download_content_path TEXT NULL,
      download_removed_at VARCHAR(40) NULL,
      download_filter_min_size_bytes BIGINT NULL,
      jellyfin_status VARCHAR(16) NOT NULL DEFAULT 'unconfigured',
      jellyfin_item_id VARCHAR(64) NULL,
      jellyfin_item_name TEXT NULL,
      jellyfin_matched_at VARCHAR(40) NULL,
      jellyfin_error TEXT NULL,
      updated_at VARCHAR(40) NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_subscription_hash ON archive_entries (subscription_id, content_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_archive_entries_seen ON archive_entries (first_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_archive_full_scan_batch ON archive_entries (full_scan_batch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_archive_entries_download_status ON archive_entries (download_status, id)`,
    `CREATE INDEX IF NOT EXISTS idx_archive_entries_release_status ON archive_entries (release_status, id)`,
    `CREATE INDEX IF NOT EXISTS idx_archive_entries_code ON archive_entries (archive_code)`,
    `CREATE INDEX IF NOT EXISTS idx_archive_release_status_id ON archive_entries (release_status, id)`,

    `CREATE TABLE IF NOT EXISTS archive_entry_codes (
      archive_entry_id INTEGER NOT NULL,
      subscription_id INTEGER NOT NULL,
      code VARCHAR(32) NOT NULL,
      PRIMARY KEY (archive_entry_id, code)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_archive_entry_codes_subscription ON archive_entry_codes (subscription_id, code, archive_entry_id)`,
    `CREATE INDEX IF NOT EXISTS idx_archive_entry_codes_code ON archive_entry_codes (code, archive_entry_id)`,

    `CREATE TABLE IF NOT EXISTS full_scan_batches (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      subscription_id INTEGER NOT NULL,
      subscription_name VARCHAR(255) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'scanning',
      is_initial SMALLINT NOT NULL DEFAULT 0,
      page_count INTEGER NULL,
      scanned_count INTEGER NULL,
      archived_count INTEGER NULL,
      created_at VARCHAR(40) NOT NULL,
      completed_at VARCHAR(40) NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_full_scan_batches_ready ON full_scan_batches (status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_full_scan_batches_subscription ON full_scan_batches (subscription_id, status, created_at)`,

    `CREATE TABLE IF NOT EXISTS subscription_progress (
      subscription_id INTEGER NOT NULL PRIMARY KEY,
      archive_total INTEGER NOT NULL DEFAULT 0,
      jellyfin_available INTEGER NOT NULL DEFAULT 0,
      release_total INTEGER NOT NULL DEFAULT 0,
      release_done INTEGER NOT NULL DEFAULT 0,
      magnet_total INTEGER NOT NULL DEFAULT 0,
      magnet_done INTEGER NOT NULL DEFAULT 0,
      library_total INTEGER NOT NULL DEFAULT 0,
      library_done INTEGER NOT NULL DEFAULT 0,
      download_total INTEGER NOT NULL DEFAULT 0,
      download_done INTEGER NOT NULL DEFAULT 0,
      updated_at VARCHAR(40) NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_subscription_progress_updated ON subscription_progress (updated_at)`,

    `CREATE TABLE IF NOT EXISTS release_jobs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      archive_entry_id INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      requested_at VARCHAR(40) NOT NULL,
      started_at VARCHAR(40) NULL,
      finished_at VARCHAR(40) NULL,
      error TEXT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_after VARCHAR(40) NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      active_archive_entry_id INTEGER GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED
    )`,
    `CREATE INDEX IF NOT EXISTS idx_release_jobs_status ON release_jobs (status, requested_at)`,
    `CREATE INDEX IF NOT EXISTS idx_release_jobs_priority ON release_jobs (status, priority, requested_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_release_jobs_active_entry ON release_jobs (active_archive_entry_id)`,

    `CREATE TABLE IF NOT EXISTS magnet_jobs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      archive_entry_id INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      requested_at VARCHAR(40) NOT NULL,
      started_at VARCHAR(40) NULL,
      finished_at VARCHAR(40) NULL,
      error TEXT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_after VARCHAR(40) NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      active_archive_entry_id INTEGER GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED
    )`,
    `CREATE INDEX IF NOT EXISTS idx_magnet_jobs_status ON magnet_jobs (status, requested_at)`,
    `CREATE INDEX IF NOT EXISTS idx_magnet_jobs_priority ON magnet_jobs (status, priority, requested_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_magnet_jobs_active_entry ON magnet_jobs (active_archive_entry_id)`,

    `CREATE TABLE IF NOT EXISTS download_jobs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      archive_entry_id INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      requested_at VARCHAR(40) NOT NULL,
      started_at VARCHAR(40) NULL,
      finished_at VARCHAR(40) NULL,
      error TEXT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_after VARCHAR(40) NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      active_archive_entry_id INTEGER GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED
    )`,
    `CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs (status, requested_at)`,
    `CREATE INDEX IF NOT EXISTS idx_download_jobs_priority ON download_jobs (status, priority, requested_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_download_jobs_active_entry ON download_jobs (active_archive_entry_id)`,

    `CREATE TABLE IF NOT EXISTS app_settings (
      "key" VARCHAR(255) NOT NULL PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS notification_outbox (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_type VARCHAR(32) NOT NULL,
      payload TEXT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at VARCHAR(40) NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      started_at VARCHAR(40) NULL,
      sent_at VARCHAR(40) NULL,
      failed_at VARCHAR(40) NULL,
      last_error TEXT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox (status, next_attempt_at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_notification_outbox_created ON notification_outbox (created_at DESC, id DESC)`,

    `CREATE TABLE IF NOT EXISTS notification_dedupes (
      dedupe_key CHAR(64) NOT NULL PRIMARY KEY,
      expires_at VARCHAR(40) NOT NULL,
      created_at VARCHAR(40) NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notification_dedupes_expiry ON notification_dedupes (expires_at)`,

    `CREATE TABLE IF NOT EXISTS subscription_presets (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      selector TEXT NOT NULL,
      render_mode VARCHAR(16) NOT NULL DEFAULT 'static',
      content_source VARCHAR(16) NOT NULL DEFAULT 'text',
      attribute_name VARCHAR(255) NULL,
      match_pattern VARCHAR(1024) NULL,
      title_selector TEXT NULL,
      title_content_source VARCHAR(16) NOT NULL DEFAULT 'text',
      title_attribute_name VARCHAR(255) NULL,
      title_match_pattern VARCHAR(1024) NULL,
      result_mode VARCHAR(16) NOT NULL DEFAULT 'first',
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      pagination_selector TEXT NULL,
      pagination_parameter VARCHAR(64) NOT NULL DEFAULT 'page',
      pagination_match_pattern VARCHAR(1024) NULL,
      is_active SMALLINT NOT NULL DEFAULT 1,
      sites_json TEXT NULL,
      steps_json TEXT NULL,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_subscription_presets_updated ON subscription_presets (updated_at DESC, id DESC)`,

    `CREATE TABLE IF NOT EXISTS worker_heartbeats (
      worker_name VARCHAR(64) NOT NULL PRIMARY KEY,
      status VARCHAR(16) NOT NULL,
      detail VARCHAR(255) NOT NULL,
      task_kind VARCHAR(32) NULL,
      subscription_id INTEGER NULL,
      archive_entry_id INTEGER NULL,
      task_content VARCHAR(255) NULL,
      progress_current INTEGER NULL,
      progress_total INTEGER NULL,
      progress_label VARCHAR(128) NULL,
      last_seen_at VARCHAR(40) NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS performance_metrics (
      granularity VARCHAR(8) NOT NULL,
      bucket_start TIMESTAMP NOT NULL,
      scope VARCHAR(32) NOT NULL,
      metric VARCHAR(64) NOT NULL,
      dimension VARCHAR(64) NOT NULL DEFAULT 'all',
      sample_count BIGINT NOT NULL DEFAULT 0,
      duration_ms BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (granularity, bucket_start, scope, metric, dimension)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_performance_metrics_range ON performance_metrics (granularity, bucket_start)`,
    `CREATE INDEX IF NOT EXISTS idx_performance_metrics_metric ON performance_metrics (metric, bucket_start)`,

    `CREATE TABLE IF NOT EXISTS runtime_metrics (
      metric_key VARCHAR(64) NOT NULL PRIMARY KEY,
      numeric_value BIGINT NULL,
      text_value VARCHAR(64) NULL,
      updated_at VARCHAR(40) NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS integration_status (
      service_name VARCHAR(32) NOT NULL PRIMARY KEY,
      status VARCHAR(16) NOT NULL,
      detail VARCHAR(255) NULL,
      checked_at VARCHAR(40) NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS initial_scan_items (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      subscription_id INTEGER NOT NULL,
      scan_id VARCHAR(64) NOT NULL,
      page_number INTEGER NOT NULL,
      item_position INTEGER NOT NULL,
      content TEXT NOT NULL,
      title TEXT NULL,
      detail_url TEXT NULL,
      content_hash CHAR(64) NOT NULL,
      created_at VARCHAR(40) NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_initial_scan_item_unique ON initial_scan_items (subscription_id, scan_id, content_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_initial_scan_item_order ON initial_scan_items (subscription_id, scan_id, page_number, item_position, id)`,

    `CREATE TABLE IF NOT EXISTS library_jobs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      archive_entry_id INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      requested_at VARCHAR(40) NOT NULL,
      started_at VARCHAR(40) NULL,
      finished_at VARCHAR(40) NULL,
      error TEXT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_after VARCHAR(40) NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      active_archive_entry_id INTEGER GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED
    )`,
    `CREATE INDEX IF NOT EXISTS idx_library_jobs_status ON library_jobs (status, requested_at)`,
    `CREATE INDEX IF NOT EXISTS idx_library_jobs_priority ON library_jobs (status, priority, requested_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_library_jobs_active_entry ON library_jobs (active_archive_entry_id)`,

    `CREATE TABLE IF NOT EXISTS library_sync_jobs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      trigger_type VARCHAR(16) NOT NULL DEFAULT 'scheduled',
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      requested_at VARCHAR(40) NOT NULL,
      started_at VARCHAR(40) NULL,
      heartbeat_at VARCHAR(40) NULL,
      finished_at VARCHAR(40) NULL,
      error TEXT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      progress_phase VARCHAR(32) NULL,
      progress_current INTEGER NULL,
      progress_total INTEGER NULL,
      progress_label VARCHAR(255) NULL,
      active_marker SMALLINT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN 1 ELSE NULL END) STORED
    )`,
    `CREATE INDEX IF NOT EXISTS idx_library_sync_jobs_priority ON library_sync_jobs (status, priority, requested_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_library_sync_jobs_active ON library_sync_jobs (active_marker)`,

    `CREATE TABLE IF NOT EXISTS jellyfin_media_items (
      item_id VARCHAR(64) NOT NULL PRIMARY KEY,
      library_id VARCHAR(128) NOT NULL,
      name TEXT NOT NULL,
      original_title TEXT NULL,
      media_path TEXT NULL,
      media_type VARCHAR(32) NOT NULL,
      sync_id CHAR(36) NOT NULL,
      synced_at VARCHAR(40) NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_jellyfin_media_items_library ON jellyfin_media_items (library_id, sync_id)`,

    `CREATE TABLE IF NOT EXISTS jellyfin_media_codes (
      item_id VARCHAR(64) NOT NULL,
      code VARCHAR(32) NOT NULL,
      PRIMARY KEY (item_id, code)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_jellyfin_media_codes_code ON jellyfin_media_codes (code)`
  ];

  for (const statement of statements) await pool.query(statement);

  await applyPostgresDataRepairs(pool);
}

/**
 * 历史数据修补：
 * 1. 早期版本写入的占位时间统一改成首次发现时间；
 * 2. 已完成下载的条目补上「已通知」时间，避免迁移后重复通知。
 */
async function applyPostgresDataRepairs(pool: Pool) {
  await pool.query(`UPDATE archive_entries SET updated_at = first_seen_at WHERE updated_at = '1970-01-01T00:00:00.000Z'`);
  await pool.query(`UPDATE archive_entries
    SET download_completion_notified_at = COALESCE(download_checked_at, download_added_at, updated_at, first_seen_at)
    WHERE download_status = 'completed' AND download_completion_notified_at IS NULL`);
}
