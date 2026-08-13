import assert from "node:assert/strict";
import test from "node:test";

import { markdownToTelegramHtml } from "../src/telegram-format.js";

test("renders common Markdown as safe Telegram HTML", () => {
  assert.equal(
    markdownToTelegramHtml("# Title\n**bold** and `x < y`\n[OpenAI](https://openai.com)"),
    '<b>Title</b>\n<b>bold</b> and <code>x &lt; y</code>\n<a href="https://openai.com/">OpenAI</a>',
  );
});

test("escapes raw HTML and rejects unsafe links", () => {
  assert.match(markdownToTelegramHtml("<script>x</script> [bad](javascript:alert(1))"), /&lt;script&gt;/);
  assert.doesNotMatch(markdownToTelegramHtml("[bad](javascript:alert(1))"), /<a /);
});
