import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listProjectEntries, listProjectSkills, projectSessionStartedText } from "../src/project-skills.js";

const project = mkdtempSync(path.join(tmpdir(), "project-skills-test-"));

try {
  mkdirSync(path.join(project, ".codex", "skills", "zebra"), { recursive: true });
  mkdirSync(path.join(project, ".codex", "skills", "alpha"), { recursive: true });
  mkdirSync(path.join(project, ".codex", "skills", "not-a-skill"), { recursive: true });
  writeFileSync(path.join(project, ".codex", "skills", "zebra", "SKILL.md"), "# Zebra\n");
  writeFileSync(path.join(project, ".codex", "skills", "alpha", "SKILL.md"), "# Alpha\n");
  writeFileSync(path.join(project, "AGENTS.md"), "# Test project\n");

  const codexHome = path.join(project, "global-codex");
  mkdirSync(path.join(codexHome, "skills", "global-skill"), { recursive: true });
  mkdirSync(path.join(codexHome, "skills", "alpha"), { recursive: true });
  writeFileSync(path.join(codexHome, "skills", "global-skill", "SKILL.md"), "# Global\n");
  writeFileSync(path.join(codexHome, "skills", "alpha", "SKILL.md"), "# Duplicate\n");

  assert.deepEqual(listProjectSkills(project, codexHome), ["alpha", "global-skill", "zebra"]);
  assert.deepEqual(listProjectEntries(project), [
    { name: ".codex", directory: true },
    { name: "global-codex", directory: true },
    { name: "AGENTS.md", directory: false },
  ]);
  assert.equal(
    projectSessionStartedText(project, { codexHome }),
    `Project session started:\n${project}\n\nProject skills:\n- alpha\n- global-skill\n- zebra\n\nProject structure:\n- .codex/\n- global-codex/\n- AGENTS.md`,
  );

  const emptyProject = path.join(project, "empty");
  mkdirSync(emptyProject);
  assert.equal(
    projectSessionStartedText(emptyProject, { codexHome: path.join(project, "missing-codex") }),
    `Project session started:\n${emptyProject}\n\nProject skills:\n- none\n\nProject structure:\n- empty`,
  );

  const truncated = projectSessionStartedText(project, { codexHome, maxLength: 150 });
  assert.ok(truncated.length <= 150);
  assert.match(truncated, /Project structure:\n(?:- .+\n)?- … \(\+3 more\)$/);
} finally {
  rmSync(project, { recursive: true, force: true });
}

console.log("project skills tests passed");
