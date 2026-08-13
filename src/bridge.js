import { randomBytes } from "node:crypto";
import { buildRichText, findStructuredReferences } from "./grok-rich-text.js";

const HELP = [
  "Send text, photos, or file attachments to your selected Grok agent.",
  "",
  "/agents - list agents",
  "/use <exact name> - select an agent",
  "/status - show the selected agent",
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
  constructor({ telegram, grok, state, allowedUserIds, allowedChatIds, defaultAgent }) {
    Object.assign(this, { telegram, grok, state, allowedUserIds, allowedChatIds, defaultAgent });
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
    await this.telegram.answerCallbackQuery(
      callback.id,
      "Could not apply that decision. The request remains unapproved.",
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
