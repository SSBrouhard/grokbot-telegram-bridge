import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonStateStore } from "../src/state.js";

test("persists Telegram offset and selected agent atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-"));
  const filename = path.join(directory, "state.json");
  const store = new JsonStateStore(filename);

  await store.load();
  await store.setOffset(17);
  await store.setAgent(99, "agent-123");

  const reloaded = new JsonStateStore(filename);
  await reloaded.load();
  assert.equal(reloaded.offset, 17);
  assert.equal(reloaded.getAgent(99), "agent-123");
  const raw = await readFile(filename, "utf8");
  assert.equal(raw, '{"offset":17,"agentsByChat":{"99":"agent-123"},"pendingApprovals":{}}\n');
  assert.deepEqual(JSON.parse(raw), {
    offset: 17,
    agentsByChat: { 99: "agent-123" },
    pendingApprovals: {},
  });
});

test("quarantines malformed state and starts cleanly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-"));
  const filename = path.join(directory, "state.json");
  await writeFile(filename, "not json\n");
  const store = new JsonStateStore(filename);

  await store.load();

  assert.equal(store.offset, 0);
  assert.equal(store.getAgent(99), undefined);
  assert.match((await readdir(directory))[0], /^state\.json\.corrupt-/);
});
