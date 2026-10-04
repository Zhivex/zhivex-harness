import { spawn } from "node:child_process";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessConfigInput,
  ZhivexHarness,
} from "@zhivex-ai/harness/engine";
import { attachRuntime, type WebRuntime } from "./runtime.js";
import { startWebServer } from "./server.js";
import { selectWebServiceDirectory, webStartupDiagnostic } from "./service-directory.js";
import { manageWebRuntime } from "./managed-runtime.js";
import type { WebModelChoice } from "./contracts.js";

export const WEB_HELP = `Usage: zhivex-code web [options]

Open a local browser workspace using the same Harness engine and durable sessions.

  --workspace <path>         Workspace to allow (repeat up to 8; default: current directory)
  --provider <name>          Host provider, or use the configured default profile
  --model <name>             Host model
  --profile <name>           Existing CLI profile
  --state-dir <path>         Existing Harness state directory (one workspace only)
  --tool-policy <path>       Existing Harness tool policy
  --port <number>            Loopback port (default: a free port)
  --recover                 Explicitly recover a proven dead service owner
  --no-open                 Run without opening a browser (for process supervision)
  --help                    Show this help

Credentials are read on the server from the launching environment or existing OS store.
Use zhivex-code init to configure credentials before launching. Ctrl+C shuts down.
macOS/Linux only. Local HTTP still requires the authentication and origin checks.`;

export function parseWebArgs(args: string[]) {
  const workspaces: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (["--recover", "--no-open", "--help"].includes(name)) {
      if (flags.has(name)) throw new Error("WEB_USAGE_INVALID");
      flags.add(name);
      continue;
    }
    if (
      ![
        "--workspace",
        "--provider",
        "--model",
        "--profile",
        "--state-dir",
        "--tool-policy",
        "--port",
      ].includes(name) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith("--")
    )
      throw new Error("WEB_USAGE_INVALID");
    const value = args[++i]!;
    if (name === "--workspace") {
      workspaces.push(value);
      if (workspaces.length > 8) throw new Error("WEB_USAGE_INVALID");
    } else {
      if (values[name] !== undefined) throw new Error("WEB_USAGE_INVALID");
      values[name] = value;
    }
  }
  const port = values["--port"] === undefined ? 0 : Number(values["--port"]);
  if (
    (values["--port"] !== undefined && !/^\d+$/.test(values["--port"])) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (values["--state-dir"] !== undefined && workspaces.length > 1)
  )
    throw new Error("WEB_USAGE_INVALID");
  return {
    workspaces: workspaces.length ? workspaces : [process.cwd()],
    values,
    port,
    recover: flags.has("--recover"),
    open: !flags.has("--no-open"),
    help: flags.has("--help"),
  };
}

async function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore", shell: false });
    child.once("error", () => reject(new Error("WEB_BROWSER_OPEN_FAILED")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("WEB_BROWSER_OPEN_FAILED")),
    );
  });
}

export async function runWebCli(
  args: string[],
  assetsDirectory: string,
  create: (
    input: HarnessConfigInput,
    profile?: string,
  ) => Promise<{ harness: ZhivexHarness; secrets: readonly string[] }>,
  modelChoices?: () => Promise<WebModelChoice[]>,
) {
  const runtimes: WebRuntime[] = [];
  try {
    const parsed = parseWebArgs(args);
    if (parsed.help) {
      process.stdout.write(WEB_HELP + "\n");
      return;
    }
    if (!["darwin", "linux"].includes(process.platform))
      throw new Error("WEB_PLATFORM_UNSUPPORTED");
    const serviceDirectory = await selectWebServiceDirectory();
    const seen = new Set<string>();
    for (const input of parsed.workspaces) {
      const workspace = await realpath(path.resolve(input));
      if (!(await lstat(workspace)).isDirectory() || seen.has(workspace))
        throw new Error("WEB_WORKSPACE_INVALID");
      seen.add(workspace);
      const v = parsed.values;
      const configuration: HarnessConfigInput = {
          workspace,
          ...(v["--provider"] ? { provider: v["--provider"] } : {}),
          ...(v["--model"] ? { model: v["--model"] } : {}),
          ...(v["--state-dir"]
            ? { stateDirectory: path.resolve(v["--state-dir"]) }
            : {}),
          ...(v["--tool-policy"]
            ? { toolPolicyFile: path.resolve(v["--tool-policy"]) }
            : {}),
        };
      const configured = await create(configuration, v["--profile"]);
      try {
        const runtime = await attachRuntime(
            configured.harness,
            serviceDirectory,
            parsed.recover,
            configured.secrets,
          );
        runtimes.push(modelChoices ? manageWebRuntime(runtime, modelChoices, async selection => {
          const next = await create({...configuration, ...selection}, v["--profile"]);
          return {
            attach: () => attachRuntime(next.harness, serviceDirectory, false, next.secrets),
            dispose: () => next.harness.close(),
          };
        }) : runtime);
      } catch (e) {
        await configured.harness.close();
        throw e;
      }
    }
    const server = await startWebServer({
      runtimes,
      assetsDirectory,
      port: parsed.port,
    });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.close().catch(() => {
        process.stderr.write("WEB_SHUTDOWN_FAILED\n");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // Never print the pairing capability or provider/transport credentials.
    process.stdout.write(
      `Zhivex Code web listening at ${server.origin}\nCtrl+C to stop.\n`,
    );
    if (parsed.open)
      try {
        await openBrowser(server.launchUrl);
      } catch {
        stop();
        throw new Error("WEB_BROWSER_OPEN_FAILED");
      }
  } catch (e) {
    await Promise.allSettled(runtimes.map((r) => r.close()));
    const code = webStartupDiagnostic(e);
    process.stderr.write(`${code}. Use zhivex-code web --help.\n`);
    process.exitCode = 1;
  }
}
