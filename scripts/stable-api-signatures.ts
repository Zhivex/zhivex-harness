import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as ts from "typescript";

export const STABLE_API_SIGNATURE_SCHEMA_VERSION = 1 as const;
export const STABLE_API_SIGNATURE_FORMAT = "typescript-declaration-ast-v1" as const;

export interface PublicApiStabilityContract {
  targetVersion: string;
  stableSignatures: string;
  runtimeExports: string[];
  stableRuntimeExports: string[];
  betaRuntimeExports: string[];
  experimentalRuntimeExports: string[];
  typeExports: string[];
  stableTypeExports: string[];
  betaTypeExports: string[];
  experimentalTypeExports: string[];
}

export interface StableApiSignatureEntry {
  name: string;
  sha256: string;
}

export interface StableApiSignatureSnapshot {
  schemaVersion: typeof STABLE_API_SIGNATURE_SCHEMA_VERSION;
  targetVersion: string;
  format: typeof STABLE_API_SIGNATURE_FORMAT;
  stableRuntimeExports: StableApiSignatureEntry[];
  stableTypeExports: StableApiSignatureEntry[];
  digest: string;
}

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const normalizeDeclaration = (value: string) => value
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((line) => line.replace(/[ \t]+$/g, ""))
  .join("\n")
  .trim();

const aliasedSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const canonicalSymbolDeclaration = (
  checker: ts.TypeChecker,
  printer: ts.Printer,
  symbol: ts.Symbol,
  kind: "runtime" | "type",
  declarationRoot: string
) => {
  const target = aliasedSymbol(checker, symbol);
  if (kind === "runtime" ? !(target.flags & ts.SymbolFlags.Value) : !(target.flags & ts.SymbolFlags.Type)) {
    throw new Error(`Stable ${kind} export ${symbol.name} has no declaration.`);
  }
  const isLocalTopLevelDeclaration = (declaration: ts.Declaration) => {
    const sourcePath = path.resolve(declaration.getSourceFile().fileName);
    const relative = path.relative(declarationRoot, sourcePath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    if (!(ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) || ts.isEnumDeclaration(declaration))) return false;
    let container: ts.Node = declaration;
    while (container.parent && !ts.isSourceFile(container.parent) && !ts.isModuleBlock(container.parent)) {
      container = container.parent;
    }
    return Boolean(container.parent && (ts.isSourceFile(container.parent) || ts.isModuleBlock(container.parent)));
  };
  const queue = [target];
  const visited = new Set<ts.Symbol>();
  const emitted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const declarations = (current.getDeclarations() ?? []).filter(isLocalTopLevelDeclaration);
    for (const declaration of declarations) {
      const text = normalizeDeclaration(printer.printNode(
        ts.EmitHint.Unspecified,
        declaration,
        declaration.getSourceFile()
      ));
      if (text) emitted.push(`${current.name}\0${text}`);
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) {
          const referenced = checker.getSymbolAtLocation(node);
          if (referenced) {
            const dependency = aliasedSymbol(checker, referenced);
            if (dependency !== current && (dependency.getDeclarations() ?? []).some(isLocalTopLevelDeclaration)) {
              queue.push(dependency);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(declaration, visit);
    }
  }
  if (emitted.length === 0) throw new Error(`Stable ${kind} export ${symbol.name} has no declaration.`);
  return emitted.sort().join("\n");
};

const snapshotPayload = (snapshot: Omit<StableApiSignatureSnapshot, "digest">) => JSON.stringify({
  schemaVersion: snapshot.schemaVersion,
  targetVersion: snapshot.targetVersion,
  format: snapshot.format,
  stableRuntimeExports: snapshot.stableRuntimeExports,
  stableTypeExports: snapshot.stableTypeExports
});

export const buildStableApiSignatureSnapshot = (
  declarationEntry: string,
  contract: PublicApiStabilityContract
): StableApiSignatureSnapshot => {
  const program = ts.createProgram({
    rootNames: [declarationEntry],
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      types: []
    }
  });
  const source = program.getSourceFile(declarationEntry);
  if (!source) throw new Error(`Stable API declaration entry is unavailable: ${declarationEntry}`);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Stable API declaration entry is not an external module: ${declarationEntry}`);
  const exportsByName = new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const declarationRoot = path.dirname(path.resolve(declarationEntry));
  const entries = (names: readonly string[], kind: "runtime" | "type") => names.map((name) => {
    const symbol = exportsByName.get(name);
    if (!symbol) throw new Error(`Stable ${kind} export ${name} is absent from ${declarationEntry}.`);
    const declaration = canonicalSymbolDeclaration(checker, printer, symbol, kind, declarationRoot);
    return { name, sha256: sha256(`${kind}\0${name}\0${declaration}`) };
  });
  const payload = {
    schemaVersion: STABLE_API_SIGNATURE_SCHEMA_VERSION,
    targetVersion: contract.targetVersion,
    format: STABLE_API_SIGNATURE_FORMAT,
    stableRuntimeExports: entries(contract.stableRuntimeExports, "runtime"),
    stableTypeExports: entries(contract.stableTypeExports, "type")
  } satisfies Omit<StableApiSignatureSnapshot, "digest">;
  return { ...payload, digest: sha256(snapshotPayload(payload)) };
};

export const parseStableApiSignatureSnapshot = (input: unknown): StableApiSignatureSnapshot => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stable API signature snapshot must be an object.");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "digest",
    "format",
    "schemaVersion",
    "stableRuntimeExports",
    "stableTypeExports",
    "targetVersion"
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Stable API signature snapshot has unknown or missing fields.");
  }
  if (value.schemaVersion !== STABLE_API_SIGNATURE_SCHEMA_VERSION ||
    value.format !== STABLE_API_SIGNATURE_FORMAT || typeof value.targetVersion !== "string") {
    throw new Error("Stable API signature snapshot metadata is invalid.");
  }
  const parseEntries = (candidate: unknown, label: string): StableApiSignatureEntry[] => {
    if (!Array.isArray(candidate)) throw new Error(`${label} must be an array.`);
    const parsed = candidate.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} entry is invalid.`);
      const row = entry as Record<string, unknown>;
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(["name", "sha256"]) ||
        typeof row.name !== "string" || !/^sha256:[a-f0-9]{64}$/.test(String(row.sha256))) {
        throw new Error(`${label} entry is invalid.`);
      }
      return { name: row.name, sha256: String(row.sha256) };
    });
    if (new Set(parsed.map((entry) => entry.name)).size !== parsed.length ||
      parsed.map((entry) => entry.name).join("\n") !== parsed.map((entry) => entry.name).sort().join("\n")) {
      throw new Error(`${label} must contain unique sorted names.`);
    }
    return parsed;
  };
  const snapshot: StableApiSignatureSnapshot = {
    schemaVersion: STABLE_API_SIGNATURE_SCHEMA_VERSION,
    targetVersion: value.targetVersion,
    format: STABLE_API_SIGNATURE_FORMAT,
    stableRuntimeExports: parseEntries(value.stableRuntimeExports, "stableRuntimeExports"),
    stableTypeExports: parseEntries(value.stableTypeExports, "stableTypeExports"),
    digest: String(value.digest)
  };
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshot.digest) ||
    snapshot.digest !== sha256(snapshotPayload(snapshot))) {
    throw new Error("Stable API signature snapshot digest is invalid.");
  }
  return snapshot;
};

export const assertStableApiSignatureSnapshot = (
  expected: StableApiSignatureSnapshot,
  actual: StableApiSignatureSnapshot
) => {
  if (expected.targetVersion !== actual.targetVersion || expected.format !== actual.format ||
    JSON.stringify(expected.stableRuntimeExports) !== JSON.stringify(actual.stableRuntimeExports) ||
    JSON.stringify(expected.stableTypeExports) !== JSON.stringify(actual.stableTypeExports) ||
    expected.digest !== actual.digest) {
    throw new Error(
      "Stable API declaration signatures drifted; incompatible Stable changes require a major version, " +
      "otherwise regenerate the reviewed snapshot with bun run contract:signatures:update."
    );
  }
};

export const emitWorkspaceDeclarations = async (workspace: string) => {
  const configPath = path.join(workspace, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, workspace);
  const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-declarations-"));
  const options: ts.CompilerOptions = {
    ...parsed.options,
    declaration: true,
    declarationMap: false,
    declarationDir: directory,
    emitDeclarationOnly: true,
    incremental: false,
    noEmit: false,
    outDir: directory,
    tsBuildInfoFile: undefined
  };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options });
  const result = program.emit(undefined, undefined, undefined, true);
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
  if (diagnostics.length > 0 || result.emitSkipped) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => workspace,
      getNewLine: () => "\n"
    }));
  }
  return {
    directory,
    entry: path.join(directory, "index.d.ts"),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
};

export const readPublicApiStabilityContract = async (file: string) => JSON.parse(
  await readFile(file, "utf8")
) as PublicApiStabilityContract;
