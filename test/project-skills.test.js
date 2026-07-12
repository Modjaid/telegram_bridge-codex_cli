import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listProjectSkills, projectSessionStartedText } from "../src/project-skills.js";

const project = mkdtempSync(path.join(tmpdir(), "project-skills-test-"));

try {
  mkdirSync(path.join(project, ".codex", "skills", "zebra"), { recursive: true });
  mkdirSync(path.join(project, ".codex", "skills", "alpha"), { recursive: true });
  mkdirSync(path.join(project, ".codex", "skills", "not-a-skill"), { recursive: true });
  writeFileSync(path.join(project, ".codex", "skills", "zebra", "SKILL.md"), "# Zebra\n");
  writeFileSync(path.join(project, ".codex", "skills", "alpha", "SKILL.md"), "# Alpha\n");

  assert.deepEqual(listProjectSkills(project), ["alpha", "zebra"]);
  assert.equal(
    projectSessionStartedText(project),
    `Project session started:\n${project}\n\nProject skills:\n- alpha\n- zebra`,
  );

  const emptyProject = path.join(project, "empty");
  mkdirSync(emptyProject);
  assert.equal(
    projectSessionStartedText(emptyProject),
    `Project session started:\n${emptyProject}\n\nProject skills:\n- none`,
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}

console.log("project skills tests passed");
