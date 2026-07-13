import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "codex-telegram-project-manager-test-"));
const projectsRoot = path.join(root, "projects");
const keepProject = path.join(projectsRoot, "keep");
const deleteProject = path.join(projectsRoot, "delete_me");
const configFile = path.join(root, "config.env");

mkdirSync(keepProject, { recursive: true });
mkdirSync(path.join(deleteProject, "nested"), { recursive: true });
writeFileSync(path.join(deleteProject, "nested", "data.txt"), "project data\n");
writeFileSync(configFile, [
  `PROJECT_CREATE_ROOT=${projectsRoot}`,
  `PROJECT_ALLOWLIST=${keepProject},${deleteProject}`,
  `PROJECT_COMMANDS=keep=${keepProject},delete_me=${deleteProject}`,
  "",
].join("\n"));

const stdout = execFileSync(path.resolve("scripts/project-manager"), [
  "delete",
  "--name",
  "delete_me",
  "--root",
  projectsRoot,
], {
  cwd: path.resolve("."),
  encoding: "utf8",
  env: { ...process.env, CODEX_TELEGRAM_BRIDGE_CONFIG: configFile },
});
const result = JSON.parse(stdout);

assert.equal(result.action, "deleted");
assert.equal(result.folderRemoved, true);
assert.equal(existsSync(deleteProject), false, "delete must recursively remove the project folder");
assert.equal(existsSync(keepProject), true, "delete must preserve other projects");

const config = readFileSync(configFile, "utf8");
assert.match(config, new RegExp(`PROJECT_ALLOWLIST=${escapeRegex(keepProject)}(?:\\n|$)`));
assert.match(config, new RegExp(`PROJECT_COMMANDS=keep=${escapeRegex(keepProject)}(?:\\n|$)`));
assert.doesNotMatch(config, /delete_me/);

console.log("project-manager tests: OK");

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
