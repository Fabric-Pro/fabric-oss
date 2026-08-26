/**
 * Resolves Teams-fetch shape for a backlog analysis request.
 *
 * `analyze_backlog` is a CopilotKit tool. The agent is instructed to call
 * `select_review_sources` first whenever the user wants Teams context
 * (messages or meetings). We derive the Teams-messages fetch strictly from
 * the channel list the user picked there.
 *
 * Deliberately ignores any `fetchTeamsMessages` the LLM might pass in tool
 * args: there is no legacy fallback anymore. If the user did not pick a
 * specific channel, Teams messages are not fetched — even when the user
 * picked a meeting hosted in Teams.
 */

export type TeamsFetchDecisionInput = {
	selectedChannels?: Array<{ projectContextId: string }>;
};

export type TeamsFetchDecision = {
	fetchTeamsMessages: boolean;
	selectedChannelContextIds: string[];
};

export function resolveTeamsFetchDecision(
	args: TeamsFetchDecisionInput,
): TeamsFetchDecision {
	const selectedChannelContextIds = (args.selectedChannels ?? []).map(
		(c) => c.projectContextId,
	);
	return {
		fetchTeamsMessages: selectedChannelContextIds.length > 0,
		selectedChannelContextIds,
	};
}
