/** Default linked Slack on unless only meetings were selected; explicit choices win. */
export type SlackFetchDecisionInput = {
	fetchSlackMessages?: boolean;
	hasSlackIntegration: boolean;
	selectedMeetings?: ReadonlyArray<unknown>;
	selectedChannels?: ReadonlyArray<unknown>;
	notionPageIds?: ReadonlyArray<string>;
};

export function resolveSlackFetchDecision(
	args: SlackFetchDecisionInput,
): boolean {
	const isMeetingOnlySelection =
		(args.selectedMeetings?.length ?? 0) > 0 &&
		!args.selectedChannels?.length &&
		!args.notionPageIds?.length;
	return (
		args.fetchSlackMessages ??
		(args.hasSlackIntegration && !isMeetingOnlySelection)
	);
}
