import assert from "node:assert/strict";
import test from "node:test";

import { TelegramClient } from "../src/telegram-client.js";

test("long polls from the requested offset without exposing the token in the body", async () => {
  const requests = [];
  const client = new TelegramClient("secret-token", {
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    },
  });

  await client.getUpdates(41, 0);

  assert.equal(requests[0].url, "https://api.telegram.org/botsecret-token/getUpdates");
  assert.deepEqual(requests[0].body, { offset: 41, timeout: 0, allowed_updates: ["message", "callback_query"] });
  assert.doesNotMatch(JSON.stringify(requests[0].body), /secret-token/);
});

test("sends strict approval buttons and handles callback acknowledgements", async () => {
  const requests = [];
  const client = new TelegramClient("token", {
    fetchImpl: async (url, options) => {
      requests.push({ method: url.split("/").at(-1), body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    },
  });
  const keyboard = [[
    { text: "Approve once", callback_data: "gta:token:a" },
    { text: "Deny", callback_data: "gta:token:d" },
  ]];
  assert.equal((await client.sendMessage(99, "Review", { inlineKeyboard: keyboard })).message_id, 7);
  await client.answerCallbackQuery("callback-1", "Approved once.");
  await client.editMessageReplyMarkup(99, 7);

  assert.deepEqual(requests[0].body.reply_markup.inline_keyboard, keyboard);
  assert.equal(requests[1].body.callback_query_id, "callback-1");
  assert.deepEqual(requests[2].body.reply_markup.inline_keyboard, []);
});

test("splits long replies within Telegram's text limit", async () => {
  const bodies = [];
  const client = new TelegramClient("token", {
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
  });

  await client.sendMessage(99, "x".repeat(8_001));

  assert.deepEqual(bodies.map((body) => body.text.length), [4_000, 4_000, 1]);
  assert.ok(bodies.every((body) => body.chat_id === 99));
});
