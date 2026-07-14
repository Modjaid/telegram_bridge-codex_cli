# Codex Telegram Bridge

Run Codex CLI from Telegram, switch between projects with one command, continue old sessions by replying to their messages, process uploaded files with project-specific handlers, and keep scheduled tasks running on a Linux server.

The Bridge runs `codex exec --json`, turns Codex JSONL events into readable progress updates, and returns tool activity and final answers to the originating chat. It has no runtime npm dependencies.

## What it gives you

- **Simple setup:** install one package and run `codex-telegram-bridge setup`.
- **Conversational project customization:** create, attach, configure, and remove Bridge projects through ordinary dialog with Codex. The bundled `codex-telegram-bridge` skill encapsulates project registration, slash commands, `AGENTS.md`, and Bridge-specific mechanics so users do not have to manage the integration by hand.
- **Telegram sessions:** start a fresh thread with `/new` or return to an older project session by replying to one of its messages.
- **Fast project switching:** `/notes`, `/work`, or another project command changes the active workspace immediately.
- **Parallel work:** start work in another project while Codex is still running in the first one.
- **Visible skills:** when a project opens, Bridge lists the global and project-local skills available to Codex.
- **Voice messages:** local `faster-whisper` transcription works without sending audio to an external transcription API.
- **Media workflows:** uploads are cached once and can trigger handlers owned by one or more projects.
- **Persistent schedules:** `/schedule` creates Codex tasks that survive Bridge restarts.
- **Optional CollabMD adapter:** use the same Bridge with a CollabMD-compatible HTTP client.

## Quick start

### Requirements

- Linux
- Node.js 22+
- npm
- A Telegram bot token from `@BotFather`
- Python 3 with venv support and `ffmpeg` when local speech-to-text is enabled

Install directly from this GitHub repository:

```bash
npm install -g github:Modjaid/telegram_bridge-codex_cli#v0.1.5
codex-telegram-bridge setup
codex-telegram-bridge doctor
```

Interactive `setup`:

1. Reuses an installed Codex CLI or offers to install `@openai/codex`.
2. Checks Codex authentication and opens the normal login flow when needed.
3. Configures the Telegram token and allowed user.
4. Creates the default Bridge project and its slash command.
5. Installs and prepares local `faster-whisper`, unless you opt out.
6. Creates and starts the systemd user service.

For unattended setup, keep the bot token in a mode-`0600` file instead of passing it on the command line:

```bash
codex-telegram-bridge setup \
  --token-file /secure/path/bot-token \
  --user-id 123456789 \
  --stt-language ru \
  --yes
```

Skip local speech recognition when it is not needed:

```bash
codex-telegram-bridge setup --skip-local-stt
```

## Everyday Telegram workflow

### Commands

| Command | Purpose |
| --- | --- |
| `/start`, `/help` | Show help |
| `/status` | Show the active session, project, model, sandbox, and thread |
| `/new` | Clear the saved Codex thread for the active project session |
| `/resume` | Show the thread that will be resumed |
| `/stop` | Stop the current Codex run |
| `/cancel` | Leave pending-answer mode |
| `/projects` | List, create, switch, detach, or delete projects |
| `/<project> [task]` | Activate a project and optionally start a task |
| `/schedule` | Create and manage persistent scheduled tasks |
| `/model [model]` | Show or set a model override |
| `/sandbox [mode]` | Show or set `read-only`, `workspace-write`, or `danger-full-access` |
| `/approval [policy]` | Show or set `untrusted`, `on-request`, `on-failure`, or `never` |
| `/diff` | Ask Codex to summarize the current Git diff |

### Start Codex deliberately

Bridge records normal dialog history but starts Codex only for configured Bridge commands:

```text
/codex summarize the current repository
/codex --history use the recent dialog and create a plan
@codex check the deployment files
codex: inspect the vault structure
```

Use `--history`, `--with-history`, or `-H` when Codex needs recent chat messages. Without that flag, the task is sent without ordinary chat noise.

### Create and return to sessions

- Send `/new` to make the next task start a fresh Codex thread.
- Every project has its own Telegram session context.
- Reply to a Bridge message from an older session to route the next message back to that session.
- A project command starts a fresh thread for that project and makes it the active destination for subsequent plain-text messages.

### Work in several projects

Project aliases are ordinary Telegram slash commands:

```text
/notes update today's note
/backend inspect the failing test
/flight compare the itinerary options
```

Switching projects does not require waiting for a run in another project to finish. Bridge prevents conflicting runs inside the same project while allowing different projects to run concurrently.

When a project session starts, Bridge reports its directory and lists available global and project-local skills, followed by a short first-level directory listing.

## Project management

On first setup, Bridge creates:

```text
~/.codex-telegram-bridge/projects/<linux-user>/
```

It also creates `AGENTS.md` and a matching command such as `/agent` or `/ksu`.

The `/projects` screen lists registered projects and provides a **Create new project** button. Project changes made by the manager are picked up before the next slash command, so adding a project does not require a Bridge restart.

Use the manager for every project lifecycle operation:

```bash
scripts/project-manager list
scripts/project-manager create --name <project-name>
scripts/project-manager add --name <alias> --path <existing-folder>
scripts/project-manager repoint --name <alias> --path <existing-folder>
scripts/project-manager detach --name <alias>
scripts/project-manager delete --name <alias>
```

The manager keeps these settings consistent:

```bash
PROJECT_CREATE_ROOT=/home/user/.codex-telegram-bridge/projects
PROJECT_ALLOWLIST=/absolute/project/one,/absolute/project/two
PROJECT_COMMANDS=one=/absolute/project/one,two=/absolute/project/two
```

Names are normalized to lowercase Telegram aliases; spaces and dashes become underscores. A created or attached project always has an `AGENTS.md`.

Removal has two distinct meanings:

- `detach` removes the command and Bridge registration while preserving the folder.
- `delete` removes the registration and recursively deletes the folder only when it is inside the Bridge-managed projects root. Attached folders elsewhere are preserved.

Never hand-edit project registration when `project-manager` can perform the operation safely.

## Bundled Codex skill

Bridge installs one global skill at startup:

```text
~/.codex/skills/codex-telegram-bridge/
```

The skill teaches Codex how to:

- distinguish creating a new project from attaching an existing folder;
- derive and register a valid slash alias;
- create and update project `AGENTS.md` instructions;
- ask whether removal means detaching the command or deleting the whole managed folder;
- explain Telegram media storage and retention;
- create and validate project-local media handlers.

The bundled skill is versioned and upgrades atomically. During migration, bundled versions up to `1.1.0` of the former `configure-telegram-media` and `manage-telegram-projects` skills are retired. Newer user-maintained versions are preserved.

## Voice messages and local STT

The recommended Russian configuration uses `faster-whisper` with `Systran/faster-whisper-small` on CPU in `int8` mode:

```bash
STT_COMMAND=scripts/transcribe-faster-whisper
LOCAL_WHISPER_MODEL=Systran/faster-whisper-small
LOCAL_WHISPER_DEVICE=cpu
LOCAL_WHISPER_COMPUTE_TYPE=int8
LOCAL_WHISPER_LANGUAGE=ru
LOCAL_WHISPER_VAD=true
LOCAL_WHISPER_BEAM_SIZE=3
STT_NORMALIZE_AUDIO=true
```

This baseline was voice-tested successfully with:

> Шла Саша по шоссе и сосала сушку.

Before changing the model, beam size, VAD, or normalization, compare recognition against the same recording and retain the new setting only when it materially improves the result.

Bridge downloads Telegram voice, audio, and audio-document messages, converts them to mono 16 kHz WAV with `ffmpeg`, then runs `STT_COMMAND <wav-path>`. The command may be any executable that writes transcript text to stdout.

Additional settings:

```bash
STT_TIMEOUT_MS=120000
MAX_AUDIO_BYTES=20000000
LOCAL_WHISPER_CPU_THREADS=4
LOCAL_WHISPER_LOCAL_FILES_ONLY=true
```

`STT_NORMALIZE_AUDIO=true` applies EBU R128 loudness normalization to improve quiet recordings while limiting peaks. The multilingual model can use a language hint such as `ru`, `en`, `de`, `uk`, or automatic detection.

An OpenAI-compatible alternative is available at `scripts/transcribe-openai.js`, but local `faster-whisper` is the default setup path.

## Media cache and project triggers

Every Telegram photo, image, voice message, audio file, video, animation, video note, or document is downloaded once into a shared cache:

```text
$XDG_CACHE_HOME/codex-telegram-bridge/telegram-media/
├── .media-index.json
└── files/<cache-entry-id>/<telegram-file-name>
```

When `XDG_CACHE_HOME` is unset, the root defaults to:

```text
~/.cache/codex-telegram-bridge/telegram-media
```

Configuration:

```bash
TELEGRAM_MEDIA_CACHE_ROOT=
TELEGRAM_MEDIA_CACHE_TTL_DAYS=7
TELEGRAM_MEDIA_TRIGGER_TIMEOUT_MS=120000
MAX_INBOX_FILE_BYTES=50000000
```

Cached originals expire after seven days by default. Cleanup runs at startup and daily.

### Project-local handlers

Projects subscribe to uploads through local Codex skills:

```text
<project>/.codex/skills/<handler>/
├── SKILL.md
├── telegram-media-trigger.json
└── scripts/handle-media.js
```

One handler can subscribe to one project, several projects, or all projects:

```json
{
  "version": 1,
  "subscriptions": [{
    "id": "documents",
    "projects": ["agent", "memomaker"],
    "match": {
      "extensions": [".pdf", ".apk"]
    },
    "run": "scripts/handle-media.js"
  }, {
    "id": "fallback",
    "projects": ["*"],
    "match": { "all": true },
    "fallback": true,
    "run": "scripts/handle-media.js"
  }]
}
```

The handler reads one JSON payload from stdin and returns one JSON object on stdout. Persistent `artifacts` must already exist inside the source project.

Caption text remains associated with the upload as the user prompt. Voice and audio follow both paths: the original file runs matching triggers while STT supplies the transcript. Replying to a media message performs lookup only; it reuses a registered artifact first and the cached original second without rerunning triggers or transcription.

Bridge-launched Codex processes receive Bridge scripts on `PATH`:

```bash
media-event list
media-event show --media-id <mediaId>
media-event complete --media-id <mediaId> --project <alias> --path <project-relative-path>
media-event validate
```

## Scheduled Codex tasks

`/schedule` opens a dedicated schedule-management session. Tasks are stored persistently in:

```text
~/.codex-telegram-bridge/state/schedule-tasks.json
```

Example requests and commands:

```text
/schedule
/schedule every day at 9am check new GitHub issues in the current project
/edit_task_<id>
/delete_task_<id>
```

Each task stores its name, description, cron expression, IANA time zone, linked project, Codex prompt, status, last run, next run, and run count. The active Telegram project becomes the default project for a newly created task.

The first schedule asks for the user's IANA time zone, persists it, and calculates the difference from the server time zone. Bridge reloads tasks after restart and resumes due work automatically.

Agents can manage schedules with:

```bash
schedule-task list --chat-id <id> --json
schedule-task set-timezone --chat-id <id> --timezone Europe/Berlin
schedule-task upsert --chat-id <id> --name daily_issues --title "Daily issues" --description "Check GitHub issues" --cron "0 9 * * *" --timezone Europe/Berlin --project /home/user/project --prompt "Check new issues and summarize them." --status enabled
schedule-task delete --chat-id <id> --name <task-name-or-id>
```

## Configuration and data

Installed code is managed by npm. Persistent data is separate:

```text
~/.codex-telegram-bridge/
├── config.env
├── projects/
├── state/
├── logs/
└── .venv/
```

Codex credentials remain in `~/.codex/`. Bridge does not copy or remove Codex or Google Workspace credentials.

Fresh configurations set:

- `CODEX_SKIP_GIT_REPO_CHECK=true`, because the generated default project is not initially a Git repository.
- `CODEX_SANDBOX=danger-full-access`, so Codex can use global skills and operate on systems without Bubblewrap.

`danger-full-access` gives Codex the same filesystem access as the Linux user running Bridge. Use a dedicated Linux user and switch to `workspace-write` when suitable host sandboxing is available.

Useful service commands:

```bash
codex-telegram-bridge start
codex-telegram-bridge stop
codex-telegram-bridge restart
codex-telegram-bridge status
codex-telegram-bridge doctor
codex-telegram-bridge login
codex-telegram-bridge add-user --user-id <telegram-id>
```

Ordinary uninstall disables the service but preserves data. Purge removes Bridge data but never Codex or Google credentials:

```bash
codex-telegram-bridge uninstall
codex-telegram-bridge uninstall --purge --yes
```

## Updating

Install the newest commit from `main`:

```bash
npm install -g github:Modjaid/telegram_bridge-codex_cli
codex-telegram-bridge restart
codex-telegram-bridge doctor
```

Or pin a release tag:

```bash
npm install -g github:Modjaid/telegram_bridge-codex_cli#v0.1.5
```

The unscoped package name `codex-telegram-bridge` on the public npm registry belongs to another project. Do not use `npm update -g codex-telegram-bridge` for this Bridge.

To migrate an old checkout without deleting it:

```bash
codex-telegram-bridge migrate --from /path/to/old/codex-telegram-bridge
codex-telegram-bridge doctor
```

Keep the old checkout until the service, Telegram commands, projects, schedules, Codex authorization, and optional external integrations are verified and backed up.

## Optional CollabMD adapter

Bridge can accept CollabMD-compatible HTTP messages in addition to Telegram long polling.

For CollabMD-only operation:

```bash
TELEGRAM_ADAPTER_ENABLED=false
COLLABMD_ADAPTER_ENABLED=true
```

In that mode, `BOT_TOKEN` and `ALLOWED_USER_IDS` are not required.

## Security

- Only Telegram users in `ALLOWED_USER_IDS` are accepted.
- There is no `/exec` endpoint and no direct arbitrary-shell Telegram command.
- Codex runs non-interactively with an explicit sandbox, approval policy, and project allowlist.
- Host permissions come from the Linux service user; use a dedicated account with minimal privileges.
- Keep `config.env` and token files at mode `0600`.
- Keep `PROJECT_ALLOWLIST` narrow.
- Treat uploaded names, MIME types, captions, binaries, APKs, and archives as untrusted.
- Do not expose the Bridge or management interfaces publicly without an authenticated proxy and a clear threat model.

## Development

Clone the repository, configure a development environment, and run the checks:

```bash
git clone https://github.com/Modjaid/telegram_bridge-codex_cli.git
cd telegram_bridge-codex_cli
cp .env.example .env
npm run check
npm start
```

Important development settings:

```bash
TELEGRAM_ADAPTER_ENABLED=true
BOT_TOKEN=<telegram-bot-token>
ALLOWED_USER_IDS=<telegram-user-id>
PROJECT_ALLOWLIST=/absolute/project/path
PROJECT_CREATE_ROOT=/absolute/projects/root
PROJECT_COMMANDS=project=/absolute/project/path
BRIDGE_COMMANDS=/codex,@codex,codex:
```

If the selected project is not a Git repository, set `CODEX_SKIP_GIT_REPO_CHECK=true`.

Systemd examples are provided in:

```text
systemd/codex-telegram-bridge.service.example
systemd/codex-bridge.summer.service.example
```

## License

MIT
