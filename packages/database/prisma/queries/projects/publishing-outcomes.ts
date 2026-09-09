/**
 * Reads that exist only to describe a Publishing Suite verdict to
 * `AiOutcomeEvent` (Fizzy #1851 A9, measurement over the #2230 substrate).
 *
 * Every function here is OBSERVATION. None of them is on the path of the write
 * it describes: each is called after the user's mutation has already committed,
 * from inside the caller's metrics guard, so a failure loses one measurement
 * row and nothing else. Keeping them in their own module rather than beside the
 * writers is the reason that stays true — nothing in here is reachable from a
 * transaction, and nothing in here may grow a write.
 */

import { db } from "../../client";
import type { DraftPostType } from "./publishing-drafts";

/**
 * The `PromptVersion` row id for a draft's `(promptId, promptVersion)` pair.
 *
 * `PublishingTopicDraft` records the prompt as an id plus an INTEGER version,
 * but `AiOutcomeEvent.promptVersionId` holds a `PromptVersion` primary key —
 * the two are not interchangeable, and writing the integer would silently
 * poison the one correlation the column exists to support (acceptance across
 * prompt revisions). Resolved here rather than at each call site so no emission
 * point can get that wrong.
 *
 * Null in, null out: an older draft may predate prompt attribution, and a
 * verdict on it is still worth recording without a prompt snapshot.
 */
export async function resolvePromptVersionId(input: {
	promptId: string | null;
	promptVersion: number | null;
}): Promise<string | null> {
	if (!input.promptId || input.promptVersion == null) {
		return null;
	}
	const row = await db.promptVersion.findUnique({
		where: {
			promptId_version: {
				promptId: input.promptId,
				version: input.promptVersion,
			},
		},
		select: { id: true },
	});
	return row?.id ?? null;
}

export interface LatestReadyDraft {
	id: string;
	model: string | null;
	promptId: string | null;
	promptVersion: number | null;
}

/**
 * The newest READY candidate for one topic and content type.
 *
 * Deliberately NOT `listTopicDrafts`, which would answer the same question.
 * That helper folds every row for every content type and, on the generate path,
 * is reserved for `readRefinementSource` — `stakeholder-email.test.ts` and its
 * three siblings assert it is never called during an ordinary generation,
 * because a generation that reads the working draft is a generation that could
 * leak saved work into a prompt it must not touch. Measurement has no business
 * relaxing that guard, so it asks a narrower question: one post type, one row,
 * candidates only.
 */
export async function getLatestReadyDraft(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
}): Promise<LatestReadyDraft | null> {
	return db.publishingTopicDraft.findFirst({
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
			status: "READY",
		},
		orderBy: { version: "desc" },
		select: { id: true, model: true, promptId: true, promptVersion: true },
	});
}

export interface WorkingDraftSourceSnapshot {
	/** The generated candidate this saved body started as. */
	draftId: string;
	model: string | null;
	promptId: string | null;
	promptVersion: number | null;
}

/**
 * The candidate a topic's saved working draft started as, with the model and
 * prompt that produced it.
 *
 * An edit's verdict belongs to the AI output it was applied to, and
 * `updateWorkingDraftBody` returns only a timestamp — it has no reason to know
 * about measurement. This resolves the subject afterwards instead.
 *
 * Scoped by `{ topicId, projectId }` like every other read in this feature, so
 * a topic id belonging to another project resolves to the same nothing a
 * missing one does. Returns null when the working draft has no source: the
 * composite FK is `ON DELETE SET NULL ("sourceDraftId")`, so a candidate that
 * was removed leaves a body with nothing to attribute the edit to, and a
 * verdict with no subject is worse than no verdict.
 */
export async function getWorkingDraftSourceSnapshot(input: {
	topicId: string;
	projectId: string;
	postType: DraftPostType;
}): Promise<WorkingDraftSourceSnapshot | null> {
	const working = await db.publishingTopicWorkingDraft.findFirst({
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
		},
		select: { sourceDraftId: true },
	});
	if (!working?.sourceDraftId) {
		return null;
	}

	// A second read rather than an `include`: `sourceDraftId` is a PLAIN column
	// (the composite FK lives in a migration, not in the Prisma model), so there
	// is no relation to traverse. Scoped by all three ids anyway — the candidate
	// must belong to the same topic in the same project as the body quoting it.
	const draft = await db.publishingTopicDraft.findFirst({
		where: {
			id: working.sourceDraftId,
			topicId: input.topicId,
			projectId: input.projectId,
		},
		select: { model: true, promptId: true, promptVersion: true },
	});
	return {
		draftId: working.sourceDraftId,
		model: draft?.model ?? null,
		promptId: draft?.promptId ?? null,
		promptVersion: draft?.promptVersion ?? null,
	};
}

export interface AnalysisRevisionSnapshot {
	/** The revision row the human just saved — the verdict's subject. */
	revisionId: string;
	/** The model that produced the analysis the revision was edited from. */
	model: string | null;
}

/**
 * The revision row a save just produced, and the model behind the analysis it
 * was edited from.
 *
 * The subject is the REVISION, not the analysis: `AiOutcomeEvent` holds one row
 * per (feature, subject, user), so keying on the analysis would collapse every
 * edit a person makes into a single row and lose the revision count — which is
 * the number this emission exists to produce.
 *
 * `revisionVersion` is checked rather than assumed. `saveAnalysisRevision`
 * returns the version it wrote, and reading "the current revision" afterwards
 * can pick up somebody else's newer save; attributing this user's verdict to
 * that row would be a lie. A mismatch returns null and the verdict is dropped.
 *
 * `PublishingTopicPlanningAnalysis` carries no prompt columns at all — only
 * `model` and `promptSource` — so there is no prompt snapshot to take here, and
 * the caller writes `promptVersionId: null` rather than inventing one.
 */
export async function getAnalysisRevisionSnapshot(input: {
	topicId: string;
	projectId: string;
	revisionVersion: number;
	sourceAnalysisVersion: number;
}): Promise<AnalysisRevisionSnapshot | null> {
	const [revision, analysis] = await Promise.all([
		db.publishingTopicAnalysisRevision.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				version: input.revisionVersion,
			},
			select: { id: true },
		}),
		db.publishingTopicPlanningAnalysis.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				version: input.sourceAnalysisVersion,
			},
			select: { model: true },
		}),
	]);
	if (!revision) {
		return null;
	}
	return { revisionId: revision.id, model: analysis?.model ?? null };
}
