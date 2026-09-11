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
    active_subscription_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN subscription_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_jobs_status (status, requested_at),
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
    active_archive_entry_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_release_jobs_status (status, requested_at),
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
    active_archive_entry_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_magnet_jobs_status (status, requested_at),
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
    active_archive_entry_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('queued', 'running') THEN archive_entry_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    KEY idx_download_jobs_status (status, requested_at),
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
    last_seen_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (worker_name)
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
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_status', "VARCHAR(16) NOT NULL DEFAULT 'unconfigured'");
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_item_id', 'VARCHAR(64) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_item_name', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_matched_at', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'jellyfin_error', 'TEXT NULL');
  await addColumnIfMissing(pool, 'archive_entries', 'updated_at', "VARCHAR(40) NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
  await pool.query("UPDATE archive_entries SET updated_at = first_seen_at WHERE updated_at = '1970-01-01T00:00:00.000Z'");
  await addColumnIfMissing(pool, 'jobs', 'attempt_count', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'jobs', 'retry_after', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'magnet_jobs', 'attempt_count', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'magnet_jobs', 'retry_after', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'download_jobs', 'attempt_count', 'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing(pool, 'download_jobs', 'retry_after', 'VARCHAR(40) NULL');
  await addColumnIfMissing(pool, 'subscriptions', 'pagination_parameter', "VARCHAR(64) NOT NULL DEFAULT 'page'");
  await addColumnIfMissing(pool, 'subscriptions', 'pagination_match_pattern', 'VARCHAR(1024) NULL');
  await addColumnIfMissing(pool, 'subscription_presets', 'pagination_selector', 'TEXT NULL');
  await addColumnIfMissing(pool, 'subscription_presets', 'pagination_parameter', "VARCHAR(64) NOT NULL DEFAULT 'page'");
  await addColumnIfMissing(pool, 'subscription_presets', 'pagination_match_pattern', 'VARCHAR(1024) NULL');
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
