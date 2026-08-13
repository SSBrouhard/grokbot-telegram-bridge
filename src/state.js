import { constants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function promptTurnBoundaryKey(agentId, clientNonce) {
  return JSON.stringify([agentId, clientNonce]);
}

export class JsonStateStore {
  constructor(filename) {
    this.filename = filename;
    this.offset = 0;
    this.agentsByChat = {};
    this.pendingApprovals = {};
    this.mirrorEnabled = undefined;
    this.mirrorCursors = {};
    this.promptTurnBoundaries = {};
    this.promptContexts = {};
    this.retiredPromptTurns = {};
    this.pendingDeliveries = {};
    this.saveQueue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const descriptor = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw;
      try {
        const metadata = await descriptor.stat();
        if (!metadata.isFile()) throw new Error("BRIDGE_STATE_PATH must be a regular file");
        if ((metadata.mode & 0o077) !== 0) {
          throw new Error("BRIDGE_STATE_PATH must not be readable or writable by group or others");
        }
        raw = await descriptor.readFile("utf8");
      } finally {
        await descriptor.close();
      }
      const parsed = JSON.parse(raw);
      this.offset = Number.isSafeInteger(parsed.offset) ? parsed.offset : 0;
      this.agentsByChat = parsed.agentsByChat && typeof parsed.agentsByChat === "object"
        ? parsed.agentsByChat
        : {};
      this.pendingApprovals = parsed.pendingApprovals && typeof parsed.pendingApprovals === "object"
        ? parsed.pendingApprovals
        : {};
      this.mirrorEnabled = typeof parsed.mirrorEnabled === "boolean" ? parsed.mirrorEnabled : undefined;
      this.mirrorCursors = parsed.mirrorCursors && typeof parsed.mirrorCursors === "object"
        ? parsed.mirrorCursors
        : {};
      this.promptTurnBoundaries = parsed.promptTurnBoundaries
        && typeof parsed.promptTurnBoundaries === "object"
        ? parsed.promptTurnBoundaries
        : {};
      this.promptContexts = parsed.promptContexts && typeof parsed.promptContexts === "object"
        ? parsed.promptContexts
        : {};
      this.retiredPromptTurns = parsed.retiredPromptTurns && typeof parsed.retiredPromptTurns === "object"
        ? parsed.retiredPromptTurns
        : {};
      this.pendingDeliveries = parsed.pendingDeliveries && typeof parsed.pendingDeliveries === "object"
        ? parsed.pendingDeliveries
        : {};
      const approvalsChanged = this.#pruneExpiredApprovals();
      const promptContextsChanged = this.#preparePromptContextsAfterLoad();
      if (approvalsChanged || promptContextsChanged) await this.#save();
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (!(error instanceof SyntaxError)) throw error;
      const quarantined = `${this.filename}.corrupt-${Date.now()}`;
      await rename(this.filename, quarantined);
      console.error(`Unreadable bridge state moved to ${quarantined}`);
    }
  }

  getAgent(chatId) {
    return this.agentsByChat[String(chatId)];
  }

  async setAgent(chatId, agentId) {
    this.agentsByChat[String(chatId)] = agentId;
    await this.#save();
  }

  isMirrorEnabled(configured) {
    return configured && this.mirrorEnabled !== false;
  }

  async setMirrorEnabled(enabled) {
    this.mirrorEnabled = enabled;
    await this.#save();
  }

  getMirrorCursor(agentId) {
    const cursor = this.mirrorCursors[agentId];
    return cursor?.initialized === true ? cursor : undefined;
  }

  async setMirrorCursor(agentId, entryId) {
    this.mirrorCursors[agentId] = {
      initialized: true,
      entryId: typeof entryId === "string" && entryId ? entryId : null,
    };
    await this.#save();
  }

  getPromptTurnBoundary(agentId, clientNonce) {
    const boundary = this.promptTurnBoundaries[promptTurnBoundaryKey(agentId, clientNonce)];
    return typeof boundary === "string" && boundary ? boundary : undefined;
  }

  async setPromptTurnBoundary(agentId, clientNonce, entryId) {
    const key = promptTurnBoundaryKey(agentId, clientNonce);
    if (Object.hasOwn(this.retiredPromptTurns, key)) return false;
    this.promptTurnBoundaries[key] = entryId;
    await this.#save();
    return true;
  }

  getPromptContext(agentId, clientNonce) {
    return this.promptContexts[promptTurnBoundaryKey(agentId, clientNonce)];
  }

  listPromptContexts(agentId) {
    return Object.entries(this.promptContexts).flatMap(([key, context]) => {
      try {
        const [contextAgentId, clientNonce] = JSON.parse(key);
        return contextAgentId === agentId ? [{ clientNonce, ...context }] : [];
      } catch {
        return [];
      }
    });
  }

  listPromptContextAgentIds() {
    return [...new Set(Object.keys(this.promptContexts).flatMap((key) => {
      try {
        const [agentId] = JSON.parse(key);
        return typeof agentId === "string" && agentId ? [agentId] : [];
      } catch {
        return [];
      }
    }))];
  }

  async setPromptContext(agentId, clientNonce, context) {
    this.promptContexts[promptTurnBoundaryKey(agentId, clientNonce)] = context;
    await this.#save();
  }

  async deletePromptContext(agentId, clientNonce) {
    delete this.promptContexts[promptTurnBoundaryKey(agentId, clientNonce)];
    await this.#save();
  }

  async deletePromptTurnBoundary(agentId, clientNonce) {
    delete this.promptTurnBoundaries[promptTurnBoundaryKey(agentId, clientNonce)];
    await this.#save();
  }

  async retirePromptTurn(agentId, clientNonce, entryId) {
    const key = promptTurnBoundaryKey(agentId, clientNonce);
    delete this.promptTurnBoundaries[key];
    this.retiredPromptTurns[key] = entryId;
    const keys = Object.keys(this.retiredPromptTurns);
    for (const expiredKey of keys.slice(0, Math.max(0, keys.length - 200))) {
      delete this.retiredPromptTurns[expiredKey];
    }
    await this.#save();
  }

  listPromptTurnBoundaries(agentId) {
    const boundaries = [];
    for (const [key, entryId] of Object.entries(this.promptTurnBoundaries)) {
      try {
        const [boundaryAgentId, clientNonce] = JSON.parse(key);
        if (boundaryAgentId === agentId && typeof clientNonce === "string"
          && typeof entryId === "string" && entryId) boundaries.push({ clientNonce, entryId });
      } catch {}
    }
    return boundaries;
  }

  listPromptTurnBoundaryAgentIds() {
    const agentIds = [];
    for (const key of Object.keys(this.promptTurnBoundaries)) {
      try {
        const [agentId, clientNonce] = JSON.parse(key);
        if (typeof agentId === "string" && agentId && typeof clientNonce === "string" && clientNonce) {
          agentIds.push(agentId);
        }
      } catch {}
    }
    return [...new Set(agentIds)];
  }

  async setOffset(offset) {
    this.offset = offset;
    await this.#save();
  }

  getApproval(token) {
    return this.pendingApprovals[token];
  }

  async setApproval(token, approval) {
    this.#pruneExpiredApprovals();
    this.pendingApprovals[token] = approval;
    await this.#save();
  }

  async deleteApproval(token) {
    delete this.pendingApprovals[token];
    await this.#save();
  }

  getDeliveryProgress(key) {
    return this.pendingDeliveries[key];
  }

  async setDeliveryProgress(key, progress) {
    this.pendingDeliveries[key] = progress;
    await this.#save();
  }

  async deleteDeliveryProgress(key) {
    delete this.pendingDeliveries[key];
    await this.#save();
  }

  #pruneExpiredApprovals(now = Date.now()) {
    let changed = false;
    for (const [token, approval] of Object.entries(this.pendingApprovals)) {
      if (Number.isFinite(approval?.expiresAt) && approval.expiresAt <= now) {
        delete this.pendingApprovals[token];
        changed = true;
      }
    }
    return changed;
  }

  #preparePromptContextsAfterLoad() {
    let changed = false;
    for (const context of Object.values(this.promptContexts)) {
      if (context?.awaitingCompletion === true) {
        context.awaitingCompletion = false;
        changed = true;
      }
    }
    return changed;
  }

  async #save() {
    const save = async () => {
      const temporary = `${this.filename}.${process.pid}.tmp`;
      const payload = `${JSON.stringify({
        offset: this.offset,
        agentsByChat: this.agentsByChat,
        pendingApprovals: this.pendingApprovals,
        ...(this.mirrorEnabled === undefined ? {} : { mirrorEnabled: this.mirrorEnabled }),
        ...(Object.keys(this.mirrorCursors).length ? { mirrorCursors: this.mirrorCursors } : {}),
        ...(Object.keys(this.promptTurnBoundaries).length
          ? { promptTurnBoundaries: this.promptTurnBoundaries }
          : {}),
        ...(Object.keys(this.promptContexts).length ? { promptContexts: this.promptContexts } : {}),
        ...(Object.keys(this.retiredPromptTurns).length
          ? { retiredPromptTurns: this.retiredPromptTurns }
          : {}),
        ...(Object.keys(this.pendingDeliveries).length ? { pendingDeliveries: this.pendingDeliveries } : {}),
      })}\n`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.filename);
    };
    const pending = this.saveQueue.then(save, save);
    this.saveQueue = pending.catch(() => {});
    await pending;
  }
}
