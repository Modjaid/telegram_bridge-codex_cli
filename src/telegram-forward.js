export function telegramForwardSource(message) {
  const origin = message?.forward_origin;
  if (origin) {
    if (origin.type === "user") return formatUser(origin.sender_user);
    if (origin.type === "hidden_user") return cleanName(origin.sender_user_name);
    if (origin.type === "chat") return formatChat(origin.sender_chat, origin.author_signature);
    if (origin.type === "channel") return formatChat(origin.chat, origin.author_signature);
    return "unknown sender";
  }

  // Keep compatibility with updates produced by older Bot API versions.
  if (message?.forward_from) return formatUser(message.forward_from);
  if (message?.forward_sender_name) return cleanName(message.forward_sender_name);
  if (message?.forward_from_chat) return formatChat(message.forward_from_chat, message.forward_signature);
  return "";
}

export function formatTelegramForward(message, text) {
  const source = telegramForwardSource(message);
  if (!source) return String(text || "").trim();
  return [`Forwarded from ${source}`, String(text || "").trim()].filter(Boolean).join("\n");
}

function formatUser(user) {
  if (!user) return "unknown sender";
  const fullName = [user.first_name, user.last_name].map(cleanName).filter(Boolean).join(" ");
  if (fullName) return fullName;
  if (user.username) return `@${cleanName(user.username)}`;
  return user.id ? `user ${user.id}` : "unknown sender";
}

function formatChat(chat, signature) {
  const name = cleanName(chat?.title || chat?.first_name || chat?.username || "unknown chat");
  const author = cleanName(signature);
  return author ? `${name} (${author})` : name;
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
