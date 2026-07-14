---
name: codex-telegram-bridge
description: Manage Codex Telegram Bridge projects and Telegram media handling. Use when a user asks to create, attach, register, activate, list, choose, detach, or delete a Bridge project; create or update project AGENTS.md instructions; explain Telegram file storage or retention; or configure project handlers for PDFs, APKs, images, audio, video, documents, archives, MIME types, extensions, one project, several projects, or all projects.
---

# Codex Telegram Bridge

Keep Bridge project registration, project instructions, and Telegram media handlers consistent.

## Choose the workflow

- For project creation, attachment, registration, activation, deletion, or instructions, follow **Manage projects**.
- For file storage questions or upload handlers, follow **Handle Telegram media**.
- When a media request needs a missing project, complete the project workflow first and then continue with the media workflow.

## Manage projects

### Confirm the target

Identify the Linux user whose Bridge owns the project. Prefer the user running the relevant Bridge service; this machine may host several users.

When the user says only “add a project” or equivalent, always ask whether to create a new project or attach a folder that already exists on the machine. Do not ask this again when the user explicitly said “create a new project” or “attach/connect this existing folder.” Use a supplied project name without asking again; ask for a name only when none was supplied.

For an existing project, inspect its `AGENTS.md` and never replace existing instructions without explicit approval. For a new project, do not delay creation to ask about instructions: ensure `AGENTS.md` exists, then offer to add instructions afterward.

### Locate the Bridge

1. Locate the target user's Bridge and persistent data directory.
2. Read the Bridge's applicable `AGENTS.md` and project-related values from `config.env` without exposing secrets.
3. Run `<bridge>/scripts/project-manager list` to obtain `createRoot`, allowed projects, and command aliases.
4. Prefer new folders directly inside `createRoot`. Do not create projects inside Bridge source code unless `createRoot` points there or the user explicitly chooses it.
5. Explain the resolved absolute path before creation only when ambiguity remains.

### Create a project

Derive the closest readable lowercase Latin alias from the project name. Replace spaces and dashes with `_`; allow only `a-z`, `0-9`, and `_`. If the name cannot be converted safely, propose a short Latin transliteration and confirm it.

Use only:

```bash
<bridge>/scripts/project-manager create --name <project_name>
```

Never create the folder first with `mkdir`. The manager creates it below `PROJECT_CREATE_ROOT`, registers it in `PROJECT_ALLOWLIST` and `PROJECT_COMMANDS`, and ensures `AGENTS.md` exists.

If the user already supplied instructions, use `apply_patch` to add only those instructions. Otherwise preserve the generated placeholder and ask one optional follow-up: whether to add anything to the new `AGENTS.md`. Do not invent requirements.

### Attach an existing project

Confirm the absolute folder and desired alias, then use:

```bash
<bridge>/scripts/project-manager add --name <project_alias> --path <absolute_existing_folder>
```

The folder must already exist. Preserve its `AGENTS.md`; the manager creates a default file only when none exists.

### Remove a project

Treat every removal request as destructive and pause before changing anything. Resolve the alias and absolute folder with `project-manager list`, show both to the user, and always ask them to choose explicitly:

1. Remove only the slash command and Bridge registration, preserving the folder and all files.
2. Remove the registration and delete the entire project folder with all of its contents.

Do not infer the choice from a vague word such as “remove” or “delete,” and do not proceed until the user answers.

For command-only removal, use:

```bash
<bridge>/scripts/project-manager detach --name <project_alias>
```

For complete deletion, use:

```bash
<bridge>/scripts/project-manager delete --name <project_alias>
```

The manager recursively deletes folders only inside the Bridge-managed projects root. For an attached folder outside that root, explain that `delete` removes only its registration and preserves the folder. Deleting that external folder requires a separate explicit confirmation of its absolute path; never silently use `rm` to bypass the manager's protection.

After either operation, run `project-manager list` again and verify that the alias and path are no longer registered. For full deletion inside the managed root, also verify that the folder no longer exists.

### Verify the project

1. Run `project-manager list` again.
2. Confirm the path appears in `projects` and the alias in `projectCommands`.
3. Confirm `AGENTS.md` exists and contains only approved instructions.
4. Report the slash command. Sending it activates that project as current.

The running Bridge refreshes project configuration before slash commands, so do not restart merely to expose a new project. Never hand-edit `config.env` for project lifecycle operations.

## Handle Telegram media

### Explain default storage

For a conceptual question, explain only what is relevant and do not create a handler:

- Bridge downloads each Telegram file once into the Linux user's XDG cache.
- The default is `$XDG_CACHE_HOME/codex-telegram-bridge/telegram-media`, or `~/.cache/codex-telegram-bridge/telegram-media` when unset.
- Cached originals expire after seven days by default.
- A project handler can catch files for one, several, or all configured projects and save or transform them where project policy permits.
- Replies reuse registered artifacts first and the temporary original second; they do not rerun handlers or STT.

### Implement a handler

When the requested behavior is clear:

1. Identify or register the target project and read its applicable `AGENTS.md` files.
2. Read [references/trigger-contract.md](references/trigger-contract.md).
3. Create or update `<project>/.codex/skills/<skill-name>/`.
4. Put agent guidance in `SKILL.md`, subscriptions in `telegram-media-trigger.json`, and executable logic under `scripts/`.
5. Apply the requested project and file matching rules. Never silently subscribe to `*` when the user named a project.
6. Read one JSON payload from stdin, emit one JSON object on stdout, and send diagnostics to stderr.
7. Return persistent files as `artifacts`; keep them inside the source project unless another destination was explicitly authorized.
8. Make processing idempotent for the same `mediaId`.
9. Validate with `scripts/validate-trigger.mjs <manifest-path>` from this skill.
10. Test with a representative payload and no real Telegram secret.

### Preserve media semantics

- Keep caption text associated with the attachment as the user prompt.
- Voice and audio run both the file trigger and Bridge STT. Do not transcribe or submit the prompt twice unless asked.
- Treat replies to existing media as lookup-only; never reprocess the original automatically.
- Do not execute APKs, binaries, or archive contents merely because they arrived.
- Treat MIME type, extension, filename, caption, and handler input as untrusted.

## Ask only when necessary

Ask one focused question only when the answer materially changes the project identity, destination, scope, destructive behavior, or processing tool. Otherwise take the safe project-local action.
