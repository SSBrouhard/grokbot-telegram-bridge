import assert from "node:assert/strict";
import test from "node:test";

import { GrokClient } from "../src/grok-client.js";

test("uses Grok's command envelope", async () => {
  const requests = [];
  const responses = [
    { ok: true, json: async () => ({ agents: [{ id: "a1", name: "Chief of Staff" }] }) },
    { ok: true, json: async () => ({ accepted: true }) },
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return responses.shift();
  };
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", { fetchImpl });

  assert.equal((await client.listAgents())[0].id, "a1");
  await client.sendPrompt("a1", "hello", "nonce-1");
  assert.deepEqual(requests.map(({ url }) => url), [
    "http://127.0.0.1:4321/api/listAgents",
    "http://127.0.0.1:4321/api/sendPrompt",
  ]);
  assert.deepEqual(requests[1].body, {
    agentId: "a1",
    prompt: "hello",
    clientNonce: "nonce-1",
    directAddressedAcceptance: true,
  });
  assert.equal(requests[0].headers.authorization, "Bearer gateway-token");
});

test("maps approval decisions only to one-shot or deny resolutions", async () => {
  const requests = [];
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    fetchImpl: async (url, options) => {
      requests.push({ method: url.split("/").at(-1), body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({}) };
    },
  });
  await client.resolveAutoReviewApproval("a1", "e1", "r1", true);
  await client.resolveAutoReviewApproval("a1", "e1", "r1", false);
  await client.resolveLocalToolPermission("a1", "e2", "r2", true);
  await client.resolveLocalToolPermission("a1", "e2", "r2", false);
  assert.deepEqual(requests.map((request) => request.body.resolution), [
    "approved", "denied", "allow-once", "deny",
  ]);
  assert.ok(requests.every((request) => !["always", "never"].includes(request.body.resolution)));
});

test("uploads attachment bytes and includes their paths in sendPrompt", async () => {
  const requests = [];
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return { ok: true, json: async () => url.endsWith("/uploadAttachment")
        ? { path: "/attachments/photo.jpg" }
        : { accepted: true } };
    },
  });
  const path = await client.uploadAttachment("a1", "photo.jpg", new Uint8Array([1, 2, 3]));
  await client.sendPrompt("a1", "look", "nonce", {
    attachmentPaths: [path],
    attachmentNames: ["photo.jpg"],
  });
  assert.equal(requests[0].body.bytesBase64, "AQID");
  assert.deepEqual(requests[1].body.attachmentPaths, ["/attachments/photo.jpg"]);
});

test("loads workflows and forwards Grok composer rich text", async () => {
  const requests = [];
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    fetchImpl: async (url, options) => {
      requests.push({ method: url.split("/").at(-1), body: JSON.parse(options.body) });
      return { ok: true, json: async () => url.endsWith("/getAgentWorkflows")
        ? [{ id: "workflow-1", name: "add-connector", trigger: null }]
        : { accepted: true } };
    },
  });
  assert.equal((await client.getAgentWorkflows("a1"))[0].id, "workflow-1");
  await client.sendPrompt("a1", "@add-connector", "nonce", { richText: "{\"type\":\"doc\"}" });
  assert.equal(requests[1].body.richText, "{\"type\":\"doc\"}");
});

test("lists configured box MCP server statuses without returning host settings", async () => {
  const requests = [];
  const responses = [
    { mcpBoxServers: ["context7", "supabase"] },
    { servers: [
      { serverIdentifier: "context7", status: "connected" },
      { serverIdentifier: "supabase", status: "error" },
    ] },
  ];
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    fetchImpl: async (url, options) => {
      requests.push({ method: url.split("/").at(-1), body: JSON.parse(options.body) });
      return { ok: true, json: async () => responses.shift() };
    },
  });
  assert.deepEqual(await client.listMcpServers(), [
    { serverIdentifier: "context7", status: "connected" },
    { serverIdentifier: "supabase", status: "error" },
  ]);
  assert.deepEqual(requests.map((request) => request.method), ["getHostSettings", "listBoxMcpServers"]);
  assert.deepEqual(requests[1].body, { serverIdentifiers: ["context7", "supabase"] });
});

test("returns a safe handoff notice for non-text messages", async () => {
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token");

  assert.match(client.getMessageText({
    id: "m2",
    kind: "send-message",
    message: { type: "approval-request" },
  }), /Open Grok Bot/);
});

test("collects text, embedded images, and standalone files from a Grok reply", () => {
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token");
  assert.deepEqual(client.getReplyContent([
    { kind: "send-message", message: { type: "text", content: "Done", images: [{ url: "/assets/chart.png", alt: "Chart" }] } },
    { kind: "send-message", message: { type: "attachment", url: "/attachments/report.pdf", file_name: "report.pdf" } },
  ]), {
    text: "Done",
    attachments: [
      { path: "/assets/chart.png", filename: "chart.png", caption: "Chart" },
      { path: "/attachments/report.pdf", filename: "report.pdf", caption: undefined },
    ],
  });
});

test("decodes a bounded data URL attachment", async () => {
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token");
  assert.deepEqual(await client.readAttachment("a1", "data:image/png;base64,AQID"), new Uint8Array([1, 2, 3]));
});

test("normalizes a host file URL before reading attachment bytes", async () => {
  let request;
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        bytesBase64: "AQID",
        totalSize: 3,
        mime: "text/plain",
      }) };
    },
  });
  assert.deepEqual(
    await client.readAttachment("a1", "file:///home/box/attachments/report.txt"),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(request.path, "/home/box/attachments/report.txt");
});

test("correlates a reply to the exact client nonce", async () => {
  const transcripts = [
    [
      { id: "other", kind: "send-message", message: { type: "text", content: "Not yours" } },
      { id: "prompt", kind: "message", clientNonce: "wanted" },
    ],
    [
      { id: "other", kind: "send-message", message: { type: "text", content: "Not yours" } },
      { id: "prompt", kind: "message", clientNonce: "wanted" },
      { id: "reply", kind: "send-message", message: { type: "text", content: "Yours" } },
    ],
    [
      { id: "other", kind: "send-message", message: { type: "text", content: "Not yours" } },
      { id: "prompt", kind: "message", clientNonce: "wanted" },
      { id: "reply", kind: "send-message", message: { type: "text", content: "Yours" } },
    ],
  ];
  let statusCalls = 0;
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    pollIntervalMs: 1,
    replyTimeoutMs: 100,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => url.endsWith("/listAgents")
        ? ({ agents: [{ id: "a1", isRunning: ++statusCalls === 1 }] })
        : ({ entries: transcripts.shift() }),
    }),
  });

  assert.deepEqual(await client.waitForReply("a1", "wanted"), {
    messageId: "reply",
    text: "Yours",
    attachments: [],
  });
});

test("retries a transient transcript failure after prompt acceptance", async () => {
  let calls = 0;
  let statusCalls = 0;
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    pollIntervalMs: 1,
    replyTimeoutMs: 100,
    fetchImpl: async (url) => {
      if (url.endsWith("/listAgents")) {
        return { ok: true, json: async () => ({
          agents: [{ id: "a1", isRunning: ++statusCalls === 1 }],
        }) };
      }
      calls += 1;
      if (calls === 1) throw new Error("temporary disconnect");
      return {
        ok: true,
        json: async () => ({ entries: [
          { kind: "message", clientNonce: "nonce" },
          { id: "reply", kind: "send-message", message: { type: "text", content: "Recovered" } },
        ] }),
      };
    },
  });

  assert.equal((await client.waitForReply("a1", "nonce")).text, "Recovered");
  assert.ok(calls >= 2);
});

test("waits through progress messages and returns the final text plus turn attachments", async () => {
  let transcriptCall = 0;
  let statusCall = 0;
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    pollIntervalMs: 1,
    replyTimeoutMs: 100,
    fetchImpl: async (url) => {
      if (url.endsWith("/listAgents")) {
        statusCall += 1;
        return { ok: true, json: async () => ({
          agents: [{ id: "a1", isRunning: statusCall === 1 }],
        }) };
      }
      transcriptCall += 1;
      const entries = [
        { id: "prompt", kind: "message", clientNonce: "nonce" },
        { id: "progress", kind: "send-message", message: { type: "text", content: "Working..." } },
      ];
      if (transcriptCall > 1) entries.push(
        { id: "file", kind: "send-message", message: { type: "attachment", url: "/attachments/report.txt", file_name: "report.txt" } },
        { id: "final", kind: "send-message", message: { type: "text", content: "Finished." } },
      );
      return { ok: true, json: async () => ({ entries }) };
    },
  });

  assert.deepEqual(await client.waitForReply("a1", "nonce"), {
    messageId: "final",
    text: "Finished.",
    attachments: [{
      path: "/attachments/report.txt",
      filename: "report.txt",
      caption: undefined,
    }],
  });
});

test("announces a pending approval once while continuing to wait", async () => {
  let transcriptCall = 0;
  let statusCall = 0;
  const announced = [];
  const approval = {
    id: "approval-entry",
    kind: "send-message",
    message: { type: "auto-review-approval", approval: { requestId: "r1", status: "pending" } },
  };
  const client = new GrokClient("http://127.0.0.1:4321", "gateway-token", {
    pollIntervalMs: 1,
    replyTimeoutMs: 100,
    fetchImpl: async (url) => {
      if (url.endsWith("/listAgents")) {
        statusCall += 1;
        return { ok: true, json: async () => ({ agents: [{ id: "a1", isRunning: statusCall < 3 }] }) };
      }
      transcriptCall += 1;
      const entries = [{ id: "prompt", kind: "message", clientNonce: "nonce" }, approval];
      if (transcriptCall >= 3) entries.push({ id: "final", kind: "send-message", message: { type: "text", content: "Done" } });
      return { ok: true, json: async () => ({ entries }) };
    },
  });
  const reply = await client.waitForReply("a1", "nonce", { onApproval: async (entry) => announced.push(entry.id) });
  assert.deepEqual(announced, ["approval-entry"]);
  assert.equal(reply.text, "Done");
});
