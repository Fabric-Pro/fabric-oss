/**
 * One catalog of project document types — display label and icon per type.
 *
 * Display names for these types are restated in several surfaces: the create
 * dialog, the editor, the documents list, the prompt binding manager, and more.
 * Each copy is hand-maintained, so a type added to the schema reaches some lists
 * and not others, and the same type reads differently depending on where you saw
 * it — two of those maps are already missing four types and fall back to a
 * de-underscored value.
 *
 * This is where that stops, not evidence that it has stopped. The create flow
 * and the server-side title default read from here; the other surfaces have not
 * been migrated. Point the next one at this map rather than writing a sixth.
 *
 * With one caveat, because the obvious next migration is the wrong one: the
 * documents list renders a SHORT form of these names — `PRD`, `SRS`, `General`
 * — chosen to sit in a dense table, not a stale copy of the long ones below.
 * Repointing it at `label` would silently widen that column. A surface that
 * wants the short form needs a second field here, not the one that exists.
 *
 * The map is keyed by the schema's own union, so a type added to the enum and
 * not to this file is a compile error rather than a silent gap — that is the
 * property the catalog exists for. Keep the entry order: it is the order the
 * create flow's type dropdown presents.
 *
 * This lives in a shared package rather than the web app because the server
 * needs the same labels to default a document's title (see
 * `buildDocumentTitle`), and a second copy on that side would reintroduce
 * exactly the drift this replaces.
 *
 * ## Why the union is declared here instead of imported
 *
 * The obvious move is to import `ProjectDocumentType` from the generated schema
 * and key the map on that. It cannot be done: `@repo/database` depends on this
 * package, so depending on it back is a cycle. Declaring the union locally keeps
 * the compile-time exhaustiveness the map exists for, and
 * `document-type-catalog.test.ts` (which lives in `@repo/api`, where both
 * packages resolve) asserts parity with the schema enum in BOTH directions — a
 * type in the schema and missing here fails, and a type here that the schema
 * dropped fails too. Do not "fix" this by adding the import back.
 */

/** Mirrors the `ProjectDocumentType` enum; parity is test-enforced, see above. */
export type ProjectDocumentTypeName =
	| "GENERAL"
	| "BUSINESS_CASE"
	| "PRD"
	| "PROPOSAL"
	| "ARCHITECTURE"
	| "TECHNICAL_SPEC"
	| "USER_STORY"
	| "API_SPEC"
	| "QA_STRATEGY"
	| "TEST_PLAN"
	| "TEST_REPORT"
	| "TRACEABILITY_MATRIX"
	| "SRS";

export type DocumentTypeCatalogEntry = {
	/** Human-readable name, used for the type dropdown and the default title. */
	label: string;
	/**
	 * The dense form, for a table cell or a dropdown that sits next to several
	 * other fields — `PRD` rather than `Product Requirements Document`. This is
	 * the second field the note above asks for; reach for it when `label` would
	 * widen the column, and never as a way to shorten `label` in place.
	 */
	shortLabel: string;
	/** Presentational only — never load-bearing for behavior. */
	icon: string;
};

export const DOCUMENT_TYPE_CATALOG: Record<
	ProjectDocumentTypeName,
	DocumentTypeCatalogEntry
> = {
	GENERAL: { label: "General Document", shortLabel: "General", icon: "📄" },
	PRD: {
		label: "Product Requirements Document",
		shortLabel: "PRD",
		icon: "📋",
	},
	SRS: {
		label: "Software Requirements Specification",
		shortLabel: "SRS",
		icon: "📑",
	},
	PROPOSAL: { label: "Project Proposal", shortLabel: "Proposal", icon: "📝" },
	BUSINESS_CASE: {
		label: "Business Case",
		shortLabel: "Business Case",
		icon: "📊",
	},
	ARCHITECTURE: {
		label: "Technical Architecture",
		shortLabel: "Architecture",
		icon: "🏗️",
	},
	TECHNICAL_SPEC: {
		label: "Technical Specification",
		shortLabel: "Technical Spec",
		icon: "⚙️",
	},
	USER_STORY: { label: "Features", shortLabel: "Feature", icon: "👤" },
	API_SPEC: {
		label: "API Specification",
		shortLabel: "API Spec",
		icon: "🔌",
	},
	QA_STRATEGY: {
		label: "Testing Strategy",
		shortLabel: "QA Strategy",
		icon: "🧪",
	},
	TEST_PLAN: { label: "Test Plan", shortLabel: "Test Plan", icon: "🗒️" },
	TEST_REPORT: {
		label: "Test Report",
		shortLabel: "Test Report",
		icon: "📊",
	},
	TRACEABILITY_MATRIX: {
		label: "Traceability Matrix",
		shortLabel: "Traceability Matrix",
		icon: "🔗",
	},
};

/** The catalog as an ordered list, for rendering a type picker. */
export const DOCUMENT_TYPE_OPTIONS: readonly ({
	value: ProjectDocumentTypeName;
} & DocumentTypeCatalogEntry)[] = Object.entries(DOCUMENT_TYPE_CATALOG).map(
	([value, entry]) => ({ value: value as ProjectDocumentTypeName, ...entry }),
);

/**
 * The display label for a type.
 *
 * Falls back to a de-underscored form of the value itself rather than throwing:
 * a row written before a type was removed from the enum should still render
 * something a human can read, and a label is never load-bearing for behavior.
 */
export function documentTypeLabel(type: string): string {
	const entry = (
		DOCUMENT_TYPE_CATALOG as Record<
			string,
			DocumentTypeCatalogEntry | undefined
		>
	)[type];
	return entry?.label ?? type.replace(/_/g, " ");
}

/** The dense display label for a type. Falls back exactly as `documentTypeLabel`. */
export function documentTypeShortLabel(type: string): string {
	const entry = (
		DOCUMENT_TYPE_CATALOG as Record<
			string,
			DocumentTypeCatalogEntry | undefined
		>
	)[type];
	return entry?.shortLabel ?? type.replace(/_/g, " ");
}
