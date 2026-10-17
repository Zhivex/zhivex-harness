import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "../src/ModelPicker.js";
import type { WebModelChoice } from "../src/contracts.js";

const choices: WebModelChoice[] = [
  {
    provider: "openai", providerName: "OpenAI", model: "gpt-6-astra", name: "gpt-6-astra",
    configured: true, capabilities: ["chat", "tools", "vision"], validation: "verified",
    contextWindow: { tokens: 1050000, type: "combined" },
    cost: { currency: "USD", inputPerMillionTokens: 10, outputPerMillionTokens: 50 },
  },
  {
    provider: "gemini", providerName: "Gemini", model: "fixture-missing", name: "Fixture missing",
    configured: false, capabilities: ["chat", "tools"], validation: "unverified",
    contextWindow: { tokens: 1050000, type: "combined" },
    cost: { currency: "USD", inputPerMillionTokens: 10, outputPerMillionTokens: 50 },
  },
];

function picker(extra: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  return renderToStaticMarkup(<ModelPicker
    choices={choices}
    currentKey="openai/gpt-6-astra"
    currentLabel="gpt-6-astra · OpenAI"
    configured
    disabled={false}
    pendingReview={false}
    loading={false}
    unavailable={false}
    selectionError=""
    open
    workspaceKey="atlas"
    onOpenChange={() => {}}
    onApply={() => {}}
    favoriteToggle={{ current: null }}
    {...extra}
  />);
}

test("configured rows stay on one line with chips, separated meta and a trailing star", () => {
  const html = picker();
  expect(html).toContain("Configured only");
  expect(html).toContain('checked=""');
  expect(html).toContain("gpt-6-astra");
  expect(html).toContain("Images");
  expect(html).toContain("1,050,000 tokens · $10 in / $50 out per 1M");
  expect(html).not.toContain("tokens$10");
  expect(html).not.toContain("No credentials");
  expect(html).not.toContain("Fixture missing");
  expect(html).toContain("Add gpt-6-astra to favorites");
  expect(html).toContain('class="model-option"');
  expect(html).not.toContain("<small>");
});

test("unconfigured providers collapse behind one CLI hint", () => {
  const html = picker({ configuredOnlyDefault: false });
  expect(html.match(/Configure credentials in the CLI\./g)).toEqual(["Configure credentials in the CLI."]);
  expect(html).toContain("1 provider without credentials");
  expect(html).not.toContain("No credentials");
});
