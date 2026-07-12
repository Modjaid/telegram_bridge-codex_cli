# Telegram media trigger contract

## Layout

```text
<project>/.codex/skills/<skill-name>/
├── SKILL.md
├── telegram-media-trigger.json
└── scripts/handle-media.js
```

## Manifest

```json
{
  "version": 1,
  "subscriptions": [{
    "id": "documents",
    "enabled": true,
    "projects": ["agent", "memomaker"],
    "match": {
      "extensions": [".pdf", ".apk"],
      "mimeTypes": ["application/pdf"],
      "mimePatterns": ["image/*"],
      "mediaTypes": ["document"],
      "maxBytes": 52428800
    },
    "run": "scripts/handle-media.js"
  }]
}
```

Use `projects: ["*"]` for all configured projects. Arrays match with OR. Distinct matcher groups also use OR unless `matchMode` is `all`. Use `match: {"all": true}` for every file. Set `fallback: true` to run a subscription only when no normal subscription matched.

Supported match fields: `extensions`, `mimeTypes`, `mimePatterns`, `mediaTypes`, `minBytes`, `maxBytes`, and `all`.

## Handler input

Bridge sends JSON through stdin:

```json
{
  "sourceProject": {"alias": "agent", "path": "/home/agent"},
  "attachment": {
    "mediaId": "tg_123_456_hash",
    "telegram": {"chatId": "123", "messageId": "456", "caption": "Inspect this"},
    "file": {"path": "/home/user/.cache/.../file.pdf", "mimeType": "application/pdf", "mediaType": "document", "sizeBytes": 123}
  },
  "subscription": {"id": "documents"}
}
```

## Handler output

Write exactly one JSON object to stdout:

```json
{
  "status": "processed",
  "promptContext": "Optional context for the agent",
  "artifacts": [{
    "mediaId": "tg_123_456_hash",
    "path": "Documents/file.pdf",
    "kind": "original"
  }]
}
```

Statuses are `processed`, `ignored`, `processing`, or `failed`. Artifact paths may be project-relative or absolute, but Bridge accepts them only when they resolve inside the source project and already exist.

## Manual registration

When an agent creates or moves a persistent artifact outside a trigger run:

```bash
media-event complete --media-id <id> --project <alias> --path <project-relative-path>
```
