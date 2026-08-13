import { markdownToTelegramHtml } from "./telegram-format.js";

const TELEGRAM_TEXT_LIMIT = 4_096;
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const TELEGRAM_UPLOAD_LIMIT = 20 * 1024 * 1024;

function chunks(text, limit = 4_000) {
  const parts = [];
  for (let start = 0; start < text.length; start += limit) parts.push(text.slice(start, start + limit));
  return parts.length ? parts : [""];
}

export class TelegramClient {
  constructor(token, options = {}) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
    this.fetch = options.fetchImpl ?? fetch;
  }

  async call(method, body, timeoutMs = 35_000, options = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const error = new Error(`Telegram ${method} failed with HTTP ${response.status}`);
      error.telegramRejected = response.status >= 400 && response.status < 500;
      throw error;
    }
    const payload = await response.json();
    if (!payload.ok) {
      const error = new Error(`Telegram ${method} rejected the request`);
      error.telegramRejected = true;
      throw error;
    }
    return payload.result;
  }

  splitMessage(text, limit = 4_000) {
    return chunks(text, limit);
  }

  getUpdates(offset, timeoutSeconds = 30, options = {}) {
    return this.call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
      (timeoutSeconds * 1_000) + 10_000,
      options,
    );
  }

  async sendMessage(chatId, text, options = {}) {
    if (text.length > TELEGRAM_TEXT_LIMIT) {
      const parts = chunks(text);
      let result;
      for (const [index, part] of parts.entries()) {
        result = await this.sendMessage(chatId, part, {
          ...options,
          ...(index === parts.length - 1 ? {} : { inlineKeyboard: undefined }),
        });
      }
      return result;
    }
    const reply = options.replyToMessageId
      ? { reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } }
      : {};
    const replyMarkup = options.inlineKeyboard
      ? { reply_markup: { inline_keyboard: options.inlineKeyboard } }
      : {};
    try {
      return await this.call("sendMessage", {
        chat_id: chatId,
        text: markdownToTelegramHtml(text),
        parse_mode: "HTML",
        ...reply,
        ...replyMarkup,
      }, 35_000, options);
    } catch (error) {
      if (!error.telegramRejected) throw error;
      return this.call("sendMessage", { chat_id: chatId, text, ...reply, ...replyMarkup }, 35_000, options);
    }
  }

  answerCallbackQuery(callbackQueryId, text, options = {}) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    }, 35_000, options);
  }

  editMessageReplyMarkup(chatId, messageId, inlineKeyboard = [], options = {}) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: inlineKeyboard },
    }, 35_000, options);
  }

  sendChatAction(chatId, action = "typing", options = {}) {
    return this.call("sendChatAction", { chat_id: chatId, action }, 35_000, options);
  }

  setMessageReaction(chatId, messageId, emoji, options = {}) {
    return this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    }, 35_000, options);
  }

  setMyCommands(commands, options = {}) {
    return this.call("setMyCommands", { commands }, 35_000, options);
  }

  async downloadFile(fileId, options = {}) {
    const metadata = await this.call("getFile", { file_id: fileId }, 35_000, options);
    if (typeof metadata?.file_path !== "string" || !metadata.file_path) {
      throw new Error("Telegram getFile returned no file path");
    }
    if (Number.isFinite(metadata.file_size) && metadata.file_size > TELEGRAM_DOWNLOAD_LIMIT) {
      throw new Error("Telegram attachment exceeds the 20 MB public Bot API limit");
    }
    const timeout = AbortSignal.timeout(60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.fetch(`${this.fileBaseUrl}/${metadata.file_path}`, { signal });
    if (!response.ok) throw new Error(`Telegram file download failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > TELEGRAM_DOWNLOAD_LIMIT) {
      throw new Error("Telegram attachment exceeds the 20 MB public Bot API limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error("Telegram attachment is empty");
    if (bytes.byteLength > TELEGRAM_DOWNLOAD_LIMIT) {
      throw new Error("Telegram attachment exceeds the 20 MB public Bot API limit");
    }
    return {
      bytes,
      filename: metadata.file_path.split("/").at(-1) || "telegram-attachment.bin",
    };
  }

  async sendAttachment(chatId, attachment, options = {}) {
    if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.byteLength === 0) {
      throw new Error("Outgoing attachment is empty");
    }
    if (attachment.bytes.byteLength > TELEGRAM_UPLOAD_LIMIT) {
      throw new Error("Outgoing attachment exceeds the 20 MB bridge limit");
    }
    const filename = attachment.filename || "grok-attachment.bin";
    const extension = filename.split(".").at(-1)?.toLowerCase();
    const asPhoto = ["jpg", "jpeg", "png", "webp"].includes(extension);
    const field = asPhoto ? "photo" : "document";
    const method = asPhoto ? "sendPhoto" : "sendDocument";
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set(field, new Blob([attachment.bytes]), filename);
    if (attachment.caption) form.set("caption", attachment.caption.slice(0, 1_024));
    if (options.replyToMessageId) {
      form.set("reply_parameters", JSON.stringify({
        message_id: options.replyToMessageId,
        allow_sending_without_reply: true,
      }));
    }
    const timeout = AbortSignal.timeout(60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.fetch(`${this.baseUrl}/${method}`, { method: "POST", body: form, signal });
    if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(`Telegram ${method} rejected the request`);
    return payload.result;
  }
}
