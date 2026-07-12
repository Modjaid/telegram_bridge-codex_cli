#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve(process.argv[2] || "telegram-media-trigger.json");
if (!existsSync(file)) fail(`Manifest not found: ${file}`);
let manifest;
try { manifest = JSON.parse(readFileSync(file, "utf8")); } catch (error) { fail(`Invalid JSON: ${error.message}`); }
if (manifest.version !== 1) fail("version must be 1");
if (!Array.isArray(manifest.subscriptions) || !manifest.subscriptions.length) fail("subscriptions must be a non-empty array");
const ids = new Set();
for (const [index, item] of manifest.subscriptions.entries()) {
  const label = `subscriptions[${index}]`;
  if (!item || typeof item !== "object") fail(`${label} must be an object`);
  if (!item.id || ids.has(item.id)) fail(`${label}.id must be present and unique`);
  ids.add(item.id);
  if (!Array.isArray(item.projects) || !item.projects.length) fail(`${label}.projects must be a non-empty array`);
  if (!item.match || typeof item.match !== "object") fail(`${label}.match must be an object`);
  if (!item.run || path.isAbsolute(item.run) || String(item.run).split(/[\\/]/).includes("..")) fail(`${label}.run must be a safe skill-relative path`);
}
console.log(`Valid Telegram media trigger manifest: ${file}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
