/** Verify workflow activity type imports against the worker's registrations. */
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import {
	parse,
	proxiedActivityTypes,
	resolveModule,
	workflowFiles,
} from "../../test-helpers/activity-registration";
import {
	unwrapActivity,
	withOrganizationLogContext,
} from "../backlog-context/organization-context";

// Constructing the real client performs a server compatibility request.
vi.mock("@qdrant/js-client-rest", () => ({ QdrantClient: class {} }));

const root = resolve(__dirname, "../..");

function activityImports(file: string, source = parse(file)) {
	const imports: { path: string; names: string[] | null }[] = [];
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier)
		) {
			continue;
		}
		const clause = statement.importClause;
		const bindings = clause?.namedBindings;
		if (!clause || !bindings) {
			continue;
		}
		const specifier = statement.moduleSpecifier.text;
		if (!specifier.startsWith(".")) {
			continue;
		}
		const path = resolveModule(file, specifier);
		if (!path) {
			throw new Error(
				`Unresolved relative import: ${file} → ${specifier}`,
			);
		}
		if (!relative(join(root, "activities"), path).startsWith("..")) {
			if (ts.isNamespaceImport(bindings) && clause.isTypeOnly) {
				imports.push({ path, names: null });
			}
			if (ts.isNamedImports(bindings)) {
				const names = bindings.elements
					.filter((s) => clause.isTypeOnly || s.isTypeOnly)
					.map((s) => (s.propertyName ?? s.name).text);
				if (names.length) {
					imports.push({ path, names });
				}
			}
		}
	}
	return imports;
}

function collidingNames(
	module: Record<string, unknown>,
	barrel: Record<string, unknown>,
): string[] {
	return Object.entries(module)
		.filter(
			([name, value]) =>
				typeof value === "function" &&
				name in barrel &&
				(typeof barrel[name] !== "function" ||
					unwrapActivity(barrel[name]) !== value),
		)
		.map(([name]) => name);
}

it("matches namespace and named type imports with registered implementations", async () => {
	const barrel = (await import("../index")) as Record<string, unknown>;
	const collisions: string[] = [];
	let namedCompared = 0;
	let namespaceCompared = 0;
	let renamedCompared = 0;
	for (const file of workflowFiles(join(root, "workflows"))) {
		for (const { path, names } of activityImports(file)) {
			// Comparing the barrel to itself proves nothing.
			if (path === join(root, "activities/index.ts")) {
				continue;
			}
			const module = (await import(path)) as Record<string, unknown>;
			const selected =
				names === null
					? module
					: Object.fromEntries(
							names.map((name) => [name, module[name]]),
						);
			const compared = Object.entries(selected).filter(
				([name, value]) =>
					typeof value === "function" && name in barrel,
			).length;
			if (names === null) {
				namespaceCompared += compared;
			} else {
				namedCompared += compared;
			}
			collisions.push(
				...collidingNames(selected, barrel).map(
					(name) => `${relative(root, file)} → ${path}: ${name}`,
				),
			);
		}
		for (const { key, specifier, exportName } of proxiedActivityTypes(
			parse(file),
		)) {
			const path = resolveModule(file, specifier);
			if (!path) {
				throw new Error(
					`Unresolved proxy import: ${file} → ${specifier}`,
				);
			}
			const module = (await import(path)) as Record<string, unknown>;
			expect(typeof module[exportName], `${file}: ${exportName}`).toBe(
				"function",
			);
			expect(barrel, `${file}: ${key}`).toHaveProperty(key);
			collisions.push(
				...collidingNames({ [key]: module[exportName] }, barrel).map(
					(name) => `${file}: ${name} ← ${exportName}`,
				),
			);
			if (key !== exportName) {
				renamedCompared += 1;
			}
		}
	}
	console.info({
		renamedCompared,
		namedCompared,
		namespaceCompared,
		mismatches: collisions.length,
	});
	expect(namedCompared).toBeGreaterThan(100);
	expect(namespaceCompared).toBeGreaterThan(0);
	expect(collisions).toEqual([]);
	expect(barrel).not.toHaveProperty("executeAgentTurn");
}, 120_000);

it("accepts identity and declared nested wrappers, rejects substitutions", () => {
	const original = async () => undefined;
	const other = async () => undefined;
	for (const registered of [
		original,
		withOrganizationLogContext(original),
		withOrganizationLogContext(withOrganizationLogContext(original)),
	]) {
		expect(
			collidingNames({ retrieve: original }, { retrieve: registered }),
		).toEqual([]);
	}
	for (const registered of [other, withOrganizationLogContext(other), 1]) {
		expect(
			collidingNames({ retrieve: original }, { retrieve: registered }),
		).toEqual(["retrieve"]);
	}
	expect(collidingNames({ constant: 1 }, { constant: 2 })).toEqual([]);
	expect(collidingNames({ helper: original }, {})).toEqual([]);
});

it("reads aliases and inline type imports and rejects unresolved relative imports", () => {
	const file = join(root, "workflows/fixture.ts");
	const source = (text: string) =>
		ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	expect(
		activityImports(
			file,
			source(
				'import type { findDueDocumentsActivity as FindDueFn } from "../activities/document-refresh/find-due-documents"; import { type findDueDocumentsActivity } from "../activities/document-refresh/find-due-documents";',
			),
		).map((i) => i.names),
	).toEqual([["findDueDocumentsActivity"], ["findDueDocumentsActivity"]]);
	expect(() =>
		activityImports(
			file,
			source(
				'import type { missing } from "../activities/does-not-exist";',
			),
		),
	).toThrow("Unresolved relative import");
});

it("checks renamed proxy keys through named imports, aliases and interfaces", () => {
	const original = async () => undefined;
	const other = async () => undefined;
	for (const declaration of [
		"type Proxies = { b: typeof AFn }",
		"interface Base { b: typeof AFn }; interface Proxies extends Base {}",
		"type Base = { b: typeof AFn }; type Proxies = Base",
		"type Proxies = { b: typeof ns.a }",
	]) {
		const source = ts.createSourceFile(
			"fixture.ts",
			`import type { a as AFn } from "./activities"; import type * as ns from "./activities"; ${declaration}; const proxy = proxyActivities<Proxies>({});`,
			ts.ScriptTarget.Latest,
			true,
		);
		const bindings = proxiedActivityTypes(source);
		expect(bindings).toEqual([
			{ key: "b", specifier: "./activities", exportName: "a" },
		]);
		const module: Record<string, unknown> = { a: original };
		const selected = Object.fromEntries(
			bindings.map((b) => [b.key, module[b.exportName]]),
		);
		expect(collidingNames(selected, { a: original, b: original })).toEqual(
			[],
		);
		expect(collidingNames(selected, { a: original, b: other })).toEqual([
			"b",
		]);
	}
	const source = ts.createSourceFile(
		"fixture.ts",
		"const local = () => {}; const proxy = proxyActivities<{ b: typeof local }>({});",
		ts.ScriptTarget.Latest,
		true,
	);
	expect(() => proxiedActivityTypes(source)).toThrow(
		"Unresolved proxy typeof",
	);
});
