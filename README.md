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
   - `WORKSPACE_ALLOWLIST`
   - `WORKSPACE_CREATE_ROOT` if Telegram-created workspaces should use a specific parent directory
   - `WORKSPACE_COMMANDS` if you want slash commands like `/agent` or `/notes`
   - `BRIDGE_COMMANDS`
4. Run:

```bash
npm run check
npm start
```

If your selected workspace is not a Git repository, set `CODEX_SKIP_GIT_REPO_CHECK=true`. Keep it `false` for normal project repositories.

## Commands

- `/start`, `/help` - help
- `/status` - current session status
- `/new` - clear saved Codex thread id for this chat
- `/resume` - resume last known thread
- `/stop` - stop the current Codex process for this chat
- `/cancel` - clear pending answer mode
- `/repo` - choose workdir from `WORKSPACE_ALLOWLIST`
- `/commands` - list workspace commands and show workspace create/delete controls
- `/schedule` - open a schedule-management Codex session for persistent cron tasks
- `/<workspace> [task]` - switch global Telegram workspace mode and start a fresh Codex thread
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

Workspace slash commands are configured with `WORKSPACE_COMMANDS` and must point to paths from `WORKSPACE_ALLOWLIST`:

```bash
WORKSPACE_ALLOWLIST=/home/agent,/home/agent/MyObsidian
WORKSPACE_COMMANDS=agent=/home/agent,notes=/home/agent/MyObsidian
```

Examples:

```text
/notes
/notes update today's note
/agent check bridge status
```

Using any workspace command clears the saved Codex thread, pending answer mode, and bridge history for the global Telegram session, even when the command selects the already active workspace. Follow-up plain text messages continue in the selected workspace until another workspace command is used.

Telegram `/commands` also shows `/delete_<workspace>` under each workspace and an inline `Create new workspace` button. Pressing the button sends a reply-only prompt for the new workspace name and shows the parent directory where the folder will be created. The user must reply to that prompt; a normal message is routed to the current Codex session.

Workspace create/delete operations go through:

```bash
scripts/workspace-manager create --name <workspaceName> --root <parentPath>
scripts/workspace-manager delete --name <workspaceName>
```

Creation updates `.env`, creates the workspace directory under `WORKSPACE_CREATE_ROOT`, adds it to `WORKSPACE_ALLOWLIST` and `WORKSPACE_COMMANDS`, and creates an `AGENTS.md` file in the new workspace. Deletion removes the workspace from bridge configuration but does not remove the folder from disk.

## Scheduled Codex Tasks

Telegram `/schedule` opens a special Codex session in the bridge service workspace, not in a normal project workspace. The session receives schedule-specific instructions and can help create, edit, or delete cron tasks through dialog.

Tasks are stored persistently in:

```text
state/schedule-tasks.json
```

Each task stores an id, name/title, description, cron expression, IANA time zone, linked workspace, saved Codex prompt, status, last run, next run, and run count. The bridge reloads this file after restart and resumes due tasks automatically.

Useful commands:

```text
/schedule
/schedule every day at 9am check new GitHub issues in the current project
/edit_task_<id>
/delete_task_<id>
```

When creating a task, the schedule session uses the currently selected Telegram workspace as the default workspace for that task. If the user switches workspace before creating another task, the new task is bound to the new workspace. On execution, Codex starts in the task's saved workspace.

The schedule session asks for the user's IANA time zone before saving the first task. It also knows the bridge system time zone and calculates the current offset difference. The user time zone is persisted and reused in later `/schedule` sessions.

Codex runs launched by `/schedule` get `scripts/` on `PATH`, so the schedule agent can manage state with:

```bash
schedule-task list --chat-id <id> --json
schedule-task set-timezone --chat-id <id> --timezone Europe/Berlin
schedule-task upsert --chat-id <id> --name daily_issues --title "Daily issues" --description "Check GitHub issues" --cron "0 9 * * *" --timezone Europe/Berlin --workspace /home/agent/project --prompt "Check new GitHub issues and summarize them." --status enabled
schedule-task delete --chat-id <id> --name <task-name-or-id>
```

## CollabMD

You can also connect CollabMD, a convenient tool for working with Markdown files on a VPS.

## Inbox And File Handling

Telegram photo/image, audio/voice, video, animation, video note, and document uploads are saved into `Inbox` under the current Telegram workspace. The bridge creates the folder when it does not exist. Use `MAX_INBOX_FILE_BYTES` to adjust the per-file download limit.

The uploaded file content is stored as a normal file:

```text
<workspace>/Inbox/<telegram-file-name>
```

If a file with the same name already exists, the bridge writes a unique filename instead of overwriting the old file.

Metadata is stored separately from the file content in the media index:

```text
<workspace>/Inbox/.media-index.json
```

The index stores the bridge `mediaId`, Telegram chat/message/file ids, media type, MIME type, local path, size, SHA-256, caption, creation/save dates, and an agent-editable description field. Missing local files are pruned synchronously when the bridge or helper commands update the index.

After saving an upload, the bridge sends the file back to Telegram with inline `Info` and `Delete` controls. That echo message is also linked to the same `mediaId`, so a later Telegram reply to the original upload or to the echo can be resolved back to the local Inbox file.

When a user replies to an Inbox media message with a Codex command, the bridge adds a `Telegram reply media` block to the Codex prompt. That block contains the local path, `mediaId`, index path, file type, MIME type, size, SHA-256, caption, and description status, so Codex can inspect or move the saved file from the workspace.

Telegram `.json` document uploads are also copied into `JSON_UPLOAD_DIR` (`/tmp/codex-telegram-upload` by default). They are sent to Codex only when the caption contains a bridge command, for example:

```text
/codex inspect this snapshot
```

Optional JSON upload settings:

```bash
JSON_UPLOAD_DIR=/tmp/codex-telegram-upload
MAX_JSON_BYTES=10000000
```

Codex runs launched by the bridge get `scripts/` prepended to `PATH`, so agents can use the media helper from any workspace:

```bash
media-index list --workspace .
media-index pending --workspace .
media-index show <mediaId> --workspace . --json
media-index find-telegram --chat-id <id> --message-id <id> --workspace . --json
printf '%s\n' 'description text' | media-index describe <mediaId> --workspace . --stdin
media-index move <mediaId> --workspace . --to Archive/2026/file.jpg
media-index delete <mediaId> --workspace .
media-index send <mediaId|path> --workspace .
media-index sync --workspace .
media-index validate --workspace .
```

Use `media-index describe` instead of editing `.media-index.json` by hand. The helper takes the same lock as the bridge, verifies that referenced files still exist, preserves existing descriptions during bridge upserts, and writes the index atomically.

Use `media-index send` when Codex finds a relevant local file and should forward it back to the Telegram user. The argument can be an indexed `mediaId` or a file path inside the workspace. A path is first added to the media index as a local media item, then sent with the same inline `Info` and `Delete` controls as Inbox uploads. By default the destination is the media item's Telegram chat when present, otherwise the first `ALLOWED_USER_IDS` entry; pass `--chat-id <id>` to override it.

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
- `codex exec` is non-interactive, so this bridge controls safety with explicit `--sandbox` and workspace allowlists.
- Set `CODEX_APPROVAL_POLICY=on-request` or use `/approval on-request` if you want Codex to ask before operations it decides need confirmation.
- Host permissions still come from the Linux user running this bridge. For example, Docker tasks require that user to be in the `docker` group or otherwise have permission to access `/var/run/docker.sock`.
- Keep `.env` mode `0600`.
- Prefer a dedicated Linux user and narrow `WORKSPACE_ALLOWLIST`.

## Systemd

Copy `systemd/codex-telegram-bridge.service.example` to a real user service and update paths.

For the `summer` user layout, use `systemd/codex-bridge.summer.service.example` as the starting point.
