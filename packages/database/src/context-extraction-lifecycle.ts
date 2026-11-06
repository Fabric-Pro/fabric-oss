/**
 * Import-free: a client component and capability evidence share this contract
 * (Fizzy #2886). Live-link integrations do not settle through extraction.
 * Google Docs run extraction; Notion pages run embedding from their saved text.
 */

/**
 * contextEmbeddingWorkflow in packages/temporal/src/workflows/context-embedding.ts:
 * 3 attempts × 5-minute startToCloseTimeout + 1s and 2s retry backoffs
 * (initialInterval 1s, backoffCoefficient 2, maximumInterval 30s).
 * Keep this quiet window aligned with that policy. Queue delays are not bounded here.
 */
export const CONTEXT_EMBEDDING_RETRY_WINDOW_MS =
	3 * 5 * 60 * 1000 + 1000 + 2000;

/** Statuses that mean a row's extraction has not settled yet. */
const IN_FLIGHT_EXTRACTION_STATUSES = ["PENDING", "EXTRACTING"];

/** The `metadata.source` an integration row with a real pipeline carries. */
const GOOGLE_DOCS_SOURCE = "google-docs";

/** Whether this row's `extractionStatus` describes real background work. */
export function hasExtractionLifecycle(row: {
	type: string;
	metadata?: unknown;
	content?: string | null;
	contentPreview?: string | null;
	contentLength?: number;
}): boolean {
	if (row.type !== "INTEGRATION") {
		return true;
	}
	const metadata = row.metadata as
		| { source?: unknown; provider?: unknown }
		| null
		| undefined;
	return (
		metadata?.source === GOOGLE_DOCS_SOURCE ||
		(metadata?.provider === "notion" &&
			(typeof row.content === "string"
				? row.content.trim().length > 0
				: (row.contentPreview?.trim().length ?? 0) > 0))
	);
}

/**
 * The same predicate as a Prisma `where` fragment, for a read that counts rows
 * in flight: every row EXCEPT a lifecycle-less integration still in flight.
 *
 * Written as a positive `OR` on purpose. The obvious `NOT { type: INTEGRATION,
 * metadata: { path: ["source"], not: "google-docs" } }` excludes every row
 * whose metadata lacks the key — JSON path comparisons against a missing key
 * are NULL, and `NOT NULL` is not true — so it would drop completed integration
 * rows from the totals along with the ones it meant to drop. Each arm here is
 * a plain positive test, and a settled integration row satisfies the second.
 *
 * A function rather than a constant so every caller gets fresh arrays: Prisma
 * rejects a readonly tuple in `notIn`, and a shared object is one accidental
 * mutation away from changing every read that spreads it.
 */
export function withExtractionLifecycleOrSettled() {
	return {
		OR: [
			{ type: { not: "INTEGRATION" as const } },
			{
				extractionStatus: {
					notIn: [...IN_FLIGHT_EXTRACTION_STATUSES] as (
						| "PENDING"
						| "EXTRACTING"
					)[],
				},
			},
			{ metadata: { path: ["source"], equals: GOOGLE_DOCS_SOURCE } },
			// Prisma cannot express trim(content) or a whitespace regex here.
			// Empty rows are excluded; whitespace-only legacy rows remain a SQL
			// filter gap relative to hasExtractionLifecycle's trimmed predicate.
			{
				metadata: { path: ["provider"], equals: "notion" },
				content: { not: "" },
			},
		],
	};
}
