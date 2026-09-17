/**
 * ONE dense version sequence for a topic's DRAFT of one content type, across
 * both kinds of entry.
 *
 * The exact sibling of `publishing-analysis-timeline.ts` one level down, and
 * deliberately so: `PublishingTopicDraft` holds what generation produced,
 * `PublishingTopicDraftRevision` holds what a person did to it, and a reader
 * wants one list numbered 1..N rather than two counters to reconcile.
 *
 * Like that module this is a READ-TIME PROJECTION — `seq` is computed from the
 * ordering of rows that already exist, and no stored number is ever renumbered.
 * The reasoning for that choice is written out in the analysis sibling and
 * applies here unchanged: stored version numbers are load-bearing (allocation,
 * uniqueness, the candidate a working draft cites), and renumbering them breaks
 * references that are resolved by value.
 *
 * ── Two adjacent sequences, opposite rules about failures ────────────────────
 *
 * The analysis timeline counts EVERY attempt, including failed ones, because
 * the stored AI scale already did and filtering would have renumbered it
 * downward on screen.
 *
 * This one counts READY generations ONLY, because the draft list always has:
 * `TopicDraftState.versions` is documented "a failed attempt is not a version
 * of anything; it is a run that produced no document". Both are correct for
 * their own table, and the difference is deliberate rather than an oversight.
 *
 * A SIDE EFFECT WORTH KNOWING: `PublishingTopicDraft.version` is allocated
 * `max + 1` over ALL attempts, so a topic whose second run failed has stored
 * READY versions 1, 3, 4 — and the panel showed exactly that, with 2 missing
 * and nothing to explain it. `seq` closes the gap, because it numbers the
 * entries a reader can actually open.
 */

import { db } from "../../client";
import type { DraftPostType } from "./publishing-drafts";

/** One entry in the unified sequence, discriminated by what produced it. */
export type DraftTimelineEntry =
	| {
			kind: "generated";
			/** Display only. Never a write token. */
			seq: number;
			draftId: string;
			/** The STORED `publishing_topic_draft.version`. */
			draftVersion: number;
			createdAt: Date;
			requestedBy: { id: string; name: string } | null;
	  }
	| {
			kind: "edited" | "restored";
			/** Display only. Never a write token. */
			seq: number;
			revisionId: string;
			/** The STORED `publishing_topic_draft_revision.version`. */
			revisionVersion: number;
			/**
			 * The generated version this body descends from, as stored. Null
			 * when it descends from nothing generated.
			 */
			sourceDraftVersion: number | null;
			/**
			 * The same reference on the unified scale, for display. Null when
			 * the referenced generation is absent or was never READY — a wrong
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
 * Order within one instant. `createdAt` alone is not a total order — two rows
 * can share a millisecond and Postgres may return them either way round, which
 * would make `seq` flap between requests. A generation logically precedes a
 * revision derived from it, so ties break generated-first and then by the row's
 * own stored version, which is unique per topic per content type per table.
 */
function compareEntries(
	a: { createdAt: Date; generated: boolean; version: number },
	b: { createdAt: Date; generated: boolean; version: number },
): number {
	const byTime = a.createdAt.getTime() - b.createdAt.getTime();
	if (byTime !== 0) {
		return byTime;
	}
	if (a.generated !== b.generated) {
		return a.generated ? -1 : 1;
	}
	return a.version - b.version;
}

/**
 * One page of a topic's unified draft timeline for one content type, newest
 * first.
 *
 * Both reads are scoped by `{ topicId, projectId, postType }`, so a topic id
 * from another project yields the same empty answer a topic with no drafts does
 * — this cannot be used to probe for topics in projects the caller cannot see.
 *
 * WHY BOTH TABLES ARE READ IN FULL: a dense ordinal is not derivable from a
 * page — `seq` for a row is the count of rows at or before it across BOTH
 * tables, so the ordering must be known completely before any number is
 * correct. What is read in full is deliberately narrow: no `body` and no
 * `content`, the two columns that make these tables large, and both reads ride
 * an existing `(topicId, postType, createdAt)` index. The page slice bounds
 * what is RETURNED, not what is scanned.
 *
 * `seq` is assigned oldest-to-newest so it is STABLE for a given row: both
 * tables are append-only, so a later insert can only add a higher number and
 * never shift one already on screen.
 */
export async function listDraftTimeline(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	/**
	 * The lowest `seq` the caller already holds; the next page is strictly
	 * below it. A position in an ordering, not a claim about a row — an unknown
	 * value yields an empty page rather than an error.
	 */
	cursor?: number | null;
	limit?: number | null;
}): Promise<{ entries: DraftTimelineEntry[]; nextCursor: number | null }> {
	const limit = Math.min(
		Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1),
		MAX_PAGE_SIZE,
	);
	const scope = {
		topicId: input.topicId,
		projectId: input.projectId,
		postType: input.postType,
	};

	const [drafts, revisions] = await Promise.all([
		db.publishingTopicDraft.findMany({
			// READY only — see the module doc. A failed run is not a version.
			where: { ...scope, status: "READY" },
			orderBy: { createdAt: "asc" },
			select: {
				id: true,
				version: true,
				createdAt: true,
				requestedBy: { select: { id: true, name: true } },
			},
		}),
		db.publishingTopicDraftRevision.findMany({
			where: scope,
			orderBy: { createdAt: "asc" },
			select: {
				id: true,
				version: true,
				kind: true,
				sourceDraftVersion: true,
				changeSummary: true,
				createdAt: true,
				author: { select: { id: true, name: true } },
			},
		}),
	]);

	const ordered = [
		...drafts.map((d) => ({
			generated: true as const,
			version: d.version,
			draft: d,
			revision: null,
		})),
		...revisions.map((r) => ({
			generated: false as const,
			version: r.version,
			draft: null,
			revision: r,
		})),
	].sort((a, b) =>
		compareEntries(
			{
				createdAt: (a.draft ?? a.revision).createdAt,
				generated: a.generated,
				version: a.version,
			},
			{
				createdAt: (b.draft ?? b.revision).createdAt,
				generated: b.generated,
				version: b.version,
			},
		),
	);

	// Stored generated version → its place on the unified scale, so a
	// revision's provenance can be shown on the same scale as everything else.
	// Built from the ordering rather than from the raw version, because the two
	// only coincide when nothing was interleaved and no run ever failed.
	const seqByDraftVersion = new Map<number, number>();
	ordered.forEach((item, index) => {
		if (item.draft) {
			seqByDraftVersion.set(item.draft.version, index + 1);
		}
	});

	const entries: DraftTimelineEntry[] = ordered.map((item, index) => {
		const seq = index + 1;
		if (item.draft) {
			return {
				kind: "generated",
				seq,
				draftId: item.draft.id,
				draftVersion: item.draft.version,
				createdAt: item.draft.createdAt,
				requestedBy: item.draft.requestedBy
					? {
							id: item.draft.requestedBy.id,
							name: item.draft.requestedBy.name,
						}
					: null,
			};
		}
		const revision = item.revision;
		return {
			kind: revision.kind === "RESTORED" ? "restored" : "edited",
			seq,
			revisionId: revision.id,
			revisionVersion: revision.version,
			sourceDraftVersion: revision.sourceDraftVersion,
			sourceSeq:
				revision.sourceDraftVersion != null
					? (seqByDraftVersion.get(revision.sourceDraftVersion) ??
						null)
					: null,
			changeSummary: revision.changeSummary,
			createdAt: revision.createdAt,
			author: revision.author
				? { id: revision.author.id, name: revision.author.name }
				: null,
		};
	});

	// Newest first, matching the panel's order.
	entries.reverse();

	// Strictly below the cursor — it names an entry the caller already holds,
	// never one to send again.
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
