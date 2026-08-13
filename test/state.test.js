import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
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
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(raw, '{"offset":17,"agentsByChat":{"99":"agent-123"},"pendingApprovals":{}}\n');
  assert.deepEqual(JSON.parse(raw), {
    offset: 17,
    agentsByChat: { 99: "agent-123" },
    pendingApprovals: {},
  });
});

test("persists per-agent mirror cursors and the enabled override across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-mirror-"));
  const filename = path.join(directory, "state.json");
  const store = new JsonStateStore(filename);
  await store.load();
  await store.setMirrorCursor("chief", "entry-42");
  await store.setMirrorEnabled(false);

  const reloaded = new JsonStateStore(filename);
  await reloaded.load();
  assert.deepEqual(reloaded.getMirrorCursor("chief"), { initialized: true, entryId: "entry-42" });
  assert.equal(reloaded.isMirrorEnabled(true), false);
  assert.equal(reloaded.isMirrorEnabled(false), false);
});

test("prunes expired Telegram actions from persisted state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-actions-"));
  const filename = path.join(directory, "state.json");
  await writeFile(filename, `${JSON.stringify({
    offset: 0,
    agentsByChat: {},
    pendingApprovals: {
      expired: { type: "routine-widget", expiresAt: Date.now() - 1 },
      active: { type: "routine-widget", expiresAt: Date.now() + 60_000 },
    },
  })}\n`, { mode: 0o600 });

  const store = new JsonStateStore(filename);
  await store.load();

  assert.equal(store.getApproval("expired"), undefined);
  assert.equal(store.getApproval("active").type, "routine-widget");
  assert.equal(JSON.parse(await readFile(filename, "utf8")).pendingApprovals.expired, undefined);
});

test("makes an interrupted submitted routine widget recoverable after restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-widget-recovery-"));
  const filename = path.join(directory, "state.json");
  await writeFile(filename, `${JSON.stringify({
    offset: 0,
    agentsByChat: {},
    pendingApprovals: {
      widget: {
        type: "routine-widget",
        submitted: true,
        clientNonce: "telegram:widget:abcdefghijklmnopqrstuvwx:0",
        resolving: true,
        expiresAt: Date.now() + 60_000,
      },
    },
  })}\n`, { mode: 0o600 });

  const store = new JsonStateStore(filename);
  await store.load();

  assert.equal(store.getApproval("widget").submitted, true);
  assert.equal(store.getApproval("widget").submissionIntent, true);
  assert.equal(store.getApproval("widget").resolving, false);
});

test("persists multipart delivery progress across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-delivery-"));
  const filename = path.join(directory, "state.json");
  const store = new JsonStateStore(filename);
  await store.load();
  await store.setDeliveryProgress("autonomous:chief:entry-1", {
    nextPart: 2,
    rootMessageId: 41,
  });

  const reloaded = new JsonStateStore(filename);
  await reloaded.load();

  assert.deepEqual(reloaded.getDeliveryProgress("autonomous:chief:entry-1"), {
    nextPart: 2,
    rootMessageId: 41,
  });
  await reloaded.deleteDeliveryProgress("autonomous:chief:entry-1");
  assert.equal(reloaded.getDeliveryProgress("autonomous:chief:entry-1"), undefined);
});

test("quarantines malformed state and starts cleanly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-"));
  const filename = path.join(directory, "state.json");
  await writeFile(filename, "not json\n", { mode: 0o600 });
  await chmod(filename, 0o600);
  const store = new JsonStateStore(filename);

  await store.load();

  assert.equal(store.offset, 0);
  assert.equal(store.getAgent(99), undefined);
  assert.match((await readdir(directory))[0], /^state\.json\.corrupt-/);
});

test("refuses a state file exposed to group or other users", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-"));
  const filename = path.join(directory, "state.json");
  await writeFile(filename, "{}\n", { mode: 0o644 });
  await chmod(filename, 0o644);

  await assert.rejects(new JsonStateStore(filename).load(), /group or others/);
});

test("refuses a symlinked state file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-"));
  const target = path.join(directory, "target.json");
  const filename = path.join(directory, "state.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, filename);

  await assert.rejects(new JsonStateStore(filename).load());
});
