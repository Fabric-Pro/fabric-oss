/**
 * Guards the Azure DevOps MCP version pin.
 *
 * Fabric's ADO sync (capability detection, push, pull, state polling) matches
 * the granular tool names that `@azure-devops/mcp` dropped in 2.9.0, when it
 * consolidated them into action-dispatched tools. Only a few read paths go
 * through `resolveAdoTool`, so sync keeps working across upstream releases only
 * while every place that spawns the server stays on one exact pre-2.9 version.
 * The catalog seeds and the wrapper image's global install are those places:
 * an unversioned `npx -y @azure-devops/mcp` resolves to the global install.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../../", import.meta.url);

const PIN_SOURCES = [
	"packages/database/prisma/seed.ts",
	"packages/database/prisma/seed-enterprise-mcp.ts",
	"packages/mcp-stdio-wrapper/Dockerfile",
];

function adoVersionSpecs(relativePath: string): (string | null)[] {
	const text = fs.readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
	return [...text.matchAll(/@azure-devops\/mcp(?:@([^\s"'`\\]+))?/g)].map(
		(match) => match[1] ?? null,
	);
}

const specsBySource = Object.fromEntries(
	PIN_SOURCES.map((source) => [source, adoVersionSpecs(source)]),
);

describe("Azure DevOps MCP version pin", () => {
	it("pins one exact version everywhere the server is spawned", () => {
		for (const [source, specs] of Object.entries(specsBySource)) {
			expect(
				specs.length,
				`${source} names the ADO MCP package`,
			).toBeGreaterThan(0);
			for (const spec of specs) {
				expect(spec, `${source} pins an exact version`).toMatch(
					/^\d+\.\d+\.\d+$/,
				);
			}
		}
		expect(new Set(Object.values(specsBySource).flat()).size).toBe(1);
	});

	it("stays on the granular tool surface the sync call sites match", () => {
		const [major, minor] = String(Object.values(specsBySource).flat()[0])
			.split(".")
			.map(Number);
		expect(
			major < 2 || (major === 2 && minor < 9),
			"2.9.0 replaced the granular wit_* tools; move every ADO call site onto resolveAdoTool before raising the pin. 2.10.0 also wraps every tool result in untrusted-content delimiters the sync parsers cannot JSON.parse, and exits at startup on node:22-slim unless the wrapper image installs libsecret-1-0.",
		).toBe(true);
	});
});
