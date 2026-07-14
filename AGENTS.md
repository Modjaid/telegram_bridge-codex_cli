# Codex Bridge Notes

## What This Is

Node.js bridge for Codex CLI. It reads `.env`, accepts Telegram long-polling updates and optional CollabMD HTTP messages, runs `codex exec --json`, and sends progress/final answers back to the source adapter.

## Key Files

- `src/bot.js` - main process: config, Telegram/CollabMD routing, session state, Codex spawning, media download/STT.
- `src/paths.js` centralizes installed-package and persistent-data paths; `src/cli.js` implements the npm CLI.
- `src/media-index.js` - locked, atomic shared media-cache index helpers.
- `src/media-triggers.js` - discovers and runs project-skill media subscriptions.
- `src/bundled-skills.js` and `bundled-skills/` - versioned skills installed into the service user's Codex home at Bridge startup.
- `scripts/media-event` - CLI for inspecting events and registering persistent project artifacts.
- `.env.example` - supported config knobs.
- `systemd/*.service.example` - service templates.

## Before Editing

1. Check state: `git status --short --branch`.
2. Update from git before changes: `git pull --ff-only` when the worktree is clean. If it is dirty, do not overwrite local changes; inspect first.

## Change Rules

- Use existing no-dependency Node style; package requires Node `>=22`.
- Installed deployments use `~/.codex-telegram-bridge/config.env`; projects, state and logs live under that persistent data root and never under the npm package. `PROJECT_ALLOWLIST` is the comma-separated list of allowed absolute paths, and `PROJECT_COMMANDS` maps slash aliases to paths from that allowlist.
- Install and update this Bridge from `github:Modjaid/telegram_bridge-codex_cli`; the same unscoped package name on the public npm registry belongs to a different project. Keep the package private to prevent accidental registry publication.
- First-time configuration creates a username-named default project under `~/.codex-telegram-bridge/projects`, maps the username slash alias to it, and creates its `AGENTS.md` without replacing existing instructions.
- First-time configuration resolves Codex CLI from the interactive setup environment and persists its absolute path as `CODEX_BIN`; the systemd service must not depend on user-local bin directories being present in the user manager's `PATH`.
- First-time configuration enables `CODEX_SKIP_GIT_REPO_CHECK=true` because the generated default project is not initialized as a Git repository; users may opt back into the repository check after initializing Git.
- First-time configuration sets `CODEX_SANDBOX=danger-full-access` so Bridge sessions work without Bubblewrap and can read the service user's skills; this grants Codex all filesystem access available to that dedicated Linux user and must be documented clearly.
- `setup` reuses or installs Codex CLI, creates a persistent Bridge-owned Python venv, installs local `faster-whisper`, preloads `Systran/faster-whisper-small`, and writes the known-good Russian CPU/int8 STT defaults. Python 3/venv and ffmpeg remain explicit system prerequisites; `--skip-local-stt` opts out.
- Interactive `setup` confirms missing Codex/Whisper installation, verifies Codex authentication and launches `codex login` when needed, then offers common Whisper language hints plus auto-detection. Non-interactive automation uses `--yes` and optional `--stt-language <code|auto>`.
- Telegram project create/attach/delete must go through `scripts/project-manager`; do not hand-edit `.env` for that flow. Created or attached projects must include an `AGENTS.md` file. Deleting a project recursively removes its folder only inside the default `~/.codex-telegram-bridge/projects` directory; attached folders elsewhere are removed from Bridge configuration but preserved on disk.
- The running Telegram adapter refreshes project configuration through `scripts/project-manager list` before project callbacks and slash-command parsing, so projects added or removed externally become available without restarting the Bridge.
- Telegram session key is global (`telegram`), so project switches/reset affect the whole Telegram bridge session.
- All Bridge-generated Telegram messages and controls must be in English. Project-name prompts use Telegram `ForceReply` so replies are tied to the prompt instead of entering the active Codex session.
- Project-switch confirmations list global and project-local skills without duplicates, followed by a non-recursive first-level directory listing capped to fit a Telegram message.
- Telegram media is downloaded once into the shared seven-day XDG cache (`$XDG_CACHE_HOME/codex-telegram-bridge/telegram-media`, or `~/.cache/...`; override with `TELEGRAM_MEDIA_CACHE_ROOT`). Project-specific processing belongs in `.codex/skills/*/telegram-media-trigger.json` plus that skill's scripts; reply resolution must never rerun triggers or STT.
- Register persistent project artifacts with `scripts/media-event complete`; do not hand-edit the shared `.media-index.json`.
- Keep bundled skill `VERSION` files in sync with material skill changes; startup must preserve an installed version newer than the bundle.
- `codex-telegram-bridge` is the single bundled skill for project lifecycle and Telegram media workflows. The installer retires the former split skills only through their last bundled version (`1.1.0`) and preserves newer user-maintained versions.
- Telegram voice prompts reuse the STT progress message as the Codex live progress log to avoid extra `Transcribed` chat messages.
- STT conversion normalizes speech loudness by default (`STT_NORMALIZE_AUDIO=true`) before producing the mono 16 kHz WAV; deployments can disable it without changing the transcriber.
- If behavior, config, project handling, service setup, or media flow changes, update this file in the same change.

## Run/Check

- Syntax check: `npm run check`.
- Start locally: `npm start`.
- Service examples use `.env` and run `src/bot.js` from the repo root.

## Git After Changes

After verified edits, review `git diff`, commit the relevant changes, and push to the remote unless the user explicitly says not to.
