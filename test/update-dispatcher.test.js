import assert from "node:assert/strict";
import test from "node:test";

import { UpdateDispatcher } from "../src/update-dispatcher.js";

test("processes approval callbacks while the chat prompt is still waiting", async () => {
  let releaseMessage;
  const events = [];
  const bridge = {
    handleUpdate: async () => {
      events.push("message-start");
      await new Promise((resolve) => { releaseMessage = resolve; });
      events.push("message-end");
    },
    handleCallbackQuery: async () => { events.push("callback"); },
    handleError: async () => {},
    handleCallbackError: async () => {},
  };
  const dispatcher = new UpdateDispatcher(bridge);
  const messageTask = dispatcher.dispatch({ message: { chat: { id: 99 } } });
  await new Promise((resolve) => setImmediate(resolve));
  await dispatcher.dispatch({ callback_query: { id: "c1" } });
  assert.deepEqual(events, ["message-start", "callback"]);
  releaseMessage();
  await messageTask;
  await dispatcher.drain();
  assert.deepEqual(events, ["message-start", "callback", "message-end"]);
});
