/**
 * Parity guard: every activity a workflow proxies must be a runtime export of
 * the activities barrel.
 *
 * `worker.ts` registers activities with `import * as activities from
 * "./activities"`, so an activity that exists on disk but is missing from
 * `activities/index.ts` is never registered. Temporal then fails every attempt
 * with "Activity function X is not registered on this Worker" — and where the
 * caller wraps the call in try/catch (the optional-context pattern), the
 * workflow still reports success with that context silently missing.
 *
 * Type-checking cannot catch this. A workflow imports the activity's *type*,
 * which resolves against the source module rather than the barrel, and
 * `proxyActivities<typeof someActivitiesNamespace>()` type-checks against a
 * namespace import that likewise bypasses the barrel. Six activities had
 * drifted this way before this test existed.
 *
 * Both sides are read off the TypeScript AST rather than by matching text: a
 * name that appears in the barrel only as a local, an import, a string, or a
 * type-only export is not a runtime export and must not count as registered.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIR = join(__dirname, "..");
const PACKAGE_ROOT = join(__dirname, "../../..");
const ACTIVITIES_ENTRY = join(__dirname, "../../activities/index.ts");

function parse(file: string): ts.SourceFile {
	return ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
}

/** Resolve a relative specifier the way the bundler does: `./x` → x.ts | x/index.ts. */
function resolveModule(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = normalize(join(dirname(fromFile), specifier));
	for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// not this candidate
		}
	}
	return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return Boolean(
		ts.canHaveModifiers(node) &&
			ts.getModifiers(node)?.some((m) => m.kind === kind),
	);
}

function hasExportModifier(node: ts.Node): boolean {
	return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

/** Names bound to a *value* (not a type) somewhere in this file's scope. */
function localValueNames(source: ts.SourceFile): Set<string> {
	const names = new Set<string>();

	for (const statement of source.statements) {
		if (
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isEnumDeclaration(statement)
		) {
			if (statement.name) names.add(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const decl of statement.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
			}
		} else if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (!clause || clause.isTypeOnly) continue;
			if (clause.name) names.add(clause.name.text);
			const bindings = clause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) {
				names.add(bindings.name.text);
			} else if (bindings && ts.isNamedImports(bindings)) {
				for (const spec of bindings.elements) {
					if (!spec.isTypeOnly) names.add(spec.name.text);
				}
			}
		}
	}

	return names;
}

/**
 * The value (runtime) exports of a module, following re-exports transitively.
 *
 * A name re-exported from another module counts only if that module really
 * exports it as a value, so an `export { SomeType } from "./x"` slipped into a
 * barrel never masks a missing activity.
 *
 * Bare package specifiers cannot be followed from here, so their named
 * re-exports are trusted — nothing registers an activity that way. A
 * *relative* specifier that fails to resolve is a resolver gap rather than a
 * boundary, and is recorded in `unresolved` so the suite fails loudly instead
 * of quietly trusting whatever it could not read.
 */
function valueExports(
	file: string,
	unresolved: string[],
	cache = new Map<string, Set<string>>(),
	inProgress = new Set<string>(),
): Set<string> {
	const cached = cache.get(file);
	if (cached) return cached;
	// Import cycle: treat as empty rather than recursing forever. The other
	// arm of the cycle still contributes its own exports.
	if (inProgress.has(file)) return new Set();

	inProgress.add(file);
	const source = parse(file);
	const locals = localValueNames(source);
	const exported = new Set<string>();

	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement)) {
			if (statement.isTypeOnly) continue;

			const specifier =
				statement.moduleSpecifier &&
				ts.isStringLiteral(statement.moduleSpecifier)
					? statement.moduleSpecifier.text
					: null;
			const relative = specifier?.startsWith(".") ?? false;
			const target = specifier ? resolveModule(file, specifier) : null;
			// Only a package boundary is trusted, never a path this resolver
			// simply failed on.
			const external = specifier !== null && !relative;

			if (specifier !== null && target === null) {
				if (relative) {
					unresolved.push(`${file} → ${specifier}`);
				} else if (!statement.exportClause) {
					// `export * from "some-package"`: its names would be part of
					// the surface and this resolver cannot see them.
					unresolved.push(`${file} → * from ${specifier}`);
				}
			}

			if (!statement.exportClause) {
				// `export * from "./x"` — everything the target exports as a value.
				if (target) {
					for (const name of valueExports(
						target,
						unresolved,
						cache,
						inProgress,
					)) {
						exported.add(name);
					}
				}
				continue;
			}

			if (ts.isNamespaceExport(statement.exportClause)) {
				// `export * as ns from "./x"` — one value binding named `ns`.
				exported.add(statement.exportClause.name.text);
				continue;
			}

			const targetExports = target
				? valueExports(target, unresolved, cache, inProgress)
				: null;

			for (const spec of statement.exportClause.elements) {
				if (spec.isTypeOnly) continue;
				const exportedName = spec.name.text;
				const localName = (spec.propertyName ?? spec.name).text;

				if (targetExports) {
					if (targetExports.has(localName))
						exported.add(exportedName);
				} else if (external) {
					// Cannot see into a package; trust it.
					exported.add(exportedName);
				} else if (locals.has(localName)) {
					// `export { foo }` — only if `foo` is a value here.
					exported.add(exportedName);
				}
			}
			continue;
		}

		if (!hasExportModifier(statement)) continue;
		// `export default function foo()` binds `default`, not `foo`, and
		// `export declare` emits nothing at all.
		if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) continue;
		if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;

		if (
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isEnumDeclaration(statement)
		) {
			if (statement.name) exported.add(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const decl of statement.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) exported.add(decl.name.text);
			}
		}
		// Interfaces and type aliases are erased — never runtime exports.
	}

	inProgress.delete(file);
	cache.set(file, exported);
	return exported;
}

/** Names bound by an object destructuring pattern, keyed by source property. */
function bindingPatternKeys(pattern: ts.ObjectBindingPattern): string[] {
	const keys: string[] = [];
	for (const element of pattern.elements) {
		// `{ foo }` and `{ foo: alias }` both name activity `foo`.
		const key = element.propertyName ?? element.name;
		if (ts.isIdentifier(key)) keys.push(key.text);
	}
	return keys;
}

/** The local name `proxyActivities` is imported under, if it is imported. */
function proxyActivitiesLocalName(source: ts.SourceFile): string | null {
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const spec of bindings.elements) {
			if ((spec.propertyName ?? spec.name).text === "proxyActivities") {
				return spec.name.text;
			}
		}
	}
	return null;
}

/**
 * Activity names a workflow file hands to `proxyActivities`, whether it
 * destructures the result immediately or keeps the proxy object and reads
 * members off it later.
 *
 * `unrecognized` counts everything this function could not follow: a
 * `proxyActivities` call whose result goes somewhere unexpected, and any use
 * of a proxy object other than reading a member off it or destructuring it.
 * It is asserted to be zero rather than ignored, because a shape nobody
 * anticipated contributes no names and would otherwise pass in silence —
 * handing a proxy to a helper (`const other = proxies`) would take every call
 * through it out of the guard's sight while the file still looked checked.
 */
function proxiedActivityNames(source: ts.SourceFile): {
	names: Set<string>;
	unrecognized: number;
	calls: number;
} {
	const names = new Set<string>();
	const proxyObjects = new Set<string>();
	const proxyCallee = proxyActivitiesLocalName(source) ?? "proxyActivities";
	let unrecognized = 0;
	let calls = 0;

	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === proxyCallee
		) {
			calls += 1;
			// `proxyActivities<T>(opts)` — type arguments hang off the call, so
			// the callee is a plain identifier regardless of the generic.
			const declaration = node.parent;
			if (ts.isVariableDeclaration(declaration)) {
				if (ts.isObjectBindingPattern(declaration.name)) {
					for (const key of bindingPatternKeys(declaration.name)) {
						names.add(key);
					}
				} else if (ts.isIdentifier(declaration.name)) {
					proxyObjects.add(declaration.name.text);
				} else {
					unrecognized += 1;
				}
			} else {
				unrecognized += 1;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);

	if (proxyObjects.size > 0) {
		// Every *reference* to a proxy object is classified, not just the ones
		// in a shape we know. An unclassifiable reference means the proxy has
		// escaped somewhere this function cannot follow, so it is counted
		// rather than skipped.
		const classifyReference = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && proxyObjects.has(node.text)) {
				const parent = node.parent;

				if (
					ts.isPropertyAccessExpression(parent) &&
					parent.expression === node
				) {
					// Every referenced member counts, not only called ones: a
					// member the proxy type declares but nothing registers is a
					// defect whether or not this file calls it today.
					names.add(parent.name.text);
				} else if (
					ts.isElementAccessExpression(parent) &&
					parent.expression === node
				) {
					if (ts.isStringLiteral(parent.argumentExpression)) {
						names.add(parent.argumentExpression.text);
					} else {
						// A computed key cannot be resolved statically.
						unrecognized += 1;
					}
				} else if (ts.isVariableDeclaration(parent)) {
					if (parent.name === node) {
						// The declaration that introduced the proxy.
					} else if (ts.isObjectBindingPattern(parent.name)) {
						// `const { foo } = proxies` — destructured later.
						for (const key of bindingPatternKeys(parent.name)) {
							names.add(key);
						}
					} else {
						// `const other = proxies` — an alias this pass would
						// stop following.
						unrecognized += 1;
					}
				} else if (
					// Type-only positions (`typeof proxies`,
					// `typeof proxies.foo`) schedule nothing.
					!ts.isTypeQueryNode(parent) &&
					!ts.isQualifiedName(parent)
				) {
					unrecognized += 1;
				}
			}
			ts.forEachChild(node, classifyReference);
		};
		classifyReference(source);
	}

	return { names, unrecognized, calls };
}

function workflowFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			out.push(...workflowFiles(full));
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("activity registration parity", () => {
	const unresolved: string[] = [];
	const registered = valueExports(ACTIVITIES_ENTRY, unresolved);

	const proxied = workflowFiles(WORKFLOWS_DIR).map((file) => {
		const source = parse(file);
		return {
			file: relative(PACKAGE_ROOT, file),
			// Comments stripped: a file that only *mentions* proxyActivities in
			// prose calls nothing and must not be reported as silent.
			mentions: source
				.getFullText()
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/[^\n]*/g, "")
				.includes("proxyActivities"),
			...proxiedActivityNames(source),
		};
	});

	it("resolves every module the barrel re-exports from", () => {
		// A specifier this resolver cannot follow leaves a hole in the export
		// surface, which would show up as a spurious "not registered" — or, for
		// a named re-export, as a name trusted without ever being checked.
		expect(unresolved).toEqual([]);
	});

	it("reads a plausible export surface off the barrel", () => {
		// Guards the guard: a resolver regression must not pass by finding nothing.
		expect(registered.size).toBeGreaterThan(200);
	});

	it("follows every proxyActivities call and every use of its result", () => {
		// Guards the guard: anything unfollowed contributes no names, so without
		// this a whole file could go unchecked while the suite stayed green.
		// One recognized use in a file does not excuse an unrecognized second.
		const unfollowed = proxied
			.filter((f) => f.unrecognized > 0)
			.map((f) => `${f.file} (${f.unrecognized})`);

		expect(unfollowed).toEqual([]);
	});

	it("extracts activity names from every file that calls proxyActivities", () => {
		// `calls` comes from the AST and follows an aliased named import; the
		// source-text arm additionally catches a call this parser did not match
		// at all, such as one made through a namespace import.
		const silent = proxied
			.filter((f) => (f.calls > 0 || f.mentions) && f.names.size === 0)
			.map((f) => f.file);

		expect(silent).toEqual([]);
	});

	it("exports every proxied activity from the activities barrel", () => {
		const missing = proxied.flatMap(({ file, names }) =>
			[...names]
				.filter((name) => !registered.has(name))
				.map((name) => `${name} (proxied by ${file})`),
		);

		expect(missing).toEqual([]);
	});
});
