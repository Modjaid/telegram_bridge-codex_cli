import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { PACKAGE_ROOT, resolveBridgePaths } from "./paths.js";

const SERVICE = "codex-telegram-bridge.service";

export async function main(argv, io = {}) {
  const command = argv[0] || "help";
  const args = parseArgs(argv.slice(1));
  const out = io.out || console.log;
  const error = io.error || console.error;
  try {
    if (["help", "--help", "-h"].includes(command)) return out(help());
    if (command === "run") return runBridge();
    if (["start", "stop", "restart", "status"].includes(command)) return serviceCommand(command, out);
    if (command === "setup") return await setup(args, { ...io, out, error });
    if (command === "configure") return await configure(args, { ...io, out, error });
    if (command === "doctor") return await doctor({ ...io, out, error });
    if (command === "login") return login(out);
    if (command === "add-user") return await addUser(args, { ...io, out, error });
    if (command === "update") return update(out);
    if (command === "uninstall") return await uninstall(args, { ...io, out, error });
    if (command === "migrate") return migrate(args, out);
    throw new Error(`Unknown command: ${command}`);
  } catch (cause) {
    error(redact(cause.message));
    process.exitCode = 1;
  }
}

async function setup(args, io) {
  assertEnvironment();
  const paths = ensureLayout();
  const codexBin = await ensureCodexCli(args, io);
  await ensureCodexAuthentication(codexBin, args, io);
  let sttLanguage = "ru";
  if (!args["skip-local-stt"]) {
    const installStt = localWhisperInstalled(paths) || await confirm(args, io, "Install local faster-whisper speech recognition?", true);
    if (installStt) {
      sttLanguage = await chooseSttLanguage(paths, args, io);
      ensureLocalWhisper(paths, io);
    } else args["skip-local-stt"] = true;
  }
  if (args["migrate-from"]) migrate({ from: args["migrate-from"] }, io.out);
  await configure(args, io);
  if (!args["skip-local-stt"]) configureLocalWhisper(paths, sttLanguage);
  installUnit(paths);
  if (!args["no-start"] && commandExists("systemctl")) {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", SERVICE]);
  }
  io.out(`Setup complete. Data: ${paths.dataRoot}`);
}

async function configure(args, io) {
  const paths = ensureLayout();
  const existing = existsSync(paths.configFile) ? readFileSync(paths.configFile, "utf8") : "";
  const env = parseEnv(existing);
  ensureDefaultProject(env, paths);
  env.CODEX_BIN ||= resolveCommand("codex") || "codex";
  env.CODEX_SANDBOX ||= "danger-full-access";
  env.CODEX_SKIP_GIT_REPO_CHECK ||= "true";
  if (args["token-file"]) {
    const token = readFileSync(path.resolve(args["token-file"]), "utf8").trim();
    await validateTelegramToken(token);
    env.BOT_TOKEN = token;
    env.TELEGRAM_ADAPTER_ENABLED = "true";
  } else if (process.env.BOT_TOKEN && !env.BOT_TOKEN) {
    await validateTelegramToken(process.env.BOT_TOKEN);
    env.BOT_TOKEN = process.env.BOT_TOKEN;
    env.TELEGRAM_ADAPTER_ENABLED = "true";
  }
  if (args["user-id"]) assertTelegramId(args["user-id"]), env.ALLOWED_USER_IDS = addCsv(env.ALLOWED_USER_IDS, args["user-id"]);
  if (existsSync(paths.configFile) && serializeEnv(env) !== existing && !args.yes && !args["token-file"] && !args["user-id"]) {
    io.out("Existing config preserved. Pass explicit options to change it.");
    return;
  }
  safeWriteConfig(paths.configFile, serializeEnv(env));
  io.out(`Configuration ready: ${paths.configFile}`);
}

function ensureDefaultProject(env, paths) {
  const projectName = path.basename(paths.home).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_") || "home";
  const defaultProject = path.join(paths.projectsRoot, projectName);
  env.PROJECT_CREATE_ROOT ||= paths.projectsRoot;
  env.PROJECT_ALLOWLIST ||= defaultProject;
  env.PROJECT_COMMANDS ||= `${projectName}=${defaultProject}`;
  mkdirSync(defaultProject, { recursive: true, mode: 0o700 });
  const agentsPath = path.join(defaultProject, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, defaultProjectAgentsMd(projectName), { mode: 0o600 });
  }
}

function defaultProjectAgentsMd(projectName) {
  return [
    `# AGENTS.md instructions for /${projectName}`,
    "",
    "This project was created by the Codex Telegram Bridge.",
    "",
    "## Notes",
    "",
    "- Keep project-specific instructions here.",
    "- Update this file when project behavior or conventions change.",
    "",
  ].join("\n");
}

async function addUser(args, io) {
  const paths = ensureLayout();
  const env = parseEnv(readRequired(paths.configFile));
  let id = args["user-id"];
  if (!id) {
    if (!env.BOT_TOKEN) throw new Error("Telegram bot is not configured. Run configure first.");
    io.out("Send /start to the bot. Waiting for a Telegram update...");
    const response = await telegram(env.BOT_TOKEN, "getUpdates", { timeout: 30, allowed_updates: ["message"] });
    const message = [...response].reverse().find(item => item.message?.text === "/start")?.message;
    if (!message) throw new Error("No /start message received. Stop any other bot instance and try again.");
    id = String(message.from.id);
    io.out(`Found Telegram user: ${safeUser(message.from)} (${id})`);
    if (!args.yes) throw new Error("Run again with --yes --user-id <id> to confirm this user.");
  }
  assertTelegramId(id);
  env.ALLOWED_USER_IDS = addCsv(env.ALLOWED_USER_IDS, id);
  safeWriteConfig(paths.configFile, serializeEnv(env));
  io.out(`Telegram user ${id} added.`);
}

async function doctor(io) {
  const paths = resolveBridgePaths();
  const env = existsSync(paths.configFile) ? parseEnv(readFileSync(paths.configFile, "utf8")) : {};
  const checks = [];
  checks.push(check("Node.js", Number(process.versions.node.split(".")[0]) >= 22, process.version));
  const codexBin = env.CODEX_BIN || resolveCommand("codex") || "codex";
  const codexInstalled = commandExists(codexBin);
  checks.push(check("Codex CLI", codexInstalled, codexInstalled ? codexBin : `not found: ${codexBin}`));
  const codexAuth = codexInstalled && spawnSync(codexBin, ["login", "status"], { encoding: "utf8" }).status === 0;
  checks.push(check("Codex authentication", codexAuth, codexAuth ? "ready" : "login required"));
  const whisperPython = path.join(paths.dataRoot, ".venv", "bin", "python");
  const whisperInstalled = existsSync(whisperPython) && spawnSync(whisperPython, ["-c", "import faster_whisper"], { stdio: "ignore" }).status === 0;
  const sttConfigured = Boolean(env.STT_COMMAND);
  checks.push(check("Local faster-whisper", whisperInstalled, whisperInstalled ? whisperPython : sttConfigured ? "not installed; rerun setup" : "not configured (optional)", !sttConfigured));
  checks.push(check("ffmpeg", commandExists("ffmpeg"), commandExists("ffmpeg") ? resolveCommand("ffmpeg") : sttConfigured ? "not found" : "not required (optional)", !sttConfigured));
  checks.push(check("Bridge config", existsSync(paths.configFile), existsSync(paths.configFile) ? "found" : "not found"));
  const configMode = existsSync(paths.configFile) ? statSync(paths.configFile).mode & 0o777 : 0;
  checks.push(check("Bridge config permissions", configMode === 0o600, configMode ? configMode.toString(8) : "n/a"));
  checks.push(check("Allowed Telegram users", Boolean(env.ALLOWED_USER_IDS), env.ALLOWED_USER_IDS ? "configured" : "not configured"));
  checks.push(check("Projects root", isWritableDirectory(paths.projectsRoot), paths.projectsRoot));
  checks.push(check("Project configuration", validateProjects(env), validateProjects(env) ? "valid" : "invalid"));
  let telegramOk = false;
  if (env.BOT_TOKEN) try { await validateTelegramToken(env.BOT_TOKEN); telegramOk = true; } catch {}
  checks.push(check("Telegram bot", telegramOk, telegramOk ? "reachable" : env.BOT_TOKEN ? "unreachable or invalid" : "not configured"));
  const active = commandExists("systemctl") && spawnSync("systemctl", ["--user", "is-active", "--quiet", SERVICE]).status === 0;
  checks.push(check("Bridge service", active, active ? "running" : "not running"));
  const googleRoot = path.join(paths.home, ".config", "google-workspace-mcp");
  checks.push(check("Google Workspace MCP", existsSync(googleRoot), existsSync(googleRoot) ? "configured" : "not configured (optional)", true));
  for (const item of checks) io.out(`${item.name}: ${item.ok ? "OK" : item.optional ? "INFO" : "ERROR"} (${item.detail})`);
  if (checks.some(item => !item.ok && !item.optional)) process.exitCode = 1;
}

function migrate(args, out) {
  const source = path.resolve(args.from || args["migrate-from"] || "");
  if (!source || !existsSync(source)) throw new Error("Migration source does not exist.");
  const paths = ensureLayout();
  const oldConfig = path.join(source, ".env");
  if (existsSync(oldConfig) && !existsSync(paths.configFile)) safeWriteConfig(paths.configFile, readFileSync(oldConfig, "utf8"));
  const oldState = path.join(source, "state");
  if (existsSync(oldState)) copyTreeMissing(oldState, paths.stateRoot);
  const env = parseEnv(readRequired(paths.configFile));
  env.PROJECT_CREATE_ROOT = paths.projectsRoot;
  safeWriteConfig(paths.configFile, serializeEnv(env));
  out(`Bridge data migrated to ${paths.dataRoot}. Source was not removed.`);
}

async function uninstall(args, io) {
  const paths = resolveBridgePaths();
  if (commandExists("systemctl")) {
    spawnSync("systemctl", ["--user", "disable", "--now", SERVICE], { stdio: "ignore" });
    if (existsSync(paths.systemdUnit)) rmSync(paths.systemdUnit);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }
  if (args.purge) {
    io.out(`Purge target: ${paths.dataRoot}`);
    if (!args.yes) throw new Error("Purge requires --yes. Codex and Google credentials are never removed.");
    rmSync(paths.dataRoot, { recursive: true, force: true });
  }
  io.out(args.purge ? "Bridge service and data removed." : `Bridge service removed. Data preserved at ${paths.dataRoot}.`);
}

function installUnit(paths) {
  mkdirSync(paths.systemdDir, { recursive: true, mode: 0o700 });
  const executable = path.resolve(process.argv[1]);
  const unit = renderSystemdUnit(paths, process.execPath, executable);
  writeFileSync(paths.systemdUnit, unit, { mode: 0o600 });
}

export function renderSystemdUnit(paths, nodePath, executable) {
  return `[Unit]\nDescription=Codex Telegram Bridge\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironmentFile=${systemdPath(paths.configFile)}\nExecStart=${systemdQuote(nodePath)} ${systemdQuote(executable)} run\nWorkingDirectory=${systemdPath(paths.dataRoot)}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

function serviceCommand(command, out) {
  if (command === "status") return run("systemctl", ["--user", "status", SERVICE, "--no-pager"]);
  run("systemctl", ["--user", command, SERVICE]);
  out(`${SERVICE}: ${command} requested`);
}

function login(out) {
  const paths = resolveBridgePaths();
  const env = existsSync(paths.configFile) ? parseEnv(readFileSync(paths.configFile, "utf8")) : {};
  run(env.CODEX_BIN || resolveCommand("codex") || "codex", ["login"]);
  out("Codex login command completed.");
}
function runBridge() {
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, "src", "bot.js")], { stdio: "inherit", env: process.env });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`Bridge stopped by ${signal}`)) : code === 0 ? resolve() : reject(new Error(`Bridge exited with status ${code}`)));
  });
}
function update(out) { out("Update the package with: npm update -g codex-telegram-bridge\nPersistent data will be preserved."); }
function assertEnvironment() {
  if (process.platform !== "linux") throw new Error("This installer currently supports Linux.");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required.");
}
async function ensureCodexCli(args, io) {
  const existing = resolveCommand("codex");
  if (existing) { io.out(`Codex CLI found: ${existing}`); return existing; }
  const npm = resolveCommand("npm");
  if (!npm) throw new Error("Codex CLI is missing and npm was not found. Install Node.js 22 with npm, then rerun setup.");
  if (!await confirm(args, io, "Codex CLI was not found. Install @openai/codex now?", true)) throw new Error("Codex CLI is required. Installation was declined.");
  io.out("Codex CLI not found. Installing @openai/codex...");
  run(npm, ["install", "-g", "@openai/codex"]);
  const installed = resolveCommand("codex");
  if (!installed) throw new Error("Codex CLI was installed but is not on PATH. Add the npm global bin directory to PATH and rerun setup.");
  io.out(`Codex CLI installed: ${installed}`);
  return installed;
}
async function ensureCodexAuthentication(codexBin, args, io) {
  if (spawnSync(codexBin, ["login", "status"], { stdio: "ignore" }).status === 0) return io.out("Codex authentication: ready");
  if (!await confirm(args, io, "Codex is not authenticated. Start Codex login now?", true)) throw new Error("Codex login is required. Run codex-telegram-bridge login, then rerun setup.");
  if (!process.stdin.isTTY && !io.ask) throw new Error("Codex login requires an interactive terminal. Run codex-telegram-bridge login, then rerun setup.");
  run(codexBin, ["login"]);
  if (spawnSync(codexBin, ["login", "status"], { stdio: "ignore" }).status !== 0) throw new Error("Codex authentication did not complete. Run codex-telegram-bridge login, then rerun setup.");
  io.out("Codex authentication: ready");
}
function localWhisperInstalled(paths) { const python=path.join(paths.dataRoot,".venv","bin","python"); return existsSync(python)&&spawnSync(python,["-c","import faster_whisper"],{stdio:"ignore"}).status===0; }
function ensureLocalWhisper(paths, io) {
  const python3 = resolveCommand("python3");
  if (!python3) throw new Error("Local STT requires Python 3. Install python3 and python3-venv, then rerun setup.");
  if (!resolveCommand("ffmpeg")) throw new Error("Local STT requires ffmpeg. Install ffmpeg with your system package manager, then rerun setup.");
  const venv = path.join(paths.dataRoot, ".venv");
  const python = path.join(venv, "bin", "python");
  if (!existsSync(python)) {
    io.out(`Creating local STT environment: ${venv}`);
    run(python3, ["-m", "venv", venv]);
  }
  if (spawnSync(python, ["-c", "import faster_whisper"], { stdio: "ignore" }).status !== 0) {
    io.out("Installing faster-whisper...");
    run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
    run(python, ["-m", "pip", "install", "faster-whisper"]);
  } else io.out("faster-whisper found in the Bridge environment.");
  io.out("Preparing Systran/faster-whisper-small (CPU int8)...");
  run(python, ["-c", 'from faster_whisper import WhisperModel; WhisperModel("Systran/faster-whisper-small", device="cpu", compute_type="int8"); print("Local Whisper model ready")']);
}
export function configureLocalWhisper(paths, language = "ru") {
  const env = parseEnv(readRequired(paths.configFile));
  const python = path.join(paths.dataRoot, ".venv", "bin", "python");
  env.STT_COMMAND ||= `${python} ${path.join(PACKAGE_ROOT, "scripts", "transcribe-faster-whisper.py")}`;
  env.STT_NORMALIZE_AUDIO ||= "true";
  env.LOCAL_WHISPER_MODEL ||= "Systran/faster-whisper-small";
  env.LOCAL_WHISPER_DEVICE ||= "cpu";
  env.LOCAL_WHISPER_COMPUTE_TYPE ||= "int8";
  env.LOCAL_WHISPER_CPU_THREADS ||= "4";
  env.LOCAL_WHISPER_LANGUAGE ||= language === "auto" ? "" : language;
  env.LOCAL_WHISPER_LOCAL_FILES_ONLY ||= "true";
  env.LOCAL_WHISPER_VAD ||= "true";
  env.LOCAL_WHISPER_BEAM_SIZE ||= "3";
  safeWriteConfig(paths.configFile, serializeEnv(env));
}
async function chooseSttLanguage(paths, args, io) {
  if (args["stt-language"]) return validateSttLanguage(args["stt-language"]);
  if (existsSync(paths.configFile)) { const current=parseEnv(readFileSync(paths.configFile,"utf8")).LOCAL_WHISPER_LANGUAGE; if(current!==undefined) return current||"auto"; }
  if (args.yes) return "ru";
  const choices = ["ru","en","auto","de","es","fr","it","uk","pl","tr"];
  const answer = (await ask(io, "Speech language [1=Russian, 2=English, 3=Auto, 4=German, 5=Spanish, 6=French, 7=Italian, 8=Ukrainian, 9=Polish, 10=Turkish] (default 1): ")).trim();
  if (!answer) return "ru";
  const index = Number(answer);
  return validateSttLanguage(Number.isInteger(index)&&index>=1&&index<=choices.length?choices[index-1]:answer);
}
export function validateSttLanguage(value) { const language=String(value).trim().toLowerCase(); if(language==="auto"||/^[a-z]{2,3}$/.test(language)) return language; throw new Error(`Invalid STT language: ${value}. Use a language code such as ru, en, de, or auto.`); }
async function confirm(args, io, prompt, defaultYes) {
  if (args.yes) return true;
  const answer=(await ask(io, `${prompt} ${defaultYes?"[Y/n]":"[y/N]"} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return ["y","yes"].includes(answer);
}
async function ask(io, prompt) {
  if (io.ask) return String(await io.ask(prompt));
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Interactive input is required: ${prompt.trim()} Rerun with --yes or provide explicit options.`);
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{return await rl.question(prompt);}finally{rl.close();}
}
function ensureLayout() { const p = resolveBridgePaths(); for (const dir of [p.dataRoot,p.projectsRoot,p.stateRoot,p.logsRoot,p.cacheRoot]) mkdirSync(dir,{recursive:true,mode:0o700}); return p; }
function safeWriteConfig(file, data) { mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); if(existsSync(file)){const backup=`${file}.bak`; copyFileSync(file,backup); chmodSync(backup,0o600);} const temp=`${file}.${process.pid}.tmp`; writeFileSync(temp,data,{mode:0o600}); renameSync(temp,file); chmodSync(file,0o600); }
function parseEnv(text) { const result={}; for(const line of text.split(/\r?\n/)){const m=line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) result[m[1]]=m[2].replace(/^["']|["']$/g,"");} return result; }
function serializeEnv(env) { return `${Object.entries(env).map(([k,v])=>`${k}=${String(v).replace(/[\r\n]/g,"")}`).join("\n")}\n`; }
function parseArgs(tokens) { const r={}; for(let i=0;i<tokens.length;i++){const t=tokens[i]; if(!t.startsWith("--")) throw new Error(`Unexpected argument: ${t}`); const k=t.slice(2); if(["yes","no-start","purge","skip-local-stt"].includes(k)) r[k]=true; else {if(tokens[i+1]===undefined) throw new Error(`Missing value for --${k}`); r[k]=tokens[++i];}} return r; }
function run(bin,args){const r=spawnSync(bin,args,{stdio:"inherit"}); if(r.error) throw r.error; if(r.status!==0) throw new Error(`${bin} exited with status ${r.status}`);}
function commandExists(bin){return spawnSync("sh",["-c",`command -v "$1" >/dev/null 2>&1`,"sh",bin]).status===0;}
export function resolveCommand(bin){const r=spawnSync("sh",["-c",`command -v "$1"`,"sh",bin],{encoding:"utf8"}); if(r.status!==0) return ""; const found=r.stdout.trim(); return path.isAbsolute(found)?found:"";}
async function validateTelegramToken(token){if(!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram token has an invalid format."); const me=await telegram(token,"getMe",{}); return me;}
async function telegram(token,method,body){const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); const data=await response.json(); if(!data.ok) throw new Error(`Telegram API error: ${data.description || response.status}`); return data.result;}
function addCsv(value,item){return [...new Set(String(value||"").split(",").filter(Boolean).concat(String(item)))].join(",");}
function assertTelegramId(id){if(!/^\d+$/.test(String(id))) throw new Error("Telegram User ID must be numeric.");}
function validateProjects(env){const projects=String(env.PROJECT_ALLOWLIST||"").split(",").filter(Boolean); if(!projects.length||projects.some(p=>!path.isAbsolute(p)||!existsSync(p))) return false; return String(env.PROJECT_COMMANDS||"").split(",").filter(Boolean).every(x=>{const i=x.indexOf("="); return i>0&&projects.includes(path.resolve(x.slice(i+1)));});}
function isWritableDirectory(dir){try{mkdirSync(dir,{recursive:true,mode:0o700}); return Boolean(statSync(dir).isDirectory()&&(statSync(dir).mode&0o200));}catch{return false;}}
function check(name,ok,detail,optional=false){return{name,ok:Boolean(ok),detail,optional};}
function readRequired(file){if(!existsSync(file)) throw new Error(`Missing configuration: ${file}`); return readFileSync(file,"utf8");}
function copyTreeMissing(source,target){mkdirSync(target,{recursive:true,mode:0o700}); for(const entry of readdirSync(source,{withFileTypes:true})){const from=path.join(source,entry.name); const to=path.join(target,entry.name); if(entry.isDirectory()) copyTreeMissing(from,to); else if(!existsSync(to)){copyFileSync(from,to); chmodSync(to,0o600);}}}
function safeUser(user){return [user.first_name,user.last_name,user.username?`@${user.username}`:""].filter(Boolean).join(" ");}
function systemdQuote(value){return `"${String(value).replace(/([\\"])/g,"\\$1")}"`;}
function systemdPath(value){if(/[\r\n]/.test(value)) throw new Error("Invalid newline in systemd path."); return String(value).replace(/ /g,"\\x20");}
function redact(value){return String(value).replace(/\b\d{6,}:[A-Za-z0-9_-]+\b/g,"[REDACTED]");}
function help(){return `Usage: codex-telegram-bridge <command> [options]\n\nCommands: setup, configure, start, stop, restart, status, doctor, login, add-user, update, uninstall\n\nNon-interactive setup: --token-file <0600-file> --user-id <id> --stt-language <code|auto> --yes\nSkip automatic local speech-to-text: setup --skip-local-stt\nUninstall data too: uninstall --purge --yes`;}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) await main(process.argv.slice(2));
