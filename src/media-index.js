import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const MEDIA_INDEX_RELATIVE_PATH = ".media-index.json";
const INDEX_VERSION = 1;
const LOCK_TIMEOUT_MS = 10000;
const STALE_LOCK_MS = 30000;

export function resolveProject(project = process.cwd()) {
  return path.resolve(project || process.cwd());
}

export function mediaIndexPath(project = process.cwd()) {
  return path.join(resolveProject(project), MEDIA_INDEX_RELATIVE_PATH);
}

export function initMediaIndex(project = process.cwd()) {
  return withMediaIndexLock(project, () => {
    const index = loadMediaIndexUnlocked(project);
    saveMediaIndexUnlocked(project, index);
    return index;
  });
}

export function loadMediaIndex(project = process.cwd(), options = {}) {
  if (options.sync) return syncMediaIndex(project).index;
  return loadMediaIndexUnlocked(project);
}

export function upsertMediaRecord(project, record) {
  assertRecordFile(project, record);
  return withMediaIndexLock(project, () => {
    const index = pruneMissingItems(project, loadMediaIndexUnlocked(project));
    const existing = index.items[record.mediaId] || {};
    const item = {
      ...record,
      description: existing.description ?? record.description ?? "",
      descriptionStatus: existing.descriptionStatus ?? record.descriptionStatus ?? "pending",
      descriptionUpdatedAt: existing.descriptionUpdatedAt ?? record.descriptionUpdatedAt ?? "",
    };
    index.items[item.mediaId] = item;
    rebuildTelegramMessageIndex(index);
    index.updatedAt = nowIso();
    saveMediaIndexUnlocked(project, index);
    return { index, item };
  });
}

export function addTelegramMessageAlias(project, mediaId, chatId, messageId) {
  return withMediaIndexLock(project, () => {
    const index = pruneMissingItems(project, loadMediaIndexUnlocked(project));
    const item = index.items[mediaId];
    if (!item) throw new Error(`Media item not found: ${mediaId}`);
    assertItemFileExists(project, item);

    item.telegram ||= {};
    item.telegram.relatedMessageIds = normalizeRelatedMessageIds(item.telegram.relatedMessageIds);
    const id = String(messageId || "").trim();
    if (id && id !== String(item.telegram.messageId || "") && !item.telegram.relatedMessageIds.includes(id)) {
      item.telegram.relatedMessageIds.push(id);
    }
    if (!item.telegram.chatId && chatId) item.telegram.chatId = String(chatId);

    rebuildTelegramMessageIndex(index);
    index.updatedAt = nowIso();
    saveMediaIndexUnlocked(project, index);
    return item;
  });
}

export function setMediaDescription(project, mediaId, description) {
  return withMediaIndexLock(project, () => {
    const index = pruneMissingItems(project, loadMediaIndexUnlocked(project));
    const item = index.items[mediaId];
    if (!item) throw new Error(`Media item not found: ${mediaId}`);
    assertItemFileExists(project, item);
    item.description = String(description || "").trim();
    item.descriptionStatus = item.description ? "described" : "pending";
    item.descriptionUpdatedAt = item.description ? nowIso() : "";
    index.updatedAt = nowIso();
    saveMediaIndexUnlocked(project, index);
    return item;
  });
}

export function deleteMediaItem(project, mediaId) {
  return withMediaIndexLock(project, () => {
    const index = loadMediaIndexUnlocked(project);
    const item = index.items[mediaId];
    if (!item) {
      const pruned = pruneMissingItems(project, index);
      saveMediaIndexUnlocked(project, pruned);
      return { deleted: false, fileDeleted: false, item: null, filePath: "" };
    }

    let filePath = "";
    let fileDeleted = false;
    try {
      filePath = itemAbsolutePath(project, item);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        fileDeleted = true;
      }
    } catch {
      filePath = item.file?.path || item.file?.relativePath || "";
    }

    delete index.items[mediaId];
    pruneMissingItems(project, index);
    index.updatedAt = nowIso();
    saveMediaIndexUnlocked(project, index);
    return { deleted: true, fileDeleted, item, filePath };
  });
}

export function moveMediaItem(project, mediaId, destination, options = {}) {
  return withMediaIndexLock(project, () => {
    const projectPath = resolveProject(project);
    const index = pruneMissingItems(projectPath, loadMediaIndexUnlocked(projectPath));
    const item = index.items[mediaId];
    if (!item) throw new Error(`Media item not found: ${mediaId}`);

    const fromPath = itemAbsolutePath(projectPath, item);
    const toPath = resolveMoveDestination(projectPath, fromPath, destination);
    assertInsideProject(projectPath, toPath);

    if (fromPath === toPath) {
      updateItemFilePath(projectPath, item, toPath);
      index.updatedAt = nowIso();
      saveMediaIndexUnlocked(projectPath, index);
      return { moved: false, overwritten: false, from: fromPath, to: toPath, item };
    }

    let overwritten = false;
    if (existsSync(toPath)) {
      if (statSync(toPath).isDirectory()) throw new Error(`Destination is a directory: ${toPath}`);
      if (!options.overwrite) throw new Error(`Destination already exists: ${toPath}`);
      overwritten = true;
    }

    mkdirSync(path.dirname(toPath), { recursive: true, mode: 0o700 });
    renameSync(fromPath, toPath);
    updateItemFilePath(projectPath, item, toPath);
    index.updatedAt = nowIso();
    saveMediaIndexUnlocked(projectPath, index);
    return { moved: true, overwritten, from: fromPath, to: toPath, item };
  });
}

export function findMediaProject(projects, mediaId) {
  for (const project of projects) {
    try {
      const item = getMediaItem(project, mediaId, { sync: true });
      if (item) return { project: resolveProject(project), item };
    } catch {
      // Keep searching other projects; a stale index should not break callbacks.
    }
  }
  return null;
}

export function listMediaItems(project = process.cwd(), options = {}) {
  const index = loadMediaIndex(project, { sync: options.sync !== false });
  let items = Object.values(index.items);
  if (options.status) items = items.filter(item => item.descriptionStatus === options.status);
  return items.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
}

export function getMediaItem(project, mediaId, options = {}) {
  const index = loadMediaIndex(project, { sync: options.sync !== false });
  const item = index.items[mediaId];
  if (!item) return null;
  if (!item.file?.expiredAt) assertItemFileExists(project, item);
  return item;
}

export function findMediaByTelegramMessage(project, chatId, messageId, options = {}) {
  const index = loadMediaIndex(project, { sync: options.sync !== false });
  const mediaId = index.telegramMessageIndex[telegramMessageKey(chatId, messageId)];
  if (!mediaId) return null;
  const item = index.items[mediaId] || null;
  if (item && !item.file?.expiredAt) assertItemFileExists(project, item);
  return item;
}

export function peekMediaByTelegramMessage(project, chatId, messageId) {
  const index = loadMediaIndex(project, { sync: false });
  const mediaId = index.telegramMessageIndex[telegramMessageKey(chatId, messageId)];
  if (!mediaId) return null;
  return index.items[mediaId] || null;
}

export function syncMediaIndex(project = process.cwd()) {
  return withMediaIndexLock(project, () => {
    const before = loadMediaIndexUnlocked(project);
    const beforeCount = Object.keys(before.items).length;
    const index = pruneMissingItems(project, before);
    const afterCount = Object.keys(index.items).length;
    if (beforeCount !== afterCount) {
      index.updatedAt = nowIso();
      saveMediaIndexUnlocked(project, index);
    }
    return { index, removed: beforeCount - afterCount };
  });
}

export function expireMediaItem(project, mediaId) {
  return withMediaIndexLock(project, () => {
    const index = loadMediaIndexUnlocked(project);
    const item = index.items[mediaId];
    if (!item) return { expired: false, fileDeleted: false };
    let fileDeleted = false;
    try {
      const filePath = itemAbsolutePath(project, item);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        fileDeleted = true;
      }
    } catch {}
    item.file ||= {};
    item.file.expiredAt = nowIso();
    index.updatedAt = nowIso();
    saveMediaIndexUnlocked(project, index);
    return { expired: true, fileDeleted, item };
  });
}

export function validateMediaIndex(project = process.cwd()) {
  const index = loadMediaIndexUnlocked(project);
  const missing = [];
  for (const item of Object.values(index.items)) {
    if (item.file?.expiredAt) continue;
    if (!itemFileExists(project, item)) missing.push(item.mediaId);
  }
  return { ok: missing.length === 0, missing, count: Object.keys(index.items).length };
}

export function getMediaFilePath(project, item) {
  assertItemFileExists(project, item);
  return itemAbsolutePath(project, item);
}

export function createLocalMediaRecord({ project, filePath, caption = "", source = "codex" }) {
  const resolvedProject = resolveProject(project);
  const absolutePath = path.resolve(resolvedProject, filePath);
  assertInsideProject(resolvedProject, absolutePath);
  if (!existsSync(absolutePath)) throw new Error(`Media file does not exist: ${absolutePath}`);

  const stats = statSync(absolutePath);
  if (stats.isDirectory()) throw new Error(`Media path is a directory: ${absolutePath}`);

  const sha256 = sha256File(absolutePath);
  const savedAt = nowIso();
  const mediaId = createLocalMediaId(absolutePath, sha256);

  return {
    mediaId,
    source,
    telegram: {
      chatId: "",
      messageId: "",
      fileId: "",
      fileUniqueId: "",
      date: "",
      caption: String(caption || ""),
      replyToMessageId: "",
    },
    file: {
      path: absolutePath,
      relativePath: path.relative(resolvedProject, absolutePath),
      storedFileName: path.basename(absolutePath),
      originalFileName: path.basename(absolutePath),
      mimeType: guessMimeType(absolutePath),
      mediaType: guessMediaType(absolutePath),
      sizeBytes: stats.size,
      sha256,
    },
    createdAt: stats.birthtimeMs ? stats.birthtime.toISOString() : savedAt,
    savedAt,
    description: "",
    descriptionStatus: "pending",
    descriptionUpdatedAt: "",
  };
}

export function createTelegramMediaRecord({ project, message, attachment, filePath }) {
  const resolvedProject = resolveProject(project);
  const absolutePath = path.resolve(filePath);
  assertInsideProject(resolvedProject, absolutePath);
  if (!existsSync(absolutePath)) throw new Error(`Media file does not exist: ${absolutePath}`);

  const stats = statSync(absolutePath);
  const sha256 = sha256File(absolutePath);
  const chatId = String(message.chat?.id || "");
  const messageId = String(message.message_id || "");
  const savedAt = nowIso();
  const telegramDate = message.date ? new Date(Number(message.date) * 1000).toISOString() : "";
  const mediaId = createMediaId(chatId, messageId, sha256);

  return {
    mediaId,
    source: "telegram",
    telegram: {
      chatId,
      messageId,
      fileId: attachment.fileId || "",
      fileUniqueId: attachment.fileUniqueId || "",
      date: telegramDate,
      caption: String(message.caption || ""),
      replyToMessageId: message.reply_to_message?.message_id ? String(message.reply_to_message.message_id) : "",
    },
    file: {
      path: absolutePath,
      relativePath: path.relative(resolvedProject, absolutePath),
      storedFileName: path.basename(absolutePath),
      originalFileName: attachment.originalFileName || attachment.fileName || path.basename(absolutePath),
      mimeType: attachment.mimeType || guessMimeType(absolutePath),
      mediaType: attachment.mediaType || "file",
      sizeBytes: stats.size,
      sha256,
    },
    createdAt: telegramDate || savedAt,
    savedAt,
    description: "",
    descriptionStatus: "pending",
    descriptionUpdatedAt: "",
  };
}

function loadMediaIndexUnlocked(project = process.cwd()) {
  const projectPath = resolveProject(project);
  const file = mediaIndexPath(projectPath);
  if (!existsSync(file)) return blankIndex(projectPath);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return normalizeIndex(projectPath, parsed);
}

function saveMediaIndexUnlocked(project = process.cwd(), index) {
  const projectPath = resolveProject(project);
  const file = mediaIndexPath(projectPath);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const normalized = normalizeIndex(projectPath, index);
  normalized.updatedAt ||= nowIso();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function withMediaIndexLock(project, fn) {
  const file = mediaIndexPath(project);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n${nowIso()}\n`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (isStaleLock(lockPath)) unlinkSync(lockPath);
      else if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for media index lock: ${lockPath}`);
      else sleepMs(50);
    }
  }

  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock may have been removed manually after a failed process.
    }
  }
}

function normalizeIndex(project, index) {
  const normalized = {
    version: Number(index?.version || INDEX_VERSION),
    project: resolveProject(project),
    updatedAt: index?.updatedAt || "",
    items: index?.items && typeof index.items === "object" && !Array.isArray(index.items) ? index.items : {},
    telegramMessageIndex: index?.telegramMessageIndex && typeof index.telegramMessageIndex === "object" ? index.telegramMessageIndex : {},
  };
  rebuildTelegramMessageIndex(normalized);
  return normalized;
}

function blankIndex(project) {
  return {
    version: INDEX_VERSION,
    project: resolveProject(project),
    updatedAt: nowIso(),
    items: {},
    telegramMessageIndex: {},
  };
}

function pruneMissingItems(project, index) {
  for (const [mediaId, item] of Object.entries(index.items)) {
    if (!itemFileExists(project, item)) delete index.items[mediaId];
  }
  rebuildTelegramMessageIndex(index);
  return index;
}

function rebuildTelegramMessageIndex(index) {
  index.telegramMessageIndex = {};
  for (const item of Object.values(index.items || {})) {
    const chatId = item.telegram?.chatId;
    const messageId = item.telegram?.messageId;
    if (chatId && messageId) index.telegramMessageIndex[telegramMessageKey(chatId, messageId)] = item.mediaId;
    for (const relatedMessageId of normalizeRelatedMessageIds(item.telegram?.relatedMessageIds)) {
      if (chatId && relatedMessageId) index.telegramMessageIndex[telegramMessageKey(chatId, relatedMessageId)] = item.mediaId;
    }
  }
}

function normalizeRelatedMessageIds(value) {
  const items = Array.isArray(value) ? value : [];
  return [...new Set(items.map(item => String(item || "").trim()).filter(Boolean))];
}

function assertRecordFile(project, record) {
  if (!record?.mediaId) throw new Error("Media record is missing mediaId");
  if (record.file?.expiredAt) return;
  assertItemFileExists(project, record);
}

function assertItemFileExists(project, item) {
  const file = itemAbsolutePath(project, item);
  if (!existsSync(file)) throw new Error(`Media file does not exist: ${file}`);
}

function itemFileExists(project, item) {
  try {
    const file = itemAbsolutePath(project, item);
    return !!file && existsSync(file);
  } catch {
    return false;
  }
}

function itemAbsolutePath(project, item) {
  const projectPath = resolveProject(project);
  const filePath = item?.file?.relativePath
    ? path.resolve(projectPath, item.file.relativePath)
    : item?.file?.path
      ? path.resolve(item.file.path)
      : "";
  if (!filePath) return "";
  assertInsideProject(projectPath, filePath);
  return filePath;
}

function resolveMoveDestination(project, fromPath, destination) {
  const rawDestination = String(destination || "").trim();
  if (!rawDestination) throw new Error("Destination path is required");

  let destinationPath = path.isAbsolute(rawDestination)
    ? path.resolve(rawDestination)
    : path.resolve(project, rawDestination);

  if (isDirectoryDestination(rawDestination, destinationPath)) {
    destinationPath = path.join(destinationPath, path.basename(fromPath));
  }

  return destinationPath;
}

function isDirectoryDestination(rawDestination, destinationPath) {
  if (rawDestination.endsWith("/") || rawDestination.endsWith(path.sep)) return true;
  try {
    return existsSync(destinationPath) && statSync(destinationPath).isDirectory();
  } catch {
    return false;
  }
}

function updateItemFilePath(project, item, filePath) {
  const stats = statSync(filePath);
  item.file ||= {};
  item.file.path = filePath;
  item.file.relativePath = path.relative(resolveProject(project), filePath);
  item.file.storedFileName = path.basename(filePath);
  item.file.sizeBytes = stats.size;
}

function assertInsideProject(project, filePath) {
  const relative = path.relative(resolveProject(project), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside project: ${filePath}`);
  }
}

function telegramMessageKey(chatId, messageId) {
  return `${String(chatId)}:${String(messageId)}`;
}

function createMediaId(chatId, messageId, sha256) {
  return `tg_${safeIdPart(chatId)}_${safeIdPart(messageId || Date.now())}_${sha256.slice(0, 6)}`;
}

function createLocalMediaId(filePath, sha256) {
  const name = path.basename(filePath, path.extname(filePath)) || "file";
  return `local_${safeIdPart(name)}_${sha256.slice(0, 12)}`;
}

function safeIdPart(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const table = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
  };
  return table[ext] || "application/octet-stream";
}

function guessMediaType(filePath) {
  const mimeType = guessMimeType(filePath);
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function isStaleLock(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function nowIso() {
  return new Date().toISOString();
}
