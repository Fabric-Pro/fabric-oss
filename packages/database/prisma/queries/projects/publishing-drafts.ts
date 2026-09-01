/**
 * Generated-draft reads for a publishing topic (Phase 2B-1, Fizzy #1853).
 *
 * One read this slice, deliberately. The writers — `startTopicDraftAttempt`,
 * `completeTopicDraft`, `failTopicDraft`, `saveWorkingDraft` — arrive in 2B-2
 * and 2B-3 with their first callers; exporting them here would ship four
 * functions nothing calls, which `knip` flags and is right to.
 *
 * The scoping is the interesting part, and it is the same rule the sibling
 * `getLatestPlanningAnalysis` follows: every read filters by `topicId` AND
 * `projectId`. A real topic id belonging to another project therefore produces
 * exactly the answer a topic with no drafts produces, so this endpoint cannot be
 * used to probe for topics in projects the caller cannot see (DV16).
 */

import { db } from "../../client";

/** The four `PublishingTopicPostType` values, in the UI's fixed display order. */
const POST_TYPES = [
	"TWEET",
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
] as const;

export type DraftPostType = (typeof POST_TYPES)[number];

export interface TopicDraftRecord {
	id: string;
	postType: DraftPostType;
	version: number;
	status: string;
	guidance: string | null;
	model: string | null;
	promptSource: string | null;
	promptId: string | null;
	promptVersion: number | null;
	error: string | null;
	requestedById: string | null;
	createdAt: Date;
	updatedAt: Date;
	/**
	 * A GENERATING row whose deadline has passed and which nothing terminalised.
	 *
	 * It exists because the ONLY code that reclaims a stranded row runs inside
	 * the next attempt's start helper, so a UI that disables its generate button
	 * while an attempt reads GENERATING can never reach it — a run whose worker
	 * never started would lock that content type with no user action able to
	 * free it. Computed from the SERVER clock, so no client's skew can widen or
	 * narrow the window.
	 */
	isExpired: boolean;
}

export interface TopicDraftState {
	postType: DraftPostType;
	/** The newest row of any status — what to SAY about the current state. */
	latestAttempt: TopicDraftRecord | null;
	/** The newest READY row — what to RENDER. */
	latestReady: TopicDraftRecord | null;
}

export interface TopicWorkingDraftState {
	postType: DraftPostType;
	/**
	 * Whether a working draft exists. Deliberately a boolean rather than the
	 * body, because 2B-1 renders no draft text and shipping a body to a page
	 * that cannot display it is bytes over the wire for nothing.
	 *
	 * NOT a privacy boundary: a working draft is shared project content, so any
	 * project member may read one. 2B-3 returns the body alongside the editor
	 * that renders it.
	 */
	hasBody: boolean;
	sourceOptionLabel: string | null;
	updatedAt: Date;
}

/**
 * Columns the draft read returns.
 *
 * `content` is absent on purpose — see `TopicWorkingDraftState.hasBody` for the
 * same argument applied to the working draft's `body`. `executionTimeoutAt` IS
 * selected, because `isExpired` is derived from it, but it is not returned:
 * the deadline is an implementation detail of the expiry answer, and shipping
 * both invites a caller to recompute expiry against its own clock.
 */
const DRAFT_SELECT = {
	id: true,
	postType: true,
	version: true,
	status: true,
	guidance: true,
	model: true,
	promptSource: true,
	promptId: true,
	promptVersion: true,
	error: true,
	requestedById: true,
	executionTimeoutAt: true,
	createdAt: true,
	updatedAt: true,
} as const;

interface RawDraftRow {
	id: string;
	postType: string;
	version: number;
	status: string;
	guidance: string | null;
	model: string | null;
	promptSource: string | null;
	promptId: string | null;
	promptVersion: number | null;
	error: string | null;
	requestedById: string | null;
	executionTimeoutAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

function toRecord(row: RawDraftRow, now: number): TopicDraftRecord {
	const { executionTimeoutAt, ...rest } = row;
	return {
		...rest,
		postType: row.postType as DraftPostType,
		isExpired:
			row.status === "GENERATING" &&
			executionTimeoutAt != null &&
			executionTimeoutAt.getTime() < now,
	};
}

/**
 * Every content type's draft state for one topic.
 *
 * TWO rows per post type, not one, for the same reason
 * `getLatestPlanningAnalysis` returns two: `latestReady` is what to render and
 * `latestAttempt` is what to say about it. Collapsing them to "the newest row"
 * would blank a perfectly good draft the moment a regeneration failed, and hide
 * it again for the minutes the next one runs — precisely when its reader most
 * wants the last good one.
 *
 * Read as ONE query ordered by version and folded in memory, rather than eight
 * `findFirst`s (two per post type). The row count per topic is bounded by how
 * many times a person has pressed a button, so the fold is cheap and the single
 * round trip cannot return a set of rows that disagree with each other about
 * which attempt is newest.
 */
export async function listTopicDrafts(input: {
	topicId: string;
	projectId: string;
}): Promise<{
	drafts: TopicDraftState[];
	workingDrafts: TopicWorkingDraftState[];
}> {
	const where = { topicId: input.topicId, projectId: input.projectId };

	const [rows, working] = await Promise.all([
		db.publishingTopicDraft.findMany({
			where,
			orderBy: { version: "desc" },
			select: DRAFT_SELECT,
		}),
		db.publishingTopicWorkingDraft.findMany({
			where,
			select: {
				postType: true,
				sourceOptionLabel: true,
				updatedAt: true,
			},
		}),
	]);

	// ONE clock for the whole response. Reading `Date.now()` per row would let a
	// slow fold report two rows with the same deadline differently.
	const now = Date.now();

	const drafts: TopicDraftState[] = POST_TYPES.map((postType) => {
		// `rows` is version-descending, so the first match of each predicate is
		// the newest — no per-type sort, and no reliance on the database
		// returning post types in any particular grouping.
		const forType = (rows as RawDraftRow[]).filter(
			(r) => r.postType === postType,
		);
		const latestAttempt = forType[0] ?? null;
		const latestReady = forType.find((r) => r.status === "READY") ?? null;
		return {
			postType,
			latestAttempt: latestAttempt ? toRecord(latestAttempt, now) : null,
			latestReady: latestReady ? toRecord(latestReady, now) : null,
		};
	});

	const workingDrafts: TopicWorkingDraftState[] = (
		working as {
			postType: string;
			sourceOptionLabel: string | null;
			updatedAt: Date;
		}[]
	).map((w) => ({
		postType: w.postType as DraftPostType,
		hasBody: true,
		sourceOptionLabel: w.sourceOptionLabel,
		updatedAt: w.updatedAt,
	}));

	return { drafts, workingDrafts };
}
