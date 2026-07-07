import { readFileSync } from "node:fs";
import path from "node:path";

const audioPath = process.argv.at(-1);
if (process.argv.length < 3 || !audioPath) {
  fail("Usage: node scripts/transcribe-openai.js /path/to/audio.wav");
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) fail("OPENAI_API_KEY is required");

const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const language = process.env.OPENAI_TRANSCRIBE_LANGUAGE || "";
const prompt = process.env.OPENAI_TRANSCRIBE_PROMPT || "";

const form = new FormData();
form.append("model", model);
form.append("file", new Blob([readFileSync(audioPath)], { type: "audio/wav" }), path.basename(audioPath));
form.append("response_format", "json");
if (language) form.append("language", language);
if (prompt) form.append("prompt", prompt);

const response = await fetch(`${baseUrl}/audio/transcriptions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form,
});

const bodyText = await response.text();
let body;
try {
  body = JSON.parse(bodyText);
} catch {
  body = null;
}

if (!response.ok) {
  const message = body?.error?.message || bodyText || `HTTP ${response.status}`;
  fail(`Transcription request failed: ${message}`);
}

const text = body?.text || "";
process.stdout.write(text.trim());

function fail(message) {
  console.error(message);
  process.exit(1);
}
