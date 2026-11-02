/**
 * MCP configured-server transport address-guard ratchet.
 *
 * A raw SDK HTTP transport defaults to Node's global fetch when its `fetch`
 * option is absent. That bypasses the configured-server guard, including its
 * DNS-time private-address refusal and redirect policy. Every direct
 * production construction therefore needs both the pre-connect resolved URL
 * assertion and a transport fetch that falls back to `fetchMcpServer`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const SCAN_ROOTS = ["apps", "packages", "agents"].map((root) =>
	resolve(repoRoot, root),
);
const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	".turbo",
	"dist",
	"coverage",
	"generated",
	"__tests__",
]);
const TRANSPORT_NAMES = new Set([
	"SSEClientTransport",
	"StreamableHTTPClientTransport",
]);

const ALLOWLIST: ReadonlyMap<string, string> = new Map([
	[
		"packages/mcp/lib/client.ts",
		"the shared factory defaults to fetchMcpServer, asserts the resolved URL, and wraps that fetch with dispatch-stop, abort, OAuth-redirect, and retry guards before either SDK transport receives it",
	],
]);

function walkTsFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) {
				files.push(...walkTsFiles(resolve(root, entry.name)));
			}
			continue;
		}
		if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
			!entry.name.endsWith(".d.ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".test.tsx")
		) {
			files.push(resolve(root, entry.name));
		}
	}
	return files;
}

function transportName(expression: ts.Expression): string | null {
	if (ts.isIdentifier(expression) && TRANSPORT_NAMES.has(expression.text)) {
		return expression.text;
	}
	return null;
}

function guardedFetchInitializer(
	initializer: ts.Expression,
	sourceFile: ts.SourceFile,
): boolean {
	const text = initializer.getText(sourceFile).replace(/\s+/g, " ").trim();
	if (text === "fetchMcpServer" || text.includes("?? fetchMcpServer")) {
		return true;
	}
	if (text !== "transportFetch") {
		return false;
	}
	return /const\s+transportFetch\s*=\s*input\.transportFetch\s*\?\?\s*fetchMcpServer/.test(
		sourceFile.getFullText(),
	);
}

function findUnguardedTransports(source: string, fileName: string): string[] {
	if (
		!source.includes("new SSEClientTransport") &&
		!source.includes("new StreamableHTTPClientTransport")
	) {
		return [];
	}
	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const resolvedAssertionIndex = source.search(
		/\bassertMcpServerUrlResolved\s*\(/,
	);
	const offenders: string[] = [];

	function visit(node: ts.Node) {
		if (ts.isNewExpression(node)) {
			const name = transportName(node.expression);
			if (name) {
				const hasResolvedAssertion =
					resolvedAssertionIndex >= 0 &&
					resolvedAssertionIndex < node.getStart(sourceFile);
				const options = node.arguments?.[1];
				const fetchProperty =
					options && ts.isObjectLiteralExpression(options)
						? options.properties.find(
								(property): property is ts.PropertyAssignment =>
									ts.isPropertyAssignment(property) &&
									property.name.getText(sourceFile) ===
										"fetch",
							)
						: undefined;
				const guardedFetch =
					fetchProperty &&
					guardedFetchInitializer(
						fetchProperty.initializer,
						sourceFile,
					);
				if (!hasResolvedAssertion || !guardedFetch) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile),
					);
					offenders.push(
						`${fileName}:${line + 1} (${name}: ${
							hasResolvedAssertion
								? "unguarded fetch"
								: "missing resolved-address assertion"
						})`,
					);
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return offenders;
}

describe("MCP SDK configured-server transport address guard", () => {
	it("rejects a constructor without a fetch option", () => {
		expect(
			findUnguardedTransports(
				"assertMcpServerUrlResolved(url); new StreamableHTTPClientTransport(url, {});",
				"bad.ts",
			),
		).toEqual([
			"bad.ts:1 (StreamableHTTPClientTransport: unguarded fetch)",
		]);
	});

	it("rejects global fetch even when a resolved-address assertion exists", () => {
		expect(
			findUnguardedTransports(
				"assertMcpServerUrlResolved(url); new SSEClientTransport(url, { fetch: globalThis.fetch });",
				"bad.ts",
			),
		).toEqual(["bad.ts:1 (SSEClientTransport: unguarded fetch)"]);
	});

	it("rejects a guarded fetch when the pre-connect resolved-address assertion is absent", () => {
		expect(
			findUnguardedTransports(
				"new SSEClientTransport(url, { fetch: fetchMcpServer });",
				"bad.ts",
			),
		).toEqual([
			"bad.ts:1 (SSEClientTransport: missing resolved-address assertion)",
		]);
	});

	it("rejects a resolved-address assertion that runs after transport construction", () => {
		expect(
			findUnguardedTransports(
				"new SSEClientTransport(url, { fetch: fetchMcpServer }); assertMcpServerUrlResolved(url);",
				"bad.ts",
			),
		).toEqual([
			"bad.ts:1 (SSEClientTransport: missing resolved-address assertion)",
		]);
	});

	it("accepts both direct and GitLab-or-guard fallback fetches", () => {
		expect(
			findUnguardedTransports(
				`assertMcpServerUrlResolved(url);
new SSEClientTransport(url, { fetch: fetchMcpServer });
new StreamableHTTPClientTransport(url, { fetch: transportFetch ?? fetchMcpServer });`,
				"guarded.ts",
			),
		).toEqual([]);
	});

	it("finds no unguarded production MCP HTTP transport", () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const absoluteFile of walkTsFiles(root)) {
				const file = relative(repoRoot, absoluteFile)
					.split(sep)
					.join("/");
				if (ALLOWLIST.has(file)) {
					continue;
				}
				offenders.push(
					...findUnguardedTransports(
						readFileSync(absoluteFile, "utf8"),
						file,
					),
				);
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`${offenders.length} MCP SDK HTTP transport(s) can bypass the configured-server address guard:\n\n${offenders
					.map((offender) => `  ${offender}`)
					.join(
						"\n",
					)}\n\nPass fetchMcpServer (or transportFetch ?? fetchMcpServer for the origin-bound GitLab path) and call assertMcpServerUrlResolved before resolving credentials or connecting.`,
			);
		}

		expect(offenders).toEqual([]);
	});
});
