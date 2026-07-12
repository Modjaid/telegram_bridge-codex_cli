# Codex Bridge Notes

## What This Is

Node.js bridge for Codex CLI. It reads `.env`, accepts Telegram long-polling updates and optional CollabMD HTTP messages, runs `codex exec --json`, and sends progress/final answers back to the source adapter.

## Key Files

- `src/bot.js` - main process: config, Telegram/CollabMD routing, session state, Codex spawning, media download/STT.
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
- Projects are configured only in `.env`: `PROJECT_ALLOWLIST` is the comma-separated list of allowed absolute paths, and `PROJECT_COMMANDS` maps slash aliases to paths from that allowlist.
- Telegram project create/attach/delete must go through `scripts/project-manager`; do not hand-edit `.env` for that flow. Created or attached projects must include an `AGENTS.md` file. Deleting a project recursively removes its folder and is restricted to paths inside `PROJECT_CREATE_ROOT`.
- Telegram session key is global (`telegram`), so project switches/reset affect the whole Telegram bridge session.
- Project-switch confirmation messages list the selected project's local skills from `.codex/skills/*/SKILL.md`.
- Telegram media is downloaded once into the shared seven-day XDG cache (`$XDG_CACHE_HOME/codex-telegram-bridge/telegram-media`, or `~/.cache/...`; override with `TELEGRAM_MEDIA_CACHE_ROOT`). Project-specific processing belongs in `.codex/skills/*/telegram-media-trigger.json` plus that skill's scripts; reply resolution must never rerun triggers or STT.
- Register persistent project artifacts with `scripts/media-event complete`; do not hand-edit the shared `.media-index.json`.
- Keep bundled skill `VERSION` files in sync with material skill changes; startup must preserve an installed version newer than the bundle.
- Telegram voice prompts reuse the STT progress message as the Codex live progress log to avoid extra `Transcribed` chat messages.
- If behavior, config, project handling, service setup, or media flow changes, update this file in the same change.

## Run/Check

- Syntax check: `npm run check`.
- Start locally: `npm start`.
- Service examples use `.env` and run `src/bot.js` from the repo root.

## Git After Changes

After verified edits, review `git diff`, commit the relevant changes, and push to the remote unless the user explicitly says not to.
