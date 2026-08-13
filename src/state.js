import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStateStore {
  constructor(filename) {
    this.filename = filename;
    this.offset = 0;
    this.agentsByChat = {};
    this.pendingApprovals = {};
    this.saveQueue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filename, "utf8"));
      this.offset = Number.isSafeInteger(parsed.offset) ? parsed.offset : 0;
      this.agentsByChat = parsed.agentsByChat && typeof parsed.agentsByChat === "object"
        ? parsed.agentsByChat
        : {};
      this.pendingApprovals = parsed.pendingApprovals && typeof parsed.pendingApprovals === "object"
        ? parsed.pendingApprovals
        : {};
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

  async setOffset(offset) {
    this.offset = offset;
    await this.#save();
  }

  getApproval(token) {
    return this.pendingApprovals[token];
  }

  async setApproval(token, approval) {
    this.pendingApprovals[token] = approval;
    await this.#save();
  }

  async deleteApproval(token) {
    delete this.pendingApprovals[token];
    await this.#save();
  }

  async #save() {
    const save = async () => {
      const temporary = `${this.filename}.${process.pid}.tmp`;
      const payload = `${JSON.stringify({
        offset: this.offset,
        agentsByChat: this.agentsByChat,
        pendingApprovals: this.pendingApprovals,
      })}\n`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filename);
    };
    const pending = this.saveQueue.then(save, save);
    this.saveQueue = pending.catch(() => {});
    await pending;
  }
}
