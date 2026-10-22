import { cpSync, existsSync, readdirSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_SKILLS = ["codex-telegram-bridge"];
const RETIRED_SKILLS = new Map([
  ["configure-telegram-media", "1.1.0"],
  ["manage-telegram-projects", "1.1.0"],
]);

export function installBundledSkills(root, options = {}) {
  const sourceRoot = path.join(root, "bundled-skills");
  if (!existsSync(sourceRoot)) return [];
  const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const projects = [...new Set((options.projects || String(process.env.PROJECT_ALLOWLIST || "").split(",").filter(Boolean)).map(project => path.resolve(project)))];
  const results = [];
  for (const project of projects) {
    if (!existsSync(project) || !lstatSync(project).isDirectory()) throw new Error(`Project directory not found: ${project}`);
    const skillsRoot = path.join(project, ".codex", "skills");
    mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
    for (const name of options.names || DEFAULT_SKILLS) results.push({ ...installOne(sourceRoot, skillsRoot, name), project });
  }
  // Archive the former global copy only after every project has a local copy.
  if (projects.length && options.migrateGlobal !== false) {
    for (const name of [...DEFAULT_SKILLS, ...RETIRED_SKILLS.keys()]) {
      const global = path.join(codexHome, "skills", name);
      if (!existsSync(global)) continue;
      const backupRoot = path.join(codexHome, "bridge-skill-backups");
      mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const backup = path.join(backupRoot, `${name}-${Date.now()}-${process.pid}`);
      renameSync(global, backup);
      results.push({ name, action: "archived-global", backup });
    }
  }
  return results;
}

const INSTALL_RECORD = ".bridge-install.json";
function fingerprint(directory) {
  const hash = createHash("sha256");
  function visit(dir, prefix = "") {
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && name === INSTALL_RECORD) continue;
      const file = path.join(dir, name);
      const relative = `${prefix}${name}`;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Skill contains a symbolic link: ${file}`);
      hash.update(JSON.stringify([relative, stat.isDirectory() ? "directory" : "file"]));
      if (stat.isDirectory()) visit(file, `${relative}/`);
      else hash.update(readFileSync(file));
    }
  }
  visit(directory);
  return hash.digest("hex");
}
function isManagedUnchanged(directory) {
  try {
    const record = JSON.parse(readFileSync(path.join(directory, INSTALL_RECORD), "utf8"));
    return record.sha256 === fingerprint(directory);
  } catch { return false; }
}
export function removeProjectBundledSkills(project) {
  const results = [];
  for (const name of DEFAULT_SKILLS) {
    const destination = path.join(project, ".codex", "skills", name);
    if (!existsSync(destination)) continue;
    const unchanged = isManagedUnchanged(destination);
    if (unchanged) rmSync(destination, { recursive: true });
    results.push({ name, action: unchanged ? "removed" : "preserved-custom", project });
  }
  return results;
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

  if (wasInstalled && !isManagedUnchanged(destination)) return { name, action: "preserved-custom", version: installedVersion };

  const nonce = `${process.pid}-${Date.now()}`;
  const temporary = path.join(skillsRoot, `.${name}.install-${nonce}`);
  const backup = path.join(skillsRoot, `.${name}.backup-${nonce}`);
  rmSync(temporary, { recursive: true, force: true });
  cpSync(source, temporary, { recursive: true, force: true });
  writeFileSync(path.join(temporary, INSTALL_RECORD), JSON.stringify({ sha256: fingerprint(temporary) }), { mode: 0o600 });
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
