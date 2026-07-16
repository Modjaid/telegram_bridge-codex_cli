export const LIVE_PROGRESS_DELETE_DELAY_MS = 60_000;

export function retainLiveProgress(live, clearTimer = clearTimeout) {
  if (!live) return;
  live.keepLogs = true;
  if (live.deleteTimer) clearTimer(live.deleteTimer);
  live.deleteTimer = null;
}

export function scheduleLiveProgressDeletion(live, options) {
  const {
    deleteMessage,
    onSettled = () => {},
    delayMs = LIVE_PROGRESS_DELETE_DELAY_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options || {};

  if (!live || live.keepLogs || live.target?.adapter !== "telegram" || !live.target.chatId || !live.messageId) {
    return false;
  }
  if (typeof deleteMessage !== "function") throw new Error("deleteMessage is required");
  if (live.deleteTimer) clearTimer(live.deleteTimer);

  live.deleteTimer = setTimer(async () => {
    live.deleteTimer = null;
    if (live.keepLogs) return;
    try {
      await deleteMessage(live.target.chatId, live.messageId);
    } finally {
      onSettled(live);
    }
  }, delayMs);
  live.deleteTimer?.unref?.();
  return true;
}
