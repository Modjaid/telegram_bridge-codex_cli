---
name: manage-telegram-projects
description: Create or connect Codex Telegram Bridge projects for the correct Linux user, derive a valid project slash command, register it with the running Bridge, and create or update project AGENTS.md instructions. Use when a user asks to create, add, attach, register, activate, or choose a folder for a Telegram bot project, workspace, or working directory.
---

# Manage Telegram Projects

Create or connect a project through the Bridge's project manager so its folder and `/projects` entry stay consistent.

## Start with the user's intent

Before changing files, identify the Linux user whose Bridge should own the project. Prefer the user running the relevant Bridge service; do not assume that the current shell user owns every Bridge on the machine.

Ask the user to choose one of these paths only when their intent is ambiguous:

- create a new project;
- connect an existing folder to the Telegram bot.

For a new project, use the name already supplied by the user. Ask for a name only when none was supplied. Do not delay creation to ask about instructions: ensure `AGENTS.md` exists, then offer to add project-specific instructions after creation. For an existing project, inspect its current `AGENTS.md` and never replace existing instructions without explicit approval.

## Locate the correct Bridge and project root

1. Locate the target user's Bridge, normally `~/codex-telegram-bridge` for that Linux user.
2. Read the Bridge's `AGENTS.md` and `.env` without exposing secrets.
3. Run `<bridge>/scripts/project-manager list` to obtain `createRoot`, allowed projects, and command aliases.
4. Recommend creating new folders directly inside `createRoot`. If it is unset, the manager infers it from the configured projects, commonly the Bridge owner's home directory.
5. Do not create projects inside the Bridge source directory unless `createRoot` explicitly points there or the user deliberately chooses it.

Explain the resolved absolute project path before making a new folder when there is meaningful ambiguity.

## Create a new project

Use only the manager:

```bash
<bridge>/scripts/project-manager create --name <project_name>
```

Derive the command alias from the project name. Prefer the closest readable lowercase Latin alias; replace spaces and dashes with `_`, and allow only `a-z`, `0-9`, and `_`. If the user's name cannot be converted safely, propose a short Latin transliteration and confirm it before creating the project.

The manager normalizes a valid name, creates the folder below `PROJECT_CREATE_ROOT`, registers it in `PROJECT_ALLOWLIST` and `PROJECT_COMMANDS`, and ensures `AGENTS.md` exists. Never create the folder with `mkdir` before invoking the manager.

If the user already supplied project instructions, use `apply_patch` to add only those approved instructions. Otherwise preserve the generated placeholder and ask one short, optional follow-up: whether the user wants to add anything to the new project's `AGENTS.md`. Do not invent product requirements.

## Connect an existing project

Confirm the absolute folder and desired Telegram command alias, then use:

```bash
<bridge>/scripts/project-manager add --name <project_alias> --path <absolute_existing_folder>
```

The folder must already exist and be a directory. The manager registers it and creates a default `AGENTS.md` only when none exists. Preserve an existing `AGENTS.md`; add requested instructions only after approval.

## Verify and report

1. Run `<bridge>/scripts/project-manager list` again.
2. Confirm the absolute path appears in `projects` and its alias appears in `projectCommands`.
3. Confirm `<project>/AGENTS.md` exists and matches the approved choice.
4. Report the new slash command and explain that sending it activates the project as the current Telegram Bridge project. The running Bridge refreshes project configuration before slash-command parsing, so do not restart it merely to expose the new command.

Never hand-edit `.env` for project creation or attachment. Never expose Telegram tokens or unrelated environment values.
