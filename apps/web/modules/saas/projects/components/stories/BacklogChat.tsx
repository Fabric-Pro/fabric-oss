"use client";

import { useCoAgent, useCopilotAction } from "@copilotkit/react-core";
import { CopilotSidebar, useChatContext } from "@copilotkit/react-ui";
import type { DecisionPrecheckResult } from "@repo/agent-types";
import { CopilotAssistantMessageForBacklogUpdater } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { useCopilotChatSession } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import "@copilotkit/react-ui/styles.css";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CheckCircle2Icon,
	HistoryIcon,
	InfoIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import { orpc } from "../../../../shared/lib/orpc-query-utils";
import { resolveTeamsFetchDecision } from "../../lib/teams-fetch-decision";
import { BacklogChangeProposal } from "./BacklogChangeProposal";
import {
	type DaysBack,
	type ReviewSourcesResult,
	ReviewSourcesSelector,
} from "./ReviewSourcesSelector";
import { MEETINGS_STALE_TIME } from "./use-project-meetings";

type BacklogUpdaterState = {
	projectId: string;
	projectName: string;
	organizationId?: string;
	hasTeamsIntegration: boolean;
	hasSlackIntegration: boolean;
	hasNotionIntegration: boolean;
	hasPMTool: boolean;
	pmToolName?: string;
	backlogSummary: string;
	analysisStatus?: string;
	lastProposalSummary?: string;
	error?: string;
	retryCount: number;
};

type Props = {
	projectId: string;
	projectName: string;
	hasTeamsIntegration: boolean;
	hasSlackIntegration: boolean;
	hasNotionIntegration: boolean;
	hasPMTool: boolean;
	pmToolName?: string;
	pmConfig?: {
		mcpConfigId: string;
		containerId: string;
		additionalContext?: Record<string, string>;
	};
	backlogSummary: string;
	onClose: () => void;
	onChangesApplied: () => void;
	/** Open the AI Update window's read-only session history. */
	onOpenSessionHistory?: () => void;
};

/**
 * `agentId` value for backlog-session `AgentConversation` rows.
 *
 * MUST match the `agentId` seeded in
 * `packages/database/prisma/seed-system-agents.ts` (currently
 * `"backlog_updater"`) so future agent-catalog JOINs (icon rendering,
 * telemetry, conversation-list filtering) resolve the bot's identity
 * uniformly. The pre-review draft used a different string and would
 * have silently missed the seeded row.
 *
 * The Temporal-side mirror constant lives at
 * `packages/temporal/src/workflows/backlog-constants.ts`
 * (`BACKLOG_AGENT_ID`). The two cannot share a single import today
 * because `apps/web` does not depend on `@repo/temporal` for runtime
 * values; if/when a server-side validation pass is added to
 * `agents.conversations.create` (Codex round-2 follow-up), both
 * sides can collapse onto a single shared `@repo/utils` constant.
 */
const BACKLOG_AGENT_ID = "backlog_updater";

/**
 * Snapshot the AI Update chat into a compact {role, content}[] transcript for
 * the read-only Session history. Defensive — tolerates the AGUI/GQL message
 * shapes, skips non-text (action/result) messages, and caps count + length so
 * the persisted payload stays bounded. Never throws.
 */
function snapshotBacklogMessages(
	messages: unknown,
): { role: string; content: string }[] {
	if (!Array.isArray(messages)) {
		return [];
	}
	const out: { role: string; content: string }[] = [];
	for (const m of messages) {
		if (!m || typeof m !== "object") {
			continue;
		}
		const role = (m as { role?: unknown }).role;
		const content = (m as { content?: unknown }).content;
		if (
			(role === "user" || role === "assistant") &&
			typeof content === "string" &&
			content.trim().length > 0
		) {
			out.push({
				role,
				content:
					content.length > 4000
						? `${content.slice(0, 4000)}…`
						: content,
			});
		}
	}
	// Keep the most recent 60 messages to bound the persisted payload.
	return out.slice(-60);
}

/**
 * Custom CopilotSidebar header for the AI Update window. The default CopilotKit
 * header only carries the title + close (×); this one places the "Session
 * history" button right next to the close control. Mirrors the factory pattern
 * in `CopilotSidebarHeader.tsx` — CopilotKit instantiates `Header` with no
 * props, so the closure captures the parent's wiring.
 */
function createBacklogSidebarHeader(onOpenSessionHistory?: () => void) {
	function BacklogSidebarHeaderSlot() {
		// Same hook the default CopilotKit header uses for its close control.
		const { setOpen } = useChatContext();
		return (
			<TooltipProvider delayDuration={300}>
				<div className="flex items-center gap-2 border-border border-b bg-card px-4 py-2">
					<div className="min-w-0 flex-1">
						<span className="truncate font-medium text-foreground text-sm">
							AI Backlog Update
						</span>
					</div>
					{onOpenSessionHistory ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									onClick={onOpenSessionHistory}
									aria-label="Open AI Update session history"
									className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
								>
									<HistoryIcon
										className="size-4"
										aria-hidden="true"
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								<p>Session history</p>
							</TooltipContent>
						</Tooltip>
					) : null}
					<div
						aria-hidden="true"
						className="mx-0.5 h-5 w-px bg-border"
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								onClick={() => setOpen(false)}
								aria-label="Close the AI Update panel"
								className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
							>
								<XIcon className="size-4" aria-hidden="true" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Close</p>
						</TooltipContent>
					</Tooltip>
				</div>
			</TooltipProvider>
		);
	}
	return BacklogSidebarHeaderSlot;
}

export function BacklogChat({
	projectId,
	projectName,
	hasTeamsIntegration,
	hasSlackIntegration,
	hasNotionIntegration,
	hasPMTool,
	pmToolName,
	pmConfig,
	backlogSummary,
	onClose,
	onChangesApplied,
	onOpenSessionHistory,
}: Props) {
	const { organizationId } = useOrganizationContext();
	// We invalidate the failed-proposals count query after the apply
	// workflow's terminal state is observed — when the workflow stamps
	// the up-front PendingBacklogProposal row as FAILED, any failed-count
	// consumer needs to refetch without a page reload. The failed
	// proposal itself surfaces in the Review proposals inbox's Failed
	// group, where it can be retried.
	const queryClient = useQueryClient();

	// Local state for progress messages shown in render callbacks
	const [analysisProgressMsg, setAnalysisProgressMsg] = useState("");
	const [applyProgressMsg, setApplyProgressMsg] = useState("");
	// Proposal id of the in-flight apply — set once the workflow is dispatched,
	// cleared when the apply concludes. Drives the "Cancel" control on the
	// progress banner so the user can stop a hung apply immediately.
	const [applyingProposalId, setApplyingProposalId] = useState<string | null>(
		null,
	);

	// Cancel a hung apply: stops the workflow + flips the proposal to FAILED so
	// the user can retry from the backlog. No toast on purpose — in-chat toasts
	// disappear on CopilotKit re-render (Spec §3.7c regression guard), so the
	// confirmation is the progress banner resolving to its terminal state on the
	// next poll (the "Cancelling…" button bridges the gap).
	const cancelApply = useCallback(
		async (proposalId: string) => {
			try {
				await orpcClient.projects.backlog.proposals.cancel({
					projectId,
					organizationId: organizationId ?? null,
					proposalId,
				});
				// Refresh the failed-count so the Review proposals banner picks
				// up the now-FAILED row.
				queryClient.invalidateQueries({
					queryKey: [
						"projects.backlog.proposals.failedCount",
						projectId,
						organizationId ?? null,
					],
				});
			} catch (err) {
				// Non-fatal: nothing was cancelled, so the apply keeps running
				// and the banner continues polling to its natural terminal state.
				console.warn("[BacklogChat] Cancel apply failed", err);
			}
		},
		[projectId, organizationId, queryClient],
	);

	// Card #1365: watch the analysis workflow's queryable state for the decision
	// pre-check result the async judge folds in AFTER the proposal is exposed
	// (workflow Step 5). The analyze poll returns on the first "complete" to keep
	// generation off the judge's critical path, so this short, separate poll is
	// what actually delivers the result to the review card — it seeds
	// `analysisDecisionConflicts` (read by the render, so the inline
	// `DecisionConflictNote` appears) and mirrors onto the cached proposal so the
	// accept relay carries the findings for the override log.
	//
	// The workflow stamps the result UNCONDITIONALLY (status "ok" when clean), so
	// its mere PRESENCE means the judge finished: the poll stops the instant the
	// check resolves — a clean run no longer polls for the whole window — and the
	// "checking…" indicator clears. Also self-limits when a newer analysis
	// supersedes this workflow, the component unmounts, a read errors, or the
	// window elapses.
	const pollForDecisionConflicts = useCallback(
		async (workflowId: string) => {
			decisionPrecheckPollWorkflowRef.current = workflowId;
			const maxWaitMs = 45000;
			const intervalMs = 2500;
			const startedAt = Date.now();
			// Does this poll still own the current analysis? Guards the conflict
			// WRITE so a superseded poll can't stamp an old run's findings onto a
			// newer proposal.
			const ownsWorkflow = () =>
				decisionPrecheckPollWorkflowRef.current === workflowId;
			// Clearing the "checking…" indicator is ALWAYS safe — a superseding
			// analysis manages its own pending state — so it is gated only on mount,
			// NEVER on `ownsWorkflow`, whose mismatch must not be able to strand the
			// indicator. Runs from `finally` so EVERY exit (result, supersede,
			// error, timeout, unmount) clears it: the transient can never stick.
			const stopChecking = () => {
				if (isMountedRef.current) {
					setDecisionPrecheckPending(false);
				}
			};
			try {
				while (Date.now() - startedAt < maxWaitMs) {
					await new Promise((resolve) =>
						setTimeout(resolve, intervalMs),
					);
					// Unmounted → stop silently; superseded → stop (finally clears).
					if (!isMountedRef.current || !ownsWorkflow()) {
						return;
					}
					const progress =
						await orpcClient.projects.backlog.analysisProgress({
							projectId,
							workflowId,
						});
					const folded = progress.proposal?.decisionConflicts;
					if (folded) {
						// Judge finished — record the FULL result (conflicts OR a
						// clean "ok") while this poll still owns the (unsuperseded)
						// proposal; `finally` clears "checking…" regardless. Storing
						// "ok" too lets the accept relay tell the server the check
						// already ran clean, so apply doesn't redundantly re-judge.
						// The render still gates the note on `status === "conflicts"`.
						if (ownsWorkflow() && isMountedRef.current) {
							setAnalysisDecisionConflicts(folded);
							// Mirror onto the cached proposal so the accept relay
							// (which reads the ref) carries the result for the
							// override log even if a re-render is missed.
							if (analysisProposalRef.current) {
								analysisProposalRef.current.decisionConflicts =
									folded;
							}
						}
						return;
					}
				}
			} catch {
				// Best-effort: a failed progress read just means no note this run;
				// the proposal and accept flow are unaffected.
			} finally {
				stopChecking();
			}
		},
		[projectId],
	);
	const [analysisResult, setAnalysisResult] = useState<{
		changeCount: number;
		summary: string;
		contextSummary: string;
		status: "complete" | "failed" | "timeout";
		/**
		 * Why application logs were or were not part of this analysis
		 * (Fizzy #1234 FR3). Absent unless the log-context feature is on.
		 */
		logContextNote?: string;
	} | null>(null);

	// Ref to store the full analysis proposal so review_backlog_changes
	// can access it without the agent needing to pass the large payload
	const analysisProposalRef = useRef<any>(null);

	// Card #1365: the interactive AI-Update decision pre-check is ASYNC. The
	// workflow exposes the proposal at status "complete" and folds the LLM
	// judge's conflict findings into its queryable state a beat later (Step 5),
	// so the analyze poll below — which returns the instant the proposal is ready
	// (NFR: never block generation on the ~1–20s judge) — cannot carry them. We
	// hold the folded result here so the already-rendered review card can surface
	// the inline `DecisionConflictNote` and the accept path can relay it for the
	// override log.
	const [analysisDecisionConflicts, setAnalysisDecisionConflicts] =
		useState<DecisionPrecheckResult | null>(null);
	// True while the async pre-check poll is in flight (judge running) so the
	// review card can show a "checking…" indicator; cleared the instant the judge
	// resolves (ok or conflicts), or on supersede / unmount / error / timeout.
	const [decisionPrecheckPending, setDecisionPrecheckPending] =
		useState(false);
	// Workflow id currently being watched for a late pre-check fold, so a fresh
	// analysis supersedes an in-flight background poll instead of racing it.
	const decisionPrecheckPollWorkflowRef = useRef<string | null>(null);
	// Tracks mount state so the fire-and-forget poll never setState after unmount
	// and stops scheduling its timers once the panel closes.
	const isMountedRef = useRef(true);
	useEffect(() => {
		return () => {
			isMountedRef.current = false;
			// Retire any in-flight late-fold poll on unmount.
			decisionPrecheckPollWorkflowRef.current = null;
		};
	}, []);
	// Defensive backstop for the "checking…" indicator: it is a transient that
	// must resolve within the poll's window, so this component-owned timer
	// guarantees it clears even if the poll that set it never delivers a clear to
	// THIS instance (e.g. a torn-down / re-mounted panel). Belt-and-suspenders on
	// top of the poll's own `finally` clear — a stuck indicator is worse than an
	// early one. Re-armed each time pending flips true; cancelled when it clears.
	useEffect(() => {
		if (!decisionPrecheckPending) {
			return;
		}
		const timeout = setTimeout(() => {
			if (isMountedRef.current) {
				setDecisionPrecheckPending(false);
			}
		}, 48000);
		return () => clearTimeout(timeout);
	}, [decisionPrecheckPending]);

	// Guard: prevent duplicate/retried analyze_backlog calls
	const isAnalyzingRef = useRef(false);

	// Live CopilotKit chat messages, mirrored into a ref so the apply callback
	// can snapshot the conversation into the Session history without a
	// re-render race. Read from the surface's `<CopilotChatSessionProvider>`
	// (mounted by `BacklogChatPanel`) rather than a local
	// `useCopilotChatInternal()`: on 1.70 each call of that hook opens its
	// own `agent/connect` (Fizzy #2389). Read-only here.
	const { messages: liveCopilotMessages } = useCopilotChatSession();
	const liveMessagesRef = useRef<unknown[]>([]);
	useEffect(() => {
		liveMessagesRef.current = Array.isArray(liveCopilotMessages)
			? liveCopilotMessages
			: [];
	}, [liveCopilotMessages]);

	// Warm the meetings list in the background as soon as the AI Update panel
	// mounts, so the source selector's meetings dropdown is already populated by
	// the time the user reaches it (the underlying Microsoft Graph call is the
	// slow part). Fire once, and only when Teams is connected — otherwise there
	// are no calendar meetings to list. Shares the exact query key the selector
	// reads (default 30-day range), so the selector renders from cache instantly.
	const didPrefetchMeetingsRef = useRef(false);
	useEffect(() => {
		if (didPrefetchMeetingsRef.current || !hasTeamsIntegration) {
			return;
		}
		didPrefetchMeetingsRef.current = true;
		void queryClient.prefetchQuery({
			...orpc.projects.backlog.listMeetings.queryOptions({
				input: {
					projectId,
					organizationId: organizationId ?? null,
					daysBack: 30,
				},
			}),
			staleTime: MEETINGS_STALE_TIME,
		});
	}, [hasTeamsIntegration, projectId, organizationId, queryClient]);

	// Lazy-created `AgentConversation` for the backlog
	// session. Held in a ref (not state) so concurrent useCopilotAction
	// callbacks see the same identifier without a re-render race. The
	// conversation is created on the FIRST operation (analyze or apply)
	// that requests it via `ensureBacklogConversationId`; subsequent
	// operations reuse the same id, so retries / partial successes /
	// follow-up apply runs all post their Step 6 message into one
	// thread (and dedup on `${workflowId}-result` operationKey).
	//
	// Choice: ref + lazy-create (not eager on mount) — matches today's
	// transient-by-default UX for users who open BacklogChat but never
	// run an operation. Eager-on-mount would create empty conversations
	// on every page visit. The id is not exposed in the URL today; PR3
	// keeps it ephemeral to the in-page session (refresh = new
	// conversation, matching the rest of the surface's volatility).
	//
	// `agentId: BACKLOG_AGENT_ID` — see the constant declaration below.
	const backlogConversationIdRef = useRef<string | null>(null);
	// Code-reviewer #3 fix — cache the IN-FLIGHT Promise (not just the
	// resolved id). Without this, two callers entering
	// `ensureBacklogConversationId` before the first `create` resolves
	// would both observe `current === null` and each fire a `create`,
	// producing two conversations for the same backlog session. The
	// natural analyze → apply sequence rarely hits this in practice,
	// but React Strict Mode's effect-double-invoke in dev would
	// trigger it during interactive work, and any future caller from
	// an `useEffect` would too. The promise cache is module-local to
	// the component instance.
	const backlogConversationCreatingRef = useRef<Promise<string> | null>(null);
	const ensureBacklogConversationId = (): Promise<string> => {
		if (backlogConversationIdRef.current) {
			return Promise.resolve(backlogConversationIdRef.current);
		}
		if (backlogConversationCreatingRef.current) {
			return backlogConversationCreatingRef.current;
		}
		backlogConversationCreatingRef.current = (async () => {
			try {
				const created = await orpcClient.agents.conversations.create({
					agentId: BACKLOG_AGENT_ID,
					organizationId: organizationId ?? null,
					title: "Backlog session",
				});
				backlogConversationIdRef.current = created.id;
				return created.id;
			} finally {
				// Clear the in-flight promise so a subsequent FAILED
				// create can be retried. (If the create succeeds, the
				// resolved-id ref short-circuits before this line is
				// ever hit again.)
				backlogConversationCreatingRef.current = null;
			}
		})();
		return backlogConversationCreatingRef.current;
	};

	// State for apply result (shown as a card after workflow completes).
	// `failedCount` + `batchTotal` make the AC #5 batch summary
	// ("30 of 32 added to roadmap — 2 failed, click to retry") visible in
	// the in-chat result card so the user doesn't have to navigate to the
	// roadmap banner to discover partial-failure context.
	const [applyResult, setApplyResult] = useState<{
		status: "success" | "failed";
		createdCount: number;
		updatedCount: number;
		failedCount: number;
		skippedCount?: number;
		batchTotal: number;
		syncedToPM: boolean;
		items: {
			identifier: string;
			title: string;
			type: string;
			_action?: string;
			reason?: string;
		}[];
		message: string;
		pmSyncOutage?: {
			tool: string;
			errorClass: string;
			count: number;
			items: Array<{
				id: string;
				itemType: "epic" | "feature" | "story" | "bug";
			}>;
		};
	} | null>(null);

	// Sync agent state with CopilotKit
	const { state: _state, setState } = useCoAgent<BacklogUpdaterState>({
		name: "backlog_updater",
		initialState: {
			projectId,
			projectName,
			organizationId: organizationId ?? undefined,
			hasTeamsIntegration,
			hasSlackIntegration,
			hasNotionIntegration,
			hasPMTool,
			pmToolName,
			backlogSummary,
			analysisStatus: undefined,
			lastProposalSummary: undefined,
			error: undefined,
			retryCount: 0,
			// Declare reasoningByTurn in initialState so CopilotKit's
			// useCoAgent doesn't filter it out of STATE_SNAPSHOT updates.
			// Without this key, reasoning events emitted by chat-node.ts
			// arrive on the SSE wire but are dropped before reaching
			// CopilotAssistantMessageForBacklogUpdater's subscription.
			// Same rationale as DocumentEditor.tsx:1286.
			reasoningByTurn: {},
		},
	});

	// =========================================================================
	// Frontend Actions — registered as tools available to the LangGraph agent
	// =========================================================================

	// Action: select_review_sources — Combined meetings + Teams channels/chats selector
	useCopilotAction({
		name: "select_review_sources",
		description:
			"Show a combined selector for the user to choose meetings and/or project-linked Teams channels and group chats to review, within a shared date-range window.",
		parameters: [],
		renderAndWaitForResponse: ({ respond }) => {
			return (
				<ReviewSourcesSelector
					projectId={projectId}
					organizationId={organizationId ?? null}
					onConfirm={(result: ReviewSourcesResult) => {
						respond?.(result);
					}}
					onCancel={() => {
						respond?.({
							selectedMeetings: [],
							selectedChannels: [],
							daysBack: 30,
						} satisfies ReviewSourcesResult);
					}}
				/>
			);
		},
	});

	// Action: select_notion_pages — Show Notion page selector
	useCopilotAction({
		name: "select_notion_pages",
		description:
			"Show a Notion page selector for the user to choose pages to analyze",
		parameters: [],
		renderAndWaitForResponse: ({ respond }) => {
			return (
				<NotionPageSelector
					onSkip={() => respond?.({ pageIds: [], mcpConfigId: "" })}
				/>
			);
		},
	});

	// Action: analyze_backlog — Start analysis workflow, show progress, return results
	// Uses handler + render instead of renderAndWaitForResponse to avoid stale-respond
	// issues with long-running async operations (80+ second Temporal workflows)
	useCopilotAction({
		name: "analyze_backlog",
		description: "Start backlog analysis with the selected context sources",
		parameters: [
			{
				name: "fetchSlackMessages",
				type: "boolean",
				description: "Whether to fetch recent Slack messages",
				required: false,
			},
			{
				name: "selectedMeetings",
				type: "object[]",
				description:
					"Selected meetings with join URLs and optional start times",
				required: false,
			},
			{
				name: "selectedChannels",
				type: "object[]",
				description:
					"Project-linked Teams channels and group chats (array of { projectContextId: string }) the user chose to include as context.",
				required: false,
			},
			{
				name: "daysBack",
				type: "number",
				description:
					"Shared date-range window in days (7, 14, 30, 60, or 90). Applies to meetings AND Teams messages.",
				required: false,
			},
			{
				name: "notionPageIds",
				type: "string[]",
				description: "IDs of selected Notion pages",
				required: false,
			},
			{
				name: "notionMcpConfigId",
				type: "string",
				description: "MCP config ID for Notion",
				required: false,
			},
			{
				name: "userPrompt",
				type: "string",
				description: "The user's request for what to analyze",
				required: true,
			},
		],
		handler: async (args) => {
			if (isAnalyzingRef.current) {
				return "Analysis is already in progress. Please wait for it to complete.";
			}
			isAnalyzingRef.current = true;
			try {
				setAnalysisResult(null);
				setApplyResult(null);
				setAnalysisProgressMsg("Starting analysis...");

				const teamsFetch = resolveTeamsFetchDecision({
					selectedChannels: args.selectedChannels as
						| Array<{ projectContextId: string }>
						| undefined,
				});

				// Ensure (lazy-create on first call) the
				// AgentConversation for this backlog session, then forward
				// its id into the workflow input. The Temporal
				// `backlogContextAnalysisWorkflow` body's Step 6 appends
				// a persistent operation-result `role: "system"` message
				// on completion (`${workflowId}-result` operationKey for
				// dedup).
				//
				// Code-reviewer #4 fix: tolerate a `create` failure. The
				// Step 6 system message is a NICE-TO-HAVE side effect;
				// blocking the actual `startAnalysis` because a chat
				// row couldn't be created would be a clear regression.
				// On failure we log + proceed with `conversationId =
				// undefined`, which makes the workflow's Step 6
				// short-circuit (`if (conversationId)` guard). User sees
				// the analyze proceed normally; just no persistent
				// "operation complete" row at the end.
				let conversationId: string | undefined;
				try {
					conversationId = await ensureBacklogConversationId();
				} catch (createError) {
					console.warn(
						"[BacklogChat] Failed to create backlog conversation; system message will be skipped for this run.",
						createError,
					);
				}

				// Fresh analysis: drop any conflict note / pending state from a
				// previous run and retire an in-flight late-fold poll (the new
				// workflow id below supersedes it via
				// `decisionPrecheckPollWorkflowRef`).
				setAnalysisDecisionConflicts(null);
				setDecisionPrecheckPending(false);
				decisionPrecheckPollWorkflowRef.current = null;

				const result = await orpcClient.projects.backlog.startAnalysis({
					projectId,
					organizationId: organizationId ?? null,
					contextSources: {
						fetchTeamsMessages: teamsFetch.fetchTeamsMessages,
						fetchSlackMessages:
							args.fetchSlackMessages ?? hasSlackIntegration,
						selectedMeetings:
							(args.selectedMeetings as Array<{
								joinUrl: string;
								startTime?: string;
							}>) ?? [],
						selectedChannelContextIds:
							teamsFetch.selectedChannelContextIds,
						daysBack: args.daysBack as DaysBack | undefined,
						notionPageIds: args.notionPageIds ?? [],
						notionMcpConfigId: args.notionMcpConfigId,
					},
					pmConfig,
					userPrompt:
						args.userPrompt ??
						"Analyze context and suggest backlog updates",
					conversationId,
				});

				if (!result.workflowId) {
					return "Failed to start analysis workflow.";
				}

				// Poll for progress until complete or timeout
				const maxPollTime = 300000; // 5 minutes
				const pollInterval = 2000;
				const startTime = Date.now();

				while (Date.now() - startTime < maxPollTime) {
					await new Promise((resolve) =>
						setTimeout(resolve, pollInterval),
					);

					try {
						const progress =
							await orpcClient.projects.backlog.analysisProgress({
								projectId,
								workflowId: result.workflowId,
							});

						setAnalysisProgressMsg(
							progress.progress?.message ?? "Analyzing...",
						);

						if (
							progress.progress?.status === "complete" &&
							progress.proposal
						) {
							// Store full proposal for review_backlog_changes
							analysisProposalRef.current = progress.proposal;

							// Card #1365: the decision pre-check is folded in
							// asynchronously AFTER "complete". If it already rode
							// along (fast judge, or the pre-change inline path),
							// record the FULL result now (conflicts OR clean "ok",
							// so the accept relay can tell the server it already ran);
							// otherwise mark the check pending and keep a short
							// background poll alive to pick up the late fold without
							// delaying this handler's return (proposal shows at once).
							const foldedAtComplete =
								progress.proposal.decisionConflicts;
							if (foldedAtComplete) {
								setAnalysisDecisionConflicts(foldedAtComplete);
								setDecisionPrecheckPending(false);
							} else {
								setDecisionPrecheckPending(true);
								void pollForDecisionConflicts(
									result.workflowId,
								);
							}

							setState(
								(prev) =>
									({
										...(prev ?? {}),
										analysisStatus: "complete",
										lastProposalSummary:
											progress.proposal.summary,
									}) as BacklogUpdaterState,
							);

							const changeCount =
								progress.proposal.changes?.length ?? 0;
							setAnalysisResult({
								changeCount,
								summary: progress.proposal.summary ?? "",
								contextSummary:
									progress.proposal.contextSummary ?? "",
								status: "complete",
								logContextNote:
									progress.progress?.logContextNote,
							});
							return `Analysis complete. ${changeCount} change(s) proposed. ${progress.proposal.summary ?? "Review the proposed changes."}`;
						}

						if (progress.progress?.status === "failed") {
							setState(
								(prev) =>
									({
										...(prev ?? {}),
										analysisStatus: "failed",
										error: progress.progress?.message,
									}) as BacklogUpdaterState,
							);
							setAnalysisResult({
								changeCount: 0,
								summary:
									progress.progress.message ??
									"Analysis failed",
								contextSummary: "",
								status: "failed",
								logContextNote:
									progress.progress?.logContextNote,
							});
							return `Analysis failed: ${progress.progress.message}`;
						}
					} catch (err) {
						setState(
							(prev) =>
								({
									...(prev ?? {}),
									analysisStatus: "failed",
									error:
										err instanceof Error
											? err.message
											: "Failed to check progress",
								}) as BacklogUpdaterState,
						);
						return `Analysis error: ${err instanceof Error ? err.message : "Failed to check progress"}`;
					}
				}

				setAnalysisResult({
					changeCount: 0,
					summary:
						"Analysis timed out after 5 minutes. Please try again.",
					contextSummary: "",
					status: "timeout",
				});
				return "Analysis timed out after 5 minutes. Please try again.";
			} catch (err) {
				const errorMsg =
					err instanceof Error
						? err.message
						: "Failed to start analysis";
				setState(
					(prev) =>
						({
							...(prev ?? {}),
							analysisStatus: "failed",
							error: errorMsg,
						}) as BacklogUpdaterState,
				);
				setAnalysisResult({
					changeCount: 0,
					summary: errorMsg,
					contextSummary: "",
					status: "failed",
				});
				return `Analysis error: ${errorMsg}`;
			} finally {
				isAnalyzingRef.current = false;
			}
		},
		render: ({ status }) => {
			// Show result card when analysis is complete
			if (status === "complete" && analysisResult) {
				// FR3 (Fizzy #1234): say why application logs were or were
				// not used. Only present once the log-context feature is on,
				// so this renders nothing for everyone else.
				const logNote = analysisResult.logContextNote ? (
					<p className="text-xs text-muted-foreground border-t pt-2 mt-2">
						{analysisResult.logContextNote}
					</p>
				) : null;
				if (
					analysisResult.status === "failed" ||
					analysisResult.status === "timeout"
				) {
					return (
						<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-2">
							<div className="flex items-center gap-2">
								<XCircleIcon className="size-4 text-destructive" />
								<p className="text-sm font-medium">
									Analysis{" "}
									{analysisResult.status === "timeout"
										? "Timed Out"
										: "Failed"}
								</p>
							</div>
							<p className="text-xs text-muted-foreground">
								{analysisResult.summary}
							</p>
							{logNote}
						</div>
					);
				}
				if (analysisResult.changeCount === 0) {
					return (
						<div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/30 p-4 space-y-2">
							<div className="flex items-center gap-2">
								<InfoIcon className="size-4 text-blue-600 dark:text-blue-400" />
								<p className="text-sm font-medium">
									No Backlog Changes Needed
								</p>
							</div>
							{analysisResult.contextSummary && (
								<p className="text-xs text-muted-foreground">
									{analysisResult.contextSummary}
								</p>
							)}
							<p className="text-xs text-muted-foreground">
								{analysisResult.summary}
							</p>
							{logNote}
						</div>
					);
				}
				return (
					<div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30 p-4 space-y-2">
						<div className="flex items-center gap-2">
							<CheckCircle2Icon className="size-4 text-success dark:text-green-400" />
							<p className="text-sm font-medium">
								Analysis Complete — {analysisResult.changeCount}{" "}
								change(s) found
							</p>
						</div>
						<p className="text-xs text-muted-foreground">
							{analysisResult.summary}
						</p>
						{logNote}
					</div>
				);
			}

			// Show progress during analysis
			return (
				<div className="rounded-lg border p-4 space-y-2">
					<div className="flex items-center gap-2">
						<div className="size-2 rounded-full bg-blue-500 animate-pulse" />
						<p className="text-sm font-medium">Analyzing Context</p>
					</div>
					<p className="text-xs text-muted-foreground">
						{analysisProgressMsg || "Starting analysis..."}
					</p>
				</div>
			);
		},
	});

	// Action: review_backlog_changes — Present change proposal for review
	useCopilotAction({
		name: "review_backlog_changes",
		description:
			"Present the change proposal to the user for review and approval",
		parameters: [
			{
				name: "summary",
				type: "string",
				description: "Summary of the proposed changes",
				required: false,
			},
			{
				name: "contextSummary",
				type: "string",
				description: "Summary of the analyzed context",
				required: false,
			},
			{
				name: "changes",
				type: "object[]",
				description: "Array of proposed changes",
				required: false,
			},
		],
		renderAndWaitForResponse: ({ args, respond }) => {
			// Use stored proposal from analysis when available (agent
			// doesn't need to pass the full payload through tool args)
			const storedProposal = analysisProposalRef.current;
			const useStored = (storedProposal?.changes?.length ?? 0) > 0;
			const changes = useStored
				? storedProposal.changes
				: (args.changes ?? []);
			const summary = storedProposal?.summary ?? args.summary ?? "";
			const contextSummary =
				storedProposal?.contextSummary ?? args.contextSummary ?? "";
			// Async decision pre-check result riding on the workflow proposal
			// (no persisted row exists at review time). Prefer the findings the
			// background poll folded in a beat after "complete" (card #1365),
			// falling back to any that already rode along on the stored proposal.
			const decisionConflicts =
				analysisDecisionConflicts ??
				storedProposal?.decisionConflicts ??
				null;

			return (
				<BacklogChangeProposal
					panel="ai-update"
					summary={summary}
					contextSummary={contextSummary}
					changes={changes}
					decisionConflicts={decisionConflicts}
					decisionPrecheckPending={decisionPrecheckPending}
					hasPMTool={hasPMTool}
					pmToolName={pmToolName}
					projectId={projectId}
					organizationId={organizationId ?? null}
					applyProgressMsg={applyProgressMsg}
					onCancelApply={
						applyingProposalId
							? () => cancelApply(applyingProposalId)
							: undefined
					}
					applyResult={applyResult}
					onApprove={async (
						approvedChanges,
						syncToPM,
						pmSyncOverrides,
					) => {
						// We deliberately keep `analysisProposalRef.current`
						// populated through the apply attempt so a per-item
						// failure (workflow errors out, PM auth lapses, etc.)
						// does NOT erase the local cache mid-recovery. The
						// ref is cleared on the success branch below once
						// every item has been applied.

						// Bypass the LLM entirely for the apply step.
						// The LLM often calls analyze_backlog instead of apply_backlog_changes,
						// so we directly call the apply API here.
						setApplyProgressMsg("Starting to apply changes...");

						const shouldSync = syncToPM && hasPMTool && !!pmConfig;

						try {
							// Reuse (or lazy-create) the
							// same `AgentConversation` the analyze step
							// used. The apply phase's Step 6 lands in the
							// same thread as the analyze phase's Step 6,
							// so the user sees a chronological pair of
							// system messages tied to the same session.
							//
							// Code-reviewer #4 fix: identical
							// defensive shape to the analyze handler —
							// a `create` failure must not block the
							// apply workflow itself; Step 6 simply
							// short-circuits.
							let conversationId: string | undefined;
							try {
								conversationId =
									await ensureBacklogConversationId();
							} catch (createError) {
								console.warn(
									"[BacklogChat] Failed to create backlog conversation; system message will be skipped for this apply run.",
									createError,
								);
							}
							const result =
								await orpcClient.projects.backlog.applyChanges({
									projectId,
									organizationId: organizationId ?? null,
									approvedChanges,
									syncToPM: shouldSync,
									pmConfig:
										shouldSync && pmConfig
											? pmConfig
											: undefined,
									pmSyncOverrides,
									conversationId,
									messages: snapshotBacklogMessages(
										liveMessagesRef.current,
									),
									// The decision pre-check is NOT relayed for the
									// override log — the server re-runs the judge at
									// apply time so the WORM ledger can't be
									// suppressed by client input (card #1365). The
									// inline note the user sees still comes from the
									// poll above.
								});

							if (!result.workflowId) {
								respond?.("No changes to apply.");
								return;
							}

							// Workflow dispatched — expose the proposal id so the
							// progress banner can offer a Cancel control.
							setApplyingProposalId(result.proposalId ?? null);

							const maxPollTime = 300000;
							const pollInterval = 2000;
							const startTime = Date.now();

							while (Date.now() - startTime < maxPollTime) {
								await new Promise((resolve) =>
									setTimeout(resolve, pollInterval),
								);

								try {
									const progress =
										await orpcClient.projects.backlog.applyProgress(
											{
												projectId,
												workflowId: result.workflowId,
											},
										);

									setApplyProgressMsg(
										progress.message ?? "Applying...",
									);

									if (progress.status === "completed") {
										const created =
											progress.createdItems ?? [];
										const updated =
											progress.updatedItems ?? [];
										const appliedTotal =
											created.length + updated.length;
										const progressErrors =
											(
												progress as {
													errors?: string[];
												}
											).errors ?? [];
										const skipped =
											(
												progress as {
													skippedItems?: Array<{
														type: string;
														title: string;
														identifier: string;
														reason: string;
													}>;
												}
											).skippedItems ?? [];
										const failed =
											(
												progress as {
													failedItems?: Array<{
														type: string;
														title: string;
														reason: string;
													}>;
												}
											).failedItems ?? [];
										// All-skipped (every proposed create already existed) is
										// NOT a failure; only a genuine non-apply with at least one
										// hard failure counts as "nothing applied".
										const nothingApplied =
											appliedTotal === 0 &&
											failed.length > 0;

										if (!nothingApplied) {
											onChangesApplied();
										}

										const allItems = [
											...created.map(
												(
													i: Record<string, unknown>,
												) => ({
													...i,
													_action: "created",
												}),
											),
											...updated.map(
												(
													i: Record<string, unknown>,
												) => ({
													...i,
													_action: "updated",
												}),
											),
											...skipped.map((sk) => ({
												type: sk.type,
												identifier: sk.identifier,
												title: sk.title,
												_action: "skipped",
												reason: sk.reason,
											})),
											...failed.map((fl) => ({
												type: fl.type,
												identifier: "",
												title: fl.title,
												_action: "failed",
												reason: fl.reason,
											})),
										];

										const batchTotal =
											approvedChanges.length;
										const failedCount = failed.length;
										const skippedCount = skipped.length;
										const partialFailure =
											!nothingApplied && failedCount > 0;
										const allSkipped =
											appliedTotal === 0 &&
											failedCount === 0 &&
											skippedCount > 0;
										setApplyResult({
											status: nothingApplied
												? "failed"
												: "success",
											createdCount: created.length,
											updatedCount: updated.length,
											failedCount,
											skippedCount,
											batchTotal,
											syncedToPM: shouldSync,
											items: allItems,
											message: nothingApplied
												? progressErrors.length > 0
													? progressErrors.join("; ")
													: "No items were applied — they may not have been found in the backlog"
												: allSkipped
													? `All ${skippedCount} item(s) already existed in the backlog — nothing new to add`
													: partialFailure
														? `${appliedTotal} of ${batchTotal} added to roadmap${skippedCount > 0 ? `, ${skippedCount} skipped` : ""} — ${failedCount} failed, open Review proposals to retry`
														: skippedCount > 0
															? `${appliedTotal} item(s) applied, ${skippedCount} skipped (already existed)`
															: `${appliedTotal} item(s) applied`,
											pmSyncOutage:
												(
													progress as {
														pmSyncOutage?: {
															tool: string;
															errorClass: string;
															count: number;
															items: Array<{
																id: string;
																itemType:
																	| "epic"
																	| "feature"
																	| "story"
																	| "bug";
															}>;
														};
													}
												).pmSyncOutage ?? undefined,
										});

										// Failed-count refetch so any failed-count
										// consumer picks up the just-stamped
										// FAILED row (per-item errors land on the
										// up-front PendingBacklogProposal row
										// written by the apply procedure; it
										// shows in the Review proposals inbox's
										// Failed group).
										queryClient.invalidateQueries({
											queryKey: [
												"projects.backlog.proposals.failedCount",
												projectId,
												organizationId ?? null,
											],
										});

										// Clear the local analysis cache only
										// when every item was applied — on
										// nothingApplied/partial-failure the
										// user can re-open the sidebar to
										// review what's still failing.
										if (!nothingApplied) {
											analysisProposalRef.current = null;
										}

										const respondMsg = nothingApplied
											? `Apply completed but no items were changed. ${progressErrors.length > 0 ? progressErrors.join("; ") : "The item may not have been found."}`
											: allSkipped
												? `All ${skippedCount} proposed item(s) already existed in the backlog; nothing new was added.`
												: partialFailure
													? `Changes applied. Created ${created.length}, updated ${updated.length}${skippedCount > 0 ? `, skipped ${skippedCount}` : ""} item(s); ${failedCount} failed (${appliedTotal} of ${batchTotal} on the roadmap). Open Review proposals to retry the failed ones.`
													: `Changes applied successfully. Created ${created.length}, updated ${updated.length} item(s)${skippedCount > 0 ? `, skipped ${skippedCount} (already existed)` : ""}. The Roadmap has been refreshed.`;
										setTimeout(
											() => respond?.(respondMsg),
											5000,
										);
										return;
									}
									if (progress.status === "failed") {
										setApplyResult({
											status: "failed",
											createdCount: 0,
											updatedCount: 0,
											failedCount: approvedChanges.length,
											batchTotal: approvedChanges.length,
											syncedToPM: false,
											items: [],
											message:
												progress.message ??
												"Unknown error",
										});

										// Workflow-level failure also needs to
										// refetch the banner count — the apply
										// procedure wrote the proposal row
										// up-front and the workflow's terminal
										// branch will stamp it FAILED.
										queryClient.invalidateQueries({
											queryKey: [
												"projects.backlog.proposals.failedCount",
												projectId,
												organizationId ?? null,
											],
										});
										setTimeout(
											() =>
												respond?.(
													`Apply failed: ${progress.message ?? "Unknown error"}`,
												),
											5000,
										);
										return;
									}
								} catch (err) {
									respond?.(
										`Apply error: ${err instanceof Error ? err.message : "Failed to check progress"}`,
									);
									return;
								}
							}

							respond?.("Apply timed out after 5 minutes.");
						} catch (err) {
							respond?.(
								`Apply error: ${err instanceof Error ? err.message : "Failed to apply changes"}`,
							);
						} finally {
							// Apply concluded (success / failure / timeout /
							// cancel) — retire the Cancel control.
							setApplyingProposalId(null);
						}
					}}
					onReject={() => {
						analysisProposalRef.current = null;
						// Retire any in-flight late-fold poll and drop the note +
						// pending state.
						decisionPrecheckPollWorkflowRef.current = null;
						setAnalysisDecisionConflicts(null);
						setDecisionPrecheckPending(false);
						respond?.(
							"User rejected all proposed changes. Do NOT re-run the analysis or call analyze_backlog again. Ask the user what they would like to do instead.",
						);
					}}
				/>
			);
		},
	});

	// Suggestions for the chat
	const suggestions = [
		{
			title: "Review project conversations",
			message:
				"Let me pick meetings and Teams channels/chats to review as context for backlog updates.",
		},
	];

	// Custom sidebar header — puts the "Session history" button next to the
	// close control. Memoized so CopilotKit doesn't remount the header each render.
	const BacklogHeader = useMemo(
		() => createBacklogSidebarHeader(onOpenSessionHistory),
		[onOpenSessionHistory],
	);

	// Track portal mount target
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);

	if (!mounted) {
		return null;
	}

	// Render as a full-screen overlay via portal so the sidebar covers the entire page
	return createPortal(
		<div className="fixed inset-0 z-50">
			<CopilotSidebar
				AssistantMessage={CopilotAssistantMessageForBacklogUpdater}
				defaultOpen={true}
				clickOutsideToClose={false}
				labels={{
					title: "AI Backlog Update",
					initial:
						hasTeamsIntegration ||
						hasSlackIntegration ||
						hasNotionIntegration
							? `I can help update your backlog for **${projectName}** based on new context from ${[
									hasTeamsIntegration &&
										"Teams messages & meetings",
									hasSlackIntegration && "Slack messages",
									hasNotionIntegration && "Notion pages",
								]
									.filter(Boolean)
									.join(
										" and ",
									)}. What would you like to analyze?`
							: `I can help manage your backlog for **${projectName}**. Connect Teams, Slack, or Notion in Settings to enable context-based analysis.`,
				}}
				suggestions={suggestions}
				Header={BacklogHeader}
				onSetOpen={(open) => {
					if (!open) {
						onClose();
					}
				}}
			>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
				<div className="h-full w-full bg-black/20" onClick={onClose} />
			</CopilotSidebar>
		</div>,
		document.body,
	);
}

function NotionPageSelector({ onSkip }: { onSkip: () => void }) {
	const [skipped, setSkipped] = useState(false);
	const [hidden, setHidden] = useState(false);

	useEffect(() => {
		if (skipped) {
			const timer = setTimeout(() => setHidden(true), 2000);
			return () => clearTimeout(timer);
		}
	}, [skipped]);

	if (hidden) {
		return null;
	}

	if (skipped) {
		return (
			<div className="rounded-lg border border-muted bg-muted/30 p-3">
				<p className="text-sm text-muted-foreground">
					Notion page selection skipped
				</p>
			</div>
		);
	}

	return (
		<div className="rounded-lg border p-4 space-y-3">
			<p className="text-sm font-medium">Notion Page Selection</p>
			<p className="text-xs text-muted-foreground">
				Notion page selection will be available when the integration is
				connected.
			</p>
			<Button
				size="sm"
				variant="outline"
				onClick={() => {
					setSkipped(true);
					onSkip();
				}}
			>
				Skip
			</Button>
		</div>
	);
}
