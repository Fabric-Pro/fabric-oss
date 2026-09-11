import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** `packages/temporal/src/activities`, relative to this file's own location. */
const ACTIVITIES_DIR = join(__dirname, "..", "..");

/**
 * Every `publishing-*` activity folder that is a DRAFT-GENERATION pair — it
 * has both a `generate-*.ts` and a `mark-*-failed.ts` file. That structural
 * signature is what excludes `publishing-shared` (has neither) and
 * `publishing-suggestion` (has a `mark-cycle-failed.ts` but no
 * `generate-*.ts` sibling — a cycle-level failure marker for a different
 * subsystem, topic suggestion rather than draft generation) WITHOUT naming
 * either folder: a future draft-generation content type is picked up the
 * same way, with nothing here to update.
 *
 * Shared by `draft-refusal.test.ts` and `publishing-failure-message.test.ts`
 * — both need exactly this folder rule, and before this each kept its own
 * copy, which is the failure mode this task exists to remove.
 */
export function draftGenerationFolders(): string[] {
	return readdirSync(ACTIVITIES_DIR, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() && entry.name.startsWith("publishing-"),
		)
		.map((entry) => entry.name)
		.filter((name) => {
			const files = readdirSync(join(ACTIVITIES_DIR, name));
			return (
				files.some((f) => /^generate-.*\.ts$/.test(f)) &&
				files.some((f) => /^mark-.*-failed\.ts$/.test(f))
			);
		});
}

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

/** A `build*LockedClauses` function name, however it is spelled. */
const LOCKED_CLAUSE_BUILDER_NAME = /^build[A-Za-z]*LockedClauses$/;

/**
 * Every `build*LockedClauses` function this file DECLARES and exports itself,
 * and — separately — the ORIGINAL name of every such function this file
 * actually CALLS, resolved through local bindings rather than matched as
 * literal call-site text.
 *
 * DETECTED: a direct call to a `build*LockedClauses` function, however the
 * call site spells it —
 *
 *   - its own name, plain (`buildShortPostLockedClauses(...)`);
 *   - a NAMED import, aliased or not
 *     (`import { buildShortPostLockedClauses as clauses } from "..."`);
 *   - a chain of plain local reassignment
 *     (`const clauses = buildShortPostLockedClauses;`, chased to a fixed
 *     point so a rebinding of a rebinding still resolves); or
 *   - a NAMESPACE import's property access (`import * as shortPost from
 *     "..."; shortPost.buildShortPostLockedClauses(...)`), recorded by the
 *     namespace's local binding and the CALLED property name — namespace
 *     access carries no alias of its own, so the property name already IS
 *     the original export name.
 *
 * A caller compares `called` against `declared` to tell an OWN call from an
 * INHERITED one. The literal-text approach this replaces could see none of
 * the non-plain forms above, which is exactly how `composeLinkedInPostPrompt`
 * (a real file, calling `buildShortPostLockedClauses` under its own,
 * unaliased name — the search still would have found THAT one; the risk is a
 * FUTURE file using any of the other three) stayed invisible to the
 * family-wide guard that exists to catch precisely this.
 *
 * NOT DETECTED, and not fixable by more per-file resolution: a builder handed
 * to another function BY REFERENCE —
 * `attachLockedClauses(buildShortPostLockedClauses, subjects)` — is invoked
 * inside that OTHER function, through a parameter name this file never sees,
 * so nothing scoped to one file has a binding left to follow.
 *
 * NOT DETECTED, as a DELIBERATE limit: bindings live in one file-global map
 * rather than per lexical scope, so a local that SHADOWS an outer alias with
 * an unrelated value of the same name could be misreported as a call to the
 * builder the outer alias named. Real lexical-scope resolution is out of
 * proportion for a discovery over one directory tree, and the failure mode is
 * the safe one: a false positive here makes the classification test demand a
 * classification for a consumer that does not exist, which reddens the build
 * rather than silently hiding a gap — the opposite of the false negatives
 * this function exists to close.
 */
export function lockedClauseBuilderUsage(file: string): {
	declared: Set<string>;
	called: string[];
} {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);

	const declared = new Set<string>();
	/** local name -> original builder name (a declaration maps to itself). */
	const bindings = new Map<string, string>();
	/** local name -> module specifier, for `import * as X from "..."`. */
	const namespaceImports = new Map<string, string>();

	const collect = (node: ts.Node): void => {
		if (
			ts.isFunctionDeclaration(node) &&
			node.name &&
			LOCKED_CLAUSE_BUILDER_NAME.test(node.name.text) &&
			node.modifiers?.some(
				(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
			)
		) {
			declared.add(node.name.text);
			bindings.set(node.name.text, node.name.text);
		}
		if (
			ts.isImportDeclaration(node) &&
			node.importClause &&
			!node.importClause.isTypeOnly &&
			node.importClause.namedBindings
		) {
			const { namedBindings } = node.importClause;
			if (ts.isNamedImports(namedBindings)) {
				for (const element of namedBindings.elements) {
					const original = (element.propertyName ?? element.name)
						.text;
					if (
						LOCKED_CLAUSE_BUILDER_NAME.test(original) &&
						!element.isTypeOnly
					) {
						bindings.set(element.name.text, original);
					}
				}
			} else if (
				ts.isNamespaceImport(namedBindings) &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				namespaceImports.set(
					namedBindings.name.text,
					node.moduleSpecifier.text,
				);
			}
		}
		ts.forEachChild(node, collect);
	};
	collect(source);

	// Chase simple local reassignment (`const x = <already-bound name>;`) to a
	// fixed point, so `const b = clauses;` after `const clauses = buildX...`
	// still resolves back to the original.
	let changed = true;
	while (changed) {
		changed = false;
		const chase = (node: ts.Node): void => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				ts.isIdentifier(node.initializer) &&
				bindings.has(node.initializer.text) &&
				!bindings.has(node.name.text)
			) {
				bindings.set(
					node.name.text,
					bindings.get(node.initializer.text) as string,
				);
				changed = true;
			}
			ts.forEachChild(node, chase);
		};
		chase(source);
	}

	const called: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			if (ts.isIdentifier(node.expression)) {
				const resolved = bindings.get(node.expression.text);
				if (resolved) {
					called.push(resolved);
				}
			} else if (
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				namespaceImports.has(node.expression.expression.text) &&
				LOCKED_CLAUSE_BUILDER_NAME.test(node.expression.name.text)
			) {
				// A namespace property access carries no alias of its own —
				// `shortPost.buildXLockedClauses` always names the ORIGINAL
				// export — so the property text IS the resolved name.
				called.push(node.expression.name.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);

	return { declared, called };
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
