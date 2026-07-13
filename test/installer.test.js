import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, renderSystemdUnit, resolveCommand } from "../src/cli.js";
import { resolveBridgePaths } from "../src/paths.js";

const originalHome = process.env.HOME;
const home = mkdtempSync(path.join(tmpdir(), "codex-telegram-bridge-test-"));
process.env.HOME = home;
delete process.env.CODEX_TELEGRAM_BRIDGE_HOME;
delete process.env.CODEX_TELEGRAM_BRIDGE_CONFIG;

try {
  const paths = resolveBridgePaths();
  assert.equal(paths.dataRoot, path.join(home, ".codex-telegram-bridge"));
  assert.equal(paths.projectsRoot, path.join(home, ".codex-telegram-bridge", "projects"));
  const unit = renderSystemdUnit(paths, "/opt/node/bin/node", "/opt/npm/bin/codex-telegram-bridge");
  assert.doesNotMatch(unit, /\/home\/agent\/codex-telegram-bridge/);
  assert.match(unit, /codex-telegram-bridge" run/);

  const output = [];
  await main(["configure"], { out: line => output.push(line), error: line => { throw new Error(line); } });
  assert.ok(existsSync(paths.configFile));
  assert.equal(statSync(paths.configFile).mode & 0o777, 0o600);
  const projectName = path.basename(home).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const defaultProject = path.join(paths.projectsRoot, projectName);
  assert.ok(existsSync(path.join(defaultProject, "AGENTS.md")));
  assert.equal(statSync(path.join(defaultProject, "AGENTS.md")).mode & 0o777, 0o600);
  const first = readFileSync(paths.configFile, "utf8");
  const codexBin = resolveCommand("codex");
  assert.ok(path.isAbsolute(codexBin), "test requires Codex CLI on PATH");
  assert.match(first, new RegExp(`CODEX_BIN=${codexBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(first, new RegExp(`PROJECT_CREATE_ROOT=${paths.projectsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(first, new RegExp(`PROJECT_ALLOWLIST=${defaultProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(first, new RegExp(`PROJECT_COMMANDS=${projectName}=${defaultProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  await main(["configure"], { out: line => output.push(line), error: line => { throw new Error(line); } });
  assert.equal(readFileSync(paths.configFile, "utf8"), first);

  await main(["uninstall"], { out: line => output.push(line), error: line => { throw new Error(line); } });
  assert.ok(existsSync(paths.dataRoot), "ordinary uninstall must preserve data");
  assert.ok(output.every(line => !/\d{6,}:[A-Za-z0-9_-]+/.test(line)), "output must not expose bot tokens");
  console.log("installer tests: OK");
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}
