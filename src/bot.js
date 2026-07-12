import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addTelegramMessageAlias,
  createTelegramMediaRecord,
  deleteMediaItem,
  expireMediaItem,
  getMediaItem,
  listMediaItems,
  MEDIA_INDEX_RELATIVE_PATH,
  peekMediaByTelegramMessage,
  upsertMediaRecord,
} from "./media-index.js";
import { runMediaTriggers } from "./media-triggers.js";
import {
  formatZonedDate,
  getScheduleTask,
  getScheduleUser,
  listScheduleTasks,
  listScheduleUsers,
  loadScheduleStore,
  markScheduleTaskRun,
  matchesCronAt,
  nextCronRun,
  refreshScheduleTaskNextRun,
  scheduleRunKey,
  timeZoneOffsetMinutes,
} from "./schedule-store.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STATE_DIR = path.join(ROOT, "state");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const SCHEDULE_PROJECT = ROOT;

loadDotEnv(path.join(ROOT, ".env"));

const config = {
  telegramEnabled: parseBool(process.env.TELEGRAM_ADAPTER_ENABLED || (process.env.BOT_TOKEN ? "true" : "false")),
  botToken: process.env.BOT_TOKEN || "",
  allowedUserIds: csv(process.env.ALLOWED_USER_IDS).map(Number).filter(Boolean),
  projects: csv(process.env.PROJECT_ALLOWLIST).map(p => path.resolve(p)),
  projectCommandSpec: process.env.PROJECT_COMMANDS || "",
  codexBin: process.env.CODEX_BIN || "codex",
  defaultModel: process.env.CODEX_MODEL || "",
  defaultSandbox: process.env.CODEX_SANDBOX || "workspace-write",
  defaultApprovalPolicy: process.env.CODEX_APPROVAL_POLICY || "on-request",
  skipGitRepoCheck: parseBool(process.env.CODEX_SKIP_GIT_REPO_CHECK || "false"),
  envAllowlist: csv(process.env.CODEX_ENV_ALLOWLIST || "PATH,HOME,USER,LANG,LC_ALL,TERM,CODEX_HOME"),
  pollTimeoutSeconds: Number(process.env.POLL_TIMEOUT_SECONDS || 25),
  liveUpdateIntervalMs: Number(process.env.LIVE_UPDATE_INTERVAL_MS || 2000),
  maxTelegramChars: Number(process.env.MAX_TELEGRAM_CHARS || 3900),
  sttCommand: process.env.STT_COMMAND || "",
  sttTimeoutMs: Number(process.env.STT_TIMEOUT_MS || 120000),
  maxAudioBytes: Number(process.env.MAX_AUDIO_BYTES || 20000000),
  maxInboxFileBytes: Number(process.env.MAX_INBOX_FILE_BYTES || 50000000),
  mediaCacheRoot: path.resolve(process.env.TELEGRAM_MEDIA_CACHE_ROOT || "/home/agent/media_files/telegram-cache"),
  mediaCacheTtlDays: Number(process.env.TELEGRAM_MEDIA_CACHE_TTL_DAYS || 7),
  mediaTriggerTimeoutMs: Number(process.env.TELEGRAM_MEDIA_TRIGGER_TIMEOUT_MS || 120000),
  jsonUploadDir: path.resolve(process.env.JSON_UPLOAD_DIR || path.join(tmpdir(), "codex-telegram-upload")),
  maxJsonBytes: Number(process.env.MAX_JSON_BYTES || 10000000),
  bridgeCommands: csv(process.env.BRIDGE_COMMANDS || "/codex,@codex,codex:"),
  includeHistoryByDefault: parseBool(process.env.CODEX_INCLUDE_HISTORY_BY_DEFAULT || "false"),
  maxHistoryMessages: Number(process.env.BRIDGE_MAX_HISTORY_MESSAGES || 40),
  scheduleTickMs: Number(process.env.SCHEDULE_TICK_MS || 60000),
  collabmdEnabled: parseBool(process.env.COLLABMD_ADAPTER_ENABLED || "false"),
  collabmdHost: process.env.COLLABMD_BRIDGE_HOST || "127.0.0.1",
  collabmdPort: Number(process.env.COLLABMD_BRIDGE_PORT || 17891),
  collabmdToken: process.env.COLLABMD_BRIDGE_TOKEN || "",
  maxHttpBodyBytes: Number(process.env.BRIDGE_MAX_HTTP_BODY_BYTES || 1000000),
};

if (config.telegramEnabled && !config.botToken) {
  throw new Error("BOT_TOKEN is required when TELEGRAM_ADAPTER_ENABLED=true");
}
if (config.telegramEnabled && config.allowedUserIds.length === 0) {
  throw new Error("ALLOWED_USER_IDS must contain at least one numeric Telegram user id");
}
if (config.projects.length === 0) {
  throw new Error("PROJECT_ALLOWLIST must contain at least one absolute project path");
}
for (const project of config.projects) {
  if (!existsSync(project)) throw new Error(`Project does not exist: ${project}`);
}
config.projectCommands = parseProjectCommandSpec(config.projectCommandSpec, config.projects);
config.projectCreateRoot = path.resolve(process.env.PROJECT_CREATE_ROOT || inferProjectCreateRoot(config.projects));
mkdirSync(path.join(config.mediaCacheRoot, "files"), { recursive: true, mode: 0o700 });
cleanupMediaCache();
setInterval(cleanupMediaCache, 24 * 60 * 60 * 1000).unref();

const apiBase = config.botToken ? `https://api.telegram.org/bot${config.botToken}` : "";
const state = loadState();
const running = new Map();
const runningProjects = new Map();
const liveProgressMessages = new Map();
let offset = Number(state.offset || 0);
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_POLICIES = ["untrusted", "on-request", "on-failure", "never"];
const COLLAPSED_LIVE_LOG_LINES = 3;
const TOGGLED_COLLAPSED_LIVE_LOG_LINES = 1;
const EXPANDED_LIVE_LOG_LINES = 20;
const SCHEDULE_SESSION_ALIAS = "schedule";

console.log("Codex Bridge started");
console.log(`Telegram adapter: ${config.telegramEnabled ? "enabled" : "disabled"}`);
if (config.telegramEnabled) console.log(`Allowed Telegram users: ${config.allowedUserIds.join(", ")}`);
console.log(`Default project: ${config.projects[0]}`);
console.log(`Project commands: ${formatProjectCommands(config.projectCommands) || "none"}`);
console.log(`Bridge commands: ${config.bridgeCommands.join(", ")}`);
if (config.telegramEnabled) startScheduleRunner();
if (config.collabmdEnabled) startCollabmdHttpAdapter();
if (config.telegramEnabled) await runTelegramAdapter();

async function runTelegramAdapter() {
  await syncTelegramCommandMenu();

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: config.pollTimeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        state.offset = offset;
        saveState();
        await handleUpdate(update);
      }
    } catch (error) {
      console.error("poll error", error);
      await sleep(2000);
    }
  }
}

async function syncTelegramCommandMenu() {
  const commands = [
    { command: "projects", description: "List and switch projects" },
    { command: "schedule", description: "Manage scheduled Codex tasks" },
  ];
  const scopes = [
    { label: "default", payload: {} },
    { label: "all_private_chats", payload: { scope: { type: "all_private_chats" } } },
    ...config.allowedUserIds.map(chatId => ({
      label: `chat:${chatId}`,
      payload: { scope: { type: "chat", chat_id: chatId } },
    })),
  ];

  for (const scope of scopes) {
    try {
      await telegram("deleteMyCommands", scope.payload);
    } catch (error) {
      console.warn(`Failed to delete Telegram commands for ${scope.label}: ${error.message}`);
    }
  }

  for (const scope of scopes) {
    try {
      await telegram("setMyCommands", { ...scope.payload, commands });
    } catch (error) {
      console.warn(`Failed to set Telegram commands for ${scope.label}: ${error.message}`);
    }
  }

  console.log("Telegram command menu synced: /projects, /schedule");
}

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
}

async function handleCallback(query) {
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;
  if (!isAllowed(userId)) {
    await answerCallback(query.id, "Access denied");
    return;
  }

  const data = query.data || "";
  const callbackSessionKey = query.message?.message_id ? findTelegramSessionKeyByMessage(chatId, query.message.message_id) : "";
  const target = telegramTarget(chatId, callbackSessionKey || getActiveTelegramSessionKey(chatId));
  const session = getSession(target.key);

  if (data.startsWith("media:")) {
    await handleMediaCallback(query, data);
    return;
  }

  if (data === "project:create") {
    await answerCallback(query.id, "Project name requested");
    const root = config.projectCreateRoot;
    const prompt = [
      "Введите имя нового project.",
      "",
      `Папка будет создана внутри:\n${root}`,
      "",
      "Ответьте именно на это сообщение. Если отправить имя обычным сообщением, оно уйдёт в текущую Codex-сессию.",
      "",
      "Разрешены латинские буквы, цифры, подчёркивание и дефис.",
    ].join("\n");
    const requestMessage = await sendMessage(chatId, prompt, telegramReplyExtra(query.message?.message_id));
    rememberPendingProjectCreate(chatId, requestMessage.message_id);
    return;
  }

  if (data === "project:list") {
    await answerCallback(query.id, "Projects");
    await editBridgeMessage(target, query.message.message_id, projectCommandsText(), projectCommandsKeyboard());
    return;
  }

  if (data.startsWith("sandbox:")) {
    const sandbox = data.slice("sandbox:".length);
    if (!SANDBOX_MODES.includes(sandbox)) {
      await answerCallback(query.id, "Unknown sandbox");
      return;
    }
    session.sandbox = sandbox;
    saveState();
    await answerCallback(query.id, `Sandbox: ${session.sandbox}`);
    await editBridgeMessage(target, query.message.message_id, statusText(target.key), statusKeyboard());
    return;
  }

  if (data.startsWith("approval:")) {
    const approvalPolicy = data.slice("approval:".length);
    if (!APPROVAL_POLICIES.includes(approvalPolicy)) {
      await answerCallback(query.id, "Unknown approval policy");
      return;
    }
    session.approvalPolicy = approvalPolicy;
    saveState();
    await answerCallback(query.id, `Approval: ${session.approvalPolicy}`);
    await editBridgeMessage(target, query.message.message_id, statusText(target.key), statusKeyboard());
    return;
  }

  if (data.startsWith("project:select:")) {
    const index = Number(data.slice("project:select:".length));
    if (Number.isInteger(index) && config.projects[index]) {
      const workdir = config.projects[index];
      const alias = projectAliasForPath(workdir);
      const newTarget = createTelegramProjectSession(chatId, { alias, workdir, prompt: "" });
      saveState();
      await answerCallback(query.id, "Project session started");
      await editBridgeMessage(newTarget, query.message.message_id, `Project session started:\n${workdir}`, statusKeyboard());
    } else {
      await answerCallback(query.id, "Unknown project");
    }
    return;
  }

  if (data === "stop") {
    await answerCallback(query.id, "Stopping");
    await stopRun(target);
    return;
  }

  if (data === "logs:toggle") {
    const live = findLiveProgress(target, query.message);
    if (!live) {
      await answerCallback(query.id, "No live logs");
      return;
    }
    live.expanded = !live.expanded;
    if (!live.expanded) live.collapsedLineCount = TOGGLED_COLLAPSED_LIVE_LOG_LINES;
    await answerCallback(query.id, live.expanded ? "More logs" : "Collapsed");
    await flushLive(live, true);
    return;
  }

  if (data === "status") {
    await answerCallback(query.id, "Status");
    await editBridgeMessage(target, query.message.message_id, statusText(target.key), statusKeyboard());
    return;
  }

  if (data === "answer:custom") {
    session.pendingAnswer = true;
    saveState();
    await answerCallback(query.id, "Waiting for your text answer");
    await sendBridgeMessage(target, "Send your answer as the next message. I will pass it back to Codex in the same thread.");
    return;
  }

  if (data === "answer:assume") {
    delete session.pendingAnswer;
    saveState();
    await answerCallback(query.id, "Continuing");
    await runCodex(target, "Make a reasonable assumption, state it briefly, and continue.");
    return;
  }

  await answerCallback(query.id, "Unknown action");
}

async function handleMediaCallback(query, data) {
  const chatId = query.message?.chat?.id;
  const [, action, mediaId] = data.split(":");
  console.log(`media callback received: action=${action || ""} mediaId=${mediaId || ""} chat=${chatId || ""} from=${query.from?.id || ""} message=${query.message?.message_id || ""}`);
  if (!mediaId) {
    await answerCallback(query.id, "Missing media id");
    return;
  }

  try {
    const cachedItem = getMediaItem(config.mediaCacheRoot, mediaId, { sync: false });
    const found = cachedItem ? { project: cachedItem.sourceProject?.path || config.mediaCacheRoot, item: cachedItem } : null;
    console.log(`media callback lookup: action=${action || ""} mediaId=${mediaId} found=${found ? "yes" : "no"} project=${found?.project || ""}`);
    if (action === "info") {
      if (!found) {
        console.log(`media info not found: mediaId=${mediaId}`);
        await answerCallback(query.id, "Media not found");
        await editMediaCallbackMessage(query.message, `Media not found or already removed:\n${mediaId}`, undefined);
        return;
      }
      await answerCallback(query.id, "Info");
      await editMediaCallbackMessage(query.message, formatMediaInfo(found.project, found.item), mediaKeyboard(mediaId));
      console.log(`media info shown: mediaId=${mediaId} project=${found.project}`);
      return;
    }

    if (action === "delete") {
      if (!found) {
        console.log(`media delete not found: mediaId=${mediaId}`);
        await answerCallback(query.id, "Already removed");
        await editMediaCallbackMessage(query.message, `File already removed from storage:\n${mediaId}`, undefined);
        return;
      }
      const result = deleteMediaItem(config.mediaCacheRoot, mediaId);
      console.log(`media delete result: mediaId=${mediaId} project=${found.project} deleted=${result.deleted} fileDeleted=${result.fileDeleted} file=${result.filePath || ""}`);
      await answerCallback(query.id, result.deleted ? "Deleted" : "Already removed");
      await editMediaCallbackMessage(query.message, [
        "File deleted from storage.",
        `mediaId: ${mediaId}`,
        result.filePath ? `file: ${result.filePath}` : "",
        `project: ${found.project}`,
      ].filter(Boolean).join("\n"), undefined);
      return;
    }

    console.log(`unknown media action: action=${action || ""} mediaId=${mediaId}`);
    await answerCallback(query.id, "Unknown media action");
    if (chatId) {
      const sessionKey = query.message?.message_id ? findTelegramSessionKeyByMessage(chatId, query.message.message_id) : "";
      const session = sessionKey ? getSession(sessionKey) : null;
      await sendMessage(chatId, `Unknown media action: ${action || ""}`, telegramSessionReplyExtra(session));
    }
  } catch (error) {
    console.error(`media callback failed: action=${action || ""} mediaId=${mediaId} error=${error.stack || error.message}`);
    await answerCallback(query.id, `Media action failed: ${error.message}`).catch(() => {});
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!isAllowed(userId)) {
    await sendMessage(chatId, "Access denied.", telegramReplyExtra(message.message_id));
    return;
  }

  const text = (message.text || message.caption || "").trim();
  const audio = getAudioAttachment(message);
  const jsonDocument = getJsonDocumentAttachment(message);
  const voicePrompt = Boolean(message.voice?.file_id);
  const inboxAttachment = getInboxAttachment(message);
  if (!text && !audio && !jsonDocument && !inboxAttachment) return;

  if (text && await handlePendingProjectCreateReply(message, text)) return;

  const projectDeleteCommand = parseProjectDeleteCommand(text);
  if (projectDeleteCommand) {
    await handleProjectDeleteCommand(chatId, projectDeleteCommand, message.message_id);
    return;
  }

  const scheduleCommand = parseScheduleCommand(text);
  if (scheduleCommand) {
    await handleScheduleCommandMessage(message, scheduleCommand);
    return;
  }

  if (!text.startsWith("/") && activatePendingScheduleSession(chatId)) {
    bindTelegramMessageToSession(telegramTarget(chatId, getActiveTelegramSessionKey(chatId)), message.message_id);
  }

  const projectCommand = parseProjectCommand(text);
  let target = null;
  let session = null;
  if (projectCommand) {
    target = createTelegramProjectSession(chatId, projectCommand);
    session = getSession(target.key);
    bindTelegramMessageToSession(target, message.message_id);
  } else {
    const replySessionKey = message.reply_to_message?.message_id
      ? findTelegramSessionKeyByMessage(chatId, message.reply_to_message.message_id)
      : "";
    const activeSessionKey = replySessionKey || getActiveTelegramSessionKey(chatId);
    if (activeSessionKey) {
      target = telegramTarget(chatId, activeSessionKey);
      session = getSession(target.key);
      setActiveTelegramSessionKey(chatId, target.key);
      bindTelegramMessageToSession(target, message.message_id);
      saveState();
    }
  }

  if (!target || !session) {
    if (await handleGlobalCommandWithoutSession(chatId, text, message.message_id)) return;
    await sendMessage(
      chatId,
      `No active project session. Start one with a project command, for example:\n${firstProjectCommandExample()}`,
      telegramReplyExtra(message.message_id),
    );
    return;
  }

  rememberTelegramUserMessage(target, message);

  let inboxPath = "";
  let inboxRecord = null;
  let inboxEchoSent = false;
  if (inboxAttachment) {
    try {
      inboxPath = await saveInboxAttachment(session, inboxAttachment);
      inboxRecord = recordInboxMedia(session, message, inboxAttachment, inboxPath);
      inboxRecord = await processMediaTriggers(session, inboxRecord);
      bindTelegramMessageToSession(target, message.message_id);
    } catch (error) {
      await sendBridgeMessage(target, `Failed to cache media: ${error.message}`);
      return;
    }
    try {
      if (!voicePrompt) {
        const echoMessage = await sendInboxMediaMessage(target, inboxRecord);
        recordInboxEchoMessage(session, inboxRecord, echoMessage);
        bindTelegramMessageToSession(target, echoMessage?.message_id);
        inboxEchoSent = true;
      }
    } catch (error) {
      await sendBridgeMessage(target, `Media cached, but controls could not be sent: ${error.message}\n\n${formatSavedInboxMessage(inboxRecord, inboxPath)}`);
    }
  }
  if (audio) {
    await handleAudioMessage(target, session, audio, inboxPath, inboxRecord, { runAsPrompt: voicePrompt || Boolean(text), userText: text });
    return;
  }
  if (jsonDocument) {
    await handleJsonDocumentMessage(target, session, jsonDocument, message.caption || "", inboxPath, inboxRecord);
    return;
  }
  if (inboxPath && !text) {
    appendHistory(session, {
      role: "user",
      text: `Uploaded ${inboxAttachment.mediaType}: ${inboxPath}`,
      adapter: "telegram",
      userId: String(userId || ""),
      media: inboxAttachment.mediaType,
      attachmentPath: inboxPath,
      mediaId: inboxRecord?.mediaId || "",
      messageId: String(message.message_id || ""),
      replyToMessageId: String(message.reply_to_message?.message_id || ""),
      at: new Date().toISOString(),
    });
    saveState();
    if (!inboxEchoSent) await sendBridgeMessage(target, formatSavedInboxMessage(inboxRecord, inboxPath));
    return;
  }
  let replyInboxContext = null;
  if (text) {
    try {
      replyInboxContext = await getReplyInboxContext(session, message);
    } catch (error) {
      await sendBridgeMessage(target, `Файл из reply не найден в Inbox: ${error.message}`);
      return;
    }
  }
  if (!replyInboxContext && inboxRecord) {
    replyInboxContext = { record: inboxRecord, path: resolvedReplyMediaPath(inboxRecord) };
  }

  appendHistory(session, {
    role: "user",
    text,
    adapter: "telegram",
    userId: String(userId || ""),
    messageId: String(message.message_id || ""),
    replyToMessageId: String(message.reply_to_message?.message_id || ""),
    at: new Date().toISOString(),
  });
  saveState();

  if (session.scheduleMode) {
    clearPendingScheduleSession(chatId);
    await runCodex(target, buildSchedulePrompt(session, text, {
      action: session.scheduleAction || "dialog",
      taskRef: session.scheduleTaskRef || "",
    }));
    return;
  }

  if (session.pendingAnswer && !text.startsWith("/")) {
    delete session.pendingAnswer;
    saveState();
    await runCodex(target, buildTextPrompt(`User answer to your previous question:\n\n${text}`, replyInboxContext));
    return;
  }

  if (projectCommand) {
    await handleProjectCommand(target, session, projectCommand);
    return;
  }

  const bridgeCommand = parseBridgeCommand(text);
  if (bridgeCommand) {
    if (!bridgeCommand.prompt) {
      await sendBridgeMessage(target, `Usage: ${config.bridgeCommands[0]} <task>\nAdd --history when Codex needs recent dialog context.`);
      return;
    }
    await runCodex(target, buildPrompt(session, bridgeCommand, text, replyInboxContext));
    return;
  }

  if (text.startsWith("/")) {
    await handleCommand(target, text);
    return;
  }

  await runCodex(target, buildTextPrompt(text, replyInboxContext));
}

async function handleCommand(target, text) {
  const chatId = target.chatId;
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (command) {
    case "/start":
    case "/help":
      await sendBridgeMessage(target, helpText(), { reply_markup: statusKeyboard() });
      return;
    case "/status":
      await sendBridgeMessage(target, statusText(target.key), { reply_markup: statusKeyboard() });
      return;
    case "/new": {
      const session = getSession(target.key);
      delete session.threadId;
      saveState();
      await sendBridgeMessage(target, "New Codex thread will be started on the next message.");
      return;
    }
    case "/resume": {
      const session = getSession(target.key);
      await sendBridgeMessage(target, session.threadId ? `Will resume thread:\n${session.threadId}` : "No saved thread id yet.");
      return;
    }
    case "/stop":
      await stopRun(target);
      return;
    case "/cancel": {
      const session = getSession(target.key);
      delete session.pendingAnswer;
      saveState();
      await sendBridgeMessage(target, "Pending answer mode cleared.");
      return;
    }
    case "/projects":
      await sendBridgeMessage(target, projectCommandsText(), { reply_markup: projectCommandsKeyboard() });
      return;
    case "/model": {
      const session = getSession(target.key);
      if (arg) {
        session.model = arg;
        saveState();
      }
      await sendBridgeMessage(target, `Model: ${session.model || config.defaultModel || "Codex default"}`);
      return;
    }
    case "/sandbox": {
      const session = getSession(target.key);
      if (arg) {
        if (!SANDBOX_MODES.includes(arg)) {
          await sendBridgeMessage(target, `Allowed: /sandbox ${SANDBOX_MODES.join("|")}`);
          return;
        }
        session.sandbox = arg;
        saveState();
      }
      await sendBridgeMessage(target, `Sandbox: ${session.sandbox || config.defaultSandbox}`, { reply_markup: sandboxKeyboard() });
      return;
    }
    case "/approval": {
      const session = getSession(target.key);
      if (arg) {
        if (!APPROVAL_POLICIES.includes(arg)) {
          await sendBridgeMessage(target, `Allowed: /approval ${APPROVAL_POLICIES.join("|")}`);
          return;
        }
        session.approvalPolicy = arg;
        saveState();
      }
      await sendBridgeMessage(target, `Approval: ${session.approvalPolicy || config.defaultApprovalPolicy}`, { reply_markup: approvalKeyboard() });
      return;
    }
    case "/diff":
      await runCodex(target, "Review the current git diff and summarize the important changes and risks. Do not modify files.");
      return;
    case "/schedule":
      await handleScheduleCommandMessage({ chat: { id: chatId }, message_id: "", text }, { action: "open", rest: arg });
      return;
    default:
      await sendBridgeMessage(target, `Unknown command: ${command}\n\n${helpText()}`);
  }
}

async function handleGlobalCommandWithoutSession(chatId, text, replyToMessageId = "") {
  const replyExtra = telegramReplyExtra(replyToMessageId);
  const [command] = String(text || "").trim().split(/\s+/);
  switch (command) {
    case "/start":
    case "/help":
      await sendMessage(chatId, helpText(), replyExtra);
      return true;
    case "/projects":
      await sendMessage(chatId, projectCommandsText(), { ...replyExtra, reply_markup: projectCommandsKeyboard() });
      return true;
    case "/schedule":
      await handleScheduleCommandMessage({ chat: { id: chatId }, message_id: replyToMessageId, text }, { action: "open", rest: String(text || "").replace(/^\/schedule(?:@[A-Za-z0-9_]+)?/i, "").trim() });
      return true;
    case "/status":
      await sendMessage(chatId, "No active project session.", replyExtra);
      return true;
    default:
      return false;
  }
}

async function handleScheduleCommandMessage(message, scheduleCommand) {
  const chatId = message.chat.id;
  const currentProject = currentTelegramProject(chatId);
  const target = createTelegramScheduleSession(chatId, {
    currentProject,
    action: scheduleCommand.action,
    taskRef: scheduleCommand.taskRef || "",
  });
  const session = getSession(target.key);
  if (message.message_id) {
    rememberTelegramUserMessage(target, message);
    bindTelegramMessageToSession(target, message.message_id);
  }

  if (scheduleCommand.action === "open" && !scheduleCommand.rest) {
    await sendBridgeMessage(target, formatScheduleTaskList(chatId, currentProject));
    return;
  }

  if (scheduleCommand.action === "edit" && !scheduleCommand.rest) {
    const task = getScheduleTask(ROOT, chatId, scheduleCommand.taskRef);
    await sendBridgeMessage(target, task ? formatScheduleTaskDetails(task) : `Task not found: ${scheduleCommand.taskRef}`);
    if (task) rememberPendingScheduleSession(chatId, target.key, task.id);
    return;
  }

  const prompt = buildSchedulePrompt(session, scheduleCommand.rest || message.text || "", scheduleCommand);
  await runCodex(target, prompt);
}

function parseScheduleCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const scheduleMatch = trimmed.match(/^\/schedule(?:@[A-Za-z0-9_]+)?(?:\s+|$)([\s\S]*)/i);
  if (scheduleMatch) return { action: "open", rest: (scheduleMatch[1] || "").trim() };
  const editMatch = trimmed.match(/^\/edit_(?:task_)?([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+|$)([\s\S]*)/i);
  if (editMatch) return { action: "edit", taskRef: editMatch[1], rest: (editMatch[2] || "").trim() };
  const deleteMatch = trimmed.match(/^\/delete_(?:task_)?([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+|$)([\s\S]*)/i);
  if (deleteMatch) return { action: "delete", taskRef: deleteMatch[1], rest: (deleteMatch[2] || "").trim() };
  return null;
}

function createTelegramScheduleSession(chatId, options = {}) {
  const now = new Date().toISOString();
  const sessionId = createSessionId(SCHEDULE_SESSION_ALIAS);
  const key = `telegram:${chatId}:${sessionId}`;
  state.sessions ||= {};
  state.sessions[key] = {
    id: sessionId,
    key,
    adapter: "telegram",
    chatId: String(chatId),
    workdir: SCHEDULE_PROJECT,
    projectCommand: SCHEDULE_SESSION_ALIAS,
    scheduleMode: true,
    scheduleCurrentProject: options.currentProject || config.projects[0],
    scheduleAction: options.action || "open",
    scheduleTaskRef: options.taskRef || "",
    sandbox: config.defaultSandbox,
    approvalPolicy: config.defaultApprovalPolicy,
    model: config.defaultModel,
    createdAt: now,
    lastUserActivityAt: now,
    lastBotActivityAt: "",
  };
  setActiveTelegramSessionKey(chatId, key);
  saveState();
  return telegramTarget(chatId, key);
}

function currentTelegramProject(chatId) {
  const activeKey = getActiveTelegramSessionKey(chatId);
  const session = activeKey ? getSession(activeKey) : null;
  const workdir = session?.scheduleMode ? session.scheduleCurrentProject : session?.workdir;
  return path.resolve(workdir || config.projects[0]);
}

function rememberPendingScheduleSession(chatId, sessionKey, taskId) {
  state.telegramChats ||= {};
  const key = String(chatId);
  state.telegramChats[key] ||= {};
  state.telegramChats[key].pendingScheduleSessionKey = sessionKey;
  state.telegramChats[key].pendingScheduleTaskId = taskId || "";
  state.telegramChats[key].pendingScheduleExpiresAt = new Date(Date.now() + 30 * 60000).toISOString();
  saveState();
}

function activatePendingScheduleSession(chatId) {
  const chat = state.telegramChats?.[String(chatId)];
  const sessionKey = chat?.pendingScheduleSessionKey || "";
  if (!sessionKey) return false;
  if (chat.pendingScheduleExpiresAt && Date.parse(chat.pendingScheduleExpiresAt) < Date.now()) {
    clearPendingScheduleSession(chatId);
    return false;
  }
  const session = getSession(sessionKey);
  if (!session.scheduleMode) {
    clearPendingScheduleSession(chatId);
    return false;
  }
  setActiveTelegramSessionKey(chatId, sessionKey);
  saveState();
  return true;
}

function clearPendingScheduleSession(chatId) {
  const chat = state.telegramChats?.[String(chatId)];
  if (!chat) return;
  delete chat.pendingScheduleSessionKey;
  delete chat.pendingScheduleTaskId;
  delete chat.pendingScheduleExpiresAt;
  saveState();
}

function rememberPendingProjectCreate(chatId, messageId) {
  state.telegramChats ||= {};
  const key = String(chatId);
  state.telegramChats[key] ||= {};
  state.telegramChats[key].pendingProjectCreateMessageId = String(messageId || "");
  state.telegramChats[key].pendingProjectCreateRoot = config.projectCreateRoot;
  state.telegramChats[key].pendingProjectCreateExpiresAt = new Date(Date.now() + 10 * 60000).toISOString();
  saveState();
}

function clearPendingProjectCreate(chatId) {
  const chat = state.telegramChats?.[String(chatId)];
  if (!chat) return;
  delete chat.pendingProjectCreateMessageId;
  delete chat.pendingProjectCreateRoot;
  delete chat.pendingProjectCreateExpiresAt;
  saveState();
}

function pendingProjectCreateForReply(chatId, replyMessageId) {
  const chat = state.telegramChats?.[String(chatId)];
  if (!chat?.pendingProjectCreateMessageId) return null;
  if (chat.pendingProjectCreateExpiresAt && Date.parse(chat.pendingProjectCreateExpiresAt) < Date.now()) {
    clearPendingProjectCreate(chatId);
    return null;
  }
  if (String(replyMessageId || "") !== String(chat.pendingProjectCreateMessageId)) return null;
  return {
    messageId: chat.pendingProjectCreateMessageId,
    root: chat.pendingProjectCreateRoot || config.projectCreateRoot,
  };
}

async function handlePendingProjectCreateReply(message, text) {
  const chatId = message.chat.id;
  const pending = pendingProjectCreateForReply(chatId, message.reply_to_message?.message_id);
  if (!pending) return false;

  clearPendingProjectCreate(chatId);
  const name = text.trim().split(/\s+/)[0] || "";
  try {
    const result = await runProjectManager("create", ["--name", name, "--root", pending.root]);
    applyProjectManagerResult(result);
    const target = createTelegramProjectSession(chatId, {
      alias: result.alias,
      workdir: result.project,
      prompt: "",
    });
    bindTelegramMessageToSession(target, message.message_id);
    await sendBridgeMessage(target, [
      "Project created.",
      `Command: /${result.alias}`,
      `Path: ${result.project}`,
      `Instructions: ${result.agentsPath}`,
    ].join("\n"));
  } catch (error) {
    await sendMessage(chatId, `Project create failed: ${error.message}`, telegramReplyExtra(message.message_id));
  }
  return true;
}

async function handleProjectDeleteCommand(chatId, projectDeleteCommand, replyToMessageId = "") {
  try {
    const result = await runProjectManager("delete", ["--name", projectDeleteCommand.alias, "--root", config.projectCreateRoot]);
    applyProjectManagerResult(result);
    const activeKey = getActiveTelegramSessionKey(chatId);
    const activeSession = activeKey ? getSession(activeKey) : null;
    if (activeSession && path.resolve(activeSession.workdir || "") === path.resolve(result.project || "")) {
      const fallback = config.projects[0] || "";
      if (fallback) {
        activeSession.workdir = fallback;
        activeSession.projectCommand = projectAliasForPath(fallback);
        delete activeSession.threadId;
        delete activeSession.pendingAnswer;
      }
      saveState();
    }
    await sendMessage(chatId, [
      `Project command deleted: /${result.alias}`,
      `Removed from allowlist: ${result.project}`,
      `Folder removed from disk: ${result.folderRemoved ? "yes" : "no"}`,
    ].join("\n"), telegramReplyExtra(replyToMessageId));
  } catch (error) {
    await sendMessage(chatId, `Project delete failed: ${error.message}`, telegramReplyExtra(replyToMessageId));
  }
}

function formatScheduleTaskList(chatId, currentProject) {
  const project = path.resolve(currentProject || config.projects[0]);
  const tasks = listScheduleTasks(ROOT, chatId).filter(task => path.resolve(task.project) === project);
  const now = new Date();
  const header = `Schedule: /${projectAliasForPath(project)}`;
  if (!tasks.length) {
    return [
      header,
      "Нет задач для этого project.",
    ].join("\n");
  }
  return [
    header,
    "",
    ...tasks.map(task => formatScheduleTaskSummary(task, now)),
  ].join("\n\n");
}

function formatScheduleTaskSummary(task, now = new Date()) {
  return [
    `${task.title || task.name}: ${task.description || "без описания"}`,
    `Запуск: ${formatHumanSchedule(task, now)}`,
    task.status === "disabled" || !task.enabled ? "Отключена" : "",
    `Изменить: /edit_task_${task.id}`,
    `Удалить: /delete_task_${task.id}`,
  ].filter(Boolean).join("\n");
}

function formatScheduleTaskDetails(task, now = new Date()) {
  const nextRun = task.nextRunAt || (task.enabled ? nextCronRun(task.cron, task.timeZone, now)?.toISOString() || "" : "");
  const nextDate = nextRun ? new Date(nextRun) : null;
  return [
    `Task: ${task.title || task.name}`,
    `id: ${task.id}`,
    `name: ${task.name}`,
    `description: ${task.description || ""}`,
    `status: ${task.status || (task.enabled ? "enabled" : "disabled")}`,
    `project: ${task.project}`,
    `schedule: ${task.cron}`,
    `time zone: ${task.timeZone}`,
    `human schedule: ${formatHumanSchedule(task, now)}`,
    nextDate ? `next run: ${formatZonedDate(nextDate, task.timeZone)} ${task.timeZone}` : "next run: none",
    task.lastRunAt ? `last run: ${formatZonedDate(new Date(task.lastRunAt), task.timeZone)} ${task.timeZone}` : "last run: never",
    "",
    "prompt:",
    task.prompt,
    "",
    `Delete: /delete_task_${task.id}`,
    "Send what you want to change.",
  ].filter(Boolean).join("\n");
}

function formatHumanSchedule(task, now = new Date()) {
  if (task.status === "disabled" || !task.enabled) return "отключена";
  const simple = simpleCronText(task.cron);
  if (simple) return simple;
  const nextRun = task.nextRunAt || nextCronRun(task.cron, task.timeZone, now)?.toISOString() || "";
  if (!nextRun) return `${task.cron} (${task.timeZone})`;
  return formatRelativeZonedDate(new Date(nextRun), task.timeZone, now);
}

function simpleCronText(cron) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = String(cron || "").trim().split(/\s+/);
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return "";
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `каждый день в ${time}`;
  if (dayOfMonth === "*" && month === "*" && ["1-5", "1,2,3,4,5"].includes(dayOfWeek)) return `по будням в ${time}`;
  return "";
}

function formatRelativeZonedDate(date, timeZone, now = new Date()) {
  const target = zonedPartsForBot(date, timeZone);
  const current = zonedPartsForBot(now, timeZone);
  const targetDay = Date.UTC(target.year, target.month - 1, target.day);
  const currentDay = Date.UTC(current.year, current.month - 1, current.day);
  const dayDiff = Math.round((targetDay - currentDay) / 86400000);
  const time = `${String(target.hour).padStart(2, "0")}:${String(target.minute).padStart(2, "0")}`;
  if (dayDiff === 0) return `сегодня в ${time}`;
  if (dayDiff === 1) return `завтра в ${time}`;
  return `${String(target.day).padStart(2, "0")}.${String(target.month).padStart(2, "0")}.${target.year} в ${time}`;
}

function zonedPartsForBot(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function buildSchedulePrompt(session, userText, command = {}) {
  const chatId = session.chatId;
  const store = loadScheduleStore(ROOT);
  const user = getScheduleUser(store, chatId);
  const systemTimeZone = getSystemTimeZone();
  const now = new Date();
  const selectedTask = command.taskRef || session.scheduleTaskRef ? getScheduleTask(ROOT, chatId, command.taskRef || session.scheduleTaskRef) : null;
  const currentProject = path.resolve(session.scheduleCurrentProject || config.projects[0]);
  return [
    "You are in Telegram Bridge /schedule mode. Help the user create, edit, or delete persistent Codex cron tasks through dialog.",
    "",
    "Hard rules:",
    "- Do not modify normal project files unless the user explicitly asks for it outside schedule management.",
    "- Use the helper `schedule-task` to read and write schedule state. It is on PATH. Do not edit state/schedule-tasks.json by hand.",
    "- Prefer purpose-built helper commands: use `upsert` for a new fully specified task, `patch` for partial edits, `enable`/`disable` for status-only changes, `rename` for name-only changes, `next` to inspect the next run, `validate-cron` to verify a cron expression, and `delete` only after deletion confirmation.",
    "- Before creating or editing a task, collect enough details. If all required details are clear and the user's time zone is known, save immediately without asking for confirmation, then report the saved configuration briefly.",
    "- Ask a confirmation question only when required details are ambiguous, missing, risky, or the user is asking to delete a task.",
    "- Before deleting a task, ask for explicit confirmation. Delete only after confirmation.",
    "- If a selected task is present, treat follow-up messages as edits to that task unless the user clearly switches context. Do not say you lack access to tasks; the selected task and existing tasks are provided below.",
    "- For relative schedule edits, interpret `forward`, `later`, `вперёд`, `позже`, and `через` as moving the run later. For example, `на две минуты вперёд` means add 2 minutes to the selected task's cron time. Use `schedule-task patch` immediately when the edit is clear.",
    "- If the user's time zone is unknown, ask for it before saving the first task. Save it with `schedule-task set-timezone --chat-id ... --timezone ...` once known.",
    "- Use IANA time zones such as Europe/Berlin or America/New_York.",
    "- Bind new tasks to the current Telegram project shown below unless the user explicitly chooses another allowed project.",
    "- The prompt saved for a task must be the exact instruction that a future Codex CLI run should execute in that task project.",
    "- Use a 5-field cron expression. Convert natural language schedules into cron in the user's time zone.",
    "- Task names must be 1-48 chars and use only A-Z, a-z, 0-9, underscore.",
    "- Use status enabled or disabled.",
    "",
    "Bridge/runtime context:",
    `- chat_id: ${chatId}`,
    `- current Telegram project for new tasks: ${currentProject}`,
    `- allowed projects: ${config.projects.join(", ")}`,
    `- user time zone: ${user.timeZone || "unknown"}`,
    `- bridge system time zone: ${systemTimeZone}`,
    user.timeZone ? `- current user/system offset difference: ${formatOffsetDifference(user.timeZone, systemTimeZone, now)}` : "- current user/system offset difference: unknown until user time zone is set",
    `- current instant: ${now.toISOString()}`,
    "",
    "Existing tasks:",
    listScheduleTasks(ROOT, chatId).map(task => JSON.stringify(task)).join("\n") || "none",
    "",
    selectedTask ? `Selected task:\n${JSON.stringify(selectedTask, null, 2)}` : "",
    "",
    "Helper commands:",
    `- schedule-task list --chat-id ${chatId} --json`,
    `- schedule-task show --chat-id ${chatId} --name <task name or id>`,
    `- schedule-task set-timezone --chat-id ${chatId} --timezone <IANA zone>`,
    `- schedule-task upsert --chat-id ${chatId} --name <name> --title <title> --description <text> --cron "0 9 * * *" --timezone <IANA zone> --project <absolute path> --prompt <prompt> --status enabled`,
    `- schedule-task patch --chat-id ${chatId} --name <task name or id> [--new-name <name>] [--title <title>] [--description <text>] [--cron "0 9 * * *"] [--timezone <IANA zone>] [--project <absolute path>] [--prompt <prompt>] [--status enabled|disabled]`,
    `- schedule-task enable --chat-id ${chatId} --name <task name or id>`,
    `- schedule-task disable --chat-id ${chatId} --name <task name or id>`,
    `- schedule-task rename --chat-id ${chatId} --name <task name or id> --new-name <name> [--title <title>]`,
    `- schedule-task next --chat-id ${chatId} --name <task name or id>`,
    `- schedule-task validate-cron --cron "0 9 * * *" --timezone <IANA zone>`,
    `- schedule-task delete --chat-id ${chatId} --name <task name or id>`,
    "",
    command.action === "edit" ? `The user invoked edit for task reference: ${command.taskRef}` : "",
    command.action === "delete" ? `The user invoked delete for task reference: ${command.taskRef}` : "",
    "",
    "User message:",
    userText || (command.action === "open" ? "Show the current schedule tasks and ask what to create or change." : ""),
  ].filter(Boolean).join("\n");
}

function startScheduleRunner() {
  const tick = () => {
    void runDueScheduleTasks().catch(error => {
      console.error("schedule runner error", error);
    });
  };
  tick();
  setInterval(tick, Math.max(1000, config.scheduleTickMs)).unref();
}

async function runDueScheduleTasks(now = new Date()) {
  const users = listScheduleUsers(ROOT);
  for (const user of users) {
    for (const task of Object.values(user.tasks || {})) {
      if (!task.enabled || task.status === "disabled") continue;
      if (!matchesCronAt(task.cron, now, task.timeZone)) continue;
      const runKey = scheduleRunKey(now, task.timeZone);
      if (task.lastRunKey === runKey) continue;
      if (!isAllowedProject(task.project)) {
        console.warn(`Skipping schedule task ${task.id || task.name}: project is not allowed: ${task.project}`);
        refreshScheduleTaskNextRun(ROOT, user.chatId, task.id || task.name, now);
        continue;
      }
      const projectKey = path.resolve(task.project);
      if (runningProjects.has(projectKey)) continue;
      const target = createTelegramScheduledTaskSession(user.chatId, task);
      markScheduleTaskRun(ROOT, user.chatId, task.id || task.name, runKey, now.toISOString());
      await runCodex(target, buildScheduledTaskPrompt(task, now), {
        liveHeader: `Scheduled task: ${task.title || task.name}\nProject: ${task.project}`,
      });
    }
  }
}

function createTelegramScheduledTaskSession(chatId, task) {
  const now = new Date().toISOString();
  const sessionId = createSessionId(`scheduled_${task.name}`);
  const key = `telegram:${chatId}:${sessionId}`;
  state.sessions ||= {};
  state.sessions[key] = {
    id: sessionId,
    key,
    adapter: "telegram",
    chatId: String(chatId),
    workdir: task.project,
    projectCommand: projectAliasForPath(task.project),
    scheduledTaskId: task.id || "",
    scheduledTaskName: task.name || "",
    sandbox: config.defaultSandbox,
    approvalPolicy: config.defaultApprovalPolicy,
    model: config.defaultModel,
    createdAt: now,
    lastUserActivityAt: "",
    lastBotActivityAt: "",
  };
  saveState();
  return telegramTarget(chatId, key);
}

function buildScheduledTaskPrompt(task, now) {
  return [
    "This is an automatic run of a Telegram Bridge schedule task.",
    `Task id: ${task.id}`,
    `Task name: ${task.name}`,
    `Task title: ${task.title || task.name}`,
    task.description ? `Description: ${task.description}` : "",
    `Schedule: ${task.cron} (${task.timeZone})`,
    `Scheduled instant: ${now.toISOString()}`,
    `Project: ${task.project}`,
    "",
    "Execute the saved task instruction in this project. Report the result concisely to Telegram.",
    "",
    "Saved task instruction:",
    task.prompt,
  ].filter(Boolean).join("\n");
}

function isAllowedProject(project) {
  const resolved = path.resolve(project || "");
  return config.projects.some(allowed => path.resolve(allowed) === resolved);
}

function inferProjectCreateRoot(projects) {
  const first = path.resolve(projects[0] || ROOT);
  if (process.env.HOME && first === path.resolve(process.env.HOME)) return first;
  return path.dirname(first);
}

function getSystemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatOffsetDifference(userTimeZone, systemTimeZone, date = new Date()) {
  const userOffset = timeZoneOffsetMinutes(date, userTimeZone);
  const systemOffset = timeZoneOffsetMinutes(date, systemTimeZone);
  const diff = userOffset - systemOffset;
  if (diff === 0) return "same offset";
  const sign = diff > 0 ? "+" : "-";
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `user is ${sign}${hours}:${String(minutes).padStart(2, "0")} relative to bridge system time`;
}

async function handleProjectCommand(target, session, projectCommand) {
  session.workdir = projectCommand.workdir;
  session.projectCommand = projectCommand.alias;
  session.lastUserActivityAt = new Date().toISOString();
  saveState();

  if (!projectCommand.prompt) {
    await sendBridgeMessage(target, `Project session started:\n${projectCommand.workdir}`);
    return;
  }

  await runCodex(target, projectCommand.prompt);
}

async function runCodex(target, prompt, options = {}) {
  const reusableMessageId = Number(options.liveMessageId || 0);
  const sendOrEditStartMessage = async text => {
    if (Number.isSafeInteger(reusableMessageId) && reusableMessageId > 0) {
      await editBridgeMessage(target, reusableMessageId, text, undefined);
      return { message_id: reusableMessageId };
    }
    return sendBridgeMessage(target, text);
  };

  if (running.has(target.key)) {
    await sendOrEditStartMessage("A Codex turn is already running for this session. Use /stop to cancel it.");
    return;
  }

  const session = getSession(target.key);
  const workdir = session.workdir || config.projects[0];
  const projectKey = path.resolve(workdir);
  const occupyingSessionKey = runningProjects.get(projectKey);
  if (occupyingSessionKey && occupyingSessionKey !== target.key) {
    const occupyingSession = getSession(occupyingSessionKey);
    await sendOrEditStartMessage(`Project is already running another session: /${occupyingSession.projectCommand || projectAliasForPath(occupyingSession.workdir)}. Reply later or stop that session with /stop.`);
    return;
  }
  const sandbox = session.sandbox || config.defaultSandbox;
  const approvalPolicy = session.approvalPolicy || config.defaultApprovalPolicy;
  const model = session.model || config.defaultModel;
  const liveHeader = options.liveHeader ? truncate(clean(options.liveHeader), 1200) : "";

  const args = ["-a", approvalPolicy, "exec", "--json", "--sandbox", sandbox];
  if (model) args.push("--model", model);
  if (config.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (session.threadId) args.push("resume", session.threadId, prompt);
  else args.push(prompt);

  const live = {
    target,
    messageId: null,
    lines: [],
    final: "",
    lastEdit: 0,
    threadId: session.threadId || "",
    expanded: false,
    collapsedLineCount: COLLAPSED_LIVE_LOG_LINES,
    header: liveHeader,
  };

  const startMessage = await sendOrEditStartMessage([
    `Starting Codex in:\n${workdir}\n\nSandbox: ${sandbox}\nApproval: ${approvalPolicy}`,
    liveHeader,
  ].filter(Boolean).join("\n\n"));
  live.messageId = startMessage.message_id;
  rememberLiveProgress(live);

  const child = spawn(config.codexBin, args, {
    cwd: workdir,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const run = { child, live, replaced: false, projectKey };
  running.set(target.key, run);
  runningProjects.set(projectKey, target.key);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  child.stdout.on("data", chunk => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) handleJsonLine(live, session, line);
  });

  child.stderr.on("data", chunk => {
    addLive(live, `stderr: ${clean(chunk).slice(0, 500)}`);
    void flushLive(live, false);
  });

  child.on("error", error => {
    addLive(live, `process error: ${error.message}`);
  });

  child.on("close", async code => {
    if (run.replaced) return;
    if (stdoutBuffer.trim()) handleJsonLine(live, session, stdoutBuffer.trim());
    if (running.get(target.key)?.child === child) running.delete(target.key);
    if (runningProjects.get(projectKey) === target.key) runningProjects.delete(projectKey);
    saveState();
    addLive(live, code === 0 ? "completed" : `failed with exit code ${code}`);
    await flushLive(live, true);
    if (live.final) {
      appendHistory(session, {
        role: "assistant",
        text: live.final,
        adapter: "codex",
        at: new Date().toISOString(),
      });
      saveState();
      await sendBridgeLong(target, live.final);
      if (looksLikeQuestion(live.final)) {
        await sendBridgeMessage(target, "Codex seems to be waiting for your answer.", { reply_markup: answerKeyboard() });
      }
    } else if (code !== 0) {
      const failure = live.lines.slice(-6).join("\n") || `Codex failed with exit code ${code}`;
      await sendBridgeMessage(target, `Codex failed.\n\n${failure}`);
    }
  });
}

function handleJsonLine(live, session, line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    addLive(live, `output: ${clean(line).slice(0, 500)}`);
    void flushLive(live, false);
    return;
  }

  switch (event.type) {
    case "thread.started":
      session.threadId = event.thread_id;
      live.threadId = event.thread_id;
      addLive(live, `thread started: ${event.thread_id}`);
      break;
    case "turn.started":
      addLive(live, "turn started");
      break;
    case "turn.completed":
      addLive(live, formatUsage(event.usage));
      break;
    case "turn.failed":
      addLive(live, `turn failed: ${event.error?.message || "unknown error"}`);
      break;
    case "error":
      addLive(live, `error: ${event.message || JSON.stringify(event)}`);
      break;
    case "item.started":
      addLive(live, formatItem("started", event.item));
      break;
    case "item.completed":
      if (event.item?.type === "agent_message" && event.item.text) {
        live.final = event.item.text;
        addLive(live, "agent message completed");
      } else {
        addLive(live, formatItem("completed", event.item));
      }
      break;
    default:
      if (event.type?.startsWith("item.")) addLive(live, event.type);
  }

  void flushLive(live, false);
}

function formatItem(phase, item = {}) {
  if (item.type === "command_execution") return `${phase}: command ${item.command || ""}`.trim();
  if (item.type === "reasoning") return `${phase}: reasoning`;
  if (item.type === "file_change") return `${phase}: file change ${item.path || ""}`.trim();
  if (item.type === "mcp_tool_call") return `${phase}: MCP ${item.server || ""} ${item.tool || ""}`.trim();
  if (item.type === "web_search") return `${phase}: web search`;
  if (item.type === "plan_update") return `${phase}: plan update`;
  if (item.type === "agent_message") return `${phase}: agent message`;
  return `${phase}: ${item.type || "item"}`;
}

function formatUsage(usage = {}) {
  const input = usage.input_tokens ?? "?";
  const output = usage.output_tokens ?? "?";
  return `turn completed: input ${input}, output ${output}`;
}

function addLive(live, line) {
  const value = clean(line);
  if (!value) return;
  live.lines.push(`${new Date().toLocaleTimeString("en-GB")} ${value}`);
  live.lines = live.lines.slice(-EXPANDED_LIVE_LOG_LINES);
}

async function flushLive(live, force) {
  const now = Date.now();
  if (!force && now - live.lastEdit < config.liveUpdateIntervalMs) return;
  live.lastEdit = now;
  await editBridgeMessage(live.target, live.messageId, renderLiveProgress(live), liveProgressKeyboard(live)).catch(() => {});
}

function renderLiveProgress(live) {
  const limit = live.expanded ? EXPANDED_LIVE_LOG_LINES : (live.collapsedLineCount || COLLAPSED_LIVE_LOG_LINES);
  const lines = live.lines.slice(-limit);
  return truncate([live.header, lines.join("\n") || "Codex progress"].filter(Boolean).join("\n\n"), config.maxTelegramChars);
}

function liveProgressKeyboard(live) {
  return {
    inline_keyboard: [[
      { text: "Stop", callback_data: "stop" },
      { text: "Status", callback_data: "status" },
      { text: live.expanded ? "Less logs" : "More logs", callback_data: "logs:toggle" },
    ]],
  };
}

function rememberLiveProgress(live) {
  if (!live?.target || !live.messageId) return;
  liveProgressMessages.set(liveProgressKey(live.target.chatId, live.messageId), live);
  while (liveProgressMessages.size > 100) {
    const oldestKey = liveProgressMessages.keys().next().value;
    liveProgressMessages.delete(oldestKey);
  }
}

function findLiveProgress(target, message) {
  const chatId = message?.chat?.id || target.chatId;
  const messageId = message?.message_id || "";
  return liveProgressMessages.get(liveProgressKey(chatId, messageId)) || running.get(target.key)?.live || null;
}

function liveProgressKey(chatId, messageId) {
  return `${String(chatId || "").trim()}:${String(messageId || "").trim()}`;
}

async function stopRun(target) {
  const run = running.get(target.key);
  if (!run) {
    await sendBridgeMessage(target, "No running Codex turn for this session.");
    return;
  }
  run.child.kill("SIGTERM");
  setTimeout(() => {
    if (running.has(target.key)) run.child.kill("SIGKILL");
  }, 3000).unref();
  await sendBridgeMessage(target, "Stopping current Codex turn.");
}

function getSession(sessionKey) {
  const key = String(sessionKey);
  state.sessions ||= {};
  state.sessions[key] ||= {
    workdir: config.projects[0],
    projectCommand: projectAliasForPath(config.projects[0]),
    sandbox: config.defaultSandbox,
    approvalPolicy: config.defaultApprovalPolicy,
    model: config.defaultModel,
  };
  return state.sessions[key];
}

function createTelegramProjectSession(chatId, projectCommand) {
  const now = new Date().toISOString();
  const sessionId = createSessionId(projectCommand.alias);
  const key = `telegram:${chatId}:${sessionId}`;
  state.sessions ||= {};
  state.sessions[key] = {
    id: sessionId,
    key,
    adapter: "telegram",
    chatId: String(chatId),
    workdir: projectCommand.workdir,
    projectCommand: projectCommand.alias,
    sandbox: config.defaultSandbox,
    approvalPolicy: config.defaultApprovalPolicy,
    model: config.defaultModel,
    createdAt: now,
    lastUserActivityAt: now,
    lastBotActivityAt: "",
  };
  setActiveTelegramSessionKey(chatId, key);
  saveState();
  return telegramTarget(chatId, key);
}

function createSessionId(alias) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${alias}-${stamp}-${randomUUID().slice(0, 8)}`;
}

function getActiveTelegramSessionKey(chatId) {
  state.telegramChats ||= {};
  return state.telegramChats[String(chatId)]?.activeSessionKey || "";
}

function setActiveTelegramSessionKey(chatId, sessionKey) {
  if (!chatId || !sessionKey) return;
  state.telegramChats ||= {};
  const key = String(chatId);
  state.telegramChats[key] ||= {};
  state.telegramChats[key].activeSessionKey = sessionKey;
  const session = getSession(sessionKey);
  session.lastUserActivityAt = new Date().toISOString();
}

function findTelegramSessionKeyByMessage(chatId, messageId) {
  state.telegramMessageIndex ||= {};
  return state.telegramMessageIndex[telegramMessageIndexKey(chatId, messageId)] || "";
}

function projectAliasForPath(workdir) {
  const resolved = path.resolve(workdir || config.projects[0]);
  for (const [alias, project] of config.projectCommands.entries()) {
    if (path.resolve(project) === resolved) return alias;
  }
  return path.basename(resolved).toLowerCase().replace(/[^\w]+/g, "_");
}

function statusText(sessionKey) {
  const session = getSession(sessionKey);
  const isRunning = running.has(String(sessionKey));
  return [
    "Codex Bridge status",
    "",
    `running: ${isRunning ? "yes" : "no"}`,
    `waiting answer: ${session.pendingAnswer ? "yes" : "no"}`,
    `workdir: ${session.workdir || config.projects[0]}`,
    `project commands: ${formatProjectCommands(config.projectCommands) || "none"}`,
    `sandbox: ${session.sandbox || config.defaultSandbox}`,
    `approval: ${session.approvalPolicy || config.defaultApprovalPolicy}`,
    `skip git repo check: ${config.skipGitRepoCheck ? "yes" : "no"}`,
    `model: ${session.model || config.defaultModel || "Codex default"}`,
    `stt: ${config.sttCommand ? "enabled" : "disabled"}`,
    `history messages: ${session.history?.length || 0}`,
    `thread: ${session.threadId || "none"}`,
  ].join("\n");
}

function helpText() {
  return [
    "Codex Bridge",
    "",
    `Codex runs only when a message starts with: ${config.bridgeCommands.join(", ")}`,
    "Add --history to include recent dialog history in the Codex prompt.",
    "Voice/audio transcripts and JSON captions use the same command parser.",
    "",
    "Commands:",
    "/codex <task> - run Codex without dialog history",
    "/codex --history <task> - run Codex with recent dialog history",
    "/status - show session status",
    "/new - start a fresh Codex thread",
    "/resume - show saved thread",
    "/stop - stop current turn",
    "/cancel - clear pending answer mode",
    "/projects - list, switch, create, or delete projects",
    "/schedule - manage persistent Codex cron tasks",
    projectHelpLine(),
    "/model [name] - show or set model",
    "/sandbox [read-only|workspace-write|danger-full-access] - show or set sandbox",
    "/approval [untrusted|on-request|on-failure|never] - show or set approval policy",
    "/diff - summarize git diff",
    "/help - show this help",
  ].join("\n");
}

function statusKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Read only", callback_data: "sandbox:read-only" }, { text: "Project write", callback_data: "sandbox:workspace-write" }],
      [{ text: "Danger full access", callback_data: "sandbox:danger-full-access" }],
      [{ text: "Ask on request", callback_data: "approval:on-request" }, { text: "Ask untrusted", callback_data: "approval:untrusted" }],
      [{ text: "Projects", callback_data: "project:list" }, { text: "Stop", callback_data: "stop" }],
    ],
  };
}

function sandboxKeyboard() {
  return {
    inline_keyboard: [[
      { text: "Read only", callback_data: "sandbox:read-only" },
      { text: "Project write", callback_data: "sandbox:workspace-write" },
      { text: "Danger full access", callback_data: "sandbox:danger-full-access" },
    ]],
  };
}

function approvalKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "On request", callback_data: "approval:on-request" }, { text: "Untrusted", callback_data: "approval:untrusted" }],
      [{ text: "On failure", callback_data: "approval:on-failure" }, { text: "Never", callback_data: "approval:never" }],
    ],
  };
}

function answerKeyboard() {
  return {
    inline_keyboard: [[
      { text: "Answer with text", callback_data: "answer:custom" },
      { text: "Let Codex decide", callback_data: "answer:assume" },
    ]],
  };
}

function mediaKeyboard(mediaId) {
  return {
    inline_keyboard: [[
      { text: "Info", callback_data: `media:info:${mediaId}` },
      { text: "Delete", callback_data: `media:delete:${mediaId}` },
    ]],
  };
}

function switchSessionProject(session, workdir) {
  session.workdir = workdir;
  delete session.threadId;
  delete session.pendingAnswer;
  delete session.history;
  delete session.seenInbound;
}

function cancelRunningSession(target) {
  const run = running.get(target.key);
  if (!run) return false;

  run.replaced = true;
  running.delete(target.key);
  if (run.projectKey && runningProjects.get(run.projectKey) === target.key) runningProjects.delete(run.projectKey);
  run.child.kill("SIGTERM");
  setTimeout(() => {
    if (!run.child.killed) run.child.kill("SIGKILL");
  }, 3000).unref();
  return true;
}

function parseProjectCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || config.projectCommands.size === 0) return null;

  const match = trimmed.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+|$)([\s\S]*)/);
  if (!match) return null;

  const alias = match[1].toLowerCase();
  const workdir = config.projectCommands.get(alias);
  if (!workdir) return null;

  return {
    alias,
    workdir,
    prompt: (match[2] || "").trim(),
  };
}

function parseProjectDeleteCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/delete_([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+|$)/);
  if (!match) return null;
  const alias = match[1].toLowerCase();
  const workdir = config.projectCommands.get(alias);
  if (!workdir) return null;
  return { alias, workdir };
}

function parseProjectCommandSpec(spec, projects) {
  const commands = new Map();
  for (const project of projects) {
    addProjectAlias(commands, path.basename(project), project);
  }
  if (projects.includes("/home/agent")) addProjectAlias(commands, "agent", "/home/agent");

  for (const item of csv(spec)) {
    const match = item.match(/^\/?([A-Za-z0-9_]+)=(.+)$/);
    if (!match) throw new Error(`Invalid PROJECT_COMMANDS entry: ${item}`);
    const alias = match[1].toLowerCase();
    const workdir = path.resolve(match[2].trim());
    if (!projects.includes(workdir)) {
      throw new Error(`PROJECT_COMMANDS path must be present in PROJECT_ALLOWLIST: ${workdir}`);
    }
    addProjectAlias(commands, alias, workdir);
  }
  return commands;
}

function addProjectAlias(commands, alias, workdir) {
  const normalized = String(alias || "").trim().toLowerCase();
  if (!normalized || !/^[a-z0-9_]+$/.test(normalized)) return;
  commands.set(normalized, workdir);
}

function formatProjectCommands(commands) {
  return [...commands.entries()].map(([alias, workdir]) => `/${alias}=${workdir}`).join(", ");
}

function projectCommandsText() {
  const entries = [...config.projectCommands.entries()];
  if (entries.length === 0) {
    return [
      "Project commands",
      "",
      "No project commands configured.",
      "",
      `Create root: ${config.projectCreateRoot}`,
    ].join("\n");
  }
  return [
    "Project commands",
    "",
    `Create root: ${config.projectCreateRoot}`,
    "",
    ...entries.map(([alias, workdir]) => [
      `/${alias} - ${workdir}`,
      `\`/delete_${alias}\``,
    ].join("\n")),
  ].join("\n");
}

function projectCommandsKeyboard() {
  return {
    inline_keyboard: [[
      { text: "Create new project", callback_data: "project:create" },
    ]],
  };
}

function projectHelpLine() {
  const commands = formatProjectCommands(config.projectCommands);
  if (!commands) return "/<project> [task] - switch project mode";
  return `/<project> [task] - switch project mode (${commands})`;
}

function firstProjectCommandExample() {
  const first = config.projectCommands.keys().next().value;
  return first ? `/${first} <task>` : "/<project> <task>";
}

async function sendMessage(chatId, text, extra = {}) {
  const messageText = truncate(text, config.maxTelegramChars);
  const formatted = formatTelegramHtml(messageText);
  try {
    return await telegram("sendMessage", {
      chat_id: chatId,
      text: formatted,
      parse_mode: "HTML",
      ...extra,
    });
  } catch (error) {
    if (!isTelegramParseError(error)) throw error;
  }
  return telegram("sendMessage", {
    chat_id: chatId,
    text: messageText,
    ...extra,
  });
}

async function sendLong(chatId, text) {
  const chunks = chunkTelegramHtmlText(text, config.maxTelegramChars);
  for (const chunk of chunks) {
    try {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: chunk.html,
        parse_mode: "HTML",
      });
    } catch (error) {
      if (!isTelegramParseError(error)) throw error;
      await telegram("sendMessage", {
        chat_id: chatId,
        text: truncate(chunk.raw, config.maxTelegramChars),
      });
    }
  }
}

async function editMessage(message, text, replyMarkup) {
  return editTelegramMessageText(message.chat.id, message.message_id, text, replyMarkup);
}

async function editMediaCallbackMessage(message, text, replyMarkup) {
  try {
    return await telegram("editMessageCaption", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      caption: truncate(text, 1000),
      reply_markup: replyMarkup,
    });
  } catch (error) {
    return editMessage(message, text, replyMarkup);
  }
}

async function sendInboxMediaMessage(target, record) {
  if (!record?.file?.path) return null;
  const session = getSession(target.key);
  const message = await sendTelegramDocument(
    target.chatId,
    record.file.path,
    record.file.mimeType || "application/octet-stream",
    withProjectSignature(formatInboxMediaCaption(record), session),
    mediaKeyboard(record.mediaId),
    telegramSessionReplyExtra(session),
  );
  bindTelegramMessageToSession(target, message?.message_id);
  return message;
}

async function sendTelegramDocument(chatId, filePath, mimeType, caption, replyMarkup, extra = {}) {
  const form = new FormData();
  const fileName = path.basename(filePath);
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([readFileSync(filePath)], { type: mimeType }), fileName);
  form.append("caption", truncate(caption, 1000));
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  appendTelegramMultipartExtra(form, extra);
  return telegramMultipart("sendDocument", form);
}

async function answerCallback(callbackQueryId, text) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

function telegramTarget(chatId, sessionKey = "") {
  const key = sessionKey || getActiveTelegramSessionKey(chatId) || "telegram";
  return { adapter: "telegram", key, chatId };
}

function collabmdTarget(sessionId) {
  return { adapter: "collabmd", key: `collabmd:${sessionId}`, sessionId };
}

async function sendBridgeMessage(target, text, extra = {}) {
  if (target.adapter === "telegram") {
    const session = getSession(target.key);
    const message = await sendMessage(target.chatId, withProjectSignature(text, session), {
      ...telegramSessionReplyExtra(session),
      ...extra,
    });
    session.lastBotActivityAt = new Date().toISOString();
    bindTelegramMessageToSession(target, message?.message_id);
    return message;
  }
  return pushCollabmdOutbox(target.sessionId, "message", { text: truncate(text, config.maxTelegramChars), extra });
}

async function sendBridgeLong(target, text) {
  if (target.adapter === "telegram") return sendSessionLong(target, text);
  const chunks = chunkText(text, config.maxTelegramChars);
  for (const chunk of chunks) await sendBridgeMessage(target, chunk);
}

async function sendSessionLong(target, text) {
  const session = getSession(target.key);
  const signed = withProjectSignature(text, session);
  const chunks = chunkTelegramHtmlText(signed, config.maxTelegramChars);
  const replyExtra = telegramSessionReplyExtra(session);
  for (const chunk of chunks) {
    let message;
    try {
      message = await telegram("sendMessage", {
        chat_id: target.chatId,
        text: chunk.html,
        parse_mode: "HTML",
        ...replyExtra,
      });
    } catch (error) {
      if (!isTelegramParseError(error)) throw error;
      message = await telegram("sendMessage", {
        chat_id: target.chatId,
        text: truncate(chunk.raw, config.maxTelegramChars),
        ...replyExtra,
      });
    }
    session.lastBotActivityAt = new Date().toISOString();
    bindTelegramMessageToSession(target, message?.message_id);
  }
}

async function editBridgeMessage(target, messageId, text, replyMarkup) {
  if (target.adapter === "telegram") {
    const session = getSession(target.key);
    session.lastBotActivityAt = new Date().toISOString();
    bindTelegramMessageToSession(target, messageId);
    return editTelegramMessageText(target.chatId, messageId, withProjectSignature(text, session), replyMarkup);
  }
  return pushCollabmdOutbox(target.sessionId, "edit", {
    message_id: messageId,
    text: truncate(text, config.maxTelegramChars),
    reply_markup: replyMarkup,
  });
}

function withProjectSignature(text, session) {
  const signature = projectSignature(session);
  const value = String(text || "");
  if (!signature) return value;
  if (value.trimEnd().endsWith(signature)) return value;
  return `${value.trimEnd()}\n\n${signature}`;
}

function projectSignature(session) {
  const alias = String(session?.projectCommand || projectAliasForPath(session?.workdir) || "").trim();
  return alias ? `/${alias}` : "";
}

function rememberTelegramUserMessage(target, message) {
  if (target.adapter !== "telegram" || !message?.message_id || !target.key || target.key === "telegram") return;
  const session = getSession(target.key);
  session.lastUserTelegramMessageId = String(message.message_id);
  session.lastUserActivityAt = new Date().toISOString();
  saveState();
}

function telegramSessionReplyExtra(session) {
  return telegramReplyExtra(session?.lastUserTelegramMessageId);
}

function telegramReplyExtra(messageId) {
  const id = Number(messageId);
  if (!Number.isSafeInteger(id) || id <= 0) return {};
  return {
    reply_parameters: {
      message_id: id,
      allow_sending_without_reply: true,
    },
  };
}

function appendTelegramMultipartExtra(form, extra = {}) {
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
}

function bindTelegramMessageToSession(target, messageId) {
  if (target.adapter !== "telegram" || !messageId || !target.key || target.key === "telegram") return;
  state.telegramMessageIndex ||= {};
  state.telegramMessageIndex[telegramMessageIndexKey(target.chatId, messageId)] = target.key;
  const session = getSession(target.key);
  session.telegramMessageIds ||= [];
  const id = String(messageId);
  if (!session.telegramMessageIds.includes(id)) {
    session.telegramMessageIds.push(id);
    session.telegramMessageIds = session.telegramMessageIds.slice(-500);
  }
  saveState();
}

function telegramMessageIndexKey(chatId, messageId) {
  return `${String(chatId || "").trim()}:${String(messageId || "").trim()}`;
}

async function editTelegramMessageText(chatId, messageId, text, replyMarkup) {
  const messageText = truncate(text, config.maxTelegramChars);
  const formatted = formatTelegramHtml(messageText);
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: formatted,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  } catch (error) {
    if (!isTelegramParseError(error)) throw error;
  }
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: messageText,
    reply_markup: replyMarkup,
  });
}

async function telegram(method, payload) {
  const res = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function telegramMultipart(method, form) {
  const res = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    body: form,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function handleBridgeTextMessage(target, payload) {
  const text = String(payload.text || "").trim();
  if (!text) return { accepted: false, reason: "empty_message" };

  const session = getSession(target.key);
  const messageId = normalizeInboundMessageId(payload.messageId || payload.id || payload.clientMessageId);
  if (markInboundMessageSeen(session, target, messageId)) {
    saveState();
    return { accepted: false, reason: "duplicate_message" };
  }

  appendHistory(session, {
    role: payload.role || "user",
    text,
    adapter: target.adapter,
    userId: String(payload.userId || ""),
    author: payload.author || "",
    messageId,
    at: payload.at || new Date().toISOString(),
  });
  saveState();

  if (session.pendingAnswer) {
    delete session.pendingAnswer;
    saveState();
    await runCodex(target, `User answer to your previous question:\n\n${text}`);
    return { accepted: true, reason: "pending_answer" };
  }

  const bridgeCommand = parseBridgeCommand(text);
  if (!bridgeCommand) return { accepted: false, reason: "no_bridge_command" };
  if (!bridgeCommand.prompt) {
    await sendBridgeMessage(target, `Usage: ${config.bridgeCommands[0]} <task>`);
    return { accepted: false, reason: "empty_bridge_command" };
  }

  await runCodex(target, buildPrompt(session, bridgeCommand, text));
  return { accepted: true, reason: "bridge_command" };
}

function parseBridgeCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  for (const rawPrefix of config.bridgeCommands) {
    const prefix = rawPrefix.trim();
    if (!prefix) continue;

    let rest = null;
    if (prefix.endsWith(":")) {
      if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) rest = trimmed.slice(prefix.length).trim();
    } else if (prefix.startsWith("/")) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = trimmed.match(new RegExp(`^${escaped}(?:@[A-Za-z0-9_]+)?(?:\\s+|$)([\\s\\S]*)`, "i"));
      if (match) rest = (match[1] || "").trim();
    } else if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      const next = trimmed.slice(prefix.length, prefix.length + 1);
      if (!next || /\s/.test(next)) rest = trimmed.slice(prefix.length).trim();
    }

    if (rest !== null) return parseBridgeArgs(rest);
  }

  return null;
}

function parseBridgeArgs(input) {
  const tokens = input.split(/\s+/).filter(Boolean);
  let includeHistory = config.includeHistoryByDefault;
  const promptTokens = [];
  for (const token of tokens) {
    if (token === "--history" || token === "--with-history" || token === "-H") {
      includeHistory = true;
      continue;
    }
    if (token === "--no-history") {
      includeHistory = false;
      continue;
    }
    promptTokens.push(token);
  }
  return { prompt: promptTokens.join(" ").trim(), includeHistory };
}

function buildPrompt(session, bridgeCommand, originalText, replyInboxContext = null) {
  const prompt = bridgeCommand.prompt || stripBridgePrefix(originalText);
  const replyMedia = formatReplyInboxPromptSection(replyInboxContext);
  if (!bridgeCommand.includeHistory) {
    return [replyMedia, replyMedia ? "Task:" : "", prompt].filter(Boolean).join("\n\n");
  }

  const history = (session.history || [])
    .slice(-config.maxHistoryMessages)
    .map(item => `${item.role || "user"}${item.author ? ` (${item.author})` : ""}: ${item.text}`)
    .join("\n");

  return [
    "Recent dialog history follows. Use it only as context for the requested task.",
    "",
    history,
    "",
    replyMedia,
    "",
    "Task:",
    prompt,
  ].join("\n");
}

function buildTextPrompt(text, replyInboxContext = null) {
  const replyMedia = formatReplyInboxPromptSection(replyInboxContext);
  return [replyMedia, replyMedia ? "Task:" : "", text].filter(Boolean).join("\n\n");
}

function formatReplyInboxPromptSection(replyInboxContext = null) {
  if (!replyInboxContext) return "";
  return [
    "Telegram reply media:",
    formatSavedInboxMessage(replyInboxContext.record, replyInboxContext.path),
    replyInboxContext.record?.sourceProject?.alias ? `source project: ${replyInboxContext.record.sourceProject.alias}` : "",
    replyInboxContext.record?.transcription?.text ? `saved transcript:\n${replyInboxContext.record.transcription.text}` : "",
  ].filter(Boolean).join("\n");
}

function stripBridgePrefix(text) {
  const parsed = parseBridgeCommand(text);
  return parsed?.prompt || String(text || "").trim();
}

function appendHistory(session, item) {
  session.history ||= [];
  session.history.push({
    role: item.role || "user",
    text: String(item.text || "").slice(0, 12000),
    adapter: item.adapter || "",
    userId: item.userId || "",
    author: item.author || "",
    media: item.media || "",
    attachmentPath: item.attachmentPath || "",
    mediaId: item.mediaId || "",
    messageId: item.messageId || "",
    replyToMessageId: item.replyToMessageId || "",
    at: item.at || new Date().toISOString(),
  });
  session.history = session.history.slice(-Math.max(config.maxHistoryMessages * 3, 50));
}

function normalizeInboundMessageId(value) {
  const id = String(value ?? "").trim();
  return id.slice(0, 300);
}

function markInboundMessageSeen(session, target, messageId) {
  if (!messageId) return false;
  session.seenInbound ||= [];
  const key = `${target.adapter}:${messageId}`;
  if (session.seenInbound.includes(key)) return true;
  session.seenInbound.push(key);
  session.seenInbound = session.seenInbound.slice(-Math.max(config.maxHistoryMessages * 6, 200));
  return false;
}

function startCollabmdHttpAdapter() {
  const server = http.createServer((req, res) => {
    void handleCollabmdHttpRequest(req, res).catch(error => {
      console.error("collabmd adapter error", error);
      sendJson(res, 500, { ok: false, error: error.message });
    });
  });

  server.listen(config.collabmdPort, config.collabmdHost, () => {
    console.log(`CollabMD adapter listening on http://${config.collabmdHost}:${config.collabmdPort}`);
  });
}

async function handleCollabmdHttpRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isCollabmdAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || body.conversationId || "").trim();
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "sessionId is required" });
      return;
    }
    const result = await handleBridgeTextMessage(collabmdTarget(sessionId), body);
    sendJson(res, result.accepted ? 202 : 200, { ok: true, ...result });
    return;
  }

  const outboxMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/outbox$/);
  if (req.method === "GET" && outboxMatch) {
    const sessionId = decodeURIComponent(outboxMatch[1]);
    const after = Number(url.searchParams.get("after") || 0);
    const messages = getCollabmdOutbox(sessionId).filter(message => message.id > after);
    sendJson(res, 200, { ok: true, messages });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}

function isCollabmdAuthorized(req) {
  if (!config.collabmdToken) return true;
  const expected = `Bearer ${config.collabmdToken}`;
  return req.headers.authorization === expected || req.headers["x-bridge-token"] === config.collabmdToken;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > config.maxHttpBodyBytes) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function pushCollabmdOutbox(sessionId, type, payload) {
  state.collabmdOutbox ||= {};
  const key = String(sessionId);
  const outbox = state.collabmdOutbox[key] ||= [];
  const message = {
    id: Number(state.nextOutboxId || 1),
    type,
    at: new Date().toISOString(),
    ...payload,
  };
  state.nextOutboxId = message.id + 1;
  outbox.push(message);
  state.collabmdOutbox[key] = outbox.slice(-200);
  saveState();
  return { message_id: message.id };
}

function getCollabmdOutbox(sessionId) {
  state.collabmdOutbox ||= {};
  return state.collabmdOutbox[String(sessionId)] || [];
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function handleAudioMessage(target, session, audio, inboxPath = "", inboxRecord = null, options = {}) {
  if (running.has(target.key)) {
    await sendBridgeMessage(target, "A Codex turn is already running for this session. Use /stop to cancel it.");
    return;
  }
  if (!config.sttCommand) {
    if (inboxPath) {
      appendHistory(session, {
        role: "user",
        text: `Uploaded audio: ${inboxPath}`,
        adapter: target.adapter,
        media: "audio",
        attachmentPath: inboxPath,
        mediaId: inboxRecord?.mediaId || "",
        at: new Date().toISOString(),
      });
      saveState();
    }
    const savedLine = inboxPath ? `${formatSavedInboxMessage(inboxRecord, inboxPath)}\n\n` : "";
    await sendBridgeMessage(target, `${savedLine}STT is not configured. Set STT_COMMAND in .env and restart the bridge.`);
    return;
  }
  if (audio.fileSize && audio.fileSize > config.maxAudioBytes) {
    if (inboxPath) {
      appendHistory(session, {
        role: "user",
        text: `Uploaded audio: ${inboxPath}`,
        adapter: target.adapter,
        media: "audio",
        attachmentPath: inboxPath,
        mediaId: inboxRecord?.mediaId || "",
        at: new Date().toISOString(),
      });
      saveState();
    }
    const savedLine = inboxPath ? `${formatSavedInboxMessage(inboxRecord, inboxPath)}\n\n` : "";
    await sendBridgeMessage(target, `${savedLine}Audio is too large for STT: ${audio.fileSize} bytes. Limit: ${config.maxAudioBytes} bytes.`);
    return;
  }

  const progress = await sendBridgeMessage(target, "Transcribing audio...");
  let tempDir = "";
  try {
    tempDir = mkdtempSync(path.join(tmpdir(), "codex-telegram-audio-"));
    const sourcePath = inboxPath || await downloadTelegramFile(audio.fileId, tempDir, audio.fileName, {
      maxBytes: config.maxAudioBytes,
      label: "audio",
    });
    const wavPath = path.join(tempDir, "audio.wav");
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-ar", "16000", "-ac", "1", wavPath], {
      cwd: ROOT,
      timeoutMs: config.sttTimeoutMs,
    });
    const transcript = (await runSttCommand(wavPath)).trim();
    if (!transcript) {
      await editBridgeMessage(target, progress.message_id, "STT returned an empty transcript.", undefined);
      return;
    }
    if (inboxRecord) {
      inboxRecord.transcription = { status: "completed", text: transcript, updatedAt: new Date().toISOString() };
      upsertMediaRecord(config.mediaCacheRoot, inboxRecord);
    }

    appendHistory(session, {
      role: "user",
      text: transcript,
      adapter: target.adapter,
      media: "audio",
      attachmentPath: inboxPath,
      mediaId: inboxRecord?.mediaId || "",
      at: new Date().toISOString(),
    });
    saveState();

    const liveHeader = formatAudioPromptLiveHeader(transcript);
    if (session.pendingAnswer) {
      delete session.pendingAnswer;
      saveState();
      await runCodex(target, `User answer to your previous question, transcribed from an audio message:\n\n${transcript}`, {
        liveHeader,
        liveMessageId: progress.message_id,
      });
      return;
    }
    if (options.runAsPrompt) {
      const audioPrompt = options.userText && options.userText !== transcript
        ? `Telegram caption:\n${options.userText}\n\nAudio transcript:\n${transcript}`
        : transcript;
      await runCodex(target, buildTextPrompt(audioPrompt, inboxRecord ? { record: inboxRecord, path: resolvedReplyMediaPath(inboxRecord) } : null), {
        liveHeader,
        liveMessageId: progress.message_id,
      });
      return;
    }
    const bridgeCommand = parseBridgeCommand(transcript);
    if (bridgeCommand) {
      await runCodex(target, buildPrompt(session, bridgeCommand, transcript), { liveMessageId: progress.message_id });
    } else {
      await editBridgeMessage(target, progress.message_id, truncate(`Transcribed:\n\n${transcript}`, config.maxTelegramChars), undefined);
      await sendBridgeMessage(target, `Transcript saved to dialog history. Start with ${config.bridgeCommands[0]} to send a task to Codex.`);
    }
  } catch (error) {
    await editBridgeMessage(target, progress.message_id, `Audio transcription failed: ${error.message}`, undefined).catch(() => {});
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function formatAudioPromptLiveHeader(transcript) {
  return `Audio transcript used as prompt:\n${transcript}`;
}

async function handleJsonDocumentMessage(target, session, document, caption, inboxPath = "", inboxRecord = null) {
  if (running.has(target.key)) {
    await sendBridgeMessage(target, "A Codex turn is already running for this session. Use /stop to cancel it.");
    return;
  }
  if (document.fileSize && document.fileSize > config.maxJsonBytes) {
    await sendBridgeMessage(target, `JSON file is too large: ${document.fileSize} bytes. Limit: ${config.maxJsonBytes} bytes.`);
    return;
  }

  const progress = await sendBridgeMessage(target, "Preparing JSON file...");
  try {
    mkdirSync(config.jsonUploadDir, { recursive: true, mode: 0o700 });
    const uploadPath = inboxPath || await downloadTelegramFile(document.fileId, config.jsonUploadDir, document.fileName, {
      maxBytes: config.maxJsonBytes,
      label: "JSON file",
    });
    const effectivePath = inboxRecord ? resolvedReplyMediaPath(inboxRecord) : uploadPath;
    const prompt = [
      "User uploaded JSON file:",
      effectivePath,
      inboxPath ? formatSavedInboxMessage(inboxRecord, inboxPath) : "",
      caption.trim() ? `Caption:\n${caption.trim()}` : "",
    ].filter(Boolean).join("\n");

    appendHistory(session, {
      role: "user",
      text: caption.trim() || `Uploaded JSON file: ${uploadPath}`,
      adapter: target.adapter,
      media: "json",
      attachmentPath: inboxPath,
      mediaId: inboxRecord?.mediaId || "",
      at: new Date().toISOString(),
    });
    saveState();

    await editBridgeMessage(target, progress.message_id, prompt, undefined);
    if (session.pendingAnswer) {
      delete session.pendingAnswer;
      saveState();
      await runCodex(target, prompt);
      return;
    }
    const bridgeCommand = parseBridgeCommand(caption || "");
    if (bridgeCommand) await runCodex(target, buildPrompt(session, bridgeCommand, prompt));
    else if (caption.trim()) await runCodex(target, buildTextPrompt(prompt));
    else await sendBridgeMessage(target, `JSON cached at:\n${uploadPath}`);
  } catch (error) {
    await editBridgeMessage(target, progress.message_id, `JSON file download failed: ${error.message}`, undefined).catch(() => {});
  }
}

function getInboxAttachment(message) {
  const photo = getPhotoAttachment(message);
  if (photo) return photo;

  if (message.voice?.file_id) {
    return {
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id || "",
      fileSize: message.voice.file_size || 0,
      fileName: `voice-${message.message_id || Date.now()}.ogg`,
      originalFileName: `voice-${message.message_id || Date.now()}.ogg`,
      mimeType: message.voice.mime_type || "audio/ogg",
      mediaType: "audio",
    };
  }

  if (message.audio?.file_id) {
    return {
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id || "",
      fileSize: message.audio.file_size || 0,
      fileName: message.audio.file_name || `audio-${message.message_id || Date.now()}`,
      originalFileName: message.audio.file_name || "",
      mimeType: message.audio.mime_type || "",
      mediaType: "audio",
    };
  }

  if (message.video?.file_id) {
    return {
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id || "",
      fileSize: message.video.file_size || 0,
      fileName: message.video.file_name || `video-${message.message_id || Date.now()}.mp4`,
      originalFileName: message.video.file_name || "",
      mimeType: message.video.mime_type || "video/mp4",
      mediaType: "video",
    };
  }

  if (message.animation?.file_id) {
    return {
      fileId: message.animation.file_id,
      fileUniqueId: message.animation.file_unique_id || "",
      fileSize: message.animation.file_size || 0,
      fileName: message.animation.file_name || `animation-${message.message_id || Date.now()}.mp4`,
      originalFileName: message.animation.file_name || "",
      mimeType: message.animation.mime_type || "video/mp4",
      mediaType: "video",
    };
  }

  if (message.video_note?.file_id) {
    return {
      fileId: message.video_note.file_id,
      fileUniqueId: message.video_note.file_unique_id || "",
      fileSize: message.video_note.file_size || 0,
      fileName: `video-note-${message.message_id || Date.now()}.mp4`,
      originalFileName: `video-note-${message.message_id || Date.now()}.mp4`,
      mimeType: "video/mp4",
      mediaType: "video",
    };
  }

  if (message.document?.file_id) {
    const document = message.document;
    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id || "",
      fileSize: document.file_size || 0,
      fileName: document.file_name || `document-${message.message_id || Date.now()}`,
      originalFileName: document.file_name || "",
      mimeType: document.mime_type || "",
      mediaType: "document",
    };
  }

  return null;
}

function getPhotoAttachment(message) {
  const photos = message.photo || [];
  if (!photos.length) return null;
  const largest = photos.reduce((best, item) => {
    const bestSize = Number(best.file_size || 0);
    const itemSize = Number(item.file_size || 0);
    if (itemSize !== bestSize) return itemSize > bestSize ? item : best;
    return Number(item.width || 0) * Number(item.height || 0) > Number(best.width || 0) * Number(best.height || 0) ? item : best;
  }, photos[0]);

  return {
    fileId: largest.file_id,
    fileUniqueId: largest.file_unique_id || "",
    fileSize: largest.file_size || 0,
    fileName: `photo-${message.message_id || Date.now()}.jpg`,
    originalFileName: `photo-${message.message_id || Date.now()}.jpg`,
    mimeType: "image/jpeg",
    mediaType: "image",
  };
}

async function saveInboxAttachment(session, attachment) {
  if (attachment.fileSize && attachment.fileSize > config.maxInboxFileBytes) {
    throw new Error(`${attachment.mediaType} is too large: ${attachment.fileSize} bytes. Limit: ${config.maxInboxFileBytes} bytes.`);
  }

  const cacheDir = path.join(config.mediaCacheRoot, "files", randomUUID());
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  return downloadTelegramFile(attachment.fileId, cacheDir, attachment.fileName, {
    maxBytes: config.maxInboxFileBytes,
    label: attachment.mediaType,
    unique: true,
  });
}

function recordInboxMedia(session, message, attachment, inboxPath) {
  const project = session.workdir || config.projects[0];
  const record = createTelegramMediaRecord({
    project: config.mediaCacheRoot,
    message,
    attachment,
    filePath: inboxPath,
  });
  record.sourceProject = { alias: projectAliasForPath(project), path: project };
  record.expiresAt = new Date(Date.now() + config.mediaCacheTtlDays * 86400000).toISOString();
  record.triggerResults = [];
  return upsertMediaRecord(config.mediaCacheRoot, record).item;
}

async function processMediaTriggers(session, record) {
  const projectPath = session.workdir || config.projects[0];
  const projects = config.projects.map(project => ({ alias: projectAliasForPath(project), path: project }));
  const results = await runMediaTriggers({
    projects,
    sourceProject: { alias: projectAliasForPath(projectPath), path: projectPath },
    record,
    timeoutMs: config.mediaTriggerTimeoutMs,
  });
  record.triggerResults = results.map(item => normalizeTriggerResult(item, projectPath));
  return upsertMediaRecord(config.mediaCacheRoot, record).item;
}

function normalizeTriggerResult(item, projectPath) {
  const result = item.result && typeof item.result === "object" ? { ...item.result } : {};
  result.artifacts = (Array.isArray(result.artifacts) ? result.artifacts : []).flatMap(artifact => {
    const candidate = path.resolve(projectPath, String(artifact?.path || ""));
    const relative = path.relative(projectPath, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(candidate)) return [];
    return [{ ...artifact, path: candidate }];
  });
  return { ...item, result };
}

function recordInboxEchoMessage(session, record, echoMessage) {
  const messageId = echoMessage?.message_id;
  const chatId = echoMessage?.chat?.id || record?.telegram?.chatId || "";
  if (!record?.mediaId || !messageId) return;

  addTelegramMessageAlias(config.mediaCacheRoot, record.mediaId, chatId, messageId);
}

async function getReplyInboxContext(session, message) {
  const reply = message.reply_to_message;
  if (!reply) return null;

  const replyMessage = {
    ...reply,
    chat: reply.chat || message.chat,
  };
  const found = findReplyMediaRecord(config.mediaCacheRoot, replyMessage) || findLegacyReplyMediaRecord(replyMessage);
  if (!found) {
    if (!getInboxAttachment(replyMessage) && !parseMediaId(replyMessage.caption || replyMessage.text || "")) return null;
    throw new Error("запись для этого Telegram-сообщения отсутствует");
  }

  const inboxPath = resolvedReplyMediaPath(found.item, found.project);
  if (!inboxPath || !existsSync(inboxPath)) {
    if (found.item.file?.expiredAt) throw new Error("файл удалён из недельного кэша и не был сохранён проектом; отправьте его повторно");
    throw new Error(found.item.file?.relativePath || found.item.file?.path || "локальный файл отсутствует");
  }

  return { record: found.item, path: inboxPath };
}

function findReplyMediaRecord(project, message) {
  const item = peekMediaByTelegramMessage(project, message.chat.id, message.message_id)
    || getReplyMediaByCaption(project, message);
  return item ? { project, item } : null;
}

function findLegacyReplyMediaRecord(message) {
  for (const project of config.projects) {
    const found = findReplyMediaRecord(project, message);
    if (found) return found;
  }
  return null;
}

function getReplyMediaByCaption(project, message) {
  const mediaId = parseMediaId(message.caption || message.text || "");
  if (!mediaId) return null;
  try {
    return getMediaItem(project, mediaId, { sync: false });
  } catch {
    return null;
  }
}

function resolvedReplyMediaPath(item, recordRoot = config.mediaCacheRoot) {
  for (const trigger of item.triggerResults || []) {
    for (const artifact of trigger.result?.artifacts || []) {
      if (artifact.path && existsSync(artifact.path)) return artifact.path;
    }
  }
  return mediaRecordFilePath(recordRoot, item);
}

function parseMediaId(text) {
  const match = String(text || "").match(/\bmediaId:\s*((?:tg|local)_[A-Za-z0-9_-]+)/);
  return match ? match[1] : "";
}

function mediaRecordFilePath(project, item) {
  if (item?.file?.relativePath) return path.resolve(project, item.file.relativePath);
  if (item?.file?.path) return path.resolve(item.file.path);
  return "";
}

function formatSavedInboxMessage(record, inboxPath) {
  return [
    "Cached Telegram media:",
    inboxPath,
    record?.mediaId ? `mediaId: ${record.mediaId}` : "",
    `index: ${path.join(config.mediaCacheRoot, MEDIA_INDEX_RELATIVE_PATH)}`,
    record?.descriptionStatus ? `description: ${record.descriptionStatus}` : "description: pending",
  ].filter(Boolean).join("\n");
}

function formatInboxMediaCaption(record) {
  return [
    "Cached Telegram media",
    `mediaId: ${record.mediaId}`,
    `type: ${record.file?.mediaType || "file"}`,
    `file: ${record.file?.relativePath || record.file?.path || ""}`,
    `description: ${record.descriptionStatus || "pending"}`,
  ].filter(Boolean).join("\n");
}

function formatMediaInfo(project, item) {
  return [
    "Media info",
    `mediaId: ${item.mediaId}`,
    `project: ${project}`,
    `type: ${item.file?.mediaType || ""}`,
    `mime: ${item.file?.mimeType || ""}`,
    `file: ${item.file?.path || ""}`,
    `relative: ${item.file?.relativePath || ""}`,
    `size: ${item.file?.sizeBytes || 0}`,
    `sha256: ${item.file?.sha256 || ""}`,
    `telegram chat: ${item.telegram?.chatId || ""}`,
    `telegram message: ${item.telegram?.messageId || ""}`,
    `telegram file: ${item.telegram?.fileId || ""}`,
    `telegram unique: ${item.telegram?.fileUniqueId || ""}`,
    `created: ${item.createdAt || ""}`,
    `saved: ${item.savedAt || ""}`,
    `description: ${item.descriptionStatus || "pending"}`,
    item.telegram?.caption ? `caption: ${item.telegram.caption}` : "",
    item.description ? `description text: ${item.description}` : "",
  ].filter(Boolean).join("\n");
}

function cleanupMediaCache() {
  try {
    const cutoff = Date.now() - config.mediaCacheTtlDays * 86400000;
    for (const item of listMediaItems(config.mediaCacheRoot, { sync: false })) {
      const timestamp = Date.parse(item.savedAt || item.createdAt || "");
      if (Number.isFinite(timestamp) && timestamp < cutoff && !item.file?.expiredAt) expireMediaItem(config.mediaCacheRoot, item.mediaId);
    }
  } catch (error) {
    console.warn(`Media cache cleanup failed: ${error.message}`);
  }
}

function getAudioAttachment(message) {
  if (message.voice?.file_id) {
    return {
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id || "",
      fileSize: message.voice.file_size || 0,
      fileName: "voice.ogg",
    };
  }
  if (message.audio?.file_id) {
    return {
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id || "",
      fileSize: message.audio.file_size || 0,
      fileName: message.audio.file_name || "audio",
    };
  }
  if (message.document?.file_id && isAudioDocument(message.document)) {
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id || "",
      fileSize: message.document.file_size || 0,
      fileName: message.document.file_name || "audio",
    };
  }
  return null;
}

function getJsonDocumentAttachment(message) {
  const document = message.document;
  if (!document?.file_id || !isJsonDocument(document)) return null;
  return {
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id || "",
    fileSize: document.file_size || 0,
    fileName: jsonFileName(document.file_name),
  };
}

function isAudioDocument(document) {
  const mime = document.mime_type || "";
  if (mime.startsWith("audio/")) return true;
  return /\.(aac|aiff|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i.test(document.file_name || "");
}

function isJsonDocument(document) {
  const mime = (document.mime_type || "").toLowerCase();
  if (mime === "application/json" || mime === "text/json" || mime.endsWith("+json")) return true;
  return /\.json$/i.test(document.file_name || "");
}

function jsonFileName(fileName) {
  const name = fileName || "upload.json";
  if (/\.json$/i.test(name)) return name;
  return `${name}.json`;
}

async function downloadTelegramFile(fileId, targetDir, fileName, options = {}) {
  const maxBytes = options.maxBytes || config.maxAudioBytes;
  const label = options.label || "file";
  const file = await telegram("getFile", { file_id: fileId });
  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(`${label} is too large: ${file.file_size} bytes`);
  }

  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`${label} is too large: ${buffer.length} bytes`);
  }

  const safeName = path.basename(fileName || file.file_path || "file").replace(/[^\w.-]/g, "_") || "file";
  const target = options.unique ? uniqueFilePath(targetDir, safeName) : path.join(targetDir, safeName);
  writeFileSync(target, buffer, { mode: 0o600 });
  return target;
}

function uniqueFilePath(targetDir, fileName) {
  const parsed = path.parse(fileName);
  const base = parsed.name || "file";
  const ext = parsed.ext || "";
  let candidate = path.join(targetDir, `${base}${ext}`);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = path.join(targetDir, `${base}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

async function runSttCommand(wavPath) {
  const [cmd, ...args] = splitCommand(config.sttCommand);
  if (!cmd) throw new Error("STT_COMMAND is empty");
  const result = await runProcess(cmd, [...args, wavPath], {
    cwd: ROOT,
    timeoutMs: config.sttTimeoutMs,
    env: process.env,
  });
  return result.stdout;
}

async function runProjectManager(command, args = []) {
  const result = await runProcess(path.join(ROOT, "scripts", "project-manager"), [command, ...args], {
    cwd: ROOT,
    timeoutMs: 30000,
    env: process.env,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`project-manager returned invalid JSON: ${clean(result.stdout).slice(0, 500)}`);
  }
}

function applyProjectManagerResult(result) {
  if (!result?.ok) throw new Error("project-manager did not report success");
  const projects = Array.isArray(result.projects) ? result.projects.map(item => path.resolve(item)) : [];
  const commandEntries = Object.entries(result.projectCommands || {});
  if (!projects.length) throw new Error("project-manager returned no projects");

  config.projects = projects;
  config.projectCreateRoot = path.resolve(result.createRoot || config.projectCreateRoot);
  config.projectCommandSpec = commandEntries.map(([alias, project]) => `${alias}=${path.resolve(project)}`).join(",");
  config.projectCommands = parseProjectCommandSpec(config.projectCommandSpec, config.projects);
  process.env.PROJECT_ALLOWLIST = config.projects.join(",");
  process.env.PROJECT_COMMANDS = config.projectCommandSpec;
  process.env.PROJECT_CREATE_ROOT = config.projectCreateRoot;
}

function runProcess(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      done(new Error(`${cmd} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs || 120000);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", done);
    child.on("close", code => {
      if (code === 0) done(null, { stdout, stderr });
      else done(new Error(`${cmd} failed with exit code ${code}: ${clean(stderr).slice(0, 1000)}`));
    });

    function done(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    }
  });
}

function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function isAllowed(userId) {
  return Number.isInteger(userId) && config.allowedUserIds.includes(userId);
}

function childEnv() {
  const env = {};
  for (const key of config.envAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PATH = `${path.join(ROOT, "scripts")}:${env.PATH || process.env.PATH || ""}`;
  env.MEDIA_INDEX_BIN = path.join(ROOT, "scripts", "media-index");
  env.CI = "1";
  return env;
}

function loadState() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return { sessions: {}, offset: 0 };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const data = readFileSync(file, "utf8");
  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function requireEnv(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function csv(value = "") {
  return value.split(",").map(x => x.trim()).filter(Boolean);
}

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function looksLikeQuestion(text) {
  const normalized = text.trim();
  if (normalized.endsWith("?")) return true;
  return /\b(please confirm|which option|do you want|should i|need your|choose|уточн|подтверд|какой вариант|как поступить|выбери|нужно ли)\b/i.test(normalized);
}

function clean(value) {
  return String(value || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
}

function isTelegramParseError(error) {
  return /can't parse entities|parse/i.test(String(error?.message || ""));
}

function escapeTelegramHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTelegramHtml(text) {
  const source = String(text || "");
  const blocks = [];
  let protectedText = source.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_match, code) => {
    const token = `\u0000CODEBLOCK${blocks.length}\u0000`;
    blocks.push(`<pre>${escapeTelegramHtml(code.replace(/\n$/, ""))}</pre>`);
    return token;
  });

  const inline = [];
  protectedText = protectedText.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `\u0000INLINECODE${inline.length}\u0000`;
    inline.push(`<code>${escapeTelegramHtml(code)}</code>`);
    return token;
  });

  let html = escapeTelegramHtml(protectedText);
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_match, index) => blocks[Number(index)] || "");
  html = html.replace(/\u0000INLINECODE(\d+)\u0000/g, (_match, index) => inline[Number(index)] || "");
  return html;
}

function chunkTelegramHtmlText(text, max) {
  const chunks = [];
  let current = "";
  for (const line of String(text || "").split(/(\n)/)) {
    const candidate = current + line;
    if (candidate && formatTelegramHtml(candidate).length <= max) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push({ raw: current, html: formatTelegramHtml(current) });
      current = "";
    }
    if (formatTelegramHtml(line).length <= max) {
      current = line;
      continue;
    }
    for (const part of splitLongTelegramHtmlText(line, max)) chunks.push(part);
  }
  if (current) chunks.push({ raw: current, html: formatTelegramHtml(current) });
  return chunks;
}

function splitLongTelegramHtmlText(text, max) {
  const chunks = [];
  let rest = String(text || "");
  while (rest) {
    let low = 1;
    let high = rest.length;
    let best = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const html = formatTelegramHtml(rest.slice(0, mid));
      if (html.length <= max) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const raw = rest.slice(0, best);
    chunks.push({ raw, html: formatTelegramHtml(raw) });
    rest = rest.slice(best);
  }
  return chunks;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n... truncated ...`;
}

function chunkText(text, max) {
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let split = rest.lastIndexOf("\n", max);
    if (split < max / 2) split = max;
    chunks.push(rest.slice(0, split));
    rest = rest.slice(split).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
