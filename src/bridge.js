import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isTopLevelPromptEntry } from "./grok-client.js";
import { buildRichText, findStructuredReferences } from "./grok-rich-text.js";

const HELP = [
  "Send text, photos, or file attachments to your selected Grok agent.",
  "",
  "/agents - list agents",
  "/use <exact name> - select an agent",
  "/status - show the selected agent",
  "/mirror status|on|off - control configured desktop mirroring",
  "/skills - list the selected agent's live skills",
  "/run <exact skill> [request] - run a skill",
  "/routines - list routines available to @ mention",
  "/mentions - list structured @ references",
  "/plugins - list box plugin connection status",
  "/settings - explain desktop-only settings actions",
  "/commands - show this help",
  "/help - show this help",
  "",
  "Telegram attachments are limited to 20 MB. Supported approvals offer only Approve once or Deny.",
  "Telegram-safe routine choice cards are one-time actions and expire in 12 hours.",
].join("\n");

const APPROVAL_TTL_MS = 10 * 60_000;
const ROUTINE_WIDGET_TTL_MS = 12 * 60 * 60_000;
const APPROVAL_TEXT_LIMIT = 3_500;
const SKILL_LIST_LIMIT = 20;
const ROUTINE_WIDGET_CALLBACK = /^gtw:([A-Za-z0-9_-]{24}):([0-9a-z])$/;
const ROUTINE_WIDGET_NONCE = /^telegram:widget:([A-Za-z0-9_-]{24}):[0-9a-z]$/;

function approvalDetails(entry) {
  if (entry?.message?.type === "auto-review-approval") {
    const approval = entry.message.approval;
    return {
      type: "auto-review",
      requestId: approval.requestId,
      title: "Grok approval required",
      fields: [
        ["Action", approval.summary],
        ["Command", approval.command],
        ["Reason", approval.reason],
        ["Proposed rule", approval.proposedRule],
        ["Surface", approval.surface],
      ],
    };
  }
  if (entry?.message?.type === "local-tool-permission") {
    const ask = entry.message.ask;
    return {
      type: "local-tool",
      requestId: ask.requestId,
      title: "Local computer permission required",
      fields: [
        ["Action", ask.action],
        ["Target", ask.target],
        ["Description", ask.description],
      ],
    };
  }
  return undefined;
}

function telegramSafeRoutineWidget(entry) {
  if (entry?.kind !== "send-message" || entry.message?.type !== "widget") return undefined;
  const widget = entry.message.widget;
  if (!widget || typeof widget.prompt !== "string" || !widget.prompt.trim()) return undefined;
  if (!Array.isArray(widget.options) || widget.options.length < 1 || widget.options.length > 10) {
    return undefined;
  }
  const choices = [];
  for (const option of widget.options) {
    if (typeof option?.label !== "string" || !option.label.trim()) return undefined;
    if (typeof option?.value !== "string" || !option.value.trim()) return undefined;
    choices.push({
      label: option.label.trim().slice(0, 64),
      value: option.value,
    });
  }
  const helpText = typeof widget.helpText === "string" ? widget.helpText.trim() : "";
  const text = [widget.prompt.trim(), helpText].filter(Boolean).join("\n\n");
  if (!text || text.length > APPROVAL_TEXT_LIMIT) return undefined;
  return { text, choices };
}

function routineWidgetNonce(token, choiceIndex) {
  return `telegram:widget:${token}:${choiceIndex.toString(36)}`;
}

function formatApproval(details) {
  const lines = [`⚠️ ${details.title}`, ""];
  for (const [label, value] of details.fields) {
    if (value === undefined || value === null || value === "") continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`${label}:`, rendered, "");
  }
  lines.push("This authorization applies to this request only and expires in 10 minutes.");
  return lines.join("\n");
}

function newestTranscriptEntryId(entries) {
  return [...entries].reverse().find((entry) => typeof entry?.id === "string" && entry.id)?.id;
}

function messageAttachments(message) {
  const attachments = [];
  const largestPhoto = message.photo?.at(-1);
  if (largestPhoto?.file_id) {
    attachments.push({ fileId: largestPhoto.file_id, filename: `telegram-photo-${message.message_id ?? "upload"}.jpg` });
  }
  for (const [kind, fallback] of [
    ["document", "telegram-file.bin"],
    ["audio", "telegram-audio.bin"],
    ["voice", "telegram-voice.ogg"],
    ["video", "telegram-video.mp4"],
  ]) {
    const media = message[kind];
    if (media?.file_id) attachments.push({ fileId: media.file_id, filename: media.file_name || fallback });
  }
  return attachments;
}

function defaultAttachmentPrompt(message) {
  if (message.voice) return "Transcribe this voice note accurately, then respond to what I said. Do not send progress updates. Send exactly one final response beginning with 'Transcript:'.";
  if (message.audio) return "Listen to this audio, summarize or transcribe it as appropriate, then respond.";
  if (message.photo) return "Examine the attached image and tell me what you find.";
  return "Examine the attached file and tell me what you find.";
}

function normalize(value) {
  return value.trim().toLocaleLowerCase();
}

function availableWorkflows(workflows) {
  return workflows.filter((workflow) => workflow?.id && workflow?.name
    && (workflow.source === "automation" || workflow.isEnabledForAgent === true));
}

function splitWorkflows(workflows) {
  const available = availableWorkflows(workflows);
  return {
    skills: available.filter((workflow) => workflow.trigger == null),
    routines: available.filter((workflow) => workflow.trigger != null),
  };
}

function matchSkillInvocation(argumentsText, skills) {
  const normalized = normalize(argumentsText);
  return [...skills]
    .sort((left, right) => right.name.length - left.name.length)
    .find((skill) => normalized === normalize(skill.name)
      || normalized.startsWith(`${normalize(skill.name)} `));
}

function workflowReference(workflow) {
  return {
    type: "workflowReference",
    id: workflow.id,
    label: workflow.name,
    iconId: workflow.iconId ?? workflow.icon?.iconId,
    iconUrl: workflow.iconUrl ?? workflow.icon?.iconUrl,
  };
}

function workflowPrompt(skill, argumentsText) {
  const request = argumentsText.slice(skill.name.length).trim();
  return `@${skill.name}${request ? ` ${request}` : ""}`;
}

function routineDescription(routine) {
  return routine.scheduleDescription ?? routine.trigger?.schedule ?? "triggered routine";
}

export class Bridge {
  constructor({
    telegram,
    grok,
    state,
    allowedUserIds,
    allowedChatIds,
    defaultAgent,
    mirrorChatId,
    mirrorUserId,
  }) {
    Object.assign(this, {
      telegram,
      grok,
      state,
      allowedUserIds,
      allowedChatIds,
      defaultAgent,
      mirrorChatId,
      mirrorUserId,
    });
    this.firstWatchSnapshots = new Map();
    this.agentMirrorQueues = new Map();
    this.widgetCallbackQueues = new Map();
  }

  isAuthorized(message) {
    return message?.chat?.type === "private"
      && this.allowedUserIds.has(message?.from?.id)
      && this.allowedChatIds.has(message?.chat?.id);
  }

  isAuthorizedCallback(callback) {
    return this.isAuthorized({ chat: callback?.message?.chat, from: callback?.from });
  }

  resolveAgent(chatId, agents) {
    const selectedId = this.state.getAgent(chatId);
    if (selectedId) {
      const selected = agents.find((agent) => agent.id === selectedId);
      if (selected) return selected;
      return undefined;
    }
    return agents.find((agent) => normalize(agent.name) === normalize(this.defaultAgent));
  }

  isMirrorConfigured() {
    return this.mirrorChatId !== undefined && this.mirrorUserId !== undefined;
  }

  isMirrorController(message) {
    return this.isMirrorConfigured()
      && message?.chat?.id === this.mirrorChatId
      && message?.from?.id === this.mirrorUserId;
  }

  mirrorEnabled() {
    return this.state.isMirrorEnabled(this.isMirrorConfigured());
  }

  async getTranscriptEntries(agentId, options = {}) {
    try {
      return await this.grok.getTranscriptTail(agentId, 200, options);
    } catch (error) {
      if (!/HTTP 404$/.test(error.message)) throw error;
      return this.grok.getTranscript(agentId, options);
    }
  }

  async mirrorAgentBusy(agentId, options = {}) {
    if (options.agent?.isRunning === true || options.agent?.isComposingMessage === true) return true;
    return typeof this.grok.isAgentBusy === "function"
      ? this.grok.isAgentBusy(agentId, options)
      : false;
  }

  async ensureMirrorBaseline(agentId, options = {}) {
    if (!options.force && this.state.getMirrorCursor(agentId)) return false;
    let entries = await this.getTranscriptEntries(agentId, options);
    if (!entries.length && !options.force) {
      entries = await this.grok.getTranscript(agentId, options);
    }
    const newestId = newestTranscriptEntryId(entries);
    if (!options.force && !entries.length) return true;
    if (!options.force && await this.mirrorAgentBusy(agentId, options)) {
      if (!this.firstWatchSnapshots.has(agentId)) {
        this.firstWatchSnapshots.set(agentId, newestId ?? null);
      }
      return true;
    }
    const snapshot = this.firstWatchSnapshots.get(agentId);
    this.firstWatchSnapshots.delete(agentId);
    if (snapshot !== undefined) {
      await this.state.setMirrorCursor(agentId, snapshot);
      return false;
    }
    await this.state.setMirrorCursor(agentId, newestId);
    return true;
  }

  async handleMirrorCommand(message, argument, options = {}) {
    if (!this.isMirrorConfigured()) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Desktop mirroring is not configured. Set both GROK_DESKTOP_MIRROR_CHAT_ID and GROK_DESKTOP_MIRROR_USER_ID in .env, then restart the bridge.",
        options,
      );
      return;
    }
    if (!this.isMirrorController(message)) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Only the configured desktop-mirror user in the configured mirror chat can control mirroring.",
        options,
      );
      return;
    }
    const action = argument.toLocaleLowerCase();
    if (!action || action === "status") {
      await this.telegram.sendMessage(
        message.chat.id,
        `Desktop mirroring is ${this.mirrorEnabled() ? "on" : "off"}.`,
        options,
      );
      return;
    }
    if (action === "off") {
      await this.state.setMirrorEnabled(false);
      await this.telegram.sendMessage(message.chat.id, "Desktop mirroring is off.", options);
      return;
    }
    if (action === "on") {
      const agents = await this.grok.listAgents(options);
      const agent = this.resolveAgent(this.mirrorChatId, agents);
      if (!agent) {
        await this.telegram.sendMessage(
          message.chat.id,
          "Could not find the selected mirror agent. Use /agents and /use before enabling mirroring.",
          options,
        );
        return;
      }
      await this.ensureMirrorBaseline(agent.id, { ...options, force: true });
      await this.state.setMirrorEnabled(true);
      await this.telegram.sendMessage(message.chat.id, `Desktop mirroring is on for ${agent.name}.`, options);
      return;
    }
    await this.telegram.sendMessage(message.chat.id, "Use /mirror status, /mirror on, or /mirror off.", options);
  }

  async handleUpdate(update, options = {}) {
    const message = update?.message;
    if (!this.isAuthorized(message)) return;
    const chatId = message.chat.id;
    const incomingAttachments = messageAttachments(message);
    const messageText = typeof message.text === "string" ? message.text : message.caption;
    if ((!messageText || !messageText.trim()) && incomingAttachments.length === 0) {
      await this.telegram.sendMessage(chatId, "Send text, a photo, or a file attachment.", options);
      return;
    }

    let text = messageText?.trim() || defaultAttachmentPrompt(message);
    const [rawCommand, ...rawArguments] = text.split(/\s+/);
    const command = rawCommand.toLocaleLowerCase().split("@")[0];
    if (command === "/start" || command === "/help" || command === "/commands") {
      await this.telegram.sendMessage(chatId, HELP, options);
      return;
    }

    if (command === "/mirror") {
      await this.handleMirrorCommand(message, rawArguments.join(" ").trim(), options);
      return;
    }

    const agents = await this.grok.listAgents(options);
    if (command === "/agents") {
      const selected = this.resolveAgent(chatId, agents);
      const lines = agents.map((agent) => `${agent.id === selected?.id ? "*" : "-"} ${agent.name}`);
      await this.telegram.sendMessage(chatId, lines.length ? lines.join("\n") : "No Grok agents are available.", options);
      return;
    }

    if (command === "/use") {
      const requested = rawArguments.join(" ").trim();
      const agent = agents.find((candidate) => normalize(candidate.name) === normalize(requested));
      if (!agent) {
        await this.telegram.sendMessage(chatId, "No exact agent-name match. Use /agents to see available names.", options);
        return;
      }
      if (this.isMirrorConfigured() && chatId === this.mirrorChatId) {
        await this.ensureMirrorBaseline(agent.id, options);
      }
      await this.state.setAgent(chatId, agent.id);
      await this.telegram.sendMessage(chatId, `Now using ${agent.name}.`, options);
      return;
    }

    const selectedId = this.state.getAgent(chatId);
    const agent = this.resolveAgent(chatId, agents);
    if (!agent) {
      const target = selectedId ? "selected agent" : `default agent “${this.defaultAgent}”`;
      await this.telegram.sendMessage(chatId, `Could not find the ${target}. Use /agents and /use.`, options);
      return;
    }
    if (command === "/status") {
      const activity = agent.isRunning || agent.isComposingMessage ? "working" : "idle";
      await this.telegram.sendMessage(chatId, `${agent.name} is ${activity}.`, options);
      return;
    }

    if (command === "/settings") {
      await this.telegram.sendMessage(
        chatId,
        "Chat Settings, General Settings, and Usage & Billing change the Grok desktop UI. Open Grok Bot on desktop for those actions.",
        options,
      );
      return;
    }

    const needsWorkflows = text.includes("@") || (rawCommand.startsWith("/") && command !== "/plugins");
    const workflows = needsWorkflows ? await this.grok.getAgentWorkflows(agent.id, options) : [];
    const { skills, routines } = splitWorkflows(workflows);
    if (command === "/skills") {
      const query = normalize(rawArguments.join(" "));
      const matches = query ? skills.filter((skill) => normalize(skill.name).includes(query)) : skills;
      const visible = matches.slice(0, SKILL_LIST_LIMIT);
      const lines = visible.map((skill) => `- ${skill.name}${/^[-a-z0-9_]+$/i.test(skill.name) ? ` (send /${skill.name})` : ""}`);
      const summary = matches.length > visible.length
        ? `\nShowing ${visible.length} of ${matches.length}. Narrow it with /skills <search>.`
        : "";
      await this.telegram.sendMessage(
        chatId,
        lines.length
          ? [`Skills for ${agent.name}:`, ...lines, summary, "Use /run <exact skill> [request]."].filter(Boolean).join("\n")
          : query ? `No skills match “${rawArguments.join(" ")}”.` : `${agent.name} has no enabled skills.`,
        options,
      );
      return;
    }

    if (command === "/routines") {
      const lines = routines.map((routine) => `- @${routine.name} - ${routineDescription(routine)}`);
      await this.telegram.sendMessage(
        chatId,
        lines.length ? [`Routines available to mention:`, ...lines].join("\n") : "No routines are available to mention.",
        options,
      );
      return;
    }

    if (command === "/plugins") {
      const servers = await this.grok.listMcpServers(options);
      const lines = servers.map((server) => `- ${server.serverIdentifier}: ${server.status ?? "unknown"}`);
      await this.telegram.sendMessage(
        chatId,
        lines.length
          ? ["Box plugin status:", ...lines, "", "Account-plugin @ references still require Grok Bot because its gateway does not expose their reference IDs."].join("\n")
          : "No box plugins are configured. Account plugins remain visible in Grok Bot on desktop.",
        options,
      );
      return;
    }

    if (command === "/mentions") {
      const mentionAgents = agents.filter((candidate) => candidate.id !== agent.id);
      const servers = await this.grok.listMcpServers(options);
      const lines = [
        "Agents:",
        ...(mentionAgents.length ? mentionAgents.map((candidate) => `- @${candidate.name}`) : ["- none"]),
        "",
        "Routines:",
        ...(routines.length ? routines.map((routine) => `- @${routine.name}`) : ["- none"]),
        "",
        "Box plugins:",
        ...(servers.length ? servers.map((server) => `- ${server.serverIdentifier}: ${server.status ?? "unknown"}`) : ["- none"]),
      ];
      await this.telegram.sendMessage(chatId, lines.join("\n"), options);
      return;
    }

    const argumentsText = text.slice(rawCommand.length).trim();
    let invokedSkill;
    let skillInvocationText = argumentsText;
    if (command === "/run") {
      invokedSkill = matchSkillInvocation(argumentsText, skills);
      if (!invokedSkill) {
        await this.telegram.sendMessage(chatId, "No exact skill-name match. Use /skills to see available names.", options);
        return;
      }
    } else if (rawCommand.startsWith("/")) {
      invokedSkill = skills.find((skill) => command === `/${normalize(skill.name)}`);
      if (!invokedSkill) {
        await this.telegram.sendMessage(chatId, "Unknown command. Use /help or /skills.", options);
        return;
      }
      skillInvocationText = `${invokedSkill.name}${argumentsText ? ` ${argumentsText}` : ""}`;
    }

    let references;
    if (invokedSkill) {
      text = workflowPrompt(invokedSkill, skillInvocationText);
      references = [{ start: 0, end: invokedSkill.name.length + 1, ...workflowReference(invokedSkill) }];
    } else if (text.includes("@")) {
      const candidates = [
        ...agents.filter((candidate) => candidate.id !== agent.id).map((candidate) => ({
          type: "mention",
          id: candidate.id,
          label: candidate.name,
        })),
        ...(agents.length >= 2 ? [{ type: "mention", id: "__everyone__", label: "everyone" }] : []),
        ...routines.map(workflowReference),
      ];
      references = findStructuredReferences(text, candidates);
    }
    const richText = buildRichText(text, references ?? []);
    await this.telegram.sendChatAction?.(chatId, "typing", options);
    await this.telegram.setMessageReaction?.(chatId, message.message_id, "👀", options).catch(() => {});
    const attachmentPaths = [];
    const attachmentNames = [];
    for (const attachment of incomingAttachments) {
      const downloaded = await this.telegram.downloadFile(attachment.fileId, options);
      const filename = attachment.filename || downloaded.filename;
      attachmentPaths.push(await this.grok.uploadAttachment(agent.id, filename, downloaded.bytes, options));
      attachmentNames.push(filename);
    }
    const clientNonce = `telegram:${update.update_id}:${chatId}:${message.message_id ?? 0}`;
    await this.grok.sendPrompt(agent.id, text, clientNonce, {
      ...options,
      attachmentPaths,
      attachmentNames,
      richText,
    });
    await this.state.setPromptContext(agent.id, clientNonce, {
      contextKey: clientNonce,
      clientNonce,
      origin: "telegram",
      chatId,
      replyToMessageId: message.message_id,
      awaitingCompletion: true,
    });
    await this.waitForOwnedReply(agent.id, clientNonce, {
      ...options,
      onApproval: (entry) => this.sendApproval(chatId, agent.id, entry, {
        ...options,
        approvalUserId: message.from.id,
        replyToMessageId: message.message_id,
      }),
    }, this.mirrorEnabled() && chatId === this.mirrorChatId);
    await this.deliverPromptContextThroughOwner(agent, clientNonce, options);
    await this.telegram.setMessageReaction?.(chatId, message.message_id, "✅", options).catch(() => {});
  }

  async pollDesktopMirrorOnce(options = {}) {
    const agents = await this.grok.listAgents(options);
    const recoveryAgentIds = new Set();
    for (const boundaryAgentId of this.state.listPromptTurnBoundaryAgentIds?.() ?? []) {
      recoveryAgentIds.add(boundaryAgentId);
    }
    for (const contextAgentId of this.state.listPromptContextAgentIds?.() ?? []) {
      recoveryAgentIds.add(contextAgentId);
    }
    for (const [, widget] of this.listRoutineWidgets()) {
      if (widget.submissionIntent === true && widget.replyDelivered !== true && widget.agentId) {
        recoveryAgentIds.add(widget.agentId);
      }
    }
    if (!this.mirrorEnabled()) {
      for (const recoveryAgentId of recoveryAgentIds) {
        const recoveryAgent = agents.find((candidate) => candidate.id === recoveryAgentId);
        if (!recoveryAgent) continue;
        for (const context of this.state.listPromptContexts?.(recoveryAgentId) ?? []) {
          const contextKey = context.contextKey ?? context.clientNonce;
          await this.withAgentMirrorOwner(recoveryAgentId, () => this.deliverPromptContext(
            recoveryAgent,
            contextKey,
            options,
            undefined,
            this.isMirrorConfigured(),
          ));
        }
      }
      return;
    }
    const recoveryErrors = new Map();
    for (const recoveryAgentId of recoveryAgentIds) {
      const recoveryAgent = agents.find((candidate) => candidate.id === recoveryAgentId);
      if (!recoveryAgent) continue;
      try {
        await this.pollDesktopMirrorAgentOnce(recoveryAgent, options);
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") throw error;
        recoveryErrors.set(recoveryAgentId, error);
        console.error(`Desktop mirror recovery failed for ${recoveryAgentId}:`, error.message);
      }
    }
    const agent = this.resolveAgent(this.mirrorChatId, agents);
    if (!agent) throw new Error("Desktop mirror agent is unavailable");
    if (recoveryAgentIds.has(agent.id)) {
      if (recoveryErrors.has(agent.id)) throw recoveryErrors.get(agent.id);
      return;
    }
    await this.pollDesktopMirrorAgentOnce(agent, options);
  }

  async pollDesktopMirrorAgentOnce(agent, options = {}) {
    return this.withAgentMirrorOwner(agent.id, () => this.pollDesktopMirrorAgentOwned(agent, options));
  }

  async pollDesktopMirrorAgentOwned(agent, options = {}) {
    const baselineOptions = { ...options, agent };
    await this.reconcileRoutineWidgetSubmissions(agent.id, options);
    const promptContexts = this.state.listPromptContexts?.(agent.id) ?? [];
    if (!promptContexts.length && await this.ensureMirrorBaseline(agent.id, baselineOptions)) return;

    let entries = await this.getTranscriptEntries(agent.id, options);
    const cursor = this.state.getMirrorCursor(agent.id);
    let cursorIndex = !cursor || cursor.entryId === null
      ? -1
      : entries.findIndex((entry) => entry?.id === cursor.entryId);
    if (cursor?.entryId && cursorIndex < 0) {
      entries = await this.grok.getTranscript(agent.id, options);
      cursorIndex = entries.findIndex((entry) => entry?.id === cursor.entryId);
      if (cursorIndex < 0) {
        if (!promptContexts.length) {
          await this.ensureMirrorBaseline(agent.id, { ...baselineOptions, force: true });
          return;
        }
        cursorIndex = -1;
      }
    }
    for (const boundary of this.state.listPromptTurnBoundaries?.(agent.id) ?? []) {
      const boundaryIndex = entries.findIndex((entry) => entry?.id === boundary.entryId);
      if (boundaryIndex >= 0 && cursor && boundaryIndex <= cursorIndex) {
        await this.retirePromptTurn(agent.id, boundary.clientNonce, boundary.entryId);
      }
    }
    if (promptContexts.some((context) => !entries.some((entry) => isTopLevelPromptEntry(entry)
      && (entry?.id === context.promptEntryId || entry?.clientNonce === context.clientNonce)))) {
      entries = await this.grok.getTranscript(agent.id, options);
      cursorIndex = cursor?.entryId === null || !cursor
        ? -1
        : entries.findIndex((entry) => entry?.id === cursor?.entryId);
    }
    for (const context of promptContexts) {
      const contextKey = context.contextKey ?? context.clientNonce;
      const contextPromptIndex = entries.findIndex((entry) => isTopLevelPromptEntry(entry)
        && (entry?.id === context.promptEntryId || entry?.clientNonce === context.clientNonce));
      if (contextPromptIndex >= 0 && (!cursor || contextPromptIndex <= cursorIndex)) {
        await this.deliverPromptContext(agent, contextKey, options, undefined, Boolean(cursor));
        return;
      }
    }
    if (!this.state.getMirrorCursor(agent.id)) {
      for (const context of promptContexts) {
        await this.deliverPromptContext(
          agent,
          context.contextKey ?? context.clientNonce,
          options,
          undefined,
          false,
        );
      }
      return;
    }
    const unseen = entries.slice(cursorIndex + 1);
    if (!unseen.length) return;
    const promptIndex = unseen.findIndex((entry) => isTopLevelPromptEntry(entry)
      && typeof entry?.id === "string" && entry.id);
    const autonomousIndex = unseen.findIndex((entry) => entry?.kind === "send-message");
    if (autonomousIndex >= 0 && (promptIndex < 0 || autonomousIndex < promptIndex)) {
      if (await this.mirrorAgentBusy(agent.id, baselineOptions)) return;
      const turnEnd = promptIndex < 0 ? unseen.length : promptIndex;
      await this.mirrorAutonomousOutput(
        agent,
        unseen.slice(autonomousIndex, turnEnd).filter((entry) => entry?.kind === "send-message"),
        options,
      );
      return;
    }
    if (promptIndex < 0) return;
    await this.mirrorDesktopTurn(agent, unseen[promptIndex], options);
  }

  async mirrorAutonomousOutput(agent, entries, options = {}) {
    if (!entries.length) return;
    for (const entry of entries) {
      if (typeof entry?.id !== "string" || !entry.id) {
        throw new Error("Grok returned no transcript cursor for autonomous output");
      }
      const widget = telegramSafeRoutineWidget(entry);
      if (widget && this.isMirrorConfigured()) {
        await this.sendAutonomousRoutineWidget(agent, entry, widget, options);
      } else {
        const reply = this.grok.getReplyContent([entry]);
        const text = reply.text
          ? `⏰ Routine · ${agent.name}\n\n${reply.text}`
          : !(reply.attachments ?? []).length
            ? "Grok produced autonomous output that Telegram cannot render. Open Grok Bot to view it."
            : undefined;
        const deliveryKey = `autonomous:${agent.id}:${entry.id}`;
        await this.deliverTelegramParts({
          deliveryKey,
          chatId: this.mirrorChatId,
          agentId: agent.id,
          text,
          attachments: reply.attachments,
          options,
        });
        await this.state.deleteDeliveryProgress?.(deliveryKey);
      }
      await this.state.setMirrorCursor(agent.id, entry.id);
    }
  }

  async mirrorDesktopTurn(agent, promptEntry, options = {}) {
    const clientNonce = typeof promptEntry?.clientNonce === "string" ? promptEntry.clientNonce : undefined;
    const contextKey = clientNonce ?? promptEntry.id;
    const waitOptions = { ...options, promptEntryId: promptEntry.id };
    const promptContext = this.state.getPromptContext?.(agent.id, contextKey);
    if (promptContext) {
      await this.deliverPromptContext(agent, contextKey, options, undefined, true);
      return;
    }
    if (clientNonce?.startsWith("telegram:")) {
      const skippedReply = await this.waitForOwnedReply(agent.id, clientNonce, waitOptions, true);
      if (typeof skippedReply?.messageId === "string" && skippedReply.messageId) {
        await this.state.setMirrorCursor(agent.id, skippedReply.messageId);
        await this.retirePromptTurn(agent.id, clientNonce, skippedReply.messageId);
      }
      return;
    }

    const prompt = this.grok.getPromptContent(promptEntry) ?? {
      text: "",
      attachments: [],
      unavailableAttachmentCount: 0,
    };
    const attachmentNotice = prompt.unavailableAttachmentCount > 0
      ? `\n\n[${prompt.unavailableAttachmentCount} desktop attachment${prompt.unavailableAttachmentCount === 1 ? " is" : "s are"} unavailable through the gateway transcript.]`
      : "";
    const promptText = prompt.text || "[Desktop prompt text is unavailable through the gateway transcript.]";
    const mirroredPrompt = await this.telegram.sendMessage(
      this.mirrorChatId,
      `🖥️ Desktop · ${agent.name}\n\n${promptText}${attachmentNotice}`,
      options,
    );
    if (!Number.isSafeInteger(mirroredPrompt?.message_id)) {
      throw new Error("Telegram returned no message ID for the mirrored desktop prompt");
    }
    await this.state.setPromptContext(agent.id, contextKey, {
      contextKey,
      clientNonce,
      promptEntryId: promptEntry.id,
      origin: "desktop",
      chatId: this.mirrorChatId,
      replyToMessageId: mirroredPrompt.message_id,
      awaitingCompletion: true,
    });
    const replyOptions = { ...options, replyToMessageId: mirroredPrompt.message_id };
    for (const attachment of prompt.attachments ?? []) {
      const bytes = await this.grok.readAttachment(agent.id, attachment.path, options);
      await this.telegram.sendAttachment(
        this.mirrorChatId,
        { ...attachment, bytes, caption: attachment.caption || "Desktop prompt attachment" },
        replyOptions,
      );
    }
    const reply = await this.waitForOwnedReply(agent.id, clientNonce, {
      ...waitOptions,
      onApproval: (entry) => this.sendApproval(this.mirrorChatId, agent.id, entry, {
        ...options,
        approvalUserId: this.mirrorUserId,
        replyToMessageId: mirroredPrompt.message_id,
      }),
    }, true, contextKey);
    await this.deliverPromptContext(agent, contextKey, options, reply, true);
  }

  async runDesktopMirror(options = {}) {
    if (!this.isMirrorConfigured()) return;
    let consecutiveFailures = 0;
    while (!options.signal?.aborted) {
      try {
        await this.pollDesktopMirrorOnce(options);
        consecutiveFailures = 0;
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") break;
        consecutiveFailures += 1;
        console.error("Desktop mirror polling failed:", error.message);
      }
      const normalDelay = this.grok.pollIntervalMs ?? 1_000;
      const delayMs = consecutiveFailures
        ? Math.min(normalDelay * (2 ** (consecutiveFailures - 1)), 30_000)
        : normalDelay;
      try {
        await sleep(delayMs, undefined, { signal: options.signal });
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") break;
        throw error;
      }
    }
  }

  async waitForOwnedReply(agentId, clientNonce, options = {}, persistBoundary = false, contextKey = clientNonce) {
    const completedReplyMessageId = typeof contextKey === "string"
      ? this.state.getPromptTurnBoundary?.(agentId, contextKey)
      : undefined;
    let reply;
    try {
      reply = await this.grok.waitForReply(agentId, clientNonce, {
        ...options,
        ...(completedReplyMessageId ? { completedReplyMessageId } : {}),
      });
    } catch (error) {
      const context = this.state.getPromptContext?.(agentId, contextKey);
      if (context?.awaitingCompletion) {
        await this.state.setPromptContext(agentId, contextKey, {
          ...context,
          awaitingCompletion: false,
        });
      }
      throw error;
    }
    if (typeof contextKey === "string" && contextKey
      && typeof reply?.messageId === "string" && reply.messageId) {
      if (persistBoundary) {
        await this.state.setPromptTurnBoundary?.(agentId, contextKey, reply.messageId);
      }
      const context = this.state.getPromptContext?.(agentId, contextKey);
      if (context) {
        await this.state.setPromptContext(agentId, contextKey, {
          ...context,
          awaitingCompletion: false,
          completionEntryId: reply.messageId,
          completionReply: {
            messageId: reply.messageId,
            text: reply.text,
            attachments: reply.attachments ?? [],
            entries: reply.entries,
          },
        });
      }
    }
    return reply;
  }

  async retirePromptTurn(agentId, contextKey, entryId) {
    if (typeof contextKey !== "string" || !contextKey) return;
    if (this.state.retirePromptTurn) {
      await this.state.retirePromptTurn(agentId, contextKey, entryId);
    } else {
      await this.state.deletePromptTurnBoundary?.(agentId, contextKey);
    }
    await this.state.deletePromptContext?.(agentId, contextKey);
    const widgetToken = ROUTINE_WIDGET_NONCE.exec(contextKey)?.[1];
    const widget = widgetToken ? this.state.getApproval(widgetToken) : undefined;
    if (widget?.type === "routine-widget" && widget.agentId === agentId) {
      widget.replyDelivered = true;
      widget.resolving = false;
      await this.state.setApproval(widgetToken, widget);
    }
  }

  async deliverRecoveredPromptEntries(
    agent,
    promptEntry,
    context,
    options = {},
    advanceCursor = true,
    resolvedEntries,
  ) {
    let entries = resolvedEntries ?? await this.getTranscriptEntries(agent.id, options);
    if (context.awaitingCompletion) return 0;
    let promptIndex = entries.findIndex((entry) => entry?.id === promptEntry.id);
    if (promptIndex < 0) {
      entries = await this.grok.getTranscript(agent.id, options);
      promptIndex = entries.findIndex((entry) => entry?.id === promptEntry.id);
    }
    if (promptIndex < 0) return 0;
    const nextPromptOffset = entries.slice(promptIndex + 1).findIndex(isTopLevelPromptEntry);
    const turnEnd = nextPromptOffset < 0 ? entries.length : promptIndex + 1 + nextPromptOffset;
    const replyEntries = entries.slice(promptIndex + 1, turnEnd)
      .filter((entry) => entry?.kind === "send-message");
    const contextKey = context.contextKey ?? promptEntry.clientNonce ?? promptEntry.id;
    let delivered = 0;
    for (const entry of replyEntries) {
      if (typeof entry?.id !== "string" || !entry.id) {
        throw new Error("Grok returned no transcript cursor for a recovered prompt update");
      }
      const alreadyDelivered = context.deliveredEntryIds?.includes(entry.id);
      const reply = this.grok.getReplyContent([entry]);
      const provenReply = entry.id === context.completionEntryId;
      const neutral = !provenReply;
      const text = reply.text
        ? neutral ? `Grok update · ${agent.name}\n\n${reply.text}` : reply.text
        : !(reply.attachments ?? []).length
          ? "Grok produced an update that Telegram cannot render safely. Open Grok Bot to view it."
          : undefined;
      const deliveryKey = `prompt:${agent.id}:${promptEntry.id}:${entry.id}`;
      const canDeliver = provenReply || this.isMirrorConfigured();
      if (!alreadyDelivered && canDeliver) {
        await this.deliverTelegramParts({
          deliveryKey,
          chatId: provenReply ? context.chatId ?? this.mirrorChatId : this.mirrorChatId,
          agentId: agent.id,
          text,
          attachments: reply.attachments,
          options: provenReply && context.replyToMessageId
            ? { ...options, replyToMessageId: context.replyToMessageId }
            : options,
        });
        context.deliveredEntryIds = [...(context.deliveredEntryIds ?? []), entry.id];
        await this.state.setPromptContext?.(agent.id, contextKey, context);
        await this.state.deleteDeliveryProgress?.(deliveryKey);
        delivered += 1;
      }
      if (advanceCursor && canDeliver) await this.state.setMirrorCursor(agent.id, entry.id);
      if (entry.id === context.completionEntryId) {
        await this.retirePromptTurn(agent.id, contextKey, entry.id);
        break;
      }
    }
    if (advanceCursor && !context.completionEntryId && nextPromptOffset >= 0) {
      if (!replyEntries.length) await this.state.setMirrorCursor(agent.id, promptEntry.id);
      await this.retirePromptTurn(agent.id, contextKey, replyEntries.at(-1)?.id ?? promptEntry.id);
    }
    return delivered;
  }

  async withAgentMirrorOwner(agentId, operation) {
    const previous = this.agentMirrorQueues.get(agentId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.agentMirrorQueues.set(agentId, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.agentMirrorQueues.get(agentId) === current) this.agentMirrorQueues.delete(agentId);
    }
  }

  async deliverPromptContextThroughOwner(agent, contextKey, options = {}) {
    return this.withAgentMirrorOwner(agent.id, async () => {
      if (!this.mirrorEnabled()) {
        return this.deliverPromptContext(
          agent,
          contextKey,
          options,
          undefined,
          this.isMirrorConfigured(),
        );
      }
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!this.state.getPromptContext?.(agent.id, contextKey)) return;
        const before = this.state.getMirrorCursor(agent.id)?.entryId;
        await this.pollDesktopMirrorAgentOwned(agent, options);
        if (!this.state.getPromptContext?.(agent.id, contextKey)) return;
        if (this.state.getMirrorCursor(agent.id)?.entryId === before) {
          return this.deliverPromptContext(agent, contextKey, options, undefined, true);
        }
      }
    });
  }

  async deliverPromptContext(agent, contextKey, options = {}, liveReply, advanceCursor = true) {
    const context = this.state.getPromptContext?.(agent.id, contextKey);
    if (!context) return;
    const clientNonce = context.clientNonce ?? context.contextKey ?? contextKey;
    let entries = [];
    try {
      entries = await this.getTranscriptEntries(agent.id, options);
    } catch {
      entries = [];
    }
    let promptEntry = entries.find((entry) => isTopLevelPromptEntry(entry)
      && (entry?.id === context.promptEntryId || entry?.clientNonce === clientNonce));
    if (!promptEntry && typeof this.grok.getTranscript === "function") {
      try {
        entries = await this.grok.getTranscript(agent.id, options);
        promptEntry = entries.find((entry) => isTopLevelPromptEntry(entry)
          && (entry?.id === context.promptEntryId || entry?.clientNonce === clientNonce));
      } catch {
        entries = [];
      }
    }
    const replyResult = liveReply ?? context.completionReply;
    if (!promptEntry && replyResult?.messageId) {
      promptEntry = {
        id: context.promptEntryId ?? `prompt:${contextKey}`,
        kind: "message",
        clientNonce,
      };
      entries.push(promptEntry);
    }
    if (!promptEntry) return;
    if (!replyResult?.messageId
      && ROUTINE_WIDGET_NONCE.test(clientNonce ?? "")
      && !context.awaitingCompletion) {
      await this.waitForOwnedReply(agent.id, clientNonce, {
        ...options,
        promptEntryId: context.promptEntryId ?? promptEntry.id,
        onApproval: (entry) => this.sendApproval(context.chatId ?? this.mirrorChatId, agent.id, entry, {
          ...options,
          approvalUserId: this.mirrorUserId,
          replyToMessageId: context.replyToMessageId,
        }),
      }, advanceCursor && this.mirrorEnabled(), contextKey);
    }
    const completed = this.state.getPromptContext?.(agent.id, contextKey) ?? context;
    const completedReply = liveReply ?? completed.completionReply;
    if (completedReply?.messageId && !entries.some((entry) => entry?.id === completedReply.messageId)) {
      entries.push(...this.replyEntriesFromResult(completedReply));
    }
    await this.deliverRecoveredPromptEntries(
      agent,
      promptEntry,
      { ...completed, contextKey, clientNonce },
      options,
      advanceCursor,
      entries,
    );
  }

  replyEntriesFromResult(reply) {
    if (reply?.entries?.length) return reply.entries;
    if (!reply?.messageId) return [];
    return [{
      id: reply.messageId,
      kind: "send-message",
      message: {
        type: "text",
        content: reply.text ?? "",
        images: (reply.attachments ?? []).map((attachment) => ({
          url: attachment.path,
          alt: attachment.caption,
        })),
      },
    }];
  }

  async findTranscriptEntryByNonce(agentId, clientNonce, options = {}) {
    let entries = await this.getTranscriptEntries(agentId, options);
    let entry = entries.find((candidate) => candidate?.clientNonce === clientNonce);
    if (entry) return entry;
    entries = await this.grok.getTranscript(agentId, options);
    return entries.find((candidate) => candidate?.clientNonce === clientNonce);
  }

  async deliverTelegramParts({ deliveryKey, chatId, agentId, text, attachments = [], options = {} }) {
    const parts = [
      ...(text ? [{ type: "text", text }] : []),
      ...attachments.map((attachment) => ({ type: "attachment", attachment })),
    ];
    let progress = this.state.getDeliveryProgress?.(deliveryKey);
    if (!progress) {
      progress = { nextPart: 0, claimed: true };
      await this.state.setDeliveryProgress?.(deliveryKey, progress);
    }
    for (let index = progress.nextPart; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.type === "text") {
        const textChunks = this.telegram.splitMessage?.(part.text) ?? [part.text];
        for (let chunkIndex = progress.nextTextChunk ?? 0; chunkIndex < textChunks.length; chunkIndex += 1) {
          const sent = await this.telegram.sendMessage(chatId, textChunks[chunkIndex], {
            ...options,
            ...(chunkIndex === textChunks.length - 1 ? {} : { inlineKeyboard: undefined }),
          });
          if (!options.replyToMessageId && !Number.isSafeInteger(progress.rootMessageId)
            && Number.isSafeInteger(sent?.message_id)) {
            progress.rootMessageId = sent.message_id;
          }
          progress.nextTextChunk = chunkIndex + 1;
          await this.state.setDeliveryProgress?.(deliveryKey, progress);
        }
        delete progress.nextTextChunk;
      } else {
        const bytes = await this.grok.readAttachment(agentId, part.attachment.path, options);
        const attachmentOptions = Number.isSafeInteger(progress.rootMessageId)
          ? { ...options, replyToMessageId: progress.rootMessageId }
          : options;
        await this.telegram.sendAttachment(chatId, { ...part.attachment, bytes }, attachmentOptions);
      }
      progress.nextPart = index + 1;
      await this.state.setDeliveryProgress?.(deliveryKey, progress);
    }
  }

  listRoutineWidgets() {
    const entries = typeof this.state.listApprovals === "function"
      ? this.state.listApprovals()
      : Object.entries(this.state.pendingApprovals ?? {});
    return entries.filter(([, approval]) => approval?.type === "routine-widget");
  }

  findRoutineWidget(agentId, entryId) {
    return this.listRoutineWidgets().find(([, widget]) => (
      widget.agentId === agentId && widget.entryId === entryId
    ));
  }

  async withWidgetCallbackLock(token, operation) {
    const previous = this.widgetCallbackQueues.get(token) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.widgetCallbackQueues.set(token, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.widgetCallbackQueues.get(token) === current) this.widgetCallbackQueues.delete(token);
    }
  }

  routineWidgetBindingError(widget, callback, token, choiceIndex) {
    const choice = widget?.choices?.[choiceIndex];
    if (!widget || widget.type !== "routine-widget" || !widget.agentId || !widget.entryId
      || !choice || typeof choice.value !== "string" || !choice.value
      || widget.chatId !== this.mirrorChatId
      || widget.userId !== this.mirrorUserId
      || widget.chatId !== callback.message?.chat?.id
      || widget.userId !== callback.from?.id
      || widget.messageId !== callback.message?.message_id) {
      return "This option is not valid for this chat.";
    }
    if (widget.replyDelivered === true) {
      return "That widget choice was already used.";
    }
    if (widget.submissionIntent === true) {
      const expectedNonce = routineWidgetNonce(token, choiceIndex);
      if (widget.choiceIndex !== choiceIndex
        || widget.clientNonce !== expectedNonce
        || widget.selectedValue !== choice.value) {
        return "That widget choice was already used.";
      }
    } else if (widget.expiresAt <= Date.now()) {
      return "expired";
    }
    return undefined;
  }

  async sendAutonomousRoutineWidget(agent, entry, details, options = {}) {
    const cardText = `⏰ Routine · ${agent.name}\n\n${details.text}`;
    if (cardText.length > APPROVAL_TEXT_LIMIT) {
      await this.telegram.sendMessage(
        this.mirrorChatId,
        "Grok Bot needs an approval, secret, or rich interaction. Open Grok Bot on desktop to handle it safely.",
        options,
      );
      return;
    }
    const existing = this.findRoutineWidget(agent.id, entry.id);
    if (existing?.[1]?.messageId) return;
    const token = existing?.[0] ?? randomBytes(18).toString("base64url");
    const widget = existing?.[1] ?? {
      type: "routine-widget",
      agentId: agent.id,
      entryId: entry.id,
      choices: details.choices,
      chatId: this.mirrorChatId,
      userId: this.mirrorUserId,
      expiresAt: Date.now() + ROUTINE_WIDGET_TTL_MS,
    };
    if (!existing) await this.state.setApproval(token, widget);
    try {
      const sent = await this.telegram.sendMessage(this.mirrorChatId, cardText, {
        ...options,
        inlineKeyboard: details.choices.map((choice, index) => [{
          text: choice.label,
          callback_data: `gtw:${token}:${index.toString(36)}`,
        }]),
      });
      widget.messageId = sent?.message_id;
      await this.state.setApproval(token, widget);
    } catch (error) {
      if (!existing) await this.state.deleteApproval(token);
      throw error;
    }
  }

  async reconcileRoutineWidgetSubmissions(agentId, options = {}) {
    const pending = this.listRoutineWidgets().filter(([, widget]) => (
      widget.agentId === agentId
      && widget.submissionIntent === true
      && typeof widget.clientNonce === "string"
      && widget.clientNonce
    ));
    if (!pending.length) return;
    let entries = await this.getTranscriptEntries(agentId, options);
    if (pending.some(([, widget]) => !entries.some((entry) => (
      isTopLevelPromptEntry(entry) && entry?.clientNonce === widget.clientNonce
    )))) {
      entries = await this.grok.getTranscript(agentId, options);
    }
    for (const [token, widget] of pending) {
      const promptEntry = entries.find((entry) => (
        isTopLevelPromptEntry(entry) && entry?.clientNonce === widget.clientNonce
      ));
      if (!promptEntry) continue;
      widget.submitted = true;
      widget.accepted = true;
      widget.resolving = false;
      await this.state.setApproval(token, widget);
      if (!this.state.getPromptContext?.(agentId, widget.clientNonce)) {
        await this.state.setPromptContext(agentId, widget.clientNonce, {
          contextKey: widget.clientNonce,
          clientNonce: widget.clientNonce,
          promptEntryId: promptEntry.id,
          origin: "telegram",
          chatId: widget.chatId,
          replyToMessageId: widget.messageId,
          awaitingCompletion: false,
        });
      }
    }
  }

  async deliverAcceptedWidgetChoice(token, widget, options = {}) {
    const agents = await this.grok.listAgents(options);
    const agent = agents.find((candidate) => candidate.id === widget.agentId)
      ?? { id: widget.agentId, name: "Grok" };
    const persistBoundary = this.mirrorEnabled();
    if (!this.state.getPromptContext?.(agent.id, widget.clientNonce)) {
      await this.state.setPromptContext(agent.id, widget.clientNonce, {
        contextKey: widget.clientNonce,
        clientNonce: widget.clientNonce,
        origin: "telegram",
        chatId: widget.chatId,
        replyToMessageId: widget.messageId,
        awaitingCompletion: true,
      });
    }
    await this.waitForOwnedReply(agent.id, widget.clientNonce, {
      ...options,
      onApproval: (entry) => this.sendApproval(widget.chatId, agent.id, entry, {
        ...options,
        approvalUserId: widget.userId,
        replyToMessageId: widget.messageId,
      }),
    }, persistBoundary);
    await this.deliverPromptContextThroughOwner(agent, widget.clientNonce, options);
    widget.replyDelivered = true;
    widget.resolving = false;
    await this.state.setApproval(token, widget);
  }

  async handleRoutineWidgetCallback(callback, token, choiceIndex, options = {}) {
    return this.withWidgetCallbackLock(token, async () => {
      const widget = this.state.getApproval(token);
      const bindingError = this.routineWidgetBindingError(widget, callback, token, choiceIndex);
      if (bindingError === "expired") {
        await this.state.deleteApproval(token);
        await this.telegram.editMessageReplyMarkup(widget.chatId, widget.messageId, [], options).catch(() => {});
        await this.telegram.answerCallbackQuery(
          callback.id,
          "This option expired. Open Grok Bot if you still need to choose.",
          options,
        );
        return;
      }
      if (bindingError) {
        await this.telegram.answerCallbackQuery(callback.id, bindingError, options);
        return;
      }
      if (widget.resolving) {
        await this.telegram.answerCallbackQuery(callback.id, "That choice is already being processed.", options);
        return;
      }

      const choice = widget.choices[choiceIndex];
      const clientNonce = routineWidgetNonce(token, choiceIndex);
      if (widget.submissionIntent === true) {
        const submittedEntry = await this.findTranscriptEntryByNonce(widget.agentId, clientNonce, options);
        if (!submittedEntry) {
          await this.telegram.answerCallbackQuery(
            callback.id,
            "Choice submission is still being reconciled. It will not be sent twice.",
            options,
          );
          return;
        }
        widget.submitted = true;
        widget.accepted = true;
        widget.resolving = true;
        await this.state.setApproval(token, widget);
        try {
          await this.telegram.editMessageReplyMarkup(widget.chatId, widget.messageId, [], options).catch(() => {});
          await this.telegram.answerCallbackQuery(callback.id, "Sent to Grok.", options).catch(() => {});
          await this.deliverAcceptedWidgetChoice(token, widget, options);
        } catch (error) {
          widget.resolving = false;
          await this.state.setApproval(token, widget);
          throw error;
        }
        return;
      }

      widget.resolving = true;
      widget.submissionIntent = true;
      widget.clientNonce = clientNonce;
      widget.choiceIndex = choiceIndex;
      widget.selectedValue = choice.value;
      await this.state.setApproval(token, widget);
      try {
        await this.grok.sendPrompt(widget.agentId, choice.value, clientNonce, options);
        widget.submitted = true;
        widget.accepted = true;
        await this.state.setApproval(token, widget);
        await this.telegram.editMessageReplyMarkup(widget.chatId, widget.messageId, [], options).catch(() => {});
        await this.telegram.answerCallbackQuery(callback.id, "Sent to Grok.", options).catch(() => {});
        await this.deliverAcceptedWidgetChoice(token, widget, options);
      } catch (error) {
        widget.resolving = false;
        await this.state.setApproval(token, widget);
        throw error;
      }
    });
  }

  async sendApproval(chatId, agentId, entry, options = {}) {
    const details = approvalDetails(entry);
    if (!details?.requestId || !entry?.id) return;
    const text = formatApproval(details);
    if (text.length > APPROVAL_TEXT_LIMIT) {
      await this.telegram.sendMessage(
        chatId,
        "This approval contains more detail than Telegram can display safely. Open Grok Bot to review the complete request. No mobile approval was offered.",
        options,
      );
      return;
    }

    const token = randomBytes(18).toString("base64url");
    const approval = {
      type: details.type,
      agentId,
      entryId: entry.id,
      requestId: details.requestId,
      chatId,
      userId: options.approvalUserId,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    };
    await this.state.setApproval(token, approval);
    try {
      const sent = await this.telegram.sendMessage(chatId, text, {
        ...options,
        inlineKeyboard: [[
          { text: "Approve once", callback_data: `gta:${token}:a` },
          { text: "Deny", callback_data: `gta:${token}:d` },
        ]],
      });
      approval.messageId = sent?.message_id;
      await this.state.setApproval(token, approval);
    } catch (error) {
      await this.state.deleteApproval(token);
      throw error;
    }
  }

  async handleCallbackQuery(update, options = {}) {
    const callback = update?.callback_query;
    if (!this.isAuthorizedCallback(callback)) return;
    const widgetMatch = ROUTINE_WIDGET_CALLBACK.exec(callback.data ?? "");
    if (widgetMatch) {
      await this.handleRoutineWidgetCallback(
        callback,
        widgetMatch[1],
        Number.parseInt(widgetMatch[2], 36),
        options,
      );
      return;
    }
    const match = /^gta:([A-Za-z0-9_-]{24}):([ad])$/.exec(callback.data ?? "");
    if (!match) {
      await this.telegram.answerCallbackQuery(callback.id, "Unknown or invalid approval.", options);
      return;
    }
    const [, token, decision] = match;
    const approval = this.state.getApproval(token);
    const expectedMessageId = callback.message?.message_id;
    if (!approval
      || approval.chatId !== callback.message.chat.id
      || approval.userId !== callback.from.id
      || approval.messageId !== expectedMessageId) {
      await this.telegram.answerCallbackQuery(callback.id, "This approval is not valid for this chat.", options);
      return;
    }
    if (approval.expiresAt <= Date.now()) {
      await this.state.deleteApproval(token);
      await this.telegram.editMessageReplyMarkup(approval.chatId, approval.messageId, [], options).catch(() => {});
      await this.telegram.answerCallbackQuery(callback.id, "This approval expired. Retry the request.", options);
      return;
    }
    if (approval.resolving) {
      await this.telegram.answerCallbackQuery(callback.id, "That decision is already being processed.", options);
      return;
    }

    approval.resolving = true;
    await this.state.setApproval(token, approval);
    try {
      const pending = await this.grok.getPendingApproval(
        approval.agentId,
        approval.entryId,
        approval.requestId,
        options,
      );
      if (!pending || (approval.type === "auto-review" && pending.message.type !== "auto-review-approval")
        || (approval.type === "local-tool" && pending.message.type !== "local-tool-permission")) {
        await this.state.deleteApproval(token);
        await this.telegram.editMessageReplyMarkup(approval.chatId, approval.messageId, [], options).catch(() => {});
        await this.telegram.answerCallbackQuery(callback.id, "This request is no longer pending.", options);
        return;
      }
      const approved = decision === "a";
      if (approval.type === "auto-review") {
        await this.grok.resolveAutoReviewApproval(
          approval.agentId,
          approval.entryId,
          approval.requestId,
          approved,
          options,
        );
      } else {
        await this.grok.resolveLocalToolPermission(
          approval.agentId,
          approval.entryId,
          approval.requestId,
          approved,
          options,
        );
      }
      await this.state.deleteApproval(token);
      await this.telegram.editMessageReplyMarkup(approval.chatId, approval.messageId, [], options).catch(() => {});
      await this.telegram.answerCallbackQuery(callback.id, approved ? "Approved once." : "Denied.", options);
      await this.telegram.sendMessage(
        approval.chatId,
        approved ? "✅ Approved once. Grok is continuing." : "❌ Denied. Grok was not authorized to perform that action.",
        { ...options, replyToMessageId: approval.messageId },
      );
    } catch (error) {
      approval.resolving = false;
      await this.state.setApproval(token, approval);
      throw error;
    }
  }

  async handleCallbackError(update, options = {}) {
    const callback = update?.callback_query;
    if (!this.isAuthorizedCallback(callback)) return;
    const widgetMatch = ROUTINE_WIDGET_CALLBACK.exec(callback.data ?? "");
    const widget = widgetMatch ? this.state.getApproval(widgetMatch[1]) : undefined;
    const choiceWasSent = widget?.type === "routine-widget" && widget.submissionIntent === true;
    await this.telegram.answerCallbackQuery(
      callback.id,
      choiceWasSent
        ? "Choice sent. Reply delivery will retry automatically."
        : widgetMatch
          ? "Could not finish that choice. Check the chat before trying again."
          : "Could not apply that decision. The request remains unapproved.",
      options,
    ).catch(() => {});
  }


  async handleError(update, options = {}) {
    const message = update?.message;
    if (!this.isAuthorized(message)) return;
    await this.telegram.setMessageReaction?.(message.chat.id, message.message_id, "❌", options).catch(() => {});
    await this.telegram.sendMessage(
      message.chat.id,
      "I couldn't finish that request. Please try again, or open Grok Bot if the request needs a desktop approval.",
      { ...options, replyToMessageId: message.message_id },
    ).catch(() => {});
  }
}

export { HELP };
