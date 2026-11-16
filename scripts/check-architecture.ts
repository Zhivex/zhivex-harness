import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript-compiler-api";
import apiContract from "../contracts/engine-api.json";

export interface SourceDependency { target: string; typeOnly: boolean; computed?: boolean }

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
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      dependencies.push({ target: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) dependencies.push({ target: argument.text, typeOnly: false });
      else dependencies.push({ target: "<computed>", typeOnly: false, computed: true });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      dependencies.push({ target: node.argument.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return dependencies;
};

const desktopPackageImports = new Set(["assistant/managed/setup", "assistant/managed/secrets", "application/protocol", "application/client", "application", "engine", "protocol", "client", "service", "models", "desktop/v1/state", "desktop/v1/providers"].map(name => `@zhivex-ai/harness/${name}`));
const assistantPackageImports = new Set([...Object.keys(apiContract.entrypoints).filter(name => name.startsWith("./assistant/")).map(name => name.slice(2)),"application/protocol", "application/client", "application", "engine", "protocol", "client", "service"].map(name => `@zhivex-ai/harness/${name}`));
const resolveSource = (file: string, target: string) => path.posix.normalize(path.posix.join(path.posix.dirname(file), target)).replace(/\.js$/, ".ts");

export const architectureViolations = (file: string, source: string): string[] => {
  const physicalFile = file;
  file = file.replace(/^packages\/core\/src/, "src").replace(/^packages\/desktop/, "desktop");
  const violations: string[] = [];
  if (/^src\/[^/]+\.tsx?$/.test(file) && !["src/index.ts", "src/cli.ts", "src/cli-entry.ts", "src/service-cli.ts", "src/acp-cli.ts", "src/version.ts"].includes(file)) {
    violations.push(`${file}: place implementation modules in their responsibility folder`);
  }
  for (const dependency of sourceDependencies(source)) {
    const target = (dependency.target.startsWith(".") ? resolveSource(physicalFile, dependency.target) : dependency.target).replace(/^packages\/core\/src/, "src").replace(/^packages\/desktop/, "desktop");
    const reject = (reason: string) => violations.push(`${file} -> ${dependency.target}: ${reason}`);
    if (file === "src/application/contracts.ts") reject("application projection contracts must have no dependencies, including type-only imports");
    if (file === "src/engine/application-protocol.ts" && target !== "src/application/contracts.ts") reject("application protocol must only export standalone projection contracts");
    if ((/^desktop\/src\/unified\/.*\.tsx$/.test(file) || file === "desktop/src/unified/bridge.ts") && ["@zhivex-ai/harness/application/client", "@zhivex-ai/harness/assistant/managed/setup"].includes(target)) reject("renderer projections must use application/protocol, not the Node client");
    if (file.startsWith("src/application/") && /^(src\/cli(?:\/|\.|-)|desktop\/|packages\/|electron$|react(?:\/|$))/.test(target)) {
      reject("the application core must not depend on a user interface or product implementation");
    }
    if (/^src\/(?:runtime|tools|providers|persistence|workspace|execution)\//.test(file) && target.startsWith("src/application/")) {
      reject("the engine must not depend on application orchestration");
    }
    if (file.startsWith("packages/cli/src/") && (target.startsWith("src/") || target.startsWith("desktop/") || target.startsWith("packages/assistant/") || /^@zhivex-ai\/assistant(?:\/|$)/.test(target))) {
      reject("Code must use declared core APIs, never source or another product");
    }
    if (file.startsWith("packages/assistant/src/")) {
      if (dependency.computed || (dependency.target.startsWith(".") && !target.startsWith("packages/assistant/src/")) || path.isAbsolute(target) ||
          /^@zhivex-ai\/(?:code|code-web)(?:\/|$)/.test(target)) reject("Assistant must not import repository internals or other products");
      if (/^@zhivex-ai\/harness(?:\/|$)/.test(target) && !assistantPackageImports.has(target)) reject("Assistant must use declared engine integration exports");
    }
    if (file.startsWith("src/") && /^(packages\/assistant\/|@zhivex-ai\/assistant(?:\/|$))/.test(target)) reject("Harness must not depend on Assistant");
    if (file.startsWith("desktop/src/") && (target.startsWith("src/") || target.startsWith("packages/cli/") || /^@zhivex-ai\/code(?:\/|$)/.test(target))) {
      reject("Desktop must consume declared Harness package exports, never repository source or Code");
    }
    if (file.startsWith("desktop/src/") && /^@zhivex-ai\/harness(?:\/|$)/.test(target) && !desktopPackageImports.has(target)) {
      reject("Desktop Harness import is not a declared integration entrypoint");
    }
    if (file.startsWith("src/") && target.startsWith("desktop/")) reject("the runtime must not depend on Desktop");
    if (file.startsWith("src/") && /^(packages\/code\/|@zhivex-ai\/code(?:\/|$))/.test(target)) reject("Harness must not depend on Code");
    if (file === "src/client/protocol.ts" && !dependency.typeOnly && target !== "zod") {
      reject("the wire protocol may load only its schema library");
    }
    if (file === "src/internal/desktop/protocol.ts" && !dependency.typeOnly && target !== "src/client/protocol.ts") {
      reject("the Desktop protocol surface must not load host implementations");
    }
    if (file === "src/internal/desktop/catalog.ts" && !dependency.typeOnly && target !== "src/models/catalog.ts") {
      reject("the Desktop catalog surface must not load host implementations");
    }
    if (file.startsWith("src/cli/") && target === "src/cli.ts") reject("CLI modules must not import their executable facade");
    if (file.startsWith("src/tools/") && !dependency.typeOnly && target === "src/runtime/harness.ts") {
      reject("tool implementations must not load the harness composition root");
    }
  }
  return violations;
};

/** Traverse every source edge, including erased type references and intermediary helpers. */
export const engineBoundaryViolations = (sources: ReadonlyMap<string, string>, entries: readonly string[] = [...Object.values(apiContract.entrypoints).filter(entry => entry.source.startsWith("src/engine/assistant/")).map(entry => entry.source),"src/engine/application-client.ts", "src/engine/application.ts", "src/engine/index.ts", "src/engine/protocol.ts", "src/engine/client.ts", "src/engine/service.ts", "src/engine/acp.ts", "src/engine/models.ts", "src/engine/desktop-state-v1.ts", "src/engine/desktop-providers-v1.ts", "src/engine/mcp-stdio-v1.ts", "src/compat/code-support.ts"]): string[] => {
  const violations: string[] = [];
  const visited = new Set<string>();
  const visit = (file: string, chain: string[]): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = sources.get(file);
    if (source === undefined && file.endsWith(".json")) return;
    if (source === undefined) { violations.push(`${chain.join(" -> ")}: unresolved engine source`); return; }
    for (const dependency of sourceDependencies(source)) {
      const target = dependency.target.startsWith(".") ? resolveSource(file, dependency.target) : dependency.target;
      const edge = [...chain, target];
      if (dependency.computed) violations.push(`${edge.join(" -> ")}: computed imports cannot prove engine isolation`);
      else if (/^@zhivex-ai\/harness(?:\/|$)/.test(target)) {
        violations.push(`${edge.join(" -> ")}: engine self-imports must use relative source paths so the full closure is checked`);
      } else if (/^(?:node:)?(?:readline(?:\/promises)?|tty)$/.test(target)) {
        violations.push(`${edge.join(" -> ")}: engine must not load terminal builtins`);
      } else if (/^(src\/cli(?:\/|\.|-)|src\/(?:service-cli|acp-cli|index)\.ts$|desktop\/|packages\/code\/|@zhivex-ai\/code(?:\/|$)|@napi-rs\/keyring$)/.test(target)) {
        violations.push(`${edge.join(" -> ")}: engine must not depend on terminal, Code, Desktop or credential UI`);
      } else if (dependency.target.startsWith(".")) visit(target, edge);
    }
  };
  for (const entry of entries) visit(entry, [entry]);
  return violations;
};

export const checkArchitecture = async (root: string): Promise<string[]> => {
  const violations: string[] = [];
  const sources = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const physical = `${directory}/${entry.name}`;
      const file = physical.replace(/^packages\/core\/src/, "src").replace(/^packages\/desktop/, "desktop");
      if (entry.isDirectory()) await visit(physical);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = await readFile(path.join(root, physical), "utf8");
        sources.set(file, source);
        violations.push(...architectureViolations(physical, source));
      }
    }
  };
  await visit("packages/core/src");
  await visit("packages/cli/src");
  violations.push(...engineBoundaryViolations(sources));
  return violations;
};

if (import.meta.main) {
  const violations = await checkArchitecture(path.resolve(import.meta.dir, ".."));
  if (violations.length) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Architecture boundaries passed.\n");
}
