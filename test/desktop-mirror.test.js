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
    getDeliveryProgress(key) { return this.deliveries.get(key); },
    async setDeliveryProgress(key, progress) { this.deliveries.set(key, { ...progress }); },
    async deleteDeliveryProgress(key) { this.deliveries.delete(key); },
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

test("mirrors autonomous routine output and sends its selected action back to Grok", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(
    {
      id: "routine-text",
      kind: "send-message",
      message: { type: "text", content: "Morning revenue proposal" },
    },
    {
      id: "routine-widget",
      kind: "send-message",
      message: {
        type: "widget",
        widget: {
          prompt: "Approve today's must-win?",
          helpText: "Proposal-only. Nothing is sent until you choose.",
          options: [
            { label: "Draft follow-up", value: "Approve RF-1 draft follow-up", style: "primary" },
            { label: "Skip today", value: "Skip RF-1", style: "danger" },
          ],
        },
      },
    },
  );

  await harness.bridge.pollDesktopMirrorOnce();

  assert.match(harness.sent[0].text, /Morning revenue proposal/);
  assert.match(harness.sent[1].text, /Approve today's must-win/);
  assert.deepEqual(
    harness.sent[1].options.inlineKeyboard.map((row) => row[0].text),
    ["Draft follow-up", "Skip today"],
  );
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-widget");

  let submitted;
  let submissionCount = 0;
  harness.grok.sendPrompt = async (agentId, text, nonce) => {
    submissionCount += 1;
    submitted = { agentId, text, nonce };
  };
  harness.grok.waitForReply = async () => ({
    messageId: "routine-choice-reply",
    text: "Draft ready for review.",
    attachments: [],
  });
  const callbackData = harness.sent[1].options.inlineKeyboard[0][0].callback_data;

  await harness.bridge.handleCallbackQuery({ callback_query: {
    id: "routine-callback",
    data: callbackData,
    from: { id: 42 },
    message: { message_id: harness.sent[1].message_id, chat: { id: 99, type: "private" } },
  } });

  assert.equal(submitted.agentId, "chief");
  assert.equal(submitted.text, "Approve RF-1 draft follow-up");
  assert.match(submitted.nonce, /^telegram:widget:/);
  assert.equal(harness.callbackAnswers.at(-1).text, "Sent to Grok.");
  assert.deepEqual(harness.markupEdits.at(-1).inlineKeyboard, []);
  assert.equal(harness.sent.at(-1).text, "Draft ready for review.");
  assert.equal(harness.sent.at(-1).options.replyToMessageId, harness.sent[1].message_id);
  assert.equal(harness.state.approvals.size, 0);

  await harness.bridge.handleCallbackQuery({ callback_query: {
    id: "routine-replay",
    data: callbackData,
    from: { id: 42 },
    message: { message_id: harness.sent[1].message_id, chat: { id: 99, type: "private" } },
  } });
  assert.equal(submissionCount, 1);
  assert.match(harness.callbackAnswers.at(-1).text, /not valid/);
});

test("checkpoints each autonomous entry so a failed widget retry does not duplicate prior text", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push(
    { id: "routine-text", kind: "send-message", message: { type: "text", content: "First update" } },
    {
      id: "routine-widget",
      kind: "send-message",
      message: { type: "widget", widget: {
        prompt: "Choose",
        options: [{ label: "Continue", value: "Continue" }],
      } },
    },
  );
  const originalSend = harness.telegram.sendMessage;
  let failWidget = true;
  harness.telegram.sendMessage = async (chatId, text, options) => {
    if (text === "Choose" && failWidget) {
      failWidget = false;
      throw new Error("Telegram unavailable");
    }
    return originalSend(chatId, text, options);
  };

  await assert.rejects(harness.bridge.pollDesktopMirrorOnce(), /Telegram unavailable/);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-text");

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.filter((message) => /First update/.test(message.text)).length, 1);
  assert.equal(harness.sent.filter((message) => message.text === "Choose").length, 1);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-widget");
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

test("sends a desktop handoff when a routine widget is too large for Telegram", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "large-widget",
    kind: "send-message",
    message: { type: "widget", widget: {
      prompt: "x".repeat(3_501),
      options: [{ label: "Continue", value: "Continue" }],
    } },
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.match(harness.sent[0].text, /cannot be displayed safely/);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "large-widget");
});

test("rejects routine widget callbacks outside their bound user, chat, and message", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "routine-widget",
    kind: "send-message",
    message: { type: "widget", widget: {
      prompt: "Choose",
      options: [{ label: "Continue", value: "Continue" }],
    } },
  });
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

test("expires routine widget callbacks without sending a Grok prompt", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "routine-widget",
    kind: "send-message",
    message: { type: "widget", widget: {
      prompt: "Choose",
      options: [{ label: "Continue", value: "Continue" }],
    } },
  });
  await harness.bridge.pollDesktopMirrorOnce();
  const data = harness.sent[0].options.inlineKeyboard[0][0].callback_data;
  const token = /^gtw:([^:]+):/.exec(data)[1];
  harness.state.approvals.get(token).expiresAt = Date.now() - 1;
  let promptCount = 0;
  harness.grok.sendPrompt = async () => { promptCount += 1; };

  await harness.bridge.handleCallbackQuery({ callback_query: {
    id: "expired",
    data,
    from: { id: 42 },
    message: { message_id: harness.sent[0].message_id, chat: { id: 99, type: "private" } },
  } });

  assert.equal(promptCount, 0);
  assert.equal(harness.state.approvals.has(token), false);
  assert.equal(harness.callbackAnswers.at(-1).text, "This option expired.");
  assert.deepEqual(harness.markupEdits.at(-1).inlineKeyboard, []);
});

test("recovers a submitted routine widget reply through the desktop mirror", async () => {
  const harness = mirrorHarness();
  const clientNonce = "telegram:widget:abcdefghijklmnopqrstuvwx:0";
  harness.state.approvals.set("abcdefghijklmnopqrstuvwx", {
    type: "routine-widget",
    agentId: "chief",
    entryId: "routine-widget",
    chatId: 99,
    userId: 42,
    messageId: 55,
    clientNonce,
    submissionIntent: true,
    submitted: true,
    resolving: false,
    expiresAt: Date.now() + 60_000,
  });
  harness.transcripts.get("chief").push({
    id: "widget-prompt",
    kind: "message",
    clientNonce,
    message: { type: "text", content: "Continue" },
  });
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Recovered reply",
    attachments: [],
  });

  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.at(-1).text, "Recovered reply");
  assert.equal(harness.sent.at(-1).options.replyToMessageId, 55);
  assert.equal(harness.state.approvals.size, 0);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "widget-reply");
});

test("reconciles a durable widget submission intent before allowing resubmission", async () => {
  const harness = mirrorHarness();
  const token = "abcdefghijklmnopqrstuvwx";
  const clientNonce = `telegram:widget:${token}:0`;
  harness.state.approvals.set(token, {
    type: "routine-widget",
    agentId: "chief",
    entryId: "routine-widget",
    choices: [{ label: "Continue", value: "Continue" }],
    chatId: 99,
    userId: 42,
    messageId: 55,
    clientNonce,
    choiceIndex: 0,
    submissionIntent: true,
    resolving: false,
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

  await harness.bridge.handleCallbackQuery({ callback_query: {
    id: "recovered-callback",
    data: `gtw:${token}:0`,
    from: { id: 42 },
    message: { message_id: 55, chat: { id: 99, type: "private" } },
  } });

  assert.equal(submissionCount, 0);
  assert.equal(harness.sent.at(-1).text, "Recovered without resubmitting");
  assert.equal(harness.state.approvals.size, 0);
});

test("keeps cursor advancement in ordered mirror processing after a widget choice", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "routine-widget",
    kind: "send-message",
    message: { type: "widget", widget: {
      prompt: "Choose",
      options: [{ label: "Continue", value: "Continue" }],
    } },
  });
  await harness.bridge.pollDesktopMirrorOnce();
  const callbackData = harness.sent[0].options.inlineKeyboard[0][0].callback_data;
  const clientNonce = callbackData.replace(/^gtw:/, "telegram:widget:");
  harness.grok.sendPrompt = async () => {
    harness.transcripts.get("chief").push(
      { id: "intervening-routine", kind: "send-message", message: { type: "text", content: "Intervening routine" } },
      { id: "widget-prompt", kind: "message", clientNonce, message: { type: "text", content: "Continue" } },
    );
  };
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Choice reply",
    attachments: [],
  });

  await harness.bridge.handleCallbackQuery({ callback_query: {
    id: "choice",
    data: callbackData,
    from: { id: 42 },
    message: { message_id: harness.sent[0].message_id, chat: { id: 99, type: "private" } },
  } });

  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-widget");
  await harness.bridge.pollDesktopMirrorOnce();
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "intervening-routine");
  assert.equal(harness.sent.filter(({ text }) => /Intervening routine/.test(text)).length, 1);
  await harness.bridge.pollDesktopMirrorOnce();
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "widget-reply");
});

test("retries only undelivered autonomous multipart parts", async () => {
  const harness = mirrorHarness();
  harness.transcripts.get("chief").push({
    id: "routine-multipart",
    kind: "send-message",
    message: {
      type: "text",
      content: "Routine report",
      images: [
        { url: "/output/one.png" },
        { url: "/output/two.png" },
      ],
    },
  });
  const originalSendAttachment = harness.telegram.sendAttachment;
  let attachmentAttempts = 0;
  harness.telegram.sendAttachment = async (...args) => {
    attachmentAttempts += 1;
    if (attachmentAttempts === 2) throw new Error("Telegram attachment failed");
    return originalSendAttachment(...args);
  };

  await assert.rejects(harness.bridge.pollDesktopMirrorOnce(), /attachment failed/);
  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.filter(({ text }) => /Routine report/.test(text)).length, 1);
  assert.deepEqual(harness.attachments.map(({ attachment }) => attachment.filename), ["one.png", "two.png"]);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "routine-multipart");
  assert.equal(harness.state.deliveries.size, 0);
});

test("retries only undelivered recovered widget reply parts", async () => {
  const harness = mirrorHarness();
  const token = "abcdefghijklmnopqrstuvwx";
  const clientNonce = `telegram:widget:${token}:0`;
  harness.state.approvals.set(token, {
    type: "routine-widget",
    agentId: "chief",
    entryId: "routine-widget",
    chatId: 99,
    userId: 42,
    messageId: 55,
    clientNonce,
    submissionIntent: true,
    submitted: true,
    resolving: false,
    expiresAt: Date.now() + 60_000,
  });
  harness.transcripts.get("chief").push({
    id: "widget-prompt",
    kind: "message",
    clientNonce,
    message: { type: "text", content: "Continue" },
  });
  harness.grok.waitForReply = async () => ({
    messageId: "widget-reply",
    text: "Widget report",
    attachments: [
      { path: "/output/one.png", filename: "one.png" },
      { path: "/output/two.png", filename: "two.png" },
    ],
  });
  const originalSendAttachment = harness.telegram.sendAttachment;
  let attachmentAttempts = 0;
  harness.telegram.sendAttachment = async (...args) => {
    attachmentAttempts += 1;
    if (attachmentAttempts === 2) throw new Error("Telegram attachment failed");
    return originalSendAttachment(...args);
  };

  await assert.rejects(harness.bridge.pollDesktopMirrorOnce(), /attachment failed/);
  assert.equal(harness.sent.filter(({ text }) => text === "Widget report").length, 1);
  harness.state.approvals.get(token).resolving = false;
  await harness.bridge.pollDesktopMirrorOnce();

  assert.equal(harness.sent.filter(({ text }) => text === "Widget report").length, 1);
  assert.deepEqual(harness.attachments.map(({ attachment }) => attachment.filename), ["one.png", "two.png"]);
  assert.equal(harness.state.getMirrorCursor("chief").entryId, "widget-reply");
  assert.equal(harness.state.deliveries.size, 0);
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
