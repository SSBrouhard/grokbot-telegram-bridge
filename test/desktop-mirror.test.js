import assert from "node:assert/strict";
import test from "node:test";

import { Bridge } from "../src/bridge.js";
import { GrokClient } from "../src/grok-client.js";

function mirrorHarness(options = {}) {
  const sent = [];
  const attachments = [];
  const callbackAnswers = [];
  const markupEdits = [];
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
    deliveries: new Map(),
    promptBoundaries: new Map(),
    promptContexts: new Map(),
    retiredPromptTurns: new Map(),
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
    getPromptTurnBoundary(agentId, clientNonce) {
      return this.promptBoundaries.get(`${agentId}:${clientNonce}`);
    },
    async setPromptTurnBoundary(agentId, clientNonce, entryId) {
      const key = `${agentId}:${clientNonce}`;
      if (this.retiredPromptTurns.has(key)) return false;
      this.promptBoundaries.set(key, entryId);
      return true;
    },
    async deletePromptTurnBoundary(agentId, clientNonce) {
      this.promptBoundaries.delete(`${agentId}:${clientNonce}`);
    },
    listPromptTurnBoundaryAgentIds() {
      return [...new Set([...this.promptBoundaries.keys()].map((key) => key.split(":", 1)[0]))];
    },
    listPromptTurnBoundaries(agentId) {
      return [...this.promptBoundaries.entries()]
        .filter(([key]) => key.startsWith(`${agentId}:`))
        .map(([key, entryId]) => ({ clientNonce: key.slice(agentId.length + 1), entryId }));
    },
    async retirePromptTurn(agentId, clientNonce, entryId) {
      const key = `${agentId}:${clientNonce}`;
      this.promptBoundaries.delete(key);
      this.retiredPromptTurns.set(key, entryId);
      this.promptContexts.delete(key);
    },
    getPromptContext(agentId, clientNonce) {
      return this.promptContexts.get(`${agentId}:${clientNonce}`);
    },
    listPromptContextAgentIds() {
      return [...new Set([...this.promptContexts.keys()].map((key) => key.split(":", 1)[0]))];
    },
    listPromptContexts(agentId) {
      return [...this.promptContexts.entries()]
        .filter(([key]) => key.startsWith(`${agentId}:`))
        .map(([key, context]) => ({ clientNonce: key.slice(agentId.length + 1), ...context }));
    },
    async setPromptContext(agentId, clientNonce, context) {
      this.promptContexts.set(`${agentId}:${clientNonce}`, { ...context });
    },
    async deletePromptContext(agentId, clientNonce) {
      this.promptContexts.delete(`${agentId}:${clientNonce}`);
    },
    getApproval(token) { return this.approvals.get(token); },
    listApprovals() { return [...this.approvals.entries()]; },
    async setApproval(token, approval) { this.approvals.set(token, { ...approval }); },
    async deleteApproval(token) { this.approvals.delete(token); },
    getDeliveryProgress(key) { return this.deliveries.get(key); },
    async setDeliveryProgress(key, progress) { this.deliveries.set(key, { ...progress }); },
    async deleteDeliveryProgress(key) { this.deliveries.delete(key); },
  };
  const telegram = {
    splitMessage(text) { return text.length > 4_096 ? text.match(/[\s\S]{1,4000}/g) : [text]; },
    async sendMessage(chatId, text, sendOptions = {}) {
      const record = { chatId, text, options: sendOptions, message_id: sent.length + 1 };
      sent.push(record);
      return { message_id: record.message_id };
    },
    async sendAttachment(chatId, attachment, sendOptions = {}) {
      attachments.push({ chatId, attachment, options: sendOptions });
      return { message_id: 100 + attachments.length };
    },
    async answerCallbackQuery(callbackId, text) { callbackAnswers.push({ callbackId, text }); },
    async editMessageReplyMarkup(chatId, messageId, inlineKeyboard) {
      markupEdits.push({ chatId, messageId, inlineKeyboard });
    },
  };
  const grok = {
    pollIntervalMs: 1,
    async listAgents() { return agents; },
    async getTranscriptTail(agentId) { return transcripts.get(agentId) ?? []; },
    async getTranscript(agentId) { return transcripts.get(agentId) ?? []; },
    async isAgentBusy() { return false; },
    getPromptContent: GrokClient.prototype.getPromptContent,
    getReplyContent: GrokClient.prototype.getReplyContent,
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
  return {
    bridge,
    telegram,
    grok,
    state,
    sent,
    attachments,
    agents,
    transcripts,
    callbackAnswers,
    markupEdits,
  };
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

test("mirrors autonomous routine text without a preceding user prompt", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "routine-text",
    kind: "send-message",
    message: { type: "text", content: "Morning revenue proposal" },
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.match(harness.sent[0].text, /Routine · Chief of Staff/);
  assert.match(harness.sent[0].text, /Morning revenue proposal/);
  assert.equal(harness.sent[0].options.inlineKeyboard, undefined);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-text");
});

test("checkpoints each autonomous entry so a failed later send does not duplicate prior text", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(
    { id: "routine-one", kind: "send-message", message: { type: "text", content: "First update" } },
    { id: "routine-two", kind: "send-message", message: { type: "text", content: "Second update" } },
  );
  const originalSend = harness.telegram.sendMessage;
  let failSecond = true;
  harness.telegram.sendMessage = async (chatId, text, options) => {
    if (/Second update/.test(text) && failSecond) {
      failSecond = false;
      throw new Error("Telegram unavailable");
    }
    return originalSend(chatId, text, options);
  };

  await assert.rejects(harness.bridge.pollDesktopMirrorOnce(), /Telegram unavailable/);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-one");

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.filter((message) => /First update/.test(message.text)).length, 1);
  assert.equal(harness.sent.filter((message) => /Second update/.test(message.text)).length, 1);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-two");
});

test("delivers every backlogged autonomous text entry in transcript order", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(
    { id: "routine-one", kind: "send-message", message: { type: "text", content: "First routine" } },
    { id: "routine-two", kind: "send-message", message: { type: "text", content: "Second routine" } },
  );

  await harness.bridge.pollDesktopMirrorOnce();

  assert.match(harness.sent[0].text, /First routine/);
  assert.match(harness.sent[1].text, /Second routine/);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-two");
});

test("refuses to rewind the mirror cursor when autonomous output has no entry id", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(
    { id: "routine-one", kind: "send-message", message: { type: "text", content: "First routine" } },
    { kind: "send-message", message: { type: "text", content: "Missing id" } },
  );

  await assert.rejects(harness.bridge.pollDesktopMirrorOnce(), /no transcript cursor/);

  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-one");
});

test("does not skip an unidentified autonomous entry before an identified one", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(
    { kind: "send-message", message: { type: "text", content: "Missing id first" } },
    { id: "routine-two", kind: "send-message", message: { type: "text", content: "Second routine" } },
  );

  await assert.rejects(harness.bridge.pollDesktopMirrorOnce(), /no transcript cursor/);

  assert.equal(harness.sent.length, 0);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "old");
});

test("sends the Open Grok Bot handoff for unsafe autonomous widgets", async () => {
  const harness = mirrorHarness();
  let promptCount = 0;
  harness.grok.sendPrompt = async () => { promptCount += 1; };
  const unsafeWidgets = [
    {
      id: "missing-value",
      widget: {
        prompt: "Approve today's must-win?",
        options: [{ label: "Draft follow-up" }],
      },
    },
    {
      id: "empty-prompt",
      widget: {
        prompt: "   ",
        options: [{ label: "Continue", value: "Continue" }],
      },
    },
    {
      id: "too-many-options",
      widget: {
        prompt: "Pick one",
        options: Array.from({ length: 11 }, (_, index) => ({
          label: `Option ${index + 1}`,
          value: `value-${index + 1}`,
        })),
      },
    },
  ];
  for (const { id, widget } of unsafeWidgets) {
    harness.transcripts.get("chief").push({
      id,
      kind: "send-message",
      message: { type: "widget", widget },
    });
  }

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.length, 3);
  assert.ok(harness.sent.every((message) => /Open Grok Bot/.test(message.text)));
  assert.ok(harness.sent.every((message) => message.options.inlineKeyboard === undefined));
  assert.equal(promptCount, 0);
  assert.equal(harness.state.approvals.size, 0);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "too-many-options");
});

function safeRoutineWidget(id = "routine-widget") {
  return {
    id,
    kind: "send-message",
    message: {
      type: "widget",
      widget: {
        prompt: "Approve today's must-win?",
        helpText: "Proposal-only. Nothing is sent until you choose.",
        options: [
          { label: "Draft follow-up", value: "Approve RF-1 draft follow-up" },
          { label: "Skip today", value: "Skip RF-1" },
        ],
      },
    },
  };
}

function widgetCallback(harness, data, overrides = {}) {
  return {
    callback_query: {
      id: "widget-callback",
      data,
      from: { id: 42 },
      message: {
        message_id: harness.sent.find((message) => message.options.inlineKeyboard)?.message_id ?? 1,
        chat: { id: 99, type: "private" },
      },
      ...overrides,
    },
  };
}

test("binds a safe routine widget to the mirror identity and submits the exact selected option", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(safeRoutineWidget());
  await harness.bridge.pollDesktopMirrorOnce();

  const card = harness.sent[0];
  assert.match(card.text, /Approve today's must-win/);
  assert.deepEqual(card.options.inlineKeyboard.map((row) => row[0].text), [
    "Draft follow-up",
    "Skip today",
  ]);
  const data = card.options.inlineKeyboard[0][0].callback_data;
  const token = /^gtw:([^:]+):/.exec(data)[1];
  const binding = harness.state.getApproval(token);
  assert.equal(binding.type, "routine-widget");
  assert.equal(binding.agentId, "chief");
  assert.equal(binding.entryId, "routine-widget");
  assert.equal(binding.chatId, 99);
  assert.equal(binding.userId, 42);
  assert.equal(binding.messageId, card.message_id);
  assert.equal(binding.choices[0].value, "Approve RF-1 draft follow-up");
  assert.ok(binding.expiresAt > Date.now());

  let submitted;
  harness.grok.sendPrompt = async (agentId, text, nonce) => {
    submitted = { agentId, text, nonce };
    harness.transcripts.get("chief").push({
      id: "widget-prompt",
      kind: "message",
      clientNonce: nonce,
      message: { type: "text", content: text },
    });
  };
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Draft ready for review.",
    attachments: [],
  });

  await harness.bridge.handleCallbackQuery(widgetCallback(harness, data));

  assert.deepEqual(submitted, {
    agentId: "chief",
    text: "Approve RF-1 draft follow-up",
    nonce: `telegram:widget:${token}:0`,
  });
  assert.equal(harness.callbackAnswers.at(-1).text, "Sent to Grok.");
  assert.deepEqual(harness.markupEdits.at(-1).inlineKeyboard, []);
  assert.equal(harness.sent.at(-1).text, "Draft ready for review.");
  assert.equal(harness.sent.at(-1).options.replyToMessageId, card.message_id);
  assert.equal(harness.state.getApproval(token).replyDelivered, true);
});

test("rejects a repeat widget click without sending another prompt", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(safeRoutineWidget());
  await harness.bridge.pollDesktopMirrorOnce();
  const data = harness.sent[0].options.inlineKeyboard[0][0].callback_data;
  let submissionCount = 0;
  harness.grok.sendPrompt = async (_agentId, text, nonce) => {
    submissionCount += 1;
    harness.transcripts.get("chief").push({
      id: "widget-prompt",
      kind: "message",
      clientNonce: nonce,
      message: { type: "text", content: text },
    });
  };
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Done",
    attachments: [],
  });

  await harness.bridge.handleCallbackQuery(widgetCallback(harness, data));
  await harness.bridge.handleCallbackQuery(widgetCallback(harness, data, { id: "repeat" }));

  assert.equal(submissionCount, 1);
  assert.match(harness.callbackAnswers.at(-1).text, /already used/);
});

test("rejects widget callbacks from a different user, chat, or stale message", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(safeRoutineWidget());
  await harness.bridge.pollDesktopMirrorOnce();
  const data = harness.sent[0].options.inlineKeyboard[0][0].callback_data;
  let promptCount = 0;
  harness.grok.sendPrompt = async () => { promptCount += 1; };

  for (const callback of [
    { from: { id: 7 }, message: { message_id: harness.sent[0].message_id, chat: { id: 99, type: "private" } } },
    { from: { id: 42 }, message: { message_id: harness.sent[0].message_id, chat: { id: 88, type: "private" } } },
    { from: { id: 42 }, message: { message_id: 999, chat: { id: 99, type: "private" } } },
  ]) {
    await harness.bridge.handleCallbackQuery({ callback_query: { id: "invalid", data, ...callback } });
  }

  assert.equal(promptCount, 0);
  assert.equal(harness.callbackAnswers.length, 3);
  assert.ok(harness.callbackAnswers.every((answer) => /not valid/.test(answer.text)));
});

test("expires a routine widget without sending a Grok prompt", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(safeRoutineWidget());
  await harness.bridge.pollDesktopMirrorOnce();
  const data = harness.sent[0].options.inlineKeyboard[0][0].callback_data;
  const token = /^gtw:([^:]+):/.exec(data)[1];
  harness.state.approvals.get(token).expiresAt = Date.now() - 1;
  let promptCount = 0;
  harness.grok.sendPrompt = async () => { promptCount += 1; };

  await harness.bridge.handleCallbackQuery(widgetCallback(harness, data, { id: "expired" }));

  assert.equal(promptCount, 0);
  assert.equal(harness.state.getApproval(token), undefined);
  assert.match(harness.callbackAnswers.at(-1).text, /expired/);
  assert.deepEqual(harness.markupEdits.at(-1).inlineKeyboard, []);
});

test("does not resubmit after a crash before sendPrompt", async () => {
  const harness = mirrorHarness();
  const token = "abcdefghijklmnopqrstuvwx";
  const clientNonce = `telegram:widget:${token}:0`;
  await harness.state.setApproval(token, {
    type: "routine-widget",
    agentId: "chief",
    entryId: "routine-widget",
    choices: [{ label: "Continue", value: "Continue" }],
    chatId: 99,
    userId: 42,
    messageId: 55,
    clientNonce,
    choiceIndex: 0,
    selectedValue: "Continue",
    submissionIntent: true,
    expiresAt: Date.now() + 60_000,
  });
  let submissionCount = 0;
  harness.grok.sendPrompt = async () => { submissionCount += 1; };

  await harness.bridge.handleCallbackQuery({
    callback_query: {
      id: "crash-before-send",
      data: `gtw:${token}:0`,
      from: { id: 42 },
      message: { message_id: 55, chat: { id: 99, type: "private" } },
    },
  });

  assert.equal(submissionCount, 0);
  assert.equal(harness.state.getApproval(token).submissionIntent, true);
  assert.match(harness.callbackAnswers.at(-1).text, /will not be sent twice/);
});

test("reconciles a crash after accept before persist without resubmitting", async () => {
  const harness = mirrorHarness();
  const token = "abcdefghijklmnopqrstuvwx";
  const clientNonce = `telegram:widget:${token}:0`;
  await harness.state.setApproval(token, {
    type: "routine-widget",
    agentId: "chief",
    entryId: "routine-widget",
    choices: [{ label: "Continue", value: "Continue" }],
    chatId: 99,
    userId: 42,
    messageId: 55,
    clientNonce,
    choiceIndex: 0,
    selectedValue: "Continue",
    submissionIntent: true,
    expiresAt: Date.now() + 60_000,
  });
  harness.transcripts.get("chief").push({
    id: "widget-prompt",
    kind: "message",
    clientNonce,
    message: { type: "text", content: "Continue" },
  });
  let submissionCount = 0;
  harness.grok.sendPrompt = async () => { submissionCount += 1; };
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Recovered without resubmitting",
    attachments: [],
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(submissionCount, 0);
  assert.equal(harness.state.getApproval(token).submitted, true);
  assert.equal(harness.sent.at(-1).text, "Recovered without resubmitting");
  assert.equal(harness.sent.at(-1).options.replyToMessageId, 55);
  assert.equal(harness.state.getApproval(token).replyDelivered, true);
});

test("resumes only widget reply delivery after restart", async () => {
  const harness = mirrorHarness();
  const token = "abcdefghijklmnopqrstuvwx";
  const clientNonce = `telegram:widget:${token}:0`;
  await harness.state.setApproval(token, {
    type: "routine-widget",
    agentId: "chief",
    entryId: "routine-widget",
    choices: [{ label: "Continue", value: "Continue" }],
    chatId: 99,
    userId: 42,
    messageId: 55,
    clientNonce,
    choiceIndex: 0,
    selectedValue: "Continue",
    submissionIntent: true,
    submitted: true,
    accepted: true,
    expiresAt: Date.now() + 60_000,
  });
  harness.transcripts.get("chief").push({
    id: "widget-prompt",
    kind: "message",
    clientNonce,
    message: { type: "text", content: "Continue" },
  });
  let submissionCount = 0;
  harness.grok.sendPrompt = async () => { submissionCount += 1; };
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Restarted reply",
    attachments: [],
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(submissionCount, 0);
  assert.equal(harness.sent.at(-1).text, "Restarted reply");
  assert.equal(harness.sent.at(-1).options.replyToMessageId, 55);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "widget-reply");
});

test("recovers a prior-agent widget after /use without resubmitting", async () => {
  const harness = mirrorHarness();
  const token = "abcdefghijklmnopqrstuvwx";
  const clientNonce = `telegram:widget:${token}:0`;
  await harness.state.setApproval(token, {
    type: "routine-widget",
    agentId: "chief",
    entryId: "routine-widget",
    choices: [{ label: "Continue", value: "Continue" }],
    chatId: 99,
    userId: 42,
    messageId: 55,
    clientNonce,
    choiceIndex: 0,
    selectedValue: "Continue",
    submissionIntent: true,
    submitted: true,
    accepted: true,
    expiresAt: Date.now() + 60_000,
  });
  harness.transcripts.get("chief").push({
    id: "widget-prompt",
    kind: "message",
    clientNonce,
    message: { type: "text", content: "Continue" },
  });
  harness.transcripts.set("research", [
    { id: "research-old", kind: "send-message", message: { type: "text", content: "Research history" } },
  ]);
  let submissionCount = 0;
  harness.grok.sendPrompt = async () => { submissionCount += 1; };
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Recovered after agent switch",
    attachments: [],
  });

  await harness.bridge.handleUpdate(command("/use Research"));
  assert.equal(harness.state.getAgent(99), "research");
  assert.equal(harness.state.getMirrorCursor("research").entryId, "research-old");
  harness.sent.length = 0;
  harness.transcripts.get("research").push({
    id: "research-new",
    kind: "send-message",
    message: { type: "text", content: "New research routine" },
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(submissionCount, 0);
  assert.equal(harness.state.getApproval(token).submitted, true);
  assert.equal(harness.state.getApproval(token).accepted, true);
  assert.equal(harness.state.getApproval(token).replyDelivered, true);
  const recoveredAt = harness.sent.findIndex((message) => message.text === "Recovered after agent switch");
  const researchAt = harness.sent.findIndex((message) => /New research routine/.test(message.text));
  assert.ok(recoveredAt >= 0);
  assert.ok(researchAt > recoveredAt);
  assert.equal(harness.sent[recoveredAt].options.replyToMessageId, 55);
  assert.equal(harness.sent.filter((message) => /Research history/.test(message.text)).length, 0);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "widget-reply");
  assert.equal(harness.state.getMirrorCursor("research").entryId, "research-new");
});

test("does not let a widget choice jump over intervening autonomous output", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(safeRoutineWidget());
  await harness.bridge.pollDesktopMirrorOnce();
  const data = harness.sent[0].options.inlineKeyboard[0][0].callback_data;
  harness.grok.sendPrompt = async (_agentId, text, nonce) => {
    harness.transcripts.get("chief").push(
      { id: "intervening-routine", kind: "send-message", message: { type: "text", content: "Intervening routine" } },
      { id: "widget-prompt", kind: "message", clientNonce: nonce, message: { type: "text", content: text } },
    );
  };
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Choice reply",
    attachments: [],
  });

  await harness.bridge.handleCallbackQuery(widgetCallback(harness, data, { id: "choice" }));

  const texts = harness.sent.map((message) => message.text);
  const interveningAt = texts.findIndex((text) => /Intervening routine/.test(text));
  const replyAt = texts.findIndex((text) => text === "Choice reply");
  assert.ok(interveningAt >= 0);
  assert.ok(replyAt > interveningAt);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "widget-reply");
});

test("serializes concurrent widget callbacks so a choice is submitted once", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(safeRoutineWidget());
  await harness.bridge.pollDesktopMirrorOnce();
  const data = harness.sent[0].options.inlineKeyboard[0][0].callback_data;
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  let submissionCount = 0;
  harness.grok.sendPrompt = async (_agentId, text, nonce) => {
    submissionCount += 1;
    await sendGate;
    harness.transcripts.get("chief").push({
      id: `widget-prompt-${submissionCount}`,
      kind: "message",
      clientNonce: nonce,
      message: { type: "text", content: text },
    });
  };
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "One reply",
    attachments: [],
  });

  const first = harness.bridge.handleCallbackQuery(widgetCallback(harness, data, { id: "first" }));
  const second = harness.bridge.handleCallbackQuery(widgetCallback(harness, data, { id: "second" }));
  await Promise.resolve();
  releaseSend();
  await Promise.all([first, second]);

  assert.equal(submissionCount, 1);
  assert.equal(harness.sent.filter((message) => message.text === "One reply").length, 1);
});

test("does not resurrect a completed widget prompt context on later mirror polls", async () => {
  const harness = mirrorHarness();
  const token = "abcdefghijklmnopqrstuvwx";
  const clientNonce = `telegram:widget:${token}:0`;
  await harness.state.setApproval(token, {
    type: "routine-widget",
    agentId: "chief",
    entryId: "routine-widget",
    choices: [{ label: "Continue", value: "Continue" }],
    chatId: 99,
    userId: 42,
    messageId: 55,
    clientNonce,
    choiceIndex: 0,
    selectedValue: "Continue",
    submissionIntent: true,
    submitted: true,
    accepted: true,
    replyDelivered: true,
    expiresAt: Date.now() + 60_000,
  });
  harness.transcripts.get("chief").push(
    {
      id: "t141u",
      kind: "message",
      clientNonce,
      message: { type: "text", content: "Continue" },
    },
    { id: "t141s0", kind: "send-message", message: { type: "text", content: "First reply" } },
    { id: "t141s1", kind: "send-message", message: { type: "text", content: "Second reply" } },
    { id: "t141s2", kind: "send-message", message: { type: "text", content: "Third reply" } },
  );
  await harness.state.setMirrorCursor("chief", "t141s2");
  let submissionCount = 0;
  harness.grok.sendPrompt = async () => { submissionCount += 1; };
  harness.grok.waitForReply = async () => ({
    messageId: "t141s2",
    text: "Should not wait again",
    attachments: [],
  });

  await harness.bridge.pollDesktopMirrorOnce();
  await harness.bridge.pollDesktopMirrorOnce();
  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(submissionCount, 0);
  assert.equal(harness.state.getPromptContext("chief", clientNonce), undefined);
  assert.equal(harness.state.listPromptContexts("chief").length, 0);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "t141s2");
  assert.equal(harness.state.getApproval(token).replyDelivered, true);
  assert.equal(harness.state.getApproval(token).submissionIntent, true);
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

test("ignores internal multi-agent messages before the next desktop prompt", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(
    {
      id: "dispatch",
      kind: "message",
      role: "assistant",
      toAgent: "research",
      content: "Internal delegation",
    },
    {
      id: "child-reply",
      kind: "message",
      role: "user",
      fromAgent: "research",
      content: "Internal result",
    },
    {
      id: "desktop-prompt",
      kind: "message",
      role: "user",
      clientNonce: "desktop:after-agents",
      content: "Real desktop prompt",
    },
    {
      id: "nested-dispatch",
      kind: "message",
      role: "assistant",
      toAgent: "research",
      content: "Nested internal task",
    },
    {
      id: "nested-result",
      kind: "message",
      role: "user",
      fromAgent: "research",
      content: "Nested internal result",
    },
    {
      id: "desktop-final",
      kind: "send-message",
      message: { type: "text", content: "Consolidated desktop answer" },
    },
  );
  const realGrok = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    pollIntervalMs: 1,
    replyTimeoutMs: 100,
  });
  let agentChecks = 0;
  realGrok.listAgents = async () => {
    agentChecks += 1;
    return harness.agents.map((agent) => ({
      ...agent,
      isRunning: agent.id === "chief" && agentChecks === 2,
    }));
  };
  realGrok.getTranscriptTail = harness.grok.getTranscriptTail;
  realGrok.getTranscript = harness.grok.getTranscript;
  harness.bridge.grok = realGrok;

  await harness.bridge.pollDesktopMirrorOnce();

  assert.match(harness.sent[0].text, /Real desktop prompt/);
  assert.doesNotMatch(harness.sent[0].text, /Internal/);
  assert.equal(harness.sent[1].text, "Consolidated desktop answer");
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "desktop-final");
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

test("does not persist a start-from-beginning cursor when the first watch is empty", async () => {
  const transcripts = new Map([["chief", []]]);
  const harness = mirrorHarness({ transcripts, cursors: [] });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.state.getMirrorCursor("chief"), undefined);
  assert.deepEqual(harness.sent, []);

  harness.transcripts.get("chief").push(
    { id: "historical-prompt", kind: "message", message: { type: "text", content: "Old prompt" } },
    { id: "historical-final", kind: "send-message", message: { type: "text", content: "Old answer" } },
  );
  await harness.bridge.pollDesktopMirrorOnce();

  assert.deepEqual(harness.sent, []);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "historical-final");
});

test("delivers autonomous output created after startup while the first watch waits for idle", async () => {
  const transcripts = new Map([["chief", [
    { id: "historical-prompt", kind: "message", message: { type: "text", content: "Old prompt" } },
    { id: "historical-final", kind: "send-message", message: { type: "text", content: "Old answer" } },
  ]]]);
  const harness = mirrorHarness({ transcripts, cursors: [] });
  harness.agents[0].isRunning = true;
  harness.grok.isAgentBusy = async () => harness.agents[0].isRunning === true;

  await harness.bridge.pollDesktopMirrorOnce();
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.state.getMirrorCursor("chief"), undefined);

  harness.transcripts.get("chief").push({
    id: "post-start-routine",
    kind: "send-message",
    message: { type: "text", content: "Morning brief after wake" },
  });
  harness.agents[0].isRunning = false;

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Morning brief after wake/);
  assert.doesNotMatch(harness.sent[0].text, /Old answer/);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "post-start-routine");
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

test("delivers a Telegram reply once before separately mirroring scheduled output", async () => {
  const harness = mirrorHarness();
  harness.grok.sendPrompt = async (_agentId, _text, nonce) => {
    harness.transcripts.get("chief").push({
      id: "telegram-prompt",
      kind: "message",
      clientNonce: nonce,
      message: { type: "text", content: "Do not mirror" },
    });
  };
  harness.grok.waitForReply = async () => {
    if (!harness.transcripts.get("chief").some((entry) => entry.id === "telegram-reply")) {
      harness.transcripts.get("chief").push({
        id: "telegram-reply",
        kind: "send-message",
        message: { type: "text", content: "Telegram response" },
      });
    }
    return { messageId: "telegram-reply", text: "Telegram response", attachments: [] };
  };

  await harness.bridge.handleUpdate(command("Telegram question"));

  assert.equal(harness.sent.filter(({ text }) => text === "Telegram response").length, 1);
  assert.equal(harness.sent.at(-1).options.replyToMessageId, 10);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "telegram-reply");
  harness.transcripts.get("chief").push({
    id: "scheduled-output",
    kind: "send-message",
    message: { type: "text", content: "Scheduled output" },
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.filter(({ text }) => text === "Telegram response").length, 1);
  assert.equal(harness.sent.filter(({ text }) => /Scheduled output/.test(text)).length, 1);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "scheduled-output");
});

test("delivers authorized Telegram replies without an active desktop watcher", async () => {
  for (const bridgeOptions of [{ configured: false }, { enabled: false }]) {
    const harness = mirrorHarness(bridgeOptions);
    harness.grok.sendPrompt = async (_agentId, text, clientNonce) => {
      harness.transcripts.get("chief").push(
        { id: "telegram-prompt", kind: "message", clientNonce, message: { type: "text", content: text } },
        { id: "telegram-reply", kind: "send-message", message: { type: "text", content: "Direct reply" } },
      );
    };
    harness.grok.waitForReply = async () => ({
      messageId: "telegram-reply",
      text: "Direct reply",
      attachments: [],
    });

    await harness.bridge.handleUpdate(command("Question"));

    assert.equal(harness.sent.at(-1).text, "Direct reply");
    assert.equal(harness.sent.at(-1).chatId, 99);
    assert.equal(harness.sent.at(-1).options.replyToMessageId, 10);
  }
});

test("serializes prompt delivery between Telegram handling and mirror polling", async () => {
  const harness = mirrorHarness();
  let finishReply;
  let replyWaitStarted;
  const replyWait = new Promise((resolve) => { finishReply = resolve; });
  const waitStarted = new Promise((resolve) => { replyWaitStarted = resolve; });
  harness.grok.sendPrompt = async (_agentId, _text, clientNonce) => {
    harness.transcripts.get("chief").push(
      { id: "telegram-prompt", kind: "message", clientNonce, message: { type: "text", content: "Question" } },
      { id: "telegram-reply", kind: "send-message", message: { type: "text", content: "One reply" } },
    );
  };
  harness.grok.waitForReply = async () => {
    replyWaitStarted();
    await replyWait;
    return { messageId: "telegram-reply", text: "One reply", attachments: [] };
  };
  let releaseSend;
  let sendStarted;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const sending = new Promise((resolve) => { sendStarted = resolve; });
  const originalSend = harness.telegram.sendMessage;
  harness.telegram.sendMessage = async (...args) => {
    sendStarted();
    await sendGate;
    return originalSend(...args);
  };

  const handling = harness.bridge.handleUpdate(command("Question"));
  await waitStarted;
  await harness.bridge.pollDesktopMirrorOnce();
  assert.deepEqual(harness.sent, []);
  finishReply();
  await sending;
  const delivery = [...harness.state.deliveries.values()][0];
  assert.equal(delivery.claimed, true);
  const firstPoll = harness.bridge.pollDesktopMirrorOnce();
  const concurrentPoll = harness.bridge.pollDesktopMirrorOnce();
  releaseSend();
  await Promise.all([handling, firstPoll, concurrentPoll]);

  assert.equal(harness.sent.filter(({ text }) => text === "One reply").length, 1);
  assert.equal(harness.sent[0].options.replyToMessageId, 10);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "telegram-reply");
});

test("routes ambiguous prompt output only to the configured mirror", async () => {
  const harness = mirrorHarness();
  const clientNonce = "telegram:2:88:20";
  harness.state.promptContexts.set(`chief:${clientNonce}`, {
    origin: "telegram",
    chatId: 88,
    replyToMessageId: 20,
  });
  harness.transcripts.get("chief").push(
    { id: "other-chat-prompt", kind: "message", clientNonce, message: { type: "text", content: "Question" } },
    { id: "ambiguous-update", kind: "send-message", message: { type: "text", content: "Private update" } },
  );

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].chatId, 99);
  assert.match(harness.sent[0].text, /^Grok update/);
  assert.equal(harness.sent[0].options.replyToMessageId, undefined);
});
