/**
 * The worker runs its TypeScript through tsx (`CMD ["tsx", "src/worker.ts"]`
 * in the Dockerfile), and Vitest's own transform does not link modules the way
 * tsx does. Under tsx, a dynamic `import()` of an ES-module workspace package
 * (`"type": "module"`, such as @repo/integrations) fails to link as soon as
 * that package takes a named import from a CommonJS one such as
 * @repo/database: Node reads the CommonJS file's raw TypeScript to find its
 * export names, finds none, and rejects the import with "does not provide an
 * export named ...". A static import compiles to require() and is unaffected.
 *
 * So this test runs under tsx rather than Vitest's transform. It collects
 * every dynamic import of a workspace package in the worker's own source
 * (`src/`, tests excluded), imports each one under tsx from a CommonJS
 * TypeScript file the way worker code does, and checks that the names the
 * call site reads, in the forms `namesUsed` recognizes, are defined. It uses the workspace's tsx and the test's
 * Node, which can differ from the versions the worker image installs; the
 * failure it guards against reproduced on both. Dynamic imports with a
 * non-literal specifier, and those inside other packages the worker loads,
 * are outside its reach.
 */

import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = join(__dirname, "../..");
const SRC_DIR = join(PACKAGE_DIR, "src");
const RESULT_MARKER = "WORKER_DYNAMIC_IMPORT_RESULTS:";

interface ImportRequest {
	specifier: string;
	names: string[];
	sites: string[];
}

interface ImportResult {
	specifier: string;
	missing?: string[];
	error?: string;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__" && entry.name !== "node_modules") {
				sourceFiles(path, out);
			}
		} else if (
			/\.tsx?$/.test(entry.name) &&
			!/\.(test|spec)\.tsx?$|\.d\.ts$/.test(entry.name)
		) {
			out.push(path);
		}
	}
	return out;
}

/**
 * Steps outward through wrappers that leave the value unchanged, noting
 * whether one of them was an `await`: before it, the value is the import's
 * Promise, after it, the module namespace.
 */
function outerValue(node: ts.Node): { value: ts.Node; awaited: boolean } {
	let value = node;
	let awaited = false;
	while (
		ts.isParenthesizedExpression(value.parent) ||
		ts.isAwaitExpression(value.parent) ||
		ts.isAsExpression(value.parent) ||
		ts.isSatisfiesExpression(value.parent) ||
		ts.isNonNullExpression(value.parent) ||
		ts.isTypeAssertionExpression(value.parent)
	) {
		awaited ||= ts.isAwaitExpression(value.parent);
		value = value.parent;
	}
	return { value, awaited };
}

/** `{ a, b: alias, c = x, ...rest }` → `["a", "b", "c"]`. */
function bindingNames(pattern: ts.ObjectBindingPattern): string[] {
	return pattern.elements.flatMap((element) => {
		if (element.dotDotDotToken) {
			return [];
		}
		const key = element.propertyName ?? element.name;
		return ts.isIdentifier(key) || ts.isStringLiteral(key)
			? [key.text]
			: [];
	});
}

/**
 * The export names a dynamic import's call site reads, for the forms the
 * worker uses: `const|let { a } = await import(...)` (parenthesized or
 * cast), `(await import(...)).a`, `import(...).then(({ a }) => ...)`, and
 * `const [{ a }, { b }] = await Promise.all([import(...), import(...)])`.
 * Other Promise methods (`catch`, `finally`) read no export. A namespace
 * kept in a variable and read later is not followed; that site is still
 * checked to load.
 */
function namesUsed(call: ts.CallExpression): string[] {
	const { value, awaited } = outerValue(call);
	const parent = value.parent;
	if (awaited) {
		if (
			ts.isVariableDeclaration(parent) &&
			parent.initializer === value &&
			ts.isObjectBindingPattern(parent.name)
		) {
			return bindingNames(parent.name);
		}
		return ts.isPropertyAccessExpression(parent) &&
			parent.expression === value
			? [parent.name.text]
			: [];
	}
	if (ts.isPropertyAccessExpression(parent) && parent.expression === value) {
		if (parent.name.text !== "then") {
			return [];
		}
		const callback = ts.isCallExpression(parent.parent)
			? parent.parent.arguments[0]
			: undefined;
		const first =
			callback &&
			(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
				? callback.parameters[0]?.name
				: undefined;
		return first && ts.isObjectBindingPattern(first)
			? bindingNames(first)
			: [];
	}
	// `await Promise.all([..., import(...), ...])` destructured by position.
	const list = ts.isArrayLiteralExpression(parent) ? parent : undefined;
	const all = list?.parent;
	if (
		list &&
		all &&
		ts.isCallExpression(all) &&
		all.arguments[0] === list &&
		all.expression.getText() === "Promise.all"
	) {
		const { value: settled, awaited: allAwaited } = outerValue(all);
		const declaration = settled.parent;
		if (
			allAwaited &&
			ts.isVariableDeclaration(declaration) &&
			declaration.initializer === settled &&
			ts.isArrayBindingPattern(declaration.name)
		) {
			const element =
				declaration.name.elements[
					list.elements.indexOf(value as ts.Expression)
				];
			return element &&
				ts.isBindingElement(element) &&
				ts.isObjectBindingPattern(element.name)
				? bindingNames(element.name)
				: [];
		}
	}
	return [];
}

/**
 * Every runtime `import("@repo/...")` with a literal specifier. Parsing, not
 * pattern matching: comments inside the call are ignored, a type-position
 * `import("@repo/x").T` is an import type rather than a call and is skipped,
 * and a template with substitutions is not a literal specifier.
 */
function collectWorkspaceDynamicImports(files: string[]): ImportRequest[] {
	const requests = new Map<string, ImportRequest>();
	for (const file of files) {
		const sourceFile = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		const visit = (node: ts.Node): void => {
			const argument = ts.isCallExpression(node)
				? node.arguments[0]
				: undefined;
			if (
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				argument &&
				(ts.isStringLiteral(argument) ||
					ts.isNoSubstitutionTemplateLiteral(argument)) &&
				argument.text.startsWith("@repo/")
			) {
				const specifier = argument.text;
				const request = requests.get(specifier) ?? {
					specifier,
					names: [],
					sites: [],
				};
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				);
				request.sites.push(
					`${relative(PACKAGE_DIR, file)}:${line + 1}`,
				);
				for (const name of namesUsed(node)) {
					if (!request.names.includes(name)) {
						request.names.push(name);
					}
				}
				requests.set(specifier, request);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return [...requests.values()].sort((a, b) =>
		a.specifier.localeCompare(b.specifier),
	);
}

// Plain TypeScript in a CommonJS location, so tsx compiles it exactly like
// worker code, including how it treats `import()`.
const PROBE_SOURCE = `
const requests: { specifier: string; names: string[] }[] = JSON.parse(
	process.argv[2] ?? "[]",
);
async function main(): Promise<void> {
	const results = [];
	for (const request of requests) {
		try {
			const namespace = (await import(request.specifier)) as Record<string, unknown>;
			results.push({
				specifier: request.specifier,
				missing: request.names.filter((name) => namespace[name] === undefined),
			});
		} catch (error) {
			results.push({
				specifier: request.specifier,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	process.stdout.write("\\n${RESULT_MARKER}" + JSON.stringify(results) + "\\n");
}
main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
`;

// Under this package's node_modules: gitignored, resolves @repo/* the way
// src/ does, and has no package.json of its own, so a probe there is
// CommonJS like the worker's files.
function scratchDir(prefix: string): string {
	const cacheDir = join(PACKAGE_DIR, "node_modules/.cache");
	mkdirSync(cacheDir, { recursive: true });
	return mkdtempSync(join(cacheDir, prefix));
}

async function importUnderTsx(
	requests: ImportRequest[],
): Promise<ImportResult[]> {
	const probeDir = scratchDir("worker-dynamic-import-probe-");
	try {
		const probe = join(probeDir, "probe.ts");
		writeFileSync(probe, PROBE_SOURCE);
		const tsxCli = createRequire(join(PACKAGE_DIR, "package.json")).resolve(
			"tsx/cli",
		);
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				tsxCli,
				probe,
				JSON.stringify(
					requests.map(({ specifier, names }) => ({
						specifier,
						names,
					})),
				),
			],
			{ cwd: PACKAGE_DIR, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
		);
		const line = stdout
			.split("\n")
			.find((candidate) => candidate.startsWith(RESULT_MARKER));
		if (!line) {
			throw new Error(
				`tsx probe printed no results:\n${stdout.slice(-2000)}`,
			);
		}
		return JSON.parse(line.slice(RESULT_MARKER.length)) as ImportResult[];
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
}

describe("worker dynamic imports under tsx", () => {
	it("collects the names each runtime workspace import uses, and nothing else", () => {
		const dir = scratchDir("worker-dynamic-import-scan-");
		try {
			const file = join(dir, "sample.ts");
			writeFileSync(
				file,
				[
					'const { a, b: alias, c = 1, ...rest } = await import("@repo/x");',
					'const mod = await import("@repo/y/sub");',
					'const { d } = await import(\n\t"@repo/x"\n);',
					'const other = await import("node:fs");',
					// A comment inside the call does not hide it.
					'const { e } = await import(/* lazy */ "@repo/z");',
					// Parenthesized, cast, and `let` forms.
					'let { f } = (await import("@repo/z")) as typeof import("@repo/types-only");',
					'const g = (await import("@repo/z")).g;',
					'import("@repo/z").then(({ h }) => h);',
					// Promise methods other than then read no export.
					'import("@repo/z").catch(() => null).finally(() => null);',
					"const [{ i }, , { j: alias2 }] = await Promise.all([",
					'\timport("@repo/w"),',
					'\timport("@repo/unused"),',
					'\timport("@repo/x"),',
					"]);",
					// Not runtime imports with a literal specifier: skipped.
					'type T = import("@repo/type-position").Thing;',
					// biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
					"const dyn = await import(`@repo/${name}`);",
				].join("\n"),
			);
			expect(
				collectWorkspaceDynamicImports([file]).map(
					({ specifier, names }) => ({
						specifier,
						names,
					}),
				),
			).toEqual([
				{ specifier: "@repo/unused", names: [] },
				{ specifier: "@repo/w", names: ["i"] },
				{ specifier: "@repo/x", names: ["a", "b", "c", "d", "j"] },
				{ specifier: "@repo/y/sub", names: [] },
				{ specifier: "@repo/z", names: ["e", "f", "g", "h"] },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads every workspace package the worker imports dynamically, with the names it uses", async () => {
		const requests = collectWorkspaceDynamicImports(sourceFiles(SRC_DIR));
		// A scan that silently found nothing would pass vacuously.
		expect(requests.map((request) => request.specifier)).toContain(
			"@repo/database",
		);

		const results = await importUnderTsx(requests);
		expect(results.map((result) => result.specifier)).toEqual(
			requests.map((request) => request.specifier),
		);

		const failures = results.flatMap((result) => {
			const sites = requests
				.find((request) => request.specifier === result.specifier)
				?.sites.join(", ");
			if (result.error) {
				return [`${result.specifier} (${sites}): ${result.error}`];
			}
			if (result.missing?.length) {
				return [
					`${result.specifier} (${sites}): undefined ${result.missing.join(", ")}`,
				];
			}
			return [];
		});
		expect(failures).toEqual([]);
	}, 150_000);
});
