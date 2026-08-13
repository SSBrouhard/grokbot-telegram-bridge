import assert from "node:assert/strict";
import test from "node:test";

import { Bridge } from "../src/bridge.js";

function makeHarness() {
  const sent = [];
  const sentOptions = [];
  const prompts = [];
  const waits = [];
  const agents = [
    { id: "chief", name: "Chief of Staff", isRunning: false, lastMessageId: "old" },
    { id: "research", name: "Research", isRunning: false, lastMessageId: null },
  ];
  const workflows = [
    { id: "skill-1", name: "add-connector", trigger: null, isEnabledForAgent: true },
    { id: "routine-1", name: "Revenue-First Morning", trigger: { schedule: "0 8 * * *" }, source: "automation" },
    { id: "global-disabled", name: "hidden-global-skill", trigger: null },
  ];
  const telegram = {
    sendMessage: async (chatId, text, options) => {
      sent.push({ chatId, text });
      sentOptions.push(options);
      return { message_id: sent.length };
    },
    answerCallbackQuery: async () => {},
    editMessageReplyMarkup: async () => {},
  };
  const grok = {
    listAgents: async () => agents,
    getAgentWorkflows: async () => workflows,
    listMcpServers: async () => [{ serverIdentifier: "context7", status: "connected" }],
    sendPrompt: async (...args) => { prompts.push(args); },
    waitForReply: async (...args) => {
      waits.push(args);
      return { messageId: "new", text: "Finished." };
    },
    uploadAttachment: async (_agentId, filename) => `/attachments/${filename}`,
  };
  const state = {
    offset: 0,
    selected: new Map(),
    getAgent(chatId) { return this.selected.get(chatId); },
    async setAgent(chatId, agentId) { this.selected.set(chatId, agentId); },
    async setOffset(offset) { this.offset = offset; },
    approvals: new Map(),
    getApproval(token) { return this.approvals.get(token); },
    async setApproval(token, approval) { this.approvals.set(token, { ...approval }); },
    async deleteApproval(token) { this.approvals.delete(token); },
  };
  const bridge = new Bridge({
    telegram,
    grok,
    state,
    allowedUserIds: new Set([42]),
    allowedChatIds: new Set([99]),
    defaultAgent: "Chief of Staff",
  });
  return { bridge, sent, sentOptions, state, grok, prompts, waits, agents, workflows };
}

const update = (text, overrides = {}) => ({
  update_id: 10,
  message: {
    text,
    chat: { id: 99, type: "private" },
    from: { id: 42 },
    ...overrides,
  },
});

test("silently ignores unauthorized users and chats", async () => {
  const { bridge, sent } = makeHarness();
  await bridge.handleUpdate(update("hello", { from: { id: 7 } }));
  await bridge.handleUpdate(update("hello", { chat: { id: 7, type: "private" } }));
  await bridge.handleUpdate(update("hello", { chat: { id: 99, type: "group" } }));
  assert.deepEqual(sent, []);
});

test("sends ordinary text with a deterministic nonce and waits for its reply", async () => {
  const { bridge, sent, grok, prompts, waits } = makeHarness();
  grok.getAgentWorkflows = async () => { throw new Error("ordinary prompts must not depend on workflow discovery"); };
  await bridge.handleUpdate(update("Please summarize today."));
  assert.deepEqual(sent, [{ chatId: 99, text: "Finished." }]);
  assert.deepEqual(prompts[0].slice(0, 3), ["chief", "Please summarize today.", "telegram:10:99:0"]);
  assert.deepEqual(waits[0].slice(0, 2), ["chief", "telegram:10:99:0"]);
});

test("lists and selects agents", async () => {
  const { bridge, sent, state } = makeHarness();
  await bridge.handleUpdate(update("/agents"));
  await bridge.handleUpdate(update("/use Research"));

  assert.match(sent[0].text, /Chief of Staff/);
  assert.match(sent[0].text, /Research/);
  assert.equal(state.getAgent(99), "research");
  assert.match(sent[1].text, /Research/);
});

test("lists live skills and runs a native slash-named skill with rich text", async () => {
  const { bridge, sent, prompts, workflows } = makeHarness();
  for (let index = 0; index < 25; index += 1) {
    workflows.push({ id: `enabled-${index}`, name: `enabled-skill-${index}`, trigger: null, isEnabledForAgent: true });
  }
  await bridge.handleUpdate(update("/skills"));
  assert.match(sent[0].text, /add-connector/);
  assert.doesNotMatch(sent[0].text, /Revenue-First Morning/);
  assert.doesNotMatch(sent[0].text, /hidden-global-skill/);
  assert.match(sent[0].text, /Showing 20 of 26/);

  await bridge.handleUpdate(update("/skills enabled-skill-24"));
  assert.match(sent[1].text, /enabled-skill-24/);
  assert.doesNotMatch(sent[1].text, /Showing 20/);

  await bridge.handleUpdate(update("/add-connector Set up Linear"));
  assert.equal(prompts[0][1], "@add-connector Set up Linear");
  assert.deepEqual(JSON.parse(prompts[0][3].richText).content[0].content[0], {
    type: "workflowReference",
    attrs: { id: "skill-1", label: "add-connector", iconId: null, iconUrl: null },
  });
});

test("runs a skill through /run and reports an unknown exact name", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("/run add-connector Connect Slack"));
  assert.equal(prompts[0][1], "@add-connector Connect Slack");

  await bridge.handleUpdate(update("/run missing-skill"));
  assert.match(sent.at(-1).text, /No exact skill-name match/);
});

test("lists routines and box plugin status without hard-coded names", async () => {
  const { bridge, sent } = makeHarness();
  await bridge.handleUpdate(update("/routines"));
  await bridge.handleUpdate(update("/plugins"));
  assert.match(sent[0].text, /Revenue-First Morning/);
  assert.match(sent[1].text, /context7.*connected/i);
});

test("turns exact agent and routine @ references into Grok composer nodes", async () => {
  const { bridge, prompts } = makeHarness();
  await bridge.handleUpdate(update("Ask @Research to check @Revenue-First Morning."));
  const richText = JSON.parse(prompts[0][3].richText);
  assert.deepEqual(richText.content[0].content.filter((node) => node.type !== "text"), [
    { type: "mention", attrs: { id: "research", label: "Research" } },
    {
      type: "workflowReference",
      attrs: { id: "routine-1", label: "Revenue-First Morning", iconId: null, iconUrl: null },
    },
  ]);
});

test("leaves ambiguous @ labels as plain text instead of guessing an ID", async () => {
  const { bridge, agents, workflows, prompts } = makeHarness();
  agents.push({ id: "shared-agent", name: "Shared" });
  workflows.push({ id: "shared-routine", name: "Shared", trigger: { schedule: "daily" }, source: "automation" });
  await bridge.handleUpdate(update("Ask @Shared."));
  assert.equal(prompts[0][3].richText, undefined);
});

test("uploads the largest Telegram photo and sends it through Grok's native attachment path", async () => {
  const { bridge, sent, prompts } = makeHarness();
  bridge.telegram.downloadFile = async () => ({ bytes: new Uint8Array([1, 2, 3]), filename: "photo.jpg" });
  await bridge.handleUpdate(update(undefined, { photo: [{ file_id: "x" }] }));
  assert.equal(sent[0].text, "Finished.");
  assert.deepEqual(prompts[0][3].attachmentPaths, ["/attachments/telegram-photo-upload.jpg"]);
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-photo-upload.jpg"]);
});

test("rejects empty unsupported messages", async () => {
  const { bridge, sent } = makeHarness();
  await bridge.handleUpdate(update(undefined));
  assert.match(sent[0].text, /photo/i);
});

test("asks Grok to transcribe a captionless voice note", async () => {
  const { bridge, prompts } = makeHarness();
  bridge.telegram.downloadFile = async () => ({ bytes: new Uint8Array([1]), filename: "voice.ogg" });
  await bridge.handleUpdate(update(undefined, { voice: { file_id: "voice" } }));
  assert.match(prompts[0][1], /transcribe/i);
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-voice.ogg"]);
});

test("delivers Grok attachments through Telegram", async () => {
  const { bridge, grok } = makeHarness();
  const delivered = [];
  grok.waitForReply = async () => ({
    messageId: "reply",
    text: "Report attached.",
    attachments: [{ path: "/attachments/report.pdf", filename: "report.pdf" }],
  });
  grok.readAttachment = async () => new Uint8Array([4, 5, 6]);
  bridge.telegram.sendAttachment = async (chatId, attachment, options) => delivered.push({ chatId, attachment, options });
  await bridge.handleUpdate(update("Make a report", { message_id: 77 }));
  assert.equal(delivered[0].attachment.filename, "report.pdf");
  assert.equal(delivered[0].options.replyToMessageId, 77);
});

test("marks failed authorized updates and replies with a safe error", async () => {
  const { bridge, sent } = makeHarness();
  const reactions = [];
  bridge.telegram.setMessageReaction = async (...args) => reactions.push(args);
  await bridge.handleError(update("fail", { message_id: 55 }));
  assert.equal(reactions[0][2], "❌");
  assert.match(sent[0].text, /couldn't finish/i);
});

test("does not silently fall back when a saved agent disappeared", async () => {
  const { bridge, sent, state } = makeHarness();
  state.selected.set(99, "deleted-agent");
  await bridge.handleUpdate(update("hello"));
  assert.match(sent[0].text, /selected agent/);
});

test("offers only Approve once and Deny, then resolves the exact pending request", async () => {
  const { bridge, grok, state, sent, sentOptions } = makeHarness();
  const resolved = [];
  grok.waitForReply = async (_agentId, _nonce, options) => {
    await options.onApproval({
      id: "entry-1",
      kind: "send-message",
      message: {
        type: "auto-review-approval",
        approval: {
          requestId: "request-1",
          status: "pending",
          summary: "Run a command",
          command: "touch /tmp/strict-test",
          reason: "Requested by the user",
        },
      },
    });
    return { messageId: "final", text: "Done." };
  };
  grok.getPendingApproval = async () => ({ message: { type: "auto-review-approval" } });
  grok.resolveAutoReviewApproval = async (...args) => resolved.push(args);

  await bridge.handleUpdate(update("Do it", { message_id: 70 }));
  const buttons = sentOptions[0].inlineKeyboard[0];
  assert.deepEqual(buttons.map((button) => button.text), ["Approve once", "Deny"]);
  assert.match(sent[0].text, /touch \/tmp\/strict-test/);
  const callbackData = buttons[0].callback_data;
  const token = callbackData.split(":")[1];
  assert.ok(state.getApproval(token));

  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-1",
    data: callbackData,
    from: { id: 42 },
    message: { message_id: 1, chat: { id: 99, type: "private" } },
  } });
  assert.deepEqual(resolved[0].slice(0, 4), ["chief", "entry-1", "request-1", true]);
  assert.equal(state.getApproval(token), undefined);
});

test("rejects an approval callback from a different user without touching Grok", async () => {
  const { bridge, grok, state } = makeHarness();
  let resolved = false;
  grok.resolveLocalToolPermission = async () => { resolved = true; };
  await state.setApproval("abcdefghijklmnopqrstuvwx", {
    type: "local-tool",
    agentId: "chief",
    entryId: "entry",
    requestId: "request",
    chatId: 99,
    userId: 42,
    messageId: 5,
    expiresAt: Date.now() + 60_000,
  });
  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-2",
    data: "gta:abcdefghijklmnopqrstuvwx:a",
    from: { id: 7 },
    message: { message_id: 5, chat: { id: 99, type: "private" } },
  } });
  assert.equal(resolved, false);
});

test("expires approval buttons without resolving Grok", async () => {
  const { bridge, grok, state } = makeHarness();
  let resolved = false;
  grok.resolveLocalToolPermission = async () => { resolved = true; };
  await state.setApproval("abcdefghijklmnopqrstuvwx", {
    type: "local-tool",
    agentId: "chief",
    entryId: "entry",
    requestId: "request",
    chatId: 99,
    userId: 42,
    messageId: 5,
    expiresAt: Date.now() - 1,
  });
  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-3",
    data: "gta:abcdefghijklmnopqrstuvwx:a",
    from: { id: 42 },
    message: { message_id: 5, chat: { id: 99, type: "private" } },
  } });
  assert.equal(resolved, false);
  assert.equal(state.getApproval("abcdefghijklmnopqrstuvwx"), undefined);
});

test("rechecks Grok and refuses a stale request", async () => {
  const { bridge, grok, state } = makeHarness();
  let resolved = false;
  grok.getPendingApproval = async () => undefined;
  grok.resolveAutoReviewApproval = async () => { resolved = true; };
  await state.setApproval("abcdefghijklmnopqrstuvwx", {
    type: "auto-review",
    agentId: "chief",
    entryId: "entry",
    requestId: "request",
    chatId: 99,
    userId: 42,
    messageId: 5,
    expiresAt: Date.now() + 60_000,
  });
  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-4",
    data: "gta:abcdefghijklmnopqrstuvwx:d",
    from: { id: 42 },
    message: { message_id: 5, chat: { id: 99, type: "private" } },
  } });
  assert.equal(resolved, false);
  assert.equal(state.getApproval("abcdefghijklmnopqrstuvwx"), undefined);
});

test("maps a local permission approval to allow once", async () => {
  const { bridge, grok, state } = makeHarness();
  const resolved = [];
  grok.getPendingApproval = async () => ({ message: { type: "local-tool-permission" } });
  grok.resolveLocalToolPermission = async (...args) => resolved.push(args);
  await state.setApproval("abcdefghijklmnopqrstuvwx", {
    type: "local-tool",
    agentId: "chief",
    entryId: "entry",
    requestId: "request",
    chatId: 99,
    userId: 42,
    messageId: 5,
    expiresAt: Date.now() + 60_000,
  });
  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-5",
    data: "gta:abcdefghijklmnopqrstuvwx:a",
    from: { id: 42 },
    message: { message_id: 5, chat: { id: 99, type: "private" } },
  } });
  assert.deepEqual(resolved[0].slice(0, 4), ["chief", "entry", "request", true]);
});
