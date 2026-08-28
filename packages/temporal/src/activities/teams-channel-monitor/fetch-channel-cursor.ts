/**
 * Teams Channel Monitor — per-channel cursor and project-level state activities.
 *
 * Thin wrappers around the `@repo/database` query helpers in
 * `packages/database/prisma/queries/projects/teams-channel-monitor.ts`.
 *
 * All Date fields are serialised to ISO strings at the activity boundary to
 * keep Temporal payload encoding predictable.
 */

import {
	appendAppliedChangeIndexes,
	clearTeamsChannelFailureState,
	finalizeBacklogUpdateSession,
	getLinkedTeamsChannelsForMonitor,
	getTeamsLinkedChannelJobContext,
	markPendingProposalApplied,
	markPendingProposalFailed,
	recordTeamsChannelFailure,
	setTeamsChannelScanPageToken,
	updateTeamsChannelCursor,
	updateTeamsChannelMonitorLastRun,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	JOB_SOURCE,
	JOB_STEPS,
	jobCompleteAll,
	jobEnsure,
	jobFail,
	jobIncrement,
	jobStep,
	seedJobSteps,
} from "../lib/job-progress";

// =============================================================================
// Types
// =============================================================================

export interface GetLinkedChannelsForMonitorInput {
	projectId: string;
}

export interface LinkedChannelForMonitor {
	id: string;
	teamId: string;
	channelId: string;
	teamName: string | null;
	channelName: string | null;
	channelWebUrl: string | null;
	/** ISO string — cursor for the latest thread activity we've already processed. */
	lastMessageCreatedAt: string | null;
	lastMessageId: string | null;
	/** Persisted Graph pagination resume token (null = scan from top). */
	scanPageToken: string | null;
}

export interface UpdateTeamsChannelMonitorLastRunInput {
	projectId: string;
}

export interface RecordTeamsChannelFailureInput {
	linkedChannelId: string;
	errorMessage: string;
}

export interface ClearTeamsChannelFailureInput {
	linkedChannelId: string;
}

// =============================================================================
// Activities
// =============================================================================

/**
 * Fetch the minimal per-channel state the monitor workflow needs each tick.
 * Re-read every tick so add/remove channel ops propagate without a restart.
 */
export async function getLinkedChannelsForMonitorActivity(
	input: GetLinkedChannelsForMonitorInput,
): Promise<LinkedChannelForMonitor[]> {
	const { projectId } = input;

	logger.info("[TeamsChannelMonitor] Fetching linked channels", {
		projectId,
	});

	try {
		const rows = await getLinkedTeamsChannelsForMonitor(projectId);
		return rows.map((r) => ({
			id: r.id,
			teamId: r.teamId,
			channelId: r.channelId,
			teamName: r.teamName,
			channelName: r.channelName,
			channelWebUrl: r.channelWebUrl,
			lastMessageCreatedAt: r.lastMessageCreatedAt
				? r.lastMessageCreatedAt.toISOString()
				: null,
			lastMessageId: r.lastMessageId,
			scanPageToken: r.scanPageToken ?? null,
		}));
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[TeamsChannelMonitor] Failed to fetch linked channels", {
			error: errorMessage,
			projectId,
		});
		return [];
	}
}

/**
 * Stamp the project's `teamsChannelMonitorLastRun` timestamp with now().
 * Non-fatal: caller may swallow errors.
 */
export async function updateTeamsChannelMonitorLastRunActivity(
	input: UpdateTeamsChannelMonitorLastRunInput,
): Promise<void> {
	const { projectId } = input;

	// Job Hub: the workflow calls this once at the end of every tick, so it is
	// the natural close point — one call closes all the per-channel rows this
	// tick opened. A tick that scanned nothing opened none, and this is a no-op.
	await jobCompleteAll();

	try {
		await updateTeamsChannelMonitorLastRun(projectId);
	} catch (error) {
		logger.error(
			"[TeamsChannelMonitor] Failed to update monitor last run timestamp",
			{
				error: error instanceof Error ? error.message : String(error),
				projectId,
			},
		);
		throw error;
	}
}

/**
 * Advance a channel's polling cursor after all threads in a tick are processed.
 * Called from the workflow — NOT from the per-thread analyze activity — so the
 * cursor never jumps past unfetched threads on busy channels.
 */
export async function updateTeamsChannelCursorActivity(input: {
	linkedChannelId: string;
	lastMessageCreatedAt: string | null;
	lastMessageId: string | null;
}): Promise<void> {
	await updateTeamsChannelCursor(input.linkedChannelId, {
		lastMessageCreatedAt: input.lastMessageCreatedAt
			? new Date(input.lastMessageCreatedAt)
			: null,
		lastMessageId: input.lastMessageId,
	});
}

/**
 * Persist (or clear) the Graph pagination resume token for a channel so the
 * next monitor tick can continue its backward-scan from that point instead
 * of re-scanning the same already-seen window.
 */
export async function setTeamsChannelScanPageTokenActivity(input: {
	linkedChannelId: string;
	token: string | null;
}): Promise<void> {
	await setTeamsChannelScanPageToken(input.linkedChannelId, input.token);
}

/**
 * Flip a PendingBacklogProposal to its terminal state after the apply
 * workflow finishes. Called from backlogApplyChangesWorkflow when it was
 * invoked for a proposal approval (pendingProposalId in the workflow input).
 *
 * The FAILED path now persists a classified `errorClass` alongside the
 * short `errorMessage` and the raw `rawApplyError`. Callers compute the
 * `{ errorClass, errorMessage }` pair via `unwrapPmSyncError(...)` so the
 * downstream inbox + roadmap banner can render plain-English copy without
 * re-parsing the raw text. Honours the dedup-guard idempotency invariant:
 * the proposal row identified by `proposalId` is the same one a retry will
 * flip back to PENDING, so we never delete or re-create it here.
 */
export async function finalizePendingProposalActivity(input: {
	proposalId: string;
	outcome: "applied" | "failed";
	appliedChangeIndexes?: number[];
	errorClass?: string;
	errorMessage?: string;
	rawApplyError?: string;
	/**
	 * Count of changes whose Fabric apply succeeded but whose PM push hit a
	 * content CONFLICT — applied to Fabric, flagged for Review Center
	 * resolution. These are counted in `appliedChangeIndexes` (idempotency),
	 * but drive the session-history "N applied · M need review" split so a
	 * partially-synced run doesn't read as fully "Applied".
	 */
	pmConflictCount?: number;
}): Promise<void> {
	if (input.appliedChangeIndexes && input.appliedChangeIndexes.length > 0) {
		await appendAppliedChangeIndexes(
			input.proposalId,
			input.appliedChangeIndexes,
		);
	}
	if (input.outcome === "applied") {
		await markPendingProposalApplied(input.proposalId);
	} else {
		await markPendingProposalFailed(input.proposalId, {
			errorClass: input.errorClass ?? "default",
			errorMessage: input.errorMessage ?? "apply workflow failed",
			rawApplyError: input.rawApplyError,
		});
	}

	// Mirror the terminal outcome onto the AI Backlog Update "Session history"
	// row, if one exists for this proposal (only AI_UPDATE_SIDEBAR applies create
	// sessions — this is a no-op for channel-monitor proposals). Best-effort: a
	// session-finalize failure must never fail the proposal finalize. No workflow
	// command is added — this runs inside the existing activity, so there is no
	// replay/determinism impact.
	try {
		const appliedIndexCount = input.appliedChangeIndexes?.length ?? 0;
		const conflictCount = input.pmConflictCount ?? 0;
		// A clean Fabric apply with M drifted (conflicted) items is a PARTIAL
		// from the user's perspective — the M items still need Review Center
		// resolution before they reach the PM tool. Surface that split even
		// though the proposal itself is APPLIED (not failed / not stuck).
		const sessionStatus =
			input.outcome === "applied"
				? conflictCount > 0
					? "PARTIALLY_APPLIED"
					: "APPLIED"
				: appliedIndexCount > 0
					? "PARTIALLY_APPLIED"
					: "FAILED";
		// `appliedChangeIndexes` counts conflicts as applied (idempotency), so
		// subtract them back out for the session's "fully synced" applied count;
		// the remainder surfaces as the "need review" split.
		const sessionAppliedCount =
			sessionStatus !== "PARTIALLY_APPLIED"
				? undefined
				: input.outcome === "applied"
					? Math.max(0, appliedIndexCount - conflictCount)
					: appliedIndexCount;
		await finalizeBacklogUpdateSession({
			pendingProposalId: input.proposalId,
			status: sessionStatus,
			appliedCount: sessionAppliedCount,
			errors: input.errorMessage
				? [input.errorMessage]
				: conflictCount > 0
					? [
							`${conflictCount} item(s) changed in the PM tool — resolve in the Review Center.`,
						]
					: undefined,
		});
	} catch (error) {
		logger.warn("[BacklogUpdateSession] finalize failed (non-fatal)", {
			proposalId: input.proposalId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Increment the per-channel `consecutiveFailures` counter and persist the
 * error message + timestamp so the settings UI can surface re-link prompts.
 */
export async function recordTeamsChannelFailureActivity(
	input: RecordTeamsChannelFailureInput,
): Promise<void> {
	const { linkedChannelId, errorMessage } = input;

	// Job Hub: a failed channel gets a row even when nothing was analyzed — a
	// tick that only errored must be visible, not silently absent. The input
	// carries no tenant, so resolve it from the linked-channel row.
	try {
		const context = await getTeamsLinkedChannelJobContext(linkedChannelId);
		if (context) {
			const displayName =
				context.channelName ?? context.teamName ?? "channel";
			await jobEnsure({
				kind: "TEAMS_CHANNEL_MONITOR",
				title: `Teams · ${displayName}`,
				projectId: context.projectId,
				userId: context.userId,
				organizationId: context.organizationId,
				sourceType: JOB_SOURCE.teamsLinkedChannel,
				sourceId: linkedChannelId,
				steps: seedJobSteps([...JOB_STEPS.channelMonitor]),
			});
			await jobIncrement({ failedChannels: 1 }, linkedChannelId);
			await jobStep("fetch", "failed", {
				sourceId: linkedChannelId,
				error: errorMessage,
			});
			// Close the row as FAILED here, not just mark the step. The
			// tick-end activity closes every row still RUNNING, so a row left
			// open would be stamped COMPLETED — a failed channel would render
			// with a green badge and no reason, which is the exact misreport
			// the Job Hub exists to remove. Closing now also makes the
			// compare-and-set in `completeBackgroundJobs` skip it.
			await jobFail(errorMessage, { sourceId: linkedChannelId });
		}
	} catch {
		// Best-effort telemetry — never let it mask the real failure below.
	}

	try {
		await recordTeamsChannelFailure(linkedChannelId, errorMessage);
	} catch (error) {
		logger.error("[TeamsChannelMonitor] Failed to record channel failure", {
			error: error instanceof Error ? error.message : String(error),
			linkedChannelId,
		});
		// Non-fatal — swallow so the monitor keeps working.
	}
}

/**
 * Clear a channel's failure state after a tick that succeeded without advancing
 * the cursor, so a recovered but quiet channel stops showing the re-link prompt
 * (Fizzy #2311).
 *
 * Best-effort, like the failure recorder above: clearing a banner must never
 * fail a tick that otherwise worked.
 */
export async function clearTeamsChannelFailureActivity(
	input: ClearTeamsChannelFailureInput,
): Promise<void> {
	try {
		await clearTeamsChannelFailureState(input.linkedChannelId);
	} catch (error) {
		logger.error("[TeamsChannelMonitor] Failed to clear channel failure", {
			error: error instanceof Error ? error.message : String(error),
			linkedChannelId: input.linkedChannelId,
		});
	}
}
