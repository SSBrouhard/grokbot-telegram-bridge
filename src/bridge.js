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
].join("\n");

const APPROVAL_TTL_MS = 10 * 60_000;
const ROUTINE_WIDGET_TTL_MS = 12 * 60 * 60_000;
const APPROVAL_TEXT_LIMIT = 3_500;
const SKILL_LIST_LIMIT = 20;

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

function routineWidgetDetails(entry) {
  if (entry?.kind !== "send-message" || entry.message?.type !== "widget") return undefined;
  const widget = entry.message.widget;
  if (!widget || typeof widget.prompt !== "string") return undefined;
  const choices = (Array.isArray(widget.options) ? widget.options : [])
    .filter((option) => typeof option?.label === "string" && option.label
      && typeof option?.value === "string" && option.value)
    .slice(0, 10)
    .map((option) => ({ label: option.label.slice(0, 64), value: option.value }));
  if (!choices.length) return undefined;
  return {
    text: [widget.prompt, widget.helpText].filter((value) => typeof value === "string" && value).join("\n\n"),
    choices,
  };
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

  async ensureMirrorBaseline(agentId, options = {}) {
    if (!options.force && this.state.getMirrorCursor(agentId)) return false;
    const entries = await this.getTranscriptEntries(agentId, options);
    const newestId = [...entries].reverse().find((entry) => typeof entry?.id === "string" && entry.id)?.id;
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
    const reply = await this.grok.waitForReply(agent.id, clientNonce, {
      ...options,
      onApproval: (entry) => this.sendApproval(chatId, agent.id, entry, {
        ...options,
        approvalUserId: message.from.id,
        replyToMessageId: message.message_id,
      }),
    });
    const replyOptions = { ...options, replyToMessageId: message.message_id };
    if (reply.text) await this.telegram.sendMessage(chatId, reply.text, replyOptions);
    for (const attachment of reply.attachments ?? []) {
      const bytes = await this.grok.readAttachment(agent.id, attachment.path, options);
      await this.telegram.sendAttachment(chatId, { ...attachment, bytes }, replyOptions);
    }
    await this.telegram.setMessageReaction?.(chatId, message.message_id, "✅", options).catch(() => {});
  }

  async pollDesktopMirrorOnce(options = {}) {
    if (!this.mirrorEnabled()) return;
    const agents = await this.grok.listAgents(options);
    const agent = this.resolveAgent(this.mirrorChatId, agents);
    if (!agent) throw new Error("Desktop mirror agent is unavailable");
    if (await this.ensureMirrorBaseline(agent.id, options)) return;

    let entries = await this.getTranscriptEntries(agent.id, options);
    const cursor = this.state.getMirrorCursor(agent.id);
    let cursorIndex = cursor?.entryId === null
      ? -1
      : entries.findIndex((entry) => entry?.id === cursor?.entryId);
    if (cursor?.entryId && cursorIndex < 0) {
      entries = await this.grok.getTranscript(agent.id, options);
      cursorIndex = entries.findIndex((entry) => entry?.id === cursor.entryId);
      if (cursorIndex < 0) {
        await this.ensureMirrorBaseline(agent.id, { ...options, force: true });
        return;
      }
    }
    const unseen = entries.slice(cursorIndex + 1);
    if (!unseen.length) return;
    const promptIndex = unseen.findIndex((entry) => isTopLevelPromptEntry(entry)
      && typeof entry?.id === "string" && entry.id);
    const autonomousIndex = unseen.findIndex((entry) => entry?.kind === "send-message"
      && typeof entry?.id === "string" && entry.id);
    if (autonomousIndex >= 0 && (promptIndex < 0 || autonomousIndex < promptIndex)) {
      if (agent.isRunning === true || agent.isComposingMessage === true
        || await this.grok.isAgentBusy(agent.id, options)) return;
      const turnEnd = promptIndex < 0 ? unseen.length : promptIndex;
      const autonomousEntries = unseen.slice(autonomousIndex, turnEnd)
        .filter((entry) => entry?.kind === "send-message");
      await this.mirrorAutonomousOutput(agent, autonomousEntries, options);
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
      const widget = entry.message?.type === "widget";
      if (widget) {
        await this.sendRoutineWidget(this.mirrorChatId, agent.id, entry, {
          ...options,
          widgetUserId: this.mirrorUserId,
        });
      } else {
        const reply = this.grok.getReplyContent([entry]);
        let rootMessageId;
        if (reply.text) {
          const sent = await this.telegram.sendMessage(
            this.mirrorChatId,
            `⏰ Routine · ${agent.name}\n\n${reply.text}`,
            options,
          );
          rootMessageId = sent?.message_id;
        }
        const replyOptions = Number.isSafeInteger(rootMessageId)
          ? { ...options, replyToMessageId: rootMessageId }
          : options;
        for (const attachment of reply.attachments ?? []) {
          const bytes = await this.grok.readAttachment(agent.id, attachment.path, options);
          await this.telegram.sendAttachment(this.mirrorChatId, { ...attachment, bytes }, replyOptions);
        }
        if (!reply.text && !(reply.attachments ?? []).length) {
          await this.telegram.sendMessage(
            this.mirrorChatId,
            "Grok produced autonomous output that Telegram cannot render. Open Grok Bot to view it.",
            options,
          );
        }
      }
      await this.state.setMirrorCursor(agent.id, entry.id);
    }
  }

  async mirrorDesktopTurn(agent, promptEntry, options = {}) {
    const clientNonce = typeof promptEntry?.clientNonce === "string" ? promptEntry.clientNonce : undefined;
    const waitOptions = { ...options, promptEntryId: promptEntry.id };
    const widgetToken = /^telegram:widget:([A-Za-z0-9_-]{24}):[0-9a-z]$/.exec(clientNonce ?? "")?.[1];
    if (widgetToken) {
      const widget = this.state.getApproval(widgetToken);
      if (widget?.type === "routine-widget") {
        if (!widget.submitted || widget.resolving) return;
        widget.resolving = true;
        await this.state.setApproval(widgetToken, widget);
        try {
          const reply = await this.grok.waitForReply(agent.id, clientNonce, waitOptions);
          await this.deliverRoutineWidgetReply(widget, reply, options);
          if (typeof reply?.messageId === "string" && reply.messageId) {
            await this.state.setMirrorCursor(agent.id, reply.messageId);
          }
          await this.state.deleteApproval(widgetToken);
        } catch (error) {
          widget.resolving = false;
          await this.state.setApproval(widgetToken, widget);
          throw error;
        }
        return;
      }
    }
    if (clientNonce?.startsWith("telegram:")) {
      const skippedReply = await this.grok.waitForReply(agent.id, clientNonce, waitOptions);
      if (typeof skippedReply?.messageId === "string" && skippedReply.messageId) {
        await this.state.setMirrorCursor(agent.id, skippedReply.messageId);
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
    const replyOptions = { ...options, replyToMessageId: mirroredPrompt.message_id };
    for (const attachment of prompt.attachments ?? []) {
      const bytes = await this.grok.readAttachment(agent.id, attachment.path, options);
      await this.telegram.sendAttachment(
        this.mirrorChatId,
        { ...attachment, bytes, caption: attachment.caption || "Desktop prompt attachment" },
        replyOptions,
      );
    }
    const reply = await this.grok.waitForReply(agent.id, clientNonce, {
      ...waitOptions,
      onApproval: (entry) => this.sendApproval(this.mirrorChatId, agent.id, entry, {
        ...options,
        approvalUserId: this.mirrorUserId,
        replyToMessageId: mirroredPrompt.message_id,
      }),
    });
    if (reply.text) {
      await this.telegram.sendMessage(this.mirrorChatId, reply.text, replyOptions);
    }
    for (const attachment of reply.attachments ?? []) {
      const bytes = await this.grok.readAttachment(agent.id, attachment.path, options);
      await this.telegram.sendAttachment(this.mirrorChatId, { ...attachment, bytes }, replyOptions);
    }
    if (!reply.text && !(reply.attachments ?? []).length) {
      await this.telegram.sendMessage(this.mirrorChatId, "Grok completed without a Telegram-renderable response.", replyOptions);
    }
    if (typeof reply?.messageId !== "string" || !reply.messageId) {
      throw new Error("Grok returned no transcript cursor for the mirrored desktop response");
    }
    await this.state.setMirrorCursor(agent.id, reply.messageId);
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

  async sendRoutineWidget(chatId, agentId, entry, options = {}) {
    const details = routineWidgetDetails(entry);
    if (!details || details.text.length > APPROVAL_TEXT_LIMIT) {
      await this.telegram.sendMessage(
        chatId,
        "This routine choice cannot be displayed safely in Telegram. Open Grok Bot to review it.",
        options,
      );
      return;
    }
    const token = randomBytes(18).toString("base64url");
    const widget = {
      type: "routine-widget",
      agentId,
      entryId: entry.id,
      choices: details.choices,
      chatId,
      userId: options.widgetUserId,
      expiresAt: Date.now() + ROUTINE_WIDGET_TTL_MS,
    };
    await this.state.setApproval(token, widget);
    try {
      const sent = await this.telegram.sendMessage(chatId, details.text, {
        ...options,
        inlineKeyboard: details.choices.map((choice, index) => [{
          text: choice.label,
          callback_data: `gtw:${token}:${index.toString(36)}`,
        }]),
      });
      widget.messageId = sent?.message_id;
      await this.state.setApproval(token, widget);
    } catch (error) {
      await this.state.deleteApproval(token);
      throw error;
    }
  }

  async handleCallbackQuery(update, options = {}) {
    const callback = update?.callback_query;
    if (!this.isAuthorizedCallback(callback)) return;
    const widgetMatch = /^gtw:([A-Za-z0-9_-]{24}):([0-9a-z])$/.exec(callback.data ?? "");
    if (widgetMatch) {
      await this.handleRoutineWidgetCallback(callback, widgetMatch[1], Number.parseInt(widgetMatch[2], 36), options);
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

  async handleRoutineWidgetCallback(callback, token, choiceIndex, options = {}) {
    const widget = this.state.getApproval(token);
    const choice = widget?.choices?.[choiceIndex];
    if (!widget || widget.type !== "routine-widget" || !choice
      || widget.chatId !== callback.message.chat.id
      || widget.userId !== callback.from.id
      || widget.messageId !== callback.message.message_id) {
      await this.telegram.answerCallbackQuery(callback.id, "This option is not valid for this chat.", options);
      return;
    }
    if (widget.expiresAt <= Date.now()) {
      await this.state.deleteApproval(token);
      await this.telegram.editMessageReplyMarkup(widget.chatId, widget.messageId, [], options).catch(() => {});
      await this.telegram.answerCallbackQuery(callback.id, "This option expired.", options);
      return;
    }
    if (widget.resolving) {
      await this.telegram.answerCallbackQuery(callback.id, "That choice is already being processed.", options);
      return;
    }

    widget.resolving = true;
    await this.state.setApproval(token, widget);
    try {
      const clientNonce = `telegram:widget:${token}:${choiceIndex.toString(36)}`;
      await this.grok.sendPrompt(widget.agentId, choice.value, clientNonce, options);
      widget.submitted = true;
      widget.clientNonce = clientNonce;
      await this.state.setApproval(token, widget);
      await this.telegram.editMessageReplyMarkup(widget.chatId, widget.messageId, [], options).catch(() => {});
      await this.telegram.answerCallbackQuery(callback.id, "Sent to Grok.", options).catch(() => {});
      const reply = await this.grok.waitForReply(widget.agentId, clientNonce, options);
      await this.deliverRoutineWidgetReply(widget, reply, options);
      if (typeof reply.messageId === "string" && reply.messageId) {
        await this.state.setMirrorCursor(widget.agentId, reply.messageId);
      }
      await this.state.deleteApproval(token);
    } catch (error) {
      if (this.state.getApproval(token)) {
        widget.resolving = false;
        await this.state.setApproval(token, widget);
      }
      throw error;
    }
  }

  async deliverRoutineWidgetReply(widget, reply, options = {}) {
    const replyOptions = { ...options, replyToMessageId: widget.messageId };
    if (reply.text) await this.telegram.sendMessage(widget.chatId, reply.text, replyOptions);
    for (const attachment of reply.attachments ?? []) {
      const bytes = await this.grok.readAttachment(widget.agentId, attachment.path, options);
      await this.telegram.sendAttachment(widget.chatId, { ...attachment, bytes }, replyOptions);
    }
    if (!reply.text && !(reply.attachments ?? []).length) {
      await this.telegram.sendMessage(widget.chatId, "Grok completed without a Telegram-renderable response.", replyOptions);
    }
  }

  async handleCallbackError(update, options = {}) {
    const callback = update?.callback_query;
    if (!this.isAuthorizedCallback(callback)) return;
    const routineWidget = /^gtw:/.test(callback.data ?? "");
    const routineToken = /^gtw:([A-Za-z0-9_-]{24}):/.exec(callback.data ?? "")?.[1];
    const choiceWasSent = routineToken && this.state.getApproval(routineToken)?.submitted === true;
    await this.telegram.answerCallbackQuery(
      callback.id,
      choiceWasSent
        ? "Choice sent. Reply delivery will retry automatically."
        : routineWidget
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
