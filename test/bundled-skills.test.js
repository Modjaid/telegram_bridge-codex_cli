import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareVersions, installBundledSkills } from "../src/bundled-skills.js";

const root = mkdtempSync(path.join(tmpdir(), "bundled-skills-test-"));
const codexHome = mkdtempSync(path.join(tmpdir(), "codex-home-test-"));
try {
  const source = path.join(root, "bundled-skills", "configure-telegram-media");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "SKILL.md"), "test\n");
  writeFileSync(path.join(source, "VERSION"), "1.2.0\n");
  assert.equal(installBundledSkills(root, { codexHome })[0].action, "installed");
  assert.equal(installBundledSkills(root, { codexHome })[0].action, "unchanged");
  writeFileSync(path.join(source, "VERSION"), "1.3.0\n");
  assert.equal(installBundledSkills(root, { codexHome })[0].action, "updated");
  assert.equal(readFileSync(path.join(codexHome, "skills", "configure-telegram-media", "VERSION"), "utf8").trim(), "1.3.0");
  const projectSkill = path.join(root, "bundled-skills", "manage-telegram-projects");
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(path.join(projectSkill, "SKILL.md"), "test\n");
  writeFileSync(path.join(projectSkill, "VERSION"), "1.0.0\n");
  const projectResult = installBundledSkills(root, { codexHome }).find(item => item.name === "manage-telegram-projects");
  assert.equal(projectResult.action, "installed");
  assert.equal(readFileSync(path.join(codexHome, "skills", "manage-telegram-projects", "VERSION"), "utf8").trim(), "1.0.0");
  assert.equal(compareVersions("2.0.0", "1.9.9") > 0, true);
  console.log("bundled skill installer test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
}
