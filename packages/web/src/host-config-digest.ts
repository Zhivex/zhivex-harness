import { createHash } from "node:crypto";
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
/** Recognition only: no host is constructed from persisted configuration. */
export const hostConfigDigest = (config: unknown) => `sha256:${createHash("sha256").update(canonical(config)).digest("hex")}`;
