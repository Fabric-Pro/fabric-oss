"use client";

import type { AssistantMessageProps } from "@copilotkit/react-ui";
import { Markdown, useChatContext } from "@copilotkit/react-ui";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	createContext,
	memo,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import { useOrganizationId } from "../../../organizations/hooks/use-organization-context";
import { DiffOutcomeChip } from "../../../projects/components/copilot/DiffOutcomeChip";
import { useDocumentAssistantOutcomes } from "../../../projects/components/copilot/DocumentAssistantOutcomesProvider";
import { ChatMessageInsertDiagramButton } from "../../../projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton";
import { deriveDiagramTitle } from "../../../projects/components/excalidraw-auto-insert/deriveDiagramTitle";
import { useActiveTipTapEditor } from "../../../projects/components/excalidraw-auto-insert/useActiveTipTapEditor";
import { useChatScopedProjectFromCopilotChat } from "../../../projects/components/excalidraw-auto-insert/useChatScopedProject";
import { AssistantRunContext } from "./AssistantRunContext";
import {
	equalExcludedTurnIds,
	type FabricMcpRenderEnvelope,
	findInlineMcpEnvelope,
	findTranscriptPrompt,
	selectAgentTurn,
	selectExcludedTurnIds,
	selectTranscriptTrace,
} from "./assistant-transcript";
import { useCopilotReplyRatingState } from "./CopilotReplyRatingContext";
import {
	type FormattedMessageTimestamp,
	formatMessageTimestamp,
	type TimestampSource,
} from "./formatMessageTimestamp";
import { equalMessageFields } from "./message-row-equality";
import {
	AWAITING_CONFIRMATION_TOOLS,
	ReasoningCollapsible,
	type ToolCallEntry,
} from "./ReasoningCollapsible";
import {
	useAgentStateSelector,
	useAgentTranscriptSelector,
} from "./useAgentStateReadOnly";

/**
 * Mount point for the Excalidraw chat -> editor auto-insert button
 * (F4 / spec § 8.1 row 4). Isolated into its own component so the
 * hook graph it pulls in (`useParams`, `useOrganizationId`,
 * `useChatScopedProjectFromCopilotChat`, `useActiveTipTapEditor`) only
 * runs when the inline-MCP envelope is actually an Excalidraw
 * resource. Non-Excalidraw paths in the assistant bubble never mount
 * this subtree.
 *
 * Project / organization context is derived from the App Router URL
 * (`/app/{organizationSlug}/projects/{id}/documents/{documentId}` and
 * `/.../stories/{storyId}`) plus the active-organization hook. The
 * Copilot sidebar is mounted INSIDE the document/story page, so
 * exactly one matching editor will be registered with the
 * TiptapEditorRegistry — the resolver returns that editor and the
 * button hits FR-2's happy path (insert at end-of-doc).
 */
function ExcalidrawAutoInsertSlot({
	envelope,
	messageId,
	visibleMessages,
}: {
	envelope: FabricMcpRenderEnvelope;
	messageId: string;
	visibleMessages: unknown;
}) {
	const routeParams = useParams<{
		id?: string;
		organizationSlug?: string;
	}>();
	const routeProjectId = routeParams?.id ?? null;
	const routeOrganizationSlug = routeParams?.organizationSlug ?? null;
	const activeOrganizationId = useOrganizationId();

	const chatScope = useChatScopedProjectFromCopilotChat({
		projectId: routeProjectId,
		organizationId: activeOrganizationId,
		visibleMessages: Array.isArray(visibleMessages)
			? (visibleMessages as unknown[])
			: [],
	});

	const resolverOptions = useMemo(
		() => ({
			chatContext: {
				projectId: chatScope.projectId,
				organizationId: chatScope.organizationId,
				surface: "in-document" as const,
			},
			// The in-document Copilot sidebar isn't mounted under the
			// FabricAgentLauncherProvider — launcher context is always
			// null on this surface. Resolver step (2) matches the
			// same-page focused editor.
			launcherContext: null,
		}),
		[chatScope.projectId, chatScope.organizationId],
	);
	const resolverTarget = useActiveTipTapEditor(resolverOptions);

	const toolResult = useMemo(() => {
		const toolArgs = (envelope.toolArgs ?? {}) as Record<string, unknown>;
		return {
			elements: toolArgs.elements,
			appState: toolArgs.appState,
			checkpointId: envelope.checkpointId ?? "",
			mcpConfigId: envelope.configId,
			resourceUri: envelope.resourceUri,
		};
	}, [envelope]);

	const title = useMemo(() => {
		const promptText = chatScope.lastUserPromptForMessage(messageId);
		return deriveDiagramTitle({ userPromptText: promptText });
	}, [chatScope, messageId]);

	return (
		<ChatMessageInsertDiagramButton
			surface="in-document"
			chatMessageId={messageId}
			toolResult={toolResult}
			organizationSlug={routeOrganizationSlug}
			chatScope={chatScope}
			resolverOptions={resolverOptions}
			resolverTarget={resolverTarget}
			title={title}
		/>
	);
}

/**
 * Options for the {@link makeCopilotAssistantMessage} factory.
 */
export interface CopilotAssistantMessageOptions {
	/**
	 * Name of the registered LangGraph agent whose `STATE_SNAPSHOT` carries
	 * `reasoningByTurn` and `toolCallsByTurn`. Defaults to
	 * `"project_document_generator"` for backward compatibility with the
	 * F-1171 surfaces (DocumentEditor + StoryWorkspace).
	 *
	 * Passing a name that isn't a registered agent is safe —
	 * `useAgentStateSelector` selects from empty state in that case. The
	 * reasoning UI simply doesn't render.
	 */
	agentName?: string;
}

/**
 * Factory for the custom AssistantMessage component CopilotKit accepts via
 * `<CopilotSidebar AssistantMessage={...}>`. CopilotKit instantiates the
 * component internally with `AssistantMessageProps` — there is no way to
 * pass an additional `agentName` prop through that boundary, so we close
 * over the agent name at construction time.
 *
 * **Stability:** JavaScript module evaluation guarantees each named export
 * below is bound to a single component reference for the entire process
 * lifetime. Passing `CopilotAssistantMessageForBacklogUpdater` (a
 * module-scope constant) to `<CopilotSidebar AssistantMessage={...}>`
 * therefore gives CopilotKit the same identity on every render — no
 * `useMemo` needed at call sites.
 *
 * **When to call the factory directly:** only for dynamic agents whose
 * name is known at runtime (Q4 follow-up — see e.g. AgentChatGeneral).
 * Those sites MUST wrap the call in `useMemo(() => makeCopilotAssistantMessage({
 * agentName: agent.id }), [agent.id])` to keep component identity stable
 * across renders. For the 4 in-scope agents, prefer the named exports
 * below.
 *
 * The returned component hides action buttons while the response is still
 * being generated. CopilotKit's built-in component only checks `isLoading`
 * (true before first token), so buttons appear as soon as streaming
 * starts. This component also checks `isGenerating` to keep buttons hidden
 * until the full response is complete.
 *
 * @internal Use the module-scope exports unless dynamically wiring an
 *           agent whose name only exists at runtime.
 */
export function makeCopilotAssistantMessage(
	opts: CopilotAssistantMessageOptions = {},
) {
	const agentName = opts.agentName ?? "project_document_generator";
	function CopilotAssistantMessageInner(
		props: AssistantMessageProps & {
			generativeSlot?: React.ReactNode;
			formattedTimestamp: FormattedMessageTimestamp | null;
			traceSelection: Selection;
			traceInProgress: boolean;
			inlineMcpEnvelope: FabricMcpRenderEnvelope | null;
			promptMessages: { id: string; role: string; content: string }[];
		},
	) {
		const tTooltips = useTranslations("tooltips.common");
		const tCopilot = useTranslations("tooltips.copilot");
		const { icons, labels } = useChatContext();
		const {
			message,
			isLoading,
			isGenerating,
			isCurrentMessage,
			onRegenerate,
			onCopy,
			onThumbsUp,
			onThumbsDown,
			markdownTagRenderers,
		} = props;

		const [copied, setCopied] = useState(false);
		const rating = useCopilotReplyRatingState();
		const vote = message?.id ? rating?.getVote(message.id) : undefined;
		// CopilotKit supplies callback wrappers even without a host rating handler.
		const canRate = Boolean(message?.id && rating?.canRate(message.id));

		const content = message?.content || "";

		const {
			inlineMcpEnvelope,
			promptMessages,
			traceInProgress,
			traceSelection: selected,
		} = props;
		const reasoning =
			typeof selected.reasoning?.text === "string"
				? selected.reasoning
				: null;
		const toolCalls = selected.toolCalls?.length
			? selected.toolCalls
			: null;

		const handleCopy = () => {
			if (content && onCopy) {
				navigator.clipboard.writeText(content);
				setCopied(true);
				onCopy(content);
				setTimeout(() => setCopied(false), 2000);
			} else if (content) {
				navigator.clipboard.writeText(content);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}
		};

		// Persisted diff outcomes for this assistant turn — populated by
		// `DocumentAssistantOutcomesProvider` (Document / Feature editor)
		// from the latest `getActiveForDocument` payload. The provider's
		// React Query subscription auto-refreshes after `recordDiffOutcome`
		// fires, so the chips appear in the LIVE chat the moment the user
		// accepts/rejects in DiffReviewBar — no page reload needed.
		// Returns `null` on surfaces without the provider (Fabric AI,
		// BacklogChat) so the bubble degrades gracefully.
		const outcomes = useDocumentAssistantOutcomes();
		const persistedOutcomes = useMemo(() => {
			if (!outcomes || !message?.id) {
				return null;
			}
			const entries = outcomes.getOutcomesForMessageId(message.id);
			if (!entries || entries.length === 0) {
				return null;
			}
			return entries;
		}, [outcomes, message?.id]);

		// Show buttons only when NOT loading AND NOT generating (response is complete)
		const showControls = content && !isLoading && !isGenerating;

		// Per-message timestamp under the bubble, shown under the same
		// condition as the controls (response complete — showing "5s ago"
		// while text is still streaming would lie about completion). Reads
		// CopilotKit's live `createdAt` or our persisted `timestamp`; `null`
		// when neither is present (very old rows) → no `<time>` rendered.
		const formattedTimestamp = props.formattedTimestamp;

		// The tool-call row owns the frame; the text reply owns the insert button.
		const isExcalidrawEnvelope =
			!!inlineMcpEnvelope &&
			typeof inlineMcpEnvelope.resourceUri === "string" &&
			inlineMcpEnvelope.resourceUri.includes("excalidraw");
		const excalidrawMessageId = (message as { id?: string } | undefined)
			?.id;

		return (
			<>
				{content &&
					isExcalidrawEnvelope &&
					inlineMcpEnvelope &&
					excalidrawMessageId && (
						<ExcalidrawAutoInsertSlot
							envelope={inlineMcpEnvelope}
							messageId={excalidrawMessageId}
							visibleMessages={promptMessages}
						/>
					)}
				{(reasoning || toolCalls) && (
					<ReasoningCollapsible
						text={reasoning?.text ?? ""}
						durationMs={reasoning?.durationMs}
						toolCalls={toolCalls ?? undefined}
						inProgress={traceInProgress}
					/>
				)}
				{persistedOutcomes && (
					<div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
						{persistedOutcomes.map((entry) => (
							<div
								key={entry.id}
								className="inline-flex items-center gap-1.5 text-[11px]"
							>
								{entry.name ? (
									<span className="font-mono text-muted-foreground">
										{entry.name}
									</span>
								) : null}
								<DiffOutcomeChip toolCall={entry} />
							</div>
						))}
					</div>
				)}
				{content && (
					<div className="copilotKitMessage copilotKitAssistantMessage group/message">
						<Markdown
							content={content}
							components={markdownTagRenderers}
						/>
						{isGenerating && (
							<span className="copilotKitAssistantMessageGenerating inline-flex items-center gap-[2px] ml-1 text-muted-foreground">
								<span className="animate-[pulse_1.4s_ease-in-out_infinite]">
									.
								</span>
								<span className="animate-[pulse_1.4s_ease-in-out_0.2s_infinite]">
									.
								</span>
								<span className="animate-[pulse_1.4s_ease-in-out_0.4s_infinite]">
									.
								</span>
							</span>
						)}
						{/*
						 * Message footer — the timestamp and the action
						 * controls share ONE in-flow flex row so they can never
						 * overlap at any width or zoom. (The previous layout
						 * reused CopilotKit's `.copilotKitMessageControls`,
						 * which is `position: absolute` and collided with the
						 * sibling `<time>` element below the bubble.)
						 *
						 * The timestamp anchors the left edge and is always
						 * visible; the controls sit to its right and fade in on
						 * hover or keyboard focus, staying visible for the
						 * current message and on mobile — mirroring CopilotKit's
						 * original reveal behaviour (`.currentMessage`,
						 * `:hover`, and the `max-width: 768px` always-on rule).
						 */}
						{(showControls || formattedTimestamp) && (
							<div className="mt-1.5 flex items-center gap-3">
								{formattedTimestamp && (
									<time
										dateTime={formattedTimestamp.iso}
										title={formattedTimestamp.tooltip}
										className="shrink-0 text-[10px] leading-none text-muted-foreground/60"
									>
										{formattedTimestamp.label}
									</time>
								)}
								{showControls && (
									<div
										className={`flex items-center gap-1 transition-opacity duration-200 ${
											isCurrentMessage
												? "opacity-100"
												: "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100 max-md:opacity-100"
										}`}
									>
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													className="copilotKitMessageControlButton"
													onClick={() =>
														onRegenerate?.()
													}
													aria-label={
														labels.regenerateResponse
													}
												>
													{icons.regenerateIcon}
												</button>
											</TooltipTrigger>
											<TooltipContent>
												{tCopilot("regenerateResponse")}
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													className="copilotKitMessageControlButton"
													onClick={handleCopy}
													aria-label={
														labels.copyToClipboard
													}
												>
													{copied ? (
														<span
															style={{
																fontSize:
																	"10px",
																fontWeight:
																	"bold",
															}}
														>
															✓
														</span>
													) : (
														icons.copyIcon
													)}
												</button>
											</TooltipTrigger>
											<TooltipContent>
												{tTooltips("copy")}
											</TooltipContent>
										</Tooltip>
										{onThumbsUp &&
											canRate &&
											content.trim() && (
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															className={`copilotKitMessageControlButton rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${vote === "RATED_UP" ? "active bg-primary text-primary-foreground" : ""}`}
															aria-pressed={
																vote ===
																"RATED_UP"
															}
															aria-disabled={
																message
																	? rating?.isPending(
																			message.id,
																		)
																	: false
															}
															onClick={() =>
																message &&
																onThumbsUp(
																	message,
																)
															}
															aria-label={
																labels.thumbsUp
															}
														>
															{icons.thumbsUpIcon}
														</button>
													</TooltipTrigger>
													<TooltipContent>
														{tCopilot("thumbsUp")}
													</TooltipContent>
												</Tooltip>
											)}
										{onThumbsDown &&
											canRate &&
											content.trim() && (
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															className={`copilotKitMessageControlButton rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${vote === "RATED_DOWN" ? "active bg-primary text-primary-foreground" : ""}`}
															aria-pressed={
																vote ===
																"RATED_DOWN"
															}
															aria-disabled={
																message
																	? rating?.isPending(
																			message.id,
																		)
																	: false
															}
															onClick={() =>
																message &&
																onThumbsDown(
																	message,
																)
															}
															aria-label={
																labels.thumbsDown
															}
														>
															{
																icons.thumbsDownIcon
															}
														</button>
													</TooltipTrigger>
													<TooltipContent>
														{tCopilot("thumbsDown")}
													</TooltipContent>
												</Tooltip>
											)}
									</div>
								)}
							</div>
						)}
					</div>
				)}
				{props.generativeSlot}
				{/*
				 * Live "Thinking…" spinner for the gap between sending and the
				 * first reasoning/content token. CopilotKit's default
				 * `activityIcon` is effectively invisible on these surfaces, so
				 * users felt nothing was happening while the agent worked. Shown
				 * only during the pure gap — once reasoning (ReasoningCollapsible)
				 * or content streams in, those take over. `motion-safe:` honors
				 * reduced-motion; `role="status"` announces it to screen readers.
				 */}
				{(isLoading || isGenerating) && !content && !reasoning && (
					<div className="copilotKitMessage copilotKitAssistantMessage">
						<span
							role="status"
							className="inline-flex items-center gap-2 text-sm text-muted-foreground"
						>
							<Loader2
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							<span>Thinking…</span>
						</span>
					</div>
				)}
			</>
		);
	}
	CopilotAssistantMessageInner.displayName = `CopilotAssistantMessage[${agentName}]`;
	const MemoRow = memo(
		CopilotAssistantMessageInner,
		(a, b) =>
			equalMessageFields(a.message, b.message, [
				"id",
				"content",
				"createdAt",
				"timestamp",
			]) &&
			equalMessageFields(a.formattedTimestamp, b.formattedTimestamp, [
				"label",
				"iso",
				"tooltip",
			]) &&
			equalSelection(a.traceSelection, b.traceSelection) &&
			a.traceInProgress === b.traceInProgress &&
			a.inlineMcpEnvelope === b.inlineMcpEnvelope &&
			a.promptMessages === b.promptMessages &&
			a.isLoading === b.isLoading &&
			a.isGenerating === b.isGenerating &&
			a.isCurrentMessage === b.isCurrentMessage &&
			a.markdownTagRenderers === b.markdownTagRenderers &&
			Boolean(a.onThumbsUp) === Boolean(b.onThumbsUp) &&
			Boolean(a.onThumbsDown) === Boolean(b.onThumbsDown),
	);
	function CopilotAssistantMessageRow(props: AssistantMessageProps) {
		const transcript = props.messages ?? [];
		const excluded = useAgentStateSelector(
			agentName,
			selectExcludedTurnIds,
			equalExcludedTurnIds,
		);
		const trace = selectTranscriptTrace(
			props.message,
			transcript,
			excluded,
		);
		const runActive = useContext(AssistantRunContext);
		const traceInProgress =
			trace.ownsTrace &&
			trace.latest &&
			(runActive || props.isLoading || props.isGenerating);
		const messageId = props.message?.id;
		const turnSelector = useMemo(
			() => (state: AssistantAgentState, messages: unknown[]) =>
				selectAgentTurn(messages, messageId, excluded, state.messages),
			[messageId, excluded],
		);
		const transcriptTurn = useAgentTranscriptSelector(
			agentName,
			turnSelector,
		);
		// Select the rendered trace, so unrelated tool results do not invalidate the body.
		const previousResults = useRef(trace.results);
		const resultIds = Object.keys(trace.results);
		if (
			resultIds.length !== Object.keys(previousResults.current).length ||
			resultIds.some(
				(id) => trace.results[id] !== previousResults.current[id],
			)
		) {
			previousResults.current = trace.results;
		}
		const results = previousResults.current;
		const traceSelector = useMemo(() => {
			return (state: AssistantAgentState): Selection => {
				const turn = trace.ownsTrace ? transcriptTurn : null;
				return {
					turn,
					reasoning:
						turn === null
							? null
							: (state.reasoningByTurn?.[turn] ?? null),
					toolCalls:
						turn === null
							? null
							: (state.toolCallsByTurn?.[turn]?.map((entry) =>
									entry.status === "pending" &&
									!AWAITING_CONFIRMATION_TOOLS.has(
										entry.name,
									) &&
									results[entry.id]
										? {
												...entry,
												status: results[entry.id],
											}
										: entry,
								) ?? null),
				};
			};
		}, [transcriptTurn, trace.ownsTrace, results]);
		const liveSelection = useAgentStateSelector(
			agentName,
			traceSelector,
			equalSelection,
		);
		const settledTools =
			!traceInProgress && trace.saved.toolCalls?.length
				? (liveSelection.toolCalls?.map((entry) =>
						entry.status === "pending"
							? (trace.saved.toolCalls?.find(
									(saved) => saved.id === entry.id,
								) ?? entry)
							: entry,
					) ?? trace.saved.toolCalls)
				: liveSelection.toolCalls;
		const settledSelection = { ...liveSelection, toolCalls: settledTools };
		const traceSelection =
			liveSelection.reasoning !== null || liveSelection.toolCalls !== null
				? settledSelection
				: { turn: null, ...trace.saved };
		const inlineMcpEnvelope = props.message?.toolCalls?.length
			? null
			: findInlineMcpEnvelope(props.message, transcript, excluded);
		// The prompt adapter needs only the preceding user and the reply id.
		const user = findTranscriptPrompt(props.message, transcript, excluded);
		const userId = user?.id;
		const userContent =
			typeof user?.content === "string" ? user.content : "";
		const hasDiagram = Boolean(
			props.message?.content &&
				inlineMcpEnvelope?.resourceUri.includes("excalidraw"),
		);
		const promptMessages = useMemo(
			() =>
				hasDiagram
					? [
							...(userId
								? [
										{
											id: userId,
											role: "user",
											content: userContent,
										},
									]
								: []),
							{
								id: messageId ?? "",
								role: "assistant",
								content: "",
							},
						]
					: EMPTY_PROMPT_MESSAGES,
			[hasDiagram, userId, userContent, messageId],
		);
		// Snapshot the displayed clock-derived value before the memo boundary.
		const formattedTimestamp =
			props.message?.content && !props.isLoading && !props.isGenerating
				? formatMessageTimestamp(props.message as TimestampSource)
				: null;
		const latest = useRef(props);
		latest.current = props;
		const callbacks = useMemo(
			() => ({
				onRegenerate: () => latest.current.onRegenerate?.(),
				onCopy: (text: string) => latest.current.onCopy?.(text),
				onThumbsUp: () => {
					if (latest.current.message) {
						latest.current.onThumbsUp?.(latest.current.message);
					}
				},
				onThumbsDown: () => {
					if (latest.current.message) {
						latest.current.onThumbsDown?.(latest.current.message);
					}
				},
			}),
			[latest],
		);
		const slot = useMemo(() => <GenerativeSlot />, []);
		return (
			<GenerativeContext.Provider value={props.message?.generativeUI}>
				<MemoRow
					{...props}
					{...callbacks}
					onThumbsUp={
						props.onThumbsUp ? callbacks.onThumbsUp : undefined
					}
					onThumbsDown={
						props.onThumbsDown ? callbacks.onThumbsDown : undefined
					}
					generativeSlot={slot}
					formattedTimestamp={formattedTimestamp}
					traceSelection={traceSelection}
					traceInProgress={
						traceInProgress && traceSelection.turn !== null
					}
					inlineMcpEnvelope={inlineMcpEnvelope}
					promptMessages={promptMessages}
				/>
			</GenerativeContext.Provider>
		);
	}
	CopilotAssistantMessageRow.displayName =
		CopilotAssistantMessageInner.displayName;
	return CopilotAssistantMessageRow;
}

// =============================================================================
// Module-scope exports — one constant per in-scope agent.
//
// Each constant is a single component reference evaluated exactly once per
// process (ES module evaluation guarantee). Passing one to
// `<CopilotSidebar AssistantMessage={...}>` therefore gives CopilotKit
// stable identity across renders — no `useMemo` needed at call sites.
//
// The default export (`CopilotAssistantMessage`) is bound to
// `project_document_generator` so the F-1171 surfaces (DocumentEditor,
// StoryWorkspace) keep working unchanged.
//
// Out-of-scope custom user agents (AgentChat*) are Q4 follow-up — they
// will use `useMemo(() => makeCopilotAssistantMessage({ agentName: ... }),
// [agentName])` at the call site.
// =============================================================================

/**
 * Default export — bound to `project_document_generator`. Use this on the
 * F-1171 surfaces (DocumentEditor, StoryWorkspace).
 */
export const CopilotAssistantMessage = makeCopilotAssistantMessage({
	agentName: "project_document_generator",
});

/** Bound to `backlog_updater`. Use on `BacklogChat.tsx`. */
export const CopilotAssistantMessageForBacklogUpdater =
	makeCopilotAssistantMessage({ agentName: "backlog_updater" });

/** Bound to `prompt_enhancer`. Use on `PromptEditorAI.tsx` and `PromptContentEnhancer.tsx`. */
export const CopilotAssistantMessageForPromptEnhancer =
	makeCopilotAssistantMessage({ agentName: "prompt_enhancer" });

/** Bound to `task_planner`. Use in `TaskPlannerWorkspace.tsx`. */
export const CopilotAssistantMessageForTaskPlanner =
	makeCopilotAssistantMessage({ agentName: "task_planner" });

/** Bound to `document_generator`. Use on `agents/document-generator/page.tsx`. */
export const CopilotAssistantMessageForDocumentGenerator =
	makeCopilotAssistantMessage({ agentName: "document_generator" });

/**
 * Bound to `story_breakdown`. Use on Feature-Breakdown surfaces. Currently
 * the story_breakdown agent is invoked from project wizard flows that do
 * not yet pass a custom `assistantMessage` prop — wiring on those surfaces
 * is a separate follow-up. The export exists so the binding is available
 * once those surfaces opt in.
 */
export const CopilotAssistantMessageForStoryBreakdown =
	makeCopilotAssistantMessage({ agentName: "story_breakdown" });

type AssistantAgentState = {
	messages?: unknown[];
	reasoningByTurn?: Record<number, { text: string; durationMs?: number }>;
	toolCallsByTurn?: Record<number, ToolCallEntry[]>;
};
type Selection = {
	turn: number | null;
	reasoning: { text: string; durationMs?: number } | null;
	toolCalls: ToolCallEntry[] | null;
};
function equalSelection(a: Selection, b: Selection) {
	return (
		a.turn === b.turn &&
		a.reasoning?.text === b.reasoning?.text &&
		a.reasoning?.durationMs === b.reasoning?.durationMs &&
		(a.toolCalls === b.toolCalls ||
			(Boolean(a.toolCalls && b.toolCalls) &&
				a.toolCalls?.length === b.toolCalls?.length &&
				(a.toolCalls ?? []).every((entry, index) => {
					const next = b.toolCalls?.[index];
					return (
						entry.id === next?.id &&
						entry.name === next?.name &&
						entry.status === next?.status &&
						entry.startedAt === next?.startedAt &&
						entry.durationMs === next?.durationMs &&
						entry.errorMessage === next?.errorMessage
					);
				})))
	);
}
const GenerativeContext =
	createContext<
		NonNullable<AssistantMessageProps["message"]>["generativeUI"]
	>(undefined);
function GenerativeSlot() {
	const render = useContext(GenerativeContext);
	return <div style={{ marginBottom: "0.5rem" }}>{render?.()}</div>;
}

const EMPTY_PROMPT_MESSAGES: { id: string; role: string; content: string }[] =
	[];
