import { NotificationType } from "@repo/database";
import { z } from "zod";

const mentionLikeBase = z.object({
	commentId: z.string(),
	storyId: z.string().optional(),
	taskId: z.string().optional(),
	projectId: z.string(),
	mentionedByUserId: z.string(),
	snippet: z.string().max(280),
});

const replyLikeBase = z.object({
	commentId: z.string(),
	parentCommentId: z.string(),
	storyId: z.string().optional(),
	taskId: z.string().optional(),
	projectId: z.string(),
	repliedByUserId: z.string(),
	snippet: z.string().max(280),
});

const assignmentBase = z.object({
	storyId: z.string(),
	projectId: z.string(),
	assignedByUserId: z.string(),
	previousAssigneeId: z.string().nullable().optional(),
});

const documentMentionBase = z.object({
	documentId: z.string(),
	projectId: z.string(),
	mentionedByUserId: z.string(),
	mentionAnchorId: z.string(),
	snippet: z.string().max(280),
});

const storyStatusChangedBase = z.object({
	storyId: z.string(),
	projectId: z.string(),
	previousStatusId: z.string().nullable(),
	previousStatusName: z.string().nullable(),
	statusId: z.string(),
	statusName: z.string(),
	movedByUserId: z.string(),
});

const pmSyncConflictBase = z.object({
	storyId: z.string(),
	projectId: z.string(),
	pendingStateChangeId: z.string(),
	previousState: z.string(),
	newState: z.string(),
});

// Threshold-crossing payload for AI_USAGE_LIMIT_WARNING (80%) and
// AI_USAGE_LIMIT_REACHED (100%). `used` and `max` are serialized as
// strings because the underlying Prisma column is BigInt and JSON cannot
// carry BigInts losslessly. The inbox renderer reformats them with the
// dimension's unit (`tokens` or USD).
const aiUsageLimitThresholdPayload = z.object({
	limitId: z.string(),
	limitName: z.string().nullable(),
	threshold: z.union([z.literal(80), z.literal(100)]),
	dimension: z.enum(["TOKENS", "SPEND_USD"]),
	window: z.enum(["HOURLY", "DAILY", "MONTHLY"]),
	used: z.string(),
	max: z.string(),
});

// Incident-source notification payload.
//
// Used by both INTEGRATION_INCIDENT (per-org rollup for affected integrations)
// and SYSTEM_INCIDENT (admin rows for error-rate burns). The shape is shared
// because both are sourced from an incident lifecycle workflow that already
// owns the canonical record in error_rate_incident / integration_incident.
//
// `providerKey` is set only when the incident has an integration source
// (registry key from packages/observability/src/integration-providers.ts).
//
// Note: severity is stored as the lowercase string ("sev1" | "sev2" | "sev3")
// rather than the IncidentSeverity enum's uppercase form (SEV1, SEV2, SEV3).
// Alertmanager rule labels emit the lowercase form and the alertmanager
// routing config uses it, so we keep the same wire shape here.
const incidentNotificationBase = z.object({
	incidentId: z.string().min(1),
	providerKey: z.string().min(1).optional(),
	severity: z.enum(["sev1", "sev2", "sev3"]),
	summary: z.string().max(280),
	link: z.string().min(1),
	startedAt: z.string().min(1), // ISO 8601 timestamp
});

// CONTEXT_INDEXING_STARTED payload — written by `processContextLinkProcedure`
// immediately after `workflow.start` resolves. Shape pinned by spec §8.2.
// `scope` mirrors the URL-source scope enum so the bell renderer can branch
// on it (e.g., to show a different sub-line for single-page vs multi-page).
const contextIndexingStartedPayload = z.object({
	contextId: z.string(),
	sourceUrl: z.string(),
	scope: z.enum(["SINGLE_PAGE", "PATH_PREFIX"]),
});

// CONTEXT_INDEXING_COMPLETED payload — written from inside
// `updateParentStatusActivity` on terminal status COMPLETED or FAILED. Spec
// §8.2 + §8.5. The `status` field is what the inbox renderer reads to pick
// the success-vs-failure icon (CheckCircle vs AlertCircle) — without it the
// completed-row would always render as success.
const contextIndexingCompletedPayload = z.object({
	contextId: z.string(),
	sourceUrl: z.string(),
	status: z.enum(["COMPLETED", "FAILED"]),
	pagesIndexed: z.number().int().nonnegative().optional(),
	extractionError: z.string().nullable().optional(),
});

// REPO_INTEGRATION_TOKEN_EXPIRED payload — written by the scheduled repo
// health check (`packages/temporal/src/activities/repo-health-check.ts`) when
// a project repository integration transitions into an expired/auth-failed
// state and auto-refresh cannot recover. The write happens directly via the
// `@repo/database` helper `createRepoIntegrationCredentialNotification` (which
// does not run this validator — the activity cannot import the @repo/api
// validator without a workspace cycle), but the schema is registered here so
// the validator stays total over `NotificationType`. `provider` mirrors the
// `RepositoryProvider` enum values surfaced by the activity.
const repoIntegrationTokenExpiredPayload = z.object({
	integrationId: z.string(),
	projectId: z.string(),
	projectName: z.string(),
	provider: z.string(),
	repositoryOwner: z.string(),
	repositoryName: z.string(),
	/** The status the integration transitioned into: TOKEN_EXPIRED or ERROR. */
	status: z.enum(["TOKEN_EXPIRED", "ERROR"]),
});

// PM_ATTACHMENT_SYNC_FAILED payload — written by the GitLab REST push path
// (`packages/temporal/src/activities/pm-integration/gitlab-rest-story-sync.ts`)
// when one or more attachments never reached the PM tool (Fizzy #1745, AC-4).
// As with the repo-integration payload above, the write happens directly via
// the `@repo/database` helper `createPmAttachmentSyncFailedNotification` —
// which does not run this validator, since the activity cannot import it
// without a workspace cycle — but the schema is registered here so the
// validator stays total over `NotificationType`.
const pmAttachmentSyncFailedPayload = z.object({
	projectId: z.string(),
	storyId: z.string(),
	storyTitle: z.string(),
	/** Human label for the PM tool, e.g. "GitLab". */
	pmToolLabel: z.string(),
	/**
	 * The one-line summary from `summarizeAttachmentFailures` — count,
	 * filenames and the adapter's reason. Required: without it the inbox row
	 * says only that something failed, which is exactly what AC-10 exists to
	 * prevent.
	 */
	failureSummary: z.string(),
});

// SECURITY_SCAN_COMPLETED payload — written directly by the temporal scan
// pipeline's emit-scan-notification helper (which cannot import this @repo/api
// validator without a workspace cycle), but registered here so the validator
// stays total over NotificationType.
const securityScanCompletedPayload = z.object({
	scanId: z.string(),
	securityFindingCount: z.number().int().nonnegative(),
	accessibilityFindingCount: z.number().int().nonnegative(),
	failed: z.boolean(),
});

// PROJECT_SERVICE_ALERT_DIGEST payload — written directly by the weekly
// project service-alert digest helper in `@repo/database`
// (`project-service-alert-digest.ts`), fanned out Mondays to each project's
// OWNER / PROJECT_ADMIN members (AC-9). Category SYSTEM (always-on, not
// user-suppressible). Registered here so the validator stays total over
// `NotificationType`; the helper does not run this validator (it lives in
// @repo/database). `weekKey` is the ISO week-ending date and forms part of the
// per-(project, week, recipient) dedupe key.
const projectServiceAlertDigestPayload = z.object({
	projectId: z.string(),
	projectName: z.string(),
	weekKey: z.string().min(1),
	weekStart: z.string().min(1), // ISO 8601
	weekEnd: z.string().min(1), // ISO 8601
	totalAlerts: z.number().int().nonnegative(),
	syncFailureCount: z.number().int().nonnegative(),
	conflictCount: z.number().int().nonnegative(),
	link: z.string().min(1),
});

// STATUS_ANNOUNCEMENT payload — written directly by the sweeper in
// `@repo/database` (`status-announcement-notifications.ts`), fanned out to each
// organization's owners/admins for live MAJOR/CRITICAL platform announcements.
// Category SYSTEM (always-on, not user-suppressible). Registered here so the
// validator stays total over `NotificationType`; the helper does not run this
// validator (it lives in @repo/database).
//
// Deliberately NOT `incidentNotificationBase`: an announcement is human-authored
// customer-facing copy, not an incident record. It has no `incidentId` and no
// sev1/sev2/sev3 severity, and forcing it into that shape would make
// `incidentId` point at a StatusUpdate row that no incident lookup can resolve.
//
// The destination lives in the notification's own `link` COLUMN, stored
// context-relative (`system-health`) so it resolves against the recipient's own
// workspace base — `/app/{slug}/system-health` for an org row. It is not
// duplicated here.
const statusAnnouncementPayload = z.object({
	statusUpdateId: z.string().min(1),
	impact: z.enum(["MAJOR", "CRITICAL"]),
	lifecycle: z.string().min(1),
	startedAt: z.string().min(1), // ISO 8601 timestamp
});

// REPORT_COMPLETED / REPORT_FAILED payload — written directly by the @repo/database
// emitReportExecutionNotification helper (which cannot import this @repo/api validator
// without a workspace cycle), but registered here so the validator stays total over
// NotificationType. Fizzy #1692.
const reportExecutionPayload = z.object({
	executionId: z.string(),
	instanceId: z.string(),
	instanceName: z.string(),
	status: z.enum(["COMPLETED", "FAILED"]),
	// No raw error field — diagnostics stay out of the UI-reachable payload; the
	// humanized details live in Execution History.
});

// SECURITY_TICKETS_GENERATED payload — written directly by the temporal
// security-finding-grouping pipeline's emit-grouping-notification helper (which
// cannot import this @repo/api validator without a workspace cycle), but
// registered here so the validator stays total over NotificationType.
const securityTicketsGeneratedPayload = z.object({
	groupingId: z.string(),
	projectId: z.string(),
	projectName: z.string(),
	createdCount: z.number().int().nonnegative(),
	updatedCount: z.number().int().nonnegative(),
	skippedCount: z.number().int().nonnegative(),
});

// DOCUMENT_UPDATED / FEATURE_UPDATED payload — written by
// `fanOut.subscriptionUpdate` when a subscribed document or feature changes.
// Category SUBSCRIPTION (always-on; suppression is per-item unsubscribe, not a
// global toggle). `changeKind` lets the inbox renderer distinguish a content
// edit from a status/stage move; `subjectId` + `subjectType` + `projectId`
// drive the deep-link. The human-readable actor + item title live in the
// notification's `title`/`link` columns, so they are intentionally absent here.
const subscriptionUpdateBase = z.object({
	subjectType: z.enum(["DOCUMENT", "FEATURE"]),
	subjectId: z.string(),
	projectId: z.string(),
	actorUserId: z.string(),
	changeKind: z.enum(["content", "status", "stage"]),
});

// STORY_SHARED payload — written by `fanOut.storyShared` when a user tags one or
// more project members from the feature editor's Notify action. Category MENTION
// (reused; the inbox renders a share glyph via a per-type icon override). The
// optional `message` is the author's free-text note, surfaced as the row snippet
// when present. The human-readable actor name + feature title live in the
// notification's `title`/`link` columns, so they are intentionally absent here.
const storySharedBase = z.object({
	storyId: z.string(),
	projectId: z.string(),
	sharedByUserId: z.string(),
	message: z.string().max(280).optional(),
});

// NEWSLETTER_APPROVAL_PENDING payload — written directly by the @repo/database
// emitNewsletterApprovalPendingNotification helper (which cannot import this
// @repo/api validator without a workspace cycle) when a newsletter send is held
// at PENDING_APPROVAL for reviewer sign-off. Fanned
// out to project OWNER/PROJECT_ADMIN members + the project creator/owner.
// Registered here so the validator stays total over NotificationType. The
// human-readable project name + review deep-link live in the notification's
// `title`/`link` columns, so they are intentionally absent here.
const newsletterApprovalPendingPayload = z.object({
	sendId: z.string(),
	projectId: z.string(),
});

// TEST_CASES_DRAFTED payload — written directly by the temporal drafting
// workflow's finalize activity (which cannot import this @repo/api validator
// without a workspace cycle), but registered here so the validator stays total
// over NotificationType. `jobId` is the batch's identity: it resolves exactly
// the cases the run created, which is what the notification's deep link opens.
const testCasesDraftedPayload = z.object({
	jobId: z.string(),
	createdCount: z.number().int().nonnegative(),
	totalFeatures: z.number().int().nonnegative(),
});

// PUBLISHING_TOPICS_READY payload — written directly by the Temporal
// `notifyPublishingTopicsReady` activity (Fizzy #1850, 1C-2b) when a publishing
// suggestion cycle reaches READY, one row per eligible contributor. The
// activity bypasses this validator entirely, as every Temporal-driven writer
// in this repo does; this registration exists to keep the map total over
// NotificationType and to give the writer's payload-shape test something to
// assert against.
const publishingTopicsReadyPayload = z.object({
	projectId: z.string(),
	cycleId: z.string(),
	topicCount: z.number().int().positive(),
});

/**
 * A tier's default prompt for an action changed (Fizzy #2068 FR6).
 *
 * `informationalOnly` records that the reader holds their own override, so
 * nothing moved for them — the row is a heads-up, not a change to act on. The
 * renderer reads it rather than re-deriving the answer from the title.
 */
const promptDefaultUpdatedPayload = z.object({
	promptId: z.string(),
	promptName: z.string(),
	scope: z.enum(["SYSTEM", "ORG"]),
	targetKey: z.string(),
	documentType: z.string(),
	storyKind: z.enum(["FEATURE", "BUG"]).nullable(),
	informationalOnly: z.boolean(),
});

/**
 * A prompt was proposed as a shared default and is waiting for review (FR16).
 *
 * `summaryDegraded` travels with the summary so the queue can say whether it is
 * a model's reading of both prompts or a plain character comparison — the two
 * read identically otherwise, and a reviewer weighs them very differently.
 */
const promptNominationPendingPayload = z.object({
	nominationId: z.string(),
	promptId: z.string(),
	promptName: z.string(),
	targetScope: z.enum(["SYSTEM", "ORG"]),
	actionCount: z.number(),
	summaryDegraded: z.boolean(),
});

// DECISION_OWNER_ASSIGNED / DECISION_OWNER_UPDATED payload — written by the
// architecture-decision create/update path when a decision is saved with, or
// edited under, an accountable owner. The human-readable actor name and
// decision title live in the notification's `title`/`snippet` columns, so they
// are intentionally absent here.
const decisionOwnerPayload = z.object({
	decisionId: z.string(),
	projectId: z.string(),
	identifier: z.string(),
	actorUserId: z.string(),
});

const NotificationPayloadByType = {
	[NotificationType.STORY_MENTION]: mentionLikeBase,
	[NotificationType.TASK_MENTION]: mentionLikeBase,
	[NotificationType.COMMENT_MENTION]: mentionLikeBase,
	[NotificationType.STORY_COMMENT_REPLY]: replyLikeBase,
	[NotificationType.TASK_COMMENT_REPLY]: replyLikeBase,
	[NotificationType.STORY_ASSIGNED]: assignmentBase,
	[NotificationType.DOCUMENT_MENTION]: documentMentionBase,
	[NotificationType.STORY_STATUS_CHANGED]: storyStatusChangedBase,
	[NotificationType.PM_SYNC_CONFLICT]: pmSyncConflictBase,
	[NotificationType.AGENT_REPLY_READY]: z.object({
		commentId: z.string(),
		storyId: z.string().optional(),
		taskId: z.string().optional(),
		projectId: z.string(),
		snippet: z.string().max(280).optional(),
	}),
	[NotificationType.AI_USAGE_LIMIT_WARNING]: aiUsageLimitThresholdPayload,
	[NotificationType.AI_USAGE_LIMIT_REACHED]: aiUsageLimitThresholdPayload,
	[NotificationType.INTEGRATION_INCIDENT]: incidentNotificationBase,
	[NotificationType.SYSTEM_INCIDENT]: incidentNotificationBase,
	[NotificationType.CONTEXT_INDEXING_STARTED]: contextIndexingStartedPayload,
	[NotificationType.CONTEXT_INDEXING_COMPLETED]:
		contextIndexingCompletedPayload,
	[NotificationType.REPO_INTEGRATION_TOKEN_EXPIRED]:
		repoIntegrationTokenExpiredPayload,
	[NotificationType.SECURITY_SCAN_COMPLETED]: securityScanCompletedPayload,
	[NotificationType.PROJECT_SERVICE_ALERT_DIGEST]:
		projectServiceAlertDigestPayload,
	[NotificationType.REPORT_COMPLETED]: reportExecutionPayload,
	[NotificationType.REPORT_FAILED]: reportExecutionPayload,
	[NotificationType.SECURITY_TICKETS_GENERATED]:
		securityTicketsGeneratedPayload,
	[NotificationType.DOCUMENT_UPDATED]: subscriptionUpdateBase,
	[NotificationType.FEATURE_UPDATED]: subscriptionUpdateBase,
	[NotificationType.STORY_SHARED]: storySharedBase,
	[NotificationType.NEWSLETTER_APPROVAL_PENDING]:
		newsletterApprovalPendingPayload,
	[NotificationType.STATUS_ANNOUNCEMENT]: statusAnnouncementPayload,
	[NotificationType.TEST_CASES_DRAFTED]: testCasesDraftedPayload,
	[NotificationType.PUBLISHING_TOPICS_READY]: publishingTopicsReadyPayload,
	[NotificationType.PROMPT_DEFAULT_UPDATED]: promptDefaultUpdatedPayload,
	[NotificationType.PROMPT_NOMINATION_PENDING]:
		promptNominationPendingPayload,
	[NotificationType.PM_ATTACHMENT_SYNC_FAILED]: pmAttachmentSyncFailedPayload,
	[NotificationType.DECISION_OWNER_ASSIGNED]: decisionOwnerPayload,
	[NotificationType.DECISION_OWNER_UPDATED]: decisionOwnerPayload,
} as const;

export function validatePayload(
	type: NotificationType,
	payload: unknown,
): Record<string, unknown> {
	const schema = NotificationPayloadByType[type];
	return schema.parse(payload) as Record<string, unknown>;
}
