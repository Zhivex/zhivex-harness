import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "../src/MessageMarkdown.js";

test("assistant Markdown renders headings, numbered plans, emphasis, tables and code", () => {
  const html = renderToStaticMarkup(<MessageMarkdown text={'## Plan\n1. **Enable conformance**\n2. Verify `npm test`\n\n```js\nconst safe = "<script>";\n```\n\n| Check | Result |\n|---|---|\n| Offline | Passed |'} />);
  expect(html).toContain("<h2>Plan</h2>"); expect(html).toContain("<ol>");
  expect(html).toContain("<strong>Enable conformance</strong>");
  expect(html).toContain("<code>npm test</code>"); expect(html).toContain("<table>");
  expect(html).toContain("&lt;script&gt;");
});
test("Markdown never executes HTML, script links or remote images", () => {
  const html = renderToStaticMarkup(<MessageMarkdown text={'<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[execute](javascript:alert%281%29)\n\n![probe](https://attacker.invalid/track)\n\n[Docs](https://example.com/docs)'} />);
  expect(html).not.toContain("<img"); expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror"); expect(html).not.toContain("javascript:");
  expect(html).not.toContain("attacker.invalid"); expect(html).toContain("[Image: probe]");
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).toContain('rel="noreferrer noopener"');
});
