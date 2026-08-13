import path from "node:path";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseIds(env, name) {
  const raw = required(env, name);
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => !/^-?\d+$/.test(value))) {
    throw new Error(`${name} must contain only comma-separated numeric IDs`);
  }
  return new Set(values.map(Number));
}

function positiveInteger(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function gatewayToken(env) {
  const direct = env.GROK_GATEWAY_TOKEN?.trim();
  if (direct) return direct;
  const filename = env.GROK_GATEWAY_TOKEN_FILE?.trim();
  if (!filename) throw new Error("GROK_GATEWAY_TOKEN or GROK_GATEWAY_TOKEN_FILE is required");
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("GROK_GATEWAY_TOKEN_FILE must be a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("GROK_GATEWAY_TOKEN_FILE must not be readable by group or others");
    }
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  try {
    const parsed = JSON.parse(raw);
    const token = parsed.gatewayToken ?? parsed.token;
    if (typeof token === "string" && token.trim()) {
      return token.trim();
    }
  } catch {}
  throw new Error("GROK_GATEWAY_TOKEN_FILE does not contain a recognized gateway token field");
}

export function loadConfig(env = process.env) {
  const gatewayUrl = required(env, "GROK_GATEWAY_URL").replace(/\/$/, "");
  const parsedGateway = new URL(gatewayUrl);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedGateway.hostname)) {
    throw new Error("GROK_GATEWAY_URL must use a loopback host");
  }

  return {
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    allowedUserIds: parseIds(env, "TELEGRAM_ALLOWED_USER_IDS"),
    allowedChatIds: parseIds(env, "TELEGRAM_ALLOWED_CHAT_IDS"),
    gatewayUrl,
    gatewayToken: gatewayToken(env),
    defaultAgent: env.GROK_DEFAULT_AGENT?.trim() || "Chief of Staff",
    statePath: path.resolve(env.BRIDGE_STATE_PATH?.trim() || "bridge-state.json"),
    replyTimeoutMs: positiveInteger(env, "GROK_REPLY_TIMEOUT_MS", 10 * 60_000),
    pollIntervalMs: positiveInteger(env, "GROK_POLL_INTERVAL_MS", 1_000),
  };
}
