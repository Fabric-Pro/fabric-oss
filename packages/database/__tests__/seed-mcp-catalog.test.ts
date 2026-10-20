import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	CURATED_SYSTEM_MCP_SERVER_KEY_SET,
	RETIRED_SYSTEM_MCP_SERVER_KEYS,
} from "../prisma/curated-mcp-server-keys";

import {
	stdioCredentialEnvVar,
	stdioPackageName,
} from "../prisma/stdio-credential-env";

// These definitions feed the MCPServer writers checked below. Keep singleton
// server definitions and both enterprise arrays in the same guard as the main array.
const SEED_INPUTS = [
	{ file: "seed.ts", name: "servers" },
	{ file: "seed.ts", name: "enterpriseServers" },
	{ file: "seed.ts", name: "fizzyServer" },
	{ file: "seed.ts", name: "fabricServer" },
	{ file: "seed-enterprise-mcp.ts", name: "enterpriseServers" },
];

type Entry = {
	key: string;
	command: string | null;
	settings: Record<string, unknown>;
};

function unwrap(expression: ts.Expression): ts.Expression {
	return ts.isAsExpression(expression)
		? unwrap(expression.expression)
		: expression;
}

function inspectSeed(name: string) {
	const source = ts.createSourceFile(
		name,
		readFileSync(new URL(`../prisma/${name}`, import.meta.url), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const catalogs = SEED_INPUTS.filter((input) => input.file === name).map(
		(input) => ({
			...input,
			entries: [] as Entry[],
			issues: [] as string[],
			declarations: 0,
		}),
	);
	const writerSources: string[] = [];
	function visit(node: ts.Node) {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			const catalog = catalogs.find(
				(input) => input.name === node.name.getText(source),
			);
			if (catalog) {
				catalog.declarations++;
				const value = unwrap(node.initializer);
				const elements = ts.isArrayLiteralExpression(value)
					? value.elements
					: [value];
				for (const element of elements) {
					if (!ts.isObjectLiteralExpression(element)) {
						catalog.issues.push(
							"Expected a literal server definition",
						);
						continue;
					}
					const settings: Record<string, unknown> = {};
					for (const property of element.properties) {
						if (!ts.isPropertyAssignment(property)) {
							catalog.issues.push("Unsupported server property");
							continue;
						}
						const field = property.name.getText(source);
						const value = unwrap(property.initializer);
						if (ts.isStringLiteral(value)) {
							settings[field] = value.text;
						} else if (value.kind === ts.SyntaxKind.NullKeyword) {
							settings[field] = null;
						} else if (ts.isArrayLiteralExpression(value)) {
							settings[field] = value.elements.map((item) =>
								ts.isStringLiteral(item)
									? item.text
									: undefined,
							);
						} else if (field === "command") {
							catalog.issues.push(
								"Command must be a literal string or null",
							);
						}
					}
					if (
						typeof settings.key !== "string" ||
						typeof settings.transport !== "string"
					) {
						catalog.issues.push(
							"Key and transport must be literal strings",
						);
						continue;
					}
					catalog.entries.push({
						key: settings.key,
						command:
							typeof settings.command === "string"
								? settings.command
								: null,
						settings,
					});
				}
			}
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isPropertyAccessExpression(node.expression.expression) &&
			node.expression.expression.name.text === "mCPServer" &&
			["create", "update", "upsert"].includes(node.expression.name.text)
		) {
			let collection: string | undefined;
			for (
				let parent = node.parent;
				parent && !ts.isFunctionLike(parent);
				parent = parent.parent
			) {
				if (ts.isForOfStatement(parent)) {
					collection = parent.expression.getText(source);
					break;
				}
			}
			const argument = node.arguments[0];
			const data =
				argument && ts.isObjectLiteralExpression(argument)
					? argument.properties.find(
							(property): property is ts.PropertyAssignment =>
								ts.isPropertyAssignment(property) &&
								property.name.getText(source) === "data",
						)?.initializer
					: undefined;
			writerSources.push(
				collection ??
					(data && ts.isIdentifier(data)
						? data.text
						: "uninspected writer"),
			);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return { name, catalogs, writerSources };
}

describe("seeded MCP catalog", () => {
	const files = [
		inspectSeed("seed.ts"),
		inspectSeed("seed-enterprise-mcp.ts"),
	];
	const catalogs = files.flatMap((file) => file.catalogs);

	for (const catalog of catalogs) {
		it(`${catalog.file}: inspects ${catalog.name} without unsupported entries`, () => {
			expect(catalog.declarations).toBe(1);
			expect(catalog.issues).toEqual([]);
			expect(catalog.entries.length).toBeGreaterThan(0);
		});
	}
	for (const file of files) {
		it(`${file.name}: covers every MCPServer create/update/upsert writer`, () => {
			const inspectedNames = file.catalogs.map((catalog) => catalog.name);
			expect(file.writerSources.length).toBeGreaterThan(0);
			for (const source of file.writerSources) {
				expect(inspectedNames).toContain(source);
			}
			expect(new Set(file.writerSources)).toEqual(
				new Set(inspectedNames),
			);
		});
	}

	// client.ts uses parseTwilioCredentials for this package's multi-field credentials.
	const DEDICATED_CREDENTIAL_PACKAGES = ["@twilio-alpha/mcp"];
	const apiKeyStdioEntries = catalogs.flatMap(({ file, name, entries }) =>
		entries
			.filter(
				({ settings }) =>
					settings.transport === "STDIO" &&
					Array.isArray(settings.authMethods) &&
					settings.authMethods.includes("API_KEY"),
			)
			.map((entry) => ({ file, name, ...entry })),
	);
	it.each(apiKeyStdioEntries)(
		"$file/$name: $key has a STDIO API-key credential mapping",
		({ command }) => {
			expect(command).not.toBeNull();
			if (
				DEDICATED_CREDENTIAL_PACKAGES.includes(
					stdioPackageName(command ?? "") ?? "",
				)
			) {
				return;
			}
			expect(stdioCredentialEnvVar(command ?? "")).toBeDefined();
		},
	);

	const mainCatalog = catalogs[0]?.entries ?? [];

	it.each([
		["neon", "https://mcp.neon.tech/mcp"],
		["axiom", "https://mcp.axiom.co/mcp"],
		["cloudflare", "https://bindings.mcp.cloudflare.com/mcp"],
	])(
		"%s uses remote HTTP OAuth without a local command",
		(key, defaultUrl) => {
			expect(
				mainCatalog.find((entry) => entry.key === key)?.settings,
			).toMatchObject({
				defaultUrl,
				command: null,
				transport: "HTTP",
				authMethods: ["OAUTH2"],
			});
		},
	);

	it("discovers Axiom at its advertised authorization-server issuer", () => {
		expect(
			mainCatalog.find((entry) => entry.key === "axiom")?.settings
				.oauthDiscoveryUrl,
		).toBe(
			"https://authorization.axiom.co/.well-known/oauth-authorization-server",
		);
	});

	it("discovers Supabase at its advertised authorization-server issuer", () => {
		expect(
			mainCatalog.find((entry) => entry.key === "supabase")?.settings
				.oauthDiscoveryUrl,
		).toBe(
			"https://api.supabase.com/.well-known/oauth-authorization-server",
		);
	});

	it.each([
		[
			"airtable",
			"npx -y airtable-mcp-server@1.14.0",
			"domdomegg",
			"https://github.com/domdomegg/airtable-mcp-server",
		],
		[
			"todoist",
			"npx -y @doist/todoist-mcp@13.6.0",
			"Doist",
			"https://github.com/Doist/todoist-mcp",
		],
		[
			"brave-search",
			"npx -y @brave/brave-search-mcp-server@2.1.4",
			"Brave",
			"https://github.com/brave/brave-search-mcp-server",
		],
	])(
		"%s uses its replacement package and upstream metadata",
		(key, command, author, repositoryUrl) => {
			expect(
				mainCatalog.find((entry) => entry.key === key)?.settings,
			).toMatchObject({
				command,
				author,
				repositoryUrl,
				transport: "STDIO",
			});
		},
	);

	for (const { file, entries } of catalogs) {
		for (const { key, command } of entries) {
			if (!command?.startsWith("npx ")) {
				continue;
			}
			it(`${file}: ${key} pins its npx package to an exact version`, () => {
				const packageSpec = command
					.split(/\s+/)
					.slice(1)
					.find((s) => !s.startsWith("-"));
				expect(packageSpec).toMatch(
					/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+$/i,
				);
			});
		}
	}

	it("keeps retired keys disjoint from the curated allowlist", () => {
		expect(
			RETIRED_SYSTEM_MCP_SERVER_KEYS.filter((key) =>
				CURATED_SYSTEM_MCP_SERVER_KEY_SET.has(key),
			),
		).toEqual([]);
	});

	it("does not recreate retired keys in any seeded server definition", () => {
		const seededKeys = new Set(
			catalogs.flatMap((c) => c.entries.map((s) => s.key)),
		);
		expect(
			RETIRED_SYSTEM_MCP_SERVER_KEYS.filter((key) => seededKeys.has(key)),
		).toEqual([]);
	});
});

describe("stdioPackageName", () => {
	it.each([
		["npx -y @scope/name@1.2.3", "@scope/name"],
		["npx @scope/name", "@scope/name"],
		["npx pkg@1.0.0", "pkg"],
		["npx -y figma-developer-mcp@0.13.2 --stdio", "figma-developer-mcp"],
		["npx --yes pkg@1.0.0", "pkg"],
		["node example-server.js", null],
		["npx -y --yes", null],
		["npx --package pkg", null],
		["", null],
	])("parses %s as %s", (command, expected) => {
		expect(stdioPackageName(command)).toBe(expected);
	});
});
