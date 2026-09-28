import type { CredentialInput } from "./cli-credentials.js";

const regions = {
  singapore: ["Singapore", "ap-southeast-1", "dashscope-intl.aliyuncs.com"],
  beijing: ["Beijing", "cn-beijing", "dashscope.aliyuncs.com"],
  "hong-kong": ["Hong Kong", "cn-hongkong", "cn-hongkong.dashscope.aliyuncs.com"],
  tokyo: ["Tokyo", "ap-northeast-1", ""],
  frankfurt: ["Frankfurt", "eu-central-1", ""],
  virginia: ["Virginia", "us-east-1", ""],
} as const;
export type QwenConnection = { service: "api"; region: keyof typeof regions; workspace?: string } | { service: "token-plan" };
export function qwenEndpoint(connection: QwenConnection): string {
  if (connection.service === "token-plan") return "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1";
  if (connection.service !== "api" || !Object.hasOwn(regions, connection.region)) throw new Error("Invalid Qwen connection.");
  const [, region, legacy] = regions[connection.region];
  if (connection.workspace !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(connection.workspace)) throw new Error("Invalid Qwen workspace ID.");
  const host = connection.workspace ? `${connection.workspace}.${region}.maas.aliyuncs.com` : legacy;
  if (!host) throw new Error("This Qwen region requires a workspace ID.");
  return `https://${host}/compatible-mode/v1`;
}
export function decodeQwenCredential(value: string): { key: string; connection: QwenConnection } {
  // Existing raw keys remain bound to the historical Singapore API endpoint.
  if (!value.startsWith("{")) return { key: value, connection: { service: "api", region: "singapore" } };
  const parsed = JSON.parse(value);
  if (parsed.version !== 1 || typeof parsed.key !== "string" || !parsed.connection) throw new Error("Invalid Qwen credential record.");
  qwenEndpoint(parsed.connection);
  return { key: parsed.key, connection: parsed.connection };
}
export async function selectQwenConnection(input: CredentialInput): Promise<QwenConnection | undefined> {
  const service = await input.select("Qwen / Service", [
    { value: "api", label: "Standard API / Alibaba Cloud Model Studio", detail: "Use the region where your API key was created" },
    { value: "token-plan", label: "QwenCloud Token Plan", detail: "Separate subscription endpoint and credential" },
  ]);
  if (!service) return;
  if (service === "token-plan") return { service };
  const region = await input.select("Qwen / API region", Object.entries(regions).map(([value, [label]]) => ({ value: value as keyof typeof regions, label })));
  if (!region) return;
  let workspace: string | undefined;
  const dedicated = !regions[region][2] || await input.select<boolean | "cancel">("Qwen / Endpoint", [
    { value: false, label: "DashScope endpoint", detail: "Existing regional API endpoint" },
    { value: true, label: "Workspace endpoint", detail: "Enter your workspace ID" },
    { value: "cancel", label: "Back" },
  ]);
  if (dedicated === undefined || dedicated === "cancel") return;
  if (dedicated) {
    if (!input.question) throw new Error("Workspace setup requires interactive input.");
    workspace = (await input.question("Workspace ID (not the API key): ")).trim();
    if (!workspace) return;
  }
  const connection: QwenConnection = { service: "api", region, ...(workspace ? { workspace } : {}) };
  qwenEndpoint(connection);
  return connection;
}
