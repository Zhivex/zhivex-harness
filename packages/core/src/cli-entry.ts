#!/usr/bin/env node
import { nodeEngineError } from "./cli/node-engine.js";
import { shortCliHelp } from "./cli/cli-help.js";
import { HARNESS_VERSION, NODE_ENGINE_RANGE } from "./version.js";

// Bun satisfies its own engine range. Node is checked before help or version
// so an unsupported runtime stops before the engine loads.
if (!process.versions.bun) {
  const engineError = nodeEngineError(process.versions.node, NODE_ENGINE_RANGE);
  if (engineError) {
    process.stderr.write(engineError);
    process.exit(1);
  }
}

// Only unambiguous informational invocations bypass the full argument parser.
// Mixed flags, command help and errors retain the existing CLI semantics.
const argv = process.argv.slice(2);
if (argv.length === 1 && ["--version", "-v", "version"].includes(argv[0]!)) {
  process.stdout.write(`${HARNESS_VERSION}\n`);
} else if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]!)) {
  process.stdout.write(`${shortCliHelp(HARNESS_VERSION)}\n`);
} else {
  const { runCli } = await import("./cli.js");
  await runCli(argv);
}
