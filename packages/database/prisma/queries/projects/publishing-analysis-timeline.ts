/**
 * ONE dense version sequence for a topic's Planning & Analysis, across both
 * kinds of entry (Fizzy #1851 follow-on).
 *
 * A topic has two independent counters: AI runs in
 * `publishing_topic_planning_analysis.version`, and hand-saved prose in
 * `publishing_topic_analysis_revision.version`. Each starts at 1. After six AI
 * runs a first manual save displayed as "Version 1 · AI v6", which reads as the
 * version going backwards.
 *
 * This module is the fix, and it is a READ-TIME PROJECTION. It stores nothing
 * and renumbers nothing: `seq` below is computed from the ordering of rows that
 * already exist, so every topic gets the unified numbering immediately with no
 * backfill, and every stored number keeps the meaning it already had.
 *
 * ── Why the numbering is not simply reassigned ───────────────────────────────
 *
 * Renumbering was considered and rejected on evidence, not taste:
 *
 *  - `sourceAnalysisVersion` is a VALUE REFERENCE into
 *    `publishing_topic_planning_analysis.version`, resolved by equality in
 *    `saveAnalysisRevision` (`findFirst({ version, status: "READY" })`) and
 *    again in the outcome writer. Renumbering the AI side requires rewriting
 *    that field on every revision row AND every outcome row in lockstep; miss
 *    one and a legitimate save returns "that analysis version no longer
 *    exists", or the stale-analysis banner goes permanently quiet.
 *  - `revision.version` is the optimistic-concurrency token (`expectedVersion`)
 *    AND the keyset pagination cursor (`version: { lt: cursor }`). Renumbering
 *    it hands a spurious CONFLICT to every editor open across the deploy.
 *  - `changeSummary` persists free text — "Restored from version 3". No
 *    migration can correct prose.
 *
 * ── Why the next number is not simply allocated across both tables ───────────
 *
 * THE SHORTCUT TO RESIST, and the reason this docblock is here rather than in a
 * commit message: allocating the next version as `max()` across both tables is
 * nearly a one-line change, and it does make the next save land on 7. It is
 * still wrong. Without a backfill the history drawer then opens on a single
 * entry numbered 7 with nothing behind it — no v1 through v6 — because the
 * earlier rows keep their old numbers on their old scales. "My save is v7 and
 * the history behind it is empty" reads worse than the "v1 · AI v6" it was
 * meant to fix. A projection numbers the rows that are already there, which is
 * the only way the sequence is dense for topics that exist today.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 * `seq` is DISPLAY ONLY and must never be accepted as input to a write. The
 * stored numbers ride alongside it under their own names — `analysisVersion`,
 * `revisionVersion`, `sourceAnalysisVersion` — so a caller reaching for a write
 * token finds the real one and never the projection.
 */

import { db } from "../../client";

/**
 * Does a FAILED or still-GENERATING AI attempt occupy a visible number?
 *
 * YES, and this is the one line to change if that call is ever revisited.
 *
 * Every attempt takes its `version` at start, before the outcome is known, so
 * the stored AI scale ALREADY counts failed runs — the "6" a user sees comes
 * from `aiVersion: latestReady?.version`, a raw stored number that includes any
 * prior failure. Counting only READY runs here would renumber the AI side
 * DOWNWARD on screen, reintroducing the very "the version went backwards"
 * complaint this projection exists to remove.
 *
 * The entry carries its `status`, so a failed run can read as failed rather
 * than having to be hidden to be understood.
 */
const COUNTS_EVERY_ATTEMPT: boolean = true;

/** One entry in the unified sequence, discriminated by what produced it. */
export type AnalysisTimelineEntry =
	| {
			kind: "ai_run";
			/** Display only. Never a write token. */
			seq: number;
			analysisId: string;
			/** The STORED `publishing_topic_planning_analysis.version`. */
			analysisVersion: number;
			status: string;
			createdAt: Date;
			requestedBy: { id: string; name: string } | null;
	  }
	| {
			kind: "revision";
			/** Display only. Never a write token. */
			seq: number;
			revisionId: string;
			/**
			 * The STORED `publishing_topic_analysis_revision.version` — the
			 * compare-and-set token. A caller that needs `expectedVersion` wants
			 * THIS, never `seq`.
			 */
			revisionVersion: number;
			/**
			 * The STORED AI version this body was seeded from. A restore sends
			 * it back verbatim; deriving it from the current analysis would
			 * claim the author read something they never saw.
			 */
			sourceAnalysisVersion: number;
			/**
			 * The same reference expressed on the unified scale, for display.
			 * `null` when the referenced analysis row is not present — a wrong
			 * number would be worse than an absent one.
			 */
			sourceSeq: number | null;
			changeSummary: string | null;
			createdAt: Date;
			author: { id: string; name: string } | null;
	  };

/** Page size when the caller names none. Entries are light — no bodies. */
const DEFAULT_PAGE_SIZE = 25;

/** Ceiling on a caller-named page size, matching the API schema. */
const MAX_PAGE_SIZE = 100;

/**
 * Order within one instant.
 *
 * `createdAt` alone is not a total order — two rows can share a millisecond,
 * and Postgres may then return them either way round, which would make `seq`
 * flap between requests. An AI run logically precedes a revision seeded from
 * it, so ties break AI-first and then by the row's own stored version, which is
 * unique per topic per table. The result is deterministic.
 */
function compareEntries(
	a: { createdAt: Date; kind: string; version: number },
	b: { createdAt: Date; kind: string; version: number },
): number {
	const byTime = a.createdAt.getTime() - b.createdAt.getTime();
	if (byTime !== 0) {
		return byTime;
	}
	if (a.kind !== b.kind) {
		return a.kind === "ai_run" ? -1 : 1;
	}
	return a.version - b.version;
}

/**
 * One page of a topic's unified analysis timeline, newest first.
 *
 * Both reads are scoped by `{ topicId, projectId }`, so a topic id from another
 * project yields the same empty answer a topic with no analysis does — this
 * cannot be used to probe for topics in projects the caller cannot see (DV16).
 *
 * WHY BOTH TABLES ARE READ IN FULL: a dense ordinal is not derivable from a
 * page. `seq` for a row is the count of rows at or before it across BOTH
 * tables, so the ordering must be known completely before any number is
 * correct. What is read in full is deliberately narrow — no `body`, no
 * `content`, the two columns that make these tables large — and both reads ride
 * the existing `@@index([topicId, createdAt])`. The page slice then bounds what
 * is returned, not what is scanned.
 *
 * `seq` is assigned oldest-to-newest so it is STABLE for a given row: these
 * tables are append-only, so a later insert can only add a higher number and
 * never shift one already shown. Deriving it as `total - offset` instead would
 * let a concurrent save shift every number on screen between page one and page
 * two — the artefact the sibling keyset cursor exists to avoid.
 */
export async function listAnalysisTimeline(input: {
	topicId: string;
	projectId: string;
	/**
	 * The lowest `seq` the caller already holds; the next page is strictly
	 * below it. Like the sibling cursor this is a position in an ordering, not
	 * a claim about a row: a cursor naming a number that never existed yields
	 * an empty page rather than an error.
	 */
	cursor?: number | null;
	limit?: number | null;
}): Promise<{ entries: AnalysisTimelineEntry[]; nextCursor: number | null }> {
	const limit = Math.min(
		Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1),
		MAX_PAGE_SIZE,
	);
	const scope = { topicId: input.topicId, projectId: input.projectId };

	const [analyses, revisions] = await Promise.all([
		db.publishingTopicPlanningAnalysis.findMany({
			where: scope,
			orderBy: { createdAt: "asc" },
			select: {
				id: true,
				version: true,
				status: true,
				createdAt: true,
				requestedBy: { select: { id: true, name: true } },
			},
		}),
		db.publishingTopicAnalysisRevision.findMany({
			where: scope,
			orderBy: { createdAt: "asc" },
			select: {
				id: true,
				version: true,
				sourceAnalysisVersion: true,
				changeSummary: true,
				createdAt: true,
				author: { select: { id: true, name: true } },
			},
		}),
	]);

	const ordered = [
		...analyses
			.filter((a) => COUNTS_EVERY_ATTEMPT || a.status === "READY")
			.map((a) => ({
				kind: "ai_run" as const,
				version: a.version,
				row: a,
			})),
		...revisions.map((r) => ({
			kind: "revision" as const,
			version: r.version,
			row: r,
		})),
	].sort((a, b) =>
		compareEntries(
			{ createdAt: a.row.createdAt, kind: a.kind, version: a.version },
			{ createdAt: b.row.createdAt, kind: b.kind, version: b.version },
		),
	);

	// Stored AI version → its place on the unified scale, so a revision's
	// provenance badge can be shown on the same scale as everything else. Built
	// from the ordering above rather than from the raw version, because the two
	// only coincide when no revision was ever interleaved.
	const seqByAnalysisVersion = new Map<number, number>();
	ordered.forEach((item, index) => {
		if (item.kind === "ai_run") {
			seqByAnalysisVersion.set(item.version, index + 1);
		}
	});

	const entries: AnalysisTimelineEntry[] = ordered.map((item, index) => {
		const seq = index + 1;
		if (item.kind === "ai_run") {
			return {
				kind: "ai_run",
				seq,
				analysisId: item.row.id,
				analysisVersion: item.row.version,
				status: item.row.status,
				createdAt: item.row.createdAt,
				requestedBy: item.row.requestedBy
					? {
							id: item.row.requestedBy.id,
							name: item.row.requestedBy.name,
						}
					: null,
			};
		}
		return {
			kind: "revision",
			seq,
			revisionId: item.row.id,
			revisionVersion: item.row.version,
			sourceAnalysisVersion: item.row.sourceAnalysisVersion,
			sourceSeq:
				seqByAnalysisVersion.get(item.row.sourceAnalysisVersion) ??
				null,
			changeSummary: item.row.changeSummary,
			createdAt: item.row.createdAt,
			author: item.row.author
				? { id: item.row.author.id, name: item.row.author.name }
				: null,
		};
	});

	// Newest first, matching the sibling history read and the drawer's order.
	entries.reverse();

	// Strictly below the cursor — it names an entry the caller already holds,
	// never one to send again. An inclusive bound would repeat an entry at every
	// page boundary, which in a version list reads as a duplicate save.
	//
	// Bound to a local first: narrowing `input.cursor` does not survive into the
	// predicate closure, because nothing proves the property is not reassigned
	// between the check and the call.
	const cursor = input.cursor;
	const page = (
		cursor != null ? entries.filter((e) => e.seq < cursor) : entries
	).slice(0, limit);

	const last = page[page.length - 1];
	const hasMore = last != null && last.seq > 1;

	return {
		entries: page,
		// Null means "this is the last page", never "start again".
		nextCursor: hasMore ? (last?.seq ?? null) : null,
	};
}
