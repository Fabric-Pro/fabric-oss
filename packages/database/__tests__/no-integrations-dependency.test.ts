/**
 * `@repo/integrations` depends on `@repo/database`, so the reverse edge would
 * be a package cycle. The GitLab connection service lives in
 * `@repo/integrations` for that reason, and `@repo/database` only carries
 * dependency-free pieces (lock keys, the personal server keys). This guard
 * keeps it that way: no module here may import `@repo/integrations`, and the
 * manifest may not declare it.
 *
 * Imports are read with TypeScript's own pre-processor, so a mention in a
 * comment or string (several modules here document their relation to
 * `@repo/integrations`) is not an import, while `import`, `export … from`,
 * `import()` and `require()` all are.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(__dirname, "..");
const FORBIDDEN = /^@repo\/integrations(\/|$)/;

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) {
			continue;
		}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (
			/\.(c|m)?tsx?$/.test(entry.name) &&
			!entry.name.endsWith(".d.ts")
		) {
			files.push(path);
		}
	}
	return files;
}

function forbiddenImports(source: string): string[] {
	const info = ts.preProcessFile(source, true, true);
	return info.importedFiles
		.map((ref) => ref.fileName)
		.filter((name) => FORBIDDEN.test(name));
}

describe("@repo/database never depends on @repo/integrations", () => {
	it("the detector sees every import form and ignores comments", () => {
		expect(
			forbiddenImports('import { x } from "@repo/integrations/gitlab";'),
		).toEqual(["@repo/integrations/gitlab"]);
		expect(forbiddenImports('export * from "@repo/integrations";')).toEqual(
			["@repo/integrations"],
		);
		expect(
			forbiddenImports(
				'const m = await import("@repo/integrations/gitlab");',
			),
		).toEqual(["@repo/integrations/gitlab"]);
		expect(
			forbiddenImports('const m = require("@repo/integrations");'),
		).toEqual(["@repo/integrations"]);
		expect(
			forbiddenImports(
				'/**\n * import { a } from "@repo/integrations/x";\n */\n// see @repo/integrations\nconst s = "@repo/integrations";',
			),
		).toEqual([]);
		expect(
			forbiddenImports('import { y } from "@repo/integrations-extra";'),
		).toEqual([]);
	});

	it("no module in the package imports it", () => {
		const files = sourceFiles(PACKAGE_ROOT);
		// The walk really covered the package (a broken walk must not pass).
		expect(files.length).toBeGreaterThan(100);
		expect(files).toContain(join(PACKAGE_ROOT, "prisma/queries/mcp.ts"));

		const offenders = files.flatMap((file) =>
			forbiddenImports(readFileSync(file, "utf8")).map(
				(name) => `${relative(PACKAGE_ROOT, file)} -> ${name}`,
			),
		);
		expect(offenders).toEqual([]);
	});

	it("the manifest does not declare it", () => {
		const manifest = JSON.parse(
			readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
		) as Record<string, Record<string, string> | undefined>;
		for (const field of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies",
		]) {
			expect(Object.keys(manifest[field] ?? {})).not.toContain(
				"@repo/integrations",
			);
		}
	});
});
