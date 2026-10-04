import { appendFileSync } from "node:fs";
import path from "node:path";

// Fixture data stays in an environment value, never in generated JavaScript.
const attemptsFile = process.env.CODE_WEB_PROVIDER_ATTEMPTS_FILE;
if (!attemptsFile || !path.isAbsolute(attemptsFile))
  throw new Error("INSTALLED_SMOKE_ATTEMPTS_FILE_REQUIRED");

globalThis.fetch = async () => {
  appendFileSync(attemptsFile, "attempt\n", { mode: 0o600 });
  throw new Error("INSTALLED_SMOKE_NETWORK_DENIED");
};
