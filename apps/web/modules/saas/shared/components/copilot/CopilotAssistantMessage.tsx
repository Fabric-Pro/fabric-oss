"use client";

import { useCoAgent, useCopilotChat } from "@copilotkit/react-core";
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
import { useMemo, useState } from "react";
import { McpAppFrame } from "../../../../../components/ai-elements/McpAppFrame";
import { useOrganizationId } from "../../../organizations/hooks/use-organization-context";
import { DiffOutcomeChip } from "../../../projects/components/copilot/DiffOutcomeChip";
import { useDocumentAssistantOutcomes } from "../../../projects/components/copilot/DocumentAssistantOutcomesProvider";
import { ChatMessageInsertDiagramButton } from "../../../projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton";
import { deriveDiagramTitle } from "../../../projects/components/excalidraw-auto-insert/deriveDiagramTitle";
import { useActiveTipTapEditor } from "../../../projects/components/excalidraw-auto-insert/useActiveTipTapEditor";
import { useChatScopedProjectFromCopilotChat } from "../../../projects/components/excalidraw-auto-insert/useChatScopedProject";
import {
	formatMessageTimestamp,
	type TimestampSource,
} from "./formatMessageTimestamp";
import {
	ReasoningCollapsible,
	type ToolCallEntry,
} from "./ReasoningCollapsible";

/**
 * MCP-app envelope shape written by `/api/mcp-app/invoke` and read
 * here to mount `<McpAppFrame>` inline in the chat.
 *
 * Why this lives here (and not on `useCopilotAction({ render })`):
 * CopilotKit's `useCopilotAction` `render` only fires for assistant
 * messages whose `generativeUI` is set during action dispatch. When a
 * frontend `useCopilotAction` is paired with an external LangGraph
 * agent (CopilotSidebar + `useCoAgent`), the action's `handler` runs
 * client-side and the result lands in the message stream as a
 * `ResultMessage`/`tool` role — but `generativeUI` is never attached
 * to the next assistant message, so the per-action `render` is dead
 * code. The result IS present in `messages` though, so we extract the
 * envelope here and inject the canvas next to the assistant reply.
 *
 * Keep the key in lockstep with the writer at
 * `apps/web/app/api/mcp-app/invoke/route.ts`.
 */
const FABRIC_MCP_RENDER_KEY = "__fabricMcpRender";

interface FabricMcpRenderEnvelope {
	resourceUri: string;
	configId: string;
	checkpointId?: string | null;
	toolArgs?: Record<string, unknown>;
}

function extractEnvelopeFromMessage(
	msg: unknown,
): FabricMcpRenderEnvelope | null {
	if (!msg || typeof msg !== "object") {
		return null;
	}
	const m = msg as Record<string, unknown>;
	// CopilotKit's runtime-client-gql exposes tool results either as a
	// `ResultMessage` (with `result: string`) or as `content`. Try both.
	const candidates: unknown[] = [m.result, m.content];
	for (const cand of candidates) {
		if (typeof cand !== "string") {
			continue;
		}
		try {
			const parsed = JSON.parse(cand);
			if (parsed && typeof parsed === "object") {
				const env = (parsed as Record<string, unknown>)[
					FABRIC_MCP_RENDER_KEY
				];
				if (
					env &&
					typeof env === "object" &&
					typeof (env as { resourceUri?: unknown }).resourceUri ===
						"string" &&
					typeof (env as { configId?: unknown }).configId === "string"
				) {
					return env as FabricMcpRenderEnvelope;
				}
			}
		} catch {
			// fall through
		}
	}
	return null;
}

function isResultMessage(
	msg: unknown,
): msg is { type: "ResultMessage"; result: string } {
	if (!msg || typeof msg !== "object") {
		return false;
	}
	const m = msg as Record<string, unknown>;
	return (
		m.type === "ResultMessage" ||
		(m as { isResultMessage?: () => boolean }).isResultMessage?.() === true
	);
}

/**
 * Inline `<McpAppFrame>` mount for a tool-result envelope. Isolated
 * into its own component (same pattern as `ExcalidrawAutoInsertSlot`
 * below) so the `useOrganizationId` hook only runs when an envelope is
 * actually present. The org id matters: `<ExcalidrawPreview>` resolves
 * the scene via `read_checkpoint` through `/api/mcp-app/call-tool`,
 * whose config lookup is tenant-scoped — a hardcoded `null` here made
 * org-tenant lookups run in personal context and 404 ("Failed to load
 * diagram (404)"), the failure class documented in the agent's
 * `<excalidraw-embed>` prompt block.
 *
 * Exported for unit tests.
 */
export function InlineMcpFrameSlot({
	envelope,
}: {
	envelope: FabricMcpRenderEnvelope;
}) {
	const activeOrganizationId = useOrganizationId();
	return (
		<McpAppFrame
			resourceUri={envelope.resourceUri}
			configId={envelope.configId}
			organizationId={activeOrganizationId ?? null}
			toolArgs={envelope.toolArgs}
			toolResult={
				envelope.checkpointId
					? JSON.stringify({
							checkpointId: envelope.checkpointId,
						})
					: undefined
			}
			surface="chat"
			className="mb-2"
		/>
	);
}

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
	 * Passing a name that isn't a registered coagent is safe — CopilotKit's
	 * `useCoAgent` returns a noop `{ state: {} }` in that case (verified at
	 * `@copilotkit/react-core` dist/index.cjs:3395-3411). The reasoning UI
	 * simply doesn't render.
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
	function CopilotAssistantMessageInner(props: AssistantMessageProps) {
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

		const content = message?.content || "";
		const subComponent = message?.generativeUI?.();

		// Pair this assistant message with the most recent preceding
		// tool-result message that carries an MCP-app render envelope.
		// CopilotKit's `RenderMessage` only handles `user` / `assistant`
		// roles — `ResultMessage`s are filtered out before reaching the
		// AssistantMessage component, and the `messages` prop CopilotKit
		// passes here contains the same filtered list, so we can't find
		// the tool result via props. The full stream (including
		// ResultMessages) lives in `useCopilotChat().visibleMessages`,
		// which is what we scan. Scope: only the LATEST tool result before
		// this assistant message — so each canvas appears exactly once,
		// next to the assistant turn that produced it.
		const { visibleMessages } = useCopilotChat();

		const inlineMcpEnvelope =
			useMemo<FabricMcpRenderEnvelope | null>(() => {
				if (!message) {
					return null;
				}
				const all = (visibleMessages || []) as unknown[];
				if (all.length === 0) {
					return null;
				}
				const targetId = (message as { id?: string }).id;
				// Locate this assistant message in the full stream.
				const idx = all.findIndex(
					(m) => (m as { id?: string }).id === targetId,
				);
				// If we can't find the message, default to scanning the whole
				// stream (e.g. the assistant message hasn't been registered yet
				// but the result has — show the latest pending envelope).
				const upper = idx === -1 ? all.length : idx;
				// Walk backwards from the assistant message until we hit the
				// previous user message; pick the first ResultMessage that
				// carries an envelope.
				for (let i = upper - 1; i >= 0; i--) {
					const m = all[i];
					const role = (m as { role?: string }).role;
					if (role === "user") {
						break;
					}
					if (isResultMessage(m)) {
						const env = extractEnvelopeFromMessage(m);
						if (env) {
							return env;
						}
					}
				}
				return null;
			}, [message, visibleMessages]);

		// Reasoning trace lookup (PO follow-up to F-1171).
		//
		// Source of data flow:
		//   chat-node writes state.reasoningByTurn[turnIndex] keyed by
		//   countHumanMessages(state.messages) → AG-UI STATE_SNAPSHOT →
		//   useCoAgent({ name: agentName }).state.
		//
		// `agentName` is closed over from the factory args. The 4 module-scope
		// exports below bind it to the per-surface agent name; the default
		// export is bound to `project_document_generator` for F-1171 surfaces.
		//
		// turnIndex here MIRRORS the backend computation: count user-role
		// messages in visibleMessages up to and including the user message
		// immediately preceding this assistant message. So the first
		// assistant reply → turnIndex 1, second → 2, etc.
		//
		// Safety on non-agent pages: `useCoAgent` with a name that isn't
		// registered (e.g. surfaces that use CopilotChat but no CoAgent)
		// returns a noop `{ state: {} }`. Verified at @copilotkit/react-core
		// (dist/index.cjs:3395-3411). So this lookup is a safe no-op on
		// surfaces where the agent isn't bound.
		const { state: agentState } = useCoAgent<{
			reasoningByTurn?: Record<
				number,
				{ text: string; durationMs: number }
			>;
			toolCallsByTurn?: Record<number, ToolCallEntry[]>;
		}>({ name: agentName });

		// Compute the turnIndex for this assistant message once and share it
		// across the reasoning and tool-call lookups. turnIndex MIRRORS the
		// backend's `countHumanMessages(state.messages)` so the same key
		// resolves the agent's per-turn writes. AG-UI uses `role === "user"`
		// on the wire; LangChain uses `HumanMessage` class on the backend —
		// both produce the same count.
		const turnIndex = useMemo<number | null>(() => {
			if (!message) {
				return null;
			}
			// Primary: count user messages in visibleMessages preceding this
			// assistant message. Works when useCopilotChat returns populated
			// visibleMessages.
			const all = (visibleMessages || []) as unknown[];
			if (all.length > 0) {
				const targetId = (message as { id?: string }).id;
				if (targetId) {
					const idx = all.findIndex(
						(m) => (m as { id?: string }).id === targetId,
					);
					if (idx !== -1) {
						let count = 0;
						for (let i = 0; i < idx; i++) {
							if ((all[i] as { role?: string }).role === "user") {
								count++;
							}
						}
						if (count >= 1) {
							return count;
						}
					}
				}
			}
			// Fallback: useCopilotChat().visibleMessages returns [] inside
			// CopilotAssistantMessage in some CopilotKit configurations (the
			// hook subscribes to a different context than the surrounding
			// RenderMessage tree). Derive turnIndex from agentState.messages
			// — count HumanMessages — which matches the backend's
			// countHumanMessages(state.messages) keying.
			//
			// CRITICAL: gate this fallback on `isCurrentMessage`. The agent
			// state only carries trace data for the CURRENT in-progress turn,
			// so applying the fallback to historical assistant messages would
			// paint each scroll-back reply with the latest turn's reasoning
			// and tools — a misattribution that lies about state. Only the
			// in-progress (current) message is allowed the fallback; older
			// messages return null so the trace silently disappears for them
			// (preferred over showing wrong trace). Proper per-message
			// carry — embedding toolCalls into AIMessage.additional_kwargs
			// (DirectChat pattern) — is tracked as a separate follow-up.
			if (isCurrentMessage) {
				const agentMsgs = (agentState as { messages?: unknown[] })
					?.messages;
				if (Array.isArray(agentMsgs) && agentMsgs.length > 0) {
					let humanCount = 0;
					for (const m of agentMsgs) {
						const o = m as {
							id?: unknown;
							type?: string;
							role?: string;
							_getType?: () => string;
						};
						if (typeof o?._getType === "function") {
							if (o._getType() === "human") {
								humanCount++;
							}
							continue;
						}
						if (
							Array.isArray(o?.id) &&
							(o.id as unknown[]).includes("HumanMessage")
						) {
							humanCount++;
							continue;
						}
						if (o?.type === "human" || o?.role === "user") {
							humanCount++;
						}
					}
					if (humanCount >= 1) {
						return humanCount;
					}
				}
			}
			return null;
		}, [message, visibleMessages, agentState, isCurrentMessage]);

		const reasoning = useMemo<{
			text: string;
			durationMs?: number;
		} | null>(() => {
			if (turnIndex === null) {
				return null;
			}
			const reasoningByTurn = agentState?.reasoningByTurn;
			if (!reasoningByTurn) {
				return null;
			}
			const entry = reasoningByTurn[turnIndex];
			if (!entry || typeof entry.text !== "string") {
				return null;
			}
			return { text: entry.text, durationMs: entry.durationMs };
		}, [turnIndex, agentState]);

		const toolCalls = useMemo<ToolCallEntry[] | null>(() => {
			if (turnIndex === null) {
				return null;
			}
			const toolCallsByTurn = agentState?.toolCallsByTurn;
			if (!toolCallsByTurn) {
				return null;
			}
			const entries = toolCallsByTurn[turnIndex];
			if (!Array.isArray(entries) || entries.length === 0) {
				return null;
			}
			return entries;
		}, [turnIndex, agentState]);

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
		const formattedTimestamp =
			content && !isLoading && !isGenerating
				? formatMessageTimestamp((message ?? {}) as TimestampSource)
				: null;

		// Excalidraw chat -> editor auto-insert (F4 / spec § 8.1 row 4).
		// The button renders BELOW the inline `<McpAppFrame>` block,
		// conditional on the envelope's resource URI containing
		// "excalidraw". The Copilot sidebar is mounted INSIDE the
		// document/story page that owns the editor, so exactly one
		// matching editor will be registered with the TiptapEditorRegistry
		// (spec § 9 step 2). The hook setup is moved into a sibling
		// sub-component so the new hooks (`useParams`, `useOrganizationId`,
		// `useActiveTipTapEditor`, etc.) only mount when an Excalidraw
		// envelope is actually present — keeping non-Excalidraw render
		// paths free of the new dependency graph.
		const isExcalidrawEnvelope =
			!!inlineMcpEnvelope &&
			typeof inlineMcpEnvelope.resourceUri === "string" &&
			inlineMcpEnvelope.resourceUri.includes("excalidraw");
		const excalidrawMessageId = (message as { id?: string } | undefined)
			?.id;

		return (
			<>
				{inlineMcpEnvelope && (
					<InlineMcpFrameSlot envelope={inlineMcpEnvelope} />
				)}
				{isExcalidrawEnvelope &&
					inlineMcpEnvelope &&
					excalidrawMessageId && (
						<ExcalidrawAutoInsertSlot
							envelope={inlineMcpEnvelope}
							messageId={excalidrawMessageId}
							visibleMessages={visibleMessages}
						/>
					)}
				{(reasoning || toolCalls) && (
					<ReasoningCollapsible
						text={reasoning?.text ?? ""}
						durationMs={reasoning?.durationMs}
						toolCalls={toolCalls ?? undefined}
						inProgress={
							isCurrentMessage &&
							(isLoading || isGenerating) &&
							!content
						}
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
										{onThumbsUp && (
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														className="copilotKitMessageControlButton"
														onClick={() =>
															message &&
															onThumbsUp(message)
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
										{onThumbsDown && (
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														className="copilotKitMessageControlButton"
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
														{icons.thumbsDownIcon}
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
				<div style={{ marginBottom: "0.5rem" }}>{subComponent}</div>
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
	return CopilotAssistantMessageInner;
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
