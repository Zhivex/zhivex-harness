import { providerDescriptor, type HarnessProvider } from "./config.js";
import { PROVIDERS } from "./providers.js";

export interface SecretEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(value: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}
export interface CredentialInput {
  select<T>(title: string, items: readonly { value: T; label: string; detail?: string }[]): Promise<T | undefined>;
  secret(prompt: string): Promise<string>;
}
export type EntryFactory = (provider: string) => Promise<SecretEntry>;
export const credentialService = "ai.zhivex.harness.cli";
export const validCredential = (value: string) => /^[\x21-\x7e]{1,8192}$/.test(value);

export const nativeCredentialEntry: EntryFactory = async provider => {
  if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) throw new Error("Unsupported credential provider.");
  if (!["darwin", "linux"].includes(process.platform) || process.env.ZHIVEX_HARNESS_CREDENTIAL_STORE === "disabled") {
    throw new Error("Secure credential storage is unavailable.");
  }
  const { AsyncEntry } = await import("@napi-rs/keyring");
  // Require Secret Service explicitly: no kernel-keyring or plaintext fallback.
  const entry = new AsyncEntry(credentialService, provider, { linux: { store: "secret-service" } });
  return {
    getPassword: () => entry.getPassword(AbortSignal.timeout(30_000)),
    setPassword: value => entry.setPassword(value, AbortSignal.timeout(30_000)),
    deleteCredential: () => entry.deleteCredential(AbortSignal.timeout(30_000)),
  };
};

/** CLI session only. Never put this object or its secrets in run metadata or process.env. */
export class CliCredentials {
  private readonly temporary = new Map<string, string>();
  revision = 0;
  constructor(private readonly entry: EntryFactory = nativeCredentialEntry,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly write: (text: string) => void = text => { process.stderr.write(text); }) {}

  private environmentKey(provider: HarnessProvider) {
    return providerDescriptor(provider).credentialNames.map(name => this.environment[name]?.trim()).find(Boolean);
  }
  private validate(value: string): string {
    if (!validCredential(value)) throw new Error("Invalid API key: use 1–8192 printable characters without whitespace.");
    return value;
  }
  private async saved(provider: HarnessProvider): Promise<string | undefined> {
    try {
      const value = await (await this.entry(provider)).getPassword();
      return value == null ? undefined : this.validate(value);
    } catch { throw new Error("Secure storage is unavailable or locked. Unlock it, use a temporary key, or configure the environment."); }
  }
  async configure(provider: HarnessProvider, input: CredentialInput): Promise<boolean> {
    if (this.environmentKey(provider)) {
      this.write("An environment key takes precedence. Remove it from the launching shell to use managed credentials.\n");
    }
    const action = await input.select(`Credentials / ${provider}`, [
      { value: "save", label: "Save or replace in system keychain" },
      { value: "temporary", label: "Temporary key for this CLI session" },
      { value: "delete", label: "Remove saved and temporary key" },
      { value: "cancel", label: "Back" },
    ]);
    if (!action || action === "cancel") return false;
    if (action === "delete") {
      const confirm = await input.select(`Remove managed key for ${provider}?`, [
        { value: false, label: "Keep key" }, { value: true, label: "Remove key" },
      ]);
      if (!confirm) return false;
      try { await (await this.entry(provider)).deleteCredential(); this.write("Saved key removed (or already absent).\n"); }
      catch { this.write("Saved key could not be removed: secure storage is unavailable or locked.\n"); }
      this.temporary.delete(provider);
      this.revision++;
      this.write("Temporary key cleared. Environment credentials are unchanged.\n");
      return true;
    }
    // Open the backend before requesting a secret; failure never silently changes storage mode.
    let target: SecretEntry | undefined;
    if (action === "save") {
      try { target = await this.entry(provider); }
      catch { this.write("Secure storage is unavailable. Choose temporary use or configure an environment key.\n"); return false; }
    }
    let secret = await input.secret("API key (hidden; Enter submits, Ctrl+C cancels): ");
    if (!secret) return false;
    secret = this.validate(secret);
    if (action === "save") {
      try { await target!.setPassword(secret); }
      catch { throw new Error("API key was not saved: secure storage is unavailable or locked. No plaintext fallback was used."); }
      this.temporary.delete(provider);
      this.write("API key saved in the system keychain.\n");
    } else {
      this.temporary.set(provider, secret);
      this.write("API key is available only for this CLI session.\n");
    }
    this.revision++;
    return true;
  }
  async providerEnvironment(provider: HarnessProvider, input: CredentialInput): Promise<NodeJS.ProcessEnv> {
    if (this.environmentKey(provider)) return { ...this.environment };
    // Managed credentials must not be redirected by shell-defined endpoint overrides.
    const endpointVariables: Record<string, string[]> = {
      openai: ["OPENAI_BASE_URL"], meta: ["META_BASE_URL"], gemini: ["GEMINI_BASE_URL"],
      qwen: ["QWEN_BASE_URL", "QWEN_REGION", "QWEN_WORKSPACE_ID"],
    };
    if ((endpointVariables[provider] ?? []).some(name => this.environment[name]?.trim())) {
      throw new Error("Managed keys require the provider's default endpoint. Remove endpoint overrides or supply an explicit environment key.");
    }
    let key = this.temporary.get(provider);
    if (!key) {
      try { key = await this.saved(provider); }
      catch { this.write("Secure storage is unavailable or locked; temporary use remains available.\n"); }
    }
    if (!key) {
      this.write(`No API key available for ${provider}.\n`);
      if (!await this.configure(provider, input)) throw new Error("Credential setup cancelled. No provider request was sent.");
      key = this.temporary.get(provider) ?? await this.saved(provider);
    }
    if (!key) throw new Error("No API key available. No provider request was sent.");
    const name = providerDescriptor(provider).credentialNames[0]!;
    return { ...this.environment, [name]: key };
  }
  clear() { this.temporary.clear(); }
}

/** Keep provider error payloads out of durable runs when they can contain a key. */
export async function credentialModel(
  config: { provider: HarnessProvider; model: string }, env: NodeJS.ProcessEnv,
  modelFactory?: typeof import("./config.js").createProviderModel,
) {
  const { createProviderModel } = await import("./config.js");
  const { wrapLanguageModel } = await import("@zhivex-ai/core");
  const secrets = providerDescriptor(config.provider).credentialNames.map(name => env[name]).filter((value): value is string => !!value);
  const safeError = (error: unknown) => {
    let message = error instanceof Error ? error.message : "Provider request failed.";
    for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
    // Do not forward cause, headers, request objects or arbitrary provider fields.
    const safe = new Error(message);
    if (error instanceof Error && error.name === "AbortError") safe.name = "AbortError";
    return safe;
  };
  const model = (modelFactory ?? createProviderModel)(config, env);
  return wrapLanguageModel(model, [{
    name: "cli-credential-errors",
    wrapGenerate: async (_context, next) => {
      try { return await next(); } catch (error) { throw safeError(error); }
    },
    wrapStream: async (_context, next) => {
      let events;
      try { events = await next(); } catch (error) { throw safeError(error); }
      return (async function* () {
        try {
          for await (const event of events) {
            if (event.type === "error") throw safeError(event.error);
            yield event;
          }
        } catch (error) { throw safeError(error); }
      })();
    },
  }]);
}
