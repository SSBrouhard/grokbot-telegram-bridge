const TRAILING_BOUNDARY = /[\s.,!?;:)}\]]/u;

function normalize(value) {
  return value.trim().toLocaleLowerCase();
}

function candidateToken(candidate) {
  return `@${candidate.label}`;
}

export function findStructuredReferences(text, candidates) {
  const counts = new Map();
  for (const candidate of candidates) {
    const key = normalize(candidate.label);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unambiguous = candidates
    .filter((candidate) => candidate.id && candidate.label && counts.get(normalize(candidate.label)) === 1)
    .sort((left, right) => right.label.length - left.label.length);
  const lowerText = text.toLocaleLowerCase();
  const references = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@" || (index > 0 && !/[\s(]/u.test(text[index - 1]))) continue;
    const candidate = unambiguous.find((item) => {
      const token = candidateToken(item);
      if (!lowerText.startsWith(token.toLocaleLowerCase(), index)) return false;
      const next = text[index + token.length];
      return next === undefined || TRAILING_BOUNDARY.test(next);
    });
    if (!candidate) continue;
    const end = index + candidateToken(candidate).length;
    references.push({ start: index, end, ...candidate });
    index = end - 1;
  }
  return references;
}

function referenceNode(reference) {
  if (reference.type === "mention") {
    return { type: "mention", attrs: { id: reference.id, label: reference.label } };
  }
  return {
    type: "workflowReference",
    attrs: {
      id: reference.id,
      label: reference.label,
      iconId: reference.iconId ?? null,
      iconUrl: reference.iconUrl ?? null,
    },
  };
}

function paragraphContent(text, lineStart, lineEnd, references) {
  const content = [];
  let cursor = lineStart;
  for (const reference of references) {
    if (reference.start < lineStart || reference.end > lineEnd) continue;
    if (reference.start > cursor) content.push({ type: "text", text: text.slice(cursor, reference.start) });
    content.push(referenceNode(reference));
    cursor = reference.end;
  }
  if (cursor < lineEnd) content.push({ type: "text", text: text.slice(cursor, lineEnd) });
  return content;
}

export function buildRichText(text, references) {
  if (!references.length) return undefined;
  const content = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length;
    const nodes = paragraphContent(text, lineStart, lineEnd, references);
    content.push({ type: "paragraph", ...(nodes.length ? { content: nodes } : {}) });
    lineStart = lineEnd + 1;
  }
  return JSON.stringify({ type: "doc", content });
}
