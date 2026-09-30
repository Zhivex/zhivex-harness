import { expect, test } from "bun:test";
import { missingLiveReleaseConfig } from "../scripts/check-live-release-config.js";

test("release configuration fails closed before paid calls and reports names only", () => {
  const env = Object.fromEntries(["OPENAI_API_KEY", "MODEL_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
    "GOOGLE_CLOUD_PROJECT", "VERTEX_LOCATION", "VERTEX_WORKLOAD_IDENTITY_PROVIDER", "VERTEX_SERVICE_ACCOUNT",
    "DASHSCOPE_API_KEY"].map(name => [name, "private-canary"]));
  expect(missingLiveReleaseConfig(env)).toEqual([]);
  env.ANTHROPIC_API_KEY = " "; delete env.VERTEX_SERVICE_ACCOUNT;
  expect(missingLiveReleaseConfig(env)).toEqual(["ANTHROPIC_API_KEY", "VERTEX_SERVICE_ACCOUNT"]);
  delete env.DASHSCOPE_API_KEY;
  expect(missingLiveReleaseConfig(env)).toContain("QWEN_API_KEY or DASHSCOPE_API_KEY");
  env.QWEN_API_KEY = "private-canary";
  expect(missingLiveReleaseConfig(env)).not.toContain("QWEN_API_KEY or DASHSCOPE_API_KEY");
});
