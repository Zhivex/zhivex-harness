#!/usr/bin/env node
import { shortCliHelp } from "./cli/cli-help.js";
import { CODE_VERSION } from "./version.js";

// Only unambiguous informational invocations bypass the full argument parser.
// Mixed flags, command help and errors retain the existing CLI semantics.
const argv = process.argv.slice(2);
if (argv.length === 1 && ["--version", "-v", "version"].includes(argv[0]!)) {
  process.stdout.write(`${CODE_VERSION}\n`);
} else if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]!)) {
  process.stdout.write(`${shortCliHelp(CODE_VERSION)}\n`);
} else {
  const { runCli } = await import("./cli.js");
  await runCli(argv);
}
