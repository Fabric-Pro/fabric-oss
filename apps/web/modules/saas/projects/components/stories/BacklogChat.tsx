"use client";

import { useCoAgent, useCopilotAction } from "@copilotkit/react-core";
import { useAgent } from "@copilotkit/react-core/v2";
import { CopilotSidebar, useChatContext } from "@copilotkit/react-ui";
import { CopilotAssistantMessageForBacklogUpdater } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { useCopilotChatSession } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useReseedAgentStateOnRunStart } from "@saas/shared/components/copilot/use-agent-state-reseed";
import "@copilotkit/react-ui/styles.css";
import type { EngagementProfile } from "@repo/database";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { HistoryIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import { orpc } from "../../../../shared/lib/orpc-query-utils";
import { validateBacklogAnalysisOptions } from "../../lib/backlog-analysis-sources";
import { resolveBacklogChatIntake } from "../../lib/backlog-chat-intake";
import { resolveSlackFetchDecision } from "../../lib/slack-fetch-decision";
import { resolveTeamsFetchDecision } from "../../lib/teams-fetch-decision";
import { BacklogFlowCard } from "./BacklogFlowCard";
import { BacklogFlowReview, type ReviewSettings } from "./BacklogFlowReview";
import {
	type BacklogFlow,
	BacklogFlowController,
	type FlowEntry,
	genuineUserMessage,
	genuineUserMessages,
	REVIEW_UNAVAILABLE_RESULT,
} from "./backlog-flow-controller";
import { MEETINGS_STALE_TIME } from "./use-project-meetings";

type BacklogUpdaterState = {
	projectId: string;
	projectName: string;
	/** Engagement profile of the project (drives the Explore intake). */
	engagementProfile?: EngagementProfile | null;
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
	/** Engagement profile of the project (drives the Explore intake). */
	engagementProfile?: EngagementProfile | null;
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
	engagementProfile,
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

	// Engagement profile decides the intake (plan Slice 6): under EXPLORE
	// the chat is the intake and the analysis runs in "explore" mode. The
	// hosting surface already holds the project, so it passes the profile in
	// rather than this panel fetching it again.
	const intake = resolveBacklogChatIntake(
		engagementProfile ?? null,
		projectName,
	);

	const [controller] = useState(() => new BacklogFlowController());
	useEffect(() => {
		controller.activate();
		return () => controller.stop();
	}, [controller]);
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

	// Project and integration context the agent's system prompt is built from.
	const agentContext = useMemo(
		() => ({
			projectId,
			projectName,
			organizationId: organizationId ?? undefined,
			hasTeamsIntegration,
			hasSlackIntegration,
			hasNotionIntegration,
			hasPMTool,
			pmToolName,
			backlogSummary,
		}),
		[
			projectId,
			projectName,
			organizationId,
			hasTeamsIntegration,
			hasSlackIntegration,
			hasNotionIntegration,
			hasPMTool,
			pmToolName,
			backlogSummary,
		],
	);

	// Sync agent state with CopilotKit
	useCoAgent<BacklogUpdaterState>({
		name: "backlog_updater",
		initialState: {
			...agentContext,
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

	// useCoAgent applies initialState after AG-UI copies state into the run
	// input. Seed eagerly below, but CopilotKit 1.80's async thread connect
	// can clear that state later. The core run-start hook re-seeds after the
	// wipe and before connect/run builds its input.
	const { agent: backlogAgent } = useAgent({
		agentId: "backlog_updater",
		updates: [],
	});
	// Restore context after a fresh-thread connect clears state.
	useReseedAgentStateOnRunStart(BACKLOG_AGENT_ID, (state) => ({
		retryCount: 0,
		reasoningByTurn: {},
		...state,
		...agentContext,
	}));

	// Keep context current on provider/context changes; run-start also covers
	// CopilotKit 1.80 clearing state after this effect has already run.
	useEffect(() => {
		backlogAgent.setState({
			retryCount: 0,
			reasoningByTurn: {},
			...backlogAgent.state,
			...agentContext,
		});
	}, [backlogAgent, agentContext]);

	const reviewSettingsRef = useRef<ReviewSettings>({
		projectId,
		organizationId: organizationId ?? null,
		hasPMTool,
		pmToolName,
		pmConfig,
		ensureBacklogConversationId,
		liveMessagesRef,
		onChangesApplied,
	});
	reviewSettingsRef.current = {
		projectId,
		organizationId: organizationId ?? null,
		hasPMTool,
		pmToolName,
		pmConfig,
		ensureBacklogConversationId,
		liveMessagesRef,
		onChangesApplied,
	};
	const analysisRequestsRef = useRef(
		new Map<
			string,
			Promise<
				Parameters<typeof orpcClient.projects.backlog.startAnalysis>[0]
			>
		>(),
	);

	const services = {
		start: async (admitted: BacklogFlow) => {
			const teams = resolveTeamsFetchDecision(admitted.sources);
			let request = analysisRequestsRef.current.get(admitted.flowId);
			if (!request) {
				request = (async () => {
					let conversationId: string | undefined;
					try {
						conversationId = await ensureBacklogConversationId();
					} catch (error) {
						console.warn(
							"[BacklogChat] Conversation unavailable; proceeding with analysis",
							error,
						);
					}
					if (!controller.canStart(admitted.flowId)) {
						throw new Error(
							"This analysis request was superseded.",
						);
					}
					return {
						projectId,
						organizationId: organizationId ?? null,
						operationKey: admitted.flowId,
						contextSources: {
							fetchTeamsMessages: teams.fetchTeamsMessages,
							fetchSlackMessages: resolveSlackFetchDecision({
								fetchSlackMessages: admitted.fetchSlackMessages,
								hasSlackIntegration,
								selectedMeetings:
									admitted.sources.selectedMeetings,
								selectedChannels:
									admitted.sources.selectedChannels,
								notionPageIds: [],
							}),
							selectedMeetings: admitted.sources.selectedMeetings,
							selectedChannelContextIds:
								teams.selectedChannelContextIds,
							daysBack: admitted.sources.daysBack,
							notionPageIds: [],
						},
						pmConfig,
						userPrompt: admitted.userPrompt,
						conversationId,
						intakeMode:
							admitted.intakeMode === "explore"
								? "explore"
								: undefined,
					};
				})();
				analysisRequestsRef.current.set(admitted.flowId, request);
			}
			const input = await request;
			if (!controller.canStart(admitted.flowId)) {
				throw new Error("This analysis request was superseded.");
			}
			return orpcClient.projects.backlog.startAnalysis(input);
		},
		poll: (workflowId: string) =>
			orpcClient.projects.backlog.analysisProgress({
				projectId,
				workflowId,
			}),
	};
	const admit = (
		entry: FlowEntry,
		args: {
			includeTeams?: boolean;
			includeNotion?: boolean;
			fetchSlackMessages?: boolean;
			userPrompt?: unknown;
		} = {},
	) => {
		if (
			!hasTeamsIntegration &&
			!hasSlackIntegration &&
			!hasNotionIntegration &&
			intake.intakeMode !== "explore"
		) {
			return "Connect Teams, Slack, or Notion in Settings before starting an analysis, or use explore intake.";
		}
		const options = validateBacklogAnalysisOptions(args);
		const messages = genuineUserMessages(liveMessagesRef.current);
		const previous = controller.current();
		const index = previous
			? messages.findIndex((message) => message.id === previous.messageId)
			: -1;
		const userPrompt =
			options.userPrompt ??
			messages
				.slice(index + 1)
				.map((message) => message.content)
				.filter(Boolean)
				.join("\n\n");
		return controller.admit(
			genuineUserMessage(liveMessagesRef.current),
			entry,
			entry === "select_notion_pages"
				? ["notion"]
				: [
						...(hasTeamsIntegration && args.includeTeams !== false
							? ["teams" as const]
							: []),
						...(hasNotionIntegration &&
						(args.includeNotion || !hasTeamsIntegration)
							? ["notion" as const]
							: []),
					],
			services,
			{
				intakeMode:
					intake.intakeMode === "explore" ? "explore" : "standard",
				fetchSlackMessages: options.fetchSlackMessages,
				userPrompt:
					userPrompt ||
					(intake.intakeMode === "explore"
						? "Propose the first spikes for this hunch."
						: "Analyze selected context and suggest backlog updates."),
			},
		);
	};

	const renderEntry = ({ result }: { result?: unknown }) => {
		// With followUp off, a refusal is not narrated by the model, so the
		// call's own card shows it.
		if (typeof result === "string" && result.trim()) {
			return (
				<p className="px-1 text-sm text-muted-foreground">{result}</p>
			);
		}
		if (
			!result ||
			typeof result !== "object" ||
			!("flowId" in result) ||
			typeof result.flowId !== "string"
		) {
			return "";
		}
		return (
			<BacklogFlowCard
				controller={controller}
				flowId={result.flowId}
				projectId={projectId}
				organizationId={organizationId ?? null}
				renderReview={(displayed) => {
					const current = reviewSettingsRef.current;
					return (
						<BacklogFlowReview
							key={displayed.flowId}
							flow={displayed}
							controller={controller}
							{...current}
							settingsRef={reviewSettingsRef}
							hasPMTool={current.hasPMTool}
							pmToolName={current.pmToolName}
							pmConfig={current.pmConfig}
							ensureBacklogConversationId={
								ensureBacklogConversationId
							}
							liveMessagesRef={liveMessagesRef}
							onChangesApplied={current.onChangesApplied}
						/>
					);
				}}
			/>
		);
	};
	useCopilotAction({
		name: "select_review_sources",
		description:
			"Start a source review request. The application runs remaining selectors, analysis and review.",
		parameters: [
			{
				name: "userPrompt",
				type: "string",
				required: false,
				description: "The clarified original request.",
			},
			{
				name: "includeTeams",
				type: "boolean",
				required: false,
				description:
					"Include the Teams and meetings selector (default when Teams is linked).",
			},
			{
				name: "includeNotion",
				type: "boolean",
				required: false,
				description:
					"Include the Notion skip card after Teams, for mixed requests.",
			},
			{
				name: "fetchSlackMessages",
				type: "boolean",
				required: false,
				description:
					"Include Slack alongside meetings when explicitly requested.",
			},
		],
		handler: (args) => admit("select_review_sources", args),
		render: renderEntry,
		// The card runs the rest of the flow; a follow-up agent run would only
		// narrate a step the card already shows, below the card.
		followUp: false,
	});
	useCopilotAction({
		name: "select_notion_pages",
		description: "Compatibility entry for Notion source review.",
		parameters: [],
		handler: () => admit("select_notion_pages"),
		render: renderEntry,
		followUp: false,
	});
	useCopilotAction({
		name: "analyze_backlog",
		description:
			"Start a new request directly for Slack-only, explore intake, or skipped selectors. The application runs analysis and review.",
		parameters: [
			{
				name: "userPrompt",
				type: "string",
				required: true,
				description: "The user's original request.",
			},
			{
				name: "fetchSlackMessages",
				type: "boolean",
				required: false,
				description: "Explicitly include Slack context.",
			},
		],
		handler: (args) => admit("analyze_backlog", args),
		render: renderEntry,
		followUp: false,
	});
	useCopilotAction({
		name: "review_backlog_changes",
		description: "Acknowledge the existing application-owned review card.",
		parameters: [],
		handler: () => controller.review(),
		// Only the refusal needs a note; on success the review card is already shown.
		render: ({ result }: { result?: unknown }) =>
			result === REVIEW_UNAVAILABLE_RESULT ? (
				<p className="px-1 text-sm text-muted-foreground">{result}</p>
			) : (
				""
			),
		followUp: false,
	});

	// Suggestions for the chat
	const suggestions = useMemo(
		() => [
			{
				title: "Review project conversations",
				message:
					"Let me pick meetings and Teams channels/chats to review as context for backlog updates.",
			},
		],
		[],
	);

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

	const chatLabels = useMemo(
		() => ({
			title:
				intake.intakeMode === "explore"
					? "Explore: first spikes"
					: "AI Backlog Update",
			initial:
				intake.intakeMode === "explore"
					? intake.initialMessage
					: hasTeamsIntegration ||
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
		}),
		[
			intake.intakeMode,
			intake.intakeMode === "explore" ? intake.initialMessage : undefined,
			hasTeamsIntegration,
			hasSlackIntegration,
			hasNotionIntegration,
			projectName,
		],
	);
	if (!mounted) {
		return null;
	}

	// Render as a full-screen overlay via portal so the sidebar covers the entire page.
	// The direct-child selectors give the two auto-height divs CopilotKit
	// injects around the backdrop (`.copilotKitSidebarContentWrapper` and its
	// `.copilotKitModalChildrenWrapper`) a definite height, so the backdrop's
	// `h-full` resolves to the viewport instead of collapsing to nothing.
	return createPortal(
		<div className="fixed inset-0 z-50 [&>.copilotKitSidebarContentWrapper]:h-full [&>.copilotKitSidebarContentWrapper>.copilotKitModalChildrenWrapper]:h-full">
			<CopilotSidebar
				AssistantMessage={CopilotAssistantMessageForBacklogUpdater}
				defaultOpen={true}
				clickOutsideToClose={false}
				labels={chatLabels}
				suggestions={
					intake.intakeMode === "explore"
						? intake.suggestions
						: suggestions
				}
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
