"use client";

import {
	AgentAvatar,
	VendorLogo,
} from "@saas/agents/components/FabricChat/shared/AgentIdentity";
import { isModelSelectionId } from "@saas/agents/components/FabricChat/shared/agent-selection";
import { ChatFailureNotice } from "@saas/agents/components/FabricChat/shared/ChatFailureNotice";
import { StoppedIndicator } from "@saas/agents/components/StoppedIndicator";
import type { ApprovalSendResult } from "@saas/agents/lib/approval-response";
import type { AgentResponse } from "@saas/agents/lib/multi-agent-response";
import {
	ChatApprovalCard,
	type ChatApprovalDecision,
} from "@saas/ai/components/ChatApprovalCard";
import { ChatMessageInsertDiagramButton } from "@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton";
import { deriveDiagramTitle } from "@saas/projects/components/excalidraw-auto-insert/deriveDiagramTitle";
import { useActiveTipTapEditor } from "@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor";
import type { ChatScope } from "@saas/projects/components/excalidraw-auto-insert/useChatScopedProject";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronUpIcon,
	CopyIcon,
	EyeIcon,
	Loader2Icon,
	XCircleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import {
	DefaultMcpStatusCard,
	type DefaultMcpStatusCtaPayload,
	isDefaultMcpStatusCta,
} from "../../../../../../components/ai-elements/DefaultMcpStatusCard";
import {
	McpAppFrame,
	prefetchMcpAppHtml,
} from "../../../../../../components/ai-elements/McpAppFrame";
import { Response } from "../../../../../../components/ai-elements/response";
import { TypingResponse } from "../../../../../../components/ai-elements/typing-response";

/**
 * One agent's answer in a multi-agent turn: its avatar or vendor logo, the
 * tool steps it ran, MCP App frames (with the Excalidraw insert button), the
 * default-MCP status card, its approval, and the answer with HTML preview
 * and copy. Shared by Nexus (`CopilotPage`) and the Orchestrator chat's
 * multi-agent mode.
 */

// ── HTML detection helpers ──────────────────────────────────────────────────────

function isHtmlDocument(content: string): boolean {
	const trimmed = content.trim();
	if (/^<!doctype\s+html/i.test(trimmed)) {
		return true;
	}
	if (/^<html[\s>]/i.test(trimmed)) {
		return true;
	}
	if (/<head[\s>]/i.test(trimmed) && /<body[\s>]/i.test(trimmed)) {
		return true;
	}
	return false;
}

function extractHtml(content: string): string | null {
	if (isHtmlDocument(content)) {
		return content.trim();
	}
	const fenced = content.match(/```html\s*\n([\s\S]*?)(?:\n```|$)/i);
	if (fenced?.[1] && isHtmlDocument(fenced[1])) {
		return fenced[1].trim();
	}
	return null;
}

interface ToolCallDisplayItem {
	id: string;
	name: string;
	args?: unknown;
	result?: unknown;
	status: "pending" | "running" | "complete" | "error" | "success";
	serverName?: string;
	durationMs?: number;
	/** MCP App: ui:// resource URI — present when tool has an interactive UI */
	mcpAppResourceUri?: string;
	/** MCP App: config ID for proxying tool calls from the iframe */
	mcpAppConfigId?: string;
}

// ── Excalidraw auto-insert helpers ────────────────────────────────────────────

/**
 * Probe the standard MCP `create_view` checkpoint locations on a tool
 * result. Mirrors the private `extractCheckpointId` in
 * `apps/web/components/ai-elements/McpAppFrame.tsx:229-273` so the Nexus
 * surface can derive the same `checkpointId` value the Excalidraw canvas
 * sees, without modifying `McpAppFrame` itself (spec § 22.1 cites that
 * file as no-changes).
 */
function extractCheckpointIdFromToolResult(toolResult: unknown): string | null {
	if (!toolResult || typeof toolResult !== "object") {
		return null;
	}
	const res = toolResult as Record<string, unknown>;
	if (typeof res.checkpointId === "string") {
		return res.checkpointId;
	}
	if (typeof res.checkpoint_id === "string") {
		return res.checkpoint_id;
	}
	const structuredContent =
		typeof res.structuredContent === "object" &&
		res.structuredContent !== null
			? (res.structuredContent as Record<string, unknown>)
			: null;
	if (structuredContent) {
		if (typeof structuredContent.checkpointId === "string") {
			return structuredContent.checkpointId;
		}
		if (typeof structuredContent.checkpoint_id === "string") {
			return structuredContent.checkpoint_id;
		}
	}
	const content = res.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const text =
				typeof block === "object" && block !== null && "text" in block
					? (block as { text: unknown }).text
					: null;
			if (typeof text === "string") {
				const m = text.match(
					/checkpoint[_\s-]?id[:\s"]+([a-zA-Z0-9_-]+)/i,
				);
				if (m?.[1]) {
					return m[1];
				}
			}
		}
	}
	return null;
}

/**
 * Predicate -- should the Excalidraw auto-insert button be mounted
 * beneath a given Nexus tool call? Exported so the unit test in
 * `__tests__/CopilotPage.excalidraw-button.test.tsx` can lock the
 * "Excalidraw + complete-status" gate without rendering the whole
 * CopilotPage. Spec § 8.1 (Nexus row) + § 22.1.
 */
export function shouldRenderNexusExcalidrawAutoInsertButton(tc: {
	mcpAppResourceUri?: string | null;
	status?: string;
}): boolean {
	const isExcalidrawCreateView =
		typeof tc.mcpAppResourceUri === "string" &&
		tc.mcpAppResourceUri.includes("excalidraw");
	const isCompleted = tc.status === "complete" || tc.status === "success";
	return isExcalidrawCreateView && isCompleted;
}

/**
 * Mount point for the Excalidraw chat -> editor auto-insert button on
 * Nexus (F1 / spec § 8.1 row 1). Isolated into its own component so the
 * hook graph it pulls in (`useActiveTipTapEditor`) only runs when the
 * tool call is actually a completed Excalidraw `create_view`.
 *
 * Nexus is not bound to a project — `chatScope.projectId` is `null`, the
 * resolver returns `null`, and the button surfaces the picker path
 * (FR-7). The `chatScope` is computed once per `AgentResponseBlock` from
 * `useChatScopedProjectFromMultiAgentStream` and threaded in here.
 *
 * Exported for the unit test only -- not part of the public API.
 */
export function NexusExcalidrawAutoInsertSlot({
	tc,
	chatScope,
	organizationSlug,
}: {
	tc: {
		id: string;
		args: unknown;
		result: unknown;
		mcpAppResourceUri: string;
		mcpAppConfigId: string;
	};
	chatScope: ChatScope;
	organizationSlug?: string | null;
}) {
	const toolArgs = (tc.args ?? {}) as Record<string, unknown>;
	const checkpointId = useMemo(
		() => extractCheckpointIdFromToolResult(tc.result),
		[tc.result],
	);

	const toolResult = useMemo(
		() => ({
			elements: toolArgs.elements,
			appState: toolArgs.appState,
			checkpointId: checkpointId ?? "",
			mcpConfigId: tc.mcpAppConfigId,
			resourceUri: tc.mcpAppResourceUri,
		}),
		[
			toolArgs.elements,
			toolArgs.appState,
			checkpointId,
			tc.mcpAppConfigId,
			tc.mcpAppResourceUri,
		],
	);

	const resolverOptions = useMemo(
		() => ({
			chatContext: {
				projectId: chatScope.projectId,
				organizationId: chatScope.organizationId,
				surface: "nexus" as const,
			},
			// Nexus isn't mounted under `FabricAgentLauncherProvider`;
			// launcher context is always null here. The resolver step (3)
			// defensive cross-tab fallback only matches when the chat is
			// project-scoped (which Nexus never is), so the resolver
			// returns null and the picker path (FR-7) activates.
			launcherContext: null,
		}),
		[chatScope.projectId, chatScope.organizationId],
	);
	const resolverTarget = useActiveTipTapEditor(resolverOptions);

	const title = useMemo(() => {
		const promptText = chatScope.lastUserPromptForMessage(tc.id);
		return deriveDiagramTitle({ userPromptText: promptText });
	}, [chatScope, tc.id]);

	return (
		<ChatMessageInsertDiagramButton
			surface="nexus"
			chatMessageId={tc.id}
			toolResult={toolResult}
			organizationSlug={organizationSlug ?? null}
			chatScope={chatScope}
			resolverOptions={resolverOptions}
			resolverTarget={resolverTarget}
			title={title}
		/>
	);
}

// ── AgentResponseBlock ─────────────────────────────────────────────────────────

export function AgentResponseBlock({
	response,
	organizationId,
	organizationSlug,
	chatScope,
	onApprovalRespond,
}: {
	response: AgentResponse;
	organizationId?: string | null;
	organizationSlug?: string | null;
	chatScope: ChatScope;
	/**
	 * Answer the agent's approval through the host (a multi-agent turn
	 * answers through its run). Without it the card answers through the
	 * orchestrator's approve route for the agent's execution.
	 */
	onApprovalRespond?: (
		approvalId: string,
		decision: ChatApprovalDecision,
	) => Promise<ApprovalSendResult>;
}) {
	const tTooltips = useTranslations("tooltips.common");
	const [copied, setCopied] = useState(false);
	const [showPreview, setShowPreview] = useState(false);

	const htmlContent = useMemo(
		() => (response.content ? extractHtml(response.content) : null),
		[response.content],
	);

	const handleCopy = () => {
		navigator.clipboard.writeText(response.content);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const toolCallItems: ToolCallDisplayItem[] = response.toolCalls.map(
		(tc) => ({
			id: tc.id,
			name: tc.name,
			args: tc.args,
			result: tc.result,
			serverName: tc.serverName,
			status: tc.status,
			mcpAppResourceUri: tc.mcpAppResourceUri,
			mcpAppConfigId: tc.mcpAppConfigId,
		}),
	);

	// Tool calls that have an MCP App interactive UI — rendered inline after the panel
	const mcpAppToolCalls = toolCallItems.filter(
		(
			tc,
		): tc is ToolCallDisplayItem & {
			mcpAppResourceUri: string;
			mcpAppConfigId: string;
		} =>
			Boolean(
				tc.mcpAppResourceUri &&
					tc.mcpAppConfigId &&
					tc.status !== "error",
			),
	);

	// Default-enabled MCP status — when the orchestrator's
	// `applyDefaultMcpEagerRouting` helper either cannot resolve a
	// tenant `MCPConfig` row for a default-enabled server, or the
	// eager-load step fails, it emits a synthetic structured-CTA tool
	// result carrying the payload accepted by `<DefaultMcpStatusCard>`.
	// Two tool-call names are matched: `fabric_connect_excalidraw_cta`
	// is the legacy emission preserved for backwards compatibility (the
	// Nexus connection-needed branch for Excalidraw) and
	// `fabric_default_mcp_status` is the new generalized emission used
	// for service-down + future default-enabled servers. The discrimi-
	// nator on the payload (`kind`) selects the rendered branch. See
	// `nexus-excalidraw-routing.spec.ts` scenario 2 for the legacy
	// contract.
	const defaultMcpStatusCtas = toolCallItems.filter(
		(tc) =>
			(tc.name === "fabric_connect_excalidraw_cta" ||
				tc.name === "fabric_default_mcp_status") &&
			isDefaultMcpStatusCta(tc.result),
	);

	// Pre-fetch MCP App HTML when tool calls with resourceUri appear
	useEffect(() => {
		for (const tc of mcpAppToolCalls) {
			if (tc.mcpAppResourceUri && tc.mcpAppConfigId) {
				prefetchMcpAppHtml(
					tc.mcpAppConfigId,
					tc.mcpAppResourceUri,
					organizationId,
				);
			}
		}
	}, [mcpAppToolCalls, organizationId]);

	const isModelAgent = isModelSelectionId(response.agentId);
	const pendingApproval = response.pendingApproval;

	return (
		<div className="group flex gap-4">
			{/* Avatar */}
			{isModelAgent && response.vendor ? (
				<VendorLogo vendor={response.vendor} size={32} />
			) : (
				<AgentAvatar name={response.agentName} />
			)}

			{/* Content */}
			<div className="flex-1 min-w-0">
				{/* Agent name label */}
				<p className="mb-2 text-sm font-semibold text-foreground">
					{response.agentName}
				</p>

				{/* Tool calls (if any) */}
				{toolCallItems.length > 0 && (
					<StepExecutionPanel
						toolCalls={toolCallItems}
						isStreaming={response.isLoading}
					/>
				)}

				{/* MCP App interactive UIs — rendered inline for completed tool calls with UI resources */}
				{mcpAppToolCalls.map((tc) => (
					<div key={tc.id}>
						<McpAppFrame
							resourceUri={tc.mcpAppResourceUri as string}
							configId={tc.mcpAppConfigId as string}
							organizationId={organizationId}
							toolArgs={tc.args as Record<string, unknown>}
							toolResult={tc.result}
							// Nexus embeds the canvas inside a scrollable
							// conversation, so the canvas must NOT hijack
							// the wheel — same UX rule as the AI Feature
							// Assistant sidebar. `surface="chat"` enables
							// the capture-phase wheel handler that forwards
							// `deltaY` to the nearest scrollable ancestor.
							surface="chat"
							className="mt-3"
							onUpdateModelContext={(content) => {
								// Forward widget edit diffs as context for next message
								const text = content
									.flatMap((c) =>
										typeof c === "object" &&
										c !== null &&
										"type" in c &&
										c.type === "text" &&
										"text" in c &&
										typeof c.text === "string" &&
										c.text
											? [c.text]
											: [],
									)
									.join("\n");
								if (text) {
									console.info(
										"[Nexus] Diagram edit context:",
										text,
									);
								}
							}}
						/>
						{/* Spec § 8.1 / § 22.1 -- mount the auto-insert
						    button as a sibling below the canvas, only
						    when the tool call is a completed Excalidraw
						    `create_view`. */}
						{shouldRenderNexusExcalidrawAutoInsertButton(tc) ? (
							<NexusExcalidrawAutoInsertSlot
								tc={{
									id: tc.id,
									args: tc.args,
									result: tc.result,
									mcpAppResourceUri: tc.mcpAppResourceUri,
									mcpAppConfigId: tc.mcpAppConfigId,
								}}
								chatScope={chatScope}
								organizationSlug={organizationSlug}
							/>
						) : null}
					</div>
				))}

				{/* Default-enabled MCP status card — emitted by the
				    workflow's `applyDefaultMcpEagerRouting` helper for
				    either the connection-needed or service-down branch
				    of a default-enabled MCP server (Excalidraw in v1).
				    The `kind` discriminator on the payload selects the
				    rendered variant. */}
				{defaultMcpStatusCtas.map((tc) => (
					<div key={tc.id} className="mt-3">
						<DefaultMcpStatusCard
							payload={tc.result as DefaultMcpStatusCtaPayload}
						/>
					</div>
				))}

				{/* Approval card — shown when orchestrator needs user approval before proceeding */}
				{pendingApproval &&
					(onApprovalRespond ? (
						<ChatApprovalCard
							key={pendingApproval.approvalId}
							approvalId={pendingApproval.approvalId}
							stepId={pendingApproval.stepId}
							reason={pendingApproval.reason}
							onRespond={(decision) =>
								onApprovalRespond(
									pendingApproval.approvalId,
									decision,
								)
							}
							organizationId={organizationId}
						/>
					) : response.executionId ? (
						<ChatApprovalCard
							approvalId={pendingApproval.approvalId}
							stepId={pendingApproval.stepId}
							reason={pendingApproval.reason}
							executionId={response.executionId}
							organizationId={organizationId}
						/>
					) : null)}

				{/* Message content or thinking indicator */}
				{response.isLoading &&
				!response.content &&
				toolCallItems.length === 0 &&
				!response.pendingApproval ? (
					<ThinkingIndicator />
				) : response.isError ? (
					<ChatFailureNotice
						content={
							response.errorMessage ? response.content : undefined
						}
						error={
							response.errorMessage ||
							response.content ||
							"An error occurred."
						}
					/>
				) : (
					<div className="relative">
						{/* HTML preview buttons */}
						{htmlContent && !response.isLoading && (
							<div className="flex items-center gap-1.5 mb-2">
								<button
									type="button"
									onClick={() => setShowPreview(true)}
									className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-muted text-muted-foreground hover:text-foreground transition-colors"
								>
									<EyeIcon className="size-3" />
									Preview
								</button>
								<button
									type="button"
									onClick={() =>
										navigator.clipboard.writeText(
											htmlContent,
										)
									}
									className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-muted text-muted-foreground hover:text-foreground transition-colors"
								>
									<CopyIcon className="size-3" />
								</button>
							</div>
						)}
						<div className="text-base text-foreground leading-relaxed">
							{response.isLoading ? (
								<TypingResponse animate streaming>
									{response.content}
								</TypingResponse>
							) : (
								<Response>{response.content}</Response>
							)}
						</div>
						{/* Editorial "Stopped" chip — rendered directly under
						 * the response text when the user halted this agent
						 * (spec § 4.2 / 8.9). Sits inside the relative
						 * wrapper, ABOVE the hover-revealed Copy button, so
						 * the chip stays close to the text instead of
						 * floating below an invisible-but-space-consuming
						 * button. Already-completed agents in the same turn
						 * keep their existing completion treatment
						 * (decision 18 / AC-6) — only agents whose
						 * `status === "cancelled"` show this chip. */}
						{response.status === "cancelled" && (
							<StoppedIndicator className="mt-1" />
						)}
						{response.isLoading && !response.pendingApproval && (
							<ThinkingIndicator
								label={
									toolCallItems.length > 0
										? "Working"
										: "Still thinking"
								}
							/>
						)}
						{/* HTML preview dialog */}
						{htmlContent && (
							<HtmlPreviewDialog
								html={htmlContent}
								open={showPreview}
								onClose={() => setShowPreview(false)}
							/>
						)}
						{/* Copy button on hover */}
						{!response.isLoading && response.content && (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={handleCopy}
										className="mt-2 flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-muted text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground"
									>
										{copied ? (
											<CheckCircle2Icon className="size-3 text-secondary" />
										) : (
											<CopyIcon className="size-3" />
										)}
										{copied ? "Copied!" : "Copy"}
									</button>
								</TooltipTrigger>
								<TooltipContent>
									{tTooltips("copy")}
								</TooltipContent>
							</Tooltip>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// ── Thinking indicator ─────────────────────────────────────────────────────────

function ThinkingIndicator({ label }: { label?: string }) {
	return (
		<div className="flex items-center gap-2 text-muted-foreground text-sm py-1">
			<div className="flex gap-1" aria-hidden="true">
				<span className="size-1.5 rounded-full bg-muted-foreground/60 motion-safe:animate-bounce [animation-delay:0ms]" />
				<span className="size-1.5 rounded-full bg-muted-foreground/60 motion-safe:animate-bounce [animation-delay:150ms]" />
				<span className="size-1.5 rounded-full bg-muted-foreground/60 motion-safe:animate-bounce [animation-delay:300ms]" />
			</div>
			{label && <span className="text-xs">{label}</span>}
		</div>
	);
}

// ── Step execution panel ───────────────────────────────────────────────────────

function StepExecutionPanel({
	toolCalls,
	isStreaming,
}: {
	toolCalls: ToolCallDisplayItem[];
	isStreaming?: boolean;
}) {
	const hasRunning = toolCalls.some(
		(tc) => tc.status === "pending" || tc.status === "running",
	);
	// Auto-expand while streaming; default to collapsed when done
	// userExpanded=null means "use default"; true/false = user override
	const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
	const expanded =
		userExpanded !== null ? userExpanded : isStreaming && hasRunning;

	if (toolCalls.length === 0) {
		return null;
	}

	const hasError = toolCalls.some((tc) => tc.status === "error");
	// Current running tool for status label
	const runningTool = toolCalls.find(
		(tc) => tc.status === "running" || tc.status === "pending",
	);
	const runningLabel = runningTool
		? (runningTool.name.split("__").pop() ?? runningTool.name)
		: null;

	return (
		<div className="mt-2 mb-3 rounded-lg border border-border bg-muted/30 overflow-hidden">
			<button
				type="button"
				onClick={() =>
					setUserExpanded((v) => (v !== null ? !v : !expanded))
				}
				className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors text-left"
				aria-expanded={expanded}
			>
				{hasRunning ? (
					<Loader2Icon className="size-3 motion-safe:animate-spin shrink-0 text-primary" />
				) : hasError ? (
					<XCircleIcon className="size-3 text-destructive shrink-0" />
				) : (
					<CheckCircle2Icon className="size-3 text-secondary shrink-0" />
				)}
				<span className="font-medium">
					{hasRunning && runningLabel ? (
						<>
							<span className="text-foreground">
								{runningLabel}
							</span>
							<span className="text-muted-foreground/70">
								{" "}
								· {toolCalls.length} step
								{toolCalls.length !== 1 ? "s" : ""}
							</span>
						</>
					) : (
						<>
							{toolCalls.length} step
							{toolCalls.length !== 1 ? "s" : ""}
							{hasError ? " (with errors)" : " completed"}
						</>
					)}
				</span>
				{expanded ? (
					<ChevronUpIcon className="ml-auto size-3 shrink-0" />
				) : (
					<ChevronDownIcon className="ml-auto size-3 shrink-0" />
				)}
			</button>

			{expanded && (
				<div className="border-t border-border/60 divide-y divide-border/40">
					{toolCalls.map((tc) => (
						<ToolCallRow key={tc.id} toolCall={tc} />
					))}
				</div>
			)}
		</div>
	);
}

// ── Tool call row ──────────────────────────────────────────────────────────────

function ToolCallRow({ toolCall }: { toolCall: ToolCallDisplayItem }) {
	const [showArgs, setShowArgs] = useState(false);
	const shortName = toolCall.name.split("__").pop() ?? toolCall.name;
	const isRunning =
		toolCall.status === "pending" || toolCall.status === "running";
	const isError = toolCall.status === "error";
	const isDone =
		toolCall.status === "complete" || toolCall.status === "success";

	const hasDetails =
		toolCall.args !== undefined || toolCall.result !== undefined;

	return (
		<div className="px-3 py-2">
			<div className="flex items-center gap-2 min-w-0">
				{isRunning ? (
					<Loader2Icon className="size-3 motion-safe:animate-spin text-muted-foreground shrink-0" />
				) : isError ? (
					<XCircleIcon className="size-3 text-destructive shrink-0" />
				) : isDone ? (
					<CheckCircle2Icon className="size-3 text-secondary shrink-0" />
				) : (
					<CheckCircle2Icon className="size-3 text-muted-foreground/40 shrink-0" />
				)}
				<span className="text-xs font-medium text-foreground truncate">
					{shortName}
				</span>
				{toolCall.serverName && (
					<span className="text-[10px] text-muted-foreground/60 shrink-0">
						{toolCall.serverName}
					</span>
				)}
				{toolCall.durationMs !== undefined && !isRunning && (
					<span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">
						{toolCall.durationMs < 1000
							? `${toolCall.durationMs}ms`
							: `${(toolCall.durationMs / 1000).toFixed(1)}s`}
					</span>
				)}
				{hasDetails && (
					<button
						type="button"
						onClick={() => setShowArgs(!showArgs)}
						className={cn(
							"text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0",
							!toolCall.durationMs && "ml-auto",
						)}
					>
						{showArgs ? "hide" : "details"}
					</button>
				)}
			</div>
			{showArgs && toolCall.args !== undefined && (
				<div className="mt-1.5">
					<p className="text-[10px] font-medium text-muted-foreground/60 mb-0.5 uppercase tracking-wide">
						Input
					</p>
					<pre className="text-[10px] bg-card rounded-md p-2 overflow-auto max-h-32 text-muted-foreground border border-border/40">
						{JSON.stringify(toolCall.args, null, 2)}
					</pre>
				</div>
			)}
			{showArgs && toolCall.result !== undefined && (
				<div className="mt-1.5">
					<p className="text-[10px] font-medium text-muted-foreground/60 mb-0.5 uppercase tracking-wide">
						Result
					</p>
					<pre className="text-[10px] bg-card rounded-md p-2 overflow-auto max-h-32 text-muted-foreground border border-border/40">
						{typeof toolCall.result === "string"
							? toolCall.result.slice(0, 500)
							: JSON.stringify(toolCall.result, null, 2).slice(
									0,
									500,
								)}
					</pre>
				</div>
			)}
		</div>
	);
}

// ── HTML preview dialog ─────────────────────────────────────────────────────────

function HtmlPreviewDialog({
	html,
	open,
	onClose,
}: {
	html: string;
	open: boolean;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-5xl h-[85vh] p-0 gap-0 flex flex-col">
				<DialogHeader className="px-4 py-3 border-b shrink-0">
					<div className="flex items-center justify-between">
						<DialogTitle className="text-sm">
							HTML Preview
						</DialogTitle>
						<button
							type="button"
							onClick={() => navigator.clipboard.writeText(html)}
							className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-muted text-muted-foreground hover:text-foreground transition-colors mr-6"
						>
							<CopyIcon className="size-3" />
							Copy HTML
						</button>
					</div>
				</DialogHeader>
				<iframe
					title="HTML Preview"
					sandbox="allow-scripts"
					srcDoc={html}
					className="flex-1 w-full border-0 bg-white rounded-b-lg"
				/>
			</DialogContent>
		</Dialog>
	);
}
