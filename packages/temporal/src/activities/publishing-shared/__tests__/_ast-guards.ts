import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Every VALUE a module imports from `@repo/database`, read off the source.
 *
 * Type-only imports are excluded on purpose — a type cannot write a row, so
 * adding one is not a change to the write surface and should not fail a guard.
 * A namespace import (`* as`) or a dynamic `import("@repo/database")` WOULD
 * defeat the check, so both are recorded as their own entries and an expected
 * set is written to contain neither.
 *
 * Extracted here when the publishing authorization read moved out of the
 * activities and into `assert-generation-actor.ts`. The walker does NOT follow
 * imports, so a guard on an activity says nothing about a helper the activity
 * calls — the helper needs its own, and a third hand-copy of this function was
 * the wrong way to get one.
 */
export function databaseValueImports(file: string): string[] {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const found = new Set<string>();

	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === "@repo/database"
		) {
			const clause = node.importClause;
			if (!clause) {
				found.add("<side-effect import>");
			} else if (!clause.isTypeOnly) {
				if (clause.name) {
					found.add(`<default> ${clause.name.text}`);
				}
				const bindings = clause.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) {
					found.add(`<namespace> ${bindings.name.text}`);
				}
				if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						if (!element.isTypeOnly) {
							found.add(
								(element.propertyName ?? element.name).text,
							);
						}
					}
				}
			}
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			const [arg] = node.arguments;
			if (
				arg &&
				ts.isStringLiteral(arg) &&
				arg.text === "@repo/database"
			) {
				found.add("<dynamic import>");
			}
		}
		ts.forEachChild(node, visit);
	};

	visit(source);
	return [...found].sort();
}

/**
 * Position of the first CALL to `name` in a source file, or -1.
 *
 * A CallExpression via the AST, and never a source-text search. A guard that
 * greps cannot tell code from prose: the first version of the publishing
 * membership scan reported the very file that REPLACED the old helper as an
 * offender, because its doc comment named it. The same mistake in the other
 * direction is worse — a comment mentioning a call keeps a guard green after
 * the call is deleted.
 */
export function firstCallPosition(file: string, name: string): number {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	let found = -1;
	const visit = (node: ts.Node): void => {
		if (found !== -1) {
			return;
		}
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === name
		) {
			found = node.getStart(source);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}
