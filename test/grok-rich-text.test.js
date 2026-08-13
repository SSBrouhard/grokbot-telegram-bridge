import assert from "node:assert/strict";
import test from "node:test";

import { buildRichText, findStructuredReferences } from "../src/grok-rich-text.js";

test("builds Grok composer JSON with agent and workflow references", () => {
  const text = "Ask @Research, then run @Revenue-First Morning.";
  const references = findStructuredReferences(text, [
    { type: "mention", id: "agent-2", label: "Research" },
    { type: "workflowReference", id: "routine-1", label: "Revenue-First Morning" },
  ]);

  assert.deepEqual(JSON.parse(buildRichText(text, references)), {
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: "Ask " },
        { type: "mention", attrs: { id: "agent-2", label: "Research" } },
        { type: "text", text: ", then run " },
        {
          type: "workflowReference",
          attrs: { id: "routine-1", label: "Revenue-First Morning", iconId: null, iconUrl: null },
        },
        { type: "text", text: "." },
      ],
    }],
  });
});

test("matches the longest exact reference and ignores email-like or partial names", () => {
  const candidates = [
    { type: "mention", id: "one", label: "Flagship" },
    { type: "mention", id: "two", label: "Flagship Ops" },
  ];
  const text = "Tell @Flagship Ops, not me@example.com or @FlagshipOperator.";
  assert.deepEqual(findStructuredReferences(text, candidates), [{
    start: 5,
    end: 18,
    type: "mention",
    id: "two",
    label: "Flagship Ops",
  }]);
});

test("does not guess when two structured references have the same label", () => {
  assert.deepEqual(findStructuredReferences("Ask @Shared.", [
    { type: "mention", id: "agent", label: "Shared" },
    { type: "workflowReference", id: "routine", label: "Shared" },
  ]), []);
});
