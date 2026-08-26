/**
 * Daily Brief — DB-local Collector Activities
 *
 * These four activities read recent activity from Fabric's existing data
 * model and return typed output matching the shared daily-brief schema in
 * @repo/database. They contain no LLM calls and no external HTTP — each is
 * a single Prisma read, scoped by (projectId, organizationId) and filtered
 * to [timeWindowStart, timeWindowEnd].
 */

export * from "./collect-ahead";
export {
	type CollectDocumentChangesInput,
	type CollectDocumentChangesOutput,
	collectDocumentChanges,
} from "./collect-document-changes";
export {
	type CollectGitHubPullRequestsActivityInput,
	type CollectGitHubPullRequestsActivityOutput,
	collectGitHubPullRequestsActivity,
	type GitHubRepoFailure,
} from "./collect-github-pull-requests";
export {
	type CollectGitHubReleasesActivityInput,
	type CollectGitHubReleasesActivityOutput,
	collectGitHubReleasesActivity,
} from "./collect-github-releases";
export {
	type CollectMeetingTranscriptsInput,
	type CollectMeetingTranscriptsOutput,
	collectMeetingTranscripts,
} from "./collect-meeting-transcripts";
export {
	type CollectStoryActivityInput,
	type CollectStoryActivityOutput,
	collectStoryActivity,
} from "./collect-story-activity";
export {
	type CollectTeamsProposalsInput,
	type CollectTeamsProposalsOutput,
	collectTeamsProposals,
} from "./collect-teams-proposals";
export {
	type DetectPriorityActionsInput,
	type DetectPriorityActionsOutput,
	detectPriorityActionsActivity,
} from "./detect-priority-actions";
export {
	buildExtractionPrompt,
	type ExtractedInsights,
	type ExtractMeetingInsightsInput,
	type ExtractMeetingInsightsOutput,
	extractMeetingInsightsActivity,
	MEETING_INSIGHTS_VERSION,
} from "./extract-meeting-insights";
export {
	type LoadReleaseNoteExclusionsInput,
	loadReleaseNoteExclusionsActivity,
} from "./load-release-note-exclusions";
export {
	type PersistDailyBriefInput,
	persistDailyBriefActivity,
} from "./persist-daily-brief";
export * from "./reduce-storylines";
export {
	type SummarizeDailyBriefInput,
	type SummarizeDailyBriefOutput,
	summarizeDailyBriefActivity,
} from "./summarize-daily-brief";
export {
	buildReleaseNotesPrompt,
	type SummarizeReleaseNotesInput,
	type SummarizeReleaseNotesOutput,
	summarizeReleaseNotesActivity,
} from "./summarize-release-notes";
