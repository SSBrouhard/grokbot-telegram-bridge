import assert from "node:assert/strict";
import test from "node:test";

import { Bridge } from "../src/bridge.js";
import { GrokClient } from "../src/grok-client.js";

function mirrorHarness(options = {}) {
  const sent = [];
  const attachments = [];
  const agents = [
    { id: "chief", name: "Chief of Staff", isRunning: false },
    { id: "research", name: "Research", isRunning: false },
  ];
  const transcripts = options.transcripts ?? new Map([
    ["chief", [{ id: "old", kind: "send-message", message: { type: "text", content: "Old" } }]],
    ["research", []],
  ]);
  const state = {
    selected: new Map(),
    approvals: new Map(),
    cursors: new Map(options.cursors ?? [["chief", { initialized: true, entryId: "old" }]]),
    enabled: options.enabled ?? true,
    getAgent(chatId) { return this.selected.get(chatId); },
    async setAgent(chatId, agentId) { this.selected.set(chatId, agentId); },
    isMirrorEnabled(configured) { return configured && this.enabled; },
    async setMirrorEnabled(enabled) { this.enabled = enabled; },
    getMirrorCursor(agentId) { return this.cursors.get(agentId); },
    async setMirrorCursor(agentId, entryId) {
      this.cursors.set(agentId, { initialized: true, entryId: entryId ?? null });
    },
    getApproval(token) { return this.approvals.get(token); },
    async setApproval(token, approval) { this.approvals.set(token, { ...approval }); },
    async deleteApproval(token) { this.approvals.delete(token); },
  };
  const telegram = {
    async sendMessage(chatId, text, sendOptions = {}) {
      const record = { chatId, text, options: sendOptions, message_id: sent.length + 1 };
      sent.push(record);
      return { message_id: record.message_id };
    },
    async sendAttachment(chatId, attachment, sendOptions = {}) {
      attachments.push({ chatId, attachment, options: sendOptions });
      return { message_id: 100 + attachments.length };
    },
    async answerCallbackQuery() {},
    async editMessageReplyMarkup() {},
  };
  const grok = {
    pollIntervalMs: 1,
    async listAgents() { return agents; },
    async getTranscriptTail(agentId) { return transcripts.get(agentId) ?? []; },
    async getTranscript(agentId) { return transcripts.get(agentId) ?? []; },
    getPromptContent: GrokClient.prototype.getPromptContent,
    async waitForReply() { return { messageId: "final", text: "Finished.", attachments: [] }; },
    async readAttachment() { return new Uint8Array([1, 2, 3]); },
  };
  const bridge = new Bridge({
    telegram,
    grok,
    state,
    allowedUserIds: new Set([42, 7]),
    allowedChatIds: new Set([99, 88]),
    defaultAgent: "Chief of Staff",
    mirrorChatId: options.configured === false ? undefined : 99,
    mirrorUserId: options.configured === false ? undefined : 42,
  });
  return { bridge, telegram, grok, state, sent, attachments, agents, transcripts };
}

const command = (text, userId = 42, chatId = 99) => ({
  update_id: 1,
  message: {
    text,
    message_id: 10,
    chat: { id: chatId, type: "private" },
    from: { id: userId },
  },
});

test("mirrors a desktop prompt and completed Markdown response in one Telegram reply thread", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "desktop-prompt",
    kind: "message",
    clientNonce: "desktop:one",
    message: { type: "text", content: "**Build** the report" },
  });
  harness.grok.waitForReply = async () => ({
    messageId: "final",
    text: "## Finished\n\n- result",
    attachments: [],
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.match(harness.sent[0].text, /Desktop · Chief of Staff/);
  assert.match(harness.sent[0].text, /\*\*Build\*\*/);
  assert.equal(harness.sent[1].text, "## Finished\n\n- result");
  assert.equal(harness.sent[1].options.replyToMessageId, harness.sent[0].message_id);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "final");
});

test("skips a Telegram-originated prompt and its complete response turn", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "telegram-prompt",
    kind: "message",
    clientNonce: "telegram:10:99:70",
    message: { type: "text", content: "Do not mirror" },
  });
  let waitedWith;
  harness.grok.waitForReply = async (...args) => {
    waitedWith = args;
    return { messageId: "telegram-final", text: "Also skipped" };
  };

  await harness.bridge.pollDesktopMirrorOnce();

  assert.deepEqual(harness.sent, []);
  assert.equal(waitedWith[1], "telegram:10:99:70");
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "telegram-final");
});

test("baselines the newest transcript entry on first startup without replaying history", async () => {
  const transcripts = new Map([["chief", [
    { id: "historical-prompt", kind: "message", message: { type: "text", content: "Old prompt" } },
    { id: "historical-final", kind: "send-message", message: { type: "text", content: "Old answer" } },
  ]]]);
  const harness = mirrorHarness({ transcripts, cursors: [] });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.deepEqual(harness.sent, []);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "historical-final");
});

test("does not advance a desktop cursor when final Telegram delivery fails", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "desktop-prompt",
    kind: "message",
    clientNonce: "desktop:failure",
    message: { type: "text", content: "Prompt" },
  });
  const originalSend = harness.telegram.sendMessage;
  let calls = 0;
  harness.telegram.sendMessage = async (...args) => {
    calls += 1;
    if (calls === 2) throw new Error("Telegram unavailable");
    return originalSend(...args);
  };

  await assert.rejects(harness.bridge.pollDesktopMirrorOnce(), /Telegram unavailable/);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "old");
});

test("sends response images and files under the mirrored desktop prompt", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "desktop-prompt",
    kind: "message",
    clientNonce: "desktop:attachments",
    attachmentPaths: ["/input/source.png"],
    attachmentNames: ["source.png"],
    message: { type: "text", content: "Use this image" },
  });
  harness.grok.waitForReply = async () => ({
    messageId: "output-file",
    text: "Done, not Working...",
    attachments: [
      { path: "/output/chart.png", filename: "chart.png" },
      { path: "/output/report.pdf", filename: "report.pdf" },
    ],
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent[1].text, "Done, not Working...");
  assert.deepEqual(harness.attachments.map(({ attachment }) => attachment.filename), [
    "source.png", "chart.png", "report.pdf",
  ]);
  assert.ok(harness.attachments.every(({ options }) => options.replyToMessageId === harness.sent[0].message_id));
});

test("announces desktop approval once with strict buttons bound to the configured mirror user", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "desktop-prompt",
    kind: "message",
    clientNonce: "desktop:approval",
    message: { type: "text", content: "Needs approval" },
  });
  harness.grok.waitForReply = async (_agentId, _nonce, options) => {
    await options.onApproval({
      id: "approval-entry",
      kind: "send-message",
      message: {
        type: "local-tool-permission",
        ask: { requestId: "request-1", status: "pending", action: "Open a file" },
      },
    });
    return { messageId: "final", text: "Done", attachments: [] };
  };

  await harness.bridge.pollDesktopMirrorOnce();

  const approvalMessage = harness.sent.find(({ options }) => options.inlineKeyboard);
  assert.deepEqual(approvalMessage.options.inlineKeyboard[0].map(({ text }) => text), ["Approve once", "Deny"]);
  assert.equal(approvalMessage.options.replyToMessageId, harness.sent[0].message_id);
  assert.equal(harness.state.approvals.size, 1);
  assert.equal([...harness.state.approvals.values()][0].userId, 42);
});

test("agent switching baselines an unseen agent and resumes an existing cursor without duplicates", async () => {
  const harness = mirrorHarness();
  harness.transcripts.set("research", [
    { id: "research-old-prompt", kind: "message", message: { type: "text", content: "History" } },
    { id: "research-old-final", kind: "send-message", message: { type: "text", content: "History reply" } },
  ]);

  await harness.bridge.handleUpdate(command("/use Research"));
  assert.equal(harness.state.getMirrorCursor("research").entryId, "research-old-final");
  harness.sent.length = 0;
  await harness.bridge.pollDesktopMirrorOnce();
  assert.deepEqual(harness.sent, []);

  harness.transcripts.get("research").push({
    id: "research-new-prompt",
    kind: "message",
    clientNonce: "desktop:research",
    message: { type: "text", content: "New research" },
  });
  await harness.bridge.pollDesktopMirrorOnce();
  assert.match(harness.sent[0].text, /New research/);

  await harness.bridge.handleUpdate(command("/use Chief of Staff"));
  const before = harness.sent.length;
  await harness.bridge.pollDesktopMirrorOnce();
  assert.equal(harness.sent.length, before);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "old");
});

test("mirror commands enforce configured chat and user and require paired environment config", async () => {
  const harness = mirrorHarness();
  await harness.bridge.handleUpdate(command("/mirror off", 7, 99));
  assert.equal(harness.state.enabled, true);
  assert.match(harness.sent.at(-1).text, /Only the configured/);

  await harness.bridge.handleUpdate(command("/mirror off", 42, 99));
  assert.equal(harness.state.enabled, false);
  await harness.bridge.handleUpdate(command("/mirror status", 42, 99));
  assert.match(harness.sent.at(-1).text, /is off/);
  await harness.bridge.handleUpdate(command("/mirror on", 42, 99));
  assert.equal(harness.state.enabled, true);

  const unconfigured = mirrorHarness({ configured: false });
  await unconfigured.bridge.handleUpdate(command("/mirror on"));
  assert.match(unconfigured.sent[0].text, /both GROK_DESKTOP_MIRROR_CHAT_ID.*GROK_DESKTOP_MIRROR_USER_ID/);
});

test("mirror watcher retries transient polling errors independently and aborts cleanly", async () => {
  const harness = mirrorHarness();
  const controller = new AbortController();
  let listCalls = 0;
  harness.grok.listAgents = async () => {
    listCalls += 1;
    if (listCalls === 1) throw new Error("temporary mirror failure");
    controller.abort();
    return harness.agents;
  };
  let telegramStillResponsive = false;
  const telegramWork = Promise.resolve().then(() => { telegramStillResponsive = true; });

  await harness.bridge.runDesktopMirror({ signal: controller.signal });
  await telegramWork;

  assert.ok(listCalls >= 2);
  assert.equal(telegramStillResponsive, true);
});

test("mirror watcher exits when shutdown aborts its idle wait", async () => {
  const harness = mirrorHarness();
  harness.grok.pollIntervalMs = 10_000;
  const controller = new AbortController();
  const watcher = harness.bridge.runDesktopMirror({ signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await watcher;
  assert.equal(controller.signal.aborted, true);
});
