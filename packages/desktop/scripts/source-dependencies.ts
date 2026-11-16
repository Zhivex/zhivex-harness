// Extracted from Harness scripts/check-architecture.ts; preserve import and re-export coverage.
import ts from "typescript-compiler-api";

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

