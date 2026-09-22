import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownResponse } from "../src/MarkdownResponse.js";
import { FileDiff } from "../src/FileDiff.js";
import { externalUrl } from "../src/external-url.js";
import {
  readPreference,
  writePreference,
  eventPollDelay,
} from "../src/local-preferences.js";
import { applyActivityPage, emptyActivity } from "../src/activity.js";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
test("drafts remain isolated across projects, sessions and storage failure", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const p = crypto.randomUUID();
  expect(writePreference("draft", p, "a", "first draft")).toBe(true);
  expect(writePreference("draft", p, "b", "second draft")).toBe(true);
  expect(readPreference("draft", p, "a")).toBe("first draft");
  expect(readPreference("draft", p + "other", "a")).toBe("");
  writePreference("draft", p, "a", "");
  expect(readPreference("draft", p, "b")).toBe("second draft");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw Error("storage unavailable");
    },
  });
  expect(writePreference("draft", p, "b", "unsaved on disk")).toBe(false);
  expect(readPreference("draft", p, "b")).toBe("unsaved on disk");
});
test("empty and replayed event pages do not copy a large conversation", () => {
  const activity = emptyActivity();
  activity.cursor = 10;
  activity.runs.r = {
    text: "a".repeat(262144),
    status: "completed",
    truncated: false,
  };
  activity.order.push("r");
  expect(
    applyActivityPage(activity, {
      schemaVersion: 1,
      cursorExpired: false,
      nextCursor: 10,
      events: [],
    }),
  ).toBe(activity);
  expect(eventPollDelay(100, 0, false)).toBe(2000);
  expect(eventPollDelay(0, 100, false)).toBe(30000);
  expect(eventPollDelay(0, 0, true)).toBe(5000);
  expect(eventPollDelay(0, 0, false)).toBe(100);
});
test("Markdown keeps executable HTML, images and unsafe protocols inert", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownResponse, {
      text: "# Title\n\n**Bold** [safe](https://example.com) [bad](javascript:alert%281%29) ![remote](https://example.com/pixel)\n\n<script>alert(1)</script>\n\n```js\n<img onerror=alert(1)>\n```",
    }),
  );
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<strong>Bold</strong>");
  expect(html).toContain('href="https://example.com/"');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("Copy code");
  expect(html).toContain("&lt;img");
});
test("external links accept only absolute web URLs without credentials", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "//example.com",
    "mailto:a@b.com",
    "https://example.com/\n",
    123,
  ])
    expect(externalUrl(url)).toBeUndefined();
  expect(externalUrl("https://example.com/docs?q=x#test")).toBe(
    "https://example.com/docs?q=x#test",
  );
});
test("diff displays changed lines while retaining exact complete contents", () => {
  const html = renderToStaticMarkup(
    createElement(FileDiff, {
      before: "same\r\nbefore\r\nlast",
      after: "same\r\nafter <script>\r\nlast",
    }),
  );
  expect(html).toContain("diff-added");
  expect(html).toContain("diff-removed");
  expect(html).toContain("Next change");
  expect(html).toContain("same\r\nbefore\r\nlast");
  expect(html).toContain("after &lt;script&gt;");
  expect(html).not.toContain("<script>");
});
