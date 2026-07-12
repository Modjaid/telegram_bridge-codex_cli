import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function listProjectSkills(workdir, codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex")) {
  const roots = [path.join(codexHome, "skills"), path.join(workdir, ".codex", "skills")];
  return [...new Set(roots.flatMap(listSkillsAt))].sort((left, right) => left.localeCompare(right));
}

function listSkillsAt(skillsRoot) {
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

export function listProjectEntries(workdir) {
  try {
    return readdirSync(workdir, { withFileTypes: true })
      .map(entry => ({ name: cleanName(entry.name), directory: entry.isDirectory() }))
      .sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export function projectSessionStartedText(workdir, options = {}) {
  const skills = listProjectSkills(workdir, options.codexHome);
  const skillList = skills.length ? skills.map(name => `- ${name}`).join("\n") : "- none";
  const header = `Project session started:\n${workdir}\n\nProject skills:\n${skillList}\n\nProject structure:`;
  const maxLength = Number(options.maxLength || 3400);
  const structure = formatProjectEntries(listProjectEntries(workdir), Math.max(0, maxLength - header.length - 1));
  return `${header}\n${structure}`;
}

function formatProjectEntries(entries, budget) {
  if (!entries.length) return "- empty";
  const rendered = [];
  let used = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const line = `- ${entry.name}${entry.directory ? "/" : ""}`;
    const remaining = entries.length - index;
    const omitted = `- … (+${remaining} more)`;
    const separator = rendered.length ? 1 : 0;
    const reserve = remaining > 1 ? omitted.length + 1 : 0;
    if (used + separator + line.length + reserve > budget) {
      if (used + separator + omitted.length <= budget) rendered.push(omitted);
      break;
    }
    rendered.push(line);
    used += separator + line.length;
  }
  return rendered.join("\n") || "- …";
}

function cleanName(name) {
  return String(name).replace(/[\r\n\t]/g, " ");
}
