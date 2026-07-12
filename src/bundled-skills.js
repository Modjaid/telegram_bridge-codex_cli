import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function installBundledSkills(root, options = {}) {
  const sourceRoot = path.join(root, "bundled-skills");
  if (!existsSync(sourceRoot)) return [];
  const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const skillsRoot = path.join(codexHome, "skills");
  mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
  const names = options.names || ["configure-telegram-media", "manage-telegram-projects"];
  return names.map(name => installOne(sourceRoot, skillsRoot, name));
}

function installOne(sourceRoot, skillsRoot, name) {
  const source = path.join(sourceRoot, name);
  if (!existsSync(path.join(source, "SKILL.md"))) return { name, action: "missing-source" };
  const bundledVersion = readVersion(source);
  const destination = path.join(skillsRoot, name);
  const wasInstalled = existsSync(destination);
  const installedVersion = readVersion(destination);
  if (wasInstalled && compareVersions(installedVersion, bundledVersion) >= 0) {
    return { name, action: "unchanged", version: installedVersion };
  }

  const nonce = `${process.pid}-${Date.now()}`;
  const temporary = path.join(skillsRoot, `.${name}.install-${nonce}`);
  const backup = path.join(skillsRoot, `.${name}.backup-${nonce}`);
  rmSync(temporary, { recursive: true, force: true });
  cpSync(source, temporary, { recursive: true, force: true });
  let backedUp = false;
  try {
    if (existsSync(destination)) {
      renameSync(destination, backup);
      backedUp = true;
    }
    renameSync(temporary, destination);
    if (backedUp) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (backedUp && !existsSync(destination)) renameSync(backup, destination);
    throw error;
  }
  return { name, action: wasInstalled ? "updated" : "installed", version: bundledVersion, previousVersion: wasInstalled ? installedVersion : "" };
}

function readVersion(directory) {
  const file = path.join(directory, "VERSION");
  if (!existsSync(file)) return "0.0.0";
  return readFileSync(file, "utf8").trim() || "0.0.0";
}

export function compareVersions(left, right) {
  const a = numericVersion(left);
  const b = numericVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function numericVersion(value) {
  return String(value || "0").split(".").map(part => Number.parseInt(part, 10) || 0);
}
