import path from "node:path";
import { createHarness, type CreateHarnessOptions } from "./harness.js";
import { resolveHarnessConfig } from "./config.js";
import { usagePricingSchema } from "./usage-ledger.js";
import { readRegularFileNoFollow } from "../workspace/file-security.js";

/** Trusted product composition shared by Code and Assistant; no terminal or credentials UI. */
export interface CreateCodingHarnessOptions extends CreateHarnessOptions {
  pricingFile?: string;
  usageLimitUsd?: number;
}

export async function createCodingHarness(options: CreateCodingHarnessOptions) {
  const { pricingFile, usageLimitUsd, ...engine } = options;
  if (usageLimitUsd !== undefined && resolveHarnessConfig(engine).costBudget) {
    throw new Error("Choose one monetary policy: --usage-limit-usd or the legacy cost budget.");
  }
  return createHarness({
    ...engine,
    projectMemory: options.projectMemory ?? true,
    usageAccounting: {
      ...options.usageAccounting,
      ...(pricingFile ? { pricing: usagePricingSchema.parse(JSON.parse((await readRegularFileNoFollow(path.resolve(pricingFile), { maxBytes: 128 * 1024, label: "Usage pricing" })).contents.toString("utf8"))) } : {}),
      ...(usageLimitUsd !== undefined ? { limitUsd: usageLimitUsd } : {}),
    },
  });
}
