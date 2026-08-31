/**
 * Drift guard for `docs/personal-context-surface-map.md`.
 *
 * The surface map enumerates, by name, the models and files that a later
 * tenancy migration will act on. A map naming something that has been renamed
 * or deleted is worse than no map: it reads as current, and the follow-on
 * change trusts it.
 *
 * This guard deliberately checks **existence only** — that every name the map
 * spells out still resolves in the tree. It does not re-run the map's derived
 * counts. Counts move with ordinary feature work and would make this test a
 * chore; a vanished model is always a defect.
 *
 * The repository has two prior documents of this shape. The one backed by a
 * drift test is alive and cited; the one without a guard was deleted rather
 * than revalidated. This is the cheap half of the first one's protection.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../../../..");
const MAP_DOC = join(REPO_ROOT, "docs/personal-context-surface-map.md");
const SCHEMA = join(REPO_ROOT, "packages/database/prisma/schema.prisma");

function read(path: string): string {
	return readFileSync(path, "utf-8");
}

/**
 * Backtick-quoted names that look like Prisma models: PascalCase, no dots or
 * slashes. The map also backticks file paths, config keys and disposition
 * labels — those are filtered out here and covered by the path test below.
 */
function quotedModelNames(doc: string): string[] {
	const quoted = doc.match(/`([A-Z][A-Za-z0-9]+)`/g) ?? [];
	return [...new Set(quoted.map((q) => q.slice(1, -1)))];
}

describe("personal context surface map — the names it spells out still exist", () => {
	it("exists", () => {
		expect(() => read(MAP_DOC)).not.toThrow();
	});

	it("names only models the schema still declares", () => {
		const schema = read(SCHEMA);
		const declared = new Set(
			[...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]),
		);

		// Not every backticked PascalCase token is a model — the map also names
		// TypeScript symbols and class constants. Only assert over tokens that
		// look like models and are not obviously something else.
		const notModels = new Set([
			"Record",
			"Set",
			"NONE",
			"Approved",
			"Proposed",
			"Internal",
		]);

		const missing = quotedModelNames(read(MAP_DOC))
			.filter((name) => !notModels.has(name))
			.filter((name) => name.endsWith("_TABLES") === false)
			.filter((name) => !declared.has(name))
			// Anything the schema does not declare is either a non-model symbol
			// or a drifted name. Keep the ones that read like models.
			.filter((name) => /^[A-Z][a-z]+([A-Z][a-z0-9]*)+$/.test(name));

		expect(missing).toEqual([]);
	});

	/**
	 * Paths the map names *because* they are gone. Deleting the reference would
	 * delete the argument: the map cites the deleted tenant-isolation audit as
	 * the precedent for what happens to a document of this shape with no drift
	 * guard — which is the guard you are reading.
	 */
	const DELIBERATELY_ABSENT = new Set(["docs/TENANT_ISOLATION_AUDIT.md"]);

	/**
	 * Paths that exist, but not in this repository. The compliance tree was cut
	 * when this repository was sanitised for open-source handoff, so these
	 * resolve for someone reading the internal tree and not for anyone here.
	 * The map cites them only from its internal-references blocks and states in
	 * the body that they are elsewhere — keeping the citation is what lets an
	 * engineer with access find the source, so the fix is to allow them, not to
	 * strip them.
	 */
	const OUTSIDE_THIS_REPOSITORY = [/^docs\/compliance\//];

	it("points at repository paths that still exist", () => {
		const doc = read(MAP_DOC);
		const paths =
			doc.match(
				/`((?:apps|packages|docs|scripts)\/[^`\s]+\.(?:ts|tsx|md|mdx|prisma|sh|json))`/g,
			) ?? [];

		expect(paths.length).toBeGreaterThan(0);
		for (const quoted of paths) {
			const relative = quoted.slice(1, -1);
			if (
				DELIBERATELY_ABSENT.has(relative) ||
				OUTSIDE_THIS_REPOSITORY.some((prefix) => prefix.test(relative))
			) {
				continue;
			}
			expect(
				() => read(join(REPO_ROOT, relative)),
				`surface map names ${relative}, which no longer exists`,
			).not.toThrow();
		}
	});

	it("names tenancy classes the query layer still declares", () => {
		const tenantDb = read(
			join(REPO_ROOT, "packages/database/src/tenant-db.ts"),
		);
		const named =
			read(MAP_DOC)
				.match(/`([A-Z_]+_TABLES)`/g)
				?.map((q) => q.slice(1, -1)) ?? [];

		expect(named.length).toBeGreaterThan(0);
		for (const cls of [...new Set(named)]) {
			expect(
				tenantDb,
				`surface map names ${cls}, which is gone`,
			).toContain(cls);
		}
	});
});
