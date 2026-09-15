import { z } from "zod";

export const DAILY_BRIEF_SCHEMA_VERSION = 3;

export const timeWindowKindSchema = z.enum([
	"LAST_24H",
	"LAST_7D",
	"LAST_2W",
	"CUSTOM",
]);
export type TimeWindowKind = z.infer<typeof timeWindowKindSchema>;

export const DEFAULT_DAILY_BRIEF_WINDOW: TimeWindowKind = "LAST_7D";

export const dailyBriefStatusSchema = z.enum([
	"GENERATING",
	"READY",
	"EMPTY",
	"FAILED",
]);
export type DailyBriefStatus = z.infer<typeof dailyBriefStatusSchema>;

export const priorityActionKindSchema = z.enum([
	"security_findings",
	"decisions_proposed",
	"blocker",
	"due_date_risk",
	"missing_ownership",
	"unresolved_dependency",
	"story_stale",
	"pr_review_stale",
	// v3 (Slice 8): a success metric moved against its direction, missed its
	// target, or has not been observed for a while.
	"metric_drift",
]);
export type PriorityActionKind = z.infer<typeof priorityActionKindSchema>;

export const priorityActionSchema = z.object({
	kind: priorityActionKindSchema,
	title: z.string(),
	whyItMatters: z.string(),
	targetCuid: z.string(),
	targetIdentifier: z.string(),
	// `metric` (v3) targets a ProjectSuccessMetric; `targetCuid` is the metric id.
	targetType: z.enum([
		"story",
		"task",
		"document",
		"scan",
		"architecture_decision",
		"metric",
	]),
	fabricLink: z.string(),
	assigneeUserId: z.string().optional(),
});
export type PriorityAction = z.infer<typeof priorityActionSchema>;

const baseItem = z.object({
	occurredAt: z.coerce.date(),
	title: z.string(),
	fabricLink: z.string().optional(),
});

export const githubItemSchema = baseItem.extend({
	kind: z.enum(["pr_opened", "pr_merged", "pr_awaiting_review", "pr_closed"]),
	prNumber: z.number().int(),
	repoFullName: z.string(),
	url: z.string(),
	author: z.string().optional(),
	/**
	 * The PR author's numeric GitHub user id as a string (matches
	 * `Account.accountId` for `providerId: "github"`). Captured ONLY on the
	 * publishing-suggestion collection path (`collect-pull-requests.ts` sets
	 * `captureAuthorGithubId: true`) and consumed ONLY by the publishing-suite
	 * PR-author attribution resolver. The Daily Brief proxies the same collector
	 * WITHOUT that flag, so the id is never emitted on the Daily Brief path — it
	 * therefore never reaches the LLM prompt, the persisted brief, or Daily Brief
	 * Temporal history. Optional — items (and briefs) without it still parse.
	 */
	authorGithubId: z.string().optional(),
	state: z.enum(["open", "closed", "merged"]).optional(),
	/**
	 * The PR's target branch (base ref). The UI groups items into "Prod" when
	 * baseRef === "production" and "Staging" otherwise. Optional for backwards
	 * compatibility with briefs generated before this field existed.
	 */
	baseRef: z.string().optional(),
	/**
	 * The PR description body, truncated. Used by the release-notes summarizer
	 * to write user-facing release blurbs. For squash-merged PRs this matches
	 * the commit message body. Optional for backwards compatibility.
	 */
	body: z.string().optional(),
});
export type GithubItem = z.infer<typeof githubItemSchema>;

/**
 * A published GitHub Release surfaced in the Daily Brief "Deployments" section.
 * Modeled on baseItem so `occurredAt` (= release.published_at) works with the
 * page's since-last-review cursor filter. Drafts and pre-releases are excluded
 * upstream by the collector — only published, stable releases reach here.
 */
export const deploymentItemSchema = baseItem.extend({
	repoFullName: z.string(),
	tagName: z.string(),
	releaseName: z.string().optional(),
	url: z.string(),
	author: z.string().optional(),
	body: z.string().optional(),
});
export type DeploymentItem = z.infer<typeof deploymentItemSchema>;

export const storyChangeItemSchema = baseItem.extend({
	kind: z.enum([
		"status_changed",
		"created",
		"assignee_changed",
		"content_changed",
		"priority_changed",
	]),
	storyCuid: z.string(),
	storyIdentifier: z.string(),
	fromValue: z.string().optional(),
	toValue: z.string().optional(),
	changedByUserId: z.string().optional(),
});
export type StoryChangeItem = z.infer<typeof storyChangeItemSchema>;

export const taskChangeItemSchema = baseItem.extend({
	kind: z.enum([
		"status_changed",
		"created",
		"due_date_changed",
		"completed",
	]),
	taskCuid: z.string(),
	taskIdentifier: z.string(),
	storyCuid: z.string().optional(),
	storyIdentifier: z.string().optional(),
	fromValue: z.string().optional(),
	toValue: z.string().optional(),
});
export type TaskChangeItem = z.infer<typeof taskChangeItemSchema>;

export const documentChangeItemSchema = baseItem.extend({
	kind: z.enum(["created", "updated", "version_added"]),
	documentCuid: z.string(),
	documentType: z.string(),
	version: z.number().int().optional(),
	changeDescription: z.string().optional(),
	changedByUserId: z.string().optional(),
});
export type DocumentChangeItem = z.infer<typeof documentChangeItemSchema>;

export const meetingDecisionSchema = z.object({
	text: z.string(),
	relatedStoryCuid: z.string().optional(),
	relatedStoryIdentifier: z.string().optional(),
	sourceQuote: z.string().optional(),
	anchorLine: z.number().int().positive().optional(),
});
export type MeetingDecision = z.infer<typeof meetingDecisionSchema>;

export const meetingActionItemSchema = z.object({
	text: z.string(),
	tentativeOwnerName: z.string().optional(),
	tentativeOwnerUserId: z.string().optional(),
	dueHint: z.string().optional(),
	sourceQuote: z.string().optional(),
	anchorLine: z.number().int().positive().optional(),
});
export type MeetingActionItem = z.infer<typeof meetingActionItemSchema>;

export const meetingOpenQuestionSchema = z.object({
	text: z.string(),
	sourceQuote: z.string().optional(),
	anchorLine: z.number().int().positive().optional(),
});
export type MeetingOpenQuestion = z.infer<typeof meetingOpenQuestionSchema>;

export const meetingItemSchema = baseItem.extend({
	transcriptCuid: z.string(),
	meetingDate: z.coerce.date(),
	summary: z.string().optional(),
	keywords: z.array(z.string()).optional(),
	speakerNames: z.array(z.string()).optional(),
	contentLength: z.number().int().optional(),
	decisions: z.array(meetingDecisionSchema).optional(),
	actionItems: z.array(meetingActionItemSchema).optional(),
	openQuestions: z.array(meetingOpenQuestionSchema).optional(),
});
export type MeetingItem = z.infer<typeof meetingItemSchema>;

export const teamsProposalItemSchema = baseItem.extend({
	proposalCuid: z.string(),
	status: z.enum([
		"PENDING",
		"APPROVED",
		"APPLYING",
		"APPLIED",
		"REJECTED",
		"FAILED",
	]),
	changeCount: z.number().int(),
	summary: z.string().optional(),
	channelName: z.string().optional(),
});
export type TeamsProposalItem = z.infer<typeof teamsProposalItemSchema>;

export const partialFailureSchema = z.object({
	source: z.enum([
		"stories",
		"tasks",
		"documents",
		"meetings",
		"teamsProposals",
		"github",
		"ahead",
		"releaseNotes",
		// v3 (Slice 8): success-metric drift collector.
		"metrics",
	]),
	reason: z.string(),
});
export type PartialFailure = z.infer<typeof partialFailureSchema>;

export const dailyBriefSectionsSchema = z.object({
	github: z.array(githubItemSchema).optional(),
	storyChanges: z.array(storyChangeItemSchema).optional(),
	taskChanges: z.array(taskChangeItemSchema).optional(),
	documents: z.array(documentChangeItemSchema).optional(),
	meetings: z.array(meetingItemSchema).optional(),
	teamsProposals: z.array(teamsProposalItemSchema).optional(),
	deployments: z.array(deploymentItemSchema).optional(),
});
export type DailyBriefSections = z.infer<typeof dailyBriefSectionsSchema>;

// ---------------------------------------------------------------------------
// v2 additions (all optional so v1 blobs remain valid)
// ---------------------------------------------------------------------------

export const storylineRelatedItemSchema = z.object({
	kind: z.enum([
		"github",
		"story_change",
		"task_change",
		"document",
		"meeting",
		"teams_proposal",
	]),
	refId: z.string(),
	occurredAt: z.coerce.date(),
	title: z.string().optional(),
});
export type StorylineRelatedItem = z.infer<typeof storylineRelatedItemSchema>;

export const storylineSchema = z.object({
	storyCuid: z.string().optional(),
	storyIdentifier: z.string().optional(),
	headline: z.string(),
	narrative: z.string(),
	relatedItems: z.array(storylineRelatedItemSchema),
});
export type Storyline = z.infer<typeof storylineSchema>;

/**
 * Per-environment release-notes summary written by the LLM. Rendered as a
 * prose blurb at the top of each environment's section in the UI. Both fields
 * are optional — empty/missing = render nothing.
 */
export const releaseNotesSummarySchema = z.object({
	prod: z.string().optional(),
	staging: z.string().optional(),
});
export type ReleaseNotesSummary = z.infer<typeof releaseNotesSummarySchema>;

export const aheadItemSchema = z.object({
	kind: z.enum([
		"upcoming_meeting",
		"story_about_to_transition",
		"proposal_expiring",
	]),
	title: z.string(),
	occursAt: z.coerce.date(),
	fabricLink: z.string(),
	context: z.string().optional(),
	targetCuid: z.string().optional(),
	targetIdentifier: z.string().optional(),
});
export type AheadItem = z.infer<typeof aheadItemSchema>;

// ---------------------------------------------------------------------------
// v3 additions (Slice 8 — success metrics). Optional so v1/v2 blobs remain valid.
// ---------------------------------------------------------------------------

export const metricDriftReasonSchema = z.enum([
	"moved_against_direction",
	"missed_target",
	"stale_observation",
]);
export type MetricDriftReason = z.infer<typeof metricDriftReasonSchema>;

/**
 * One drifting success metric. Values are the metric's own numbers; no
 * customer-facing names beyond the metric name the team chose.
 */
export const metricDriftItemSchema = z.object({
	metricId: z.string(),
	name: z.string(),
	direction: z.enum(["UP", "DOWN"]),
	target: z.number().nullable(),
	lastValue: z.number().nullable(),
	previousValue: z.number().nullable(),
	lastObservedAt: z.coerce.date().nullable(),
	reasons: z.array(metricDriftReasonSchema).min(1),
});
export type MetricDriftItem = z.infer<typeof metricDriftItemSchema>;

export const dailyBriefContentSchema = z.object({
	// Stored briefs from every prior version must keep parsing; only the
	// constant above moves. See __tests__/daily-brief-schema-v3.test.ts.
	schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
	executiveSummary: z.string(),
	priorityActions: z.array(priorityActionSchema),
	sections: dailyBriefSectionsSchema,
	partialFailures: z.array(partialFailureSchema).optional(),
	// v2
	storylines: z.array(storylineSchema).optional(),
	ahead: z.array(aheadItemSchema).optional(),
	releaseNotesSummary: releaseNotesSummarySchema.optional(),
	deploymentsError: z.string().optional(),
	/**
	 * The repository's GitHub-canonical "Latest" release (via /releases/latest),
	 * window-independent. Rendered as the "Prod release" anchor when the PR-derived
	 * prod bucket is empty. Optional + additive → rollback-safe (old readers strip it).
	 */
	latestProdRelease: deploymentItemSchema.optional(),
	/**
	 * Per-repository GitHub-canonical "Latest" production release (window-independent),
	 * newest-first. Rendered as the "Prod release" anchor (one card per repo) when the
	 * PR-derived prod bucket is empty. New readers prefer this; old readers fall back to
	 * `latestProdRelease`. Optional + additive → rollback-safe (old readers strip it).
	 */
	latestProdReleasesByRepo: z.array(deploymentItemSchema).optional(),
	// v3
	metricDrift: z.array(metricDriftItemSchema).optional(),
});
export type DailyBriefContent = z.infer<typeof dailyBriefContentSchema>;

export function resolveTimeWindow(
	kind: TimeWindowKind,
	now: Date = new Date(),
	custom?: { start: Date; end: Date },
): { start: Date; end: Date } {
	if (kind === "CUSTOM") {
		if (!custom) {
			throw new Error("CUSTOM time window requires explicit start/end");
		}
		return custom;
	}
	const end = now;
	const start = new Date(now);
	switch (kind) {
		case "LAST_24H":
			start.setHours(start.getHours() - 24);
			break;
		case "LAST_7D":
			start.setDate(start.getDate() - 7);
			break;
		case "LAST_2W":
			start.setDate(start.getDate() - 14);
			break;
	}
	return { start, end };
}
