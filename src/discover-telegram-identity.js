import { TelegramClient } from "./telegram-client.js";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

const telegram = new TelegramClient(token);
const updates = await telegram.getUpdates(0);
const identities = new Map();
for (const update of updates) {
  const message = update.message;
  if (!message?.from?.id || !message?.chat?.id) continue;
  const key = `${message.from.id}:${message.chat.id}`;
  identities.set(key, {
    userId: message.from.id,
    chatId: message.chat.id,
    chatType: message.chat.type,
  });
}

if (updates.length) {
  const nextOffset = Math.max(...updates.map((update) => update.update_id)) + 1;
  await telegram.getUpdates(nextOffset, 0);
}

if (!identities.size) {
  console.log("No message identities found. Send the bot /start, then run this command again.");
} else {
  console.log("Telegram identities found (message contents omitted):");
  for (const identity of identities.values()) {
    console.log(`user=${identity.userId} chat=${identity.chatId} type=${identity.chatType}`);
  }
}
