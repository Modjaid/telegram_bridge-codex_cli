import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SCHEDULE_VERSION = 1;
const NAME_RE = /^[A-Za-z0-9_]{1,48}$/;

export function scheduleStorePath(root) {
  return path.join(root, "state", "schedule-tasks.json");
}

export function loadScheduleStore(root) {
  const file = scheduleStorePath(root);
  if (!existsSync(file)) return createEmptyStore();
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const normalized = normalizeStore(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) saveScheduleStore(root, normalized);
  return normalized;
}

export function saveScheduleStore(root, store) {
  const file = scheduleStorePath(root);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const normalized = normalizeStore(store);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return normalized;
}

export function listScheduleTasks(root, chatId) {
  return Object.values(getScheduleUser(loadScheduleStore(root), chatId).tasks)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function getScheduleTask(root, chatId, nameOrId) {
  const user = getScheduleUser(loadScheduleStore(root), chatId);
  const normalizedName = normalizeTaskName(nameOrId);
  return user.tasks[normalizedName] || Object.values(user.tasks).find(task => task.id === String(nameOrId || "").trim()) || null;
}

export function upsertScheduleTask(root, chatId, input) {
  const store = loadScheduleStore(root);
  const user = ensureScheduleUser(store, chatId);
  const now = new Date().toISOString();
  const name = normalizeTaskName(input.name);
  assertTaskName(name);
  const existing = user.tasks[name] || {};
  const task = normalizeTask({
    ...existing,
    ...input,
    id: existing.id || input.id || randomUUID().slice(0, 8),
    name,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  });
  task.nextRunAt = task.enabled ? nextCronRun(task.cron, task.timeZone)?.toISOString() || "" : "";
  user.tasks[name] = task;
  user.updatedAt = now;
  saveScheduleStore(root, store);
  return task;
}

export function deleteScheduleTask(root, chatId, nameOrId) {
  const store = loadScheduleStore(root);
  const user = ensureScheduleUser(store, chatId);
  const taskName = resolveTaskName(user, nameOrId);
  const existing = user.tasks[taskName] || null;
  if (existing) {
    delete user.tasks[taskName];
    user.updatedAt = new Date().toISOString();
    saveScheduleStore(root, store);
  }
  return existing;
}

export function setScheduleUserTimeZone(root, chatId, timeZone) {
  assertTimeZone(timeZone);
  const store = loadScheduleStore(root);
  const user = ensureScheduleUser(store, chatId);
  user.timeZone = timeZone;
  user.updatedAt = new Date().toISOString();
  saveScheduleStore(root, store);
  return user;
}

export function listScheduleUsers(root) {
  return Object.values(loadScheduleStore(root).users);
}

export function getScheduleUser(store, chatId) {
  return normalizeStore(store).users[String(chatId)] || createUser(String(chatId));
}

export function ensureScheduleUser(store, chatId) {
  store.version = SCHEDULE_VERSION;
  store.users ||= {};
  const key = String(chatId);
  store.users[key] ||= createUser(key);
  store.users[key].chatId = String(store.users[key].chatId || key);
  store.users[key].tasks ||= {};
  return store.users[key];
}

export function markScheduleTaskRun(root, chatId, nameOrId, runKey, at = new Date().toISOString()) {
  const store = loadScheduleStore(root);
  const user = ensureScheduleUser(store, chatId);
  const taskName = resolveTaskName(user, nameOrId);
  const task = user.tasks[taskName];
  if (!task) return null;
  task.lastRunKey = runKey;
  task.lastRunAt = at;
  task.nextRunAt = task.enabled ? nextCronRun(task.cron, task.timeZone, new Date(at))?.toISOString() || "" : "";
  task.runCount = Number(task.runCount || 0) + 1;
  task.updatedAt = at;
  user.updatedAt = at;
  saveScheduleStore(root, store);
  return task;
}

export function refreshScheduleTaskNextRun(root, chatId, nameOrId, from = new Date()) {
  const store = loadScheduleStore(root);
  const user = ensureScheduleUser(store, chatId);
  const taskName = resolveTaskName(user, nameOrId);
  const task = user.tasks[taskName];
  if (!task) return null;
  task.nextRunAt = task.enabled ? nextCronRun(task.cron, task.timeZone, from)?.toISOString() || "" : "";
  task.updatedAt = new Date().toISOString();
  user.updatedAt = task.updatedAt;
  saveScheduleStore(root, store);
  return task;
}

export function matchesCronAt(cron, date, timeZone) {
  const fields = parseCron(cron);
  const parts = zonedDateParts(date, timeZone);
  return cronFieldMatches(fields.minute, parts.minute)
    && cronFieldMatches(fields.hour, parts.hour)
    && cronFieldMatches(fields.dayOfMonth, parts.day)
    && cronFieldMatches(fields.month, parts.month)
    && cronFieldMatches(fields.dayOfWeek, parts.weekday);
}

export function scheduleRunKey(date, timeZone) {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${timeZone}`;
}

export function nextCronRun(cron, timeZone, from = new Date(), maxMinutes = 527040) {
  const fields = parseCron(cron);
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  const deadline = start.getTime() + maxMinutes * 60000;
  let candidate = new Date(start.getTime() + 60000);
  while (candidate.getTime() <= deadline) {
    const parts = zonedDateParts(candidate, timeZone);
    if (cronFieldMatches(fields.minute, parts.minute)
      && cronFieldMatches(fields.hour, parts.hour)
      && cronFieldMatches(fields.dayOfMonth, parts.day)
      && cronFieldMatches(fields.month, parts.month)
      && cronFieldMatches(fields.dayOfWeek, parts.weekday)) {
      return candidate;
    }
    let advanceMinutes = 1;
    if (!cronFieldMatches(fields.month, parts.month)
      || !cronFieldMatches(fields.dayOfMonth, parts.day)
      || !cronFieldMatches(fields.dayOfWeek, parts.weekday)) {
      advanceMinutes = 24 * 60;
    } else if (!cronFieldMatches(fields.hour, parts.hour)) {
      advanceMinutes = Math.max(1, deltaToNext(fields.hour, parts.hour, 24) * 60);
    } else if (!cronFieldMatches(fields.minute, parts.minute)) {
      advanceMinutes = Math.max(1, deltaToNext(fields.minute, parts.minute, 60));
    }
    candidate = new Date(candidate.getTime() + advanceMinutes * 60000);
  }
  return null;
}

export function formatZonedDate(date, timeZone) {
  if (!date) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function timeZoneOffsetMinutes(date, timeZone) {
  const parts = zonedDateParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const actual = new Date(date.getTime());
  actual.setSeconds(0, 0);
  return Math.round((asUtc - actual.getTime()) / 60000);
}

export function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid time zone: ${timeZone}`);
  }
}

export function normalizeTaskName(name) {
  return String(name || "").trim().replace(/^\/?(?:edit|delete)_task_?/i, "").replace(/^\/?(?:edit|delete)_/i, "");
}

export function assertTaskName(name) {
  if (!NAME_RE.test(name)) {
    throw new Error("Task name must use only A-Z, a-z, 0-9, underscore and be 1-48 chars long");
  }
}

export function validateCron(cron) {
  parseCron(cron);
  return true;
}

function createEmptyStore() {
  return {
    version: SCHEDULE_VERSION,
    updatedAt: "",
    users: {},
  };
}

function createUser(chatId) {
  return {
    chatId,
    timeZone: "",
    tasks: {},
    updatedAt: "",
  };
}

function normalizeStore(store) {
  const normalized = {
    version: SCHEDULE_VERSION,
    updatedAt: String(store?.updatedAt || ""),
    users: {},
  };
  for (const [chatId, user] of Object.entries(store?.users || {})) {
    normalized.users[String(chatId)] = {
      chatId: String(user?.chatId || chatId),
      timeZone: String(user?.timeZone || ""),
      updatedAt: String(user?.updatedAt || ""),
      tasks: {},
    };
    for (const [name, task] of Object.entries(user?.tasks || {})) {
      try {
        const normalizedTask = normalizeTask({ ...task, name: task?.name || name });
        if (!normalizedTask.nextRunAt && normalizedTask.enabled) {
          normalizedTask.nextRunAt = nextCronRun(normalizedTask.cron, normalizedTask.timeZone)?.toISOString() || "";
        }
        normalized.users[String(chatId)].tasks[normalizedTask.name] = normalizedTask;
      } catch {
        // Ignore invalid tasks instead of breaking bridge startup.
      }
    }
  }
  return normalized;
}

function normalizeTask(task) {
  const name = normalizeTaskName(task.name);
  assertTaskName(name);
  const cron = String(task.cron || "").trim();
  validateCron(cron);
  const timeZone = String(task.timeZone || "").trim();
  assertTimeZone(timeZone);
  const rawProject = String(task.project || "").trim();
  if (!rawProject) throw new Error("Task project is required");
  const project = path.resolve(rawProject);
  if (project === path.parse(project).root) throw new Error("Task project is required");
  const prompt = String(task.prompt || "").trim();
  if (!prompt) throw new Error("Task prompt is required");
  const status = normalizeStatus(task.status ?? (task.enabled === false ? "disabled" : "enabled"));
  const enabled = status === "enabled" || status === "running";
  return {
    id: String(task.id || stableTaskId(name)).replace(/^task_/, "").trim(),
    name,
    title: String(task.title || task.name || name).trim(),
    description: String(task.description || "").trim(),
    cron,
    timeZone,
    project,
    prompt,
    status,
    enabled,
    createdAt: String(task.createdAt || ""),
    updatedAt: String(task.updatedAt || ""),
    lastRunAt: String(task.lastRunAt || ""),
    lastRunKey: String(task.lastRunKey || ""),
    nextRunAt: String(task.nextRunAt || ""),
    runCount: Number(task.runCount || 0),
  };
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["enabled", "disabled", "running", "paused"].includes(status)) return status === "paused" ? "disabled" : status;
  return "enabled";
}

function stableTaskId(name) {
  return createHash("sha1").update(String(name || randomUUID())).digest("hex").slice(0, 8);
}

function resolveTaskName(user, nameOrId) {
  const raw = String(nameOrId || "").trim();
  const normalized = normalizeTaskName(raw);
  if (user.tasks[normalized]) return normalized;
  const byId = Object.values(user.tasks || {}).find(task => task.id === raw || task.id === normalized || `task_${task.id}` === raw || task.id === raw.replace(/^task_/, ""));
  return byId?.name || normalized;
}

function parseCron(cron) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields: ${cron}`);
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 7, value => value === 7 ? 0 : value),
  };
}

function parseCronField(field, min, max, normalize = value => value) {
  const values = new Set();
  for (const rawPart of String(field || "").split(",")) {
    const part = rawPart.trim();
    if (!part) throw new Error(`Invalid cron field: ${field}`);
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    let start;
    let end;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [startText, endText] = rangePart.split("-");
      start = Number(startText);
      end = Number(endText);
    } else {
      start = Number(rangePart);
      end = Number(rangePart);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron range: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  return values;
}

function cronFieldMatches(values, value) {
  return values.has(value);
}

function deltaToNext(values, current, modulus) {
  const sorted = [...values].sort((a, b) => a - b);
  for (const value of sorted) {
    if (value > current) return value - current;
  }
  return modulus - current + sorted[0];
}

function zonedDateParts(date, timeZone) {
  assertTimeZone(timeZone);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdayNumber(parts.weekday),
  };
}

function weekdayNumber(value) {
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[value] ?? 0;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
