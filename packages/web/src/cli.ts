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
import { startInteractiveWebRuntime } from "./interactive-startup.js";
import { manageWebRuntime } from "./managed-runtime.js";
import type { WebModelChoice } from "./contracts.js";
import { planRegistrySync, projectFailureCause, removeRegisteredPath, safeRegistryRead } from "./project-registry.js";
import { createHash } from "node:crypto";
import type { UnavailableProject } from "./server.js";

export const WEB_HELP = `Usage: zhivex-code web [options]

Open a local browser workspace using the same Harness engine and durable sessions.

  --workspace <path>         Workspace to allow (repeat up to 8; default: current directory)
  --provider <name>          Host provider, or use the configured default profile
  --model <name>             Host model
  --profile <name>           Existing CLI profile
  --state-dir <path>         Existing Harness state directory (one workspace only)
  --tool-policy <path>       Tool policy for this single workspace (not shared)
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
    (values["--state-dir"] !== undefined && workspaces.length > 1) ||
    (values["--tool-policy"] !== undefined && workspaces.length > 1)
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
    interactive?: boolean,
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
    const tracked = new Map<string, { key: string; source: "flag" | "registry" }>();
    const unavailableProjects: UnavailableProject[] = [];
    const unavailableKeys = new Map<string, string>();
    const v = parsed.values;
    const explicitPolicy = v["--tool-policy"] ? path.resolve(v["--tool-policy"]) : undefined;
    async function openWorkspace(workspace: string, source: "flag" | "registry", toolPolicy?: string) {
      if (seen.has(workspace)) return;
      const configuration: HarnessConfigInput = {
        workspace,
        ...(v["--provider"] ? { provider: v["--provider"] } : {}),
        ...(v["--model"] ? { model: v["--model"] } : {}),
        ...(source === "flag" && v["--state-dir"] ? { stateDirectory: path.resolve(v["--state-dir"]) } : {}),
        ...(toolPolicy ? { toolPolicyFile: toolPolicy } : {}),
      };
      const label = toolPolicy ? path.basename(toolPolicy) : undefined;
      const launch = (interactive: boolean) => create(configuration, v["--profile"], interactive);
      const started = await startInteractiveWebRuntime(launch, configured => attachRuntime(
        configured.harness, serviceDirectory, parsed.recover && source === "flag", configured.secrets, false, label));
      const runtime = modelChoices ? manageWebRuntime(started.runtime, modelChoices, async selection => {
        const next = await create({ ...configuration, ...selection }, v["--profile"], started.interactive);
        return {
          attach: () => attachRuntime(next.harness, serviceDirectory, false, next.secrets, started.legacyPending, label),
          dispose: () => next.harness.close(),
        };
      }) : started.runtime;
      seen.add(workspace);
      tracked.set(workspace, { key: runtime.workspace.key, source });
      return runtime;
    }
    function rememberUnavailable(folder: string, cause: string, source: "flag" | "registry") {
      const key = `unavailable.${createHash("sha256").update(folder).digest("hex").slice(0, 24)}`;
      unavailableKeys.set(folder, key);
      const project: UnavailableProject = {
        key, name: path.basename(folder), workspace: folder, provider: "", model: "",
        unavailable: true, cause, ...(source === "registry" ? {} : {}),
      };
      const index = unavailableProjects.findIndex(item => item.key === key);
      if (index >= 0) unavailableProjects[index] = project;
      else unavailableProjects.push(project);
      return project;
    }
    for (const input of parsed.workspaces) {
      const workspace = await realpath(path.resolve(input));
      if (!(await lstat(workspace)).isDirectory() || seen.has(workspace))
        throw new Error("WEB_WORKSPACE_INVALID");
      const runtime = await openWorkspace(workspace, "flag", explicitPolicy);
      if (!runtime) throw new Error("WEB_WORKSPACE_INVALID");
      runtimes.push(runtime);
    }
    if (!v["--state-dir"]) {
      const registered = await safeRegistryRead();
      if (registered) {
        const plan = planRegistrySync([...tracked].map(([projectPath, value]) => ({ path: projectPath, source: value.source })), registered);
        for (const project of plan.start) {
          try {
            const runtime = await openWorkspace(project.path, "registry", project.toolPolicy);
            if (runtime) runtimes.push(runtime);
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            rememberUnavailable(project.path, projectFailureCause(code, project.path), "registry");
          }
        }
        for (const item of plan.unavailable) rememberUnavailable(item.project.path, item.cause, "registry");
      }
    }
    const server = await startWebServer({
      runtimes,
      unavailable: unavailableProjects,
      assetsDirectory,
      port: parsed.port,
      onForgetProject: async (key) => {
        const found = [...tracked.entries()].find(([, value]) => value.key === key);
        if (!found) {
          const folder = [...unavailableKeys.entries()].find(([, value]) => value === key)?.[0];
          if (folder) await removeRegisteredPath(folder).catch(() => undefined);
          return;
        }
        if (found[1].source === "registry") await removeRegisteredPath(found[0]);
        tracked.delete(found[0]);
        seen.delete(found[0]);
      },
    });
    let registryWarned = false;
    let syncing = false;
    const registryTimer = setInterval(() => {
      if (syncing || v["--state-dir"]) return;
      syncing = true;
      void (async () => {
        const registered = await safeRegistryRead();
        if (!registered) {
          if (!registryWarned) {
            registryWarned = true;
            process.stderr.write("PROJECT_REGISTRY_UNSAFE. Registered projects were not loaded.\n");
          }
          return;
        }
        registryWarned = false;
        const plan = planRegistrySync([...tracked].map(([projectPath, value]) => ({ path: projectPath, source: value.source })), registered);
        for (const folder of plan.detach) {
          const item = tracked.get(folder);
          if (item) await server.directory.detach(item.key);
          tracked.delete(folder);
          seen.delete(folder);
        }
        for (const project of [...plan.start, ...plan.unavailable.map(item => item.project)]) {
          if (plan.unavailable.some(item => item.project.path === project.path) && !plan.start.includes(project)) {
            server.directory.markUnavailable(rememberUnavailable(project.path, plan.unavailable.find(item => item.project.path === project.path)!.cause, "registry"));
            continue;
          }
          try {
            const runtime = await openWorkspace(project.path, "registry", project.toolPolicy);
            if (!runtime) continue;
            const stale = unavailableKeys.get(project.path);
            if (stale) server.directory.clearUnavailable(stale);
            unavailableKeys.delete(project.path);
            if (!server.directory.attach(runtime)) {
              await runtime.close();
              tracked.delete(project.path);
              seen.delete(project.path);
            }
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            server.directory.markUnavailable(rememberUnavailable(project.path, projectFailureCause(code, project.path), "registry"));
          }
        }
      })().catch(() => undefined).finally(() => { syncing = false; });
    }, 1000);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(registryTimer);
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
