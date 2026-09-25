/**
 * Completion notifications belong to a download cycle, not to every observed
 * transition back into qBittorrent's completed state.
 */
export function shouldEnqueueDownloadCompletionNotification(
  previousStatus: string,
  nextStatus: string,
  notificationQueuedAt: string | null
) {
  return nextStatus === 'completed'
    && previousStatus !== 'completed'
    && notificationQueuedAt === null;
}
