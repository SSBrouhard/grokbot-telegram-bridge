import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HANDOFF_NOTICE = "Grok Bot needs an approval, secret, or rich interaction. Open Grok Bot on desktop to handle it safely.";
const OUTBOUND_ATTACHMENT_LIMIT = 20 * 1024 * 1024;

function unwrap(payload) {
  return payload?.result ?? payload;
}

export function isTopLevelPromptEntry(entry) {
  return entry?.kind === "message"
    && entry.role !== "assistant"
    && !entry.toAgent
    && !entry.fromAgent;
}

export class GrokClient {
  constructor(baseUrl, token, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetch = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 10 * 60_000;
  }

  async command(method, args = {}, options = {}) {
    const timeout = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(args),
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error(`Grok gateway ${method} failed with HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(`Grok gateway ${method} rejected the request`);
    return unwrap(payload);
  }

  async listAgents(options = {}) {
    const payload = await this.command("listAgents", {}, options);
    return Array.isArray(payload) ? payload : (payload.agents ?? []);
  }

  async getAgentWorkflows(agentId, options = {}) {
    const payload = await this.command("getAgentWorkflows", { id: agentId }, options);
    return Array.isArray(payload) ? payload : (payload.workflows ?? []);
  }

  async listMcpServers(options = {}) {
    const settings = await this.command("getHostSettings", {}, options);
    const serverIdentifiers = Array.isArray(settings?.mcpBoxServers)
      ? settings.mcpBoxServers.filter((identifier) => typeof identifier === "string" && identifier)
      : [];
    if (!serverIdentifiers.length) return [];
    const payload = await this.command("listBoxMcpServers", { serverIdentifiers }, options);
    return Array.isArray(payload) ? payload : (payload.servers ?? []);
  }

  async sendPrompt(agentId, prompt, clientNonce = randomUUID(), options = {}) {
    const attachmentPaths = options.attachmentPaths ?? [];
    const attachmentNames = options.attachmentNames ?? [];
    const result = await this.command("sendPrompt", {
      agentId,
      prompt,
      clientNonce,
      directAddressedAcceptance: true,
      ...(options.richText ? { richText: options.richText } : {}),
      ...(attachmentPaths.length ? { attachmentPaths, attachmentNames } : {}),
    }, options);
    if (result?.accepted === false) throw new Error("Grok did not accept the prompt");
    return { ...result, clientNonce };
  }

  async uploadAttachment(agentId, filename, bytes, options = {}) {
    const result = await this.command("uploadAttachment", {
      agentId,
      filename,
      bytesBase64: Buffer.from(bytes).toString("base64"),
    }, options);
    if (typeof result?.path !== "string" || !result.path) {
      throw new Error("Grok attachment upload returned no path");
    }
    return result.path;
  }

  async getTranscript(agentId, options = {}) {
    const payload = await this.command("getAgentTranscript", { id: agentId }, options);
    return Array.isArray(payload) ? payload : (payload.entries ?? payload.transcript ?? []);
  }

  async getTranscriptTail(agentId, limit = 200, options = {}) {
    const payload = await this.command("getAgentTranscriptTail", { id: agentId, limit }, options);
    return Array.isArray(payload) ? payload : (payload.entries ?? []);
  }

  async resolveAutoReviewApproval(agentId, entryId, requestId, approved, options = {}) {
    return this.command("resolveAutoReviewApproval", {
      agentId,
      entryId,
      requestId,
      resolution: approved ? "approved" : "denied",
    }, options);
  }

  async resolveLocalToolPermission(agentId, entryId, requestId, approved, options = {}) {
    return this.command("resolveLocalToolPermission", {
      agentId,
      entryId,
      requestId,
      resolution: approved ? "allow-once" : "deny",
    }, options);
  }

  async getPendingApproval(agentId, entryId, requestId, options = {}) {
    let entries;
    try {
      entries = await this.getTranscriptTail(agentId, 200, options);
    } catch (error) {
      if (!/HTTP 404$/.test(error.message)) throw error;
      entries = await this.getTranscript(agentId, options);
    }
    let entry = entries.find((candidate) => candidate?.id === entryId);
    if (!entry) {
      entries = await this.getTranscript(agentId, options);
      entry = entries.find((candidate) => candidate?.id === entryId);
    }
    if (entry?.kind !== "send-message") return undefined;
    if (entry.message?.type === "auto-review-approval"
      && entry.message.approval?.status === "pending"
      && entry.message.approval?.requestId === requestId) return entry;
    if (entry.message?.type === "local-tool-permission"
      && entry.message.ask?.status === "pending"
      && entry.message.ask?.requestId === requestId) return entry;
    return undefined;
  }

  async readAttachment(agentId, path, options = {}) {
    if (path.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(path);
      if (!match) throw new Error("Grok returned an unsupported data attachment");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > OUTBOUND_ATTACHMENT_LIMIT) {
        throw new Error("Grok data attachment is empty or exceeds 20 MB");
      }
      return new Uint8Array(bytes);
    }
    let gatewayPath = path;
    if (path.startsWith("file:")) {
      try {
        gatewayPath = fileURLToPath(path);
      } catch {
        throw new Error("Grok returned an invalid file attachment URL");
      }
    }
    const parts = [];
    let offset = 0;
    let totalSize;
    while (totalSize === undefined || offset < totalSize) {
      const chunk = await this.command("readAttachmentChunk", {
        agentId,
        path: gatewayPath,
        offset,
        length: Math.min(8 * 1024 * 1024, OUTBOUND_ATTACHMENT_LIMIT - offset),
      }, options);
      if (!chunk || typeof chunk.bytesBase64 !== "string" || !Number.isSafeInteger(chunk.totalSize)) {
        throw new Error("Grok attachment could not be read");
      }
      totalSize = chunk.totalSize;
      if (totalSize > OUTBOUND_ATTACHMENT_LIMIT) throw new Error("Grok attachment exceeds 20 MB");
      const bytes = Buffer.from(chunk.bytesBase64, "base64");
      if (bytes.byteLength === 0 && offset < totalSize) throw new Error("Grok attachment read stalled");
      parts.push(bytes);
      offset += bytes.byteLength;
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  getMessageText(entry) {
    const message = entry?.message;
    if (entry?.kind !== "send-message" || message?.type !== "text") return HANDOFF_NOTICE;
    return message.content?.trim() || HANDOFF_NOTICE;
  }

  getPromptContent(entry) {
    if (entry?.kind !== "message") return undefined;
    const message = entry?.message;
    const textCandidates = [
      typeof entry?.prompt === "string" ? entry.prompt : undefined,
      typeof entry?.content === "string" ? entry.content : undefined,
      typeof entry?.text === "string" ? entry.text : undefined,
      typeof message?.content === "string" ? message.content : undefined,
      typeof message?.text === "string" ? message.text : undefined,
    ];
    const text = textCandidates.find((candidate) => candidate?.trim())?.trim() ?? "";
    const attachments = [];
    let unavailableAttachmentCount = 0;
    const attachmentPaths = Array.isArray(entry?.attachmentPaths) ? entry.attachmentPaths : [];
    const attachmentNames = Array.isArray(entry?.attachmentNames) ? entry.attachmentNames : [];
    for (const [index, attachmentPath] of attachmentPaths.entries()) {
      if (typeof attachmentPath !== "string" || !attachmentPath) {
        unavailableAttachmentCount += 1;
        continue;
      }
      attachments.push({
        path: attachmentPath,
        filename: typeof attachmentNames[index] === "string" && attachmentNames[index]
          ? attachmentNames[index]
          : attachmentPath.split("/").at(-1) || "desktop-attachment.bin",
      });
    }
    if (attachmentNames.length > attachmentPaths.length) {
      unavailableAttachmentCount += attachmentNames.length - attachmentPaths.length;
    }
    if (Array.isArray(message?.images)) {
      for (const image of message.images) {
        if (typeof image?.url === "string" && image.url) {
          attachments.push({
            path: image.url,
            filename: image.url.split("/").at(-1) || "desktop-image.png",
            caption: typeof image?.alt === "string" ? image.alt : undefined,
          });
        } else {
          unavailableAttachmentCount += 1;
        }
      }
    }
    if (Array.isArray(entry?.attachments)) {
      for (const attachment of entry.attachments) {
        const attachmentPath = typeof attachment?.path === "string"
          ? attachment.path
          : typeof attachment?.url === "string" ? attachment.url : undefined;
        if (!attachmentPath) {
          unavailableAttachmentCount += 1;
          continue;
        }
        attachments.push({
          path: attachmentPath,
          filename: (typeof attachment?.file_name === "string" && attachment.file_name)
            || (typeof attachment?.filename === "string" && attachment.filename)
            || attachmentPath.split("/").at(-1)
            || "desktop-attachment.bin",
          caption: typeof attachment?.alt === "string" ? attachment.alt : undefined,
        });
      }
    }
    return { text, attachments, unavailableAttachmentCount };
  }

  getReplyContent(entries) {
    const textParts = [];
    const attachments = [];
    let requiresDesktop = false;
    for (const entry of entries) {
      if (entry?.kind !== "send-message") continue;
      const message = entry.message;
      if (message?.type === "text") {
        if (message.content?.trim()) textParts.push(message.content.trim());
        for (const image of message.images ?? []) {
          if (typeof image?.url === "string") {
            attachments.push({ path: image.url, filename: image.url.split("/").at(-1) || "grok-image.png", caption: image.alt });
          }
        }
      } else if (message?.type === "attachment" && typeof message.url === "string") {
        attachments.push({
          path: message.url,
          filename: message.file_name || message.url.split("/").at(-1) || "grok-attachment.bin",
          caption: message.alt,
        });
      } else {
        requiresDesktop = true;
      }
    }
    return {
      text: textParts.at(-1) || (requiresDesktop && attachments.length === 0 ? HANDOFF_NOTICE : ""),
      attachments,
    };
  }

  async isAgentBusy(agentId, options = {}) {
    const agent = await this.getAgentStatus(agentId, options);
    return agent?.isRunning === true || agent?.isComposingMessage === true;
  }

  async getAgentStatus(agentId, options = {}) {
    const agents = await this.listAgents(options);
    return agents.find((candidate) => candidate.id === agentId);
  }

  replyResult(entries) {
    const result = { messageId: entries.at(-1).id, ...this.getReplyContent(entries) };
    Object.defineProperty(result, "entries", { value: entries });
    return result;
  }

  ownedReplyEntries(replyEntries, completionCandidateId) {
    if (typeof completionCandidateId !== "string" || !completionCandidateId) return replyEntries;
    const completedReplyIndex = replyEntries.findIndex((entry) => entry?.id === completionCandidateId);
    return completedReplyIndex >= 0 ? replyEntries.slice(0, completedReplyIndex + 1) : replyEntries;
  }

  async waitForReply(agentId, clientNonce, options = {}) {
    const deadline = Date.now() + this.replyTimeoutMs;
    let retryDelayMs = this.pollIntervalMs;
    let lastError;
    let promptObserved = false;
    let busyReplyObserved = false;
    let completionCandidateId;
    let stableReplySignature;
    let stableReplySince;
    const announcedApprovals = new Set();
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      try {
        let entries;
        try {
          entries = await this.getTranscriptTail(agentId, 200, options);
        } catch (error) {
          if (!/HTTP 404$/.test(error.message)) throw error;
          entries = await this.getTranscript(agentId, options);
        }
        const matchesPrompt = (entry) => isTopLevelPromptEntry(entry)
          && ((typeof clientNonce === "string" && entry?.clientNonce === clientNonce)
            || (typeof options.promptEntryId === "string" && entry?.id === options.promptEntryId));
        let promptIndex = entries.findIndex(matchesPrompt);
        if (promptIndex < 0 && !promptObserved) {
          entries = await this.getTranscript(agentId, options);
          promptIndex = entries.findIndex(matchesPrompt);
        }
        if (promptIndex >= 0) {
          promptObserved = true;
          const replyBoundaryIndex = typeof options.completedReplyMessageId === "string"
            ? entries.findIndex((entry, index) => index > promptIndex
              && entry?.id === options.completedReplyMessageId)
            : -1;
          const nextPromptOffset = entries.slice(promptIndex + 1)
            .findIndex(isTopLevelPromptEntry);
          const turnEnd = replyBoundaryIndex >= 0
            ? replyBoundaryIndex + 1
            : nextPromptOffset < 0 ? entries.length : promptIndex + 1 + nextPromptOffset;
          const replyEntries = entries.slice(promptIndex + 1, turnEnd)
            .filter((entry) => entry?.kind === "send-message");
          for (const entry of replyEntries) {
            const pendingAutoReview = entry.message?.type === "auto-review-approval"
              && entry.message.approval?.status === "pending";
            const pendingLocalTool = entry.message?.type === "local-tool-permission"
              && entry.message.ask?.status === "pending";
            if ((pendingAutoReview || pendingLocalTool) && !announcedApprovals.has(entry.id)) {
              announcedApprovals.add(entry.id);
              await options.onApproval?.(entry);
            }
          }
          if (replyBoundaryIndex >= 0 && replyEntries.length) {
            return this.replyResult(replyEntries);
          }
          if (replyEntries.length) {
            const agent = await this.getAgentStatus(agentId, options);
            const busy = agent?.isRunning === true || agent?.isComposingMessage === true;
            if (busy) {
              busyReplyObserved = true;
              stableReplySignature = undefined;
              stableReplySince = undefined;
              // Freeze the live completion witness only while the agent is busy.
              // Never treat the later current lastMessageId as reply ownership.
              if (typeof agent?.lastMessageId === "string"
                && replyEntries.some((entry) => entry?.id === agent.lastMessageId)) {
                completionCandidateId = agent.lastMessageId;
              }
            } else if (busyReplyObserved) {
              return this.replyResult(this.ownedReplyEntries(replyEntries, completionCandidateId));
            } else {
              const signature = replyEntries.map((entry, index) => entry?.id ?? `entry-${index}`).join(":");
              if (signature !== stableReplySignature) {
                stableReplySignature = signature;
                stableReplySince = Date.now();
              } else if (Date.now() - stableReplySince >= Math.max(5_000, this.pollIntervalMs * 2)) {
                return this.replyResult(this.ownedReplyEntries(replyEntries, completionCandidateId));
              }
            }
          }
        } else if (promptObserved) {
          const replyEntries = entries.filter((entry) => entry?.kind === "send-message");
          if (replyEntries.length) {
            const agent = await this.getAgentStatus(agentId, options);
            const busy = agent?.isRunning === true || agent?.isComposingMessage === true;
            if (busy) {
              busyReplyObserved = true;
              if (typeof agent?.lastMessageId === "string"
                && replyEntries.some((entry) => entry?.id === agent.lastMessageId)) {
                completionCandidateId = agent.lastMessageId;
              }
            } else if (busyReplyObserved) {
              return this.replyResult(this.ownedReplyEntries(replyEntries, completionCandidateId));
            }
          }
        }
        lastError = undefined;
        retryDelayMs = this.pollIntervalMs;
      } catch (error) {
        if (error.name === "AbortError" || (error.name === "TimeoutError" && options.signal?.aborted)) throw error;
        lastError = error;
        retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await sleep(Math.min(retryDelayMs, remainingMs), undefined, { signal: options.signal });
      }
    }
    if (lastError) throw new Error("Timed out waiting for Grok after gateway errors", { cause: lastError });
    throw new Error("Timed out waiting for Grok to finish");
  }
}

export { HANDOFF_NOTICE };
