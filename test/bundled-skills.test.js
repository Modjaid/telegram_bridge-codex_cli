import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareVersions, installBundledSkills } from "../src/bundled-skills.js";

const root = mkdtempSync(path.join(tmpdir(), "bundled-skills-test-"));
const codexHome = mkdtempSync(path.join(tmpdir(), "codex-home-test-"));
try {
  const source = path.join(root, "bundled-skills", "codex-telegram-bridge");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "SKILL.md"), "test\n");
  writeFileSync(path.join(source, "VERSION"), "1.0.0\n");

  assert.equal(installBundledSkills(root, { codexHome })[0].action, "installed");
  assert.equal(installBundledSkills(root, { codexHome })[0].action, "unchanged");
  writeFileSync(path.join(source, "VERSION"), "1.1.0\n");
  assert.equal(installBundledSkills(root, { codexHome })[0].action, "updated");
  assert.equal(readFileSync(path.join(codexHome, "skills", "codex-telegram-bridge", "VERSION"), "utf8").trim(), "1.1.0");

  const retiredMedia = path.join(codexHome, "skills", "configure-telegram-media");
  mkdirSync(retiredMedia, { recursive: true });
  writeFileSync(path.join(retiredMedia, "SKILL.md"), "legacy\n");
  writeFileSync(path.join(retiredMedia, "VERSION"), "1.1.0\n");
  const mediaResult = installBundledSkills(root, { codexHome }).find(item => item.name === "configure-telegram-media");
  assert.equal(mediaResult.action, "retired");
  assert.equal(existsSync(retiredMedia), false);

  const newerProject = path.join(codexHome, "skills", "manage-telegram-projects");
  mkdirSync(newerProject, { recursive: true });
  writeFileSync(path.join(newerProject, "SKILL.md"), "custom newer skill\n");
  writeFileSync(path.join(newerProject, "VERSION"), "2.0.0\n");
  const projectResult = installBundledSkills(root, { codexHome }).find(item => item.name === "manage-telegram-projects");
  assert.equal(projectResult.action, "preserved-newer");
  assert.equal(existsSync(newerProject), true);

  assert.equal(compareVersions("2.0.0", "1.9.9") > 0, true);
  console.log("bundled skill installer test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
}
