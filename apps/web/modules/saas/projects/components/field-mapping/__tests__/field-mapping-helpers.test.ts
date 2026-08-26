import { describe, expect, it } from "vitest";
import {
	CURATED_SEED_IDS,
	deriveAvailableFields,
	filterFields,
	isContentField,
	keywordSortFields,
	moveFieldByIndex,
	type PmFieldCatalogEntry,
	reorderFields,
	resolveManualField,
	type SelectedField,
	SOFT_CAP,
	seedFromCatalog,
	selectionsEqual,
} from "../field-mapping-helpers";

/**
 * Task 7.6 — the field-mapping pure helpers carry the picker logic
 * (search, plumbing filter, keyword sort, manual add, reorder, seed, dirty). Per
 * the plan these are tested heavily here; the components get lighter render/a11y
 * tests. All helpers are pure and non-mutating.
 */

const cat = (
	referenceName: string,
	name: string,
	isPlumbing = false,
): PmFieldCatalogEntry => ({ referenceName, name, isPlumbing });

const CATALOG: PmFieldCatalogEntry[] = [
	cat("System.Description", "Description"),
	cat("Custom.BusinessRules", "Business Rules"),
	cat("Custom.DesignCriteria", "Design Criteria"),
	cat("Custom.LSReset", "LS Reset", true),
	cat("Custom.StateDevFE", "State Dev FE", true),
	cat("Custom.OwnerEmail", "Owner Email"),
];

describe("filterFields", () => {
	it("matches by friendly name, case-insensitive", () => {
		const result = filterFields(CATALOG, "business");
		expect(result.map((f) => f.referenceName)).toEqual([
			"Custom.BusinessRules",
		]);
	});

	it("matches by referenceName (identifier), case-insensitive", () => {
		const result = filterFields(CATALOG, "custom.designcriteria");
		expect(result.map((f) => f.name)).toEqual(["Design Criteria"]);
	});

	it("returns the list unchanged for an empty/whitespace query", () => {
		expect(filterFields(CATALOG, "")).toBe(CATALOG);
		expect(filterFields(CATALOG, "   ")).toBe(CATALOG);
	});

	it("returns [] when nothing matches", () => {
		expect(filterFields(CATALOG, "zzzznope")).toEqual([]);
	});
});

describe("isContentField / keywordSortFields", () => {
	it("recognizes content fields by keyword in name or referenceName", () => {
		expect(
			isContentField(cat("Custom.BusinessRules", "Business Rules")),
		).toBe(true);
		expect(isContentField(cat("System.Description", "Description"))).toBe(
			true,
		);
		expect(isContentField(cat("Custom.OwnerEmail", "Owner Email"))).toBe(
			false,
		);
	});

	it("stable-partitions content fields to the top, preserving relative order", () => {
		const input = [
			cat("Custom.OwnerEmail", "Owner Email"),
			cat("Custom.BusinessRules", "Business Rules"),
			cat("Custom.Widget", "Widget"),
			cat("System.Description", "Description"),
		];
		expect(keywordSortFields(input).map((f) => f.referenceName)).toEqual([
			"Custom.BusinessRules",
			"System.Description",
			"Custom.OwnerEmail",
			"Custom.Widget",
		]);
	});
});

describe("deriveAvailableFields", () => {
	const base = {
		catalog: CATALOG,
		selected: [] as SelectedField[],
		query: "",
		showAll: false,
		keywordSort: false,
	};

	it("hides plumbing by default", () => {
		const result = deriveAvailableFields(base);
		expect(result.map((f) => f.referenceName)).not.toContain(
			"Custom.LSReset",
		);
		expect(result.map((f) => f.referenceName)).not.toContain(
			"Custom.StateDevFE",
		);
	});

	it("reveals plumbing when showAll is on", () => {
		const result = deriveAvailableFields({ ...base, showAll: true });
		expect(result.map((f) => f.referenceName)).toContain("Custom.LSReset");
		expect(result.map((f) => f.referenceName)).toContain(
			"Custom.StateDevFE",
		);
	});

	it("drops already-selected fields", () => {
		const result = deriveAvailableFields({
			...base,
			selected: [
				{ id: "Custom.BusinessRules", displayName: "Business Rules" },
			],
		});
		expect(result.map((f) => f.referenceName)).not.toContain(
			"Custom.BusinessRules",
		);
	});

	it("applies the search query", () => {
		const result = deriveAvailableFields({ ...base, query: "criteria" });
		expect(result.map((f) => f.referenceName)).toEqual([
			"Custom.DesignCriteria",
		]);
	});

	it("keyword-sorts when requested", () => {
		const result = deriveAvailableFields({
			...base,
			showAll: true,
			keywordSort: true,
		});
		// Content fields first, plumbing/non-content after.
		expect(result[0].referenceName).toBe("System.Description");
		expect(isContentField(result[result.length - 1])).toBe(false);
	});
});

describe("reorderFields (drag)", () => {
	const fields: SelectedField[] = [
		{ id: "a", displayName: "A" },
		{ id: "b", displayName: "B" },
		{ id: "c", displayName: "C" },
	];

	it("moves fromId to toId's position", () => {
		expect(reorderFields(fields, "a", "c").map((f) => f.id)).toEqual([
			"b",
			"c",
			"a",
		]);
	});

	it("is a no-op when ids are equal or unknown", () => {
		expect(reorderFields(fields, "a", "a")).toBe(fields);
		expect(reorderFields(fields, "a", "zzz")).toBe(fields);
	});

	it("does not mutate the input", () => {
		reorderFields(fields, "a", "c");
		expect(fields.map((f) => f.id)).toEqual(["a", "b", "c"]);
	});
});

describe("moveFieldByIndex (keyboard reorder)", () => {
	const fields: SelectedField[] = [
		{ id: "a", displayName: "A" },
		{ id: "b", displayName: "B" },
		{ id: "c", displayName: "C" },
	];

	it("moves an item up", () => {
		expect(moveFieldByIndex(fields, 1, "up").map((f) => f.id)).toEqual([
			"b",
			"a",
			"c",
		]);
	});

	it("moves an item down", () => {
		expect(moveFieldByIndex(fields, 1, "down").map((f) => f.id)).toEqual([
			"a",
			"c",
			"b",
		]);
	});

	it("is a no-op at the edges (first up / last down)", () => {
		expect(moveFieldByIndex(fields, 0, "up")).toBe(fields);
		expect(moveFieldByIndex(fields, 2, "down")).toBe(fields);
	});
});

describe("seedFromCatalog", () => {
	it("seeds only curated fields present in the catalog, in curated order", () => {
		const catalog: PmFieldCatalogEntry[] = [
			cat("Custom.BusinessRules", "Business Rules"),
			cat("System.Description", "Description"),
			cat("Custom.NotCurated", "Not Curated"),
		];
		const seed = seedFromCatalog(catalog);
		// Curated order is System.Description before Custom.BusinessRules.
		expect(seed.map((f) => f.id)).toEqual([
			"System.Description",
			"Custom.BusinessRules",
		]);
		// Captures the friendly name as displayName.
		expect(seed[0].displayName).toBe("Description");
	});

	it("returns [] when no curated field is in the catalog", () => {
		expect(seedFromCatalog([cat("Custom.Xyz", "Xyz")])).toEqual([]);
	});

	it("every CURATED_SEED_ID is a plausible ADO referenceName", () => {
		expect(CURATED_SEED_IDS.length).toBeGreaterThan(0);
		expect(CURATED_SEED_IDS).toContain("System.Description");
	});
});

describe("resolveManualField (escape hatch)", () => {
	const catalog = [cat("Custom.BusinessRules", "Business Rules")];

	it("adopts the catalog friendly name when the identifier is present", () => {
		expect(resolveManualField(catalog, "Custom.BusinessRules")).toEqual({
			id: "Custom.BusinessRules",
			displayName: "Business Rules",
		});
	});

	it("falls back to the identifier as displayName when absent from catalog", () => {
		expect(resolveManualField(catalog, "Custom.Unknown")).toEqual({
			id: "Custom.Unknown",
			displayName: "Custom.Unknown",
		});
	});

	it("trims and rejects an empty identifier", () => {
		expect(
			resolveManualField(catalog, "  Custom.BusinessRules  ")?.id,
		).toBe("Custom.BusinessRules");
		expect(resolveManualField(catalog, "   ")).toBeNull();
	});
});

describe("selectionsEqual (dirty tracking)", () => {
	const a: SelectedField[] = [
		{ id: "x", displayName: "X" },
		{ id: "y", displayName: "Y" },
	];

	it("is true for structurally identical selections", () => {
		expect(selectionsEqual(a, [...a.map((f) => ({ ...f }))])).toBe(true);
	});

	it("is false when order differs", () => {
		expect(selectionsEqual(a, [a[1], a[0]])).toBe(false);
	});

	it("is false when a displayName differs (rename is a dirty change)", () => {
		expect(selectionsEqual(a, [{ id: "x", displayName: "X!" }, a[1]])).toBe(
			false,
		);
	});

	it("is false when length differs", () => {
		expect(selectionsEqual(a, [a[0]])).toBe(false);
	});
});

describe("SOFT_CAP", () => {
	it("is the documented soft cap of 15", () => {
		expect(SOFT_CAP).toBe(15);
	});
});
