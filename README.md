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

Voice and audio messages can be transcribed and saved into dialog history. The transcript is sent to Codex only when it contains a bridge command, or when Codex is waiting for an explicit answer. Enable local STT in `.env`:

```bash
STT_COMMAND=scripts/transcribe-faster-whisper
LOCAL_WHISPER_MODEL=Systran/faster-whisper-base
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
