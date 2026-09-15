import type { Pool, RowDataPacket } from 'mysql2/promise';

/** Create the MySQL schema shared by the API and background workers. */
export async function ensureMySqlSchema(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INT NOT NULL AUTO_INCREMENT,
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
    interval_minutes INT NOT NULL DEFAULT 60,
    schedule_type VARCHAR(16) NOT NULL DEFAULT 'hourly',
    schedule_interval_hours INT NOT NULL DEFAULT 1,
    schedule_time VARCHAR(5) NOT NULL DEFAULT '09:00',
    schedule_weekday TINYINT NOT NULL DEFAULT 1,
    is_active TINYINT NOT NULL DEFAULT 1,
    last_checked_at VARCHAR(40) NULL,
    last_hash CHAR(64) NULL,
    last_content MEDIUMTEXT NULL,
    last_error TEXT NULL,
    pagination_selector TEXT NULL,
    pagination_parameter VARCHAR(64) NOT NULL DEFAULT 'page',
    pagination_match_pattern VARCHAR(1024) NULL,
    initial_scan_completed TINYINT NOT NULL DEFAULT 0,
    initial_scan_total INT NULL,
    initial_scan_pages_completed INT NOT NULL DEFAULT 0,
    initial_scan_run_id VARCHAR(64) NULL,
    initial_scan_next_page INT NOT NULL DEFAULT 1,
    next_scheduled_at VARCHAR(40) NULL,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS jobs (
    id INT NOT NULL AUTO_INCREMENT,
    subscription_id INT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    requested_at VARCHAR(40) NOT NULL,
    started_at VARCHAR(40) NULL,
    finished_at VARCHAR(40) NULL,
    error TEXT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    retry_after VARCHAR(40) NULL,
    priority INT NOT NULL DEFAULT 0,
    active_subscription_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN subscription_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_jobs_status (status, requested_at),
    KEY idx_jobs_priority (status, priority, requested_at),
    UNIQUE KEY idx_jobs_active_subscription (active_subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS runtime_logs (
    id INT NOT NULL AUTO_INCREMENT,
    level VARCHAR(16) NOT NULL,
    source VARCHAR(16) NOT NULL,
    subscription_id INT NULL,
    job_id INT NULL,
    message TEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_runtime_logs_subscription_id_id (subscription_id, id DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS archive_entries (
    id INT NOT NULL AUTO_INCREMENT,
    subscription_id INT NOT NULL,
    content TEXT NOT NULL,
    title TEXT NULL,
    content_hash CHAR(64) NOT NULL,
    first_seen_at VARCHAR(40) NOT NULL,
    detail_url TEXT NULL,
    release_date VARCHAR(10) NULL,
    release_status VARCHAR(16) NOT NULL DEFAULT 'unsearched',
    release_checked_at VARCHAR(40) NULL,
    release_error TEXT NULL,
    magnet_status VARCHAR(16) NOT NULL DEFAULT 'unsearched',
    magnet_value MEDIUMTEXT NULL,
    magnet_checked_at VARCHAR(40) NULL,
    magnet_error TEXT NULL,
    download_status VARCHAR(16) NOT NULL DEFAULT 'not_queued',
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
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY idx_archive_subscription_hash (subscription_id, content_hash),
    KEY idx_archive_entries_seen (first_seen_at DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS release_jobs (
    id INT NOT NULL AUTO_INCREMENT,
    archive_entry_id INT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    requested_at VARCHAR(40) NOT NULL,
    started_at VARCHAR(40) NULL,
    finished_at VARCHAR(40) NULL,
    error TEXT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    retry_after VARCHAR(40) NULL,
    priority INT NOT NULL DEFAULT 0,
    active_archive_entry_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_release_jobs_status (status, requested_at),
    KEY idx_release_jobs_priority (status, priority, requested_at),
    UNIQUE KEY idx_release_jobs_active_entry (active_archive_entry_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS magnet_jobs (
    id INT NOT NULL AUTO_INCREMENT,
    archive_entry_id INT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    requested_at VARCHAR(40) NOT NULL,
    started_at VARCHAR(40) NULL,
    finished_at VARCHAR(40) NULL,
    error TEXT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    retry_after VARCHAR(40) NULL,
    priority INT NOT NULL DEFAULT 0,
    active_archive_entry_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_magnet_jobs_status (status, requested_at),
    KEY idx_magnet_jobs_priority (status, priority, requested_at),
    UNIQUE KEY idx_magnet_jobs_active_entry (active_archive_entry_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS download_jobs (
    id INT NOT NULL AUTO_INCREMENT,
    archive_entry_id INT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    requested_at VARCHAR(40) NOT NULL,
    started_at VARCHAR(40) NULL,
    finished_at VARCHAR(40) NULL,
    error TEXT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    retry_after VARCHAR(40) NULL,
    priority INT NOT NULL DEFAULT 0,
    active_archive_entry_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_download_jobs_status (status, requested_at),
    KEY idx_download_jobs_priority (status, priority, requested_at),
    UNIQUE KEY idx_download_jobs_active_entry (active_archive_entry_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    \`key\` VARCHAR(255) NOT NULL,
    value MEDIUMTEXT NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (\`key\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS subscription_presets (
    id INT NOT NULL AUTO_INCREMENT,
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
    interval_minutes INT NOT NULL DEFAULT 60,
    pagination_selector TEXT NULL,
    pagination_parameter VARCHAR(64) NOT NULL DEFAULT 'page',
    pagination_match_pattern VARCHAR(1024) NULL,
    is_active TINYINT NOT NULL DEFAULT 1,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_subscription_presets_updated (updated_at DESC, id DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_name VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    detail VARCHAR(255) NOT NULL,
    task_kind VARCHAR(32) NULL,
    subscription_id INT NULL,
    archive_entry_id INT NULL,
    task_content VARCHAR(255) NULL,
    progress_current INT NULL,
    progress_total INT NULL,
    progress_label VARCHAR(128) NULL,
    last_seen_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (worker_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Compact, aggregate-only operational telemetry. No task payloads, URLs,
  // credentials or raw external errors are kept in these long-lived rows.
  await pool.query(`CREATE TABLE IF NOT EXISTS performance_metrics (
    granularity VARCHAR(8) NOT NULL,
    bucket_start DATETIME NOT NULL,
    scope VARCHAR(32) NOT NULL,
    metric VARCHAR(64) NOT NULL,
    dimension VARCHAR(64) NOT NULL DEFAULT 'all',
    sample_count BIGINT NOT NULL DEFAULT 0,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (granularity, bucket_start, scope, metric, dimension),
    KEY idx_performance_metrics_range (granularity, bucket_start),
    KEY idx_performance_metrics_metric (metric, bucket_start)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // External services never determine Docker readiness, but their most recent
  // safe-to-display status lets the UI distinguish a disabled integration from
  // a configured service that has recently failed.
  await pool.query(`CREATE TABLE IF NOT EXISTS integration_status (
    service_name VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL,
    detail VARCHAR(255) NULL,
    checked_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (service_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // A full scan is deliberately invisible until every page has succeeded.
  // These rows are its durable checkpoint, so a retried job can continue at
  // the next page without re-reading completed pages.
  await pool.query(`CREATE TABLE IF NOT EXISTS initial_scan_items (
    id BIGINT NOT NULL AUTO_INCREMENT,
    subscription_id INT NOT NULL,
    scan_id VARCHAR(64) NOT NULL,
    page_number INT NOT NULL,
    item_position INT NOT NULL,
    content TEXT NOT NULL,
    title TEXT NULL,
    detail_url TEXT NULL,
    content_hash CHAR(64) NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY idx_initial_scan_item_unique (subscription_id, scan_id, content_hash),
    KEY idx_initial_scan_item_order (subscription_id, scan_id, page_number, item_position, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS library_jobs (
    id INT NOT NULL AUTO_INCREMENT,
    archive_entry_id INT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    requested_at VARCHAR(40) NOT NULL,
    started_at VARCHAR(40) NULL,
    finished_at VARCHAR(40) NULL,
    error TEXT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    retry_after VARCHAR(40) NULL,
    priority INT NOT NULL DEFAULT 0,
    active_archive_entry_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_library_jobs_status (status, requested_at),
    KEY idx_library_jobs_priority (status, priority, requested_at),
    UNIQUE KEY idx_library_jobs_active_entry (active_archive_entry_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Jellyfin is an external service. Keep a compact local mirror of the
  // selected libraries' searchable metadata so new archive entries can be
  // matched with indexed MySQL lookups instead of one remote API search each.
  await pool.query(`CREATE TABLE IF NOT EXISTS jellyfin_media_items (
    item_id VARCHAR(64) NOT NULL,
    library_id VARCHAR(128) NOT NULL,
    name TEXT NOT NULL,
    original_title TEXT NULL,
    media_path TEXT NULL,
    media_type VARCHAR(32) NOT NULL,
    sync_id CHAR(36) NOT NULL,
    synced_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (item_id),
    KEY idx_jellyfin_media_items_library (library_id, sync_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS jellyfin_media_codes (
    item_id VARCHAR(64) NOT NULL,
    code VARCHAR(32) NOT NULL,
    PRIMARY KEY (item_id, code),
    KEY idx_jellyfin_media_codes_code (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // CREATE TABLE IF NOT EXISTS does not amend an existing table, so add newer
  // archive fields safely for installations created by earlier releases.
  await addColumnIfMissing(pool, 'archive_entries', 'detail_url', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'release_date', 'VARCHAR(10) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'release_status', "VARCHAR(16) NOT NULL DEFAULT 'unsearched'");
  await addColumnIfMissing(pool, 'archive_entries', 'release_checked_at', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'release_error', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_status', "VARCHAR(16) NOT NULL DEFAULT 'not_queued'");
  await addColumnIfMissing(pool, 'archive_entries', 'download_queued_at', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_added_at', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_torrent_hash', 'CHAR(40) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_checked_at', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_error', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_progress', 'DECIMAL(7,6) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_speed', 'BIGINT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_size', 'BIGINT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'downloaded_bytes', 'BIGINT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_save_path', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_content_path', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_removed_at', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'download_filter_min_size_bytes', 'BIGINT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_status', "VARCHAR(16) NOT NULL DEFAULT 'unconfigured'");
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_item_id', 'VARCHAR(64) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_item_name', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_matched_at', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_error', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'updated_at', "VARCHAR(40) NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
  await pool.query("UPDATE archive_entries SET updated_at = first_seen_at WHERE updated_at = '1970-01-01T00:00:00.000Z'");
  await addColumnIfMissing(pool, 'jobs', 'attempt_count', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'jobs', 'retry_after', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'jobs', 'priority', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'release_jobs', 'attempt_count', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'release_jobs', 'retry_after', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'release_jobs', 'priority', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'magnet_jobs', 'attempt_count', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'magnet_jobs', 'retry_after', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'magnet_jobs', 'priority', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'download_jobs', 'attempt_count', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'download_jobs', 'retry_after', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'download_jobs', 'priority', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'subscriptions', 'initial_scan_run_id', 'VARCHAR(64) NULL');
  await addColumnIfMissing(pool, 'subscriptions', 'initial_scan_next_page', 'INT NOT NULL DEFAULT 1');
  await addColumnIfMissing(pool, 'subscriptions', 'next_scheduled_at', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'subscriptions', 'pagination_parameter', "VARCHAR(64) NOT NULL DEFAULT 'page'");
  await addColumnIfMissing(pool, 'subscriptions', 'pagination_match_pattern', 'VARCHAR(1024) NULL');
  await addColumnIfMissing(pool, 'worker_heartbeats', 'task_kind', 'VARCHAR(32) NULL');
  await addColumnIfMissing(pool, 'worker_heartbeats', 'subscription_id', 'INT NULL');
  await addColumnIfMissing(pool, 'worker_heartbeats', 'archive_entry_id', 'INT NULL');
  await addColumnIfMissing(pool, 'worker_heartbeats', 'task_content', 'VARCHAR(255) NULL');
  await addColumnIfMissing(pool, 'worker_heartbeats', 'progress_current', 'INT NULL');
  await addColumnIfMissing(pool, 'worker_heartbeats', 'progress_total', 'INT NULL');
  await addColumnIfMissing(pool, 'worker_heartbeats', 'progress_label', 'VARCHAR(128) NULL');
  await addColumnIfMissing(pool, 'subscription_presets', 'pagination_selector', 'TEXT NULL');
  await addColumnIfMissing(pool, 'subscription_presets', 'pagination_parameter', "VARCHAR(64) NOT NULL DEFAULT 'page'");
  await addColumnIfMissing(pool, 'subscription_presets', 'pagination_match_pattern', 'VARCHAR(1024) NULL');

  // Index creation is safe when API and workers boot together.
  await addIndexIfMissing(pool, 'jobs', 'idx_jobs_priority', 'KEY idx_jobs_priority (status, priority, requested_at)');
  await addIndexIfMissing(pool, 'release_jobs', 'idx_release_jobs_priority', 'KEY idx_release_jobs_priority (status, priority, requested_at)');
  await addIndexIfMissing(pool, 'magnet_jobs', 'idx_magnet_jobs_priority', 'KEY idx_magnet_jobs_priority (status, priority, requested_at)');
  await addIndexIfMissing(pool, 'download_jobs', 'idx_download_jobs_priority', 'KEY idx_download_jobs_priority (status, priority, requested_at)');
}

async function addColumnIfMissing(pool: Pool, table: string, column: string, definition: string) {
  const [rows] = await pool.query<(RowDataPacket & { present: number })[]>(`SELECT COUNT(*) AS present
    FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  if (Number(rows[0]?.present ?? 0) === 0) {
    try {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    } catch (error) {
      // API and the three workers may boot simultaneously in Docker. A second
      // process racing to add the same migration is harmless.
      if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error;
    }
  }
}

async function addIndexIfMissing(pool: Pool, table: string, index: string, definition: string) {
  const [rows] = await pool.query<(RowDataPacket & { present: number })[]>(`SELECT COUNT(*) AS present
    FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index]);
  if (Number(rows[0]?.present ?? 0) > 0) return;
  try { await pool.query(`ALTER TABLE \`${table}\` ADD ${definition}`); }
  catch (error) { if ((error as { code?: string }).code !== 'ER_DUP_KEYNAME') throw error; }
}
