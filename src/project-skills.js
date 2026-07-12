import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export function listProjectSkills(workdir) {
  const skillsRoot = path.join(workdir, ".codex", "skills");
  let entries;
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .map(entry => entry.name)
    .filter(name => existsSync(path.join(skillsRoot, name, "SKILL.md")))
    .sort((left, right) => left.localeCompare(right));
}

export function projectSessionStartedText(workdir) {
  const skills = listProjectSkills(workdir);
  const skillList = skills.length ? skills.map(name => `- ${name}`).join("\n") : "- none";
  return `Project session started:\n${workdir}\n\nProject skills:\n${skillList}`;
}
