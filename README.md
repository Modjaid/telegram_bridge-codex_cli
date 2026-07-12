# Codex Bridge

Minimal multi-adapter bridge for Codex CLI.

It runs `codex exec --json`, parses JSONL events, and mirrors progress, tool activity, and final responses back to the originating adapter. It uses no npm dependencies.

Adapters:

- Telegram long polling
- CollabMD-compatible HTTP adapter

The bridge listens to every adapter message and stores per-session dialog history, but it starts Codex only when a message matches a configured bridge command.

For CollabMD-only mode, set `TELEGRAM_ADAPTER_ENABLED=false` and `COLLABMD_ADAPTER_ENABLED=true`. In that mode `BOT_TOKEN` and `ALLOWED_USER_IDS` are not required.

## Setup

1. Create a bot with `@BotFather`.
2. Copy `.env.example` to `.env`.
3. Set:
   - `TELEGRAM_ADAPTER_ENABLED`
   - `BOT_TOKEN` and `ALLOWED_USER_IDS` when Telegram is enabled
   - `PROJECT_ALLOWLIST`
   - `PROJECT_CREATE_ROOT` if Telegram-created projects should use a specific parent directory
   - `PROJECT_COMMANDS` if you want slash commands like `/agent` or `/notes`
   - `BRIDGE_COMMANDS`
4. Run:

```bash
npm run check
npm start
```

If your selected project is not a Git repository, set `CODEX_SKIP_GIT_REPO_CHECK=true`. Keep it `false` for normal project repositories.

## Commands

- `/start`, `/help` - help
- `/status` - current session status
- `/new` - clear saved Codex thread id for this chat
- `/resume` - resume last known thread
- `/stop` - stop the current Codex process for this chat
- `/cancel` - clear pending answer mode
- `/projects` - list, switch, create, and delete projects from `PROJECT_ALLOWLIST`
- `/schedule` - open a schedule-management Codex session for persistent cron tasks
- `/<project> [task]` - switch global Telegram project mode and start a fresh Codex thread
- `/model [model]` - show or set model override
- `/sandbox [read-only|workspace-write|danger-full-access]` - show or set sandbox
- `/approval [untrusted|on-request|on-failure|never]` - show or set Codex approval policy
- `/diff` - ask Codex to summarize current git diff

Plain text messages are saved into the adapter session history. They are not sent to Codex unless they start with one of `BRIDGE_COMMANDS`:

```text
/codex summarize the current repository
/codex --history use the recent dialog and create an implementation plan
@codex check the deployment files
codex: inspect the vault structure
```

Use `--history`, `--with-history`, or `-H` to include recent dialog messages in the Codex prompt. By default, Codex receives only the command task, so normal chat noise does not force the agent to re-read and re-reason over the whole conversation.

Telegram messages starting with other `/` commands are handled by the bridge, not blindly forwarded to shell.

Project slash commands are configured with `PROJECT_COMMANDS` and must point to paths from `PROJECT_ALLOWLIST`:

```bash
PROJECT_ALLOWLIST=/home/agent,/home/agent/MyObsidian
PROJECT_COMMANDS=agent=/home/agent,notes=/home/agent/MyObsidian
```

Examples:

```text
/notes
/notes update today's note
/agent check bridge status
```

Using any project command clears the saved Codex thread, pending answer mode, and bridge history for the global Telegram session, even when the command selects the already active project. Follow-up plain text messages continue in the selected project until another project command is used.

Telegram `/projects` also shows `/delete_<project>` under each project and an inline `Create new project` button. Pressing the button sends a reply-only prompt for the new project name and shows the parent directory where the folder will be created. The user must reply to that prompt; a normal message is routed to the current Codex session.

Project create/delete operations go through:

```bash
scripts/project-manager create --name <projectName> --root <parentPath>
scripts/project-manager delete --name <projectName>
```

Creation updates `.env`, creates the project directory under `PROJECT_CREATE_ROOT`, adds it to `PROJECT_ALLOWLIST` and `PROJECT_COMMANDS`, and creates an `AGENTS.md` file in the new project. Deletion recursively removes the project folder under `PROJECT_CREATE_ROOT`, then removes it from the bridge configuration.

## Scheduled Codex Tasks

Telegram `/schedule` opens a special Codex session in the bridge's own service directory, not in a user project. The session receives schedule-specific instructions and can help create, edit, or delete cron tasks through dialog.

Tasks are stored persistently in:

```text
state/schedule-tasks.json
```

Each task stores an id, name/title, description, cron expression, IANA time zone, linked project, saved Codex prompt, status, last run, next run, and run count. The bridge reloads this file after restart and resumes due tasks automatically.

Useful commands:

```text
/schedule
/schedule every day at 9am check new GitHub issues in the current project
/edit_task_<id>
/delete_task_<id>
```

When creating a task, the schedule session uses the currently selected Telegram project as the default project for that task. If the user switches project before creating another task, the new task is bound to the new project. On execution, Codex starts in the task's saved project.

The schedule session asks for the user's IANA time zone before saving the first task. It also knows the bridge system time zone and calculates the current offset difference. The user time zone is persisted and reused in later `/schedule` sessions.

Codex runs launched by `/schedule` get `scripts/` on `PATH`, so the schedule agent can manage state with:

```bash
schedule-task list --chat-id <id> --json
schedule-task set-timezone --chat-id <id> --timezone Europe/Berlin
schedule-task upsert --chat-id <id> --name daily_issues --title "Daily issues" --description "Check GitHub issues" --cron "0 9 * * *" --timezone Europe/Berlin --project /home/agent/project --prompt "Check new GitHub issues and summarize them." --status enabled
schedule-task delete --chat-id <id> --name <task-name-or-id>
```

## CollabMD

You can also connect CollabMD, a convenient tool for working with Markdown files on a VPS.

## Inbox And File Handling

Telegram photo/image, audio/voice, video, animation, video note, and document uploads are saved into `Inbox` under the current Telegram project. The bridge creates the folder when it does not exist. Use `MAX_INBOX_FILE_BYTES` to adjust the per-file download limit.

The uploaded file content is stored as a normal file:

```text
<project>/Inbox/<telegram-file-name>
```

If a file with the same name already exists, the bridge writes a unique filename instead of overwriting the old file.

Metadata is stored separately from the file content in the media index:

```text
<project>/Inbox/.media-index.json
```

The index stores the bridge `mediaId`, Telegram chat/message/file ids, media type, MIME type, local path, size, SHA-256, caption, creation/save dates, and an agent-editable description field. Missing local files are pruned synchronously when the bridge or helper commands update the index.

After saving an upload, the bridge sends the file back to Telegram with inline `Info` and `Delete` controls. That echo message is also linked to the same `mediaId`, so a later Telegram reply to the original upload or to the echo can be resolved back to the local Inbox file.

When a user replies to an Inbox media message with a Codex command, the bridge adds a `Telegram reply media` block to the Codex prompt. That block contains the local path, `mediaId`, index path, file type, MIME type, size, SHA-256, caption, and description status, so Codex can inspect or move the saved file from the project.

Telegram `.json` document uploads are also copied into `JSON_UPLOAD_DIR` (`/tmp/codex-telegram-upload` by default). They are sent to Codex only when the caption contains a bridge command, for example:

```text
/codex inspect this snapshot
```

Optional JSON upload settings:

```bash
JSON_UPLOAD_DIR=/tmp/codex-telegram-upload
MAX_JSON_BYTES=10000000
```

Codex runs launched by the bridge get `scripts/` prepended to `PATH`, so agents can use the media helper from any project:

```bash
media-index list --project .
media-index pending --project .
media-index show <mediaId> --project . --json
media-index find-telegram --chat-id <id> --message-id <id> --project . --json
printf '%s\n' 'description text' | media-index describe <mediaId> --project . --stdin
media-index move <mediaId> --project . --to Archive/2026/file.jpg
media-index delete <mediaId> --project .
media-index send <mediaId|path> --project .
media-index sync --project .
media-index validate --project .
```

Use `media-index describe` instead of editing `.media-index.json` by hand. The helper takes the same lock as the bridge, verifies that referenced files still exist, preserves existing descriptions during bridge upserts, and writes the index atomically.

Use `media-index send` when Codex finds a relevant local file and should forward it back to the Telegram user. The argument can be an indexed `mediaId` or a file path inside the project. A path is first added to the media index as a local media item, then sent with the same inline `Info` and `Delete` controls as Inbox uploads. By default the destination is the media item's Telegram chat when present, otherwise the first `ALLOWED_USER_IDS` entry; pass `--chat-id <id>` to override it.

Voice and audio messages can be transcribed and saved into dialog history. Telegram voice messages recorded directly in chat are treated as user prompts: the bridge transcribes them, sends the transcript to Codex, and keeps the transcript in the same live progress message. Uploaded audio files are saved as media and only sent to Codex when the transcript contains a bridge command, or when Codex is waiting for an explicit answer. Enable local STT in `.env`:

```bash
STT_COMMAND=scripts/transcribe-faster-whisper
LOCAL_WHISPER_MODEL=Systran/faster-whisper-small
LOCAL_WHISPER_LANGUAGE=ru
```

The bridge downloads Telegram `voice`, `audio`, and audio `document` messages, converts them to mono 16 kHz WAV with `ffmpeg`, runs `STT_COMMAND <wav-path>`, and routes the transcript through the same command parser as text messages. `STT_COMMAND` can point to any script or binary that prints transcript text to stdout.

Optional STT settings:

```bash
STT_TIMEOUT_MS=120000
MAX_AUDIO_BYTES=20000000
LOCAL_WHISPER_DEVICE=cpu
LOCAL_WHISPER_COMPUTE_TYPE=int8
LOCAL_WHISPER_CPU_THREADS=4
LOCAL_WHISPER_LOCAL_FILES_ONLY=true
LOCAL_WHISPER_VAD=true
LOCAL_WHISPER_BEAM_SIZE=5
```

An OpenAI-compatible fallback script is also available at `scripts/transcribe-openai.js`, but the default setup is local `faster-whisper`.

## Security Notes

- Only users in `ALLOWED_USER_IDS` are accepted.
- No `/exec` or arbitrary shell command endpoint exists.
- `codex exec` is non-interactive, so this bridge controls safety with explicit `--sandbox` and project allowlists.
- Set `CODEX_APPROVAL_POLICY=on-request` or use `/approval on-request` if you want Codex to ask before operations it decides need confirmation.
- Host permissions still come from the Linux user running this bridge. For example, Docker tasks require that user to be in the `docker` group or otherwise have permission to access `/var/run/docker.sock`.
- Keep `.env` mode `0600`.
- Prefer a dedicated Linux user and narrow `PROJECT_ALLOWLIST`.

## Systemd

Copy `systemd/codex-telegram-bridge.service.example` to a real user service and update paths.

For the `summer` user layout, use `systemd/codex-bridge.summer.service.example` as the starting point.
