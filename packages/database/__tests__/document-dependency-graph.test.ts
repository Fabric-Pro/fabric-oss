import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCUMENT_PHASES } from "../../temporal/src/workflows/batch-document-generation";
import { ProjectDocumentType } from "../prisma/generated/enums";
import {
	DOCUMENT_TIERS,
	isDocumentAvailable,
} from "../src/document-dependency-graph";

/**
 * The prerequisite graph had two hand-written copies — the project wizard's
 * `DOCUMENT_TIERS` and the batch workflow's phase numbers, whose comment asked
 * the next reader to keep them matching. These tests are what stops the single
 * copy from quietly growing a hole: a document type the graph does not name is
 * "available now, phase 1" at every lookup, which is the answer that generates
 * an architecture document before any requirements exist.
 */
describe("document dependency graph", () => {
	it("names every document type the schema can store", () => {
		// Exhaustiveness is enforced at COMPILE time by the `satisfies` clause in
		// the module. Asserted again at RUNTIME because the compile-time check
		// only fires for whoever edits the enum with a working type-check — and
		// the cost of missing it is silent, not loud.
		for (const type of Object.values(ProjectDocumentType)) {
			expect(DOCUMENT_TIERS[type]).toBeDefined();
		}
		expect(Object.keys(DOCUMENT_TIERS).sort()).toEqual(
			Object.values(ProjectDocumentType).sort(),
		);
	});

	it("makes a foundation document available against nothing at all", () => {
		expect(DOCUMENT_TIERS.PRD).toEqual({ tier: 1, prerequisites: [] });
		expect(isDocumentAvailable("PRD", new Set())).toBe(true);
	});

	it("holds a tier-2 document back until ONE prerequisite is satisfied", () => {
		// OR, not AND. Architecture needs a statement of intent to build from,
		// and a PRD and a Proposal are two ways of writing the same one down —
		// demanding both would block a project that deliberately wrote one.
		expect(DOCUMENT_TIERS.ARCHITECTURE.prerequisites).toEqual([
			"PRD",
			"PROPOSAL",
		]);
		expect(isDocumentAvailable("ARCHITECTURE", new Set())).toBe(false);
		expect(isDocumentAvailable("ARCHITECTURE", new Set(["PRD"]))).toBe(
			true,
		);
		expect(isDocumentAvailable("ARCHITECTURE", new Set(["PROPOSAL"]))).toBe(
			true,
		);
		expect(
			isDocumentAvailable("ARCHITECTURE", new Set(["PRD", "PROPOSAL"])),
		).toBe(true);
	});

	it("holds features back until any technical document exists", () => {
		expect(isDocumentAvailable("USER_STORY", new Set(["PRD"]))).toBe(false);
		expect(isDocumentAvailable("USER_STORY", new Set(["API_SPEC"]))).toBe(
			true,
		);
		expect(
			isDocumentAvailable(
				"USER_STORY",
				new Set(["ARCHITECTURE", "TECHNICAL_SPEC", "API_SPEC"]),
			),
		).toBe(true);
	});

	it("gives the batch workflow the same phases as the graph's tiers", () => {
		// The workflow DERIVES `phase` from this graph, so the only way these can
		// disagree is if someone writes the numbers out again by hand. That is
		// exactly the regression worth catching: the batch would then sequence a
		// document ahead of the input the wizard told the user it needs.
		for (const type of Object.keys(DOCUMENT_TIERS)) {
			expect(DOCUMENT_PHASES[type]?.phase).toBe(
				DOCUMENT_TIERS[type].tier,
			);
		}
	});

	it("imports nothing from Prisma as a value", () => {
		// The whole point of the module's location. A single value import here
		// puts the generated Prisma client into the browser bundle that renders
		// the wizard AND into the Temporal workflow sandbox, both of which
		// deep-import this file precisely because it costs them nothing.
		const source = readFileSync(
			fileURLToPath(
				new URL("../src/document-dependency-graph.ts", import.meta.url),
			),
			"utf8",
		);

		const imports = [
			...source.matchAll(
				/^import\s+(?<clause>[\s\S]*?)\s+from\s+"(?<specifier>[^"]+)";$/gm,
			),
		];
		expect(imports).not.toHaveLength(0);
		for (const statement of imports) {
			expect({
				specifier: statement.groups?.specifier,
				typeOnly: statement.groups?.clause.startsWith("type "),
			}).toEqual({
				specifier: statement.groups?.specifier,
				typeOnly: true,
			});
		}

		// Side-effect imports and CommonJS requires slip past the check above.
		expect(source).not.toMatch(/^import\s+"[^"]+";$/m);
		expect(source).not.toMatch(/\brequire\s*\(/);
	});
});
