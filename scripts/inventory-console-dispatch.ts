import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript-compiler-api";

const root = path.resolve(import.meta.dir, "..");
const inventory = JSON.parse(await readFile(path.join(root, "fixtures/cli-compatibility/inventory.json"), "utf8"));
const collect = async (directory: string): Promise<string[]> => {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => entry.isDirectory() ? collect(`${directory}/${entry.name}`) : Promise.resolve(entry.name.endsWith(".ts") ? [`${directory}/${entry.name}`] : [])));
  return groups.flat().sort();
};
const reports = [];
for (const directory of ["packages/core/src/cli", "packages/cli/src/cli"]) {
  const sources = [];
  for (const file of await collect(directory)) {
    const text = await readFile(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const conditions: { line: number; expression: string; commands: string[] }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node)) {
        const literals = new Set<string>();
        const scan = (child: ts.Node) => {
          if (ts.isStringLiteral(child) && /^\/[a-z][a-z-]*(?:\s|$)/.test(child.text)) literals.add(child.text);
          ts.forEachChild(child, scan);
        };
        scan(node.expression);
        if (literals.size) conditions.push({ line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, expression: node.expression.getText(ast), commands: [...literals].sort() });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (conditions.length) sources.push({ file, sha256: createHash("sha256").update(text).digest("hex"), conditions });
  }
  const catalog = inventory.terminalCommands.find((entry: { source: string }) => entry.source === `${directory}/console/console-commands.ts`);
  if (!catalog) throw new Error(`Missing catalog: ${directory}`);
  const names = new Set<string>(catalog.commands.map((entry: { command: string }) => entry.command));
  const dispatchNames = [...new Set(sources.flatMap(source => source.conditions.flatMap(condition => condition.commands.map(command => command.trim().split(/\s/)[0]!))))].sort();
  reports.push({ directory, sources, dispatchNames, outsideCatalog: dispatchNames.filter(name => !names.has(name)),
    catalogWithoutLiteralCondition: [...names].filter(name => !dispatchNames.includes(name)),
    destination: "Unified CLI over core; keep direct/service capability distinction and aliases until explicit compatibility decision" });
}
console.log(JSON.stringify({ schemaVersion: 1, reports,
  limitations: ["Literal if-condition inventory, not an execution coverage proof", "Dispatch through regexes, helpers or computed commands requires manual review", "Catalog absence does not imply unsupported behavior; condition presence does not prove successful execution"]
}, null, 2));
