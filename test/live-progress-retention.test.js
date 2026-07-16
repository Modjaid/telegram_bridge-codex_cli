import assert from "node:assert/strict";
import {
  LIVE_PROGRESS_DELETE_DELAY_MS,
  retainLiveProgress,
  scheduleLiveProgressDeletion,
} from "../src/live-progress-retention.js";

assert.equal(LIVE_PROGRESS_DELETE_DELAY_MS, 60_000);

let callback;
let scheduledDelay;
let deleted;
let settled = false;
const live = { target: { adapter: "telegram", chatId: 10 }, messageId: 20 };
assert.equal(scheduleLiveProgressDeletion(live, {
  deleteMessage: async (chatId, messageId) => { deleted = [chatId, messageId]; },
  onSettled: () => { settled = true; },
  setTimer: (fn, delay) => { callback = fn; scheduledDelay = delay; return { unref() {} }; },
}), true);
assert.equal(scheduledDelay, 60_000);
await callback();
assert.deepEqual(deleted, [10, 20]);
assert.equal(settled, true);

let cleared = false;
let retainedCallback;
const retained = { target: { adapter: "telegram", chatId: 11 }, messageId: 21 };
scheduleLiveProgressDeletion(retained, {
  deleteMessage: async () => assert.fail("retained logs must not be deleted"),
  setTimer: fn => { retainedCallback = fn; return 123; },
});
retainLiveProgress(retained, timer => { assert.equal(timer, 123); cleared = true; });
assert.equal(cleared, true);
assert.equal(retained.keepLogs, true);
await retainedCallback();

assert.equal(scheduleLiveProgressDeletion({
  keepLogs: true,
  target: { adapter: "telegram", chatId: 12 },
  messageId: 22,
}, { deleteMessage: async () => {} }), false);

console.log("live progress retention tests passed");
