import { Bridge } from "./bridge.js";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { GrokClient } from "./grok-client.js";
import { JsonStateStore } from "./state.js";
import { TelegramClient } from "./telegram-client.js";
import { UpdateDispatcher } from "./update-dispatcher.js";

const config = loadConfig();
const state = new JsonStateStore(config.statePath);
await state.load();

const telegram = new TelegramClient(config.telegramToken);
const grok = new GrokClient(config.gatewayUrl, config.gatewayToken, {
  pollIntervalMs: config.pollIntervalMs,
  replyTimeoutMs: config.replyTimeoutMs,
});
const bridge = new Bridge({
  telegram,
  grok,
  state,
  allowedUserIds: config.allowedUserIds,
  allowedChatIds: config.allowedChatIds,
  defaultAgent: config.defaultAgent,
});
const dispatcher = new UpdateDispatcher(bridge);

await telegram.setMyCommands([
  { command: "help", description: "Show help" },
  { command: "agents", description: "List Grok agents" },
  { command: "use", description: "Select a Grok agent" },
  { command: "status", description: "Show selected agent status" },
  { command: "skills", description: "List Grok skills" },
  { command: "run", description: "Run a Grok skill" },
  { command: "routines", description: "List mentionable routines" },
  { command: "mentions", description: "List @ references" },
  { command: "plugins", description: "List plugin status" },
  { command: "settings", description: "Explain desktop-only settings" },
  { command: "commands", description: "Show all bridge commands" },
]);

let stopping = false;
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    shutdown.abort();
  });
}

console.log("grokbot-telegram-bridge started");
let consecutiveFailures = 0;
let fetchOffset = state.offset;
const pendingCommits = [];
let commitQueue = Promise.resolve();

function markProcessed(record) {
  record.processed = true;
  commitQueue = commitQueue.then(async () => {
    while (pendingCommits[0]?.processed) {
      const completed = pendingCommits.shift();
      await state.setOffset(completed.offset);
    }
  });
  return commitQueue;
}

while (!stopping) {
  try {
    const updates = await telegram.getUpdates(fetchOffset, 30, { signal: shutdown.signal });
    for (const update of updates) {
      const record = { offset: update.update_id + 1, processed: false };
      pendingCommits.push(record);
      fetchOffset = record.offset;
      void dispatcher.dispatch(update, { signal: shutdown.signal }).then(
        () => markProcessed(record),
        (error) => {
          if (!stopping && error.name !== "AbortError") {
            console.error("Update dispatch failed:", error.message);
          }
        },
      ).catch((error) => console.error("State commit failed:", error.message));
    }
    consecutiveFailures = 0;
  } catch (error) {
    if (stopping || error.name === "AbortError") break;
    console.error("Bridge polling failed:", error.message);
    consecutiveFailures += 1;
    const backoffMs = Math.min(1_000 * (2 ** (consecutiveFailures - 1)), 30_000);
    try {
      await sleep(backoffMs, undefined, { signal: shutdown.signal });
    } catch (sleepError) {
      if (stopping || sleepError.name === "AbortError") break;
      throw sleepError;
    }
  }
}

await dispatcher.drain();
await commitQueue;
console.log("grokbot-telegram-bridge stopped");
