import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";

const valid = {
  TELEGRAM_BOT_TOKEN: "123:test-token",
  TELEGRAM_ALLOWED_USER_IDS: "42, 43",
  TELEGRAM_ALLOWED_CHAT_IDS: "99",
  GROK_GATEWAY_URL: "http://127.0.0.1:4321",
  GROK_GATEWAY_TOKEN: "gateway-token",
};

test("loads a locked-down configuration", () => {
  const config = loadConfig(valid);

  assert.deepEqual(config.allowedUserIds, new Set([42, 43]));
  assert.deepEqual(config.allowedChatIds, new Set([99]));
  assert.equal(config.gatewayUrl, "http://127.0.0.1:4321");
  assert.equal(config.defaultAgent, "Chief of Staff");
});

test("loads paired desktop mirror IDs only when both are allowlisted", () => {
  const config = loadConfig({
    ...valid,
    GROK_DESKTOP_MIRROR_CHAT_ID: "99",
    GROK_DESKTOP_MIRROR_USER_ID: "42",
  });
  assert.equal(config.mirrorChatId, 99);
  assert.equal(config.mirrorUserId, 42);

  assert.throws(() => loadConfig({
    ...valid,
    GROK_DESKTOP_MIRROR_CHAT_ID: "99",
  }), /must be set together/);
  assert.throws(() => loadConfig({
    ...valid,
    GROK_DESKTOP_MIRROR_CHAT_ID: "100",
    GROK_DESKTOP_MIRROR_USER_ID: "42",
  }), /CHAT_ID must be in TELEGRAM_ALLOWED_CHAT_IDS/);
  assert.throws(() => loadConfig({
    ...valid,
    GROK_DESKTOP_MIRROR_CHAT_ID: "99",
    GROK_DESKTOP_MIRROR_USER_ID: "44",
  }), /USER_ID must be in TELEGRAM_ALLOWED_USER_IDS/);
});

for (const key of [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "GROK_GATEWAY_URL",
]) {
  test(`rejects missing ${key}`, () => {
    const env = { ...valid };
    delete env[key];
    assert.throws(() => loadConfig(env), new RegExp(key));
  });
}

test("rejects a missing Grok gateway credential", () => {
  const env = { ...valid };
  delete env.GROK_GATEWAY_TOKEN;
  assert.throws(() => loadConfig(env), /GROK_GATEWAY_TOKEN/);
});

test("reads the existing gateway token from a private discovery record", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-config-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const filename = path.join(directory, "gateway.json");
  writeFileSync(filename, JSON.stringify({ token: "from-file" }), { mode: 0o600 });
  const env = { ...valid, GROK_GATEWAY_TOKEN_FILE: filename };
  delete env.GROK_GATEWAY_TOKEN;

  assert.equal(loadConfig(env).gatewayToken, "from-file");
  chmodSync(filename, 0o644);
  assert.throws(() => loadConfig(env), /group or others/);

  const symlink = path.join(directory, "gateway-link.json");
  symlinkSync(filename, symlink);
  assert.throws(() => loadConfig({ ...env, GROK_GATEWAY_TOKEN_FILE: symlink }));
});

test("rejects a non-loopback Grok gateway by default", () => {
  assert.throws(
    () => loadConfig({ ...valid, GROK_GATEWAY_URL: "http://192.168.1.10:4321" }),
    /loopback/,
  );
});

test("rejects malformed allowlist IDs", () => {
  assert.throws(
    () => loadConfig({ ...valid, TELEGRAM_ALLOWED_USER_IDS: "42,nope" }),
    /numeric/,
  );
});
