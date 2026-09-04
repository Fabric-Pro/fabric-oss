/**
 * Backlog Context Analysis Workflow
 *
 * Fetches context from multiple sources (Teams, meetings, Notion, RAG),
 * fetches the existing backlog, and runs LLM analysis to propose changes.
 *
 * Follows the same patterns as the project document workflows:
 * - Signal-based cancellation
 * - Query-based progress tracking
 * - Parallel context fetching
 */

import {
	ApplicationFailure,
	CancellationScope,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import type {
	analyzeContextAndPropose as AnalyzeContextAndProposeFn,
	ChangeProposal,
	runBacklogDecisionPrecheckActivity as RunBacklogDecisionPrecheckActivityFn,
} from "../activities/backlog-context/analyze-context";
import type { fetchApplicationLogsForBacklog as FetchApplicationLogsForBacklogFn } from "../activities/backlog-context/fetch-application-logs";
import type { fetchBacklogSnapshot as FetchBacklogSnapshotFn } from "../activities/backlog-context/fetch-backlog-snapshot";
import type {
	fetchDecisionsForBacklog as FetchDecisionsForBacklogFn,
	fetchMeetingTranscript as FetchMeetingTranscriptFn,
	fetchNotionPageContent as FetchNotionPageContentFn,
	fetchSecurityFindingsForBacklog as FetchSecurityFindingsForBacklogFn,
	fetchSlackMessagesForBacklog as FetchSlackMessagesForBacklogFn,
	fetchTeamsMessagesForBacklog as FetchTeamsMessagesForBacklogFn,
	retrieveProjectRagContext as RetrieveProjectRagContextFn,
} from "../activities/backlog-context/fetch-context";
import type { fetchPMWorkItemsByType as FetchPMWorkItemsByTypeFn } from "../activities/pm-integration/fetch-pm-hierarchy";
// Step 6 activity proxy for the persistent operation-
// result message. Reuses the same activity authored in PR1 and proxied
// from the orchestrator/direct-chat workflows in PR2. The timeout posture
// mirrors PR2's (`scheduleToCloseTimeout` is the worker-outage cap;
// `startToClose` is the single-attempt bound).
import type * as postOperationResultModule from "../activities/post-operation-result";
import { BACKLOG_ANALYSIS_CANCELLED_TYPE } from "./backlog-constants";
import { unwrapPmSyncError } from "./pm-sync-error-unwrap";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

// Re-export the ChangeProposal type for consumers
export type { ChangeProposal } from "../activities/backlog-context/analyze-context";

// =============================================================================
// Types
// =============================================================================

export interface BacklogContextAnalysisInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	contextSources: {
		fetchTeamsMessages: boolean;
		fetchSlackMessages?: boolean;
		selectedMeetings?: Array<{ joinUrl: string; startTime?: string }>;
		/** Specific ProjectContext IDs to scope Teams fetch to. */
		selectedChannelContextIds?: string[];
		/** Shared time window for meetings and Teams messages (days). */
		daysBack?: number;
		notionPageIds?: string[];
		notionMcpConfigId?: string;
	};
	/** PM tool config for fetching existing PM work items */
	pmConfig?: {
		mcpConfigId: string;
		containerId: string;
		additionalContext?: Record<string, string>;
	};
	userPrompt: string;
	/**
	 * Optional `AgentConversation` ID. When set, the
	 * workflow appends a `role: "system"` operation-result message at
	 * completion. Threaded through from `start-analysis.ts` procedure.
	 * Absent ⇒ Step 6 short-circuits (transient behaviour preserved).
	 */
	conversationId?: string;
}

export type AnalysisStatus =
	| "initializing"
	| "fetching_teams"
	| "fetching_slack"
	| "fetching_meetings"
	| "fetching_notion"
	| "fetching_rag"
	| "fetching_decisions"
	| "fetching_security"
	| "fetching_logs"
	| "fetching_backlog"
	| "analyzing"
	| "complete"
	| "cancelled"
	| "failed";

export interface BacklogContextAnalysisProgress {
	status: AnalysisStatus;
	message: string;
	error?: string;
	/**
	 * Why application logs are or are not part of this analysis (Fizzy #1234
	 * FR3). Set only when the log-context feature is enabled; absent otherwise
	 * so nothing changes for anyone while the flag is off.
	 */
	logContextNote?: string;
}

export interface BacklogContextAnalysisOutput {
	success: boolean;
	proposal?: ChangeProposal;
	error?: string;
	/** See `BacklogContextAnalysisProgress.logContextNote`. */
	logContextNote?: string;
	/**
	 * Set when the run stopped before the model rather than proposing from
	 * nothing (Fizzy #2260). Carries the reason, so the client can say what
	 * happened instead of showing an empty result or an error.
	 */
	skippedReason?: string;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelAnalysisSignal = defineSignal("cancelAnalysis");
export const analysisProgressQuery =
	defineQuery<BacklogContextAnalysisProgress>("analysisProgress");
export const analysisResultQuery = defineQuery<ChangeProposal | null>(
	"analysisResult",
);

// =============================================================================
// Activity Proxies
// =============================================================================

const {
	fetchTeamsMessagesForBacklog,
	fetchSlackMessagesForBacklog,
	fetchMeetingTranscript,
	fetchNotionPageContent,
	retrieveProjectRagContext,
	fetchDecisionsForBacklog,
	fetchSecurityFindingsForBacklog,
	fetchApplicationLogsForBacklog,
} = proxyActivities<{
	fetchTeamsMessagesForBacklog: typeof FetchTeamsMessagesForBacklogFn;
	fetchSlackMessagesForBacklog: typeof FetchSlackMessagesForBacklogFn;
	fetchMeetingTranscript: typeof FetchMeetingTranscriptFn;
	fetchNotionPageContent: typeof FetchNotionPageContentFn;
	retrieveProjectRagContext: typeof RetrieveProjectRagContextFn;
	fetchDecisionsForBacklog: typeof FetchDecisionsForBacklogFn;
	fetchSecurityFindingsForBacklog: typeof FetchSecurityFindingsForBacklogFn;
	fetchApplicationLogsForBacklog: typeof FetchApplicationLogsForBacklogFn;
}>({
	startToCloseTimeout: "120 seconds",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { fetchBacklogSnapshot } = proxyActivities<{
	fetchBacklogSnapshot: typeof FetchBacklogSnapshotFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { fetchPMWorkItemsByType } = proxyActivities<{
	fetchPMWorkItemsByType: typeof FetchPMWorkItemsByTypeFn;
}>({
	startToCloseTimeout: "60 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { analyzeContextAndPropose } = proxyActivities<{
	analyzeContextAndPropose: typeof AnalyzeContextAndProposeFn;
}>({
	startToCloseTimeout: "300 seconds", // LLM analysis can take time
	heartbeatTimeout: "120 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
		// A tenant with no provider of its own is now a deterministic refusal
		// rather than the rare case it was while the platform key backed every
		// call, so retrying one only delays the same answer.
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

// Async decision pre-check (card #1365 NFR): runs AFTER the proposal is exposed
// so the user-interactive AI-Update path never blocks on the LLM judge. Bounded,
// single-attempt, no heartbeat — the activity's `runDecisionPrecheck` is the
// degradation boundary (never throws, returns empty on any failure), and the
// workflow call is additionally wrapped in try/catch so no pre-check failure can
// break analysis. `startToCloseTimeout` sits just above the judge's own 20s
// `DECISION_PRECHECK_TIMEOUT_MS` so a stalled judge can't hold the run open.
const { runBacklogDecisionPrecheckActivity } = proxyActivities<{
	runBacklogDecisionPrecheckActivity: typeof RunBacklogDecisionPrecheckActivityFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: {
		maximumAttempts: 1,
	},
});

// Step 6 activity proxy.
//
// Timeout posture (Codex PR3 round-1 fix #1):
//   - `startToCloseTimeout: "30 seconds"` — single-attempt bound once
//     the activity is dispatched to a worker.
//   - `scheduleToCloseTimeout: "15 seconds"` — TIGHT whole-schedule
//     cap. PR2's direct-chat / orchestrator workflows use a "2 minutes"
//     cap because they either fire-and-forget via child workflow
//     (direct-chat) or sit behind `ParentClosePolicy.ABANDON`
//     (orchestrator completion) — user-perceived completion latency
//     is decoupled from this number. The backlog workflows are
//     inline-await on the user-facing return path; if the procedure
//     layer's `query()` consumer in `analysis-progress.ts` falls back
//     to the bounded `handle.result()` race (3s timeout), the parent
//     workflow's terminal state would not be reachable until this
//     timeout expires. A 2-minute stall under worker outage is a
//     measurable UX regression; a 15-second cap is short enough that
//     the user-visible stall stays inside a single 3s race retry
//     window. Trade-off: a worker outage longer than 15s drops the
//     Step 6 message (acceptable degradation — the message is a
//     "nice to have", not a primary completion path).
//   - `maximumAttempts: 2` — only retry-worthy class is transient
//     temporal-platform failure (activity worker disconnect). App
//     errors are already swallowed inside the activity itself.
//
// If a later observability finding shows that the inline-await
// latency leak is still hurting users (e.g. recurring worker outages
// in a region), the right escalation is to mirror direct-chat's
// `startChild + PARENT_CLOSE_POLICY_ABANDON` pattern, NOT to widen
// the schedule cap.
const { postOperationResultActivity } = proxyActivities<
	typeof postOperationResultModule
>({
	startToCloseTimeout: "30 seconds",
	scheduleToCloseTimeout: "15 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "5s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// Pure Helpers (exported for unit testing)
// =============================================================================

/**
 * Decide how Teams messages should be fetched for a backlog analysis run.
 * Pure function — safe to unit-test without a Temporal harness.
 */
export type TeamsFetchPlan =
	| { kind: "skip" }
	| { kind: "legacy" } // fetch from all linked channels
	| { kind: "scoped"; contextIds: string[] }; // fetch only these

export function planTeamsFetch(input: {
	fetchTeamsMessages: boolean;
	selectedChannelContextIds?: string[];
}): TeamsFetchPlan {
	const explicit = input.selectedChannelContextIds ?? [];
	if (explicit.length > 0) {
		return { kind: "scoped", contextIds: explicit };
	}
	if (input.fetchTeamsMessages) {
		return { kind: "legacy" };
	}
	return { kind: "skip" };
}

// =============================================================================
// Workflow Implementation
// =============================================================================

export async function backlogContextAnalysisWorkflow(
	input: BacklogContextAnalysisInput,
): Promise<BacklogContextAnalysisOutput> {
	const {
		projectId,
		userId,
		organizationId,
		contextSources,
		pmConfig,
		userPrompt,
		// Optional AgentConversation ID for the
		// persistent operation-result system message. Step 6 (at the
		// bottom of this body) short-circuits when undefined,
		// preserving today's behaviour for callers that omit it.
		conversationId,
	} = input;

	// Workflow state
	let cancelled = false;
	let proposal: ChangeProposal | null = null;
	const progress: BacklogContextAnalysisProgress = {
		status: "initializing",
		message: "Starting backlog analysis...",
	};

	// Signal & Query Handlers
	setHandler(cancelAnalysisSignal, () => {
		log.info("Received cancel signal for backlog analysis");
		cancelled = true;
		progress.status = "cancelled";
		progress.message = "Analysis cancelled by user";
	});

	setHandler(analysisProgressQuery, () => progress);
	setHandler(analysisResultQuery, () => proposal);

	try {
		log.info("Starting backlog context analysis workflow", {
			projectId,
			fetchTeams: contextSources.fetchTeamsMessages,
			selectedTeamsChannels:
				contextSources.selectedChannelContextIds?.length ?? 0,
			fetchSlack: contextSources.fetchSlackMessages ?? false,
			meetingCount: contextSources.selectedMeetings?.length ?? 0,
			notionCount: contextSources.notionPageIds?.length ?? 0,
			daysBack: contextSources.daysBack,
			hasPMConfig: !!pmConfig,
		});

		// =====================================================================
		// Step 1: Fetch context sources (parallel where possible)
		// =====================================================================

		const fetchedContext: {
			teamsMessages?: string;
			slackMessages?: string;
			meetingTranscripts?: string[];
			notionContent?: string[];
			ragContext?: string;
			architectureDecisions?: string;
			securityFindings?: string;
			applicationLogs?: string;
		} = {};

		/** Meetings were selected and not one of them yielded a transcript. */
		let meetingsRequestedButEmpty = false;

		// 1a. Fetch Teams messages
		const teamsPlan = planTeamsFetch({
			fetchTeamsMessages: contextSources.fetchTeamsMessages,
			selectedChannelContextIds: contextSources.selectedChannelContextIds,
		});

		if (teamsPlan.kind !== "skip" && !cancelled) {
			progress.status = "fetching_teams";
			progress.message =
				teamsPlan.kind === "scoped"
					? `Fetching recent Teams messages from ${teamsPlan.contextIds.length} selected channel(s)...`
					: "Fetching recent Teams messages...";

			try {
				const result = await fetchTeamsMessagesForBacklog({
					projectId,
					userId,
					organizationId,
					limit: 30,
					contextIds:
						teamsPlan.kind === "scoped"
							? teamsPlan.contextIds
							: undefined,
					daysBack: contextSources.daysBack,
				});
				if (result.success) {
					fetchedContext.teamsMessages = result.formattedMessages;
				}
				log.info("Fetched Teams messages", {
					messageCount: result.messageCount,
					scopedChannels:
						teamsPlan.kind === "scoped"
							? teamsPlan.contextIds.length
							: 0,
				});
			} catch (error) {
				log.warn("Failed to fetch Teams messages, continuing", {
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled by user",
				BACKLOG_ANALYSIS_CANCELLED_TYPE,
			);
		}

		// 1a-2. Fetch Slack messages
		if (contextSources.fetchSlackMessages && !cancelled) {
			progress.status = "fetching_slack";
			progress.message = "Fetching recent Slack messages...";

			try {
				const result = await fetchSlackMessagesForBacklog({
					projectId,
					userId,
					organizationId,
					limit: 30,
				});
				if (result.success) {
					fetchedContext.slackMessages = result.formattedMessages;
				}
				log.info("Fetched Slack messages", {
					messageCount: result.messageCount,
				});
			} catch (error) {
				log.warn("Failed to fetch Slack messages, continuing", {
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled by user",
				BACKLOG_ANALYSIS_CANCELLED_TYPE,
			);
		}

		// 1b. Fetch meeting transcripts
		if (
			contextSources.selectedMeetings &&
			contextSources.selectedMeetings.length > 0 &&
			!cancelled
		) {
			progress.status = "fetching_meetings";
			progress.message = `Fetching ${contextSources.selectedMeetings.length} meeting transcript(s)...`;

			const transcripts: string[] = [];
			if (patched("backlog-parallel-meeting-transcripts")) {
				// Fetch transcripts concurrently (bounded) instead of one at a
				// time. Each meeting is 3-4 sequential Graph calls, so serial
				// fetching made a 90-day / many-meeting selection take minutes.
				// patched() keeps recorded/in-flight histories on the legacy
				// sequential path below for deterministic replay.
				const CONCURRENCY = 6;
				const meetings = contextSources.selectedMeetings;
				for (let i = 0; i < meetings.length; i += CONCURRENCY) {
					if (cancelled) {
						break;
					}
					const chunk = meetings.slice(i, i + CONCURRENCY);
					const settled = await Promise.all(
						chunk.map((meeting) =>
							fetchMeetingTranscript({
								joinUrl: meeting.joinUrl,
								startTime: meeting.startTime,
								userId,
								organizationId,
								projectId,
							})
								.then((result) =>
									result.success && result.transcript
										? result.transcript
										: null,
								)
								.catch((error) => {
									log.warn(
										"Failed to fetch meeting transcript",
										{
											joinUrl: meeting.joinUrl,
											error:
												error instanceof Error
													? error.message
													: String(error),
										},
									);
									return null;
								}),
						),
					);
					for (const transcript of settled) {
						if (transcript) {
							transcripts.push(transcript);
						}
					}
				}
			} else {
				// Legacy sequential path — retained verbatim so histories
				// recorded before the parallel patch replay deterministically.
				for (const meeting of contextSources.selectedMeetings) {
					if (cancelled) {
						break;
					}
					try {
						const result = await fetchMeetingTranscript({
							joinUrl: meeting.joinUrl,
							startTime: meeting.startTime,
							userId,
							organizationId,
							projectId,
						});
						if (result.success && result.transcript) {
							transcripts.push(result.transcript);
						}
					} catch (error) {
						log.warn("Failed to fetch meeting transcript", {
							joinUrl: meeting.joinUrl,
							error:
								error instanceof Error
									? error.message
									: String(error),
						});
					}
				}
			}
			if (transcripts.length > 0) {
				fetchedContext.meetingTranscripts = transcripts;
			} else {
				// Every selected meeting came back without a transcript. Worth
				// remembering: it is the difference between "the meetings said
				// nothing new" and "we never read the meetings".
				meetingsRequestedButEmpty = true;
			}
		}

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled by user",
				BACKLOG_ANALYSIS_CANCELLED_TYPE,
			);
		}

		// 1c. Fetch Notion pages
		if (
			contextSources.notionPageIds &&
			contextSources.notionPageIds.length > 0 &&
			contextSources.notionMcpConfigId &&
			!cancelled
		) {
			progress.status = "fetching_notion";
			progress.message = `Fetching ${contextSources.notionPageIds.length} Notion page(s)...`;

			const notionContent: string[] = [];
			for (const pageId of contextSources.notionPageIds) {
				if (cancelled) {
					break;
				}
				try {
					const result = await fetchNotionPageContent({
						pageId,
						mcpConfigId: contextSources.notionMcpConfigId,
						userId,
						organizationId,
					});
					if (result.success && result.content) {
						notionContent.push(result.content);
					}
				} catch (error) {
					log.warn("Failed to fetch Notion page", {
						pageId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					});
				}
			}
			if (notionContent.length > 0) {
				fetchedContext.notionContent = notionContent;
			}
		}

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled by user",
				BACKLOG_ANALYSIS_CANCELLED_TYPE,
			);
		}

		// 1d. Fetch RAG context (always)
		progress.status = "fetching_rag";
		progress.message = "Retrieving project knowledge base...";

		try {
			const ragResult = await retrieveProjectRagContext({
				projectId,
				query: userPrompt,
				userId,
				organizationId,
				topK: 5,
			});
			if (ragResult.success) {
				fetchedContext.ragContext = ragResult.formattedContext;
			}
		} catch (error) {
			log.warn("Failed to retrieve RAG context, continuing", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled by user",
				BACKLOG_ANALYSIS_CANCELLED_TYPE,
			);
		}

		// Step 1e was added after this workflow had already started in
		// production. Gate it behind a patch marker so pre-change histories
		// replay the legacy sequence (RAG -> backlog snapshot) deterministically.
		if (patched("backlog-decisions-context-v1")) {
			// 1e. Fetch architecture decisions
			progress.status = "fetching_decisions";
			progress.message = "Checking project architecture decisions...";

			try {
				const decisionsResult = await fetchDecisionsForBacklog({
					projectId,
				});
				if (
					decisionsResult.success &&
					decisionsResult.formattedDecisions
				) {
					fetchedContext.architectureDecisions =
						decisionsResult.formattedDecisions;
				}
			} catch (error) {
				log.warn("Failed to fetch architecture decisions, continuing", {
					error:
						error instanceof Error ? error.message : String(error),
				});
			}

			if (cancelled) {
				throw ApplicationFailure.nonRetryable(
					"Cancelled by user",
					BACKLOG_ANALYSIS_CANCELLED_TYPE,
				);
			}
		}

		// This activity was added after the workflow entered production. Keep it
		// behind its own permanent patch marker so older histories replay the
		// legacy sequence deterministically.
		if (patched("backlog-security-context-v1")) {
			// 1f. Fetch security findings
			progress.status = "fetching_security";
			progress.message = "Checking project security findings...";

			try {
				const securityResult = await fetchSecurityFindingsForBacklog({
					projectId,
				});
				if (
					securityResult.success &&
					securityResult.formattedFindings
				) {
					fetchedContext.securityFindings =
						securityResult.formattedFindings;
				}
			} catch (error) {
				log.warn("Failed to fetch security findings, continuing", {
					error:
						error instanceof Error ? error.message : String(error),
				});
			}

			if (cancelled) {
				throw ApplicationFailure.nonRetryable(
					"Cancelled by user",
					BACKLOG_ANALYSIS_CANCELLED_TYPE,
				);
			}
		}

		// Step 1g (Fizzy #1234) is likewise newer than this workflow's first
		// production run, so it gets its own patch marker — a history recorded
		// before this shipped must replay the old sequence exactly.
		//
		// The activity itself is flag-gated and never throws: with the flag off
		// it returns an empty clause and an empty note, so the only cost on the
		// default path is one short activity round-trip.
		if (patched("backlog-application-logs-v1")) {
			// 1g. Fetch application logs as root-cause evidence
			progress.status = "fetching_logs";
			progress.message = "Checking application logs...";

			try {
				const logsResult = await fetchApplicationLogsForBacklog({
					projectId,
					userId,
					organizationId,
					terms: [userPrompt],
				});
				if (logsResult.clause) {
					fetchedContext.applicationLogs = logsResult.clause;
				}
				// FR3: the user is told why logs are or are not present. Only
				// surfaced once the feature is on — `disabled` carries no note
				// worth showing to someone who never asked for the feature.
				if (logsResult.status !== "disabled") {
					progress.logContextNote = logsResult.note;
				}
			} catch (error) {
				log.warn("Failed to fetch application logs, continuing", {
					error:
						error instanceof Error ? error.message : String(error),
				});
			}

			if (cancelled) {
				throw ApplicationFailure.nonRetryable(
					"Cancelled by user",
					BACKLOG_ANALYSIS_CANCELLED_TYPE,
				);
			}
		}

		// =====================================================================
		// Step 2: Fetch existing backlog (Fabric DB + PM tool)
		// =====================================================================

		progress.status = "fetching_backlog";
		progress.message = "Fetching existing backlog...";

		const backlogSnapshot = await fetchBacklogSnapshot({ projectId });

		// Flatten hierarchy for analysis input
		const existingBacklog = {
			epics: backlogSnapshot.epics.map((e) => ({
				id: e.id,
				identifier: e.identifier,
				title: e.title,
				description: e.description,
				externalId: e.externalId,
			})),
			features: [
				...backlogSnapshot.epics.flatMap((e) =>
					e.features.map((f) => ({
						id: f.id,
						identifier: f.identifier,
						title: f.title,
						description: f.description,
						epicId: e.id,
						externalId: f.externalId,
					})),
				),
				...backlogSnapshot.orphanFeatures.map((f) => ({
					id: f.id,
					identifier: f.identifier,
					title: f.title,
					description: f.description,
					epicId: null,
					externalId: f.externalId,
				})),
			],
			stories: [
				...backlogSnapshot.epics.flatMap((e) =>
					e.features.flatMap((f) =>
						f.stories.map((s) => ({
							id: s.id,
							identifier: s.identifier,
							title: s.title,
							description: s.description,
							featureId: f.id,
							externalId: s.externalId,
						})),
					),
				),
				...backlogSnapshot.orphanFeatures.flatMap((f) =>
					f.stories.map((s) => ({
						id: s.id,
						identifier: s.identifier,
						title: s.title,
						description: s.description,
						featureId: f.id,
						externalId: s.externalId,
					})),
				),
				...backlogSnapshot.orphanStories.map((s) => ({
					id: s.id,
					identifier: s.identifier,
					title: s.title,
					description: s.description,
					featureId: null,
					externalId: s.externalId,
				})),
			],
		};

		// Fetch PM work items if configured
		let pmToolType: string | undefined;
		let pmWorkItems:
			| {
					epics: Array<{
						id: string;
						title?: string;
						description?: string | null;
						url?: string | null;
					}>;
					features: Array<{
						id: string;
						title?: string;
						description?: string | null;
						url?: string | null;
					}>;
					stories: Array<{
						id: string;
						title?: string;
						description?: string | null;
						url?: string | null;
					}>;
			  }
			| undefined;

		if (pmConfig && !cancelled) {
			try {
				const pmResult = await fetchPMWorkItemsByType({
					projectId,
					mcpConfigId: pmConfig.mcpConfigId,
					containerId: pmConfig.containerId,
					additionalContext: pmConfig.additionalContext,
					userId,
					organizationId,
				});
				pmWorkItems = pmResult;
				pmToolType = pmResult.detectedType;
				log.info("Fetched PM work items", {
					epics: pmResult.epics.length,
					features: pmResult.features.length,
					stories: pmResult.stories.length,
					detectedType: pmToolType,
				});
			} catch (error) {
				log.warn("Failed to fetch PM work items, continuing", {
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled by user",
				BACKLOG_ANALYSIS_CANCELLED_TYPE,
			);
		}

		// =====================================================================
		// Step 3: Run LLM analysis
		// =====================================================================

		/**
		 * Do not ask the model to propose backlog changes from a meeting it was
		 * never given (Fizzy #2260).
		 *
		 * When Teams transcript ingest broke, runs reached this point with an
		 * empty transcript, no RAG hits and nothing else but the backlog — and
		 * the model dutifully proposed work anyway. A prod run on 20 Aug created
		 * three items off application logs and the existing backlog, none of
		 * which anyone had discussed; another was handed a two-day-old
		 * transcript and rewrote an unrelated item from it. To the person who
		 * asked for an update on today's meeting, both read as invention.
		 *
		 * The guard is deliberately narrow: it fires only when meetings were the
		 * request AND nothing else was gathered either. A run that also pulled
		 * Teams messages, Slack, Notion, logs or RAG still has something real to
		 * work from and proceeds, with the missing meetings noted.
		 */
		const gatheredAnythingElse = Object.entries(fetchedContext).some(
			([key, value]) =>
				key !== "meetingTranscripts" &&
				(Array.isArray(value) ? value.length > 0 : Boolean(value)),
		);
		// `patched()` is REQUIRED — this returns early where recorded histories
		// went on to call `analyzeContextAndPropose`. Replays of those histories
		// (patched() === false) must keep taking the old path.
		if (
			patched("backlog-skip-empty-meeting-context-v1") &&
			meetingsRequestedButEmpty &&
			!gatheredAnythingElse
		) {
			const skippedReason =
				"None of the selected meetings has a transcript available yet, and no other context was gathered — so there was nothing to base an update on. Nothing was proposed. Transcripts usually appear 60–90 minutes after a call, and a meeting that was never recorded will not produce one at all.";
			log.warn(
				"[BacklogAnalysis] Skipping proposal: no meeting content",
				{ projectId },
			);
			progress.status = "complete";
			progress.message = skippedReason;
			return { success: true, skippedReason };
		}

		progress.status = "analyzing";
		progress.message = "Analyzing context and proposing backlog changes...";

		proposal = await analyzeContextAndPropose({
			projectId,
			userId,
			organizationId,
			fetchedContext,
			existingBacklog,
			pmWorkItems,
			userPrompt,
			pmToolType,
			// Card #1365 async NFR: the user-interactive AI-Update path must not
			// block the proposal on the ~20s LLM judge. Skip the analyzer's inline
			// pre-check and run it as the separate post-return activity below so
			// the proposal is exposed immediately and conflicts surface after.
			deferDecisionPrecheck: true,
		});

		log.info("Analysis complete", {
			changeCount: proposal.changes.length,
			summary: proposal.summary,
		});

		// =====================================================================
		// Step 4: Return result
		// =====================================================================

		progress.status = "complete";
		progress.message = `Analysis complete. ${proposal.changes.length} change(s) proposed.`;

		// =====================================================================
		// Step 5 (card #1365): async decision pre-check.
		//
		// The proposal is already produced and EXPOSED via `analysisResultQuery`
		// at this point (status is "complete"), so the AI-Update sidebar's poll
		// receives it immediately — generation proceeds without waiting on the
		// judge. We then run the LLM judge OFF that critical path and fold the
		// result back into the queryable `proposal`, so a subsequent poll (and
		// the workflow's final returned result) carries `decisionConflicts`.
		//
		// We assign the result UNCONDITIONALLY — including the `status: "ok"`,
		// empty-findings case — so its mere PRESENCE tells the sidebar poll the
		// judge has finished. That lets the poll stop the instant the check
		// resolves (instead of polling blindly for its whole window on a clean
		// run) and lets the review card resolve its "checking…" indicator. The
		// render + the apply override log still gate on `status === "conflicts"`,
		// so an "ok" result surfaces nothing and logs nothing.
		//
		// `patched()` is REQUIRED — this adds a new activity call to the
		// workflow's command stream, so histories recorded before this change
		// would throw a non-determinism error on replay without the gate. Old
		// histories (patched() === false) skip it entirely and keep the pre-check
		// findings the pre-change inline path already baked into the proposal
		// result. The state write after the activity is a plain, deterministic
		// workflow-variable assignment (the `if`→unconditional change is
		// command-neutral, so it is replay-safe without a new patch). The
		// activity self-degrades (never throws) and is additionally wrapped in
		// try/catch so no failure can break the run.
		if (patched("backlog-decision-precheck-async-v1")) {
			try {
				const decisionConflicts =
					await runBacklogDecisionPrecheckActivity({
						projectId,
						userId,
						organizationId,
						changes: proposal.changes,
					});
				proposal.decisionConflicts = decisionConflicts;
			} catch (precheckError) {
				log.warn(
					"Backlog decision pre-check activity failed; returning proposal without warnings",
					{
						projectId,
						error:
							precheckError instanceof Error
								? precheckError.message
								: String(precheckError),
					},
				);
			}
		}

		// =====================================================================
		// Step 6: persist operation-result system message.
		// Identical structure to PR2's orchestrator completion phase —
		// `CancellationScope.nonCancellable` so AC-3 holds under late
		// cancel, `conversationId` short-circuit preserves today's
		// behaviour when the caller hasn't lazy-created a conversation.
		//
		// Why inline (not `startChild` like PR2's direct-chat fix):
		// The backlog procedure layer reads progress via `query()` (in-
		// memory, no `await handle.result()` on the user-facing path —
		// only as a 3-second-bounded fallback in `analysis-progress.ts`).
		// User-perceived completion latency is therefore decoupled from
		// the parent workflow's return time; the inline-await pattern
		// that hurt direct-chat (SSE polling `handle.result()`) does
		// not regress here.
		//
		// `operationKey` uses `workflowInfo().workflowId` (server-side
		// `backlog-analysis-${projectId}-${Date.now()}` from the route)
		// which Temporal preserves across workflow retries. Stable dedup.
		// =====================================================================
		if (conversationId) {
			// Local non-null narrow — `proposal` was assigned by
			// `analyzeContextAndPropose` above and is guaranteed defined
			// in this success branch (we return it on the next line).
			// TS can't infer this across the long success-path scope,
			// so we capture into a local `const` and let the `if (...)`
			// type-guard do the work. Code-reviewer #8 cleanup —
			// dropped the previous defensive `?.` chains that
			// contradicted the doc claim of "guaranteed defined".
			const finalProposal = proposal;
			try {
				await CancellationScope.nonCancellable(async () => {
					if (!finalProposal) {
						return;
					}
					await postOperationResultActivity({
						conversationId,
						userId,
						organizationId: organizationId ?? null,
						operationKey: `${workflowInfo().workflowId}-result`,
						outcome: "success",
						operationLabel: "Backlog analysis",
						summary:
							finalProposal.summary ||
							`Analysis complete. ${finalProposal.changes.length} change(s) proposed.`,
					});
				});
			} catch (postError) {
				log.warn(
					"Step 6 — operation-result message failed (non-fatal)",
					{
						conversationId,
						error:
							postError instanceof Error
								? postError.message
								: String(postError),
					},
				);
			}
		}

		return {
			success: true,
			proposal,
			// FR3: carried onto the terminal result too, not just progress —
			// a client that polls only after completion still learns why logs
			// were or were not part of the analysis.
			...(progress.logContextNote
				? { logContextNote: progress.logContextNote }
				: {}),
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);

		// Bug #391: when the failure originates from an activity throw, Temporal
		// wraps it in an ActivityFailure whose own .message is the generic
		// "Activity task failed". Walk the cause chain to recover the classified
		// message + errorClass the activity set (mirrors the sibling apply
		// workflow). Cancellation throws are ApplicationFailure raised directly
		// in this workflow, so they keep their own message.
		const isAppFailure = error instanceof ApplicationFailure;
		const unwrapped = isAppFailure ? null : unwrapPmSyncError(error);
		const displayMessage = unwrapped?.message ?? errorMessage;

		// Code-reviewer #1 fix: gate progress mutations behind the
		// `instanceof ApplicationFailure` check. Cancellation throws are
		// `ApplicationFailure.nonRetryable("Cancelled by user",
		// "BACKLOG_ANALYSIS_CANCELLED")` from the various cancellation
		// checkpoints above (L334, L367, L414, L461, L489, L619). Each of
		// those checkpoints sets `progress.status = "cancelled"` BEFORE
		// throwing. Pre-fix this catch unconditionally overwrote that to
		// `"failed"`, surfacing a cancelled run as `failed` to the
		// `query()` consumer in `analysis-progress.ts`. Mirrors the
		// sister `backlog-apply-changes-workflow.ts` catch shape so the
		// two workflows behave the same way.
		if (!isAppFailure) {
			log.error("Backlog context analysis workflow failed", {
				error: displayMessage,
				errorClass: unwrapped?.errorClass,
			});
			progress.status = "failed";
			progress.message = displayMessage;
			progress.error = displayMessage;
		}

		// Step 6.
		//
		// Code-reviewer #2 fix: distinguish "cancelled" from "failed" in
		// the persisted Step 6 row. AC-3 explicitly distinguishes the
		// two, the activity's `OperationOutcome` literal accepts
		// `"cancelled"`, and `<SystemMessage>` renders the outcome glyph
		// differently (✕ for failure, ⊘ for cancelled). Sniff the
		// `ApplicationFailure.type` set by the cancellation checkpoints
		// above so a user-cancelled run leaves the right semantic record
		// in the chat thread.
		//
		// The `isTerminal` guard (same as PR2's direct-chat catch /
		// Codex round-1 fix #1) only posts when the failure is
		// non-retryable, so a retried workflow can't be blocked by a
		// stale row at the dedup key. Cancellation throws are
		// nonRetryable by construction, so they always satisfy this.
		const isCancellation =
			error instanceof ApplicationFailure &&
			error.type === BACKLOG_ANALYSIS_CANCELLED_TYPE;
		const isTerminal =
			!(error instanceof ApplicationFailure) ||
			error.nonRetryable === true;
		if (conversationId && isTerminal) {
			const stepOutcome: "failure" | "cancelled" = isCancellation
				? "cancelled"
				: "failure";
			try {
				await CancellationScope.nonCancellable(async () => {
					await postOperationResultActivity({
						conversationId,
						userId,
						organizationId: organizationId ?? null,
						operationKey: `${workflowInfo().workflowId}-result`,
						outcome: stepOutcome,
						operationLabel: "Backlog analysis",
						summary: displayMessage,
					});
				});
			} catch (postError) {
				log.warn(
					"Step 6 — operation-result message failed (non-fatal)",
					{
						conversationId,
						error:
							postError instanceof Error
								? postError.message
								: String(postError),
					},
				);
			}
		}

		if (error instanceof ApplicationFailure) {
			throw error;
		}

		throw ApplicationFailure.nonRetryable(
			displayMessage,
			"BACKLOG_ANALYSIS_FAILED",
		);
	}
}
