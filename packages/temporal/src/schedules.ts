/**
 * Temporal Schedule Registration
 *
 * Registers system schedules during worker startup.
 * Schedules are idempotent — if they already exist, registration is skipped.
 */

import * as tls from "node:tls";
import {
	Connection,
	ScheduleAlreadyRunning,
	ScheduleClient,
} from "@temporalio/client";
import { getTemporalConfig } from "./client";
import { ensureAiUsageSchedules } from "./scripts/ensure-ai-usage-schedules";
import { ensureContextSummarizationSchedules } from "./scripts/ensure-context-summarization-schedules";
import { ensureMonitoringSchedules } from "./scripts/ensure-monitoring-schedules";

const PROJECT_DELETE_SCHEDULE_ID = "project-delete-cleanup";
const PROJECT_DELETE_WORKFLOW_NAME = "projectDeleteCleanupWorkflow";
const TASK_QUEUE = "fabric-worker";

// Daily at midnight US Eastern (Temporal handles DST via timezone)
const PROJECT_DELETE_CRON_SCHEDULE = "0 0 * * *";
const TIMEZONE = "America/New_York";

const AGENT_HEALTH_SCHEDULE_ID = "agent-health-monitor";
const AGENT_HEALTH_WORKFLOW_NAME = "agentHealthMonitorWorkflow";
// Every 2 minutes
const AGENT_HEALTH_CRON_SCHEDULE = "*/2 * * * *";

const REPO_HEALTH_SCHEDULE_ID = "repo-integration-health-check";
const REPO_HEALTH_WORKFLOW_NAME = "repoIntegrationHealthCheckWorkflow";
// Every 30 minutes
const REPO_HEALTH_CRON_SCHEDULE = "*/30 * * * *";

const AUTHORITY_CLEANUP_SCHEDULE_ID = "authority-cleanup";
const AUTHORITY_CLEANUP_WORKFLOW_NAME = "authorityCleanupWorkflow";
// Every minute — authority sessions have short TTLs so timely expiration matters
const AUTHORITY_CLEANUP_CRON_SCHEDULE = "* * * * *";

const PM_STATE_POLL_SCHEDULE_ID = "ado-state-poll-system";
const PM_STATE_POLL_WORKFLOW_NAME = "adoStatePollWorkflow";
// Every hour
const PM_STATE_POLL_CRON_SCHEDULE = "0 * * * *";

const PIPELINE_RESULTS_SYNC_SCHEDULE_ID = "qa-pipeline-results-sync";
const PIPELINE_RESULTS_SYNC_WORKFLOW_NAME = "syncAllPipelineResultsWorkflow";
// Every 15 minutes. Chosen as the smallest interval that still feels "automatic"
// to someone watching a CI run finish, without turning provider rate limits into
// the binding constraint: the sweep costs one listing call per connected repo
// per tick, and most ticks find nothing new.
const PIPELINE_RESULTS_SYNC_CRON_SCHEDULE = "*/15 * * * *";

const NEWSLETTER_DISPATCH_SCHEDULE_ID = "newsletter-dispatcher";
const NEWSLETTER_DISPATCH_WORKFLOW_NAME = "newsletterDispatcherWorkflow";
// Every hour (UTC); the dispatcher honors each project's sendHourUtc.
const NEWSLETTER_DISPATCH_CRON_SCHEDULE = "0 * * * *";

const PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID =
	"publishing-suggestion-dispatcher";
const PUBLISHING_SUGGESTION_DISPATCH_WORKFLOW_NAME =
	"publishingSuggestionDispatcherWorkflow";
// Daily at 06:00 UTC — the daily content sweep (Publishing Suite 1A §6.1). The
// findEligibleProjects activity owns "now" + the master flag; each project's
// dispatch is idempotent (active-GENERATING partial index).
const PUBLISHING_SUGGESTION_DISPATCH_CRON_SCHEDULE = "0 6 * * *";

const DOCUMENT_REFRESH_SCHEDULE_ID = "document-refresh-dispatcher";
const DOCUMENT_REFRESH_WORKFLOW_NAME = "documentRefreshDispatcherWorkflow";
// Every hour (UTC). The find-due activity owns "now" and honors each document's
// cadence; the hourly tick is also the collision-retry granularity — a document
// skipped because someone was editing it is simply re-evaluated an hour later.
const DOCUMENT_REFRESH_CRON_SCHEDULE = "0 * * * *";
// Its OWN queue, not "project-documents". The sweep is unattended and can go
// wide; that queue serves a human waiting on "Update using context".
const DOCUMENT_REFRESH_TASK_QUEUE = "document-refresh";

export const PUBLISHING_RECONCILE_SCHEDULE_ID =
	"publishing-notification-reconcile";
// Exported, unlike its siblings, because the registration test asserts the
// COMPLETE create() payload and a literal it also owns would prove nothing.
export const PUBLISHING_RECONCILE_WORKFLOW_NAME =
	"publishingNotificationReconcileWorkflow";
// worker.ts IMPORTS this to create its poller, so the schedule's target and the
// worker's queue are one string rather than two that agree today.
export const PUBLISHING_RECONCILE_TASK_QUEUE = "publishing-reconcile";

// THESE TWO NUMBERS ARE ONE BUDGET AND MUST BE CHANGED TOGETHER.
//
// The schedule is overlap: "SKIP", which is safe ONLY because a run is bounded
// by an execution timeout STRICTLY SHORTER than the interval between triggers.
// Raise the timeout above the interval — or shorten the cron without shortening
// the timeout — and a wedged run silently swallows every subsequent trigger,
// which is the wedge this workflow exists to be immune to. There is an
// executable assertion on the relationship in
// __tests__/publishing-reconcile/schedule-and-queue.test.ts; it derives the
// interval from the cron rather than restating it, so changing one alone is red.
//
// Hourly, not daily. The design's own §9.9 parameter list states the cadence as
// a configuration value; the "same daily tick" phrasing elsewhere is inherited
// from a draft in which the sweep rode the dispatcher.
export const PUBLISHING_RECONCILE_CRON_SCHEDULE = "0 * * * *";
export const PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS = 45 * 60_000;

// One tick, not a backlog. A worker that was down for six hours should resume
// reconciling NOW, not replay six missed triggers whose work the current tick
// would do anyway — every transition is idempotent, so a replayed tick is pure
// waste. One hour is the same value the two sibling hourly sweeps in this file
// use.
export const PUBLISHING_RECONCILE_CATCHUP_WINDOW = "1 hour";

const SCHEDULED_REPORT_SCHEDULE_ID = "scheduled-report-generation";
const SCHEDULED_REPORT_WORKFLOW_NAME = "scheduledReportDispatcherWorkflow";
// Every 15 minutes (UTC); the dispatcher honors each instance's nextRunAt.
const SCHEDULED_REPORT_CRON_SCHEDULE = "*/15 * * * *";

const URL_SOURCE_RECONCILE_SCHEDULE_ID = "url-source-schedule-reconcile";
const URL_SOURCE_RECONCILE_WORKFLOW_NAME =
	"reconcileUrlSourceSchedulesWorkflow";
// Every Sunday at 00:30 UTC — runs 30 minutes after the per-context
// weekly schedules' fire window so we don't race them. Spec §14.5.
const URL_SOURCE_RECONCILE_CRON_SCHEDULE = "30 0 * * 0";
const URL_SOURCE_RECONCILE_TASK_QUEUE = "project-documents";

const DOC_EMBED_SWEEP_SCHEDULE_ID = "project-document-embedding-sweep";
const DOC_EMBED_SWEEP_WORKFLOW_NAME = "projectDocumentEmbeddingSweepWorkflow";
// Every 5 minutes — reaps stale Qdrant chunks left by superseded embed
// runs (e.g. activities that kept running after TERMINATE_EXISTING).
// 5 min bounds the worst-case retrieval staleness window to a much
// tighter value than the original 15 min, at the cost of running the
// sweep 3× more often. The activity is cheap (one paginated DB query +
// one filter-based Qdrant delete per document) so the extra load is
// negligible. Runs in "project-documents" task queue alongside the
// embed workflow.
const DOC_EMBED_SWEEP_CRON_SCHEDULE = "*/5 * * * *";
const DOC_EMBED_SWEEP_TASK_QUEUE = "project-documents";

const AUDIT_LOG_RETENTION_SCHEDULE_ID = "audit-log-retention";
const AUDIT_LOG_RETENTION_WORKFLOW_NAME = "auditLogRetentionWorkflow";
// Daily at 03:00 UTC — purges audit_log rows older than
// FABRIC_AUDIT_LOG_RETENTION_DAYS. Off-hours so the batched DELETE
// doesn't compete with peak-hour writes. Registered only when
// FABRIC_AUDIT_LOG_RETENTION_ENABLED === "true" (opt-in by design so a
// self-hosted operator never silently loses audit history).
const AUDIT_LOG_RETENTION_CRON_SCHEDULE = "0 3 * * *";

const REQUEST_SPAN_RETENTION_SCHEDULE_ID = "request-span-retention";
const REQUEST_SPAN_RETENTION_WORKFLOW_NAME = "requestSpanRetentionWorkflow";
// Daily at 04:45 UTC — purges request_span rows older than
// FABRIC_REQUEST_SPAN_RETENTION_DAYS (default 7). Offset off the 03:00–04:15
// retention cluster so the batched DELETE doesn't contend on the fabric-worker
// queue. Registered BY DEFAULT (request spans are ephemeral failure-only debug
// data with a documented TTL); FABRIC_REQUEST_SPAN_RETENTION_ENABLED=false opts out.
const REQUEST_SPAN_RETENTION_CRON_SCHEDULE = "45 4 * * *";

const CONVERSATION_RETENTION_SCHEDULE_ID = "conversation-retention";
const CONVERSATION_RETENTION_WORKFLOW_NAME = "conversationRetentionWorkflow";
// Daily at 05:15 UTC — purges ai_chat + agent_conversation rows untouched for
// longer than FABRIC_CONVERSATION_RETENTION_DAYS. Sits after the 03:00–04:45
// retention cluster so the batched DELETEs (two tables, cascading) don't
// contend on the fabric-worker queue.
//
// OPT-IN, unlike request-span retention: this destroys conversation and agent
// history, and its retention period is a business commitment rather than an
// engineering default. Requires BOTH
// FABRIC_CONVERSATION_RETENTION_ENABLED=true (registers the schedule) and a
// positive FABRIC_CONVERSATION_RETENTION_DAYS (the activity no-ops without it).
const CONVERSATION_RETENTION_CRON_SCHEDULE = "15 5 * * *";

const AUDIT_LOG_SEAL_SCHEDULE_ID = "audit-log-seal";
const AUDIT_LOG_SEAL_WORKFLOW_NAME = "auditLogSealWorkflow";
// Hourly at :15 — advances the audit_log tamper-evidence seal chain. Runs at
// :15 to steer clear of the top-of-hour schedule crowd. Registered only when
// FABRIC_AUDIT_LOG_SEALING_ENABLED === "true" (opt-in: sealing is inert until an
// operator turns it on and, for SOC 2, sets a dedicated AUDIT_LOG_SIGNING_KEY).
const AUDIT_LOG_SEAL_CRON_SCHEDULE = "15 * * * *";

const PM_SYNC_LOG_RETENTION_SCHEDULE_ID = "pm-sync-log-retention";
const PM_SYNC_LOG_RETENTION_WORKFLOW_NAME = "pmSyncLogRetentionWorkflow";
// Daily at 04:00 UTC — purges pm_sync_log rows older than
// FABRIC_PM_SYNC_LOG_RETENTION_DAYS. Off-hours so the batched DELETE
// doesn't compete with peak-hour writes, and one hour after the
// audit-log retention (03:00) so the two batched purges on the same
// `fabric-worker` queue don't overlap. Registered only when
// FABRIC_PM_SYNC_LOG_RETENTION_ENABLED === "true" (opt-in by design).
const PM_SYNC_LOG_RETENTION_CRON_SCHEDULE = "0 4 * * *";

const WORKFLOW_BUILDER_RECONCILE_SCHEDULE_ID =
	"workflow-builder-schedule-reconcile";
const WORKFLOW_BUILDER_RECONCILE_WORKFLOW_NAME =
	"reconcileWorkflowBuilderSchedulesWorkflow";
// Weekly, Sunday 01:15 UTC. Schedule sync is best-effort — it never fails a
// publish — so drift accumulates only when Temporal was unreachable at exactly
// the wrong moment. Weekly is ample, and 01:15 keeps it clear of both the
// per-workflow schedules (which mostly fire on the hour) and the 00:30
// url-source reconciler.
const WORKFLOW_BUILDER_RECONCILE_CRON_SCHEDULE = "15 1 * * 0";
// MUST match the worker registration in worker.ts.
const WORKFLOW_BUILDER_RECONCILE_TASK_QUEUE = "workflow-builder";

const DRAFT_PROJECT_CLEANUP_SCHEDULE_ID = "draft-project-cleanup-daily";
const DRAFT_PROJECT_CLEANUP_WORKFLOW_NAME = "draftProjectCleanupWorkflow";
// Daily at 03:00 UTC — sweeps abandoned wizard DRAFTs (>14 days old) and
// cancels their in-flight URL crawls before soft-deleting. Spec §6.3.
// Off-hours so the batch doesn't compete with peak-hour wizard activity;
// the existing audit-log retention also runs at 03:00 but on the
// `fabric-worker` queue, so the two don't compete for a single worker.
const DRAFT_PROJECT_CLEANUP_CRON_SCHEDULE = "0 3 * * *";
const DRAFT_PROJECT_CLEANUP_TASK_QUEUE = "project-documents";

const WEAVE_WATCHDOG_SCHEDULE_ID = "weave-execution-watchdog";
const WEAVE_WATCHDOG_WORKFLOW_NAME = "weaveExecutionWatchdogWorkflow";
// Every 5 minutes — bounds the worst-case leak duration after a
// Weave/CodingRun workflow dies ungracefully (force-terminated, OOM,
// worker crash) and never gets its non-cancellable finally block to
// run. Runs on the default `fabric-worker` queue.
const WEAVE_WATCHDOG_CRON_SCHEDULE = "*/5 * * * *";

const DOCUMENT_GENERATION_WATCHDOG_SCHEDULE_ID = "document-generation-watchdog";
const DOCUMENT_GENERATION_WATCHDOG_WORKFLOW_NAME =
	"documentGenerationWatchdogWorkflow";
// Every 10 minutes — fails ProjectDocument rows left GENERATING by a dispatch
// whose workflow never started. Less frequent than the apply watchdog because
// its staleness ceiling is twice as long (30 minutes, so a slow legitimate run
// is never a candidate) and each tick asks Temporal about every candidate row.
// Runs on the default `fabric-worker` queue.
const DOCUMENT_GENERATION_WATCHDOG_CRON_SCHEDULE = "*/10 * * * *";

const BACKLOG_APPLY_WATCHDOG_SCHEDULE_ID = "backlog-apply-watchdog";
const BACKLOG_APPLY_WATCHDOG_WORKFLOW_NAME = "backlogApplyWatchdogWorkflow";
// Every 5 minutes — recovers PendingBacklogProposal rows stuck mid-apply
// (still PENDING with an apply dispatched longer than
// FABRIC_BACKLOG_APPLY_STALE_MINUTES, default 15) after the apply workflow
// died before its finalize step ran, or was scheduled but never executed.
// Runs on the default `fabric-worker` queue.
const BACKLOG_APPLY_WATCHDOG_CRON_SCHEDULE = "*/5 * * * *";

const BACKGROUND_JOB_RETENTION_SCHEDULE_ID = "background-job-retention";
const BACKGROUND_JOB_RETENTION_WORKFLOW_NAME = "backgroundJobRetentionWorkflow";
// Daily at 05:00 UTC — deletes Job Hub rows older than
// FABRIC_JOB_RETENTION_DAYS (default 7). Offset from the 03:00/04:00
// retention cluster so the batched DELETEs don't stack on one queue.
// Registered unconditionally, unlike the opt-in audit-log purge: job rows are
// ephemeral progress telemetry and the panel already hides anything past the
// window, so an unbounded table would be pure waste.
const BACKGROUND_JOB_RETENTION_CRON_SCHEDULE = "0 5 * * *";

const BACKGROUND_JOB_WATCHDOG_SCHEDULE_ID = "background-job-watchdog";
const BACKGROUND_JOB_WATCHDOG_WORKFLOW_NAME = "backgroundJobWatchdogWorkflow";
// Every 5 minutes — fails Job Hub rows whose heartbeat went stale past
// FABRIC_JOB_STALE_MINUTES (default 45). A worker that dies mid-run never
// writes the closing status, so without this the job shows "Running" forever
// and the nav badge never clears. Runs on the default `fabric-worker` queue.
//
// NOTE: the schedule's `note` is only written when the schedule is CREATED, so
// changing the default here does not update an already-registered schedule's
// description in the Temporal UI — that needs an explicit schedule update.
const BACKGROUND_JOB_WATCHDOG_CRON_SCHEDULE = "*/5 * * * *";

const ATTACHMENT_TEMP_ORPHAN_SWEEP_SCHEDULE_ID = "attachment-temp-orphan-sweep";
const ATTACHMENT_TEMP_ORPHAN_SWEEP_WORKFLOW_NAME =
	"attachmentTempOrphanSweepWorkflow";
// Daily at 03:15 UTC — reclaims abandoned story-attachments-tmp/ objects.
// Minute 15 offsets off the 03:00 UTC retention cluster (audit-log,
// draft-project).
const ATTACHMENT_TEMP_ORPHAN_SWEEP_CRON_SCHEDULE = "15 3 * * *";

const ATTACHMENT_FINAL_ORPHAN_SWEEP_SCHEDULE_ID =
	"attachment-final-orphan-sweep";
const ATTACHMENT_FINAL_ORPHAN_SWEEP_WORKFLOW_NAME =
	"attachmentFinalOrphanSweepWorkflow";
// Daily at 03:45 UTC — reclaims orphaned story-attachments/ final objects.
// Minute 45 offsets off the temp sweep (03:15 UTC) so the two prefix scans do
// not contend on the same bucket.
const ATTACHMENT_FINAL_ORPHAN_SWEEP_CRON_SCHEDULE = "45 3 * * *";

const ATTACHMENT_RETENTION_PURGE_SCHEDULE_ID = "attachment-retention-purge";
const ATTACHMENT_RETENTION_PURGE_WORKFLOW_NAME =
	"attachmentRetentionPurgeWorkflow";
// Daily at 04:15 UTC — purges expired soft-deleted attachments (rows + objects).
// Minute offsets off temp (03:15) and final (03:45) sweeps so the three
// attachment jobs don't contend.
const ATTACHMENT_RETENTION_PURGE_CRON_SCHEDULE = "15 4 * * *";

const QA_EVIDENCE_RETENTION_SCHEDULE_ID = "qa-evidence-retention";
const QA_EVIDENCE_RETENTION_WORKFLOW_NAME = "qaEvidenceRetentionWorkflow";
// Daily at 04:45 UTC — deletes QA run screenshots past their project's window.
// Half an hour after the attachment purge so the two object-store sweeps do not
// contend for the same connection pool.
const QA_EVIDENCE_RETENTION_CRON_SCHEDULE = "45 4 * * *";

/**
 * Register all system Temporal schedules.
 *
 * Uses its own Connection (not the worker's NativeConnection) because
 * ScheduleClient requires a @temporalio/client Connection.
 */
export async function registerSystemSchedules(): Promise<void> {
	const config = getTemporalConfig();

	const connectionOptions: Parameters<typeof Connection.connect>[0] = {
		address: config.address,
	};

	if (config.apiKey) {
		connectionOptions.apiKey = config.apiKey;
		const rootCerts = tls.rootCertificates.join("\n");
		connectionOptions.tls = {
			serverRootCACertificate: Buffer.from(rootCerts),
		};
		connectionOptions.metadata = {
			"temporal-namespace": config.namespace,
		};
	} else if (
		config.tls &&
		process.env.TEMPORAL_CLIENT_CERT &&
		process.env.TEMPORAL_CLIENT_KEY
	) {
		connectionOptions.tls = {
			clientCertPair: {
				crt: Buffer.from(process.env.TEMPORAL_CLIENT_CERT),
				key: Buffer.from(process.env.TEMPORAL_CLIENT_KEY),
			},
		};
		connectionOptions.metadata = {
			"temporal-namespace": config.namespace,
		};
	} else if (config.tls) {
		connectionOptions.tls = true;
	}

	const connection = await Connection.connect(connectionOptions);

	try {
		const scheduleClient = new ScheduleClient({
			connection,
			namespace: config.namespace,
		});

		await registerProjectDeleteCleanupSchedule(scheduleClient);
		await registerAgentHealthMonitorSchedule(scheduleClient);
		await registerRepoHealthCheckSchedule(scheduleClient);
		await registerAuthorityCleanupSchedule(scheduleClient);
		await registerDocumentEmbeddingSweepSchedule(scheduleClient);
		await registerDocumentRefreshSchedule(scheduleClient);
		await registerPmStatePollSchedule(scheduleClient);
		await registerPipelineResultsSyncSchedule(scheduleClient);
		await registerNewsletterDispatcherSchedule(scheduleClient);
		await registerPublishingSuggestionDispatcherSchedule(scheduleClient);
		await registerPublishingNotificationReconcileSchedule(scheduleClient);
		await registerScheduledReportSchedule(scheduleClient);
		await registerUrlSourceReconcileSchedule(scheduleClient);
		await registerAuditLogRetentionSchedule(scheduleClient);
		await registerAuditLogSealSchedule(scheduleClient);
		await registerRequestSpanRetentionSchedule(scheduleClient);
		await registerConversationRetentionSchedule(scheduleClient);
		await registerPmSyncLogRetentionSchedule(scheduleClient);
		await registerWorkflowBuilderReconcileSchedule(scheduleClient);
		await registerDraftProjectCleanupSchedule(scheduleClient);
		await registerWeaveExecutionWatchdogSchedule(scheduleClient);
		await registerBacklogApplyWatchdogSchedule(scheduleClient);
		await registerDocumentGenerationWatchdogSchedule(scheduleClient);
		await registerBackgroundJobRetentionSchedule(scheduleClient);
		await registerBackgroundJobWatchdogSchedule(scheduleClient);
		await registerAttachmentTempOrphanSweepSchedule(scheduleClient);
		await registerAttachmentFinalOrphanSweepSchedule(scheduleClient);
		await registerAttachmentRetentionPurgeSchedule(scheduleClient);
		await registerQaEvidenceRetentionSchedule(scheduleClient);
		await ensureContextSummarizationSchedules(scheduleClient);
		// Monitoring schedules
		await ensureMonitoringSchedules(scheduleClient);
		await ensureAiUsageSchedules(scheduleClient);
	} finally {
		await connection.close();
	}
}

/**
 * Register the project-delete-cleanup schedule.
 * Runs daily at midnight US Eastern to send deletion reminders and permanently delete expired projects.
 */
async function registerProjectDeleteCleanupSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: PROJECT_DELETE_SCHEDULE_ID,
			spec: {
				cronExpressions: [PROJECT_DELETE_CRON_SCHEDULE],
				timezone: TIMEZONE,
			},
			action: {
				type: "startWorkflow",
				workflowType: PROJECT_DELETE_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [{ batchSize: 100 }],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 hour",
			},
			state: {
				paused: false,
				note: "Cleans up soft-deleted projects after 7-day retention period. Sends reminder emails 24-48h before permanent deletion.",
			},
		});

		console.log(
			`[Worker] Schedule "${PROJECT_DELETE_SCHEDULE_ID}" registered (daily at midnight US Eastern)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${PROJECT_DELETE_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the agent-health-monitor schedule.
 * Runs every 2 minutes to probe registered agents' /health endpoints and update status.
 */
async function registerAgentHealthMonitorSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: AGENT_HEALTH_SCHEDULE_ID,
			spec: {
				cronExpressions: [AGENT_HEALTH_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: AGENT_HEALTH_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 minute",
			},
			state: {
				paused: false,
				note: "Probes registered agent /health endpoints every 2 minutes and marks stale agents.",
			},
		});

		console.log(
			`[Worker] Schedule "${AGENT_HEALTH_SCHEDULE_ID}" registered (every 2 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${AGENT_HEALTH_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the repo-integration-health-check schedule.
 * Runs every 30 minutes to validate project repository integration tokens,
 * detect expiry, and capture rate limit headers.
 *
 * v1 simplification: Single global schedule. If latency becomes an issue
 * with many integrations, the next step is per-org schedules.
 */
async function registerRepoHealthCheckSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: REPO_HEALTH_SCHEDULE_ID,
			spec: {
				cronExpressions: [REPO_HEALTH_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: REPO_HEALTH_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [{ intervalMinutes: 30 }],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "30 minutes",
			},
			state: {
				paused: false,
				note: "Validates project repository integration tokens every 30 minutes. Detects expiry, refreshes GitHub OAuth tokens, and logs rate limits.",
			},
		});

		console.log(
			`[Worker] Schedule "${REPO_HEALTH_SCHEDULE_ID}" registered (every 30 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${REPO_HEALTH_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the authority-cleanup schedule.
 * Runs every minute to expire authority sessions and grants that have
 * passed their TTL. This is critical for the Pipes-style authorization
 * model — stale grants must be cleaned up promptly so they can't be
 * reused after intended expiration.
 */
async function registerAuthorityCleanupSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: AUTHORITY_CLEANUP_SCHEDULE_ID,
			spec: {
				cronExpressions: [AUTHORITY_CLEANUP_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: AUTHORITY_CLEANUP_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "2 minutes",
			},
			state: {
				paused: false,
				note: "Expires authority sessions and grants that have passed their TTL. Part of Pipes-style runtime authorization.",
			},
		});

		console.log(
			`[Worker] Schedule "${AUTHORITY_CLEANUP_SCHEDULE_ID}" registered (every minute)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${AUTHORITY_CLEANUP_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the project-document-embedding-sweep schedule.
 *
 * Runs every 5 minutes to reap stale Qdrant chunks left by superseded
 * embed runs. Stale points have a `documentVersion` payload lower than
 * the source `ProjectDocument.version`; the sweep deletes them with a
 * filter-based delete scoped to each document.
 *
 * This is the belt-and-suspenders for the race where a stale
 * `embedProjectDocumentActivity` from a `TERMINATE_EXISTING`-d workflow
 * keeps upserting after the newer run has already landed. The
 * versioned point ids already prevent overwrites at the write path;
 * this sweep ensures the zombies eventually get cleaned up so retrieval
 * doesn't drag around orphans indefinitely. A 5 min cadence bounds the
 * worst-case retrieval staleness window to ~5 minutes.
 */
async function registerDocumentEmbeddingSweepSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: DOC_EMBED_SWEEP_SCHEDULE_ID,
			spec: {
				cronExpressions: [DOC_EMBED_SWEEP_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: DOC_EMBED_SWEEP_WORKFLOW_NAME,
				taskQueue: DOC_EMBED_SWEEP_TASK_QUEUE,
				args: [{ batchSize: 100, maxBatches: 50 }],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "5 minutes",
			},
			state: {
				paused: false,
				note: "Reaps stale Qdrant document-chunk points left by superseded embed runs (documentVersion < ProjectDocument.version).",
			},
		});

		console.log(
			`[Worker] Schedule "${DOC_EMBED_SWEEP_SCHEDULE_ID}" registered (every 5 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${DOC_EMBED_SWEEP_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the ado-state-poll-system schedule.
 * Runs every hour to poll PM tool work item states for all active projects
 * and reconcile terminal state changes into PendingPmStateChange entries.
 */
async function registerPmStatePollSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: PM_STATE_POLL_SCHEDULE_ID,
			spec: {
				cronExpressions: [PM_STATE_POLL_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: PM_STATE_POLL_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 hour",
			},
			state: {
				paused: false,
				note: "Polls PM tool work item states hourly for projects with adoStatePollActive=true. Creates PendingPmStateChange entries for terminal state transitions.",
			},
		});

		console.log(
			`[Worker] Schedule "${PM_STATE_POLL_SCHEDULE_ID}" registered (every hour)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${PM_STATE_POLL_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the QA pipeline-results sweep.
 *
 * Answers the question the QA card left open for a long time — on demand, on a
 * schedule, or by webhook? The ruling on 2026-07-26 was: **on a schedule, and
 * keep the manual button.** Before this, results arrived only when a human
 * pressed "Sync now", so a team that never pressed it had an empty QA tab rather
 * than a stale one.
 *
 * Webhooks were considered and not chosen: they would be near-instant, but they
 * need a public authenticated endpoint per provider plus per-customer setup —
 * and asking a customer to add a webhook brushes against the constraint that
 * Fabric does not touch their CI configuration.
 *
 * `overlap: SKIP` matters more here than in most schedules. A tick that is still
 * sweeping when the next fires must not stack; the per-project children are
 * ABANDONed and can outlive their parent, so overlapping sweeps would multiply
 * provider calls for no benefit.
 */
async function registerPipelineResultsSyncSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: PIPELINE_RESULTS_SYNC_SCHEDULE_ID,
			spec: {
				cronExpressions: [PIPELINE_RESULTS_SYNC_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: PIPELINE_RESULTS_SYNC_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				// One tick, not a backlog. Results are a current-state view; a
				// worker that was down for six hours should resume syncing now,
				// not replay 24 missed sweeps against provider rate limits.
				catchupWindow: "15 minutes",
			},
			state: {
				paused: false,
				note: "Every 15 minutes, pulls CI pipeline results for projects with a connected repository. Starts the same per-project workflow as the manual 'Sync now', under the same workflow id, so the two collapse rather than duplicate.",
			},
		});

		console.log(
			`[Worker] Schedule "${PIPELINE_RESULTS_SYNC_SCHEDULE_ID}" registered (every 15 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${PIPELINE_RESULTS_SYNC_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the Living Documents auto-refresh schedule.
 *
 * Registered unconditionally, even though the feature is behind
 * `FABRIC_FEATURE_LIVING_DOCS_REFRESH`: gating lives in the find-due activity,
 * not here, so flipping the flag on takes effect on the next tick with no
 * redeploy. With the flag off the sweep runs and returns an empty due-list.
 */
async function registerDocumentRefreshSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: DOCUMENT_REFRESH_SCHEDULE_ID,
			spec: { cronExpressions: [DOCUMENT_REFRESH_CRON_SCHEDULE] },
			action: {
				type: "startWorkflow",
				workflowType: DOCUMENT_REFRESH_WORKFLOW_NAME,
				taskQueue: DOCUMENT_REFRESH_TASK_QUEUE,
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				note: "Hourly sweep: refreshes living documents whose per-document cadence is due. Gated by FABRIC_FEATURE_LIVING_DOCS_REFRESH in the handler.",
			},
		});
		console.log(
			`[Worker] Schedule "${DOCUMENT_REFRESH_SCHEDULE_ID}" registered (every hour)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${DOCUMENT_REFRESH_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the Publishing Suite reconciliation schedule (1C-2d-2a).
 *
 * Registered unconditionally — and, unlike the dispatcher above, there is no
 * flag gate inside the activity either. That is deliberate rather than an
 * oversight: the ledger is empty while FABRIC_FEATURE_PUBLISHING_SUITE is off,
 * so an ungated sweep is a no-op in that state, while gating it would mean that
 * turning the master flag off during an incident silently walks every
 * outstanding obligation to EXPIRED — the exact loss this sweep exists to
 * prevent.
 *
 * `args: []` on purpose. The design asked for explicit batch arguments, but
 * every registration in THIS FILE is CREATE-ONLY: this one and its twenty-seven
 * siblings all call `scheduleClient.create()`, swallow `ScheduleAlreadyRunning`,
 * and never touch a schedule that already exists. A redeploy therefore does not
 * reach one, so a value in `args` is frozen at creation while a module constant
 * is picked up by every redeploy. Batch bounds live in @repo/database, not here.
 *
 * CREATE-ONLY IS THIS FILE'S CONVENTION, NOT AN SDK LIMITATION, and the
 * difference is the whole content of the operator procedure. The SDK exposes
 * in-place editing and this repo already uses it: `upsertWorkflowSchedule()` in
 * ./schedules/workflow-builder-schedule.ts catches the already-exists error and
 * calls `handle.update()` to replace the spec without losing the schedule — same
 * package, one directory down. ./schedules/url-source-schedule.ts names
 * `ScheduleHandle.update` too and declines it, for a reason it states. So the
 * twenty-eight registrations here are a deliberate convention, not the absence
 * of an API, and this one follows them rather than becoming the exception.
 *
 * The consequence is unchanged by that: as registered, changing the cron,
 * overlap, catchup window, note or execution timeout of an ALREADY-REGISTERED
 * schedule means deleting it first, and a delete discards the schedule's run
 * history and recent-actions list along with the values. See
 * docs/runbooks/publishing-reconcile-schedule.md — which must not repeat the
 * sentence this comment used to carry, that there is no `.update()` here. There
 * is none in THIS FILE; there is one in this package.
 *
 * EXPORTED, which none of the twenty-seven sibling registrations in this file
 * are. That is not consistency for its own sake being broken — it is the only
 * way this payload can be tested at all, and on a CREATE-ONLY schedule an
 * untested payload is the most expensive mistake available here: a wrong cron, a
 * missing overlap policy or an omitted execution timeout survives every redeploy
 * until an operator deletes the schedule by hand.
 */
export async function registerPublishingNotificationReconcileSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: PUBLISHING_RECONCILE_SCHEDULE_ID,
			spec: { cronExpressions: [PUBLISHING_RECONCILE_CRON_SCHEDULE] },
			action: {
				type: "startWorkflow",
				workflowType: PUBLISHING_RECONCILE_WORKFLOW_NAME,
				taskQueue: PUBLISHING_RECONCILE_TASK_QUEUE,
				args: [],
				// Strictly less than the hourly interval — see the constants.
				workflowExecutionTimeout:
					PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS,
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: PUBLISHING_RECONCILE_CATCHUP_WINDOW,
			},
			state: {
				paused: false,
				// AN OPERATOR-VISIBLE RUNTIME STRING, and therefore held to the
				// same standard as a log line: it must not advertise a route
				// that does not exist. It describes 2a AND NOTHING ELSE.
				//
				// An earlier draft named the three ledger transitions as
				// though this sweep performed them. It does not: the workflow
				// calls one activity, `abandonStalePublishingCycles`, and
				// `reclaimPublishingNotificationStates` does not exist in the
				// tree yet. A dead-leased SENDING row is producible today —
				// scripts/redrive-publishing-notification.ts makes them — so
				// an operator who read that note would wait for a reclaim that
				// never comes. The draft's hedge made it worse by blaming
				// 1C-2d-3, which is when the ROWS get a producer; the reason
				// nothing reclaims them is that the CODE ships in 1C-2d-2b.
				//
				// Stating the gap affirmatively rather than staying silent
				// about it is the point. This note is written once and FROZEN:
				// `create()` never runs again in an environment that already
				// has the schedule, so 2b's deploy does not rewrite this
				// string. Under-claiming ages into a note that omits a
				// transition the sweep by then performs, which costs an
				// unnecessary escalation. Over-claiming ages into a note that
				// suppresses a necessary one. Only one of those is survivable.
				note: "Hourly. Marks stale PENDING publishing cycles ABANDONED — that transition, and no other. It does NOT touch the notification ledger: expiring DEFERRED rows and reclaiming dead-leased SENDING rows ship in 1C-2d-2b, so until that deploys a stuck ledger row stays stuck and needs a human. No mail key required; no feature-flag gate by design. This note is frozen at registration and is not rewritten by a redeploy — the code is the authority on what runs.",
			},
		});
		console.log(
			`[Worker] Schedule "${PUBLISHING_RECONCILE_SCHEDULE_ID}" registered (every hour)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${PUBLISHING_RECONCILE_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the newsletter-dispatcher schedule.
 * Runs hourly to sweep projects whose external release-notes newsletter cadence
 * is due (the findDueNewsletterProjects activity owns "now" and honors each
 * project's sendHourUtc), dispatching a generate+send workflow per due project.
 */
async function registerNewsletterDispatcherSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: NEWSLETTER_DISPATCH_SCHEDULE_ID,
			spec: { cronExpressions: [NEWSLETTER_DISPATCH_CRON_SCHEDULE] },
			action: {
				type: "startWorkflow",
				workflowType: NEWSLETTER_DISPATCH_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				note: "Hourly sweep: dispatches external release-notes newsletters for projects whose cadence is due.",
			},
		});
		console.log(
			`[Worker] Schedule "${NEWSLETTER_DISPATCH_SCHEDULE_ID}" registered (every hour)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${NEWSLETTER_DISPATCH_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the publishing-suggestion-dispatcher schedule (Publishing Suite 1A,
 * Task 10). Runs daily at 06:00 UTC to sweep eligible projects and dispatch a
 * per-project suggestion cycle for those with new content.
 *
 * Registered unconditionally, even though the feature is behind
 * `FABRIC_FEATURE_PUBLISHING_SUITE`: gating lives in the findEligibleProjects
 * activity, not here, so flipping the flag on takes effect on the next tick with
 * no redeploy. With the flag off the sweep runs and returns an empty due-list.
 */
async function registerPublishingSuggestionDispatcherSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID,
			spec: {
				cronExpressions: [PUBLISHING_SUGGESTION_DISPATCH_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: PUBLISHING_SUGGESTION_DISPATCH_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				note: "Daily sweep (06:00 UTC): dispatches publishing-suggestion cycles for eligible projects with new content. Gated by FABRIC_FEATURE_PUBLISHING_SUITE in the find-eligible activity.",
			},
		});
		console.log(
			`[Worker] Schedule "${PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID}" registered (daily at 06:00 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${PUBLISHING_SUGGESTION_DISPATCH_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the scheduled-report-generation schedule.
 * Runs every 15 minutes to fire report instances whose nextRunAt is due — the
 * dispatcher reconciles/backfills, finds due instances, and starts
 * templateInstanceExecutionWorkflow for each (advancing nextRunAt idempotently).
 */
async function registerScheduledReportSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: SCHEDULED_REPORT_SCHEDULE_ID,
			spec: { cronExpressions: [SCHEDULED_REPORT_CRON_SCHEDULE] },
			action: {
				type: "startWorkflow",
				workflowType: SCHEDULED_REPORT_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				note: "Every 15 min: fires due scheduled report instances.",
			},
		});
		console.log(
			`[Worker] Schedule "${SCHEDULED_REPORT_SCHEDULE_ID}" registered (every 15 min)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${SCHEDULED_REPORT_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the URL Source Schedules reconciliation schedule.
 *
 * Runs weekly to delete orphaned `url-source-schedule-*` Temporal Schedules:
 *   - Context row no longer exists.
 *   - Context row's `urlRefreshMode` is no longer scheduled (ONCE/LIVE).
 *   - Context row's `urlScheduleId` doesn't match the schedule's id.
 *
 * Guard against schedule drift from delete-context-hook failures and from
 * direct DB writes that bypass `update-url-source`.
 */
async function registerUrlSourceReconcileSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: URL_SOURCE_RECONCILE_SCHEDULE_ID,
			spec: {
				cronExpressions: [URL_SOURCE_RECONCILE_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: URL_SOURCE_RECONCILE_WORKFLOW_NAME,
				taskQueue: URL_SOURCE_RECONCILE_TASK_QUEUE,
				args: [{ dryRun: false }],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 day",
			},
			state: {
				paused: false,
				note: "Weekly sweep of orphaned per-context URL-source Temporal Schedules. See spec §14.5.",
			},
		});

		console.log(
			`[Worker] Schedule "${URL_SOURCE_RECONCILE_SCHEDULE_ID}" registered (weekly, Sundays 00:30 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${URL_SOURCE_RECONCILE_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the audit-log-retention schedule.
 *
 * Opt-in: only registered when `FABRIC_AUDIT_LOG_RETENTION_ENABLED === "true"`.
 * Default is OFF so a self-hosted operator does not silently lose audit
 * history; Fabric Cloud sets the flag to true and `FABRIC_AUDIT_LOG_RETENTION_DAYS=365`.
 *
 * Runs daily at 03:00 UTC. Idempotent registration — the stable
 * `AUDIT_LOG_RETENTION_SCHEDULE_ID` ensures restarts don't create
 * duplicates (the `ScheduleAlreadyRunning` catch branch absorbs the
 * collision).
 *
 * See: docs/audit-log/README.md §9.4
 */
async function registerAuditLogRetentionSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const enabled = process.env.FABRIC_AUDIT_LOG_RETENTION_ENABLED === "true";
	if (!enabled) {
		console.log(
			`[Worker] Schedule "${AUDIT_LOG_RETENTION_SCHEDULE_ID}" NOT registered (FABRIC_AUDIT_LOG_RETENTION_ENABLED is not "true"). Set the env var to opt in.`,
		);
		return;
	}

	try {
		await scheduleClient.create({
			scheduleId: AUDIT_LOG_RETENTION_SCHEDULE_ID,
			spec: {
				cronExpressions: [AUDIT_LOG_RETENTION_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: AUDIT_LOG_RETENTION_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				// Don't overlap: a slow purge run shouldn't be paralleled
				// by a fresh trigger 24h later.
				overlap: "SKIP",
				catchupWindow: "12 hours",
			},
			state: {
				paused: false,
				note: "Purges audit_log rows older than FABRIC_AUDIT_LOG_RETENTION_DAYS in 5k-row batches with a 1k-batch safety cap. Self-emits one audit.retention.purged row per run.",
			},
		});

		console.log(
			`[Worker] Schedule "${AUDIT_LOG_RETENTION_SCHEDULE_ID}" registered (daily at 03:00 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${AUDIT_LOG_RETENTION_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the audit-log-seal schedule.
 *
 * Opt-in: only registered when `FABRIC_AUDIT_LOG_SEALING_ENABLED === "true"`.
 * Default is OFF so upgrading operators do not silently gain a new background
 * workflow; a SOC 2 self-hoster turns it on and sets a dedicated
 * `AUDIT_LOG_SIGNING_KEY` (it otherwise falls back to a key derived from
 * `BETTER_AUTH_SECRET`).
 *
 * Runs hourly at :15. Idempotent registration — the stable
 * `AUDIT_LOG_SEAL_SCHEDULE_ID` ensures restarts don't create duplicates (the
 * `ScheduleAlreadyRunning` catch branch absorbs the collision).
 *
 * See: docs/audit-log/README.md §10
 */
async function registerAuditLogSealSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const enabled = process.env.FABRIC_AUDIT_LOG_SEALING_ENABLED === "true";
	if (!enabled) {
		console.log(
			`[Worker] Schedule "${AUDIT_LOG_SEAL_SCHEDULE_ID}" NOT registered (FABRIC_AUDIT_LOG_SEALING_ENABLED is not "true"). Set the env var to opt in.`,
		);
		return;
	}

	try {
		await scheduleClient.create({
			scheduleId: AUDIT_LOG_SEAL_SCHEDULE_ID,
			spec: {
				cronExpressions: [AUDIT_LOG_SEAL_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: AUDIT_LOG_SEAL_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				// Don't overlap: the genesis run can stream all history; a fresh
				// trigger must not parallel an in-progress seal (the sequence
				// unique constraint would reject it anyway).
				overlap: "SKIP",
				catchupWindow: "2 hours",
			},
			state: {
				paused: false,
				note: "Advances the audit_log tamper-evidence seal chain hourly: one chained, HMAC-signed seal over the immutable content of each window. Verify with `pnpm --filter @repo/database verify:audit-seals`.",
			},
		});

		console.log(
			`[Worker] Schedule "${AUDIT_LOG_SEAL_SCHEDULE_ID}" registered (hourly at :15)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${AUDIT_LOG_SEAL_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the request-span-retention schedule.
 *
 * Registered BY DEFAULT — request spans are ephemeral debug data (persisted
 * only on request failure) with a documented 7-day TTL, so purging them is the
 * expected steady state (SOC 2 C1.2). Set
 * `FABRIC_REQUEST_SPAN_RETENTION_ENABLED=false` to opt out. Runs daily at 04:45
 * UTC. Idempotent via the stable schedule id.
 */
/**
 * Register the daily conversation / agent-history retention purge.
 *
 * OPT-IN (mirrors audit-log retention, not request-span retention): this
 * destroys conversation and agent history, and C1.2's "agreed retention
 * schedule" is a business commitment. Registering by default with an
 * engineering-chosen number would start deleting customer data on a schedule
 * nobody agreed to. The activity has a second, independent gate
 * (FABRIC_CONVERSATION_RETENTION_DAYS), so even a registered schedule no-ops
 * until a period is chosen.
 */
async function registerConversationRetentionSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const enabled =
		process.env.FABRIC_CONVERSATION_RETENTION_ENABLED === "true";
	if (!enabled) {
		console.log(
			`[Worker] Schedule "${CONVERSATION_RETENTION_SCHEDULE_ID}" NOT registered (FABRIC_CONVERSATION_RETENTION_ENABLED is not "true"). Set the env var to opt in.`,
		);
		return;
	}

	try {
		await scheduleClient.create({
			scheduleId: CONVERSATION_RETENTION_SCHEDULE_ID,
			spec: {
				cronExpressions: [CONVERSATION_RETENTION_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: CONVERSATION_RETENTION_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				// Don't overlap: a slow purge run shouldn't be paralleled by a
				// fresh trigger 24h later.
				overlap: "SKIP",
				catchupWindow: "12 hours",
			},
			state: {
				paused: false,
				note: "Purges ai_chat + agent_conversation rows whose updatedAt is older than FABRIC_CONVERSATION_RETENTION_DAYS, in 5k-row batches with a 1k-batch safety cap per table. Never purges pinned rows. No-ops unless the retention period is set.",
			},
		});

		console.log(
			`[Worker] Schedule "${CONVERSATION_RETENTION_SCHEDULE_ID}" registered (daily at 05:15 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${CONVERSATION_RETENTION_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

async function registerRequestSpanRetentionSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	if (process.env.FABRIC_REQUEST_SPAN_RETENTION_ENABLED === "false") {
		console.log(
			`[Worker] Schedule "${REQUEST_SPAN_RETENTION_SCHEDULE_ID}" NOT registered (FABRIC_REQUEST_SPAN_RETENTION_ENABLED === "false").`,
		);
		return;
	}

	try {
		await scheduleClient.create({
			scheduleId: REQUEST_SPAN_RETENTION_SCHEDULE_ID,
			spec: {
				cronExpressions: [REQUEST_SPAN_RETENTION_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: REQUEST_SPAN_RETENTION_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "12 hours",
			},
			state: {
				paused: false,
				note: "Purges request_span rows older than FABRIC_REQUEST_SPAN_RETENTION_DAYS (default 7) in 5k-row batches with a 1k-batch safety cap.",
			},
		});

		console.log(
			`[Worker] Schedule "${REQUEST_SPAN_RETENTION_SCHEDULE_ID}" registered (daily at 04:45 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${REQUEST_SPAN_RETENTION_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the attachment-temp-orphan-sweep schedule.
 *
 * Always registered (feature is GA). Idempotent via the stable schedule id.
 */
async function registerAttachmentTempOrphanSweepSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: ATTACHMENT_TEMP_ORPHAN_SWEEP_SCHEDULE_ID,
			spec: {
				cronExpressions: [ATTACHMENT_TEMP_ORPHAN_SWEEP_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: ATTACHMENT_TEMP_ORPHAN_SWEEP_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 hour",
			},
			state: {
				paused: false,
				note: "Reclaims abandoned story-attachments-tmp/ objects older than FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS (default 24) + 1h margin. Skips temps whose final-key row exists but final object is missing (recovery bytes).",
			},
		});

		console.log(
			`[Worker] Schedule "${ATTACHMENT_TEMP_ORPHAN_SWEEP_SCHEDULE_ID}" registered (daily at 03:15 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${ATTACHMENT_TEMP_ORPHAN_SWEEP_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the attachment-final-orphan-sweep schedule.
 *
 * Always registered (feature is GA). Idempotent via the stable schedule id.
 */
async function registerAttachmentFinalOrphanSweepSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: ATTACHMENT_FINAL_ORPHAN_SWEEP_SCHEDULE_ID,
			spec: {
				cronExpressions: [ATTACHMENT_FINAL_ORPHAN_SWEEP_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: ATTACHMENT_FINAL_ORPHAN_SWEEP_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 hour",
			},
			state: {
				paused: false,
				note: "Reclaims orphaned story-attachments/ final objects (no owning StoryAttachment row) older than FABRIC_ATTACHMENT_FINAL_ORPHAN_MAX_AGE_HOURS (default 24) + 1h margin. Budget counts successful deletes; maximumAttempts 1.",
			},
		});

		console.log(
			`[Worker] Schedule "${ATTACHMENT_FINAL_ORPHAN_SWEEP_SCHEDULE_ID}" registered (daily at 03:45 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${ATTACHMENT_FINAL_ORPHAN_SWEEP_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the attachment-retention-purge schedule (#1702 Part 5).
 *
 * Always registered (feature is GA). Idempotent via the stable schedule id.
 */
/**
 * Registered unconditionally, even though QA sits behind
 * `FABRIC_FEATURE_TEST_CASES`: the gate lives in the find-and-delete activity,
 * not here, so flipping the flag on takes effect on the next tick with no
 * redeploy. With the flag off the sweep runs and examines nothing.
 */
async function registerQaEvidenceRetentionSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: QA_EVIDENCE_RETENTION_SCHEDULE_ID,
			spec: {
				cronExpressions: [QA_EVIDENCE_RETENTION_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: QA_EVIDENCE_RETENTION_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 hour",
			},
			state: {
				paused: false,
				note: "Deletes QA run screenshots older than their project's evidenceRetentionDays (default 90; 0 keeps them indefinitely), object-first then ledger row. Budget counts confirmed object deletes; maximumAttempts 1.",
			},
		});

		console.log(
			`[Worker] Schedule "${QA_EVIDENCE_RETENTION_SCHEDULE_ID}" registered (daily at 04:45 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${QA_EVIDENCE_RETENTION_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

async function registerAttachmentRetentionPurgeSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: ATTACHMENT_RETENTION_PURGE_SCHEDULE_ID,
			spec: {
				cronExpressions: [ATTACHMENT_RETENTION_PURGE_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: ATTACHMENT_RETENTION_PURGE_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 hour",
			},
			state: {
				paused: false,
				note: "Purges StoryAttachment rows whose retention window has elapsed since they were hidden, plus their R2 objects (object-first). The window resolves per tenant: project setting, else organization setting, else the server default. Budget counts successful object deletes; maximumAttempts 1.",
			},
		});

		console.log(
			`[Worker] Schedule "${ATTACHMENT_RETENTION_PURGE_SCHEDULE_ID}" registered (daily at 04:15 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${ATTACHMENT_RETENTION_PURGE_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the pm-sync-log-retention schedule.
 *
 * Opt-in: only registered when `FABRIC_PM_SYNC_LOG_RETENTION_ENABLED === "true"`.
 * Default is OFF so an operator does not silently lose PM sync history.
 *
 * Runs daily at 04:00 UTC (one hour after audit-log retention to avoid
 * overlapping batched purges on the `fabric-worker` queue). Idempotent
 * registration — the stable `PM_SYNC_LOG_RETENTION_SCHEDULE_ID` ensures
 * restarts don't create duplicates (the `ScheduleAlreadyRunning` catch
 * branch absorbs the collision).
 */
async function registerPmSyncLogRetentionSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const enabled = process.env.FABRIC_PM_SYNC_LOG_RETENTION_ENABLED === "true";
	if (!enabled) {
		console.log(
			`[Worker] Schedule "${PM_SYNC_LOG_RETENTION_SCHEDULE_ID}" NOT registered (FABRIC_PM_SYNC_LOG_RETENTION_ENABLED is not "true"). Set the env var to opt in.`,
		);
		return;
	}

	try {
		await scheduleClient.create({
			scheduleId: PM_SYNC_LOG_RETENTION_SCHEDULE_ID,
			spec: {
				cronExpressions: [PM_SYNC_LOG_RETENTION_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: PM_SYNC_LOG_RETENTION_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				// Don't overlap: a slow purge run shouldn't be paralleled
				// by a fresh trigger 24h later.
				overlap: "SKIP",
				catchupWindow: "12 hours",
			},
			state: {
				paused: false,
				note: "Purges pm_sync_log rows older than FABRIC_PM_SYNC_LOG_RETENTION_DAYS in 5k-row batches with a 1k-batch safety cap. Emits one structured pm_sync_log.retention.purged log line per run.",
			},
		});

		console.log(
			`[Worker] Schedule "${PM_SYNC_LOG_RETENTION_SCHEDULE_ID}" registered (daily at 04:00 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${PM_SYNC_LOG_RETENTION_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the workflow-builder schedule reconciler.
 *
 * Deletes schedules whose workflow was deleted, unpublished, or switched away
 * from a Schedule trigger. Conservative by design: anything it cannot
 * positively identify as an orphan is left alone, because a false positive
 * deletes a live schedule.
 */
async function registerWorkflowBuilderReconcileSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: WORKFLOW_BUILDER_RECONCILE_SCHEDULE_ID,
			spec: {
				cronExpressions: [WORKFLOW_BUILDER_RECONCILE_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: WORKFLOW_BUILDER_RECONCILE_WORKFLOW_NAME,
				taskQueue: WORKFLOW_BUILDER_RECONCILE_TASK_QUEUE,
				args: [{ dryRun: false }],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "12 hours",
			},
			state: {
				paused: false,
				note: "Weekly sweep for orphaned workflow-builder schedules (workflow deleted, unpublished, or no longer schedule-triggered).",
			},
		});

		console.log(
			`[Worker] Schedule "${WORKFLOW_BUILDER_RECONCILE_SCHEDULE_ID}" registered (weekly, Sunday 01:15 UTC, workflow-builder queue)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${WORKFLOW_BUILDER_RECONCILE_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the draft-project-cleanup schedule.
 *
 * Daily at 03:00 UTC. Sweeps DRAFT `Project` rows abandoned past the
 * 14-day cutoff: cancels every in-flight URL crawl on the DRAFT, then
 * soft-deletes the DRAFT so the existing 7-day retention cron eventually
 * reaps it.
 *
 * Idempotent registration via the `ScheduleAlreadyRunning` catch — safe
 * to call on every worker boot. Runs on the `project-documents` task
 * queue (matches the wizard-cleanup pattern) so the same worker pool
 * that hosts the URL crawl workflows also services the cancellation
 * calls.
 *
 * The 03:00 UTC slot is shared with `audit-log-retention` but they run
 * on different task queues (`fabric-worker` vs `project-documents`) so
 * there's no contention.
 */
async function registerDraftProjectCleanupSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: DRAFT_PROJECT_CLEANUP_SCHEDULE_ID,
			spec: {
				cronExpressions: [DRAFT_PROJECT_CLEANUP_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: DRAFT_PROJECT_CLEANUP_WORKFLOW_NAME,
				taskQueue: DRAFT_PROJECT_CLEANUP_TASK_QUEUE,
				args: [{ cutoffDays: 14, batchSize: 50 }],
			},
			policies: {
				// Don't overlap: yesterday's sweep should drain before
				// today's fire. Drift past 24h is covered by the
				// catchupWindow.
				overlap: "SKIP",
				catchupWindow: "12 hours",
			},
			state: {
				paused: false,
				note: "Sweeps abandoned wizard DRAFTs (>14 days idle), cancels in-flight URL crawls per DRAFT, then soft-deletes. See spec §6.3.",
			},
		});

		console.log(
			`[Worker] Schedule "${DRAFT_PROJECT_CLEANUP_SCHEDULE_ID}" registered (daily at 03:00 UTC, project-documents queue)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${DRAFT_PROJECT_CLEANUP_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the weave-execution-watchdog schedule.
 *
 * Runs every 5 minutes on the `fabric-worker` queue. Finds Weave
 * (`WeaveExecution`) and CodingRun (`CodingRun`) rows that are still
 * non-terminal but whose `startedAt` is older than
 * `WEAVE_MAX_RUN_MINUTES` (default 120). For each: signals cancel,
 * falls through to terminate when the signal goes unacknowledged,
 * calls the provider cleanup directly, marks the row
 * `TERMINATED_STALE`, and writes a `weave.session.terminated_stale`
 * audit-log entry.
 *
 * Idempotent registration via the `ScheduleAlreadyRunning` catch.
 */
async function registerWeaveExecutionWatchdogSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: WEAVE_WATCHDOG_SCHEDULE_ID,
			spec: {
				cronExpressions: [WEAVE_WATCHDOG_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: WEAVE_WATCHDOG_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "10 minutes",
			},
			state: {
				paused: false,
				note: "Detects and kills Weave/CodingRun rows non-terminal for longer than WEAVE_MAX_RUN_MINUTES (default 120). Writes a weave.session.terminated_stale audit-log entry per kill.",
			},
		});

		console.log(
			`[Worker] Schedule "${WEAVE_WATCHDOG_SCHEDULE_ID}" registered (every 5 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${WEAVE_WATCHDOG_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the backlog-apply-watchdog schedule.
 *
 * Runs every 5 minutes on the `fabric-worker` queue. Finds
 * `PendingBacklogProposal` rows still PENDING with an apply dispatched
 * (`applyStartedAt` set) longer than `FABRIC_BACKLOG_APPLY_STALE_MINUTES`
 * (default 15). For each: force-terminates the leaked apply workflow, flips the
 * row `PENDING → FAILED` (errorClass "TimedOut", compare-and-set so a late
 * finalize / manual cancel can't be clobbered), finalizes the session-history
 * row, and writes a `backlog.proposal.timed_out` audit entry.
 *
 * Idempotent registration via the `ScheduleAlreadyRunning` catch.
 */
async function registerBacklogApplyWatchdogSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: BACKLOG_APPLY_WATCHDOG_SCHEDULE_ID,
			spec: {
				cronExpressions: [BACKLOG_APPLY_WATCHDOG_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: BACKLOG_APPLY_WATCHDOG_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "10 minutes",
			},
			state: {
				paused: false,
				note: "Recovers PendingBacklogProposal rows stuck mid-apply (PENDING with applyStartedAt older than FABRIC_BACKLOG_APPLY_STALE_MINUTES, default 15). Writes a backlog.proposal.timed_out audit entry per recovery.",
			},
		});

		console.log(
			`[Worker] Schedule "${BACKLOG_APPLY_WATCHDOG_SCHEDULE_ID}" registered (every 5 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${BACKLOG_APPLY_WATCHDOG_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the document-generation-watchdog schedule.
 *
 * Runs every 10 minutes on the `fabric-worker` queue. Finds `ProjectDocument`
 * rows still GENERATING whose generation was dispatched longer ago than
 * `FABRIC_DOCUMENT_GENERATION_STALE_MINUTES` (default 30), asks Temporal whether
 * anything is still running under each row's workflow id, and flips only the
 * ones it can confirm are not — every uncertainty reads as live and is retried
 * next tick. The write is scoped to the scanned attempt, so a row re-dispatched
 * in between is left alone.
 *
 * Idempotent registration via the `ScheduleAlreadyRunning` catch.
 */
async function registerDocumentGenerationWatchdogSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: DOCUMENT_GENERATION_WATCHDOG_SCHEDULE_ID,
			spec: {
				cronExpressions: [DOCUMENT_GENERATION_WATCHDOG_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: DOCUMENT_GENERATION_WATCHDOG_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "10 minutes",
			},
			state: {
				paused: false,
				note: "Fails ProjectDocument rows left GENERATING by a dispatch whose workflow never started (older than FABRIC_DOCUMENT_GENERATION_STALE_MINUTES, default 30). Skips any row Temporal still reports as running.",
			},
		});

		console.log(
			`[Worker] Schedule "${DOCUMENT_GENERATION_WATCHDOG_SCHEDULE_ID}" registered (every 10 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${DOCUMENT_GENERATION_WATCHDOG_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the background-job-retention schedule (Job Hub).
 *
 * Registered unconditionally — unlike the opt-in audit-log purge, these rows
 * are ephemeral progress telemetry and the panel already hides anything past
 * the retention window.
 */
async function registerBackgroundJobRetentionSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: BACKGROUND_JOB_RETENTION_SCHEDULE_ID,
			spec: {
				cronExpressions: [BACKGROUND_JOB_RETENTION_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: BACKGROUND_JOB_RETENTION_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				// A slow purge shouldn't be paralleled by the next day's run.
				overlap: "SKIP",
				catchupWindow: "12 hours",
			},
			state: {
				paused: false,
				note: "Deletes background_job rows older than FABRIC_JOB_RETENTION_DAYS (default 7) in 5k-row batches with a safety cap. Keeps the Job Hub table bounded.",
			},
		});

		console.log(
			`[Worker] Schedule "${BACKGROUND_JOB_RETENTION_SCHEDULE_ID}" registered (daily at 05:00 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${BACKGROUND_JOB_RETENTION_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * Register the background-job-watchdog schedule (Job Hub).
 *
 * Bounds how long a crashed run can sit in the panel as "Running": the closing
 * write lives in an activity that never got to run, so nothing else will ever
 * finish those rows.
 */
async function registerBackgroundJobWatchdogSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	try {
		await scheduleClient.create({
			scheduleId: BACKGROUND_JOB_WATCHDOG_SCHEDULE_ID,
			spec: {
				cronExpressions: [BACKGROUND_JOB_WATCHDOG_CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: BACKGROUND_JOB_WATCHDOG_WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "10 minutes",
			},
			state: {
				paused: false,
				note: "Fails background_job rows whose heartbeat is older than FABRIC_JOB_STALE_MINUTES (default 45), so a dead worker's job stops showing as Running.",
			},
		});

		console.log(
			`[Worker] Schedule "${BACKGROUND_JOB_WATCHDOG_SCHEDULE_ID}" registered (every 5 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${BACKGROUND_JOB_WATCHDOG_SCHEDULE_ID}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}
