import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_CHARACTERS = 20_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const PORTABLE_ENVIRONMENT_KEYS = [
  "CI",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR"
] as const;

export interface PortableProcessResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunPortableProcessOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  maxOutputCharacters?: number;
  signal?: AbortSignal;
  stderr?: "pipe" | "ignore";
}

class BoundedTextCapture {
  private readonly decoder = new TextDecoder();
  private readonly maxCharacters: number;
  private output = "";
  private totalCharacters = 0;

  constructor(maxCharacters: number) {
    this.maxCharacters = maxCharacters;
  }

  write(chunk: Uint8Array) {
    this.append(this.decoder.decode(chunk, { stream: true }));
  }

  finish() {
    this.append(this.decoder.decode());
    return this.totalCharacters <= this.maxCharacters
      ? this.output
      : `${this.output}\n… output truncated (${this.totalCharacters - this.maxCharacters} characters omitted)`;
  }

  private append(value: string) {
    this.totalCharacters += value.length;
    if (this.output.length < this.maxCharacters) {
      this.output += value.slice(0, this.maxCharacters - this.output.length);
    }
  }
}

const processEnvironment = (additional: RunPortableProcessOptions["env"]): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PORTABLE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(additional ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
};

const exitCodeForSignal = (signal: NodeJS.Signals | null) => {
  if (signal === "SIGKILL") return 137;
  if (signal === "SIGTERM") return 143;
  return 1;
};

const abortReason = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");

export const runPortableProcess = async (
  command: readonly string[],
  options: RunPortableProcessOptions = {}
): Promise<PortableProcessResult> => {
  if (command.length === 0 || !command[0]) throw new Error("The process command must not be empty.");
  if (options.signal?.aborted) throw abortReason(options.signal);

  const maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
  if (!Number.isSafeInteger(maxOutputCharacters) || maxOutputCharacters < 0) {
    throw new Error("maxOutputCharacters must be a non-negative safe integer.");
  }
  if (options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("timeoutMs must be a positive safe integer.");
  }

  const argv = [...command];
  const stdout = new BoundedTextCapture(maxOutputCharacters);
  const stderr = new BoundedTextCapture(maxOutputCharacters);
  const child = spawn(argv[0]!, argv.slice(1), {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: processEnvironment(options.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let timedOut = false;
  let aborted = false;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;

  child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));

  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    terminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, DEFAULT_TERMINATION_GRACE_MS);
    terminationTimer.unref?.();
  };
  const handleAbort = () => {
    aborted = true;
    terminate();
  };
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
  timeout?.unref?.();

  try {
    return await new Promise<PortableProcessResult>((resolve, reject) => {
      let processError: Error | undefined;
      child.once("error", (error) => {
        processError = error;
      });
      child.once("close", (exitCode, signal) => {
        if (processError) {
          reject(processError);
          return;
        }
        if (aborted && options.signal) {
          reject(abortReason(options.signal));
          return;
        }
        resolve({
          command: argv,
          exitCode: exitCode ?? exitCodeForSignal(signal),
          stdout: stdout.finish(),
          stderr: options.stderr === "ignore" ? "" : stderr.finish(),
          timedOut
        });
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (terminationTimer) clearTimeout(terminationTimer);
    options.signal?.removeEventListener("abort", handleAbort);
  }
};
