import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addTelegramMessageAlias, expireMediaItem, getMediaItem, peekMediaByTelegramMessage, upsertMediaRecord } from "../src/media-index.js";

const root = mkdtempSync(path.join(tmpdir(), "media-cache-test-"));
try {
  const filePath = path.join(root, "files", "event", "file.pdf");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "test");
  upsertMediaRecord(root, {
    mediaId: "tg_test",
    telegram: { chatId: "1", messageId: "2" },
    file: { path: filePath, relativePath: path.relative(root, filePath) },
    savedAt: new Date(0).toISOString(),
  });
  addTelegramMessageAlias(root, "tg_test", "1", "3");
  expireMediaItem(root, "tg_test");
  assert.equal(existsSync(filePath), false);
  assert.equal(getMediaItem(root, "tg_test", { sync: false }).file.expiredAt.length > 0, true);
  assert.equal(peekMediaByTelegramMessage(root, "1", "3").mediaId, "tg_test");
  console.log("media cache expiration test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
