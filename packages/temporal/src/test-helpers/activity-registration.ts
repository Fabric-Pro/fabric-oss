import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";

export function parse(file: string): ts.SourceFile {
	return ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
}

/** Resolve a relative specifier the way the bundler does: `./x` → x.ts | x/index.ts. */
export function resolveModule(
	fromFile: string,
	specifier: string,
): string | null {
	if (!specifier.startsWith(".")) {
		return null;
	}
	const base = normalize(join(dirname(fromFile), specifier));
	for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
		try {
			if (statSync(candidate).isFile()) {
				return candidate;
			}
		} catch {
			// not this candidate
		}
	}
	return null;
}

export function workflowFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") {
				continue;
			}
			out.push(...workflowFiles(full));
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

/** Names bound by an object destructuring pattern, keyed by source property. */
function bindingPatternKeys(pattern: ts.ObjectBindingPattern): string[] {
	const keys: string[] = [];
	for (const element of pattern.elements) {
		// `{ foo }` and `{ foo: alias }` both name activity `foo`.
		const key = element.propertyName ?? element.name;
		if (ts.isIdentifier(key)) {
			keys.push(key.text);
		}
	}
	return keys;
}

/** The local name `proxyActivities` is imported under, if it is imported. */
function proxyActivitiesLocalName(source: ts.SourceFile): string | null {
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) {
			continue;
		}
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) {
			continue;
		}
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
export function proxiedActivityNames(source: ts.SourceFile): {
	names: Set<string>;
	unrecognized: number;
	calls: number;
} {
	const names = new Set<string>();
	const proxyObjects = new Set<string>();
	const proxyCalls = new Set(proxyActivityCalls(source));
	let unrecognized = 0;
	let calls = 0;

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && proxyCalls.has(node)) {
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

function proxyActivityCalls(source: ts.SourceFile): ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const callee = proxyActivitiesLocalName(source) ?? "proxyActivities";
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === callee
		) {
			calls.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return calls;
}

/** Resolve explicit proxy properties to their imported implementation types. */
export function proxiedActivityTypes(source: ts.SourceFile): {
	key: string;
	specifier: string;
	exportName: string;
}[] {
	const imports = new Map<
		string,
		{ specifier: string; exportName: string | null }
	>();
	const declarations = new Map<
		string,
		ts.TypeAliasDeclaration | ts.InterfaceDeclaration
	>();
	for (const node of source.statements) {
		if (
			ts.isTypeAliasDeclaration(node) ||
			ts.isInterfaceDeclaration(node)
		) {
			declarations.set(node.name.text, node);
		}
		if (
			!ts.isImportDeclaration(node) ||
			!ts.isStringLiteral(node.moduleSpecifier)
		) {
			continue;
		}
		const bindings = node.importClause?.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) {
			imports.set(bindings.name.text, {
				specifier: node.moduleSpecifier.text,
				exportName: null,
			});
		}
		if (bindings && ts.isNamedImports(bindings)) {
			for (const binding of bindings.elements) {
				imports.set(binding.name.text, {
					specifier: node.moduleSpecifier.text,
					exportName: (binding.propertyName ?? binding.name).text,
				});
			}
		}
	}
	const result: { key: string; specifier: string; exportName: string }[] = [];
	const resolveQuery = (key: string, query: ts.TypeQueryNode): void => {
		const name = query.exprName;
		const binding = ts.isIdentifier(name)
			? imports.get(name.text)
			: ts.isIdentifier(name.left)
				? imports.get(name.left.text)
				: undefined;
		const exportName = ts.isIdentifier(name)
			? binding?.exportName
			: binding?.exportName === null
				? name.right.text
				: undefined;
		if (!binding || !exportName) {
			throw new Error(
				`Unresolved proxy typeof: ${source.fileName}: ${key}: ${query.getText(source)}`,
			);
		}
		result.push({ key, specifier: binding.specifier, exportName });
	};
	const visitType = (node: ts.Node, active = new Set<string>()): void => {
		if (
			ts.isPropertySignature(node) &&
			node.type &&
			ts.isTypeQueryNode(node.type)
		) {
			if (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name)) {
				throw new Error("Unsupported proxy property key");
			}
			resolveQuery(node.name.text, node.type);
			return;
		}
		const reference = ts.isTypeReferenceNode(node)
			? node.typeName
			: ts.isExpressionWithTypeArguments(node)
				? node.expression
				: null;
		if (reference && ts.isIdentifier(reference)) {
			const declaration = declarations.get(reference.text);
			if (declaration) {
				if (active.has(reference.text)) {
					throw new Error(`Cyclic proxy type: ${reference.text}`);
				}
				const next = new Set(active).add(reference.text);
				ts.forEachChild(declaration, (child) => visitType(child, next));
			}
			return;
		}
		ts.forEachChild(node, (child) => visitType(child, active));
	};
	for (const call of proxyActivityCalls(source)) {
		for (const type of call.typeArguments ?? []) {
			visitType(type);
		}
	}
	return result;
}
