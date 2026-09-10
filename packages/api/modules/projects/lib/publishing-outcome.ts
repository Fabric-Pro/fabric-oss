/**
 * Publishing Suite → `AiOutcomeEvent`, in one place (Fizzy #1851 A9).
 *
 * The Suite had exactly one measurement before this: `answerSource` on a
 * decision entry, which says whether a recommended ANSWER was taken and nothing
 * about whether the feature works. The numbers the feature is judged on — how
 * many posts get generated, how much they get revised, how many people actually
 * publish — are all human verdicts on AI output, which is the table Fizzy #2230
 * already built. Nothing new is stored; this module is the mapping.
 *
 * ## The rules every emission here obeys
 *
 * **A metrics write may never fail the action it describes.** Each function is
 * total: it swallows everything, logs a warning, and resolves. That is the same
 * contract `accept-clean-spec-patch.ts` states at its own call site, hoisted
 * here so a new emission point cannot forget it — a `try`/`catch` a caller has
 * to remember is a guard that holds until somebody adds the fifth caller.
 *
 * **Emit AFTER the mutation commits.** Every caller records once its own write
 * has returned successfully, so a dropped row costs one measurement and the
 * user's action is already done.
 *
 * **The tenant is derived, never taken from the request.** Callers pass the
 * `organizationId` they resolved from the loaded Project row (or from
 * `resolveProjectTenant`), matching `requireEligibleProjectForTopic`'s rule
 * that `input.organizationId` is a guard and never a scoping key.
 *
 * ## Why one feature key and many subject types
 *
 * See the `publishing-suite` entry in `AI_FEATURE_KEYS`. In short:
 * `getAiOutcomeBreakdown` groups by `featureKey` alone, so one key keeps the
 * suite's headline acceptance number addable, and `subjectType` carries the
 * per-content-type split the table was designed to hold.
 */

import {
	getAiOutcomesForSubjects,
	getAnalysisRevisionSnapshot,
	getLatestReadyDraft,
	getWorkingDraftSourceSnapshot,
	recordAiOutcome,
	resolveProjectTenant,
	resolvePromptVersionId,
} from "@repo/database";
import { logger } from "@repo/logs";

/** The registry key every Publishing Suite verdict is filed under. */
const PUBLISHING_FEATURE_KEY = "publishing-suite";

/** The content types that produce a generated draft. */
type PublishingDraftPostType =
	| "TWEET"
	| "LINKEDIN_POST"
	| "BLOG_POST"
	| "CASE_STUDY"
	| "STAKEHOLDER_EMAIL"
	| "WEBINAR_SCRIPT";

/**
 * What a verdict is about.
 *
 * The content type is part of the SUBJECT TYPE rather than of the feature key,
 * so `GROUP BY featureKey, subjectType` answers "which content types are
 * working" while `GROUP BY featureKey` still answers "is the Suite working".
 * Append-only, exactly like the feature keys: renaming one orphans its history.
 */
type PublishingSubjectType =
	| "publishing-short-post"
	| "publishing-linkedin-post"
	| "publishing-blog-post"
	| "publishing-case-study"
	| "publishing-stakeholder-email"
	| "publishing-analysis"
	| "publishing-topic"
	| "publishing-webinar-script";

const SUBJECT_TYPE_BY_POST_TYPE: Record<
	PublishingDraftPostType,
	PublishingSubjectType
> = {
	TWEET: "publishing-short-post",
	LINKEDIN_POST: "publishing-linkedin-post",
	BLOG_POST: "publishing-blog-post",
	CASE_STUDY: "publishing-case-study",
	STAKEHOLDER_EMAIL: "publishing-stakeholder-email",
	WEBINAR_SCRIPT: "publishing-webinar-script",
};

/** Verdicts that mean the human took the output; see `skipIfAlreadyAccepted`. */
const ACCEPTED = new Set(["ACCEPTED_AS_IS", "ACCEPTED_WITH_EDITS"]);

export interface PublishingOutcomeParams {
	outcome: "ACCEPTED_AS_IS" | "ACCEPTED_WITH_EDITS" | "REJECTED";
	subjectType: PublishingSubjectType;
	subjectId: string;
	userId: string;
	organizationId: string | null;
	projectId: string;
	/** From the draft that produced the output, when the caller has one. */
	model?: string | null;
	promptId?: string | null;
	promptVersion?: number | null;
}

/**
 * File one verdict. Never throws, never rejects.
 *
 * `promptId` + `promptVersion` are resolved to a `PromptVersion` id rather than
 * passed through: the draft table records an integer version and the outcome
 * table wants a row id, and writing the integer into that column would make
 * every prompt comparison silently wrong. See `resolvePromptVersionId`.
 */
export async function recordPublishingOutcome(
	params: PublishingOutcomeParams,
): Promise<void> {
	try {
		const promptVersionId = await resolvePromptVersionId({
			promptId: params.promptId ?? null,
			promptVersion: params.promptVersion ?? null,
		});

		await recordAiOutcome({
			featureKey: PUBLISHING_FEATURE_KEY,
			outcome: params.outcome,
			subjectType: params.subjectType,
			subjectId: params.subjectId,
			userId: params.userId,
			organizationId: params.organizationId,
			projectId: params.projectId,
			modelCanonicalName: params.model ?? null,
			promptVersionId,
		});
	} catch (err) {
		logger.warn("[publishing-suite] outcome capture failed", {
			subjectType: params.subjectType,
			subjectId: params.subjectId,
			outcome: params.outcome,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}

export interface SupersededDraftParams {
	topicId: string;
	projectId: string;
	organizationId: string | null;
	postType: PublishingDraftPostType;
	userId: string;
}

/**
 * Record that a regeneration passed over the candidate that was on screen.
 *
 * This is the churn signal: the number of `REJECTED` rows a topic accumulates
 * before one of its candidates is accepted IS "how many regenerations it took",
 * which is one of the two numbers the feature was asked for. Each attempt is a
 * distinct draft row, so the rejections stack rather than overwrite.
 *
 * **It refuses to overwrite an acceptance.** `AiOutcomeEvent` holds one row per
 * (feature, subject, user), so a blind `REJECTED` on the previous candidate
 * would erase the `ACCEPTED_WITH_EDITS` written when that same person edited
 * the body they adopted — destroying the OTHER number the feature was asked
 * for, and doing it precisely in the flow A7 shipped "refine" to support
 * (adopt → edit → refine). This deviates from the literal mapping in the slice
 * brief, deliberately.
 *
 * The check reads the caller's own existing verdict rather than inferring one
 * from `workingDraft.sourceDraftId`. That column is not evidence of adoption:
 * the FIRST generation seeds a working draft pointing at its own candidate
 * (`seedWorkingDraftIfAbsent`), so treating it as "adopted" would silently drop
 * the rejection on every first regeneration — the most common one there is.
 */
export async function recordSupersededDraft(
	params: SupersededDraftParams,
): Promise<void> {
	try {
		// The attempt just started is GENERATING, never READY, so the newest
		// READY row is still the candidate this run supersedes.
		//
		// `getLatestReadyDraft` rather than `listTopicDrafts`: the
		// generate procedures are asserted never to call the latter outside
		// `readRefinementSource`, because a generation that reads the working
		// draft could leak saved work into a prompt. Measurement asks the
		// narrower question instead of relaxing that guard.
		const prior = await getLatestReadyDraft({
			topicId: params.topicId,
			projectId: params.projectId,
			postType: params.postType,
		});
		if (!prior) {
			// Nothing to supersede: a first generation rejects nobody, and
			// counting one would make every topic look like it took a retry.
			return;
		}

		const subjectType = SUBJECT_TYPE_BY_POST_TYPE[params.postType];
		const existing = await getAiOutcomesForSubjects({
			featureKey: PUBLISHING_FEATURE_KEY,
			subjectType,
			subjectIds: [prior.id],
			userId: params.userId,
		});
		if (ACCEPTED.has(existing[prior.id] ?? "")) {
			return;
		}

		await recordPublishingOutcome({
			outcome: "REJECTED",
			subjectType,
			subjectId: prior.id,
			userId: params.userId,
			organizationId: params.organizationId,
			projectId: params.projectId,
			model: prior.model,
			promptId: prior.promptId,
			promptVersion: prior.promptVersion,
		});
	} catch (err) {
		logger.warn("[publishing-suite] superseded-draft capture failed", {
			topicId: params.topicId,
			postType: params.postType,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}

export interface EditedWorkingDraftParams {
	topicId: string;
	projectId: string;
	organizationId: string | null;
	postType: PublishingDraftPostType;
	userId: string;
}

/**
 * Record that a human saved an edit over the candidate they adopted.
 *
 * `ACCEPTED_WITH_EDITS` against `ACCEPTED_AS_IS` is the "how many revisions"
 * number. The subject is the CANDIDATE, not the working draft: the verdict is
 * about the AI's output, and keying it to the candidate is what makes the two
 * outcomes comparable — the upsert then turns "adopted, then edited" into one
 * row that ends up saying `ACCEPTED_WITH_EDITS`, which is the truth.
 *
 * A working draft whose source candidate is gone is skipped rather than
 * recorded against nothing.
 */
export async function recordEditedWorkingDraft(
	params: EditedWorkingDraftParams,
): Promise<void> {
	try {
		const source = await getWorkingDraftSourceSnapshot({
			topicId: params.topicId,
			projectId: params.projectId,
			postType: params.postType,
		});
		if (!source) {
			return;
		}

		await recordPublishingOutcome({
			outcome: "ACCEPTED_WITH_EDITS",
			subjectType: SUBJECT_TYPE_BY_POST_TYPE[params.postType],
			subjectId: source.draftId,
			userId: params.userId,
			organizationId: params.organizationId,
			projectId: params.projectId,
			model: source.model,
			promptId: source.promptId,
			promptVersion: source.promptVersion,
		});
	} catch (err) {
		logger.warn("[publishing-suite] edited-draft capture failed", {
			topicId: params.topicId,
			postType: params.postType,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}

export interface AnalysisRevisionOutcomeParams {
	topicId: string;
	projectId: string;
	organizationId: string | null;
	userId: string;
	/** The version `saveAnalysisRevision` reported writing. */
	revisionVersion: number;
	/** The AI analysis version the editor was seeded from. */
	sourceAnalysisVersion: number;
}

/**
 * Record a human revision of the AI's planning analysis prose.
 *
 * One row per revision, because the subject is the revision — see
 * `getAnalysisRevisionSnapshot` for why keying on the analysis instead would
 * collapse a person's whole editing history into a single row.
 *
 * No prompt snapshot: `PublishingTopicPlanningAnalysis` carries `model` and
 * `promptSource` but no prompt id or version, so there is nothing to resolve.
 */
export async function recordAnalysisRevisionOutcome(
	params: AnalysisRevisionOutcomeParams,
): Promise<void> {
	try {
		const snapshot = await getAnalysisRevisionSnapshot({
			topicId: params.topicId,
			projectId: params.projectId,
			revisionVersion: params.revisionVersion,
			sourceAnalysisVersion: params.sourceAnalysisVersion,
		});
		if (!snapshot) {
			return;
		}

		await recordPublishingOutcome({
			outcome: "ACCEPTED_WITH_EDITS",
			subjectType: "publishing-analysis",
			subjectId: snapshot.revisionId,
			userId: params.userId,
			organizationId: params.organizationId,
			projectId: params.projectId,
			model: snapshot.model,
		});
	} catch (err) {
		logger.warn("[publishing-suite] analysis-revision capture failed", {
			topicId: params.topicId,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}

export interface TopicStatusOutcomeParams {
	topicId: string;
	projectId: string;
	userId: string;
	/** The status the topic just moved to. */
	status: string;
}

/**
 * Record the end of a topic's life: declined, or published.
 *
 * `COUNT(DISTINCT userId)` over the published rows is the closest thing the
 * system has to the measure the feature was actually funded on — going from
 * roughly five people posting regularly to twenty-five.
 *
 * Every topic is recorded, including one a person typed in by hand. Dropping
 * manual topics would keep the acceptance rate honest but destroy that
 * publisher count, and only one of those two is recoverable afterwards:
 * `subjectId` IS the topic id, so a dashboard that wants AI-suggested topics
 * only joins `publishing_topic` and filters `origin`. **An acceptance rate over
 * `publishing-topic` that does not exclude `origin = MANUAL` is inflated.**
 *
 * The organization is resolved from the Project row rather than from the
 * request, which is why this reaches for `resolveProjectTenant` instead of
 * taking an id: `updatePublishingTopicStatus` deliberately carries no project
 * ratchet — adding one would start 404-ing status changes on archived projects
 * — so there is no loaded project to inherit the tenant from.
 */
export async function recordTopicStatusOutcome(
	params: TopicStatusOutcomeParams,
): Promise<void> {
	if (params.status !== "PUBLISHED" && params.status !== "DECLINED") {
		return;
	}
	try {
		const tenant = await resolveProjectTenant(params.projectId);

		await recordPublishingOutcome({
			outcome:
				params.status === "PUBLISHED" ? "ACCEPTED_AS_IS" : "REJECTED",
			subjectType: "publishing-topic",
			subjectId: params.topicId,
			userId: params.userId,
			organizationId: tenant?.organizationId ?? null,
			projectId: params.projectId,
		});
	} catch (err) {
		logger.warn("[publishing-suite] topic-status capture failed", {
			topicId: params.topicId,
			status: params.status,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}
