import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript-compiler-api";

export interface SourceDependency { target: string; typeOnly: boolean }

/** Includes re-exports and literal dynamic imports, not just import declarations. */
export const sourceDependencies = (source: string): SourceDependency[] => {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const dependencies: SourceDependency[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node)
        ? Boolean(node.importClause?.isTypeOnly || (node.importClause && !node.importClause.name && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(item => item.isTypeOnly)))
        : Boolean(node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly)));
      dependencies.push({ target: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) dependencies.push({ target: argument.text, typeOnly: false });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      dependencies.push({ target: node.argument.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return dependencies;
};

const desktopSurfaces = new Set(["protocol", "providers", "runtime", "persistence"].map(name => `src/internal/desktop/${name}.ts`));
const resolveSource = (file: string, target: string) => path.posix.normalize(path.posix.join(path.posix.dirname(file), target)).replace(/\.js$/, ".ts");

export const architectureViolations = (file: string, source: string): string[] => {
  const violations: string[] = [];
  if (/^src\/[^/]+\.tsx?$/.test(file) && !["src/index.ts", "src/cli.ts", "src/service-cli.ts", "src/acp-cli.ts", "src/version.ts"].includes(file)) {
    violations.push(`${file}: place implementation modules in their responsibility folder`);
  }
  for (const dependency of sourceDependencies(source)) {
    const target = dependency.target.startsWith(".") ? resolveSource(file, dependency.target) : dependency.target;
    const reject = (reason: string) => violations.push(`${file} -> ${dependency.target}: ${reason}`);
    if (file.startsWith("desktop/src/") && target.startsWith("src/") && !desktopSurfaces.has(target)) {
      reject("Desktop must consume an explicit internal/desktop surface");
    }
    if (file.startsWith("src/") && target.startsWith("desktop/")) reject("the runtime must not depend on Desktop");
    if (file === "src/client/protocol.ts" && !dependency.typeOnly && target !== "zod") {
      reject("the wire protocol may load only its schema library");
    }
    if (file === "src/internal/desktop/protocol.ts" && !dependency.typeOnly && target !== "src/client/protocol.ts") {
      reject("the Desktop protocol surface must not load host implementations");
    }
    if (file.startsWith("src/cli/") && target === "src/cli.ts") reject("CLI modules must not import their executable facade");
    if (file.startsWith("src/tools/") && !dependency.typeOnly && target === "src/runtime/harness.ts") {
      reject("tool implementations must not load the harness composition root");
    }
  }
  return violations;
};

export const checkArchitecture = async (root: string): Promise<string[]> => {
  const violations: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file);
      else if (/\.tsx?$/.test(entry.name)) violations.push(...architectureViolations(file, await readFile(path.join(root, file), "utf8")));
    }
  };
  await visit("src");
  await visit("desktop/src");
  return violations;
};

if (import.meta.main) {
  const violations = await checkArchitecture(path.resolve(import.meta.dir, ".."));
  if (violations.length) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Architecture boundaries passed.\n");
}
