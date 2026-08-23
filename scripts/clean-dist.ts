import { rm } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dir, "..");
const outputDirectory = path.join(workspace, "dist");

if (path.dirname(outputDirectory) !== workspace || path.basename(outputDirectory) !== "dist") {
  throw new Error("Refusing to clean an unexpected build output directory");
}

await rm(outputDirectory, { force: true, recursive: true });
