import { isQbittorrentDownloadPaused, type QbittorrentTorrentState } from './qbittorrent.js';

/**
 * A size-filtered waiting torrent can be paused while its magnet metadata is
 * still unavailable. Persist that pause so it can be checked at low frequency.
 */
export function shouldColdPauseSizeFilteredWaiting(
  status: string,
  minimumBytes: number,
  torrent: QbittorrentTorrentState,
  filesAvailable: boolean
) {
  return status === 'waiting'
    && Number.isFinite(minimumBytes)
    && minimumBytes > 0
    && !filesAvailable
    && isQbittorrentDownloadPaused(torrent);
}
