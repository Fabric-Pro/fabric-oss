/**
 * Teams Chat Monitor — per-chat cursor and project-level state activities.
 *
 * Thin wrappers around the `@repo/database` query helpers in
 * `packages/database/prisma/queries/projects/teams-chat-monitor.ts`.
 *
 * All Date fields are serialised to ISO strings at the activity boundary to
 * keep Temporal payload encoding predictable.
 */

import {
	clearTeamsChatFailureState,
	getLinkedTeamsChatsForMonitor,
	getTeamsLinkedChatJobContext,
	recordTeamsChatFailure,
	setTeamsChatScanPageToken,
	updateTeamsChatCursor,
	updateTeamsChatMonitorLastRun,
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

export interface GetLinkedChatsForMonitorInput {
	projectId: string;
}

export interface LinkedChatForMonitor {
	id: string;
	chatId: string;
	chatTopic: string | null;
	chatWebUrl: string | null;
	/** ISO string — cursor for the latest message activity we've already processed. */
	lastMessageCreatedAt: string | null;
	lastMessageId: string | null;
	/** Persisted Graph pagination resume token (null = scan from top). */
	scanPageToken: string | null;
}

export interface UpdateTeamsChatMonitorLastRunInput {
	projectId: string;
}

export interface ClearTeamsChatFailureInput {
	linkedChatId: string;
}

export interface RecordTeamsChatFailureInput {
	linkedChatId: string;
	errorMessage: string;
}

// =============================================================================
// Activities
// =============================================================================

/**
 * Fetch the minimal per-chat state the monitor workflow needs each tick.
 * Re-read every tick so add/remove chat ops propagate without a restart.
 */
export async function getLinkedChatsForMonitorActivity(
	input: GetLinkedChatsForMonitorInput,
): Promise<LinkedChatForMonitor[]> {
	const { projectId } = input;

	logger.info("[TeamsChatMonitor] Fetching linked chats", { projectId });

	try {
		const rows = await getLinkedTeamsChatsForMonitor(projectId);
		return rows.map((r) => ({
			id: r.id,
			chatId: r.chatId,
			chatTopic: r.chatTopic,
			chatWebUrl: r.chatWebUrl,
			lastMessageCreatedAt: r.lastMessageCreatedAt
				? r.lastMessageCreatedAt.toISOString()
				: null,
			lastMessageId: r.lastMessageId,
			scanPageToken: r.scanPageToken ?? null,
		}));
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[TeamsChatMonitor] Failed to fetch linked chats", {
			error: errorMessage,
			projectId,
		});
		return [];
	}
}

/**
 * Stamp the project's `teamsChatMonitorLastRun` timestamp with now().
 * Non-fatal: caller may swallow errors.
 */
export async function updateTeamsChatMonitorLastRunActivity(
	input: UpdateTeamsChatMonitorLastRunInput,
): Promise<void> {
	const { projectId } = input;

	// Job Hub: the workflow calls this at the end of every tick — one call
	// closes all the per-chat rows this tick opened. A tick that found nothing
	// opened none, and this is a no-op.
	await jobCompleteAll();

	try {
		await updateTeamsChatMonitorLastRun(projectId);
	} catch (error) {
		logger.error(
			"[TeamsChatMonitor] Failed to update monitor last run timestamp",
			{
				error: error instanceof Error ? error.message : String(error),
				projectId,
			},
		);
		throw error;
	}
}

/**
 * Advance a chat's polling cursor after all new messages in a tick are processed.
 */
export async function updateTeamsChatCursorActivity(input: {
	linkedChatId: string;
	lastMessageCreatedAt: string | null;
	lastMessageId: string | null;
}): Promise<void> {
	await updateTeamsChatCursor(input.linkedChatId, {
		lastMessageCreatedAt: input.lastMessageCreatedAt
			? new Date(input.lastMessageCreatedAt)
			: null,
		lastMessageId: input.lastMessageId,
	});
}

/**
 * Persist (or clear) the Graph pagination resume token for a chat.
 */
export async function setTeamsChatScanPageTokenActivity(input: {
	linkedChatId: string;
	token: string | null;
}): Promise<void> {
	await setTeamsChatScanPageToken(input.linkedChatId, input.token);
}

/**
 * Increment the per-chat `consecutiveFailures` counter and persist the
 * error message + timestamp so the settings UI can surface re-link prompts.
 */
export async function recordTeamsChatFailureActivity(
	input: RecordTeamsChatFailureInput,
): Promise<void> {
	const { linkedChatId, errorMessage } = input;

	// Job Hub: a failed chat gets a row even when nothing was analyzed — a tick
	// that only errored must be visible. The input carries no tenant, so resolve
	// it from the linked-chat row.
	try {
		const context = await getTeamsLinkedChatJobContext(linkedChatId);
		if (context) {
			await jobEnsure({
				kind: "TEAMS_CHAT_MONITOR",
				title: `Teams chat · ${context.chatTopic ?? "chat"}`,
				projectId: context.projectId,
				userId: context.userId,
				organizationId: context.organizationId,
				sourceType: JOB_SOURCE.teamsLinkedChat,
				sourceId: linkedChatId,
				steps: seedJobSteps([...JOB_STEPS.channelMonitor]),
			});
			await jobIncrement({ failedChannels: 1 }, linkedChatId);
			await jobStep("fetch", "failed", {
				sourceId: linkedChatId,
				error: errorMessage,
			});
			// Close the row as FAILED here, not just mark the step. The
			// tick-end activity closes every row still RUNNING, so a row left
			// open would be stamped COMPLETED — a failed chat would render with
			// a green badge and no reason, which is the exact misreport the Job
			// Hub exists to remove. Closing now also makes the compare-and-set
			// in `completeBackgroundJobs` skip it.
			await jobFail(errorMessage, { sourceId: linkedChatId });
		}
	} catch {
		// Best-effort telemetry — never mask the real failure below.
	}

	try {
		await recordTeamsChatFailure(linkedChatId, errorMessage);
	} catch (error) {
		logger.error("[TeamsChatMonitor] Failed to record chat failure", {
			error: error instanceof Error ? error.message : String(error),
			linkedChatId,
		});
		// Non-fatal — swallow so the monitor keeps working.
	}
}

/**
 * Clear a chat's failure state after a tick that succeeded without advancing the
 * cursor. Mirror of `clearTeamsChannelFailureActivity` (Fizzy #2311).
 */
export async function clearTeamsChatFailureActivity(
	input: ClearTeamsChatFailureInput,
): Promise<void> {
	try {
		await clearTeamsChatFailureState(input.linkedChatId);
	} catch (error) {
		logger.error("[TeamsChatMonitor] Failed to clear chat failure", {
			error: error instanceof Error ? error.message : String(error),
			linkedChatId: input.linkedChatId,
		});
	}
}
