# Codex Bridge Notes

## What This Is

Node.js bridge for Codex CLI. It reads `.env`, accepts Telegram long-polling updates and optional CollabMD HTTP messages, runs `codex exec --json`, and sends progress/final answers back to the source adapter.

## Key Files

- `src/bot.js` - main process: config, Telegram/CollabMD routing, session state, Codex spawning, media download/STT.
- `src/media-index.js` - locked, atomic `Inbox/.media-index.json` helpers.
- `scripts/media-index` - CLI for listing/describing/moving/deleting/sending indexed media.
- `.env.example` - supported config knobs.
- `systemd/*.service.example` - service templates.

## Before Editing

1. Check state: `git status --short --branch`.
2. Update from git before changes: `git pull --ff-only` when the worktree is clean. If it is dirty, do not overwrite local changes; inspect first.

## Change Rules

- Use existing no-dependency Node style; package requires Node `>=22`.
- Projects are configured only in `.env`: `PROJECT_ALLOWLIST` is the comma-separated list of allowed absolute paths, and `PROJECT_COMMANDS` maps slash aliases to paths from that allowlist.
- Telegram project create/delete must go through `scripts/project-manager`; do not hand-edit `.env` for that flow. Created projects must include an `AGENTS.md` file. Deleting a project recursively removes its folder and is restricted to paths inside `PROJECT_CREATE_ROOT`.
- Telegram session key is global (`telegram`), so project switches/reset affect the whole Telegram bridge session.
- Uploaded media goes under `<project>/Inbox`; update media metadata via `scripts/media-index`, not by hand-editing `.media-index.json`.
- Telegram voice prompts reuse the STT progress message as the Codex live progress log to avoid extra `Transcribed` chat messages.
- If behavior, config, project handling, service setup, or media flow changes, update this file in the same change.

## Run/Check

- Syntax check: `npm run check`.
- Start locally: `npm start`.
- Service examples use `.env` and run `src/bot.js` from the repo root.

## Git After Changes

After verified edits, review `git diff`, commit the relevant changes, and push to the remote unless the user explicitly says not to.
