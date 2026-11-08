// 调度器与实际处理器共用筛选条件，避免把不能处理的数据反复唤醒。
export const legacyReleasePredicate = `s.rule_family = 'missav' AND (a.release_status = 'unsearched'
  OR (a.release_status = 'unavailable' AND a.release_error = '详情页未找到标签“发行日期”对应的日期值。'))`;

export const readyFullScanBatchPredicate = `b.status = 'processing'
  AND NOT EXISTS(SELECT 1 FROM archive_entries a JOIN release_jobs j ON j.archive_entry_id = a.id WHERE a.full_scan_batch_id = b.id AND j.status IN ('queued','running'))
  AND NOT EXISTS(SELECT 1 FROM archive_entries a JOIN magnet_jobs j ON j.archive_entry_id = a.id WHERE a.full_scan_batch_id = b.id AND j.status IN ('queued','running'))
  AND NOT EXISTS(SELECT 1 FROM archive_entries a JOIN library_jobs j ON j.archive_entry_id = a.id WHERE a.full_scan_batch_id = b.id AND j.status IN ('queued','running'))`;
