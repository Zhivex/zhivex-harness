import { HARNESS_VERSION } from "../version.js";
/** Executable identity only; never changes persistence paths or scopes. */
export let terminalVersion = HARNESS_VERSION;
export function setTerminalVersion(version: string): void { terminalVersion = version; }
