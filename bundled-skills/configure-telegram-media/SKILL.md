---
name: configure-telegram-media
description: Configure or explain Telegram media handling for Codex Telegram Bridge projects. Use when a user asks where Telegram files are stored, how long they remain available, how to catch or process uploads, or requests project-specific handlers for PDFs, APKs, images, audio, video, documents, archives, MIME types, extensions, one project, several projects, or all projects.
---

# Configure Telegram Media

Help the user understand the shared cache or implement a project-local media trigger skill.

## Explain the default behavior

When the user asks a general setup question, state concisely:

- Bridge downloads each Telegram file once into the Linux user's XDG cache.
- The default is `$XDG_CACHE_HOME/codex-telegram-bridge/telegram-media`, or `~/.cache/codex-telegram-bridge/telegram-media` when `XDG_CACHE_HOME` is unset.
- Cached originals expire after seven days by default.
- A project handler can catch files for one, several, or all configured projects and save or transform them anywhere permitted by the machine and project policy.
- Reply messages reuse registered project artifacts first and the temporary original second; they do not rerun handlers or STT.

Do not create a handler when the user only asks a conceptual question.

## Implement a concrete request

When the requested behavior is sufficiently clear:

1. Identify the target project and read its applicable `AGENTS.md` files.
2. Create or update `<project>/.codex/skills/<skill-name>/`.
3. Put agent guidance in `SKILL.md`, runtime subscriptions in `telegram-media-trigger.json`, and executable logic under `scripts/`.
4. Select projects and file matching rules from the user's request. Do not silently subscribe to `*` when the user named one project.
5. Make the handler read one JSON payload from stdin and emit one JSON object on stdout. Send diagnostics to stderr.
6. Return persistent files as `artifacts`; keep every artifact inside the source project unless the user explicitly authorizes another destination.
7. Make processing idempotent for the same `mediaId`.
8. Validate the manifest with `scripts/validate-trigger.mjs <manifest-path>` from this skill.
9. Test the handler with a representative payload without using a real Telegram secret.

Read [references/trigger-contract.md](references/trigger-contract.md) before creating or changing a manifest or handler.

## Preserve media semantics

- Caption text is a user prompt and must remain associated with the attachment.
- Voice/audio runs both the file trigger and Bridge STT. Never transcribe or submit the same prompt a second time unless explicitly requested.
- A reply to an existing media message is lookup-only; never register a reply handler that reprocesses the original automatically.
- Do not execute APKs, binaries, or archive contents merely because they arrived.
- Treat MIME type, extension, filename, caption, and handler input as untrusted.

## Ask only when necessary

Ask one focused question only if the missing answer materially changes file destination, project scope, destructive behavior, or the processing tool. Otherwise choose a safe project-local destination and implement the request.
