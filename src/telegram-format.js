function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function markdownToTelegramHtml(markdown) {
  const protectedBlocks = [];
  const protect = (html) => {
    const token = `\u0000${protectedBlocks.length}\u0000`;
    protectedBlocks.push(html);
    return token;
  };

  let text = markdown.replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, (_match, code) => (
    protect(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`)
  ));
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => protect(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, rawUrl) => {
    const url = safeUrl(rawUrl);
    return url ? protect(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`) : match;
  });
  text = escapeHtml(text);
  text = text
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>");
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => protectedBlocks[Number(index)]);
}

