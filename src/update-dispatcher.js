export class UpdateDispatcher {
  constructor(bridge) {
    this.bridge = bridge;
    this.chatQueues = new Map();
  }

  async dispatch(update, options = {}) {
    if (update?.callback_query) {
      try {
        await this.bridge.handleCallbackQuery(update, options);
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") throw error;
        console.error("Approval callback failed:", error.message);
        await this.bridge.handleCallbackError(update, options);
      }
      return;
    }

    const chatId = update?.message?.chat?.id;
    const key = String(chatId ?? "unknown");
    const previous = this.chatQueues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      try {
        await this.bridge.handleUpdate(update, options);
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") throw error;
        console.error("Bridge update failed:", error.message);
        await this.bridge.handleError(update, options);
      }
    });
    this.chatQueues.set(key, task);
    void task.finally(() => {
      if (this.chatQueues.get(key) === task) this.chatQueues.delete(key);
    }).catch(() => {});
    return task;
  }

  async drain() {
    await Promise.allSettled(this.chatQueues.values());
  }
}
