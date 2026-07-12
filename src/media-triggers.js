import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const MANIFEST = "telegram-media-trigger.json";

export async function runMediaTriggers({ projects, sourceProject, record, timeoutMs = 120000 }) {
  const matches = discover(projects, sourceProject, record);
  const results = [];
  for (const match of matches) {
    try {
      const result = await runHandler(match, { sourceProject, attachment: record }, timeoutMs);
      results.push({ ...match.identity, ok: true, result });
    } catch (error) {
      results.push({ ...match.identity, ok: false, error: error.message });
    }
  }
  return results;
}

function discover(projects, sourceProject, record) {
  const alias = sourceProject.alias;
  const normal = [];
  const fallback = [];
  for (const ownerProject of projects) {
    const skillsRoot = path.join(ownerProject.path, ".codex", "skills");
    if (!existsSync(skillsRoot)) continue;
    for (const skillName of safeDirectories(skillsRoot)) {
      const skillRoot = path.join(skillsRoot, skillName);
      const manifestPath = path.join(skillRoot, MANIFEST);
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { continue; }
      for (const subscription of manifest.subscriptions || []) {
        if (subscription.enabled === false || !projectMatches(subscription.projects, alias)) continue;
        if (!fileMatches(subscription.match || {}, record)) continue;
        const runPath = path.resolve(skillRoot, String(subscription.run || ""));
        if (!isInside(skillRoot, runPath) || !existsSync(runPath)) continue;
        const item = {
          skillRoot,
          runPath,
          subscription,
          identity: { ownerProject: ownerProject.alias, skill: skillName, subscriptionId: String(subscription.id || skillName) },
        };
        (subscription.fallback ? fallback : normal).push(item);
      }
    }
  }
  return normal.length ? normal : fallback;
}

function safeDirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort();
  } catch { return []; }
}

function projectMatches(value, alias) {
  const projects = Array.isArray(value) ? value.map(String) : ["*"];
  return projects.includes("*") || projects.includes(alias);
}

function fileMatches(match, record) {
  if (match.all === true) return true;
  const extension = path.extname(record.file?.originalFileName || record.file?.path || "").toLowerCase();
  const mime = String(record.file?.mimeType || "").toLowerCase();
  const mediaType = String(record.file?.mediaType || "").toLowerCase();
  const checks = [];
  if (Array.isArray(match.extensions)) checks.push(match.extensions.map(x => String(x).toLowerCase()).includes(extension));
  if (Array.isArray(match.mimeTypes)) checks.push(match.mimeTypes.map(x => String(x).toLowerCase()).includes(mime));
  if (Array.isArray(match.mimePatterns)) checks.push(match.mimePatterns.some(pattern => mimePattern(pattern, mime)));
  if (Array.isArray(match.mediaTypes)) checks.push(match.mediaTypes.map(x => String(x).toLowerCase()).includes(mediaType));
  const size = Number(record.file?.sizeBytes || 0);
  if (match.minBytes !== undefined) checks.push(size >= Number(match.minBytes));
  if (match.maxBytes !== undefined) checks.push(size <= Number(match.maxBytes));
  if (!checks.length) return false;
  return match.matchMode === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

function mimePattern(pattern, mime) {
  const value = String(pattern || "").toLowerCase();
  return value.endsWith("/*") ? mime.startsWith(value.slice(0, -1)) : value === mime;
}

function runHandler(match, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const command = match.runPath.endsWith(".js") ? process.execPath : match.runPath;
    const args = match.runPath.endsWith(".js") ? [match.runPath] : [];
    const child = spawn(command, args, { cwd: match.skillRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 1_000_000) child.kill("SIGTERM"); });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`handler timed out after ${timeoutMs} ms`));
      if (code !== 0) return reject(new Error(stderr.trim() || `handler exited with ${code}`));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : { status: "processed" }); }
      catch { reject(new Error("handler returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify({ ...payload, subscription: match.subscription }));
  });
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
