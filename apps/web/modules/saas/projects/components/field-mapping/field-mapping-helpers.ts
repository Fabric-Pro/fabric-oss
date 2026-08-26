import { arrayMove } from "@dnd-kit/sortable";
import type { FieldMappingField } from "@repo/database/src/field-mapping-schema";

/**
 * One enumerated PM field from the catalog (transient, not persisted). Returned
 * by `projects.pm.enumerateFields`. `isPlumbing` is a server-computed hint used
 * to hide internal automation/state fields behind the "Show all fields" toggle.
 */
export type PmFieldCatalogEntry = {
	referenceName: string;
	name: string;
	isPlumbing: boolean;
};

/** A field the admin has selected, in the shape persisted to `fieldMapping.fields[]`. */
export type SelectedField = FieldMappingField;

/**
 * Soft cap on selected field count. "Soft" = the UI
 * warns and discourages beyond this rather than hard-rejecting. Guards against
 * runaway aggregation approaching the ~2 MiB Temporal PM-sync input limit and
 * RAG/ProjectContext inflation (§7.4).
 */
export const SOFT_CAP = 15;

/**
 * Curated content-bearing ADO fields from the spike.
 * Used only to pre-fill an initial selection on first open — intersected with the
 * enumerated catalog so we never seed a field the project doesn't have. Order
 * here is the seeded display order.
 */
export const CURATED_SEED_IDS: readonly string[] = [
	"System.Description",
	"Microsoft.VSTS.Common.AcceptanceCriteria",
	"Custom.BusinessRules",
	"Custom.UserStoryAcceptance",
	"Custom.DesignCriteria",
	"Custom.ReleaseNotes",
];

/**
 * Keywords that mark a field as a likely content-bearing field.
 * Used by the optional keyword sort to surface these toward the top of the
 * available list. Matched case-insensitively against both `name` and
 * `referenceName`.
 */
const CONTENT_KEYWORDS: readonly string[] = [
	"acceptance",
	"business rules",
	"description",
	"design criteria",
	"release notes",
	"notes",
	"details",
	"summary",
];

/**
 * Case-insensitive search over the catalog. Matches BOTH the friendly `name`
 * (ADO field `name`) and the `referenceName` (ADO identifier) so an admin can
 * find a field by either. An empty/whitespace query returns the list unchanged.
 */
export function filterFields(
	catalog: PmFieldCatalogEntry[],
	query: string,
): PmFieldCatalogEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return catalog;
	}
	return catalog.filter(
		(f) =>
			f.name.toLowerCase().includes(q) ||
			f.referenceName.toLowerCase().includes(q),
	);
}

/** True when a field's name or referenceName matches any content keyword. */
export function isContentField(field: PmFieldCatalogEntry): boolean {
	const haystack = `${field.name} ${field.referenceName}`.toLowerCase();
	return CONTENT_KEYWORDS.some((kw) => haystack.includes(kw));
}

/**
 * Optional keyword sort: stable-partition likely content fields to
 * the top, preserving the catalog's relative order within each group. Pure and
 * non-mutating.
 */
export function keywordSortFields(
	catalog: PmFieldCatalogEntry[],
): PmFieldCatalogEntry[] {
	const content: PmFieldCatalogEntry[] = [];
	const rest: PmFieldCatalogEntry[] = [];
	for (const field of catalog) {
		(isContentField(field) ? content : rest).push(field);
	}
	return [...content, ...rest];
}

/**
 * Derive the available list from the full catalog: drop already-selected fields,
 * hide plumbing unless `showAll`, filter by the search query, and (optionally)
 * keyword-sort. Single source of truth for what the available column renders.
 */
export function deriveAvailableFields(params: {
	catalog: PmFieldCatalogEntry[];
	selected: SelectedField[];
	query: string;
	showAll: boolean;
	keywordSort: boolean;
}): PmFieldCatalogEntry[] {
	const { catalog, selected, query, showAll, keywordSort } = params;
	const selectedIds = new Set(selected.map((f) => f.id));
	let list = catalog.filter((f) => !selectedIds.has(f.referenceName));
	if (!showAll) {
		list = list.filter((f) => !f.isPlumbing);
	}
	list = filterFields(list, query);
	return keywordSort ? keywordSortFields(list) : list;
}

/** Reorder a selected list by moving `fromId` to `toId`'s position (drag). */
export function reorderFields(
	fields: SelectedField[],
	fromId: string,
	toId: string,
): SelectedField[] {
	const from = fields.findIndex((f) => f.id === fromId);
	const to = fields.findIndex((f) => f.id === toId);
	if (from === -1 || to === -1 || from === to) {
		return fields;
	}
	return arrayMove(fields, from, to);
}

/** Move the field at `index` one slot up or down (keyboard reorder). */
export function moveFieldByIndex(
	fields: SelectedField[],
	index: number,
	direction: "up" | "down",
): SelectedField[] {
	const target = direction === "up" ? index - 1 : index + 1;
	if (index < 0 || target < 0 || target >= fields.length) {
		return fields;
	}
	return arrayMove(fields, index, target);
}

/**
 * Build the curated starting selection: intersect CURATED_SEED_IDS
 * with the enumerated catalog, capturing each field's friendly `name` as the
 * displayName, in curated order. Fields absent from the catalog are skipped.
 */
export function seedFromCatalog(
	catalog: PmFieldCatalogEntry[],
): SelectedField[] {
	const byRef = new Map(catalog.map((f) => [f.referenceName, f]));
	const seeded: SelectedField[] = [];
	for (const id of CURATED_SEED_IDS) {
		const entry = byRef.get(id);
		if (entry) {
			seeded.push({ id, displayName: entry.name });
		}
	}
	return seeded;
}

/**
 * Resolve the displayName for a manually-typed identifier (spec §2.4.5 escape
 * hatch): if the identifier is in the catalog, adopt its friendly `name`;
 * otherwise fall back to the identifier itself (admin may edit the label).
 */
export function resolveManualField(
	catalog: PmFieldCatalogEntry[],
	identifier: string,
): SelectedField | null {
	const id = identifier.trim();
	if (!id) {
		return null;
	}
	const match = catalog.find((f) => f.referenceName === id);
	return { id, displayName: match ? match.name : id };
}

/** Structural equality of two ordered selections — drives the dirty indicator. */
export function selectionsEqual(
	a: SelectedField[],
	b: SelectedField[],
): boolean {
	if (a.length !== b.length) {
		return false;
	}
	return a.every(
		(field, i) =>
			field.id === b[i].id && field.displayName === b[i].displayName,
	);
}
