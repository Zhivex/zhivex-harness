/** Read-only source inventory for HAR-HU-36. Run with Bun; writes JSON to stdout. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript-compiler-api";
import { sourceDependencies } from "./check-architecture.js";

const root = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const manifest = JSON.parse(await read("package.json"));
const baseline = JSON.parse(await read("contracts/public-api.json"));
const source = ts.createSourceFile("index.ts", await read("src/index.ts"), ts.ScriptTarget.Latest, true);
const exports: { name: string; kind: string; tier: string; source: string }[] = [];
for (const statement of source.statements) {
  if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)
    || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    throw new Error("Review inventory extraction: expected explicit named root re-exports");
  }
  for (const item of statement.exportClause.elements) {
    const kind = statement.isTypeOnly || item.isTypeOnly ? "Type" : "Runtime";
    const name = item.name.text;
    const tiers = ["stable", "beta", "experimental"].filter(tier => baseline[`${tier}${kind}Exports`].includes(name));
    if (tiers.length !== 1) throw new Error(`Unclassified root export: ${name}`);
    exports.push({ name, kind: kind.toLowerCase(), tier: tiers[0]!, source: statement.moduleSpecifier.text });
  }
}
for (const kind of ["runtime", "type"]) {
  const actual = exports.filter(item => item.kind === kind).map(item => item.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...baseline[`${kind}Exports`]].sort())) {
    throw new Error(`Root ${kind} export inventory differs from the contract`);
  }
}
const imports: { file: string; target: string; resolved: string; typeOnly: boolean }[] = [];
const visit = async (directory: string): Promise<void> => {
  for (const entry of (await readdir(path.join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await visit(file);
    else if (/\.tsx?$/.test(file)) {
      for (const dependency of sourceDependencies(await read(file))) {
        const resolved = dependency.target.startsWith(".")
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file), dependency.target)).replace(/\.js$/, ".ts")
          : dependency.target;
        // All CLI/Desktop dependencies plus any reverse edge into CLI from the rest of Harness.
        if (file.startsWith("src/cli/") || ["src/cli.ts", "src/cli-entry.ts", "src/acp-cli.ts", "src/service-cli.ts"].includes(file)
          || file.startsWith("desktop/src/") || resolved.startsWith("src/cli/")) {
          imports.push({ file, ...dependency, resolved });
        }
      }
    }
  }
};
await visit("src");
await visit("desktop/src");
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  scope: "Static imports, re-exports, literal dynamic imports/require and import types; not a complete runtime cycle proof",
  package: { name: manifest.name, version: manifest.version, exports: manifest.exports, bin: manifest.bin, engines: manifest.engines },
  counts: Object.fromEntries(["stable", "beta", "experimental"].map(tier => [tier, {
    runtime: exports.filter(item => item.tier === tier && item.kind === "runtime").length,
    type: exports.filter(item => item.tier === tier && item.kind === "type").length
  }])),
  exports,
  imports,
  cliContract: baseline.cli,
  schemaContract: baseline.schemas
}, null, 2)}\n`);
