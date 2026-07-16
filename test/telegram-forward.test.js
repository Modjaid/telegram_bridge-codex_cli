import assert from "node:assert/strict";
import { formatTelegramForward, telegramForwardSource } from "../src/telegram-forward.js";

assert.equal(formatTelegramForward({}, "Hello"), "Hello");
assert.equal(formatTelegramForward({
  forward_origin: {
    type: "user",
    sender_user: { id: 12, first_name: "Ada", last_name: "Lovelace" },
  },
}, "Hello"), "Forwarded from Ada Lovelace\nHello");
assert.equal(formatTelegramForward({
  forward_origin: { type: "hidden_user", sender_user_name: "Hidden  Author" },
}, "Secret"), "Forwarded from Hidden Author\nSecret");
assert.equal(formatTelegramForward({
  forward_origin: {
    type: "channel",
    chat: { id: -100, title: "News" },
    author_signature: "Editor",
  },
}, "Update"), "Forwarded from News (Editor)\nUpdate");
assert.equal(telegramForwardSource({
  forward_from_chat: { title: "Legacy Channel" },
  forward_signature: "Owner",
}), "Legacy Channel (Owner)");

console.log("telegram forward tests passed");
