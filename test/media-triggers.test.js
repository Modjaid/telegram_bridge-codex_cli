import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMediaTriggers } from "../src/media-triggers.js";

const root = mkdtempSync(path.join(tmpdir(), "media-triggers-test-"));
try {
  const skill = path.join(root, ".codex", "skills", "documents");
  mkdirSync(path.join(skill, "scripts"), { recursive: true });
  writeFileSync(path.join(skill, "telegram-media-trigger.json"), JSON.stringify({
    subscriptions: [{ id: "documents", projects: ["agent", "notes"], match: { extensions: [".pdf", ".apk"] }, run: "scripts/handle.js" }],
  }));
  const handler = path.join(skill, "scripts", "handle.js");
  writeFileSync(handler, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({status:'processed'})));\n");
  chmodSync(handler, 0o755);

  const results = await runMediaTriggers({
    projects: [{ alias: "agent", path: root }],
    sourceProject: { alias: "agent", path: root },
    record: { file: { originalFileName: "build.apk", mimeType: "application/octet-stream", mediaType: "document", sizeBytes: 5 } },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].subscriptionId, "documents");
  assert.equal(results[0].result.status, "processed");
  console.log("media trigger test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
