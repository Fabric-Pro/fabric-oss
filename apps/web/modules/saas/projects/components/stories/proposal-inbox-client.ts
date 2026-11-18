import { orpcClient } from "@shared/lib/orpc-client";
import type { QueryClient } from "@tanstack/react-query";

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
