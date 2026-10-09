/**
 * Read a source file the way the compiler reads it, so a structure test can
 * say what a file calls and imports without being fooled by a comment that
 * mentions fetch, or missing a call that hides in a string. Used by the tests
 * that fail the build when a file reaches for the network or logs.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export interface Source {
  /** every identifier and how often it appears: a call, a property, a binding */
  identifiers: Map<string, number>;
  /** module specifier -> value imports from it. '*' stands for a default or namespace import. Type-only imports are left out. */
  imports: Map<string, string[]>;
  /** every string and template literal, for require() and import() */
  strings: Set<string>;
  /** code that reaches for a name it does not spell out: import() of a computed specifier, a computed property of globalThis */
  computed: string[];
}

export function readSource(path: string | URL): Source {
  const file = path instanceof URL ? path.pathname : path;
  const kind = /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, kind);
  const out: Source = { identifiers: new Map(), imports: new Map(), strings: new Set(), computed: [] };
  const bump = (name: string): void => void out.identifiers.set(name, (out.identifiers.get(name) ?? 0) + 1);
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) bump(node.text);
    const specifier = node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent));
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !specifier) out.strings.add(node.text);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      const c = node.importClause;
      if (c && !c.isTypeOnly) {
        if (c.name) names.push('*');
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) names.push('*');
          else for (const e of c.namedBindings.elements) if (!e.isTypeOnly) names.push(e.propertyName?.text ?? e.name.text);
        }
      }
      out.imports.set(node.moduleSpecifier.text, [...(out.imports.get(node.moduleSpecifier.text) ?? []), ...names]);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      out.imports.set(node.moduleSpecifier.text, [...(out.imports.get(node.moduleSpecifier.text) ?? []), '*']);
    }
    const literal = (n: ts.Node | undefined): boolean => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && !literal(node.arguments[0])) out.computed.push('import() of a computed specifier');
    if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === 'resolve') out.computed.push('import.meta.resolve');
    if (ts.isElementAccessExpression(node) && !literal(node.argumentExpression)) {
      const target = node.expression.getText();
      if (/^(?:\(.*\))?\s*(?:globalThis|window|self|global)\b/.test(target) || /\bas any\)$/.test(target)) out.computed.push(`computed property of ${target.replace(/\s+/g, ' ')}`);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}
