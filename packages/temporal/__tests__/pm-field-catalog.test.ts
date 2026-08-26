/**
 * PM field-catalog tests.
 *
 * 7.3 — plumbing heuristic: known internal automation/state referenceNames are
 *       flagged `isPlumbing: true`; content-bearing fields are flagged false.
 * 7.4 — enumeration union/dedupe: `buildFieldCatalogFromTypeFields` unions the
 *       per-work-item-type `.fields[]` arrays and dedupes by `referenceName`.
 *
 * `tool-analyzer.ts` has no heavy module-load side effects, so no mocks needed.
 */

import { describe, expect, it } from "vitest";
import {
	buildFieldCatalogFromTypeFields,
	isPlumbingReferenceName,
} from "../src/activities/pm-integration/tool-analyzer";

// =============================================================================
// 7.3 — plumbing heuristic
// =============================================================================

describe("isPlumbingReferenceName", () => {
	it.each([
		"Custom.LSReset",
		"Custom.StateDevFE",
		"Custom.StateDevBE",
		"Custom.IdDevBE",
		"Custom.IdDevFE",
		"Custom.zLSUpdated",
	])("flags known plumbing referenceName %s as plumbing", (refName) => {
		expect(isPlumbingReferenceName(refName)).toBe(true);
	});

	it.each([
		// Curated content fields from the spike — must surface by default.
		"Microsoft.VSTS.Common.AcceptanceCriteria",
		"Custom.BusinessRules",
		"Custom.DesignCriteria",
		"Custom.UserStoryAcceptance",
		"Custom.ReleaseNotes",
		"System.Description",
	])("flags content field %s as NOT plumbing", (refName) => {
		expect(isPlumbingReferenceName(refName)).toBe(false);
	});

	it("never treats standard System.* / Microsoft.VSTS.* fields as plumbing", () => {
		expect(isPlumbingReferenceName("System.Title")).toBe(false);
		expect(isPlumbingReferenceName("System.History")).toBe(false);
		expect(isPlumbingReferenceName("Microsoft.VSTS.TCM.ReproSteps")).toBe(
			false,
		);
	});

	it("matches the pattern families on the local part of a Custom.* name", () => {
		// Pattern-driven (not on the curated denylist) — proves the regex arm.
		expect(isPlumbingReferenceName("Custom.StateDevQA")).toBe(true);
		expect(isPlumbingReferenceName("Custom.zHiddenFlag")).toBe(true);
		expect(isPlumbingReferenceName("Custom.GroupOwner")).toBe(true);
		expect(isPlumbingReferenceName("Custom.RiskLevel")).toBe(true);
	});

	it("errs toward showing (false) for an empty or non-Custom referenceName", () => {
		expect(isPlumbingReferenceName("")).toBe(false);
		expect(isPlumbingReferenceName("StateDevFE")).toBe(false); // no Custom. prefix
	});
});

// =============================================================================
// 7.4 — enumeration union / dedupe
// =============================================================================

describe("buildFieldCatalogFromTypeFields", () => {
	// Two work item types whose field sets overlap (System.Description +
	// Custom.BusinessRules appear on both) — the union must dedupe them.
	const userStoryFields = [
		{ referenceName: "System.Description", name: "Description" },
		{
			referenceName: "Custom.BusinessRules",
			name: "Business Rules",
		},
		{ referenceName: "Custom.LSReset", name: "LS Reset" },
	];
	const bugFields = [
		{ referenceName: "System.Description", name: "Description" }, // dup
		{
			referenceName: "Microsoft.VSTS.TCM.ReproSteps",
			name: "Repro Steps",
		},
		{ referenceName: "Custom.BusinessRules", name: "Business Rules" }, // dup
	];

	it("unions fields across work item types and dedupes by referenceName", () => {
		const catalog = buildFieldCatalogFromTypeFields([
			userStoryFields,
			bugFields,
		]);
		const refs = catalog.map((f) => f.referenceName);
		expect(refs).toEqual([
			"System.Description",
			"Custom.BusinessRules",
			"Custom.LSReset",
			"Microsoft.VSTS.TCM.ReproSteps",
		]);
		// Deduped — each referenceName appears exactly once.
		expect(new Set(refs).size).toBe(refs.length);
	});

	it("computes isPlumbing per entry via the single-source classifier", () => {
		const catalog = buildFieldCatalogFromTypeFields([userStoryFields]);
		const byRef = new Map(catalog.map((f) => [f.referenceName, f]));
		expect(byRef.get("Custom.LSReset")?.isPlumbing).toBe(true);
		expect(byRef.get("Custom.BusinessRules")?.isPlumbing).toBe(false);
		expect(byRef.get("System.Description")?.isPlumbing).toBe(false);
	});

	it("first occurrence wins for the display name across types", () => {
		const catalog = buildFieldCatalogFromTypeFields([
			[{ referenceName: "Custom.Foo", name: "First Label" }],
			[{ referenceName: "Custom.Foo", name: "Second Label" }],
		]);
		expect(catalog).toHaveLength(1);
		expect(catalog[0].name).toBe("First Label");
	});

	it("falls back name → referenceName and skips malformed entries", () => {
		const catalog = buildFieldCatalogFromTypeFields([
			[
				{ referenceName: "Custom.NoName" }, // no name → fallback
				{ name: "orphan with no ref" }, // no referenceName → skipped
				null,
				"not-an-object",
				{ referenceName: "" }, // blank ref → skipped
			],
		]);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toEqual({
			referenceName: "Custom.NoName",
			name: "Custom.NoName",
			isPlumbing: false,
		});
	});

	it("ignores non-array inputs (a failed per-type fetch) without throwing", () => {
		const catalog = buildFieldCatalogFromTypeFields([
			userStoryFields,
			undefined,
			null,
			{ notAnArray: true },
		]);
		expect(catalog.map((f) => f.referenceName)).toEqual([
			"System.Description",
			"Custom.BusinessRules",
			"Custom.LSReset",
		]);
	});

	it("returns an empty catalog for no types", () => {
		expect(buildFieldCatalogFromTypeFields([])).toEqual([]);
	});
});
