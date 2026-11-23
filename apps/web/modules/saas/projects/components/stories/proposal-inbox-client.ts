import { orpcClient } from "@shared/lib/orpc-client";
import type { QueryClient } from "@tanstack/react-query";
import type { ApproveOutcome } from "./proposal-approve-outcome";

/**
 * Pick the right monitor's pendingProposals namespace for approve/reject
 * based on the proposal's `source` value (the enum from `schema.prisma`:
 * `SLACK_CHANNEL`, `TEAMS_CHANNEL`, `TEAMS_CHAT`).
 *
 * Background: prior to the chat-thread-image-attachments feature the inbox
 * called teamsChannelMonitor.approve for every source; this worked because
 * `createStoryFromProposal` is source-agnostic and the approve procedure
 * did not yet touch any per-source resources. Once the orchestrator was
 * wired (FR-18) the per-monitor approve procedures each pull credentials
 * for their own integration (Slack bot token vs Microsoft Graph token) and
 * each filter `sourceMetadata.attachments` to refs matching THEIR source.
 * Dispatching to the wrong endpoint silently drops the attachments —
 * verified live during PR validation.
 */
export function endpointForSource(source: string) {
	switch (source) {
		case "SLACK_CHANNEL":
			return orpcClient.projects.slackChannelMonitor.pendingProposals;
		case "TEAMS_CHAT":
			return orpcClient.projects.teamsChatMonitor.pendingProposals;
		default:
			// Default keeps the previous behavior for unknown future sources —
			// the Teams channel monitor's list/get/count endpoints are
			// source-agnostic, so falling through here at least surfaces the
			// proposal rather than throwing.
			return orpcClient.projects.teamsChannelMonitor.pendingProposals;
	}
}

/** The project's possible-duplicate flags, one query for the whole inbox. */
export function proposalDuplicateFlagsQueryKey(
	projectId: string,
	organizationId: string | null,
) {
	return ["proposal-duplicate-flags", projectId, organizationId] as const;
}

/**
 * Refresh every Proposal Inbox read after a proposal or ticket changed: the
 * review list, its badge count, the Rejected list, any open proposal and
 * the possible-duplicate flags, which compare the inbox with the Roadmap.
 */
export function invalidateProposalInboxQueries(
	queryClient: QueryClient,
	projectId: string,
	organizationId: string | null,
): void {
	for (const prefix of [
		"teams-channel-monitor-pending-proposals",
		"teams-channel-monitor-pending-proposals-count",
		"teams-channel-monitor-pending-proposal",
	]) {
		queryClient.invalidateQueries({
			queryKey: [prefix, projectId, organizationId],
		});
	}
	queryClient.invalidateQueries({
		queryKey: proposalDuplicateFlagsQueryKey(projectId, organizationId),
	});
}

/** Roadmap recommendation batches. */
export const ROADMAP_RECOMMENDATION_SOURCE = "ROADMAP_RECOMMENDATION";

/**
 * Sources applied through the backlog apply workflow with the proposal id,
 * never through a channel-monitor approve door.
 */
const ASYNC_APPLY_SOURCES = new Set([
	"SCOPE_DOCUMENT",
	ROADMAP_RECOMMENDATION_SOURCE,
]);

/** The PM tool an approved update is pushed to when the reviewer syncs. */
export type ProposalPmConfig = {
	mcpConfigId: string;
	containerId: string;
	additionalContext?: Record<string, string>;
};

/** One approval of a proposal's changes, whole or one item. */
export type ProposalApprovalRequest = {
	projectId: string;
	organizationId: string | null;
	pmConfig: ProposalPmConfig | undefined;
	proposalId: string;
	source: string;
	approvedChanges: unknown[];
	approvedChangeIndexes?: number[];
	pmSyncOverrides?: Record<number, { pushAnyway?: boolean; skip?: boolean }>;
	syncToPM: boolean;
	/** `proposalRevision` of the detail the reviewer approved from. */
	expectedProposalRevision?: string;
};

/**
 * Approve a proposal's changes through the door its source uses. The inbox
 * and a line-by-line review on a ticket page both approve through here.
 */
export async function requestProposalApproval(
	request: ProposalApprovalRequest,
): Promise<ApproveOutcome> {
	const { projectId, organizationId, pmConfig } = request;
	// Scope-document proposals are applied through the backlog apply
	// workflow with the proposal id: the handler claims the row and every
	// change is recorded with an application key, so a retried apply cannot
	// create the same items twice. The channel-monitor approve path
	// materialises creates synchronously and must not be used for them.
	//
	// Roadmap recommendation batches take the same door, and honour the
	// reviewer's PM-sync choice: the server defaults to no sync, so only an
	// explicit tick pushes.
	if (ASYNC_APPLY_SOURCES.has(request.source)) {
		const isRecommendation =
			request.source === ROADMAP_RECOMMENDATION_SOURCE;
		const dispatched = await orpcClient.projects.backlog.applyChanges({
			projectId,
			organizationId,
			proposalId: request.proposalId,
			approvedChanges: request.approvedChanges as never,
			approvedChangeIndexes: request.approvedChangeIndexes,
			expectedProposalRevision: request.expectedProposalRevision,
			pmSyncOverrides: request.pmSyncOverrides,
			...(isRecommendation
				? {
						syncToPM: request.syncToPM,
						pmConfig: request.syncToPM ? pmConfig : undefined,
					}
				: { syncToPM: false }),
		});
		// A resubmit with every item held back returns no workflow: the
		// held-back items are still named, as on any other approve.
		return dispatched.workflowId
			? { status: "dispatched", heldBack: dispatched.heldBack }
			: {
					status: "failed",
					errors: [dispatched.message],
					heldBack: dispatched.heldBack,
				};
	}
	return await endpointForSource(request.source).approve({
		projectId,
		organizationId,
		proposalId: request.proposalId,
		// The approve procedure will handle its own Zod validation on the
		// change shape; we pass whatever BacklogChangeProposal produced after
		// normalization.
		approvedChanges: request.approvedChanges as never,
		approvedChangeIndexes: request.approvedChangeIndexes,
		// A proposal changed since it was opened is refused (CONFLICT).
		expectedProposalRevision: request.expectedProposalRevision,
		// Explicit user choice from the proposal-review checkbox. Pass the
		// boolean verbatim (never undefined): the approve procedure treats
		// `undefined` as "sync if a PM tool is configured", so an explicit
		// `false` is required to honor an unchecked box.
		syncToPM: request.syncToPM,
		// Lets the checkbox govern UPDATE-change sync too (CREATE resolves
		// the config server-side). Undefined when no PM tool.
		pmConfig,
	});
}
