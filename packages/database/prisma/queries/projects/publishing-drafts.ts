/**
 * Generated-draft persistence for a publishing topic (Phase 2B, Fizzy #1853).
 *
 * One read and four writes. The read shipped in 2B-1 ahead of the writers so the
 * schema and the state model could be reviewed before an LLM call was attached
 * to them; the writers arrived in 2B-2 with their first callers.
 *
 * The scoping is the interesting part, and it is the same rule the sibling
 * `getLatestPlanningAnalysis` follows: every read filters by `topicId` AND
 * `projectId`. A real topic id belonging to another project therefore produces
 * exactly the answer a topic with no drafts produces, so this endpoint cannot be
 * used to probe for topics in projects the caller cannot see (DV16).
 *
 * The writers add the tenant discipline the planning table already carries — the
 * Project row is locked `FOR UPDATE` and the tenant tuple derived from the
 * LOCKED row, never from client input or ambient context — plus one thing that
 * table does not need: this one has TWO unique constraints, so a `P2002` must be
 * named before it is described. See `startTopicDraftAttempt`.
 *
 * WHY THE READ IS NOT ALSO TENANT-FILTERED, since the writers so carefully are.
 * Raised in adversarial review, and the answer is that the two are guarding
 * different things. The writers' `sameTenant` fence stops a run STARTED under
 * organization A from COMMITTING under B — content generated on A's identity and
 * quota must not be attributed to B, and the row would otherwise be marked READY
 * while its own columns contradicted its project. It was never there to hide
 * A-era history from B.
 *
 * After a deliberate project transfer, everything in the project moves with it:
 * that is what transferring a project means. The two sibling reads are scoped
 * identically — `getLatestPlanningAnalysis` and `listTopicDecisions` both filter
 * on `{ topicId, projectId }` alone — and the first of those already returns
 * generated model output through that scope. Adding a tenant predicate here and
 * nowhere else would make one tab of the Topic Item Page disagree with the
 * others about what the topic contains, which is a worse failure than the one it
 * would be trying to prevent.
 *
 * What IS genuinely owed, family-wide and not by this slice, is the transfer
 * RE-HOME: child rows keep their old `organizationId`, so under `policy`-mode
 * RLS they become invisible to the new owner and an old-organization delete
 * cascades them away. That affects `publishing_topic`,
 * `publishing_topic_planning_analysis` and `publishing_topic_decision_entry`
 * equally, and fixing only the two tables here would make the family look sound
 * while three siblings stayed exposed.
 */

import { randomUUID } from "node:crypto";
import { db } from "../../client";
import {
	type DraftCommitOutcome,
	lockProjectTenant,
	sameTenant,
	uniqueViolationConstraint,
} from "./publishing-tenant-lock";

// Re-exported so `@repo/temporal` can name the reason it is switching on:
// `publishing-tenant-lock` is internal and absent from the barrel on purpose.
export type {
	DraftCommitOutcome,
	DraftCommitRefusal,
} from "./publishing-tenant-lock";

/**
 * The `PublishingTopicPostType` values in the UI's fixed display order.
 *
 * Exported under a deliberately unmistakable name because this module's symbols
 * reach `@repo/database`'s root barrel. It exists so the exhaustiveness pin in
 * `__tests__/publishing-post-types.test.ts` can compare it to the Prisma enum —
 * it is NOT a source of truth for the vocabulary. Read
 * `PUBLISHING_TOPIC_POST_TYPES` for that.
 */
export const PUBLISHING_DRAFT_POST_TYPES_DISPLAY_ORDER = [
	"TWEET",
	"LINKEDIN_POST",
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
	"WEBINAR_SCRIPT",
	"NEWSLETTER_BLURB",
] as const;

export type DraftPostType =
	(typeof PUBLISHING_DRAFT_POST_TYPES_DISPLAY_ORDER)[number];

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
	/**
	 * The generated draft document — the three short post options, for a TWEET.
	 *
	 * Null until the attempt reaches READY, so it is selected unconditionally
	 * rather than only for READY rows: the column IS the status for this purpose,
	 * and a second query per status would return the same nulls more slowly.
	 *
	 * 2B-1 deliberately did NOT return this, on the grounds that shipping a blob
	 * to a page which cannot display it is bytes over the wire for nothing. 2B-2
	 * is the slice that built the panel which reads it, which is exactly the
	 * condition that comment named for adding it.
	 */
	content: unknown;
}

export interface TopicDraftState {
	postType: DraftPostType;
	/** The newest row of any status — what to SAY about the current state. */
	latestAttempt: TopicDraftRecord | null;
	/** The newest READY row — what to RENDER. */
	latestReady: TopicDraftRecord | null;
	/**
	 * Every READY generation of this type, newest first.
	 *
	 * `latestAttempt` and `latestReady` were the whole contract, so a panel
	 * headed "Generated draft (version 2)" had no version 1 to open — the rows
	 * persist, and nothing could reach them. This costs no query: the fold
	 * below already reads every row before narrowing to two.
	 *
	 * READY only. A failed attempt is not a version of anything; it is a run
	 * that produced no document, and `latestAttempt` is where the panel says so.
	 */
	versions: TopicDraftRecord[];
}

/**
 * The AI refinement PROPOSAL sitting beside a working draft, if any.
 *
 * Null means "no proposal", which is every row that has never been refined and
 * every row whose proposal was accepted or rejected.
 *
 * Deliberately a nested object rather than eight flat fields on
 * `TopicWorkingDraftState`. The proposal is a unit — a body that only means
 * something next to the baseline it revises and the instruction that asked for
 * it — and flattening it would let a caller read `refinedBody` without ever
 * having to notice `isStale`.
 */
export interface TopicRefinementState {
	status: "GENERATING" | "READY" | "FAILED";
	/**
	 * What the model proposed. Null while GENERATING and on FAILED — there is
	 * no half-written proposal to render.
	 */
	proposedBody: string | null;
	/** What the author asked for. Null when the run carried no instruction. */
	instruction: string | null;
	/**
	 * The model's note about the revision: what it generalized, what it could
	 * not do. Null while GENERATING and on FAILED.
	 *
	 * Render it BESIDE the proposal, not instead of it. Where the author's
	 * instruction ran into an unresolved approval, this is the only place the
	 * revision says so — without it a declined instruction looks like an
	 * ignored one.
	 */
	note: string | null;
	/** Why it failed. Null unless `status` is FAILED. */
	error: string | null;
	/** Who asked. Resolved to a name through the project's member list. */
	requestedById: string | null;
	/**
	 * The proposal revises text that is no longer the saved body.
	 *
	 * Computed here rather than left to each caller, because it decides whether
	 * Accept can be offered at all: `acceptRefinement` refuses a stale proposal
	 * with `baseline_changed`, and a panel that offered the button anyway would
	 * be offering an action guaranteed to fail.
	 *
	 * Only meaningful for a READY proposal; false otherwise.
	 */
	isStale: boolean;
	/**
	 * The run's deadline has passed with nothing committed.
	 *
	 * The counterpart of `TopicDraftRecord.isExpired`, and derived the same way
	 * — against the ONE clock this response uses, never the caller's — so that a
	 * stranded run reads as stranded rather than as perpetually in progress. The
	 * next refine reclaims it.
	 */
	isExpired: boolean;
	/** When the proposal last changed. Never the body's `updatedAt`. */
	updatedAt: Date | null;
}

export interface TopicWorkingDraftState {
	postType: DraftPostType;
	/**
	 * Whether the working draft has any text. Derived from `body` rather than
	 * from the row's existence, so an empty body reads as "nothing saved" instead
	 * of as a draft the panel then renders as blank.
	 */
	hasBody: boolean;
	/**
	 * The saved draft text.
	 *
	 * NOT a privacy boundary — a working draft is shared project content, so any
	 * project member may read one (see `PublishingTopicWorkingDraft`). 2B-1
	 * withheld it only because nothing rendered it then; 2B-2's panel shows the
	 * option the user selected, which is what it is for.
	 */
	body: string;
	/**
	 * Which candidate this body was taken from.
	 *
	 * Returned because the LABEL alone does not identify an option across
	 * regenerations: the prompt is asked for descriptive labels, so "Direct"
	 * recurring in v2 with entirely different text is the common case. A reader
	 * comparing on the label alone marks v2's option as already saved and
	 * disables it, and the option becomes unreachable.
	 *
	 * Nullable because the composite foreign key is `ON DELETE SET NULL
	 * ("sourceDraftId")`: deleting a candidate keeps the body and forgets where
	 * it came from, which is the whole point of that column list.
	 */
	sourceDraftId: string | null;
	sourceOptionLabel: string | null;
	/**
	 * The raw content of the candidate this body was ADOPTED FROM.
	 *
	 * The panels render `safetyNote` — "the draft was generalized, and here is
	 * why" — and were reading it off `latestReady`, which after a regeneration
	 * nobody adopted is a different document from the one in the editor. `null`
	 * for a hand-written body, or when the source row is gone.
	 */
	sourceContent: unknown;
	updatedAt: Date;
	/**
	 * The AI refinement proposal for this content type, or null.
	 *
	 * NOTE for panel authors: a refinement does NOT refresh `sourceContent`.
	 * That field is documented as the candidate this body was ADOPTED FROM, and
	 * a refinement revises the working copy without re-seeding it from a
	 * generation — so `safetyNote`, `inputsNeeded` and the rest still describe
	 * the candidate the draft started as. That is the correct reading of
	 * provenance, but it does mean a refined body can sit beside a note written
	 * about an earlier version of it.
	 */
	refinement: TopicRefinementState | null;
}

/**
 * Columns the draft read returns.
 *
 * `executionTimeoutAt` IS selected, because `isExpired` is derived from it, but
 * it is not returned: the deadline is an implementation detail of the expiry
 * answer, and shipping both invites a caller to recompute expiry against its own
 * clock — against a different clock, which is the bug `isExpired` exists to
 * prevent.
 */
const DRAFT_SELECT = {
	id: true,
	content: true,
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
	content: unknown;
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
 * Fold a working-draft row's refinement columns into the nested state, or null.
 *
 * `now` is passed in rather than read here for the reason `toRecord` takes it:
 * one clock for the whole response, so a slow fold cannot report two rows with
 * the same deadline differently.
 */
function toRefinementState(
	row: {
		body: string;
		refinementStatus: string | null;
		refinedBody: string | null;
		refinedFromBody: string | null;
		refinementInstruction: string | null;
		refinementNote: string | null;
		refinementError: string | null;
		refinementExpiresAt: Date | null;
		refinementUpdatedAt: Date | null;
		refinementRequestedById: string | null;
	},
	now: number,
): TopicRefinementState | null {
	// `== null`, so a row read WITHOUT these columns selected — an older caller,
	// a partial select, a test fixture — reads as "no proposal" rather than
	// building a phantom one whose every field is undefined. `=== null` let that
	// through, and the object it produced claimed a refinement existed.
	if (row.refinementStatus == null) {
		return null;
	}
	const status = row.refinementStatus as TopicRefinementState["status"];
	return {
		status,
		proposedBody: status === "READY" ? row.refinedBody : null,
		note: status === "READY" ? row.refinementNote : null,
		instruction: row.refinementInstruction,
		error: status === "FAILED" ? row.refinementError : null,
		requestedById: row.refinementRequestedById,
		// Compared against the LIVE body, which is the same comparison
		// `acceptRefinement` makes before it writes. The two must agree, or the
		// panel offers a button the writer refuses.
		isStale:
			status === "READY" && row.refinedFromBody !== null
				? row.refinedFromBody !== row.body
				: false,
		isExpired:
			status === "GENERATING" &&
			(row.refinementExpiresAt === null ||
				row.refinementExpiresAt.getTime() < now),
		updatedAt: row.refinementUpdatedAt,
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
				body: true,
				sourceDraftId: true,
				sourceOptionLabel: true,
				updatedAt: true,
				refinementStatus: true,
				refinedBody: true,
				refinedFromBody: true,
				refinementInstruction: true,
				refinementNote: true,
				refinementError: true,
				refinementExpiresAt: true,
				refinementUpdatedAt: true,
				refinementRequestedById: true,
			},
		}),
	]);

	// ONE clock for the whole response. Reading `Date.now()` per row would let a
	// slow fold report two rows with the same deadline differently.
	const now = Date.now();

	const drafts: TopicDraftState[] =
		PUBLISHING_DRAFT_POST_TYPES_DISPLAY_ORDER.map((postType) => {
			// `rows` is version-descending, so the first match of each predicate is
			// the newest — no per-type sort, and no reliance on the database
			// returning post types in any particular grouping.
			const forType = (rows as RawDraftRow[]).filter(
				(r) => r.postType === postType,
			);
			const latestAttempt = forType[0] ?? null;
			const readyRows = forType.filter((r) => r.status === "READY");
			const latestReady = readyRows[0] ?? null;
			return {
				postType,
				latestAttempt: latestAttempt
					? toRecord(latestAttempt, now)
					: null,
				latestReady: latestReady ? toRecord(latestReady, now) : null,
				// Same rows, same clock, same order `rows` arrived in — so the
				// first entry IS `latestReady` rather than a second opinion
				// about which version is current.
				versions: readyRows.map((r) => toRecord(r, now)),
			};
		});

	// Every candidate row by id, for `sourceContent` below. `rows` is already in
	// memory — this function reads them all before folding to two per type — so
	// resolving a working draft's source costs a map build and no query.
	const rowsById = new Map(
		(rows as RawDraftRow[]).map((r) => [r.id, r] as const),
	);

	const workingDrafts: TopicWorkingDraftState[] = (
		working as {
			postType: string;
			body: string;
			sourceDraftId: string | null;
			sourceOptionLabel: string | null;
			updatedAt: Date;
			refinementStatus: string | null;
			refinedBody: string | null;
			refinedFromBody: string | null;
			refinementInstruction: string | null;
			refinementNote: string | null;
			refinementError: string | null;
			refinementExpiresAt: Date | null;
			refinementUpdatedAt: Date | null;
			refinementRequestedById: string | null;
		}[]
	).map((w) => ({
		postType: w.postType as DraftPostType,
		hasBody: w.body.trim().length > 0,
		body: w.body,
		sourceDraftId: w.sourceDraftId,
		sourceOptionLabel: w.sourceOptionLabel,
		/**
		 * Two ways reading `latestReady` went wrong, and the second is why a
		 * wording qualifier could not reach it:
		 *
		 *  - v1 generalized, v2 also generalized — the reader saw v2's note
		 *    over v1's text, which a qualifier can at least flag.
		 *  - v1 generalized, v2 needing none — `latestReady.safetyNote` is
		 *    null, so the section VANISHED while the saved text was still the
		 *    generalized one. Nothing was on screen to qualify, and copy and
		 *    download then exported text whose stated generalizations described
		 *    a document nobody adopted.
		 *
		 * `null` for a hand-written body or a source row past retention — both
		 * mean "no note applies", which is the honest answer rather than the
		 * newest one.
		 */
		sourceContent: w.sourceDraftId
			? (rowsById.get(w.sourceDraftId)?.content ?? null)
			: null,
		updatedAt: w.updatedAt,
		refinement: toRefinementState(w, now),
	}));

	return { drafts, workingDrafts };
}

// =============================================================================
// Writers (Phase 2B-2, Fizzy #1853)
// =============================================================================

/** How long a GENERATING draft stays valid before a later attempt reclaims it. */
export const TOPIC_DRAFT_TIMEOUT_MS = 10 * 60 * 1000;

/** Which prompt actually shaped a draft — see `PublishingTopicDraft.promptSource`. */
export type TopicDraftPromptSource =
	| "BOUND"
	| "DEFAULT_UNBOUND"
	| "DEFAULT_RENDER_FAILED";

export type StartTopicDraftResult =
	| { status: "started"; draftId: string; version: number }
	| { status: "in_flight" }
	/**
	 * The project is gone, archived or soft-deleted as of the lock. Distinct
	 * from `not_found` for the reason `StartPlanningAnalysisResult` documents:
	 * collapsing them reports a perfectly healthy topic as missing when it was
	 * the project that changed underneath the caller.
	 */
	| { status: "project_ineligible" }
	| { status: "not_found" };

/**
 * Open a new draft attempt for one topic and content type.
 *
 * Same transaction shape as `startPlanningAnalysisAttempt`, with ONE difference
 * that matters and is the reason this is not a generic helper over both tables:
 * this table carries TWO unique constraints, not one.
 *
 *   - `publishing_topic_draft_active` — the partial index making the in-flight
 *     guard per CONTENT TYPE, so a short post may generate while a blog post is.
 *   - `publishing_topic_draft_topicId_postType_version_key` — version identity.
 *
 * 2A can treat any `P2002` as "a run is already in flight" because it has only
 * the first. Here that shortcut would report a version collision as an in-flight
 * run: the UI would show a spinner for a generation that does not exist and will
 * never report, and the underlying allocation bug would never surface. So the
 * constraint is named, and anything unrecognised RETHROWS. Failing loudly on a
 * conflict we cannot explain is the only safe direction — the alternative is a
 * plausible-looking lie about the system's state.
 */
export async function startTopicDraftAttempt(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	requestedById: string;
	guidance: string | null;
}): Promise<StartTopicDraftResult> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		// Re-scope the topic by BOTH ids. A topic id alone is never trusted: a
		// valid id from another project must resolve to the same nothing a
		// missing one does (DV16).
		const topic = await tx.publishingTopic.findFirst({
			where: { id: input.topicId, projectId: input.projectId },
			select: { id: true },
		});
		if (!topic) {
			return { status: "not_found" as const };
		}

		// Reclaim an orphaned attempt. Without this the partial unique index is
		// a PERMANENT lock on this content type: a worker that dies between the
		// insert below and the terminal marker leaves a GENERATING row that
		// refuses every later attempt, and no user action recovers it.
		//
		// Looked up by (topicId, postType) — matching the index, which is NOT
		// tenant-scoped — because a row stamped with an OLD tenant still holds
		// the slot. Tenant-scoping the lookup would miss that blocker and leave
		// the content type stuck on it forever; the tenant decision belongs in
		// the reclaim RULE below, not in the lookup.
		const blocker = await tx.publishingTopicDraft.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
				status: "GENERATING",
			},
			select: {
				id: true,
				organizationId: true,
				userId: true,
				executionTimeoutAt: true,
			},
		});
		if (blocker) {
			// A row whose stored tuple no longer matches the project's is
			// reclaimed UNCONDITIONALLY, deadline or not: the tenant fence in
			// `completeTopicDraft` guarantees it can never legitimately finish,
			// so making the content type wait out ten minutes for a row that is
			// already dead would be a lock with no purpose.
			const tenantIntact = sameTenant(blocker, tenant);
			const expired =
				blocker.executionTimeoutAt != null &&
				blocker.executionTimeoutAt.getTime() < Date.now();
			if (!tenantIntact || expired) {
				await tx.publishingTopicDraft.updateMany({
					where: {
						id: blocker.id,
						projectId: input.projectId,
						status: "GENERATING",
					},
					data: {
						status: "FAILED",
						error: tenantIntact
							? "Generation timed out before it reported a result."
							: "Superseded: the project moved to a different owner while this run was in flight (transfer).",
						executionTimeoutAt: null,
					},
				});
			}
		}

		// Version is per (topic, content type): a short post and a blog post on
		// one topic each count from 1, because a reader compares versions within
		// a content type and never across two.
		const { _max } = await tx.publishingTopicDraft.aggregate({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
			},
			_max: { version: true },
		});
		const version = (_max?.version ?? 0) + 1;

		try {
			const created = await tx.publishingTopicDraft.create({
				data: {
					topicId: input.topicId,
					projectId: input.projectId,
					postType: input.postType,
					// Tenancy, from the locked row — never from client input and
					// never from ambient context.
					organizationId: tenant.organizationId,
					userId: tenant.userId,
					// Authorship. A different column on purpose: for an org
					// project `userId` is null, and conflating the two is what
					// the XOR CHECK would reject.
					requestedById: input.requestedById,
					guidance: input.guidance,
					version,
					status: "GENERATING",
					executionTimeoutAt: new Date(
						Date.now() + TOPIC_DRAFT_TIMEOUT_MS,
					),
				},
				select: { id: true, version: true },
			});
			return {
				status: "started" as const,
				draftId: created.id,
				version: created.version,
			};
		} catch (error) {
			// ONLY the in-flight index answers "a run is already going". See the
			// function header: any other conflict is rethrown rather than
			// described as something it is not.
			if (
				uniqueViolationConstraint(error) ===
				"publishing_topic_draft_active"
			) {
				return { status: "in_flight" as const };
			}
			throw error;
		}
	});
}

/**
 * Commit a finished draft.
 *
 * The same two guards `completePlanningAnalysis` carries, and neither subsumes
 * the other:
 *
 *  1. The project tuple is re-validated under lock, because the activity checked
 *     it before a multi-minute model call and a transfer, archive or delete
 *     during that call must not be committed under the stale tenant.
 *  2. The write CASes on `status = 'GENERATING'`. Once a deadline reclaim has
 *     marked this attempt FAILED and let a newer one through the partial index,
 *     this attempt's activity is still running — without the CAS it would
 *     resurrect itself to READY, leaving two terminal rows for one content type
 *     with the older one silently newer.
 *
 * A lost CAS is not an error. It means the attempt was superseded, which is a
 * normal outcome, so it returns `{ persisted: false }` rather than throwing.
 */
export async function completeTopicDraft(input: {
	id: string;
	projectId: string;
	content: unknown;
	sourceRefs: unknown;
	model: string | null;
	promptSource: TopicDraftPromptSource;
	promptId: string | null;
	promptVersion: number | null;
}): Promise<DraftCommitOutcome> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { persisted: false, reason: "project_ineligible" };
		}

		// TENANT FENCE. The lock proves the project is still eligible; it does
		// NOT prove this attempt belongs to the tenant that now owns it. An
		// attempt opened under org A and completed after a transfer to org B
		// would otherwise be marked READY, putting content generated under A's
		// identity in front of B's members on a row whose own columns contradict
		// its project.
		const stored = await tx.publishingTopicDraft.findFirst({
			where: { id: input.id, projectId: input.projectId },
			select: { organizationId: true, userId: true },
		});
		if (!stored) {
			return { persisted: false, reason: "attempt_missing" };
		}
		if (!sameTenant(stored, tenant)) {
			return { persisted: false, reason: "tenant_changed" };
		}

		const updated = await tx.publishingTopicDraft.updateMany({
			where: {
				id: input.id,
				projectId: input.projectId,
				status: "GENERATING",
			},
			data: {
				status: "READY",
				content: input.content as never,
				sourceRefs: input.sourceRefs as never,
				model: input.model,
				promptSource: input.promptSource,
				promptId: input.promptId,
				promptVersion: input.promptVersion,
				error: null,
				// Cleared so the row stops matching the expiry predicate. A
				// terminal row keeping a past deadline is what makes a finished
				// draft read as stranded.
				executionTimeoutAt: null,
			},
		});

		return updated.count > 0
			? { persisted: true }
			: { persisted: false, reason: "superseded" };
	});
}

/**
 * Mark a draft attempt failed.
 *
 * Same CAS and same tenant fence as the success path, for the same reasons — a
 * superseded attempt must not overwrite the row a newer one now owns, and a
 * transferred project must not receive a failure stamped with the old tenant's
 * run. `persisted: false` means the attempt was already terminal; the caller
 * logs it and moves on rather than retrying.
 */
export async function failTopicDraft(input: {
	id: string;
	projectId: string;
	error: string;
}): Promise<DraftCommitOutcome> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { persisted: false, reason: "project_ineligible" };
		}

		const stored = await tx.publishingTopicDraft.findFirst({
			where: { id: input.id, projectId: input.projectId },
			select: { organizationId: true, userId: true },
		});
		if (!stored) {
			return { persisted: false, reason: "attempt_missing" };
		}
		if (!sameTenant(stored, tenant)) {
			return { persisted: false, reason: "tenant_changed" };
		}

		const updated = await tx.publishingTopicDraft.updateMany({
			where: {
				id: input.id,
				projectId: input.projectId,
				status: "GENERATING",
			},
			data: {
				status: "FAILED",
				// Bounded: this string reaches a user-facing panel, and an
				// unbounded provider message can be kilobytes of stack.
				error: input.error.slice(0, 2000),
				executionTimeoutAt: null,
			},
		});

		return updated.count > 0
			? { persisted: true }
			: { persisted: false, reason: "superseded" };
	});
}

/**
 * Append one row to a topic's draft-revision history, inside the caller's
 * transaction and under the project lock the caller already holds.
 *
 * `max(version) + 1` per `(topicId, postType)`, the same allocation
 * `startTopicDraftAttempt` uses for the generated side. Both are safe for the
 * same reason and only that reason: every writer of these tables takes
 * `lockProjectTenant` first, so the read and the insert cannot interleave with
 * another allocation for this project.
 *
 * Tenancy comes from the LOCKED project row, never from client input.
 */
async function appendDraftRevision(
	tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
	input: {
		topicId: string;
		projectId: string;
		postType: DraftPostType;
		tenant: { organizationId: string | null; userId: string | null };
		body: string;
		kind: "EDITED" | "RESTORED" | "REFINED";
		sourceDraftVersion: number | null;
		authorUserId: string | null;
		changeSummary: string | null;
	},
): Promise<number> {
	const { _max } = await tx.publishingTopicDraftRevision.aggregate({
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
		},
		_max: { version: true },
	});
	const version = (_max?.version ?? 0) + 1;
	await tx.publishingTopicDraftRevision.create({
		data: {
			topicId: input.topicId,
			projectId: input.projectId,
			organizationId: input.tenant.organizationId,
			userId: input.tenant.userId,
			postType: input.postType,
			version,
			body: input.body,
			kind: input.kind,
			sourceDraftVersion: input.sourceDraftVersion,
			authorUserId: input.authorUserId,
			changeSummary: input.changeSummary,
		},
	});
	return version;
}

/**
 * Record the body that is ABOUT TO BE REPLACED, if no revision has ever been
 * written for this content type.
 *
 * The one-shot backstop for bodies that predate the history table. Without it
 * this feature would prevent loss only from tomorrow: a working draft carrying
 * a hand edit made before the table existed has no revision, and the first
 * restore after deploy would discard exactly the text the feature exists to
 * protect.
 *
 * Runs at most once per `(topicId, postType)` — after it, a revision exists and
 * the condition is false forever. Attributed to whoever last wrote the row
 * (`updatedById`), which is the most faithful claim available; its `createdAt`
 * is necessarily now rather than when the text was written, and the summary
 * says so rather than implying a precision the row cannot support.
 */
async function captureOutgoingBodyIfUnrecorded(
	tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
	input: {
		topicId: string;
		projectId: string;
		postType: DraftPostType;
		tenant: { organizationId: string | null; userId: string | null };
		outgoingBody: string | null;
		outgoingAuthorId: string | null;
	},
): Promise<void> {
	if (!input.outgoingBody || input.outgoingBody.length === 0) {
		return;
	}
	const existing = await tx.publishingTopicDraftRevision.findFirst({
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
		},
		select: { id: true },
	});
	if (existing) {
		return;
	}
	await appendDraftRevision(tx, {
		topicId: input.topicId,
		projectId: input.projectId,
		postType: input.postType,
		tenant: input.tenant,
		body: input.outgoingBody,
		kind: "EDITED",
		sourceDraftVersion: null,
		authorUserId: input.outgoingAuthorId,
		changeSummary: "Saved before version history was kept",
	});
}

export type SaveWorkingDraftResult =
	| { status: "saved"; updatedAt: Date }
	| { status: "project_ineligible" }
	/** No candidate with that id, or it belongs to another topic/content type. */
	| { status: "source_not_found" }
	/**
	 * The working draft is not the one the caller believed it was replacing.
	 *
	 * Two people choosing different options within a few seconds of each other
	 * both used to succeed, and the second silently erased the first — the
	 * project lock serialises the writes but says nothing about whether the
	 * second writer knew what it was overwriting. Raised in adversarial review.
	 */
	| { status: "stale" };

/**
 * Save one generated option as the topic's working draft for a content type
 * (FR19/FR20).
 *
 * The composite foreign key added in 2B-1 already proves a working draft cites a
 * candidate of its OWN topic and content type, so the read below is not what
 * makes that true — the database is. It exists to turn a violation into a
 * `source_not_found` answer the API can render, instead of a 500 from a
 * constraint the caller cannot see.
 *
 * WHO MAY WRITE `body`, and why the list is short. 2B-2 could say "this is the
 * only writer, and generation never touches this table", which made FR33
 * ("regenerating shall not silently overwrite saved work") true by construction.
 * 2B-3 needs a blog draft to exist after the FIRST generation (DV5) and an
 * editor for it (FR21), so that sentence can no longer be the guarantee. Three
 * writers now, and the guarantee is restated as a property each one carries:
 *
 *   - `saveWorkingDraft` (here) — adoption. Replaces the body, and refuses
 *     unless the caller's `expectedUpdatedAt` still matches.
 *   - `updateWorkingDraftBody` — the editor. Same compare-and-set.
 *   - `seedWorkingDraftIfAbsent` — generation. CREATE-ONLY: it has no update
 *     path at all, so a regeneration cannot reach an existing row.
 *
 * That is what keeps FR33 and FR35 structural rather than a rule a later change
 * has to remember: no writer here can replace a body without being handed the
 * version it believes it is replacing, and the one writer generation calls
 * cannot replace a body at all.
 *
 * HISTORY: the first two append to `publishing_topic_draft_revision`, the third
 * deliberately does not. A seed CREATES the first body — it replaces nothing,
 * so there is nothing to lose — and the generation that produced it is already
 * an entry in the unified sequence in its own right. Minting a revision there
 * would put two entries on screen for one act. The rule is the same one
 * `saveWorkingDraft` applies to a first adoption: history records a body being
 * REPLACED, not a body arriving where there was none.
 */
export async function saveWorkingDraft(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	sourceDraftId: string;
	/**
	 * Which prompt-authored option was chosen, or null for a content type whose
	 * generation produces one draft rather than a set. Nullable because the blog
	 * post has no options to label — the column has always been `String?`, and
	 * this signature was the half that had not caught up.
	 */
	sourceOptionLabel: string | null;
	body: string;
	updatedById: string;
	/**
	 * The working draft's `updatedAt` as the caller last saw it, or null for
	 * "I believe nothing is saved".
	 *
	 * `updatedAt` rather than `sourceDraftId`, which was the first version of
	 * this check and is subtly weaker. Two states share a null source id —
	 * nothing saved, and saved-from-a-candidate-that-was-since-deleted (the
	 * composite FK is `ON DELETE SET NULL ("sourceDraftId")`) — so the check
	 * cannot tell them apart. That is unreachable today, since nothing deletes a
	 * candidate; it stops being unreachable the moment 2B-3 adds a body editor,
	 * because an edit changes `body` and leaves `sourceDraftId` alone. The source
	 * check would pass while the row HAD changed, and a selection would silently
	 * discard someone's edit.
	 *
	 * No new column either way: `updatedAt` is `@updatedAt`, so every write to
	 * this row moves it, which is exactly the property a revision counter would
	 * have been added to provide.
	 */
	expectedUpdatedAt: Date | null;
}): Promise<SaveWorkingDraftResult> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		// All four ids together. Scoping by draft id alone would let a caller
		// name a candidate from another topic — the FK would reject it, but as
		// an opaque failure rather than an answer, and the round trip would have
		// confirmed that id exists somewhere.
		const source = await tx.publishingTopicDraft.findFirst({
			where: {
				id: input.sourceDraftId,
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
				status: "READY",
			},
			// `version` as well as `id`: the revision this write appends records
			// which generated version the body came from, and that number is
			// read from the candidate rather than taken from the caller.
			select: { id: true, version: true },
		});
		if (!source) {
			return { status: "source_not_found" as const };
		}

		// Optimistic concurrency, read INSIDE the transaction that holds the
		// project lock — so between this read and the write below nothing else
		// can commit a selection for this project.
		//
		// `body` and `updatedById` ride along for the one-shot backstop below:
		// the body this write is about to replace has to be recorded before it
		// goes, if nothing ever recorded it.
		const current = await tx.publishingTopicWorkingDraft.findUnique({
			where: {
				topicId_postType: {
					topicId: input.topicId,
					postType: input.postType,
				},
			},
			select: { updatedAt: true, body: true, updatedById: true },
		});
		// Compared by time VALUE, not by identity: the caller's copy has been
		// through JSON and is a different Date object for the same instant.
		// `current` absent and `expected` null agree; anything else is a caller
		// acting on a view of this draft that has since moved.
		const currentAt = current?.updatedAt?.getTime() ?? null;
		const expectedAt = input.expectedUpdatedAt?.getTime() ?? null;
		if (currentAt !== expectedAt) {
			return { status: "stale" as const };
		}

		const saved = await tx.publishingTopicWorkingDraft.upsert({
			where: {
				topicId_postType: {
					topicId: input.topicId,
					postType: input.postType,
				},
			},
			create: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
				// Tenancy from the LOCKED row, as everywhere else here.
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				sourceDraftId: input.sourceDraftId,
				sourceOptionLabel: input.sourceOptionLabel,
				body: input.body,
				updatedById: input.updatedById,
			},
			update: {
				sourceDraftId: input.sourceDraftId,
				sourceOptionLabel: input.sourceOptionLabel,
				body: input.body,
				updatedById: input.updatedById,
				// Re-stamped on every save. A row that predates an org transfer
				// otherwise keeps the old tenant and, under `policy`-mode RLS,
				// becomes invisible to the project's current members.
				organizationId: tenant.organizationId,
				userId: tenant.userId,
			},
			select: { updatedAt: true },
		});

		// HISTORY. Only when this write actually replaces a DIFFERENT body.
		//
		// The first adoption of a generated candidate — picking a short-post
		// option, or the blog editor opening on the run that seeded it — replaces
		// nothing and loses nothing, and the candidate is already an entry in the
		// sequence in its own right. Minting a revision for it would put two
		// entries on screen for one act and make the count read high.
		//
		// A restore is the case that matters: the body on screen is being
		// swapped for an earlier one, and without this the swap left no trace.
		if (current && current.body !== input.body) {
			await captureOutgoingBodyIfUnrecorded(tx, {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
				tenant,
				outgoingBody: current.body,
				outgoingAuthorId: current.updatedById,
			});
			await appendDraftRevision(tx, {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
				tenant,
				body: input.body,
				kind: "RESTORED",
				sourceDraftVersion: source.version,
				authorUserId: input.updatedById,
				changeSummary: `Restored from version ${source.version}`,
			});
		}

		return { status: "saved" as const, updatedAt: saved.updatedAt };
	});
}

export type SeedWorkingDraftResult =
	| { status: "seeded"; updatedAt: Date }
	/** A working draft already existed. Nothing was written. */
	| { status: "already_exists" }
	| { status: "project_ineligible" }
	| { status: "source_not_found" };

/**
 * Create a working draft from a just-generated draft, but ONLY if the topic has
 * none for that content type yet (DV5/FR21).
 *
 * This is the one working-draft writer generation calls, and it exists as a
 * separate function from `saveWorkingDraft` rather than a flag on it for one
 * reason: it has NO update path. Not "an update path it declines to take" — no
 * `upsert`, no `update`, no `updateMany` anywhere in its body. A regeneration
 * that reaches an existing row can only get `already_exists` back, so FR35
 * ("regenerating a Blog Post shall not silently overwrite saved work") holds
 * because of what this function is unable to express, not because of a condition
 * someone remembered to write.
 *
 * The card asks for two things that pull against each other — a blog generation
 * produces an editable draft by default (DV5), and a regeneration never
 * overwrites saved work (FR35/DV10) — and create-if-absent is what satisfies
 * both. The first run seeds; every run after it writes a candidate the reader
 * adopts explicitly through `saveWorkingDraft`, which is compare-and-set.
 *
 * `already_exists` is a NORMAL outcome, not a failure. It is what every
 * regeneration returns, and the caller logs it at debug rather than warning.
 */
export async function seedWorkingDraftIfAbsent(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	sourceDraftId: string;
	body: string;
	updatedById: string;
}): Promise<SeedWorkingDraftResult> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		// All four ids together, exactly as `saveWorkingDraft` does. The
		// composite FK would reject a mismatch anyway, but as an opaque failure
		// rather than an answer.
		const source = await tx.publishingTopicDraft.findFirst({
			where: {
				id: input.sourceDraftId,
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
				status: "READY",
			},
			select: { id: true },
		});
		if (!source) {
			return { status: "source_not_found" as const };
		}

		const existing = await tx.publishingTopicWorkingDraft.findUnique({
			where: {
				topicId_postType: {
					topicId: input.topicId,
					postType: input.postType,
				},
			},
			select: { id: true },
		});
		if (existing) {
			return { status: "already_exists" as const };
		}

		try {
			const seeded = await tx.publishingTopicWorkingDraft.create({
				data: {
					topicId: input.topicId,
					projectId: input.projectId,
					postType: input.postType,
					// Tenancy from the LOCKED row, as everywhere else here.
					organizationId: tenant.organizationId,
					userId: tenant.userId,
					sourceDraftId: input.sourceDraftId,
					// No option to name: a blog generation produces one draft
					// rather than a labeled set.
					sourceOptionLabel: null,
					body: input.body,
					updatedById: input.updatedById,
				},
				select: { updatedAt: true },
			});
			return { status: "seeded" as const, updatedAt: seeded.updatedAt };
		} catch (error) {
			// The read above and this write are inside the project lock every
			// other writer of this table also takes, so losing the race needs a
			// writer that does not — a future one, or a manual query. Answering
			// `already_exists` keeps that case on the same no-overwrite path
			// instead of surfacing a constraint the caller cannot see.
			if (
				uniqueViolationConstraint(error) ===
				"publishing_topic_working_draft_topicId_postType_key"
			) {
				return { status: "already_exists" as const };
			}
			throw error;
		}
	});
}

export type UpdateWorkingDraftBodyResult =
	| { status: "saved"; updatedAt: Date }
	| { status: "project_ineligible" }
	/** No working draft for that topic and content type. */
	| { status: "not_found" }
	| { status: "stale" };

/**
 * Replace the text of an existing working draft (FR21).
 *
 * The editor's writer. It changes `body` and nothing else about where the draft
 * came from: `sourceDraftId` still names the candidate this text STARTED as,
 * because provenance is the origin of a draft rather than a claim about what it
 * currently says. A heavily edited post is still a post that began at version 4,
 * and the panel says so.
 *
 * Same `updatedAt` compare-and-set as `saveWorkingDraft`, and the pair is why
 * that check compares timestamps rather than `sourceDraftId`: an edit moves
 * `body` and leaves the source id alone, so a source-based check would pass
 * while the row HAD changed and an adoption would silently discard the edit.
 * That was unreachable when 2B-2 wrote it and is reachable now.
 *
 * Creates nothing. A working draft that does not exist is `not_found`, never an
 * upsert — the row is created by adoption or by the first generation, and an
 * editor that could conjure one would let a body reach a topic whose generation
 * never ran.
 */
export async function updateWorkingDraftBody(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	body: string;
	updatedById: string;
	/** The row's `updatedAt` as the editor last saw it. */
	expectedUpdatedAt: Date;
}): Promise<UpdateWorkingDraftBodyResult> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		// Scoped by projectId as well as the unique key: a topic id belonging to
		// another project must not resolve a row here. This read exists to tell
		// `not_found` from `stale` — it is NOT the concurrency check.
		const current = await tx.publishingTopicWorkingDraft.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
			},
			// `body`, `updatedById` and `sourceDraftId` ride along for the
			// history append below — the outgoing text for the one-shot
			// backstop, and the candidate this draft traces back to so an edit
			// records the generated version it descends from.
			select: {
				id: true,
				body: true,
				updatedById: true,
				sourceDraftId: true,
			},
		});
		if (!current) {
			return { status: "not_found" as const };
		}

		// The compare-and-set is the WRITE, not a comparison before it.
		//
		// An earlier version read `updatedAt` here and compared it in JS before
		// issuing an unconditional `update`. That is correct only for as long as
		// every writer of this table takes the project lock above — a
		// convention, not a constraint, and the kind that holds until someone
		// adds a writer that does not. Raised by review. Putting `updatedAt` in
		// the WHERE makes the check atomic in Postgres, so a row that moved
		// between the two statements matches nothing and no write happens.
		//
		// Equality on the timestamp is exact rather than approximate: the column
		// is `TIMESTAMP(3)` and a JS `Date` is also millisecond-precision, so the
		// value that came back from a read round-trips to the same instant.
		const written = await tx.publishingTopicWorkingDraft.updateMany({
			where: {
				id: current.id,
				updatedAt: input.expectedUpdatedAt,
			},
			data: {
				body: input.body,
				updatedById: input.updatedById,
				// Re-stamped for the same reason `saveWorkingDraft` re-stamps:
				// a row that predates an org transfer otherwise keeps the old
				// tenant and, under `policy`-mode RLS, becomes invisible to the
				// project's current members.
				organizationId: tenant.organizationId,
				userId: tenant.userId,
			},
		});
		if (written.count === 0) {
			return { status: "stale" as const };
		}

		const saved = await tx.publishingTopicWorkingDraft.findUniqueOrThrow({
			where: { id: current.id },
			select: { updatedAt: true },
		});

		// HISTORY — the half this feature exists for.
		//
		// A hand-typed edit used to be versioned NOWHERE: this row is a single
		// upsert target, so every save overwrote the last and a restore
		// discarded the lot behind a confirm dialog. The append runs only after
		// the compare-and-set above has already WON (`written.count > 0`), so a
		// losing write leaves no history entry — the revision is a consequence
		// of the won CAS, never a second chance at one.
		//
		// The source version is read from the row's own `sourceDraftId` rather
		// than derived from the newest candidate: an edit descends from whatever
		// seeded the draft, and stamping the latest run would claim the author
		// worked from something they never saw.
		const sourceVersion = current.sourceDraftId
			? ((
					await tx.publishingTopicDraft.findFirst({
						where: {
							id: current.sourceDraftId,
							topicId: input.topicId,
							projectId: input.projectId,
						},
						select: { version: true },
					})
				)?.version ?? null)
			: null;

		await captureOutgoingBodyIfUnrecorded(tx, {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
			tenant,
			outgoingBody: current.body,
			outgoingAuthorId: current.updatedById,
		});
		await appendDraftRevision(tx, {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
			tenant,
			body: input.body,
			kind: "EDITED",
			sourceDraftVersion: sourceVersion,
			authorUserId: input.updatedById,
			changeSummary: null,
		});

		return { status: "saved" as const, updatedAt: saved.updatedAt };
	});
}

// =============================================================================
// Per-content-type read markers (Fizzy #1851 follow-up, finding #46)
// =============================================================================

/**
 * When this reader last looked at each content type on a topic.
 *
 * A map rather than a list, because every caller asks the same question — "has
 * this tab changed since I was here" — and a list would make each of them build
 * the same index.
 */
export async function getTopicDraftReadMarkers(input: {
	topicId: string;
	projectId: string;
	userId: string;
}): Promise<Record<string, Date>> {
	const rows = await db.publishingTopicDraftRead.findMany({
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			userId: input.userId,
		},
		select: { postType: true, readAt: true },
	});
	return Object.fromEntries(rows.map((r) => [r.postType, r.readAt]));
}

/**
 * Record that this reader has now seen one content type.
 *
 * An upsert that always moves `readAt` forward, so re-opening a tab after a
 * regeneration clears the marker rather than leaving it stuck at the first
 * visit.
 *
 * Tenant columns come from the TOPIC, never from caller input — the same rule
 * `PublishingTopicRead` states. A marker stamped from ambient context is a row
 * RLS places in the wrong tenant.
 *
 * Deliberately writes NOTHING on `PublishingTopic`. Reading must not bump a
 * topic's `updatedAt`, or opening one would reorder "Recently Modified"
 * underneath the person reading it.
 */
export async function markTopicDraftRead(input: {
	topicId: string;
	projectId: string;
	userId: string;
	postType: DraftPostType;
}): Promise<boolean> {
	const topic = await db.publishingTopic.findFirst({
		where: { id: input.topicId, projectId: input.projectId },
		select: { organizationId: true },
	});
	if (!topic) {
		return false;
	}
	await db.publishingTopicDraftRead.upsert({
		where: {
			topicId_userId_postType: {
				topicId: input.topicId,
				userId: input.userId,
				postType: input.postType,
			},
		},
		create: {
			topicId: input.topicId,
			userId: input.userId,
			postType: input.postType,
			projectId: input.projectId,
			organizationId: topic.organizationId,
		},
		update: { readAt: new Date() },
	});
	return true;
}

// =============================================================================
// Refinement proposals (Fizzy #1851 follow-up)
// =============================================================================

/**
 * How long a GENERATING refinement stays valid before the next start reclaims it.
 *
 * The same ten minutes as `TOPIC_DRAFT_TIMEOUT_MS`, and named separately rather
 * than shared so the two can move independently: a refinement prompt carries a
 * draft the generation prompt does not, and the budgets are free to diverge.
 */
export const TOPIC_REFINEMENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Is this proposal's run still the one that owns the slot?
 *
 * Fail-OPEN on a missing deadline, which is the whole reason this table needs no
 * `refinementStatus <> 'GENERATING' OR refinementExpiresAt IS NOT NULL` CHECK.
 * Its sibling `publishing_topic_draft` cannot make that choice: exclusion there
 * is a partial unique index in the DATABASE, so a null deadline is a permanent
 * lock no code path can reason its way out of. Here exclusion is the CAS below,
 * so a null deadline simply means "nothing proves this run is alive" — and the
 * safe reading of that is that it is not.
 */
function refinementIsLive(row: {
	refinementStatus: string | null;
	refinementExpiresAt: Date | null;
}): boolean {
	return (
		row.refinementStatus === "GENERATING" &&
		row.refinementExpiresAt != null &&
		row.refinementExpiresAt.getTime() > Date.now()
	);
}

export type StartRefinementResult =
	| {
			status: "started";
			runId: string;
			/**
			 * The body this run must revise, captured under the project lock in
			 * the SAME transaction that claimed the slot.
			 *
			 * Returned rather than re-read by the caller, and that is the point:
			 * the text stored as `refinedFromBody` and the text handed to the
			 * prompt are the same string by construction. The old refine path
			 * read the body in one query (`readRefinementSource`) and opened the
			 * attempt in another, so an edit landing between them produced a run
			 * that revised one version while recording another.
			 */
			baseline: string;
	  }
	| { status: "project_ineligible" }
	/** No topic, or no working draft with any text to refine. */
	| { status: "not_found" }
	/** A refinement is already running for this content type. */
	| { status: "in_flight" };

/**
 * Claim the refinement slot for one content type and record what is being asked.
 *
 * The counterpart of `startTopicDraftAttempt`, and deliberately smaller than it.
 * That function needs a partial unique index, a blocker lookup and a reclaim
 * `updateMany` to establish "one run in flight per content type". Here
 * `@@unique([topicId, postType])` already means there is exactly one row, so the
 * claim is a single compare-and-set against that row's own columns — the slot IS
 * the row.
 *
 * Writes NO draft attempt. That is the change this whole slice exists for: a
 * refinement no longer consumes a version number, no longer appears in the
 * candidates grid, and no longer has to be told apart from a real generation by
 * a flag every reader must remember to interpret.
 *
 * `updatedAt` is PINNED to its current value. It is the body's concurrency
 * token — `updateWorkingDraftBody` and `saveWorkingDraft` both compare against
 * it — and Prisma's `@updatedAt` would otherwise move it on this write, telling
 * every open editor their draft had changed underneath them. It had not; only
 * the proposal beside it did, which is what `refinementUpdatedAt` is for.
 */
export async function startRefinement(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	instruction: string | null;
	requestedById: string;
}): Promise<StartRefinementResult> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		// Both ids, as everywhere in this module: a real topic id from another
		// project must resolve to the same nothing a missing one does (DV16).
		const topic = await tx.publishingTopic.findFirst({
			where: { id: input.topicId, projectId: input.projectId },
			select: { id: true },
		});
		if (!topic) {
			return { status: "not_found" as const };
		}

		const current = await tx.publishingTopicWorkingDraft.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
			},
			select: {
				id: true,
				body: true,
				updatedAt: true,
				refinementStatus: true,
				refinementExpiresAt: true,
			},
		});
		// No row, or a row carrying no text, are the same answer: there is
		// nothing to revise. Derived from the BODY rather than the row's
		// existence, exactly as `TopicWorkingDraftState.hasBody` is.
		if (!current || current.body.trim().length === 0) {
			return { status: "not_found" as const };
		}

		if (refinementIsLive(current)) {
			return { status: "in_flight" as const };
		}

		const runId = randomUUID();
		const now = new Date();
		// The CAS. `updatedAt` in the WHERE makes the claim atomic in Postgres
		// rather than a comparison in JS that happens to be inside a lock every
		// current writer takes — the same correction `updateWorkingDraftBody`
		// already carries, and for the same reason: the convention holds only
		// until someone adds a writer that does not take the lock.
		const claimed = await tx.publishingTopicWorkingDraft.updateMany({
			where: { id: current.id, updatedAt: current.updatedAt },
			data: {
				refinementRunId: runId,
				refinementStatus: "GENERATING",
				// The baseline is captured HERE, under the lock, so what is
				// stored and what the prompt receives cannot disagree.
				refinedFromBody: current.body,
				refinementInstruction: input.instruction,
				// Cleared, not left: a previous proposal's body or error showing
				// beside a run that is still going is the state that makes a
				// reader accept text the new run has not produced yet.
				refinedBody: null,
				refinementNote: null,
				refinementError: null,
				refinementExpiresAt: new Date(
					now.getTime() + TOPIC_REFINEMENT_TIMEOUT_MS,
				),
				refinementUpdatedAt: now,
				refinementRequestedById: input.requestedById,
				// PINNED — see the docblock. The body did not change.
				updatedAt: current.updatedAt,
				// Re-stamped for the reason every writer here re-stamps: a row
				// predating an org transfer otherwise keeps the old tenant and,
				// under `policy`-mode RLS, becomes invisible to the project's
				// current members.
				organizationId: tenant.organizationId,
				userId: tenant.userId,
			},
		});
		if (claimed.count === 0) {
			// The row moved between the read and the write. Reported as
			// `in_flight` rather than a new status: from the caller's side both
			// mean "someone else is acting on this draft, try again", and the
			// panel already has that message.
			return { status: "in_flight" as const };
		}

		return {
			status: "started" as const,
			runId,
			baseline: current.body,
		};
	});
}

/**
 * Commit a finished refinement.
 *
 * The two guards `completeTopicDraft` carries, rebuilt on this row:
 *
 *  1. The project tuple is re-validated under lock, because the activity checked
 *     it before a multi-minute model call and a transfer, archive or delete
 *     during that call must not be committed under the stale tenant.
 *  2. The write CASes on `refinementRunId`, not merely on
 *     `refinementStatus = 'GENERATING'`. Status alone is the hole: once a
 *     stranded run's deadline passes, the next start reclaims the slot and sets
 *     GENERATING again for a DIFFERENT run — and the first run, still executing,
 *     would satisfy a status-only predicate and commit its result into the
 *     second run's slot. The attempt table keyed every write on the attempt's
 *     primary key; `refinementRunId` is that key.
 *
 * A lost CAS is not an error. It means this run was superseded, which is a
 * normal outcome, so it returns `{ persisted: false }` rather than throwing —
 * the same contract the draft writers use, so the workflow's existing branch
 * carries over unchanged.
 */
export async function completeRefinement(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	runId: string;
	body: string;
	/** The model's note about the revision, or null. */
	note: string | null;
}): Promise<DraftCommitOutcome> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { persisted: false, reason: "project_ineligible" };
		}

		const stored = await tx.publishingTopicWorkingDraft.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
			},
			select: {
				id: true,
				updatedAt: true,
				organizationId: true,
				userId: true,
			},
		});
		if (!stored) {
			return { persisted: false, reason: "attempt_missing" };
		}
		// TENANT FENCE, as on `completeTopicDraft`: the lock proves the project
		// is eligible, not that this run belongs to the tenant that now owns it.
		// A refinement opened under org A and committed after a transfer to B
		// would otherwise put text generated on A's identity and quota in front
		// of B's members.
		if (!sameTenant(stored, tenant)) {
			return { persisted: false, reason: "tenant_changed" };
		}

		const written = await tx.publishingTopicWorkingDraft.updateMany({
			where: {
				id: stored.id,
				refinementRunId: input.runId,
				refinementStatus: "GENERATING",
			},
			data: {
				refinementStatus: "READY",
				refinedBody: input.body,
				refinementNote: input.note,
				refinementError: null,
				// Cleared so the row stops matching the expiry predicate. A
				// terminal proposal keeping a past deadline is what makes a
				// finished refinement read as stranded.
				refinementExpiresAt: null,
				refinementUpdatedAt: new Date(),
				// PINNED. The proposal is not the body — nothing the reader is
				// editing has changed yet, and it will not until they accept.
				updatedAt: stored.updatedAt,
			},
		});

		return written.count > 0
			? { persisted: true }
			: { persisted: false, reason: "superseded" };
	});
}

/**
 * Mark a refinement run failed.
 *
 * Same CAS and same tenant fence as the success path, for the same reasons. The
 * proposal columns are left in place apart from the error: `refinedFromBody` and
 * `refinementInstruction` are what let the panel say WHICH request failed, and
 * clearing them would reduce a failed refinement to an error with no subject.
 */
export async function failRefinement(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	runId: string;
	error: string;
}): Promise<DraftCommitOutcome> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { persisted: false, reason: "project_ineligible" };
		}

		const stored = await tx.publishingTopicWorkingDraft.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
			},
			select: {
				id: true,
				updatedAt: true,
				organizationId: true,
				userId: true,
			},
		});
		if (!stored) {
			return { persisted: false, reason: "attempt_missing" };
		}
		if (!sameTenant(stored, tenant)) {
			return { persisted: false, reason: "tenant_changed" };
		}

		const written = await tx.publishingTopicWorkingDraft.updateMany({
			where: {
				id: stored.id,
				refinementRunId: input.runId,
				refinementStatus: "GENERATING",
			},
			data: {
				refinementStatus: "FAILED",
				refinedBody: null,
				refinementNote: null,
				refinementError: input.error,
				refinementExpiresAt: null,
				refinementUpdatedAt: new Date(),
				updatedAt: stored.updatedAt,
			},
		});

		return written.count > 0
			? { persisted: true }
			: { persisted: false, reason: "superseded" };
	});
}

export type AcceptRefinementResult =
	| { status: "accepted"; updatedAt: Date; version: number }
	| { status: "project_ineligible" }
	/** No working draft for that topic and content type. */
	| { status: "not_found" }
	/** Nothing to accept: no proposal, or one that is still running or failed. */
	| { status: "no_proposal" }
	/**
	 * The body moved since this proposal was computed against it.
	 *
	 * DISTINCT from `stale`, and the distinction is the point. `stale` means the
	 * caller's own view is behind and refreshing fixes it. This means the
	 * proposal itself is answering a question about text that is no longer
	 * saved — accepting would discard whatever replaced it — so the fix is to
	 * run the refinement again, not to refresh.
	 */
	| { status: "baseline_changed" }
	| { status: "stale" };

/**
 * Accept the proposal: it becomes the working draft body, and the proposal is
 * cleared.
 *
 * ONE transaction, and that is a correctness requirement rather than tidiness.
 * Writing the body through `updateWorkingDraftBody` and clearing the proposal in
 * a second call would leave a window in which the text is already accepted and
 * the panel still offers to accept it — and a crash inside that window leaves it
 * open forever.
 *
 * It goes through the SAME revision machinery every other body writer goes
 * through — `captureOutgoingBodyIfUnrecorded` then `appendDraftRevision` — so an
 * accepted refinement is recoverable exactly like a hand edit. Writing `body`
 * directly would reopen the gap the draft-revision slice just closed: a body
 * replaced with no revision behind it is a body that cannot be restored.
 *
 * TWO staleness checks, because two different things can have moved and they
 * need opposite answers:
 *
 *   - `expectedUpdatedAt` — the CALLER's view is behind. Someone saved while
 *     this reader was deciding. Refresh and retry.
 *   - `refinedFromBody` vs the live `body` — the PROPOSAL is behind. It revises
 *     text that is no longer saved. Refreshing changes nothing; the refinement
 *     has to be run again.
 *
 * The second is not hypothetical. The working draft is SHARED per topic rather
 * than per author — `editingUserId` is advisory and take-over is always
 * available — so "A refines from X, B edits to Y, A accepts" is an ordinary
 * sequence, and without this check it silently destroys B's edit.
 *
 * Here `updatedAt` is deliberately NOT pinned. The body genuinely changed, so
 * every open editor's token SHOULD be invalidated — that is the mechanism
 * working, not the collision the proposal writers avoid.
 */
export async function acceptRefinement(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	acceptedById: string;
	/** The row's `updatedAt` as the accepting client last saw it. */
	expectedUpdatedAt: Date;
}): Promise<AcceptRefinementResult> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		const current = await tx.publishingTopicWorkingDraft.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
			},
			select: {
				id: true,
				body: true,
				updatedById: true,
				sourceDraftId: true,
				refinementStatus: true,
				refinedBody: true,
				refinedFromBody: true,
				refinementInstruction: true,
			},
		});
		if (!current) {
			return { status: "not_found" as const };
		}

		const proposed = current.refinedBody;
		if (current.refinementStatus !== "READY" || !proposed) {
			return { status: "no_proposal" as const };
		}
		// The baseline check runs BEFORE the compare-and-set, so a proposal
		// computed against superseded text is refused without touching the row.
		if (current.refinedFromBody !== current.body) {
			return { status: "baseline_changed" as const };
		}

		const written = await tx.publishingTopicWorkingDraft.updateMany({
			where: { id: current.id, updatedAt: input.expectedUpdatedAt },
			data: {
				body: proposed,
				updatedById: input.acceptedById,
				// The proposal is spent. Cleared in the same statement that
				// consumes it, so there is no state in which the body is
				// accepted and the proposal is still offered.
				refinementRunId: null,
				refinementStatus: null,
				refinedBody: null,
				refinedFromBody: null,
				refinementInstruction: null,
				refinementNote: null,
				refinementError: null,
				refinementExpiresAt: null,
				refinementRequestedById: null,
				refinementUpdatedAt: new Date(),
				organizationId: tenant.organizationId,
				userId: tenant.userId,
			},
		});
		if (written.count === 0) {
			return { status: "stale" as const };
		}

		const saved = await tx.publishingTopicWorkingDraft.findUniqueOrThrow({
			where: { id: current.id },
			select: { updatedAt: true },
		});

		// `sourceDraftId` still names the candidate this draft STARTED as — a
		// refinement revises the working copy and does not re-seed it from a
		// generation, so the provenance it descends from is unchanged. Read from
		// the row's own column rather than from the newest candidate, for the
		// reason `updateWorkingDraftBody` gives: stamping the latest run would
		// claim the author worked from something they never saw.
		const sourceVersion = current.sourceDraftId
			? ((
					await tx.publishingTopicDraft.findFirst({
						where: {
							id: current.sourceDraftId,
							topicId: input.topicId,
							projectId: input.projectId,
						},
						select: { version: true },
					})
				)?.version ?? null)
			: null;

		await captureOutgoingBodyIfUnrecorded(tx, {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
			tenant,
			outgoingBody: current.body,
			outgoingAuthorId: current.updatedById,
		});
		const version = await appendDraftRevision(tx, {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
			tenant,
			body: proposed,
			kind: "REFINED",
			sourceDraftVersion: sourceVersion,
			authorUserId: input.acceptedById,
			// The ASK, not a description of the result. A history that records
			// only what changed cannot answer why, and the instruction is the
			// only place the why exists.
			changeSummary: current.refinementInstruction,
		});

		return {
			status: "accepted" as const,
			updatedAt: saved.updatedAt,
			version,
		};
	});
}

export type RejectRefinementResult =
	| { status: "rejected"; updatedAt: Date }
	| { status: "project_ineligible" }
	| { status: "not_found" }
	/** There was no proposal to reject. Already the desired end state. */
	| { status: "no_proposal" };

/**
 * Discard the proposal. The working draft body is untouched.
 *
 * Accepts a proposal in ANY state, deliberately — including GENERATING and
 * FAILED. A FAILED proposal needs a way to be dismissed or the error sits on the
 * panel forever, and cancelling a run in flight is safe for the same reason the
 * run token exists: `completeRefinement` CASes on `refinementRunId`, so the
 * cancelled run's eventual write matches nothing and is reported as superseded.
 * The workflow is not signalled and does not need to be; it finishes, finds the
 * slot gone, and says so.
 *
 * `updatedAt` is PINNED. Rejecting changes nothing a reader is editing, so
 * invalidating their token would make a dismissed error look like someone else's
 * save.
 *
 * No `expectedUpdatedAt`. Rejection is idempotent and destroys nothing — the
 * body is untouched and the proposal is reproducible by running it again — so a
 * compare-and-set would add a conflict dialog protecting nothing.
 */
export async function rejectRefinement(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
}): Promise<RejectRefinementResult> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		const current = await tx.publishingTopicWorkingDraft.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
			},
			select: { id: true, updatedAt: true, refinementStatus: true },
		});
		if (!current) {
			return { status: "not_found" as const };
		}
		if (current.refinementStatus === null) {
			return { status: "no_proposal" as const };
		}

		await tx.publishingTopicWorkingDraft.updateMany({
			where: { id: current.id },
			data: {
				refinementRunId: null,
				refinementStatus: null,
				refinedBody: null,
				refinedFromBody: null,
				refinementInstruction: null,
				refinementNote: null,
				refinementError: null,
				refinementExpiresAt: null,
				refinementRequestedById: null,
				refinementUpdatedAt: new Date(),
				updatedAt: current.updatedAt,
			},
		});

		return { status: "rejected" as const, updatedAt: current.updatedAt };
	});
}
