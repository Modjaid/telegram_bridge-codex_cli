---
name: manage-telegram-projects
description: Create or connect Codex Telegram Bridge projects for the correct Linux user, register them in the Bridge /projects command, and create or update project AGENTS.md instructions. Use when a user asks to create, add, attach, register, or choose a folder for a Telegram bot project, workspace, or working directory.
---

# Manage Telegram Projects

Create or connect a project through the Bridge's project manager so its folder and `/projects` entry stay consistent.

## Start with the user's intent

Before changing files, identify the Linux user whose Bridge should own the project. Prefer the user running the relevant Bridge service; do not assume that the current shell user owns every Bridge on the machine.

Ask the user to choose one of these paths unless already clear:

- create a new project;
- connect an existing folder to the Telegram bot.

For a new project, confirm the project name before creating it. Also ask whether `AGENTS.md` should be empty or contain project-specific instructions based on the user's request. For an existing project, inspect its current `AGENTS.md` and never replace existing instructions without explicit approval.

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

The manager normalizes the Telegram command to lowercase with spaces or dashes represented by underscores, creates the folder below `PROJECT_CREATE_ROOT`, registers it in `PROJECT_ALLOWLIST` and `PROJECT_COMMANDS`, and ensures `AGENTS.md` exists.

After creation, use `apply_patch` to make `AGENTS.md` either empty or contain only the approved project instructions. Do not add invented product requirements.

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
4. State that a running Bridge may need a restart before `/projects` reflects the changed `.env`; do not restart a service unless the user requested it or already authorized completing the live rollout.

Never hand-edit `.env` for project creation or attachment. Never expose Telegram tokens or unrelated environment values.
