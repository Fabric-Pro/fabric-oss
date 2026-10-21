/** Validate source objects received through the analysis frontend action. */
export function validateBacklogAnalysisSources(args: {
	selectedMeetings?: unknown;
	selectedChannels?: unknown;
	daysBack?: unknown;
}): {
	selectedMeetings: Array<{ joinUrl: string; startTime?: string }>;
	selectedChannels: Array<{ projectContextId: string }>;
	daysBack: 7 | 14 | 30 | 60 | 90 | undefined;
} {
	const selectedMeetings: Array<{ joinUrl: string; startTime?: string }> = [];
	for (const entry of Array.isArray(args.selectedMeetings)
		? args.selectedMeetings
		: []) {
		if (
			entry &&
			typeof entry === "object" &&
			typeof entry.joinUrl === "string" &&
			entry.joinUrl.trim().length > 0
		) {
			selectedMeetings.push({
				joinUrl: entry.joinUrl,
				...(typeof entry.startTime === "string"
					? { startTime: entry.startTime }
					: {}),
			});
		}
	}
	const selectedChannels: Array<{ projectContextId: string }> = [];
	for (const entry of Array.isArray(args.selectedChannels)
		? args.selectedChannels
		: []) {
		if (
			entry &&
			typeof entry === "object" &&
			typeof entry.projectContextId === "string" &&
			entry.projectContextId.trim().length > 0
		) {
			selectedChannels.push({ projectContextId: entry.projectContextId });
		}
	}
	const daysBack =
		args.daysBack === 7 ||
		args.daysBack === 14 ||
		args.daysBack === 30 ||
		args.daysBack === 60 ||
		args.daysBack === 90
			? args.daysBack
			: undefined;
	return { selectedMeetings, selectedChannels, daysBack };
}

/** Validate other model-supplied options before starting analysis. */
export function validateBacklogAnalysisOptions(args: {
	userPrompt?: unknown;
	fetchSlackMessages?: unknown;
	notionPageIds?: unknown;
	notionMcpConfigId?: unknown;
}) {
	return {
		userPrompt:
			typeof args.userPrompt === "string" &&
			args.userPrompt.trim().length > 0
				? args.userPrompt
				: undefined,
		fetchSlackMessages:
			typeof args.fetchSlackMessages === "boolean"
				? args.fetchSlackMessages
				: undefined,
		notionPageIds: Array.isArray(args.notionPageIds)
			? args.notionPageIds.filter(
					(id): id is string =>
						typeof id === "string" && id.trim().length > 0,
				)
			: [],
		notionMcpConfigId:
			typeof args.notionMcpConfigId === "string"
				? args.notionMcpConfigId
				: undefined,
	};
}
