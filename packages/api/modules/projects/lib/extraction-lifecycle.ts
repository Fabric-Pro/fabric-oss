/**
 * Which context rows have an extraction lifecycle at all (Fizzy #2886).
 *
 * Deliberately import-free, like `readiness/thresholds.ts`: the Context tab is a
 * client component and reads the same predicate the capability evidence does,
 * so the two can never disagree about which rows are "in flight".
 *
 * Every context kind runs through extraction and reports its progress on
 * `extractionStatus` — except most `INTEGRATION` rows. A Slack, Teams, Notion or
 * backlog integration is a live link whose ingest is owned elsewhere, so its
 * status column is written PENDING at creation and nothing ever moves it. Read
 * as work in flight, such a row is a source "still processing" forever, and a
 * stall once the clock runs out — a banner about a source that was never going
 * to finish, on projects whose integrations are working exactly as designed.
 *
 * The one exception is Google Docs: an `INTEGRATION` row that is exported to
 * storage and run through the full extraction pipeline, with a real status that
 * can stall or fail like any upload.
 */

/** Statuses that mean a row's extraction has not settled yet. */
const IN_FLIGHT_EXTRACTION_STATUSES = ["PENDING", "EXTRACTING"];

/** The `metadata.source` an integration row with a real pipeline carries. */
const GOOGLE_DOCS_SOURCE = "google-docs";

/** Whether this row's `extractionStatus` describes real background work. */
export function hasExtractionLifecycle(row: {
	type: string;
	metadata?: unknown;
}): boolean {
	if (row.type !== "INTEGRATION") {
		return true;
	}
	const metadata = row.metadata as { source?: unknown } | null | undefined;
	return metadata?.source === GOOGLE_DOCS_SOURCE;
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
		],
	};
}
