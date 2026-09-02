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

import { db } from "../../client";
import {
	lockProjectTenant,
	sameTenant,
	uniqueViolationConstraint,
} from "./publishing-tenant-lock";

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
	updatedAt: Date;
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
			body: string;
			sourceDraftId: string | null;
			sourceOptionLabel: string | null;
			updatedAt: Date;
		}[]
	).map((w) => ({
		postType: w.postType as DraftPostType,
		hasBody: w.body.trim().length > 0,
		body: w.body,
		sourceDraftId: w.sourceDraftId,
		sourceOptionLabel: w.sourceOptionLabel,
		updatedAt: w.updatedAt,
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
}): Promise<{ persisted: boolean }> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { persisted: false };
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
		if (!stored || !sameTenant(stored, tenant)) {
			return { persisted: false };
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

		return { persisted: updated.count > 0 };
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
}): Promise<{ persisted: boolean }> {
	return db.$transaction(async (tx) => {
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { persisted: false };
		}

		const stored = await tx.publishingTopicDraft.findFirst({
			where: { id: input.id, projectId: input.projectId },
			select: { organizationId: true, userId: true },
		});
		if (!stored || !sameTenant(stored, tenant)) {
			return { persisted: false };
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

		return { persisted: updated.count > 0 };
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
 * This is the ONLY writer of `body`, and generation never touches this table.
 * That is what makes FR33 ("regenerating shall not silently overwrite saved
 * work") a property of where the writes go rather than a rule a later change has
 * to remember not to break.
 */
export async function saveWorkingDraft(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	sourceDraftId: string;
	sourceOptionLabel: string;
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
			select: { id: true },
		});
		if (!source) {
			return { status: "source_not_found" as const };
		}

		// Optimistic concurrency, read INSIDE the transaction that holds the
		// project lock — so between this read and the write below nothing else
		// can commit a selection for this project.
		const current = await tx.publishingTopicWorkingDraft.findUnique({
			where: {
				topicId_postType: {
					topicId: input.topicId,
					postType: input.postType,
				},
			},
			select: { updatedAt: true },
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

		return { status: "saved" as const, updatedAt: saved.updatedAt };
	});
}
