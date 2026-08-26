"use client";

/**
 * CopilotPage
 *
 * Dust-style multi-agent parallel streaming companion page.
 * - Chat history sidebar (left panel, desktop)
 * - Landing view: serif greeting + compose input + full agent browser with tabs
 * - Compose input with agent chips and agent picker dropdown
 * - Conversation view with parallel SSE streams — one per selected agent
 * - Each agent response streams independently in real-time
 * - Chat persistence to AiChat database on completion
 */

import { useAnalytics } from "@analytics";
import {
	AI_CHAT_IMAGE_MIME_TYPES,
	AI_CHAT_SERVER_ALLOWED_EXTENSIONS,
	AI_CHAT_SERVER_ONLY_MIME_TYPES,
	type AiChatExtractionOutcome,
	buildAiChatAcceptAttribute,
	buildAiChatAttachmentEntry,
	DEFAULT_AI_CHAT_MAX_FILE_BYTES,
	DEFAULT_AI_CHAT_MIME_ALLOWLIST,
} from "@repo/utils/ai-chat-attachment";
import {
	AgentAvatar,
	VendorLogo,
} from "@saas/agents/components/FabricChat/shared/AgentIdentity";
import { AgentModelPicker } from "@saas/agents/components/FabricChat/shared/AgentModelPicker";
import {
	buildInstanceAgentConfig,
	type SelectedAgent,
} from "@saas/agents/components/FabricChat/shared/agent-selection";
import { StoppedIndicator } from "@saas/agents/components/StoppedIndicator";
import { useEscToStopOrClose } from "@saas/agents/hooks/useEscToStopOrClose";
import {
	type AgentResponse,
	type ConversationTurn,
	type MultiAgentExecutionOptions,
	useMultiAgentStream,
} from "@saas/agents/hooks/useMultiAgentStream";
import { BUILT_IN_CAPABILITIES } from "@saas/agents/lib/builtin-capabilities";
import {
	buildTurnsFromHistory,
	DEFAULT_AI_AGENT_NAME,
	getHistoryAssistantIdentity,
	type HistoryChatMessage,
	LEGACY_DEFAULT_AI_AGENT_NAME,
	parseHistoryAssistantMessage,
} from "@saas/agents/lib/conversation-turns";
import { computeAgentManagementView } from "@saas/agents/lib/registry-management";
import { useSession } from "@saas/auth/hooks/use-session";
import { McpLogo } from "@saas/mcp/components/McpLogo";
import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { ChatMessageInsertDiagramButton } from "@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton";
import { deriveDiagramTitle } from "@saas/projects/components/excalidraw-auto-insert/deriveDiagramTitle";
import { useActiveTipTapEditor } from "@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor";
import {
	type ChatScope,
	useChatScopedProjectFromMultiAgentStream,
} from "@saas/projects/components/excalidraw-auto-insert/useChatScopedProject";
import { prepareImageForAi } from "@saas/projects/lib/image-upload-utils";
import { useClipboardImagePaste } from "@saas/projects/lib/use-clipboard-image-paste";
import { CopilotSidebarAttachments } from "@saas/shared/components/copilot/CopilotSidebarAttachments";
import type { AttachedFile as CopilotAttachedFile } from "@saas/shared/components/copilot/use-copilot-document-upload";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { SparklesIcon } from "@saas/shared/components/icons/SparklesIcon";
import { SidebarEdgeHandle } from "@saas/shared/components/SidebarEdgeHandle";
import { getRandomGreeting } from "@saas/shared/lib/greetings";
import { AsanaIcon } from "@saas/workflows/lib/plugins/asana/icon";
import { AttioIcon } from "@saas/workflows/lib/plugins/attio/icon";
import { CanvaIcon } from "@saas/workflows/lib/plugins/canva/icon";
import { FreshserviceIcon } from "@saas/workflows/lib/plugins/freshservice/icon";
import { FrontIcon } from "@saas/workflows/lib/plugins/front/icon";
import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { SearchInput } from "@ui/components/search-input";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowUpIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronUpIcon,
	CopyIcon,
	EyeIcon,
	LayoutGridIcon,
	LayoutTemplateIcon,
	Loader2Icon,
	MicIcon,
	MoreHorizontalIcon,
	PaperclipIcon,
	PlusIcon,
	SearchIcon,
	Settings2Icon,
	StopCircleIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "../../../../components/ai-elements/conversation";
import {
	DefaultMcpStatusCard,
	type DefaultMcpStatusCtaPayload,
	isDefaultMcpStatusCta,
} from "../../../../components/ai-elements/DefaultMcpStatusCard";
import {
	McpAppFrame,
	prefetchMcpAppHtml,
} from "../../../../components/ai-elements/McpAppFrame";
import { Response } from "../../../../components/ai-elements/response";
import { TypingResponse } from "../../../../components/ai-elements/typing-response";
import { AgentInsightsSheet } from "../../agents/components/AgentInsightsSheet";
import { ConversationToolPicker } from "../../agents/components/FabricChat/ConversationToolPicker";
import {
	buildChatToolSelectionPayload,
	resolveSelectedChatToolIds,
} from "../lib/chat-tool-selection";
import {
	type PersistedSelectedAgent,
	persistSelectionShape,
} from "../lib/persist-selection";
import { ChatApprovalCard } from "./ChatApprovalCard";
import { ChatHistorySidebar } from "./ChatHistorySidebar";

// Nexus paste/drop image allowlist & per-paste cap. Module-level so the
// referentially-stable identity satisfies the `useClipboardImagePaste` contract
// without needing per-render memoization. Mirrors the file-picker `accept`
// allowlist on the textarea (`.jpg,.jpeg,.png,.gif,.webp,.tiff`) so paste,
// drop, and the paperclip behave identically. Per spec §7 + decisions.md.
const NEXUS_PASTE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/tiff",
]);
/**
 * Read from the shared vocabulary rather than restated: paste and the paperclip
 * queue must refuse at the same byte, or the same image is accepted through one
 * entry point and rejected through the other.
 */
const NEXUS_PASTE_IMAGE_MAX_BYTES = DEFAULT_AI_CHAT_MAX_FILE_BYTES;

/**
 * What the picker advertises, derived rather than written out.
 *
 * The hand-kept string it replaces had already gone stale: it listed the
 * formats as of when it was typed, so `.csv` was accepted by the server and by
 * this surface's own validation while the picker refused to show it. A user
 * would have had to drag the file in to discover it worked.
 *
 * Nexus runs no canvas compression step, so it advertises the full image set
 * including TIFF — see `AI_CHAT_SERVER_ONLY_MIME_TYPES` for why the Feature
 * Assistant's is narrower.
 */
const NEXUS_FILE_ACCEPT = buildAiChatAcceptAttribute([
	...AI_CHAT_IMAGE_MIME_TYPES,
	...AI_CHAT_SERVER_ONLY_MIME_TYPES,
]);

/** Format seconds as `M:SS` for the in-row recording timer. */
function formatRecordingDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

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

function inferMimeTypeFromFilename(filename: string): string | null {
	const extension = filename.split(".").pop()?.toLowerCase();
	if (!extension) {
		return null;
	}

	const extensionToMime: Record<string, string> = {
		pdf: "application/pdf",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		txt: "text/plain",
		md: "text/markdown",
		html: "text/html",
		json: "application/json",
		csv: "text/csv",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		png: "image/png",
		gif: "image/gif",
		webp: "image/webp",
		tiff: "image/tiff",
		tif: "image/tiff",
	};

	return extensionToMime[extension] ?? null;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface BrowserAgent {
	id?: string;
	agentId: string;
	displayName: string;
	description?: string | null;
	scope: string;
	framework?: string | null;
	config?: Record<string, unknown> | null;
	metadata?: Record<string, unknown> | null;
	isTemplateInstance?: boolean;
	/** Full instructions for template instances */
	instructions?: string | null;
	/** MCP config IDs for template instances */
	enabledMcpConfigIds?: string[] | null;
	/** Workspace IDs for RAG scoping */
	workspaceIds?: string[];
	/** agent instance ID for memory/skills loading */
	instanceId?: string;
	/** Raw OAuth provider names from toolConnections (e.g. ["GITHUB"]) */
	enabledIntegrationProviders?: string[];
}

/**
 * One queued Nexus attachment.
 *
 * Deliberately the same status union the upload hook and Loom Direct carry, so
 * the shared chip component renders it without a translation layer and a fourth
 * shape cannot drift in.
 */
interface NexusAttachment {
	id: string;
	file: File;
	status: "pending" | "uploading" | "processing" | "ready" | "error";
	error?: string;
	extraction?: AiChatExtractionOutcome;
}

/**
 * Widen a queued attachment to the shape the shared chip renders.
 *
 * `documentId` is null because Nexus queues *before* an upload exists — it
 * uploads at send time, so there is nothing to point at until the turn is
 * already in flight. Every other field maps straight across, which is the
 * benefit of having taken the same status union rather than inventing one.
 */
function toChipRecord(attachment: NexusAttachment): CopilotAttachedFile {
	return {
		id: attachment.id,
		file: attachment.file,
		name: attachment.file.name,
		type: attachment.file.type,
		size: attachment.file.size,
		documentId: null,
		status: attachment.status,
		error: attachment.error,
		extraction: attachment.extraction,
	};
}

/**
 * Whether the chip row still has something to tell the user.
 *
 * `false` is the signal to clear: everything landed and none of it needs
 * saying. A clean upload should not leave chips behind for the next turn — the
 * Feature Assistant achieves that by clearing on send, and this is the same
 * guarantee at the moment Nexus can actually offer it, since its upload runs
 * *during* send rather than before it.
 *
 * A truncated read, a file with no readable text, or a failed upload stays on
 * screen: the chip is the only place that disclosure appears, and the user
 * still has its remove button to dismiss it.
 *
 * Exported so the test exercises this exact predicate rather than a restatement
 * of it that could drift.
 */
export function nexusAttachmentsNeedAttention(
	attachments: ReadonlyArray<Pick<NexusAttachment, "status" | "extraction">>,
): boolean {
	const stillWorking = attachments.some(
		(attachment) =>
			attachment.status !== "ready" && attachment.status !== "error",
	);
	if (stillWorking) {
		return true;
	}
	return attachments.some(
		(attachment) =>
			attachment.status === "error" ||
			(attachment.extraction !== undefined &&
				attachment.extraction.status !== "extracted" &&
				attachment.extraction.status !== "skipped"),
	);
}

interface SendPayload {
	message: string;
	files?: File[];
	/**
	 * Reports what happened to `files[index]` back to the composer that sent
	 * them, so its chips can show upload progress and what was actually read.
	 *
	 * Rides on the payload rather than arriving as a prop because `ComposeInput`
	 * is rendered two levels below the handler that does the uploading, and the
	 * payload is the one channel that already connects them. Lifting the
	 * attachment records instead would mean drilling them through both
	 * intermediate views.
	 *
	 * Nexus uploads at send time, unlike the Feature Assistant which uploads
	 * before it. So without this the chips are gone before the first byte
	 * moves, and everything the server reports — a truncated read, a workbook
	 * with no readable text, a refused container — has nothing to land on.
	 */
	onAttachmentOutcome?: (
		index: number,
		patch: {
			status: "uploading" | "processing" | "ready" | "error";
			error?: string;
			extraction?: AiChatExtractionOutcome;
		},
	) => void;
}

interface WorkflowIntegrationRecord {
	id: string;
	provider: string;
	name?: string | null;
	isActive: boolean;
	hasCredentials: boolean;
}

const ORCHESTRATOR_SYSTEM_AGENT_IDS = [
	"project_document_generator",
	"document_generator",
	"task_planner",
	"story_breakdown",
	"code_executor",
	"prompt_enhancer",
	"api_agent",
	"data_analyst",
	"cuga_generalist",
	"mcp_tool_executor",
];

function buildCapabilityExecutionOptions(params: {
	selectedCapabilities: CapabilityItem[];
	selectedAgents: SelectedAgent[];
	integrations: WorkflowIntegrationRecord[];
}): MultiAgentExecutionOptions | undefined {
	const { selectedCapabilities, selectedAgents, integrations } = params;
	if (selectedCapabilities.length === 0) {
		return undefined;
	}

	const capabilityIds = new Set(selectedCapabilities.map((cap) => cap.id));
	const enabledFabricToolIds = new Set<string>();
	const prioritizedToolIds = new Set<string>();
	const prioritizedAgentIds = new Set<string>();
	const enabledAgentIds = new Set<string>();
	const enabledIntegrationIds = new Set<string>();
	let executionMode: MultiAgentExecutionOptions["executionMode"] = "balanced";

	const activeProviderIds = (providers: string[]) =>
		integrations
			.filter(
				(integration) =>
					integration.isActive &&
					integration.hasCredentials &&
					providers.includes(integration.provider),
			)
			.map((integration) => integration.id);

	if (capabilityIds.has("create-files")) {
		enabledFabricToolIds.add("fabric_create_file");
	}
	if (capabilityIds.has("create-frames")) {
		enabledFabricToolIds.add("fabric_create_frame");
	}
	if (capabilityIds.has("create-images")) {
		enabledFabricToolIds.add("fabric_generate_image");
	}
	if (capabilityIds.has("discover-knowledge")) {
		enabledFabricToolIds.add("workspace_rag_query");
		enabledFabricToolIds.add("workspace_rag_summarize");
		prioritizedToolIds.add("workspace_rag_query");
		prioritizedToolIds.add("workspace_rag_summarize");
	}
	if (capabilityIds.has("discover-tools")) {
		enabledFabricToolIds.add("fabric_mcp_list");
		enabledFabricToolIds.add("fabric_mcp_schema");
		enabledFabricToolIds.add("fabric_mcp_grep");
		enabledFabricToolIds.add("fabric_mcp_call");
		prioritizedToolIds.add("fabric_mcp_list");
		prioritizedToolIds.add("fabric_mcp_call");
	}
	if (capabilityIds.has("speech-generator")) {
		enabledFabricToolIds.add("fabric_text_to_speech");
	}
	if (capabilityIds.has("web-search-browse")) {
		enabledFabricToolIds.add("fabric_web_search");
		enabledFabricToolIds.add("fabric_scrape_url");
		enabledFabricToolIds.add("fabric_search_and_analyze");
		enabledFabricToolIds.add("fabric_scrape_and_analyze");
		prioritizedToolIds.add("fabric_web_search");
		prioritizedToolIds.add("fabric_scrape_url");
	}
	if (capabilityIds.has("go-deep")) {
		executionMode = "deep";
		enabledFabricToolIds.add("fabric_web_search");
		enabledFabricToolIds.add("fabric_scrape_url");
		enabledFabricToolIds.add("workspace_rag_query");
		enabledFabricToolIds.add("workspace_rag_summarize");
		prioritizedToolIds.add("fabric_web_search");
		prioritizedToolIds.add("workspace_rag_query");
		for (const agentId of [
			"task_planner",
			"data_analyst",
			"document_generator",
			"code_executor",
		]) {
			prioritizedAgentIds.add(agentId);
		}
	}
	if (capabilityIds.has("run-agent")) {
		for (const agentId of ORCHESTRATOR_SYSTEM_AGENT_IDS) {
			enabledAgentIds.add(agentId);
		}
		for (const agentId of [
			"task_planner",
			"data_analyst",
			"document_generator",
			"code_executor",
		]) {
			prioritizedAgentIds.add(agentId);
		}
		for (const selectedAgent of selectedAgents) {
			if (!selectedAgent.agentId.startsWith("model:")) {
				enabledAgentIds.add(selectedAgent.agentId);
			}
		}
	}
	if (capabilityIds.has("mention-users")) {
		for (const integrationId of activeProviderIds([
			"SLACK",
			"MICROSOFT_GRAPH",
		])) {
			enabledIntegrationIds.add(integrationId);
		}
	}

	return {
		executionMode,
		enabledAgentIds:
			enabledAgentIds.size > 0 ? Array.from(enabledAgentIds) : null,
		enabledFabricToolIds:
			enabledFabricToolIds.size > 0
				? Array.from(enabledFabricToolIds)
				: null,
		enabledIntegrationIds:
			enabledIntegrationIds.size > 0
				? Array.from(enabledIntegrationIds)
				: null,
		prioritizedToolIds: Array.from(prioritizedToolIds),
		prioritizedAgentIds: Array.from(prioritizedAgentIds),
	};
}

interface HistoryChat {
	id: string;
	title?: string | null;
	messages: HistoryChatMessage[];
	createdAt: Date | string;
	updatedAt: Date | string;
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

function doesHistoryMessageBelongToAgent(
	message: HistoryChatMessage,
	agent: SelectedAgent,
): boolean {
	if (message.role !== "assistant" || typeof message.content !== "string") {
		return false;
	}

	const parsed = getHistoryAssistantIdentity(message);
	if (parsed.agentId === agent.agentId) {
		return true;
	}

	return parsed.agentName === agent.name;
}

function buildAgentScopedHistory(params: {
	agent: SelectedAgent;
	priorMessages: HistoryChatMessage[];
	activeTurns: ConversationTurn[];
}): Array<{ role: "user" | "assistant"; content: string }> {
	const { agent, priorMessages, activeTurns } = params;
	const history: Array<{ role: "user" | "assistant"; content: string }> = [];

	for (const message of priorMessages) {
		if (message.role === "user" && message.content?.trim()) {
			history.push({ role: "user", content: message.content });
			continue;
		}

		if (
			doesHistoryMessageBelongToAgent(message, agent) &&
			message.content?.trim()
		) {
			history.push({
				role: "assistant",
				content: parseHistoryAssistantMessage(message.content).content,
			});
		}
	}

	for (const turn of activeTurns) {
		history.push({ role: "user", content: turn.userMessage });
		const agentResponse = turn.agentResponses.get(agent.agentId);
		if (agentResponse?.content?.trim()) {
			history.push({
				role: "assistant",
				content: agentResponse.content,
			});
		}
	}

	return history;
}

/**
 * Reconstruct selected agents from message history, enriched with full config
 * (instructions, MCP servers, workspace IDs) via the instance config map.
 */
function deriveSelectedAgentsFromHistory(
	messages: HistoryChatMessage[],
	instanceConfigMap?: Map<
		string,
		{
			instructions: string | null;
			enabledMcpConfigIds: string[];
			workspaceIds: string[];
			instanceId?: string;
			enabledIntegrationIds?: string[];
		}
	>,
): SelectedAgent[] {
	const agents = new Map<string, SelectedAgent>();

	for (const message of messages) {
		if (
			message.role !== "assistant" ||
			typeof message.content !== "string" ||
			message.content.trim().length === 0
		) {
			continue;
		}

		const parsed = getHistoryAssistantIdentity(message);
		if (
			parsed.agentName === DEFAULT_AI_AGENT_NAME ||
			parsed.agentName === LEGACY_DEFAULT_AI_AGENT_NAME
		) {
			continue;
		}

		const { agentId, agentName: name, vendor } = parsed;
		let agent: SelectedAgent = { agentId, name, vendor };

		if (agentId.startsWith("model:")) {
			// Reconstruct model agents: modelOverride from agentId. Leave
			// `enabledMcpConfigIds` undefined so it falls through to the
			// chat-level scope in `useMultiAgentStream` — model-as-agent
			// is "no inherent scope", not "user explicitly disabled all".
			// The user's tenant-level MCP connections (Excalidraw, GitHub,
			// Notion, etc.) become available via search_tools as a result.
			agent = {
				...agent,
				modelOverride: agentId.replace("model:", ""),
			};
		} else if (agentId.startsWith("template-instance:")) {
			// Enrich with full config from the registry
			const config = instanceConfigMap?.get(agentId);
			agent = {
				...agent,
				instructions: config?.instructions ?? null,
				enabledMcpConfigIds: config?.enabledMcpConfigIds ?? [], // default: no servers (not all)
				workspaceIds: config?.workspaceIds ?? [],
				instanceId: config?.instanceId,
				enabledIntegrationIds: config?.enabledIntegrationIds,
			};
		}

		agents.set(agentId, agent);
	}

	return Array.from(agents.values());
}

/**
 * Resumable-execution predicate (AC-8 / decision 14).
 *
 * Filters by `status === "streaming"`, which is the only in-flight
 * value the multi-agent hook ever sets while a turn is active.
 *
 * After Group 2 widened `AgentResponse.status` to include `"cancelled"`,
 * this predicate continues to skip cancelled agents implicitly — the
 * `===` check excludes every other variant. A cancelled turn therefore
 * never auto-resumes on next page reload, which is the contract from
 * decision 14: an explicit user-initiated stop marks the turn as
 * non-resumable. Do NOT loosen this predicate to include `"cancelled"`.
 */
function extractResumableExecutions(turns: ConversationTurn[]): Array<{
	turnId: string;
	agentId: string;
	agentName: string;
	vendor?: string;
	executionId: string;
}> {
	const resumptions: Array<{
		turnId: string;
		agentId: string;
		agentName: string;
		vendor?: string;
		executionId: string;
	}> = [];

	for (const turn of turns) {
		for (const response of turn.agentResponses.values()) {
			if (
				response.isLoading &&
				response.executionId &&
				response.status === "streaming"
			) {
				resumptions.push({
					turnId: turn.id,
					agentId: response.agentId,
					agentName: response.agentName,
					vendor: response.vendor,
					executionId: response.executionId,
				});
			}
		}
	}

	return resumptions;
}

function SelectedAgentsInline({
	selectedAgents,
}: {
	selectedAgents: SelectedAgent[];
}) {
	return (
		<div className="flex min-w-0 items-center gap-2">
			<div className="flex items-center gap-1.5">
				{selectedAgents
					.slice(0, 3)
					.map((agent) =>
						agent.agentId.startsWith("model:") && agent.vendor ? (
							<VendorLogo
								key={agent.agentId}
								vendor={agent.vendor}
								size={28}
							/>
						) : (
							<AgentAvatar
								key={agent.agentId}
								name={agent.name}
								size="sm"
							/>
						),
					)}
			</div>
			<span className="truncate text-sm font-medium text-foreground">
				{selectedAgents.map((a) => a.name).join(", ")}
			</span>
		</div>
	);
}

// ── AgentDetailSheet ───────────────────────────────────────────────────────────

interface DetailAgent {
	agentId: string;
	name: string;
	description?: string | null;
	vendor?: string;
	modelOverride?: string;
	framework?: string;
	scope?: string;
	config?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	contextWindow?: number;
	speedTier?: string;
	qualityTier?: string;
}

function AgentDetailSheet({
	isOpen,
	onClose,
	agent,
	basePath,
}: {
	isOpen: boolean;
	onClose: () => void;
	agent: DetailAgent | null;
	basePath: string;
}) {
	if (!agent) {
		return null;
	}

	const isModelAgent = agent.agentId.startsWith("model:");
	const isSystemAgent = agent.scope === "SYSTEM";
	const heroEmoji = (agent.metadata as any)?.heroEmojis?.[0] as
		| string
		| undefined;
	const systemPrompt =
		(agent.config as any)?.systemPrompt ??
		(agent.config as any)?.instructions ??
		null;

	return (
		<Sheet open={isOpen} onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				side="right"
				className="w-[380px] sm:w-[420px] flex flex-col gap-0 p-0"
			>
				<SheetHeader className="px-5 py-4 border-b border-border/60">
					<div className="flex items-start gap-4">
						{/* Avatar */}
						{isModelAgent && agent.vendor ? (
							<VendorLogo vendor={agent.vendor} size={52} />
						) : heroEmoji ? (
							<div className="size-[52px] flex items-center justify-center text-3xl shrink-0 rounded-xl bg-muted border border-border/60">
								{heroEmoji}
							</div>
						) : (
							<AgentAvatar name={agent.name} size="lg" />
						)}
						<div className="flex-1 min-w-0 pt-0.5">
							<SheetTitle className="text-xl font-semibold text-foreground leading-tight">
								{agent.name}
							</SheetTitle>
							<div className="mt-1.5">
								{isModelAgent ? (
									<span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
										Model
									</span>
								) : isSystemAgent ? (
									<span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
										System Agent
									</span>
								) : (
									<span className="inline-flex items-center rounded-full bg-secondary/10 px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
										Custom Agent
									</span>
								)}
							</div>
						</div>
					</div>
				</SheetHeader>

				<div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
					{/* Description */}
					{agent.description && (
						<p className="text-sm text-muted-foreground leading-relaxed">
							{agent.description}
						</p>
					)}

					{/* Model stats */}
					{isModelAgent &&
						(agent.contextWindow ||
							agent.speedTier ||
							agent.qualityTier) && (
							<div className="flex flex-wrap gap-2">
								{agent.contextWindow && (
									<span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
										<span className="font-medium text-foreground">
											{agent.contextWindow >= 1000
												? `${Math.round(agent.contextWindow / 1000)}k`
												: agent.contextWindow}
										</span>
										ctx
									</span>
								)}
								{agent.speedTier && (
									<span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
										<span className="font-medium text-foreground capitalize">
											{agent.speedTier.toLowerCase()}
										</span>
										speed
									</span>
								)}
								{agent.qualityTier && (
									<span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
										<span className="font-medium text-foreground capitalize">
											{agent.qualityTier.toLowerCase()}
										</span>
										quality
									</span>
								)}
							</div>
						)}

					{/* System prompt / instructions */}
					{!isModelAgent && systemPrompt && (
						<div>
							<p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
								Instructions
							</p>
							<div className="rounded-lg border border-border/60 bg-muted/30 p-3 max-h-48 overflow-y-auto">
								<p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
									{systemPrompt}
								</p>
							</div>
							<a
								href={`${basePath}/agent-templates`}
								className="mt-1.5 inline-block text-[11px] text-primary hover:underline"
							>
								Edit in settings
							</a>
						</div>
					)}

					{/* Framework / scope for registered agents */}
					{!isModelAgent && agent.framework && (
						<div>
							<p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
								Framework
							</p>
							<p className="text-sm text-foreground">
								{agent.framework}
							</p>
						</div>
					)}
				</div>

				{/* Footer actions */}
				<div className="shrink-0 border-t border-border/60 px-5 py-3 flex items-center gap-2">
					{isModelAgent ? (
						<a
							href={`${basePath}/settings/ai-providers`}
							className="inline-flex items-center justify-center rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
						>
							Configure provider
						</a>
					) : (
						<a
							href={`${basePath}/agent-templates`}
							className="inline-flex items-center justify-center rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
						>
							Edit agent
						</a>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

// ── AgentBrowserSection ────────────────────────────────────────────────────────

type AgentTab = "all" | "system" | "custom" | "models";

function AgentBrowserSection({
	organizationId,
	selectedAgentIds,
	onToggleAgent,
	selectedConversationMcpIds,
	onOpenConversationToolPicker,
}: {
	organizationId?: string | null;
	selectedAgentIds: string[];
	onToggleAgent: (agent: SelectedAgent) => void;
	selectedConversationMcpIds?: string[] | null;
	onOpenConversationToolPicker?: () => void;
}) {
	const [activeTab, setActiveTab] = useState<AgentTab>("all");
	const [search, setSearch] = useState("");
	const [detailAgent, setDetailAgent] = useState<DetailAgent | null>(null);
	const [insightAgent, setInsightAgent] = useState<{
		id: string;
		displayName: string;
		description?: string | null;
		scope?: string;
		status?: string;
	} | null>(null);
	const basePath = useBasePath();

	const { data } = useQuery({
		queryKey: ["agents-registry", organizationId, "browse"],
		queryFn: () =>
			orpcClient.agents.registry.list({
				limit: 100,
				organizationId: organizationId ?? null,
			}),
		refetchOnWindowFocus: false,
	});

	// Managed-default MCP configs ride along with every chat regardless of
	// the per-conversation selection — count them into the "Chat tools" badge
	// so the displayed number reflects what's actually active for this turn.
	const { data: mcpConfigs } = useQuery({
		queryKey: ["mcp-configs", organizationId ?? null],
		queryFn: () =>
			organizationId
				? orpcClient.mcp.configs.list({ organizationId })
				: orpcClient.mcp.configs.list(),
		refetchOnWindowFocus: false,
	});
	const managedDefaultMcpConfigCount = (mcpConfigs ?? []).filter(
		(c: any) => !!c?.isManagedDefault,
	).length;

	const { data: instancesData } = useQuery({
		queryKey: ["agent-template-instances", organizationId, "browse"],
		queryFn: () =>
			orpcClient.agentTemplates.instances.list({
				organizationId: organizationId ?? null,
				status: "ACTIVE",
				latestVersionOnly: true,
				limit: 100,
				offset: 0,
			}),
		refetchOnWindowFocus: false,
	});

	const { data: modelsData } = useQuery({
		queryKey: ["ai-models-available", organizationId],
		queryFn: () =>
			orpcClient.aiConfig.models.listAvailable({
				organizationId: organizationId ?? null,
				taskType: "CHAT",
			}),
		enabled: activeTab === "models" || activeTab === "all",
		refetchOnWindowFocus: false,
	});

	const registryAgents: BrowserAgent[] = (data?.agents ?? []).map(
		(agent) => ({
			id: agent.id,
			agentId: agent.agentId,
			displayName: agent.displayName,
			description: agent.description,
			scope: agent.scope,
			framework: agent.framework,
			config: (agent.config as Record<string, unknown> | null) ?? null,
			metadata:
				(agent.metadata as Record<string, unknown> | null) ?? null,
			isTemplateInstance: false,
		}),
	);
	const instanceAgents: BrowserAgent[] = (instancesData?.instances ?? []).map(
		(instance: any) => {
			const config = buildInstanceAgentConfig(instance);
			return {
				id: instance.id,
				agentId: `template-instance:${instance.id}`,
				displayName: instance.name,
				description: instance.description,
				scope: instance.organizationId ? "ORGANIZATION" : "USER",
				framework: instance.template?.displayName ?? "Custom Agent",
				config: instance.customInstructions as Record<
					string,
					unknown
				> | null,
				metadata: {
					heroEmojis: instance.heroEmojis ?? [],
					templateDisplayName: instance.template?.displayName ?? null,
				},
				isTemplateInstance: true,
				instructions: config.instructions,
				enabledMcpConfigIds: config.enabledMcpConfigIds,
				workspaceIds: config.workspaceIds,
				instanceId: config.instanceId ?? instance.id,
				enabledIntegrationProviders: config.enabledIntegrationProviders,
			};
		},
	);
	const agents = [...registryAgents, ...instanceAgents];
	const availableModels = modelsData?.models ?? [];
	const agentManagementView = computeAgentManagementView(
		agents.map((agent) => ({
			id: agent.id ?? agent.agentId,
			displayName: agent.displayName,
			description: agent.description,
			framework: agent.framework,
			scope: agent.scope,
			status: "ACTIVE",
			conversationCount:
				(agent as BrowserAgent & { conversationCount?: number })
					.conversationCount ?? 0,
		})),
		search,
		activeTab === "system" ? "system" : "all",
	);

	// Build model "agents" — each model is selectable like an agent
	const modelAgents: (SelectedAgent & {
		contextWindow: number;
		speedTier: string;
		qualityTier?: string;
	})[] = availableModels
		.filter((m) => {
			if (!search) {
				return true;
			}
			const q = search.toLowerCase();
			return (
				m.displayName.toLowerCase().includes(q) ||
				m.vendor.toLowerCase().includes(q) ||
				(m.description ?? "").toLowerCase().includes(q)
			);
		})
		.map((m) => ({
			agentId: `model:${m.canonicalName}`,
			name: m.displayName,
			description:
				m.description ??
				`${m.vendor} · ${m.speedTier} · ${m.contextWindow.toLocaleString()} ctx`,
			modelOverride: m.canonicalName,
			vendor: m.vendor,
			contextWindow: m.contextWindow,
			speedTier: m.speedTier,
			qualityTier: (m as any).qualityTier,
			// Leave `enabledMcpConfigIds` undefined so the agent inherits
			// the chat-level scope (the "Chat tools" picker) and otherwise
			// defaults to the tenant's connected MCPs. To run a raw
			// model with no tools, the user can use the "Disable MCP"
			// option in Chat tools, which sets `[]` explicitly.
		}));

	const filteredAgents = agents.filter((agent) => {
		if (activeTab === "models") {
			return false;
		}

		if (activeTab === "system") {
			return agent.scope === "SYSTEM";
		}

		if (activeTab === "custom") {
			if (agent.scope === "SYSTEM") {
				return false;
			}
			if (!search) {
				return true;
			}
			return agentManagementView.items.some(
				(item) => item.id === (agent.id ?? agent.agentId),
			);
		}

		if (!search) {
			return true;
		}

		return agentManagementView.items.some(
			(item) => item.id === (agent.id ?? agent.agentId),
		);
	});

	// Items to display in grid based on active tab
	const showModels = activeTab === "models";
	const showAgents = activeTab !== "models";

	const tabs: Array<{ id: AgentTab; label: string }> = [
		{ id: "all", label: "All agents" },
		{ id: "system", label: "System" },
		{ id: "custom", label: "Custom" },
		{ id: "models", label: "Models" },
	];

	return (
		<div className="w-full">
			{/* Section heading */}
			<div className="flex items-center justify-between mb-4">
				<h2
					className="text-xl text-foreground/85"
					style={{ fontFamily: "var(--font-sans)", fontWeight: 400 }}
				>
					Work with...
				</h2>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onOpenConversationToolPicker}
						className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-background px-3.5 py-2 text-sm font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground"
					>
						<McpLogo size={16} />
						Chat tools
						{selectedConversationMcpIds != null && (
							<span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] leading-none text-foreground">
								{selectedConversationMcpIds.length +
									managedDefaultMcpConfigCount}
							</span>
						)}
					</button>
					{/* Create dropdown */}
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								className="inline-flex items-center gap-2 rounded-xl bg-primary text-primary-foreground px-3.5 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
							>
								<PlusIcon className="size-4" />
								Create
								<ChevronDownIcon className="size-3.5 opacity-70" />
							</button>
						</PopoverTrigger>
						<PopoverContent
							align="end"
							sideOffset={6}
							className="w-56 p-2 shadow-lg"
						>
							<p className="px-3 pt-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/50">
								Agents
							</p>
							<a
								href={`${basePath}/agent-templates/new`}
								className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted transition-colors group"
							>
								<div className="flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted text-muted-foreground shrink-0">
									<RobotIcon className="size-4.5" />
								</div>
								agent from scratch
							</a>
							<a
								href={`${basePath}/agent-templates`}
								className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted transition-colors group"
							>
								<div className="flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted text-muted-foreground shrink-0">
									<LayoutTemplateIcon className="size-4.5" />
								</div>
								agent from template
							</a>
							<div className="my-1.5 h-px bg-border/60" />
							<p className="px-3 pt-0.5 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/50">
								Skills
							</p>
							<a
								href={`${basePath}/mcp-servers`}
								className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted transition-colors"
							>
								<div className="flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted text-muted-foreground shrink-0">
									<McpLogo size={18} />
								</div>
								skill
							</a>
						</PopoverContent>
					</Popover>

					{/* Manage dropdown */}
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-muted text-foreground/85 px-3.5 py-2 text-sm font-medium hover:bg-accent hover:text-foreground transition-colors"
							>
								<RobotIcon className="size-4" />
								Manage
								<ChevronDownIcon className="size-3.5 opacity-70" />
							</button>
						</PopoverTrigger>
						<PopoverContent
							align="end"
							sideOffset={6}
							className="w-48 p-2 shadow-lg"
						>
							<a
								href={`${basePath}/agents`}
								className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted transition-colors"
							>
								<div className="flex size-7 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-foreground shrink-0">
									<RobotIcon className="size-4" />
								</div>
								agents
							</a>
							<a
								href={`${basePath}/mcp-servers`}
								className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted transition-colors"
							>
								<div className="flex size-7 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-foreground shrink-0">
									<McpLogo size={16} />
								</div>
								skills
							</a>
						</PopoverContent>
					</Popover>
				</div>
			</div>

			{/* Search */}
			<div className="relative mb-3">
				<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50 pointer-events-none" />
				<SearchInput
					placeholder={
						showModels ? "Search models..." : "Search agents..."
					}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="pl-9 h-9 bg-muted/40 border-border text-sm"
				/>
			</div>

			{/* Tabs */}
			<div className="flex items-center gap-1 mb-4 border-b border-border">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						onClick={() => setActiveTab(tab.id)}
						className={cn(
							"px-3 py-1.5 text-sm -mb-px transition-colors",
							activeTab === tab.id
								? "text-foreground border-b-2 border-foreground font-medium"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Grid */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{/* Model cards */}
				{(showModels || activeTab === "all") &&
					modelAgents.map((modelAgent) => {
						const isSelected = selectedAgentIds.includes(
							modelAgent.agentId,
						);
						return (
							<div
								key={modelAgent.agentId}
								className="relative group/card"
							>
								<button
									type="button"
									onClick={() => onToggleAgent(modelAgent)}
									className={cn(
										"flex items-start gap-3 rounded-xl border p-3 text-left transition-colors w-full pr-8",
										isSelected
											? "border-primary/40 bg-primary/5"
											: "border-border bg-card hover:bg-muted/40 hover:border-border/80",
									)}
								>
									{modelAgent.vendor ? (
										<VendorLogo
											vendor={modelAgent.vendor}
											size={32}
										/>
									) : (
										<AgentAvatar name={modelAgent.name} />
									)}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-1.5">
											<p className="text-sm font-semibold truncate text-foreground/85">
												{modelAgent.name}
											</p>
											{isSelected && (
												<CheckCircle2Icon className="size-3.5 text-primary shrink-0" />
											)}
										</div>
										<p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
											{modelAgent.description}
										</p>
									</div>
								</button>
								{/* Three-dot detail button */}
								<button
									type="button"
									aria-label={`Details for ${modelAgent.name}`}
									onClick={(e) => {
										e.stopPropagation();
										setDetailAgent({
											agentId: modelAgent.agentId,
											name: modelAgent.name,
											description: modelAgent.description,
											vendor: modelAgent.vendor,
											modelOverride:
												modelAgent.modelOverride,
											contextWindow:
												modelAgent.contextWindow,
											speedTier: modelAgent.speedTier,
											qualityTier: modelAgent.qualityTier,
										});
									}}
									className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md text-muted-foreground/40 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/card:opacity-100"
								>
									<MoreHorizontalIcon className="size-3.5" />
								</button>
							</div>
						);
					})}

				{/* Agent cards */}
				{showAgents &&
					filteredAgents.map((agent) => {
						const isSelected = selectedAgentIds.includes(
							agent.agentId,
						);
						const heroEmoji = (agent.metadata as any)
							?.heroEmojis?.[0] as string | undefined;
						return (
							<div
								key={agent.agentId}
								className="relative group/card"
							>
								<button
									type="button"
									onClick={() =>
										onToggleAgent({
											agentId: agent.agentId,
											name: agent.displayName,
											description: agent.description,
											instructions: agent.instructions,
											enabledMcpConfigIds:
												agent.enabledMcpConfigIds,
											workspaceIds: agent.workspaceIds,
											instanceId: agent.instanceId,
											enabledIntegrationProviders:
												agent.enabledIntegrationProviders,
										})
									}
									className={cn(
										"flex items-start gap-3 rounded-xl border p-3 text-left transition-colors w-full pr-8",
										isSelected
											? "border-primary/40 bg-primary/5"
											: "border-border bg-card hover:bg-muted/40 hover:border-border/80",
									)}
								>
									{heroEmoji ? (
										<div className="size-8 flex items-center justify-center text-lg shrink-0 rounded-xl bg-muted border border-border/60">
											{heroEmoji}
										</div>
									) : (
										<AgentAvatar name={agent.displayName} />
									)}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-1.5">
											<p className="text-sm font-semibold truncate text-foreground/85">
												{agent.displayName}
											</p>
											{isSelected && (
												<CheckCircle2Icon className="size-3.5 text-primary shrink-0" />
											)}
										</div>
										<p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
											{agent.description ??
												agent.framework}
										</p>
									</div>
								</button>
								{/* Three-dot detail button */}
								<button
									type="button"
									aria-label={`Details for ${agent.displayName}`}
									onClick={(e) => {
										e.stopPropagation();
										setDetailAgent({
											agentId: agent.agentId,
											name: agent.displayName,
											description: agent.description,
											framework:
												agent.framework ?? undefined,
											scope: agent.scope ?? undefined,
											config:
												(agent.config as Record<
													string,
													unknown
												>) ?? undefined,
											metadata:
												(agent.metadata as Record<
													string,
													unknown
												>) ?? undefined,
										});
									}}
									className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md text-muted-foreground/40 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/card:opacity-100"
								>
									<MoreHorizontalIcon className="size-3.5" />
								</button>
								{!agent.isTemplateInstance && agent.id && (
									<button
										type="button"
										aria-label={`Insights for ${agent.displayName}`}
										onClick={(e) => {
											e.stopPropagation();
											if (!agent.id) {
												return;
											}
											setInsightAgent({
												id: agent.id,
												displayName: agent.displayName,
												description: agent.description,
												scope: agent.scope,
												status: "ACTIVE",
											});
										}}
										className="absolute bottom-2 right-2 rounded-md border border-border/70 bg-background/90 px-2 py-1 text-[11px] font-medium text-muted-foreground opacity-0 transition-all hover:text-foreground group-hover/card:opacity-100"
									>
										Insights
									</button>
								)}
							</div>
						);
					})}

				{/* Empty state */}
				{((showModels && modelAgents.length === 0) ||
					(showAgents &&
						filteredAgents.length === 0 &&
						(!showModels || activeTab !== "all"))) && (
					<div className="col-span-3 py-8 text-center text-sm text-muted-foreground">
						{showModels
							? "No models configured. Add an AI provider in Settings."
							: "No agents match your search."}
					</div>
				)}
			</div>

			{/* Agent detail sheet */}
			<AgentDetailSheet
				isOpen={detailAgent !== null}
				onClose={() => setDetailAgent(null)}
				agent={detailAgent}
				basePath={basePath}
			/>
			{insightAgent && (
				<AgentInsightsSheet
					open={insightAgent !== null}
					onOpenChange={(open) => {
						if (!open) {
							setInsightAgent(null);
						}
					}}
					agent={insightAgent}
					organizationId={organizationId}
				/>
			)}
		</div>
	);
}

// ── ComposeInput ───────────────────────────────────────────────────────────────

// Exported for tests (ComposeInput.default-agent-send.test.tsx).
export function ComposeInput({
	value,
	onChange,
	onSend,
	onStop,
	isLoading,
	selectedAgents,
	onRemoveAgent,
	onOpenAgentPicker: _onOpenAgentPicker,
	organizationId,
	placeholder,
	autoFocus,
	onToggleAgent,
	selectedCapabilities,
	onToggleCapability,
	onRemoveCapability,
}: {
	value: string;
	onChange: (v: string) => void;
	onSend: (payload: SendPayload) => void;
	/**
	 * Invoked when the user clicks the morphed Stop button while any
	 * agent in the current turn is in-flight. Wired by the
	 * `ConversationView` to `useMultiAgentStream().stopAll("button")`.
	 * When omitted, the Stop morph is not rendered and the legacy
	 * spinner-only treatment applies.
	 */
	onStop?: () => void;
	isLoading: boolean;
	selectedAgents: SelectedAgent[];
	onRemoveAgent: (agentId: string) => void;
	onOpenAgentPicker: () => void;
	organizationId?: string | null;
	placeholder?: string;
	autoFocus?: boolean;
	onToggleAgent?: (agent: SelectedAgent) => void;
	selectedCapabilities?: CapabilityItem[];
	onToggleCapability?: (cap: CapabilityItem) => void;
	onRemoveCapability?: (capId: string) => void;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const basePath = useBasePath();
	const [capsPickerOpen, setCapsPickerOpen] = useState(false);
	const [capsSearch, setCapsSearch] = useState("");
	const [isRecording, setIsRecording] = useState(false);
	const [hasSpeechSupport, setHasSpeechSupport] = useState(false);
	const [recordingSeconds, setRecordingSeconds] = useState(0);
	// Records rather than a bare `File[]`: Nexus had no per-file state at all,
	// so a chip could say nothing beyond its own filename. The status union is
	// the house shape — the same one the upload hook and Loom Direct use — not
	// a third invention.
	const [pendingFiles, setPendingFiles] = useState<NexusAttachment[]>([]);
	const [fileUploadError, setFileUploadError] = useState<string | null>(null);
	const recognitionRef = useRef<any>(null);
	const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// `onresult` runs after the click handler has already returned, so
	// reading `value` from the closure would see the value at start
	// time, not the latest. The ref always holds the latest value.
	const valueRef = useRef(value);
	// Tracks how many auto-retries we've done in the current click
	// cycle. Reset on user click. Capped at MAX_RETRIES below to avoid
	// infinite loops on a permanently failing mic.
	const retryCountRef = useRef(0);
	// Set to true by stopRecognition / unmount cleanup so the onend
	// auto-restart path knows to bail.
	const stopRequestedRef = useRef(false);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [value]);

	useEffect(() => {
		setHasSpeechSupport(
			!!(
				(window as any).SpeechRecognition ||
				(window as any).webkitSpeechRecognition
			),
		);
	}, []);

	useEffect(() => {
		valueRef.current = value;
	}, [value]);

	useEffect(() => {
		return () => {
			if (tickIntervalRef.current) {
				clearInterval(tickIntervalRef.current);
				tickIntervalRef.current = null;
			}
			const recognition = recognitionRef.current;
			if (recognition) {
				recognition.onresult = null;
				recognition.onerror = null;
				recognition.onend = null;
				recognition.stop();
				recognitionRef.current = null;
			}
		};
	}, []);

	const handleSendNow = useCallback(() => {
		const trimmedMessage = value.trim();
		if (!trimmedMessage && pendingFiles.length === 0) {
			return;
		}

		const fallbackMessage =
			"Please review the attached document(s) and help me with them.";
		const queued = pendingFiles;

		onSend({
			message: trimmedMessage || fallbackMessage,
			files: queued.map((attachment) => attachment.file),
			onAttachmentOutcome: (index, patch) => {
				const target = queued[index];
				if (!target) {
					return;
				}
				setPendingFiles((prev) =>
					prev.map((attachment) =>
						attachment.id === target.id
							? { ...attachment, ...patch }
							: attachment,
					),
				);
			},
		});

		// Chips are NOT cleared here. Nexus uploads during send, so clearing now
		// would drop them before the first byte moves and leave every outcome
		// the server reports with nowhere to land. They clear themselves once
		// every file has settled with nothing worth saying — see the effect
		// below.
		//
		// Reset to `pending`, not `uploading`: the handler works through the
		// files one at a time and reports each transition itself, so marking
		// them all as uploading here would claim work had started on files
		// still waiting their turn. What this pass is for is clearing a prior
		// send's outcome off a re-sent chip.
		setPendingFiles((prev) =>
			prev.map((attachment) => ({
				...attachment,
				status: "pending" as const,
				error: undefined,
				extraction: undefined,
			})),
		);
		setFileUploadError(null);
	}, [value, pendingFiles, onSend]);

	// See `nexusAttachmentsNeedAttention` for why clearing happens here rather
	// than at send time.
	useEffect(() => {
		if (
			pendingFiles.length > 0 &&
			!nexusAttachmentsNeedAttention(pendingFiles)
		) {
			setPendingFiles([]);
		}
	}, [pendingFiles]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			// No agent-selection gate here: an empty selection falls back to
			// the built-in default assistant in the send handler.
			const isEnterSendDisabled =
				(value.trim().length === 0 && pendingFiles.length === 0) ||
				isLoading;
			if (!isEnterSendDisabled) {
				handleSendNow();
			}
		}
	};

	const stopRecordingTick = useCallback(() => {
		if (tickIntervalRef.current) {
			clearInterval(tickIntervalRef.current);
			tickIntervalRef.current = null;
		}
	}, []);

	// Voice dictation lifecycle — single-shot per click with auto-retry.
	// Why single-shot: Chromium's `continuous = true` mode often only
	// emits interim results that never finalize, so the transcript never
	// reaches the textarea (PR #828). Single-shot is reliable but ends
	// after the first natural pause.
	//
	// Why auto-retry on silent end: the most common failure is
	// `no-speech` — Chromium's online recognition service occasionally
	// fails to register audio, especially in the first ~200-500ms after
	// `start()` while it's spinning up. We auto-retry up to 2 times
	// before giving up so a transient miss doesn't require a manual
	// re-click.
	//
	// Why defensive abort + ref-clearing: Chromium retains an internal
	// handle to the previous recognizer after `onend` fires. Without
	// explicit abort, `recognition.start()` throws InvalidStateError on
	// subsequent clicks and the mic silently does nothing. Identity-
	// checking inside lifecycle handlers prevents callbacks from a prior
	// recognizer from clobbering a newer ref.
	const startRecognition = useCallback(() => {
		const SpeechRecognition =
			(window as any).SpeechRecognition ||
			(window as any).webkitSpeechRecognition;
		if (!SpeechRecognition) {
			return;
		}

		const previous = recognitionRef.current;
		if (previous) {
			try {
				previous.onresult = null;
				previous.onerror = null;
				previous.onend = null;
				previous.abort();
			} catch {}
			recognitionRef.current = null;
		}

		const recognition = new SpeechRecognition();
		recognition.continuous = false;
		recognition.interimResults = false;
		recognition.lang = "en-US";

		// Per-session flag: did onresult fire? If yes, this is a
		// successful capture — onend is normal end and we stop. If no,
		// onend is a silent failure and we auto-retry.
		let gotResultThisSession = false;

		recognition.onresult = (event: any) => {
			gotResultThisSession = true;
			const transcript = event.results[0][0].transcript as string;
			const current = valueRef.current;
			onChange(current + (current ? " " : "") + transcript);
			// Visual stop the moment we have the transcript — onend
			// will follow shortly and clear the tick.
			setIsRecording(false);
		};

		recognition.onerror = (event: any) => {
			const code = event?.error;

			// `no-speech` is the only error we want to swallow so
			// `onend` can decide whether to auto-retry. Everything else
			// is a terminal stop for this click cycle.
			if (code === "no-speech") {
				return;
			}

			if (code === "not-allowed" || code === "service-not-allowed") {
				toast.error(
					"Microphone access is blocked for this site. Enable it in your browser settings to use voice input.",
				);
			} else if (code === "audio-capture") {
				toast.error(
					"No microphone detected. Connect a microphone and try again.",
				);
			} else if (code === "network") {
				toast.error(
					"Voice recognition is unavailable right now. Please type your message instead.",
				);
			}
			// `aborted` and any unknown error: silent stop, no retry,
			// no toast — `aborted` is the manual-stop / unmount /
			// tab-hidden teardown signal and the user already knows
			// they triggered it.
			stopRequestedRef.current = true;
			setIsRecording(false);
		};

		recognition.onend = () => {
			if (recognitionRef.current === recognition) {
				recognitionRef.current = null;
			}

			if (stopRequestedRef.current) {
				setIsRecording(false);
				stopRecordingTick();
				retryCountRef.current = 0;
				return;
			}

			if (gotResultThisSession) {
				setIsRecording(false);
				stopRecordingTick();
				retryCountRef.current = 0;
				return;
			}

			const MAX_RETRIES = 2;
			if (retryCountRef.current < MAX_RETRIES) {
				retryCountRef.current += 1;
				queueMicrotask(() => {
					if (!stopRequestedRef.current) {
						startRecognition();
					}
				});
				return;
			}

			// Max retries hit with no result — typically the user clicked
			// the mic but never spoke. Stop silently rather than show a
			// "didn't catch that" toast that scolds users for not
			// dictating: silence is a valid outcome.
			retryCountRef.current = 0;
			setIsRecording(false);
			stopRecordingTick();
		};

		recognitionRef.current = recognition;
		try {
			recognition.start();
		} catch {
			recognitionRef.current = null;
			retryCountRef.current = 0;
			setIsRecording(false);
			stopRecordingTick();
			return;
		}

		setIsRecording(true);
		// Only reset the timer/seconds on the initial start, not on auto-
		// retry — the user's click cycle should feel continuous.
		if (tickIntervalRef.current === null) {
			setRecordingSeconds(0);
			tickIntervalRef.current = setInterval(() => {
				setRecordingSeconds((s) => s + 1);
			}, 1000);
		}
	}, [onChange, stopRecordingTick]);

	const stopRecognition = useCallback(() => {
		stopRequestedRef.current = true;
		retryCountRef.current = 0;
		const r = recognitionRef.current;
		if (r) {
			try {
				r.onresult = null;
				r.onerror = null;
				r.onend = null;
				r.abort();
			} catch {}
			recognitionRef.current = null;
		}
		setIsRecording(false);
		stopRecordingTick();
	}, [stopRecordingTick]);

	// Auto-stop recording the moment the AI starts responding — the
	// composer textarea is disabled while `isLoading`, so an active mic
	// would silently buffer audio that the user can no longer send.
	useEffect(() => {
		if (isLoading && isRecording) {
			stopRecognition();
		}
	}, [isLoading, isRecording, stopRecognition]);

	const handleMicClick = useCallback(() => {
		if (isRecording) {
			stopRecognition();
		} else {
			stopRequestedRef.current = false;
			retryCountRef.current = 0;
			startRecognition();
		}
	}, [isRecording, startRecognition, stopRecognition]);

	/**
	 * Shared helper used by both the paperclip file picker and the
	 * `useClipboardImagePaste` paste/drop pipeline (T-6.1). Queues files into
	 * `pendingFiles` so the existing `handleSend` three-step pipeline
	 * (`ai.documents.createUploadUrl` → `upload` → `process`) runs at send
	 * time — exactly the same path the paperclip already drives, no parallel
	 * upload implementation. Visual progress is the existing `pendingFiles`
	 * chips below the textarea.
	 */
	const enqueuePendingFiles = useCallback(
		async (files: readonly File[]): Promise<void> => {
			if (files.length === 0) {
				return;
			}

			// Nexus performed no client-side validation at all, so every rejection
			// arrived from the server after the upload had already been paid for —
			// and `fileUploadError` below had two writers that both cleared it,
			// making its own error banner unreachable. This is the minimum that
			// makes the control fire; U6 replaces the page-level banner with
			// per-file chip status.
			//
			// The server stays authoritative: this reads the same allowlist and cap
			// the server resolver defaults to, so the two cannot drift, and the
			// wider server-only set (TIFF) is admitted here because Nexus runs no
			// canvas compression step.
			const accepted: File[] = [];
			const rejected: string[] = [];
			for (const file of files) {
				if (file.size > DEFAULT_AI_CHAT_MAX_FILE_BYTES) {
					rejected.push(
						`"${file.name}" is larger than ${Math.round(DEFAULT_AI_CHAT_MAX_FILE_BYTES / (1024 * 1024))} MB.`,
					);
					continue;
				}
				// Extension is the fallback, not the check: paste and drop routinely
				// hand over files with an empty `type`.
				if (
					!DEFAULT_AI_CHAT_MIME_ALLOWLIST.includes(file.type) &&
					!AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test(file.name)
				) {
					rejected.push(`"${file.name}" is not a supported format.`);
					continue;
				}
				if (file.type.startsWith("image/")) {
					// Base64 adds a third on the wire; the raw cap above does not
					// see that, so an image can pass here and still be refused by
					// the provider much later.
					const shaped = await prepareImageForAi(file);
					if (!shaped.ok) {
						rejected.push(shaped.error);
						continue;
					}
					accepted.push(shaped.file);
					continue;
				}
				accepted.push(file);
			}

			if (accepted.length > 0) {
				setPendingFiles((prev) => [
					...prev,
					...accepted.map((file, offset) => ({
						id: `nexus-file-${prev.length + offset}-${file.name}-${file.size}`,
						file,
						status: "pending" as const,
					})),
				]);
			}
			setFileUploadError(rejected.length > 0 ? rejected.join(" ") : null);
		},
		[],
	);

	const handleFileInputChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(event.target.files ?? []);
			enqueuePendingFiles(files);
			event.target.value = "";
		},
		[enqueuePendingFiles],
	);

	/**
	 * Paste/drop uploader (T-6.1). Resolves immediately after queuing — the
	 * actual three-step `ai.documents.*` pipeline runs at send time inside the
	 * parent's `handleSend`, identical to the paperclip flow. The `signal`
	 * argument is unused here because the queuing step is synchronous; the
	 * hook still aborts on host unmount via its internal AbortController.
	 */
	const handlePasteUploader = useCallback(
		async (file: File, _signal: AbortSignal): Promise<void> => {
			enqueuePendingFiles([file]);
		},
		[enqueuePendingFiles],
	);

	/**
	 * Mixed-paste split: non-image files in a paste/drop are
	 * forwarded to the same queue used by the paperclip handler.
	 */
	const handleNonImagePastedFiles = useCallback(
		(files: File[]): void => {
			enqueuePendingFiles(files);
		},
		[enqueuePendingFiles],
	);

	const { handlePaste, handleDrop, handleDragOver } = useClipboardImagePaste({
		surface: "nexus",
		maxSizeBytes: NEXUS_PASTE_IMAGE_MAX_BYTES,
		allowedMimeTypes: NEXUS_PASTE_IMAGE_MIME_TYPES,
		maxFilesPerPaste: 5,
		uploader: handlePasteUploader,
		onNonImageFiles: handleNonImagePastedFiles,
	});

	// Sending with no agent selected is allowed: the send handler falls back
	// to the built-in default assistant (the placeholder's "just ask
	// anything" path), so the composer must not gate on the selection.
	const sendDisabled =
		(value.trim().length === 0 && pendingFiles.length === 0) || isLoading;

	return (
		<div
			className="rounded-2xl border-2 border-border/70 bg-card shadow-md overflow-hidden focus-within:ring-0 focus-within:border-primary/60 transition-colors"
			onDrop={handleDrop}
			onDragOver={handleDragOver}
		>
			{/* Selected agent chips */}
			{selectedAgents.length > 0 && (
				<div className="flex flex-wrap gap-1.5 px-4 pt-3 pb-0">
					{selectedAgents.map((agent) => (
						<span
							key={agent.agentId}
							className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary px-2.5 py-0.5 text-xs font-medium"
						>
							{agent.agentId.startsWith("model:") &&
							agent.vendor ? (
								<VendorLogo vendor={agent.vendor} size={14} />
							) : (
								<AgentAvatar name={agent.name} size="sm" />
							)}
							<span>@{agent.name}</span>
							<button
								type="button"
								onClick={() => onRemoveAgent(agent.agentId)}
								className="ml-0.5 hover:opacity-70 transition-opacity"
								aria-label={`Remove ${agent.name}`}
							>
								<XIcon className="size-3" />
							</button>
						</span>
					))}
				</div>
			)}

			{/* Textarea */}
			<div className="px-4 pt-3 pb-2">
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					placeholder={
						isRecording
							? "Listening…"
							: (placeholder ??
								(selectedAgents.length > 0
									? `Ask ${selectedAgents.map((a) => a.name).join(", ")}...`
									: "Ask an @agent a question, or just ask anything"))
					}
					rows={2}
					disabled={isLoading}
					className="w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none leading-relaxed disabled:opacity-50"
					style={{ scrollbarWidth: "none" }}
					// biome-ignore lint/a11y/noAutofocus: intentional focus for companion UX
					autoFocus={autoFocus}
				/>
			</div>

			{/* Selected capability chips */}
			{selectedCapabilities && selectedCapabilities.length > 0 && (
				<div className="flex flex-wrap gap-1.5 px-4 pb-2">
					{selectedCapabilities.map((cap) => (
						<span
							key={cap.id}
							className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-foreground"
						>
							<span
								className={cn(
									"flex size-4 items-center justify-center rounded",
									cap.iconBg,
								)}
							>
								<span className="[&>svg]:size-2.5">
									{cap.icon}
								</span>
							</span>
							<span>{cap.name}</span>
							<button
								type="button"
								onClick={() => onRemoveCapability?.(cap.id)}
								className="ml-0.5 hover:opacity-70 transition-opacity"
								aria-label={`Remove ${cap.name}`}
							>
								<XIcon className="size-3" />
							</button>
						</span>
					))}
				</div>
			)}

			{/*
			 * The shared chip row, not a local copy of it. The span this
			 * replaced rendered a filename and a remove button and nothing
			 * else — no status, no truncation notice, no sheet list — so
			 * everything the server reports about what it actually read had no
			 * way to reach the user on this surface.
			 */}
			<div className="px-2">
				<CopilotSidebarAttachments
					files={pendingFiles.map(toChipRecord)}
					onRemove={(fileId: string) =>
						setPendingFiles((prev) =>
							prev.filter(
								(attachment) => attachment.id !== fileId,
							),
						)
					}
				/>
			</div>

			{fileUploadError && (
				<p className="px-4 pb-2 text-xs text-destructive">
					{fileUploadError}
				</p>
			)}

			{/* Toolbar */}
			<div className="flex items-center justify-between px-3 pb-3 pt-0.5">
				{/* Left: action buttons */}
				<div className="flex items-center gap-1">
					{/* Paperclip / file attach */}
					<button
						type="button"
						aria-label="Attach file"
						onClick={() => fileInputRef.current?.click()}
						className="flex size-7 items-center justify-center rounded-lg transition-colors text-muted-foreground hover:text-foreground hover:bg-muted/60"
					>
						<PaperclipIcon className="size-3.5" />
					</button>
					{/*
					 * `sr-only`, not `hidden` (display:none). Chromium 124+
					 * blocks the file picker for programmatic clicks on
					 * `display:none` inputs.
					 */}
					<input
						ref={fileInputRef}
						type="file"
						onChange={handleFileInputChange}
						accept={NEXUS_FILE_ACCEPT}
						multiple
						className="sr-only"
						aria-hidden="true"
						tabIndex={-1}
					/>

					<AgentModelPicker
						selectedAgents={selectedAgents}
						onToggleAgent={onToggleAgent}
						organizationId={organizationId}
					/>

					{/* Capabilities popover */}
					<Popover
						open={capsPickerOpen}
						onOpenChange={(open) => {
							setCapsPickerOpen(open);
							if (!open) {
								setCapsSearch("");
							}
						}}
					>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label="Capabilities"
								className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
							>
								<LayoutGridIcon className="size-3.5" />
							</button>
						</PopoverTrigger>
						<PopoverContent
							align="start"
							sideOffset={8}
							className="w-80 p-0"
						>
							<div className="px-3 py-2 border-b border-border/60">
								<p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/70 mb-2">
									Capabilities
								</p>
								<div className="relative">
									<SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
									<input
										type="search"
										autoComplete="off"
										aria-label="Search capabilities"
										value={capsSearch}
										onChange={(e) =>
											setCapsSearch(e.target.value)
										}
										placeholder="Search capabilities..."
										className="w-full pl-6 pr-2 py-1 text-xs bg-muted/50 border border-border/60 rounded-md outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/50"
									/>
								</div>
							</div>
							<CapabilitiesList
								basePath={basePath}
								search={capsSearch}
								onClose={() => {
									setCapsPickerOpen(false);
									setCapsSearch("");
								}}
								onSelectCapability={(cap) => {
									onToggleCapability?.(cap);
									setCapsPickerOpen(false);
									setCapsSearch("");
								}}
								selectedCapabilityIds={selectedCapabilities?.map(
									(c) => c.id,
								)}
							/>
						</PopoverContent>
					</Popover>
				</div>

				{/* Right: mic + send buttons */}
				<div className="flex items-center gap-1.5">
					{/* Mic button */}
					{hasSpeechSupport && (
						<>
							{isRecording && (
								<span
									className="text-[11px] font-medium tabular-nums text-destructive"
									aria-live="polite"
								>
									{formatRecordingDuration(recordingSeconds)}
								</span>
							)}
							<div className="relative group/mic">
								<button
									type="button"
									aria-label="Voice input"
									aria-pressed={isRecording}
									onClick={handleMicClick}
									disabled={isLoading}
									className={cn(
										"flex size-7 items-center justify-center rounded-lg transition-colors",
										"disabled:opacity-50 disabled:cursor-not-allowed",
										isRecording
											? "text-destructive bg-destructive/10 motion-safe:animate-pulse"
											: "text-muted-foreground hover:text-foreground hover:bg-muted/60",
									)}
								>
									<MicIcon className="size-3.5" />
								</button>
								{/* Tooltip */}
								<div className="pointer-events-none absolute bottom-full right-0 mb-2 hidden group-hover/mic:block z-50">
									<div className="rounded-md bg-popover border border-border shadow-md px-2.5 py-1.5 text-[11px] text-foreground whitespace-nowrap">
										{isLoading
											? "Available after the AI replies"
											: isRecording
												? "Click to stop recording"
												: "Click to start recording"}
									</div>
								</div>
							</div>
						</>
					)}

					{/* Send → Stop morph.
					 *
					 * While any agent in the current turn is in-flight and
					 * the parent has wired `onStop`, the trailing button
					 * morphs into a neutral muted Stop control. Same
					 * dimensions (`size-8`) so the layout doesn't jump.
					 * No destructive red, no `transition-all`, no
					 * `hover:scale-*` (decision 8 + design context).
					 *
					 * Strings audited against
					 * fabric/standards/ai/ai-copy-tone.md — task 4.1. */}
					{onStop && isLoading ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={onStop}
									aria-label="Stop generating"
									className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
								>
									<StopCircleIcon className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="top">
								<p>Stop this response · Esc</p>
							</TooltipContent>
						</Tooltip>
					) : (
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<button
										type="button"
										onClick={handleSendNow}
										disabled={sendDisabled}
										className={cn(
											"flex size-8 items-center justify-center rounded-full transition-colors",
											sendDisabled
												? "bg-muted text-muted-foreground cursor-not-allowed"
												: "bg-primary text-primary-foreground hover:bg-primary/90",
										)}
										aria-label="Send"
									>
										{isLoading ? (
											<Loader2Icon className="size-3.5 motion-safe:animate-spin" />
										) : (
											<ArrowUpIcon className="size-3.5" />
										)}
									</button>
								</span>
							</TooltipTrigger>
						</Tooltip>
					)}
				</div>
			</div>
		</div>
	);
}

// ── CapabilitiesList ───────────────────────────────────────────────────────────

interface CapabilityItem {
	id: string;
	name: string;
	description: string;
	icon: React.ReactNode;
	iconBg: string;
	href?: string;
	isConfigureLink?: boolean;
}

function CapabilitiesList({
	basePath,
	search,
	onClose,
	onSelectCapability,
	selectedCapabilityIds,
}: {
	basePath: string;
	search: string;
	onClose: () => void;
	onSelectCapability?: (cap: CapabilityItem) => void;
	selectedCapabilityIds?: string[];
}) {
	const settingsPath = basePath.includes("/app/")
		? `${basePath.replace(/\/app\/.*/, "/app")}/settings/integrations`
		: "/app/settings/integrations";

	const builtInCapabilities: CapabilityItem[] = BUILT_IN_CAPABILITIES.map(
		(capability) => ({
			id: capability.id,
			name: capability.name,
			description: capability.description,
			icon: capability.icon("size-3.5 text-foreground"),
			iconBg: capability.iconBgClassName,
			href:
				capability.id === "discover-knowledge"
					? `${basePath}/workspaces`
					: capability.id === "discover-tools"
						? `${basePath}/mcp-servers`
						: undefined,
		}),
	);

	const integrationCapabilities: CapabilityItem[] = [
		{
			id: "asana",
			name: "Asana",
			description: "Create and manage tasks in Asana",
			icon: <AsanaIcon className="size-4" />,
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
		{
			id: "attio",
			name: "Attio",
			description: "Search and create records in Attio CRM",
			icon: <AttioIcon className="size-4" />,
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
		{
			id: "canva",
			name: "Canva",
			description: "Connect with Canva to manage designs",
			icon: <CanvaIcon className="size-4" />,
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
		{
			id: "front",
			name: "Front",
			description: "Create and list conversations in Front",
			icon: <FrontIcon className="size-4" />,
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
		{
			id: "freshservice",
			name: "Freshservice",
			description: "Create IT service tickets in Freshservice",
			icon: <FreshserviceIcon className="size-4" />,
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
		{
			id: "github",
			name: "GitHub",
			description: "Manage repositories, issues, and pull requests",
			icon: (
				<svg
					viewBox="0 0 24 24"
					className="size-4 fill-foreground"
					aria-hidden="true"
					focusable="false"
				>
					<path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
				</svg>
			),
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
		{
			id: "linear",
			name: "Linear",
			description: "Create and track issues in Linear",
			icon: (
				<svg
					viewBox="0 0 24 24"
					className="size-4 fill-foreground"
					aria-hidden="true"
					focusable="false"
				>
					<path d="M.63 14.81C1.02 18.78 4.2 21.96 8.17 22.35zM0 12.31l11.67 11.67c.37-.06.74-.14 1.1-.24L.24 11.21c-.1.36-.18.73-.24 1.1M.06 10.12l13.8 13.8c.35-.08.7-.17 1.04-.28L.34 9.08a13.37 13.37 0 0 0-.28 1.04m.51-2.68 15.97 15.97c.3-.12.6-.25.88-.4L1.0 6.56c-.15.28-.28.58-.4.88m1.25-2.44 17.14 17.14c.25-.17.5-.34.73-.52L2.34 4.27c-.18.23-.36.47-.52.73m1.96-2.24 17.47 17.47c.21-.21.41-.43.6-.65L3.37 2.11c-.22.19-.44.39-.65.6m2.62-1.94 16.77 16.77c.17-.25.34-.5.49-.76L5.91 1.13c-.26.15-.51.32-.76.49m3.07-1.56 14.02 14.02c.13-.29.25-.58.36-.88L9.56.72a13.76 13.76 0 0 0-.88.36M11.69.27 23.71 12.3c.11-.36.19-.73.25-1.1L12.79.02a12.5 12.5 0 0 0-1.1.25m2.5-.2 9.72 9.72C23.55 5.81 20.37 2.63 14.19.07Z" />
				</svg>
			),
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
		{
			id: "notion",
			name: "Notion",
			description: "Read and update pages in Notion",
			icon: (
				<svg
					viewBox="0 0 24 24"
					className="size-4 fill-foreground"
					aria-hidden="true"
					focusable="false"
				>
					<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
				</svg>
			),
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
		{
			id: "slack",
			name: "Slack",
			description: "Send messages and read channels in Slack",
			icon: (
				<svg
					viewBox="0 0 24 24"
					className="size-4"
					aria-hidden="true"
					focusable="false"
				>
					<path
						fill="#E01E5A"
						d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.687 8.834a2.528 2.528 0 0 1-2.521 2.521 2.527 2.527 0 0 1-2.521-2.521V2.522A2.527 2.527 0 0 1 15.166 0a2.528 2.528 0 0 1 2.521 2.522v6.312zM15.166 18.956a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.166 24a2.527 2.527 0 0 1-2.521-2.522v-2.522h2.521zM15.166 17.687a2.527 2.527 0 0 1-2.521-2.521 2.526 2.526 0 0 1 2.521-2.521h6.312A2.527 2.527 0 0 1 24 15.166a2.528 2.528 0 0 1-2.522 2.521h-6.312z"
					/>
					<path
						fill="#36C5F0"
						d="M5.042 8.834H2.522A2.528 2.528 0 0 1 0 6.313a2.527 2.527 0 0 1 2.522-2.521 2.527 2.527 0 0 1 2.52 2.521v2.521zM8.834 5.042V2.522A2.528 2.528 0 0 1 11.355 0a2.527 2.527 0 0 1 2.521 2.522 2.527 2.527 0 0 1-2.521 2.52H8.834z"
					/>
				</svg>
			),
			iconBg: "bg-white dark:bg-zinc-900",
			isConfigureLink: true,
			href: settingsPath,
		},
	];

	const allCapabilities = [
		...builtInCapabilities,
		...integrationCapabilities,
	];

	const filtered = search
		? allCapabilities.filter((cap) => {
				const q = search.toLowerCase();
				return (
					cap.name.toLowerCase().includes(q) ||
					cap.description.toLowerCase().includes(q)
				);
			})
		: allCapabilities;

	const builtInFiltered = filtered.filter((c) =>
		builtInCapabilities.some((b) => b.id === c.id),
	);
	const integrationFiltered = filtered.filter((c) =>
		integrationCapabilities.some((i) => i.id === c.id),
	);

	const renderItem = (cap: CapabilityItem) => {
		const isSelected = selectedCapabilityIds?.includes(cap.id);
		const content = (
			<>
				<div
					className={cn(
						"flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50",
						cap.iconBg,
					)}
				>
					{cap.icon}
				</div>
				<div className="min-w-0 flex-1">
					<p className="text-xs font-medium text-foreground">
						{cap.name}
					</p>
					<p className="text-[10px] leading-snug text-muted-foreground break-words">
						{cap.description}
					</p>
				</div>
				{cap.isConfigureLink && (
					<span className="shrink-0 flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/8 border border-primary/20 rounded-md px-1.5 py-0.5">
						<Settings2Icon className="size-3" />
						Configure
					</span>
				)}
				{isSelected && !cap.isConfigureLink && (
					<CheckCircle2Icon className="size-3.5 text-primary shrink-0" />
				)}
			</>
		);

		const className =
			"flex items-center gap-2.5 px-3 py-2 hover:bg-muted/50 transition-colors group cursor-pointer";

		// Configure links (integrations) always navigate
		if (cap.isConfigureLink && cap.href) {
			return (
				<a
					key={cap.id}
					href={cap.href}
					onClick={onClose}
					className={className}
				>
					{content}
				</a>
			);
		}

		// Discover Knowledge / Discover Tools — href navigation without configure badge
		if (cap.href && !cap.isConfigureLink) {
			return (
				<a
					key={cap.id}
					href={cap.href}
					onClick={onClose}
					className={className}
				>
					{content}
				</a>
			);
		}

		// All other built-in capabilities — add as chip
		return (
			<button
				key={cap.id}
				type="button"
				onClick={() => {
					onSelectCapability?.(cap);
					onClose();
				}}
				className={cn(
					className,
					"text-left",
					isSelected && "bg-primary/5",
				)}
			>
				{content}
			</button>
		);
	};

	if (filtered.length === 0) {
		return (
			<div className="py-6 text-center text-xs text-muted-foreground">
				No capabilities match your search
			</div>
		);
	}

	return (
		<div
			className="max-h-80 overflow-x-hidden overflow-y-auto py-1"
			style={{ scrollbarWidth: "thin" }}
		>
			{builtInFiltered.length > 0 && (
				<>
					{!search && (
						<p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/60">
							Built-in
						</p>
					)}
					{builtInFiltered.map(renderItem)}
				</>
			)}
			{integrationFiltered.length > 0 && (
				<>
					{!search && (
						<p className="px-3 pt-3 pb-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/60 border-t border-border/40 mt-1">
							Integrations
						</p>
					)}
					{integrationFiltered.map(renderItem)}
				</>
			)}
		</div>
	);
}

// ── AgentPickerDialog ──────────────────────────────────────────────────────────

function AgentPickerDialog({
	open,
	onClose,
	organizationId,
	selectedAgentIds,
	onToggle,
}: {
	open: boolean;
	onClose: () => void;
	organizationId?: string | null;
	selectedAgentIds: string[];
	onToggle: (agent: SelectedAgent) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Choose agents</DialogTitle>
				</DialogHeader>
				<AgentBrowserSection
					organizationId={organizationId}
					selectedAgentIds={selectedAgentIds}
					onToggleAgent={onToggle}
				/>
			</DialogContent>
		</Dialog>
	);
}

// ── LandingView ────────────────────────────────────────────────────────────────

function LandingView({
	firstName,
	selectedAgents,
	onToggleAgent,
	onRemoveAgent,
	onOpenAgentPicker,
	onSend,
	organizationId,
	selectedCapabilities,
	onToggleCapability,
	onRemoveCapability,
	selectedConversationMcpIds,
	onOpenConversationToolPicker,
}: {
	firstName: string;
	selectedAgents: SelectedAgent[];
	onToggleAgent: (agent: SelectedAgent) => void;
	onRemoveAgent: (agentId: string) => void;
	onOpenAgentPicker: () => void;
	onSend: (payload: SendPayload) => void;
	organizationId?: string | null;
	selectedCapabilities?: CapabilityItem[];
	onToggleCapability?: (cap: CapabilityItem) => void;
	onRemoveCapability?: (capId: string) => void;
	selectedConversationMcpIds?: string[] | null;
	onOpenConversationToolPicker?: () => void;
}) {
	const [input, setInput] = useState("");
	const [greeting, setGreeting] = useState("");

	useEffect(() => {
		setGreeting(getRandomGreeting(firstName));
	}, [firstName]);

	const handleSend = useCallback(
		(payload: SendPayload) => {
			onSend(payload);
			setInput("");
		},
		[onSend],
	);

	return (
		<div className="flex flex-col h-full overflow-auto">
			{/* Vertically centered greeting + input */}
			<div className="flex flex-col items-center px-4 max-w-[55rem] mx-auto w-full pt-[12vh] pb-8 gap-6">
				<h1
					className="text-foreground/85"
					style={{
						fontFamily: "var(--font-sans)",
						fontWeight: 400,
						fontSize: "clamp(1.5rem, 4vw, 2.5rem)",
						lineHeight: 1.15,
						letterSpacing: "-0.01em",
					}}
				>
					{greeting}
				</h1>
				<div className="w-full">
					<ComposeInput
						value={input}
						onChange={setInput}
						onSend={handleSend}
						isLoading={false}
						selectedAgents={selectedAgents}
						onRemoveAgent={onRemoveAgent}
						onOpenAgentPicker={onOpenAgentPicker}
						organizationId={organizationId}
						onToggleAgent={onToggleAgent}
						selectedCapabilities={selectedCapabilities}
						onToggleCapability={onToggleCapability}
						onRemoveCapability={onRemoveCapability}
						autoFocus
					/>
				</div>
			</div>

			{/* Agent browser below input */}
			<div className="max-w-[55rem] mx-auto w-full px-4 pb-12">
				<AgentBrowserSection
					organizationId={organizationId}
					selectedAgentIds={selectedAgents.map((a) => a.agentId)}
					onToggleAgent={onToggleAgent}
					selectedConversationMcpIds={selectedConversationMcpIds}
					onOpenConversationToolPicker={onOpenConversationToolPicker}
				/>
			</div>
		</div>
	);
}

// ── TurnBlock ──────────────────────────────────────────────────────────────────

function TurnBlock({
	turn,
	organizationId,
	organizationSlug,
	chatScope,
}: {
	turn: ConversationTurn;
	organizationId?: string | null;
	organizationSlug?: string | null;
	chatScope: ChatScope;
}) {
	const responses = Array.from(turn.agentResponses.values());
	// Caption parity with `CopilotUserMessage` (AI Feature Assistant /
	// DocumentEditor) and `FabricDirectChat` (Fabric Agent panel):
	// paperclip + 11px filename rendered OUTSIDE the bubble, no
	// background, no border, right-aligned beneath the user message.
	// Older persisted turns without `attachmentNames` skip gracefully.
	const captionNames = turn.attachmentNames ?? [];

	return (
		<div className="space-y-4">
			{/* User message */}
			<div className="flex flex-col items-end gap-1">
				<div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm leading-relaxed">
					{turn.userMessage}
				</div>
				{captionNames.length > 0 && (
					<div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 px-1 text-[11px] text-muted-foreground/70">
						{captionNames.map((name) => (
							<span
								key={name}
								className="inline-flex items-center gap-1"
							>
								<PaperclipIcon
									className="h-2.5 w-2.5"
									aria-hidden="true"
								/>
								<span className="max-w-[220px] truncate">
									{name}
								</span>
							</span>
						))}
					</div>
				)}
			</div>

			{/* Agent responses — one per agent, all stream simultaneously */}
			<div className="space-y-4">
				{responses.map((resp) => (
					<AgentResponseBlock
						key={resp.agentId}
						response={resp}
						organizationId={organizationId}
						organizationSlug={organizationSlug}
						chatScope={chatScope}
					/>
				))}
			</div>
		</div>
	);
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

function AgentResponseBlock({
	response,
	organizationId,
	organizationSlug,
	chatScope,
}: {
	response: AgentResponse;
	organizationId?: string | null;
	organizationSlug?: string | null;
	chatScope: ChatScope;
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

	const isModelAgent = response.agentId.startsWith("model:");

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
									.filter(
										(c: any) =>
											c?.type === "text" && c?.text,
									)
									.map((c: any) => c.text)
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
				{response.pendingApproval && response.executionId && (
					<ChatApprovalCard
						approvalId={response.pendingApproval.approvalId}
						stepId={response.pendingApproval.stepId}
						reason={response.pendingApproval.reason}
						executionId={response.executionId}
						organizationId={organizationId}
					/>
				)}

				{/* Message content or thinking indicator */}
				{response.isLoading &&
				!response.content &&
				toolCallItems.length === 0 &&
				!response.pendingApproval ? (
					<ThinkingIndicator />
				) : response.isError ? (
					<p className="text-sm text-destructive">
						{response.content || "An error occurred."}
					</p>
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

// ── ConversationView ───────────────────────────────────────────────────────────

function ConversationView({
	turns,
	isLoading,
	onSend,
	onStop,
	onNew,
	selectedAgents,
	onRemoveAgent,
	onOpenAgentPicker,
	onToggleAgent,
	organizationId,
	organizationSlug,
	selectedCapabilities,
	onToggleCapability,
	onRemoveCapability,
	selectedConversationMcpIds,
	onOpenConversationToolPicker,
}: {
	turns: ConversationTurn[];
	isLoading: boolean;
	onSend: (payload: SendPayload) => void;
	/**
	 * Invoked when the user clicks the morphed Stop button. The parent
	 * wires this to `useMultiAgentStream().stopAll("button")`.
	 * The morph appears whenever any agent in the current turn is
	 * in-flight (visibility predicate computed below).
	 */
	onStop?: () => void;
	onNew: () => void;
	selectedAgents: SelectedAgent[];
	onRemoveAgent: (agentId: string) => void;
	onOpenAgentPicker: () => void;
	onToggleAgent?: (agent: SelectedAgent) => void;
	organizationId?: string | null;
	/**
	 * Forwarded into `<ChatMessageInsertDiagramButton>` per Excalidraw
	 * tool call (spec § 8.1 / F1). Used by the button's client-side
	 * feature-flag short-circuit (slug allowlist for staged rollout).
	 */
	organizationSlug?: string | null;
	selectedCapabilities?: CapabilityItem[];
	onToggleCapability?: (cap: CapabilityItem) => void;
	onRemoveCapability?: (capId: string) => void;
	selectedConversationMcpIds?: string[] | null;
	onOpenConversationToolPicker?: () => void;
}) {
	// Build the Nexus chat scope once for the whole conversation —
	// passed down to every `TurnBlock` / `AgentResponseBlock` so each
	// per-tool-call slot doesn't re-call the hook. Nexus has no project
	// binding (the surface lives at `/app/{slug}/copilot`), so
	// `projectId` is `null`. The button's resolver returns null in this
	// case and the picker path (FR-7) activates.
	const chatScope = useChatScopedProjectFromMultiAgentStream({
		projectId: null,
		organizationId: organizationId ?? null,
		turns,
	});
	const [input, setInput] = useState("");
	const handleSend = useCallback(
		(payload: SendPayload) => {
			if (isLoading) {
				return;
			}
			onSend(payload);
			setInput("");
		},
		[isLoading, onSend],
	);

	// Managed-default MCP configs are unioned into every chat by the backend
	// — include their count in the "Chat tools" badge so the displayed
	// number reflects what's actually active for this turn.
	const { data: mcpConfigs } = useQuery({
		queryKey: ["mcp-configs", organizationId ?? null],
		queryFn: () =>
			organizationId
				? orpcClient.mcp.configs.list({ organizationId })
				: orpcClient.mcp.configs.list(),
		refetchOnWindowFocus: false,
	});
	const managedDefaultMcpConfigCount = (mcpConfigs ?? []).filter(
		(c: any) => !!c?.isManagedDefault,
	).length;

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between pl-5 pr-32 py-3 border-b border-border shrink-0">
				<div className="flex items-center gap-2">
					{selectedAgents.length > 0 ? (
						<SelectedAgentsInline selectedAgents={selectedAgents} />
					) : (
						<>
							<SparklesIcon className="size-4 text-muted-foreground" />
							<span className="text-sm font-medium text-foreground">
								{DEFAULT_AI_AGENT_NAME}
							</span>
						</>
					)}
					{isLoading && (
						<span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/60 ml-1">
							thinking
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onOpenConversationToolPicker}
						className="inline-flex items-center rounded-lg border border-border/70 bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
					>
						Chat tools
						{selectedConversationMcpIds != null && (
							<span className="ml-1.5 text-[10px] text-foreground">
								{selectedConversationMcpIds.length +
									managedDefaultMcpConfigCount}
							</span>
						)}
					</button>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 text-xs"
						onClick={onNew}
					>
						<PlusIcon className="size-3.5" />
						New
					</Button>
				</div>
			</div>

			{/* Message list */}
			<Conversation
				className="flex-1 px-4 py-8"
				initial="smooth"
				resize="instant"
			>
				<ConversationContent className="max-w-[55rem] mx-auto space-y-10">
					{turns.length === 0 ? (
						<div className="py-12 text-center text-sm text-muted-foreground">
							No messages in this conversation.
						</div>
					) : (
						turns.map((turn) => (
							<TurnBlock
								key={turn.id}
								turn={turn}
								organizationId={organizationId}
								organizationSlug={organizationSlug}
								chatScope={chatScope}
							/>
						))
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			{/* Input */}
			<div className="shrink-0 border-t border-border px-4 py-3">
				<div className="max-w-[55rem] mx-auto">
					<ComposeInput
						value={input}
						onChange={setInput}
						onSend={handleSend}
						onStop={onStop}
						isLoading={isLoading}
						selectedAgents={selectedAgents}
						onRemoveAgent={onRemoveAgent}
						onOpenAgentPicker={onOpenAgentPicker}
						organizationId={organizationId}
						onToggleAgent={onToggleAgent}
						selectedCapabilities={selectedCapabilities}
						onToggleCapability={onToggleCapability}
						onRemoveCapability={onRemoveCapability}
						placeholder="Ask a follow-up..."
					/>
				</div>
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

// ── Main component ─────────────────────────────────────────────────────────────

interface CopilotPageProps {
	organizationId?: string | null;
	/**
	 * Organization slug from the Nexus route. Forwarded into the
	 * orchestrator stream body so the workflow can construct surface-
	 * specific deep links (e.g. the "/app/{slug}/mcp-servers" CTA
	 * emitted by `applyDefaultMcpEagerRouting` on the service-down
	 * branch). Optional — personal-context callers omit it.
	 */
	organizationSlug?: string;
	/**
	 * Persisted agent selection fetched on the server during SSR. Passed as
	 * `initialData` into the React Query hydration query so the picker shows
	 * the user's saved chips on the first paint, with no client-side
	 * waterfall. Same shape as the GET endpoint returns. `null` means the
	 * server couldn't fetch (e.g. unauthenticated SSR) — in that case we
	 * fall back to the client-side query path (existing behavior).
	 */
	initialPersistedSelection?: {
		exists: boolean;
		version: number;
		selectedAgents: PersistedSelectedAgent[];
		droppedCount: number;
	} | null;
}

export function CopilotPage({
	organizationId,
	organizationSlug,
	initialPersistedSelection,
}: CopilotPageProps) {
	const { user } = useSession();
	const firstName = user?.name?.split(" ")[0] ?? "there";
	const queryClient = useQueryClient();
	const router = useRouter();
	const basePath = useBasePath();
	const { trackEvent } = useAnalytics();

	// Seed `selectedAgents` from SSR `initialData` when the server-rendered
	// HTML already carries the user's saved chips. This is the difference
	// between the picker rendering blank-then-pop and rendering populated on
	// the very first paint. Falls back to `[]` when SSR didn't fetch (e.g.
	// unauthenticated render path) — in that case the client-side query path
	// runs as before.
	const [selectedAgents, setSelectedAgents] = useState<SelectedAgent[]>(
		initialPersistedSelection?.exists &&
			initialPersistedSelection.selectedAgents.length > 0
			? (initialPersistedSelection.selectedAgents as SelectedAgent[])
			: [],
	);
	const [selectedCapabilities, setSelectedCapabilities] = useState<
		CapabilityItem[]
	>([]);
	const [hasStarted, setHasStarted] = useState(false);
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const [historyChat, setHistoryChat] = useState<HistoryChat | null>(null);
	const [agentPickerOpen, setAgentPickerOpen] = useState(false);
	const [conversationToolPickerOpen, setConversationToolPickerOpen] =
		useState(false);
	const [isHistorySidebarCollapsed, setIsHistorySidebarCollapsed] =
		useState(false);
	const [selectedConversationMcpIds, setSelectedConversationMcpIds] =
		useState<string[] | null>(null);

	const priorHistoryMessagesRef = useRef<HistoryChatMessage[]>([]);
	const activeChatIdRef = useRef<string | null>(null);
	const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const lastPersistedSnapshotRef = useRef<string | null>(null);
	// Mirror of `selectedAgents` updated synchronously inside pick/unpick
	// handlers so RAPID clicks read each other's results. Without this,
	// three clicks in the same render cycle all see the OLD closure value
	// and each computes a 1-item `next` — only the last `setSelectedAgents`
	// (and its persist call) wins, losing the prior two picks. The ref is
	// updated BEFORE `setSelectedAgents`, so click N sees click N-1's
	// result even though React hasn't re-rendered yet. Initial value
	// matches the `useState` initializer above.
	const selectedAgentsRef = useRef<SelectedAgent[]>(
		initialPersistedSelection?.exists &&
			initialPersistedSelection.selectedAgents.length > 0
			? (initialPersistedSelection.selectedAgents as SelectedAgent[])
			: [],
	);

	useEffect(() => {
		activeChatIdRef.current = activeChatId;
		lastPersistedSnapshotRef.current = null;
	}, [activeChatId]);

	// Keep `selectedAgentsRef` in sync with `selectedAgents` for state
	// updates that didn't go through the pick/unpick handlers (hydration
	// effect, tenant-change reset, "New thread" reset, history-chat
	// activation). Handler-initiated changes update the ref synchronously
	// BEFORE `setSelectedAgents`, so this effect is a no-op for those
	// paths — but is essential for the others.
	useEffect(() => {
		selectedAgentsRef.current = selectedAgents;
	}, [selectedAgents]);

	const searchParams = useSearchParams();
	const initialChatId = searchParams.get("c");
	const initialAgentParam = searchParams.get("agent");
	const hasAutoLoadedRef = useRef(false);
	const hasAutoSelectedAgentRef = useRef(false);

	// Stop-failure toast — the cancel POST returns non-2xx for one or
	// more of the in-flight agents. The visual state does NOT revert
	// (decision 11 / AC-10); we only surface a single non-blocking note
	// per turn. Copy audited against fabric/standards/ai/ai-copy-tone.md
	// — task 4.1.
	const handleStopFailed = useCallback(() => {
		toast.message(
			"Couldn't fully stop the response. Trailing tokens may still arrive.",
		);
	}, []);

	// Generic forwarder that turns SSE-stream tracking events into
	// `useAnalytics().trackEvent` calls. The hook itself doesn't import
	// the analytics module (keeps tests simple, avoids a circular dep
	// between the AI module and the analytics module), so this wrapper
	// performs the wire-up. The allowlist is explicit so a stray event
	// name from the server can't quietly inflate the analytics surface.
	const handleAnalyticsEvent = useCallback(
		(eventName: string, payload: Record<string, unknown>) => {
			if (
				eventName === "mcp_default_tool_invoked" ||
				eventName === "mcp_default_tool_failed"
			) {
				trackEvent(eventName, payload);
			}
		},
		[trackEvent],
	);

	const multiAgent = useMultiAgentStream({
		organizationId,
		onStopFailed: handleStopFailed,
		onAnalyticsEvent: handleAnalyticsEvent,
	});

	// Stable `onStop` for ComposeInput — wraps the hook's `stopAll()`
	// with the `"button"` trigger tag so cancel telemetry distinguishes
	// the morph click from the Esc keybinding.
	const handleStopAllFromButton = useCallback(() => {
		multiAgent.stopAll("button");
	}, [multiAgent.stopAll]);

	// Stable `onStop` for the shared Esc binding — tags telemetry as
	// `"esc"` so we can distinguish keypresses from morph clicks
	// (spec § 10.1, decision 9 / AC-7).
	const handleStopAllFromEsc = useCallback(() => {
		multiAgent.stopAll("esc");
	}, [multiAgent.stopAll]);

	// Esc-context binding (spec § 8.8 / AC-7). While any agent in the
	// current turn is streaming, Esc stops all of them via `stopAll`.
	// While idle on Nexus, Esc is a no-op — we omit `onClose` so the
	// hook does not navigate, blur, or close anything.
	useEscToStopOrClose({
		isInFlight: multiAgent.isLoading,
		onStop: handleStopAllFromEsc,
	});

	// ── Persistent agent selection — hydrate on mount, write-through on send.
	//   Decision 5 / spec §6.1 — the picker stays empty until the response
	//   resolves, mirroring today's first-run UX. Decision 6 / spec §6.3 —
	//   no focus refetch, no visibility-change refetch, no realtime push:
	//   each tab hydrates exactly once on mount and last-write-wins on send.
	const persistenceQuery = useQuery({
		queryKey: ["chat-agent-selection", user?.id, organizationId],
		// `tenantProtectedProcedure` resolves (user × org) from the
		// session — no input needed here. `organizationId` is in the
		// queryKey only so React Query invalidates / refetches when the
		// user switches orgs (which restarts the session). Per spec §6.3
		// (Decision 6), there's no focus / visibility refetch.
		queryFn: async () => orpcClient.users.chatAgentSelection.get(),
		// SSR `initialData` short-circuits the client-side fetch on first
		// mount. Combined with `staleTime: Infinity` and
		// `refetchOnMount: false`, the query treats the SSR-provided value
		// as the source of truth and never fires a redundant round-trip.
		// On org switches (queryKey changes), this prop value won't match
		// the new key — React Query starts a fresh query and the server
		// component re-renders with the new org's data, so the new key
		// also gets initialData.
		initialData: initialPersistedSelection ?? undefined,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: 1,
		enabled: !!user?.id,
	});

	const persistenceHydratedRef = useRef(false);
	// Reset the one-shot hydration guard AND clear the picker whenever the
	// (user × org) pair changes. Next.js App Router does NOT remount the
	// page when only a dynamic route segment changes (org #1 → org #2 via
	// /app/{slug}/nexus), so without this reset the second org's persisted
	// selection would silently fail to seed (ref still true) AND the
	// previous org's agents would linger in the picker (selectedAgents not
	// cleared). Personal ↔ org switches DO remount (different route trees),
	// but defensive reset costs nothing. Skip the very first run so we
	// don't clear state right after parent provides the initial org id.
	const lastTenantKeyRef = useRef<string | null>(null);
	useEffect(() => {
		const tenantKey = `${user?.id ?? ""}::${organizationId ?? ""}`;
		if (lastTenantKeyRef.current === null) {
			lastTenantKeyRef.current = tenantKey;
			return;
		}
		if (lastTenantKeyRef.current === tenantKey) {
			return;
		}
		lastTenantKeyRef.current = tenantKey;
		persistenceHydratedRef.current = false;
		setSelectedAgents([]);
	}, [user?.id, organizationId]);

	useEffect(() => {
		// Race-window guard: only seed when the user has not yet picked
		// anything manually. Hydrate once per (user × org), irrespective of
		// subsequent query invalidations.
		if (persistenceHydratedRef.current) {
			return;
		}
		const data = persistenceQuery.data;
		if (!data) {
			return;
		}
		if (
			data.exists &&
			data.selectedAgents.length > 0 &&
			selectedAgents.length === 0
		) {
			setSelectedAgents(data.selectedAgents);
		}
		// Telemetry — spec §7. Three events tracking the persistence path:
		//   - hydrated: persistence existed and was non-empty (irrespective
		//     of whether we actually seeded — fast typists who picked
		//     before the response are still meaningful for analytics).
		//   - invalidated: server-side validator dropped at least one entry.
		//   - written: emitted by the mutation's onSuccess.
		if (data.exists && data.selectedAgents.length > 0) {
			trackEvent("nexus_agent_persistence_hydrated", {
				count: data.selectedAgents.length,
				organizationId: organizationId ?? null,
			});
		}
		if (data.droppedCount > 0) {
			trackEvent("nexus_agent_persistence_invalidated", {
				droppedCount: data.droppedCount,
				organizationId: organizationId ?? null,
			});
		}
		persistenceHydratedRef.current = true;
	}, [
		persistenceQuery.data,
		selectedAgents.length,
		trackEvent,
		organizationId,
	]);

	const persistMutation = useMutation({
		mutationFn: async (input: {
			selectedAgents: PersistedSelectedAgent[];
		}) =>
			orpcClient.users.chatAgentSelection.set({
				selectedAgents: input.selectedAgents,
			}),
		onSuccess: (_data, variables) => {
			trackEvent("nexus_agent_persistence_written", {
				count: variables.selectedAgents.length,
				organizationId: organizationId ?? null,
			});
		},
		// Persistence-write failures must NEVER surface to the user — see
		// spec §6.2 / Decision 7 / `global/error-handling.md` "telemetry
		// only on persistence". The chat send path is already running by
		// the time this fires; a rejected promise here would stack-trace
		// to the console and otherwise be invisible.
		onError: (err) => {
			// eslint-disable-next-line no-console -- intentional dev signal
			console.warn(
				"[CopilotPage] chat-agent-selection persist failed",
				err,
			);
		},
	});

	// Serialize persist mutations: only ONE write in flight at a time, the
	// LATEST requested state always wins. Without this, rapid clicks fire
	// 3 parallel POSTs to `chatAgentSelection.set`; whichever response the
	// server processes LAST wins at the DB, but TCP / HTTP/2 ordering
	// makes that non-deterministic — UI ends empty, DB ends with one of
	// the intermediate states (the staging repro).
	//
	// Pattern: while a mutation is in flight, stash any newer requested
	// state in `pendingPersistRef`. On settle, if there's a pending
	// state different from what we just persisted, fire it. Coalesces
	// bursts into at most TWO requests (the one already in flight plus
	// the final state).
	const persistInFlightRef = useRef(false);
	const pendingPersistRef = useRef<PersistedSelectedAgent[] | null>(null);
	const firePersistAgentSelection = useCallback(
		(selection: PersistedSelectedAgent[]) => {
			if (persistInFlightRef.current) {
				// Overwrite any prior pending — only the latest matters.
				pendingPersistRef.current = selection;
				return;
			}
			persistInFlightRef.current = true;
			persistMutation.mutate(
				{ selectedAgents: selection },
				{
					onSettled: () => {
						persistInFlightRef.current = false;
						const next = pendingPersistRef.current;
						if (next !== null) {
							pendingPersistRef.current = null;
							firePersistAgentSelection(next);
						}
					},
				},
			);
		},
		[persistMutation],
	);

	// ── Chat list (infinite scroll) ──────────────────────────────────────────

	const chatListQuery = useInfiniteQuery({
		queryKey: ["ai-chats", organizationId],
		queryFn: async ({ pageParam }: { pageParam: number }) => {
			return await orpcClient.ai.chats.list({
				organizationId: organizationId ?? null,
				limit: 20,
				offset: pageParam,
			});
		},
		getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
		initialPageParam: 0,
		refetchOnWindowFocus: false,
	});

	const allChats = chatListQuery.data?.pages.flatMap((p) => p.chats) ?? [];

	const { data: workflowIntegrationsData = [] } = useQuery({
		queryKey: ["workflow-integrations", organizationId ?? null, "copilot"],
		queryFn: async () => {
			const result = await orpcClient.workflows.integrations.list({
				organizationId: organizationId ?? null,
			});
			return (result.integrations || []) as WorkflowIntegrationRecord[];
		},
		refetchOnWindowFocus: false,
	});

	const chatToolsQuery = useQuery({
		queryKey: ["ai-chat-tools", activeChatId, organizationId],
		queryFn: async () => {
			if (!activeChatId) {
				throw new Error(
					"Active chat ID is required to load chat tools.",
				);
			}

			return orpcClient.ai.chats.tools.list({
				id: activeChatId,
				organizationId: organizationId ?? null,
			});
		},
		enabled: !!activeChatId,
		refetchOnWindowFocus: false,
	});

	const updateChatToolsMutation = useMutation({
		mutationFn: async (params: {
			selectedMcpConfigIds: string[];
			toolSelectionMode: "DEFAULT" | "ONLY_SELECTED" | "DISABLED";
		}) => {
			if (!activeChatId) {
				throw new Error(
					"Active chat ID is required to update chat tools.",
				);
			}

			return orpcClient.ai.chats.tools.update({
				id: activeChatId,
				organizationId: organizationId ?? null,
				...params,
			});
		},
		onSuccess: (result) => {
			setSelectedConversationMcpIds(resolveSelectedChatToolIds(result));
		},
	});

	// Always-on query so agent config (instructions, MCP servers, workspace IDs) can be
	// restored when loading a conversation from history (cold load / URL navigation).
	const { data: agentInstanceConfigsData } = useQuery({
		queryKey: [
			"agent-template-instances",
			organizationId,
			"config-registry",
		],
		queryFn: () =>
			orpcClient.agentTemplates.instances.list({
				organizationId: organizationId ?? null,
				status: "ACTIVE",
				latestVersionOnly: true,
				limit: 100,
				offset: 0,
			}),
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});

	// Map from agentId → full config, used to enrich agents recovered from history
	const instanceConfigMap = useMemo(() => {
		const map = new Map<
			string,
			{
				instructions: string | null;
				enabledMcpConfigIds: string[];
				workspaceIds: string[];
				instanceId?: string;
				enabledIntegrationIds: string[];
			}
		>();
		for (const instance of agentInstanceConfigsData?.instances ?? []) {
			const config = buildInstanceAgentConfig(instance as any);
			// Resolve OAuth integration providers → IDs using workflowIntegrationsData
			const enabledIntegrationIds = (
				config.enabledIntegrationProviders ?? []
			).flatMap((provider) =>
				workflowIntegrationsData
					.filter((i) => i.isActive && i.provider === provider)
					.map((i) => i.id),
			);
			map.set(`template-instance:${(instance as any).id}`, {
				...config,
				enabledIntegrationIds,
			});
		}
		return map;
	}, [agentInstanceConfigsData, workflowIntegrationsData]);

	useEffect(() => {
		if (!activeChatId) {
			setSelectedConversationMcpIds(null);
			return;
		}

		if (!chatToolsQuery.data) {
			return;
		}

		setSelectedConversationMcpIds(
			resolveSelectedChatToolIds(chatToolsQuery.data),
		);
	}, [activeChatId, chatToolsQuery.data]);

	const loadMoreRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = loadMoreRef.current;
		if (!el) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (
					entries[0].isIntersecting &&
					chatListQuery.hasNextPage &&
					!chatListQuery.isFetchingNextPage
				) {
					chatListQuery.fetchNextPage();
				}
			},
			{ threshold: 0.1 },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [
		chatListQuery.hasNextPage,
		chatListQuery.isFetchingNextPage,
		chatListQuery.fetchNextPage,
	]);

	const activateChatFromHistory = useCallback(
		(chat: (typeof allChats)[number]) => {
			multiAgent.reset();
			const historyMessages =
				(chat.messages as unknown as HistoryChatMessage[]) ?? [];
			const hydratedTurns = buildTurnsFromHistory(historyMessages);
			const resumptions = extractResumableExecutions(hydratedTurns);
			setActiveChatId(chat.id);
			activeChatIdRef.current = chat.id;
			setSelectedAgents(
				deriveSelectedAgentsFromHistory(
					historyMessages,
					instanceConfigMap,
				),
			);
			setSelectedCapabilities([]);
			if (resumptions.length > 0) {
				priorHistoryMessagesRef.current = [];
				setHistoryChat(null);
				setHasStarted(true);
				multiAgent.hydrateTurns(hydratedTurns);
				multiAgent.resumeAgents(
					resumptions.map((resumption) => ({
						turnId: resumption.turnId,
						executionId: resumption.executionId,
						agent: {
							agentId: resumption.agentId,
							name: resumption.agentName,
							vendor: resumption.vendor,
						},
					})),
				);
				return;
			}

			setHasStarted(false);
			setHistoryChat({
				id: chat.id,
				title: chat.title,
				messages: historyMessages,
				createdAt: chat.createdAt,
				updatedAt: chat.updatedAt,
			});
		},
		[multiAgent, instanceConfigMap],
	);

	// ── Auto-load chat from URL ?c=chatId on initial mount / refresh ─────────

	useEffect(() => {
		if (hasAutoLoadedRef.current) {
			return;
		}
		if (!initialChatId) {
			return;
		}
		// Only auto-load when no conversation is active (i.e. page refresh/direct link)
		if (activeChatId !== null || hasStarted) {
			return;
		}
		if (!chatListQuery.isSuccess || allChats.length === 0) {
			return;
		}
		const chat = allChats.find((c) => c.id === initialChatId);
		if (!chat) {
			return;
		}
		hasAutoLoadedRef.current = true;
		activateChatFromHistory(chat);
	}, [
		activateChatFromHistory,
		initialChatId,
		activeChatId,
		hasStarted,
		chatListQuery.isSuccess,
		allChats,
	]);

	useEffect(() => {
		if (hasAutoSelectedAgentRef.current) {
			return;
		}
		if (!initialAgentParam || initialChatId) {
			return;
		}
		if (activeChatId !== null || hasStarted) {
			return;
		}

		try {
			const parsed = JSON.parse(initialAgentParam) as SelectedAgent;
			if (!parsed?.agentId || !parsed?.name) {
				return;
			}
			hasAutoSelectedAgentRef.current = true;
			setSelectedAgents([parsed]);
		} catch {
			// Ignore malformed deep-link payloads.
		}
	}, [activeChatId, hasStarted, initialAgentParam, initialChatId]);

	// ── Mutations ────────────────────────────────────────────────────────────

	const createChatMutation = useMutation({
		mutationFn: async (title: string) => {
			return await orpcClient.ai.chats.create({
				organizationId: organizationId ?? null,
				title: title.slice(0, 80),
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["ai-chats", organizationId],
			});
		},
	});

	const deleteChatMutation = useMutation({
		mutationFn: async (chatId: string) => {
			return await orpcClient.ai.chats.delete({
				id: chatId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["ai-chats", organizationId],
			});
		},
	});

	// ── Persist messages when any agent completes streaming ──────────────────
	// Saves as soon as each individual agent finishes, rather than waiting for
	// all agents to complete. This prevents data loss when one model hangs or
	// the user refreshes before all parallel streams finish.

	const buildMessagesToSave = useCallback(
		(turns: typeof multiAgent.turns) => {
			const allMessages = turns.flatMap((turn) => {
				const msgs: HistoryChatMessage[] = [
					{
						id: `user-${turn.id}`,
						turnId: turn.id,
						role: "user",
						content: turn.userMessage,
						timestamp: turn.timestamp.toISOString(),
					},
				];
				for (const [, resp] of turn.agentResponses) {
					if (
						resp.content ||
						resp.toolCalls.length > 0 ||
						resp.executionId
					) {
						// Persist completed tool calls so they can be shown in conversation history.

						const persistedToolCalls = resp.toolCalls
							.filter(
								(tc) =>
									tc.mcpAppResourceUri ||
									tc.status === "complete" ||
									tc.status === "error",
							)
							.map((tc) => ({
								id: tc.id,
								name: tc.name,
								args: tc.args,
								result: tc.result,
								status: tc.status,
								serverName: tc.serverName,
								mcpAppResourceUri: tc.mcpAppResourceUri,
								mcpAppConfigId: tc.mcpAppConfigId,
							}));
						msgs.push({
							id: `asst-${resp.agentId}-${turn.id}`,
							turnId: turn.id,
							role: "assistant",
							agentId: resp.agentId,
							agentName: resp.agentName,
							vendor: resp.vendor,
							executionId: resp.executionId,
							streamStatus: resp.status,
							content:
								selectedAgents.length > 1
									? `[${resp.agentName}]: ${resp.content}`
									: resp.content,
							timestamp: new Date().toISOString(),
							toolCalls:
								persistedToolCalls.length > 0
									? persistedToolCalls
									: undefined,
						});
					}
				}
				return msgs;
			});

			const prior = priorHistoryMessagesRef.current.map((m) => ({
				id: m.id,
				turnId: m.turnId,
				role: m.role,
				content: m.content,
				timestamp: m.timestamp ?? new Date().toISOString(),
				agentId: m.agentId,
				agentName: m.agentName,
				vendor: m.vendor,
				executionId: m.executionId,
				streamStatus: m.streamStatus,
				toolCalls: m.toolCalls,
			}));
			return prior.length > 0 ? [...prior, ...allMessages] : allMessages;
		},
		[selectedAgents.length],
	);

	const persistChatMessages = useCallback(
		async (
			chatId: string,
			messages: HistoryChatMessage[],
			options?: { invalidate?: boolean },
		) => {
			const snapshot = JSON.stringify(messages);
			if (snapshot === lastPersistedSnapshotRef.current) {
				return;
			}

			lastPersistedSnapshotRef.current = snapshot;
			const firstUserMsg = messages.find((m) => m.role === "user");
			const title = firstUserMsg?.content?.slice(0, 80) ?? undefined;

			await orpcClient.ai.chats.update({
				id: chatId,
				organizationId: organizationId ?? null,
				messages: messages as unknown as Record<string, unknown>[],
				title,
			});

			if (options?.invalidate) {
				queryClient.invalidateQueries({
					queryKey: ["ai-chats", organizationId],
				});
			}
		},
		[organizationId, queryClient],
	);

	const buildMessagesIncludingPendingUserTurn = useCallback(
		(message: string) => {
			const existingMessages = buildMessagesToSave(multiAgent.turns);
			return [
				...existingMessages,
				{
					id: `user-pending-${Date.now()}`,
					role: "user",
					content: message,
					timestamp: new Date().toISOString(),
				},
			] satisfies HistoryChatMessage[];
		},
		[buildMessagesToSave, multiAgent.turns],
	);

	const persistCurrentConversationNow = useCallback(async () => {
		const chatId = activeChatIdRef.current;
		if (!chatId || multiAgent.turns.length === 0) {
			return;
		}

		multiAgent.flushStreamingText();
		if (persistTimeoutRef.current) {
			clearTimeout(persistTimeoutRef.current);
			persistTimeoutRef.current = null;
		}

		const messagesToSave = buildMessagesToSave(multiAgent.turns);
		await persistChatMessages(chatId, messagesToSave, { invalidate: true });
	}, [buildMessagesToSave, multiAgent, persistChatMessages]);

	useEffect(() => {
		const chatId = activeChatIdRef.current;
		if (!chatId || multiAgent.turns.length === 0) {
			return;
		}

		const messagesToSave = buildMessagesToSave(multiAgent.turns);
		const hasStreamingResponses = multiAgent.turns.some((turn) =>
			Array.from(turn.agentResponses.values()).some(
				(resp) => resp.isLoading,
			),
		);

		if (persistTimeoutRef.current) {
			clearTimeout(persistTimeoutRef.current);
		}

		persistTimeoutRef.current = setTimeout(
			() => {
				void persistChatMessages(chatId, messagesToSave, {
					invalidate: !hasStreamingResponses,
				}).catch(console.error);
			},
			hasStreamingResponses ? 750 : 150,
		);

		return () => {
			if (persistTimeoutRef.current) {
				clearTimeout(persistTimeoutRef.current);
				persistTimeoutRef.current = null;
			}
		};
	}, [multiAgent.turns, buildMessagesToSave, persistChatMessages]);

	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				void persistCurrentConversationNow().catch(console.error);
			}
		};

		const handlePageHide = () => {
			void persistCurrentConversationNow().catch(console.error);
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);
		window.addEventListener("pagehide", handlePageHide);
		return () => {
			document.removeEventListener(
				"visibilitychange",
				handleVisibilityChange,
			);
			window.removeEventListener("pagehide", handlePageHide);
		};
	}, [persistCurrentConversationNow]);

	// ── Handlers ─────────────────────────────────────────────────────────────

	const waitForDocumentsReady = useCallback(
		async (
			chatId: string,
			documentIds: string[],
			maxWaitMs = 5 * 60 * 1000,
		): Promise<boolean> => {
			const startTime = Date.now();

			while (Date.now() - startTime < maxWaitMs) {
				try {
					const result = await orpcClient.ai.documents.list({
						chatId,
					});
					const targetDocs = result.documents.filter(
						(d: { id: string }) => documentIds.includes(d.id),
					);

					if (targetDocs.length < documentIds.length) {
						await new Promise((resolve) =>
							setTimeout(resolve, 2000),
						);
						continue;
					}

					const hasFailedDocs = targetDocs.some(
						(d: { status: string }) => d.status === "FAILED",
					);
					if (hasFailedDocs) {
						return false;
					}

					const hasPendingDocs = targetDocs.some(
						(d: { status: string }) =>
							d.status === "PENDING" || d.status === "PROCESSING",
					);

					if (!hasPendingDocs) {
						return true;
					}

					await new Promise((resolve) => setTimeout(resolve, 2000));
				} catch (error) {
					console.error(
						"[Nexus] Error checking document status:",
						error,
					);
					await new Promise((resolve) => setTimeout(resolve, 2000));
				}
			}

			return false;
		},
		[],
	);

	const handleSend = useCallback(
		async ({ message, files = [], onAttachmentOutcome }: SendPayload) => {
			if (!message.trim() && files.length === 0) {
				return;
			}

			let chatId = activeChatIdRef.current;

			if (!chatId) {
				try {
					const result =
						await createChatMutation.mutateAsync(message);
					chatId = result.chat.id;
					setActiveChatId(chatId);
					activeChatIdRef.current = chatId;
					if (selectedConversationMcpIds !== null) {
						const payload = buildChatToolSelectionPayload(
							selectedConversationMcpIds,
						);
						await orpcClient.ai.chats.tools.update({
							id: chatId,
							organizationId: organizationId ?? null,
							...payload,
						});
					}
					// Update URL with conversation ID (like Dust's getConversationRoute)
					router.replace(`${basePath}/nexus?c=${chatId}`, {
						scroll: false,
					});
				} catch (e) {
					console.error("Failed to create chat:", e);
				}
			}

			if (!chatId) {
				// Settle the chips before leaving. This return runs before the
				// upload loop, so without it every queued attachment sits at
				// `pending` forever: nothing further reports on them, and the
				// composer only clears once everything has settled.
				for (let index = 0; index < files.length; index++) {
					onAttachmentOutcome?.(index, {
						status: "error",
						error: "Couldn't start the chat, so this file wasn't uploaded.",
					});
				}
				toast.error("Failed to initialize chat.");
				return;
			}

			const attachedDocumentIds: string[] = [];
			// Nexus discarded `process()`'s return value, so a file's text
			// reached the model only if retrieval happened to surface a chunk
			// of it. These are the finished envelope entries, delivered whole
			// beside the identifiers that still drive that retrieval.
			const inlineAttachmentContexts: string[] = [];
			if (files.length > 0) {
				for (const [fileIndex, file] of files.entries()) {
					try {
						onAttachmentOutcome?.(fileIndex, {
							status: "uploading",
						});
						const mimeType =
							file.type ||
							inferMimeTypeFromFilename(file.name) ||
							"application/octet-stream";
						const { documentId, signedUploadUrl, useServerUpload } =
							await orpcClient.ai.documents.createUploadUrl({
								chatId,
								organizationId: organizationId ?? null,
								filename: file.name,
								mimeType,
								size: file.size,
							});

						if (signedUploadUrl) {
							const uploadResponse = await fetch(
								signedUploadUrl,
								{
									method: "PUT",
									body: file,
									headers: {
										"Content-Type": mimeType,
									},
								},
							);
							if (!uploadResponse.ok) {
								throw new Error(
									`Upload failed with status ${uploadResponse.status}`,
								);
							}
						} else if (useServerUpload) {
							const arrayBuffer = await file.arrayBuffer();
							const base64 = btoa(
								new Uint8Array(arrayBuffer).reduce(
									(data, byte) =>
										data + String.fromCharCode(byte),
									"",
								),
							);
							await orpcClient.ai.documents.upload({
								documentId,
								fileData: base64,
								mimeType,
							});
						} else {
							throw new Error("No upload method available");
						}

						onAttachmentOutcome?.(fileIndex, {
							status: "processing",
						});
						const processed = await orpcClient.ai.documents.process(
							{
								documentId,
							},
						);
						// The outcome reaches the chip, which is the only place
						// a truncated read or a workbook with no readable text
						// is ever said out loud on this surface.
						onAttachmentOutcome?.(fileIndex, {
							status: "ready",
							extraction: processed?.extraction,
						});
						attachedDocumentIds.push(documentId);
						// `process` already bounds what it returns, so no
						// second budget is applied here.
						inlineAttachmentContexts.push(
							buildAiChatAttachmentEntry(
								file.name,
								processed?.extractedContent ?? "",
							),
						);
					} catch (error) {
						console.error("[Nexus] File upload failed:", error);
						const reason =
							error instanceof Error
								? error.message
								: "Upload failed";
						onAttachmentOutcome?.(fileIndex, {
							status: "error",
							error: reason,
						});
						toast.error(
							`Failed to upload "${file.name}". Please verify file type/size and try again.`,
						);
					}
				}

				if (attachedDocumentIds.length === 0) {
					toast.error("No documents were uploaded.");
					return;
				}

				const allReady = await waitForDocumentsReady(
					chatId,
					attachedDocumentIds,
				);
				if (!allReady) {
					// The upload and the extraction call both succeeded, so
					// every chip is sitting at `ready` — but the readiness poll
					// says processing did not finish. Leaving them green would
					// have the chip claim success while the toast reports
					// failure, which is the exact contradiction R10 forbids.
					for (let index = 0; index < files.length; index++) {
						onAttachmentOutcome?.(index, {
							status: "error",
							error: "This file didn't finish processing.",
						});
					}
					toast.error(
						"One or more documents failed to process. Please try a different file.",
					);
					return;
				}
			}

			setHasStarted(true);

			// Handle history chat continuation
			let priorMessages = priorHistoryMessagesRef.current;
			if (historyChat && multiAgent.turns.length === 0) {
				priorHistoryMessagesRef.current = historyChat.messages.filter(
					(m) =>
						(m.role === "user" || m.role === "assistant") &&
						m.content?.trim(),
				);
				priorMessages = priorHistoryMessagesRef.current;
				setHistoryChat(null);
			}

			// Use selected agents, or the default built-in assistant if none selected
			const agentsToUse =
				selectedAgents.length > 0
					? selectedAgents
					: [
							{
								agentId: "default",
								name: DEFAULT_AI_AGENT_NAME,
								description: "A helpful AI assistant",
							},
						];

			const capabilityExecutionOptions =
				buildCapabilityExecutionOptions({
					selectedCapabilities,
					selectedAgents: agentsToUse,
					integrations: workflowIntegrationsData,
				}) ?? {};
			if (attachedDocumentIds.length > 0) {
				capabilityExecutionOptions.attachedDocumentIds =
					attachedDocumentIds;
				if (inlineAttachmentContexts.length > 0) {
					capabilityExecutionOptions.inlineAttachmentContexts =
						inlineAttachmentContexts;
				}
				capabilityExecutionOptions.chatId = chatId;
				// Display-only filenames for the user-bubble caption (the
				// agent reads attachments via `attachedDocumentIds`, not
				// this list). Mirrors the `attachmentNames` plumbing on
				// the Fabric Agent panel (FabricDirectChat) and the
				// `[Attached: …]` line `CopilotUserMessage` parses out.
				const namesFromUploads = files
					.map((f) => f.name)
					.filter((name): name is string => Boolean(name));
				if (namesFromUploads.length > 0) {
					capabilityExecutionOptions.attachmentNames =
						namesFromUploads;
				}
			}
			if (selectedConversationMcpIds !== null) {
				const existingMcpIds =
					capabilityExecutionOptions.enabledMcpConfigIds ?? [];
				const mergedMcpIds = [
					...new Set([
						...existingMcpIds,
						...selectedConversationMcpIds,
					]),
				];
				capabilityExecutionOptions.enabledMcpConfigIds = mergedMcpIds;
			}

			// CopilotPage hosts the Nexus surface. Tag the stream so the
			// orchestrator's surface-aware routing helper
			// (`applyDefaultMcpEagerRouting`) fires for any surface in
			// `TEMPORAL_ROUTED_SURFACES`. The CopilotSidebar path uses a
			// different factory that explicitly sets `surface: "copilot"` —
			// see `default-mcp-eager-routing.test.ts` scenario 3 for the
			// regression guard.
			capabilityExecutionOptions.surface = "nexus";
			if (organizationSlug) {
				capabilityExecutionOptions.organizationSlug = organizationSlug;
			}

			if (chatId) {
				void persistChatMessages(
					chatId,
					buildMessagesIncludingPendingUserTurn(message),
					{ invalidate: true },
				).catch(console.error);
			}

			multiAgent.sendToAgents(
				message,
				agentsToUse,
				(agent) =>
					buildAgentScopedHistory({
						agent,
						priorMessages,
						activeTurns: multiAgent.turns,
					}),
				Object.keys(capabilityExecutionOptions).length > 0
					? capabilityExecutionOptions
					: undefined,
			);

			// Persistence is now handled at pick/unpick time inside
			// `handleToggleAgent` / `handleRemoveAgent`, so we no longer write
			// from the send path. Doing it here was a footgun: the user's
			// "remembered selection" only became durable after a successful
			// send, which meant picking an agent and reloading without sending
			// silently lost the choice and the next send fell back to the
			// orchestrator's default model. Picker state is now the source of
			// truth in BOTH directions — what you click is what gets stored.
		},
		[
			selectedConversationMcpIds,
			multiAgent,
			createChatMutation,
			historyChat,
			router,
			basePath,
			organizationId,
			organizationSlug,
			selectedCapabilities,
			workflowIntegrationsData,
			persistChatMessages,
			buildMessagesIncludingPendingUserTurn,
			waitForDocumentsReady,
			selectedAgents,
		],
	);

	const handleNewConversation = useCallback(() => {
		multiAgent.reset();
		setHasStarted(false);
		setActiveChatId(null);
		// Restore the user's persistent default agent selection instead of
		// clearing the picker. Without this, clicking "New thread" after
		// hydration drops the picker back to empty even though the user has
		// a saved default — which is surprising because fresh page load
		// (no `?c=...`) DOES seed the persisted default. Mirrors the Loom
		// fix from PR #827. We read from the already-cached `useQuery`
		// result so this is synchronous from the button's perspective. We
		// do NOT call `persistMutation` because we're restoring to the
		// stored value — there's nothing new to persist.
		const persisted = persistenceQuery.data;
		const defaultAgents =
			persisted?.exists && persisted.selectedAgents.length > 0
				? persisted.selectedAgents
				: [];
		// Update the ref synchronously so an immediately-following pick
		// click reads the post-reset value, not the pre-reset chat agents.
		// (The sync useEffect would catch up on the next render, but a
		// click in the same event-loop tick would otherwise race.)
		selectedAgentsRef.current = defaultAgents as SelectedAgent[];
		setSelectedAgents(defaultAgents);
		setSelectedCapabilities([]);
		setSelectedConversationMcpIds(null);
		activeChatIdRef.current = null;
		setHistoryChat(null);
		priorHistoryMessagesRef.current = [];
		lastPersistedSnapshotRef.current = null;
		// Clear conversation ID from URL
		router.replace(`${basePath}/nexus`, { scroll: false });
	}, [multiAgent, router, basePath, persistenceQuery.data]);

	const handleSelectChat = useCallback(
		(chatId: string) => {
			const chat = allChats.find((c) => c.id === chatId);
			if (!chat) {
				return;
			}

			if (chatId === activeChatId && hasStarted && !historyChat) {
				return;
			}
			activateChatFromHistory(chat);
			// Update URL with selected conversation ID
			router.replace(`${basePath}/nexus?c=${chatId}`, {
				scroll: false,
			});
		},
		[
			activateChatFromHistory,
			allChats,
			activeChatId,
			hasStarted,
			historyChat,
			router,
			basePath,
		],
	);

	const handleDeleteChat = useCallback(
		async (chatId: string) => {
			await deleteChatMutation.mutateAsync(chatId);
			if (activeChatId === chatId) {
				handleNewConversation();
			}
		},
		[deleteChatMutation, activeChatId, handleNewConversation],
	);

	const handleToggleAgent = useCallback(
		(agent: SelectedAgent) => {
			// If the agent carries raw provider names, resolve them to IDs now
			// that we have workflowIntegrationsData available
			let resolvedAgent = agent;
			if (
				agent.enabledIntegrationProviders &&
				agent.enabledIntegrationProviders.length > 0
			) {
				const resolvedIds = agent.enabledIntegrationProviders.flatMap(
					(provider) =>
						workflowIntegrationsData
							.filter(
								(i) => i.isActive && i.provider === provider,
							)
							.map((i) => i.id),
				);
				resolvedAgent = {
					...agent,
					enabledIntegrationIds:
						resolvedIds.length > 0 ? resolvedIds : undefined,
					enabledIntegrationProviders: undefined,
				};
			}
			// Read from the ref, NOT the `selectedAgents` closure — rapid
			// clicks within a single render cycle would all see the same
			// stale closure value and each compute a 1-item `next`, losing
			// the prior picks. The ref is updated synchronously below, so
			// click N+1 sees click N's result even before React re-renders.
			const current = selectedAgentsRef.current;
			const exists = current.find(
				(a) => a.agentId === resolvedAgent.agentId,
			);
			const next = exists
				? current.filter((a) => a.agentId !== resolvedAgent.agentId)
				: [...current, resolvedAgent];
			selectedAgentsRef.current = next;
			setSelectedAgents(next);
			// Serialized persist via `firePersistAgentSelection` — only ONE
			// request in flight at a time, the LATEST state is queued for
			// after current settle. Replaces direct `persistMutation.mutate`
			// which fired N parallel POSTs whose response order was
			// non-deterministic; the staging repro showed UI:[] but
			// DB:[Gemini] (one of the intermediate states won the race).
			firePersistAgentSelection(persistSelectionShape(next));
		},
		[workflowIntegrationsData, firePersistAgentSelection],
	);

	const handleRemoveAgent = useCallback(
		(agentId: string) => {
			// Mirror handleToggleAgent — read from ref, update it
			// synchronously, setState, fire serialized persist. When
			// `next` is empty, persisting `[]` causes the read-side
			// validator's empty-cleanup path to delete the row, so the
			// next reload returns to the first-run path (Decision 4 —
			// empty picker is the canonical first-run UX).
			const next = selectedAgentsRef.current.filter(
				(a) => a.agentId !== agentId,
			);
			selectedAgentsRef.current = next;
			setSelectedAgents(next);
			firePersistAgentSelection(persistSelectionShape(next));
		},
		[firePersistAgentSelection],
	);

	const handleToggleCapability = useCallback((cap: CapabilityItem) => {
		setSelectedCapabilities((prev) => {
			const exists = prev.find((c) => c.id === cap.id);
			if (exists) {
				return prev.filter((c) => c.id !== cap.id);
			}
			return [...prev, cap];
		});
	}, []);

	const handleRemoveCapability = useCallback((capId: string) => {
		setSelectedCapabilities((prev) => prev.filter((c) => c.id !== capId));
	}, []);

	const handleConversationToolChange = useCallback(
		(nextIds: string[] | null) => {
			setSelectedConversationMcpIds(nextIds);

			if (!activeChatId) {
				return;
			}

			void updateChatToolsMutation.mutateAsync({
				...buildChatToolSelectionPayload(nextIds),
			});
		},
		[activeChatId, updateChatToolsMutation],
	);

	// ── Layout ────────────────────────────────────────────────────────────────

	const showHistoryView = !!historyChat && !hasStarted;
	const historyTurns = useMemo(
		() => (historyChat ? buildTurnsFromHistory(historyChat.messages) : []),
		[historyChat],
	);
	const conversationTurns = showHistoryView ? historyTurns : multiAgent.turns;
	const showConversationView = showHistoryView || hasStarted;
	const isConversationLoading = hasStarted ? multiAgent.isLoading : false;

	return (
		<div className="flex h-full overflow-hidden bg-background">
			{/* Left sidebar: chat history */}
			<div
				className={cn(
					"relative hidden shrink-0 overflow-visible transition-[width] duration-200 ease-out md:flex",
					isHistorySidebarCollapsed
						? "md:w-0"
						: "md:w-[224px] xl:w-[256px]",
				)}
			>
				<div
					className={cn(
						"h-full overflow-hidden bg-background transition-opacity duration-150",
						isHistorySidebarCollapsed
							? "pointer-events-none w-0 opacity-0"
							: "w-full border-r border-border/70 opacity-100",
					)}
				>
					{!isHistorySidebarCollapsed && (
						<ChatHistorySidebar
							chats={allChats}
							activeChatId={activeChatId}
							isLoading={chatListQuery.isLoading}
							hasNextPage={!!chatListQuery.hasNextPage}
							isFetchingNextPage={
								chatListQuery.isFetchingNextPage
							}
							onSelectChat={handleSelectChat}
							onDeleteChat={handleDeleteChat}
							onNewChat={handleNewConversation}
							loadMoreRef={loadMoreRef}
						/>
					)}
				</div>
				<SidebarEdgeHandle
					isExpanded={!isHistorySidebarCollapsed}
					onClick={() =>
						setIsHistorySidebarCollapsed((current) => !current)
					}
					expandLabel="Expand conversation history"
					collapseLabel="Collapse conversation history"
					collapsedClassName="left-0 z-40 -translate-x-1/2"
				/>
			</div>

			{/* Main content */}
			<div className="flex-1 min-w-0 overflow-hidden">
				{showConversationView ? (
					<ConversationView
						turns={conversationTurns}
						isLoading={isConversationLoading}
						onSend={handleSend}
						onStop={handleStopAllFromButton}
						onNew={handleNewConversation}
						selectedAgents={selectedAgents}
						onRemoveAgent={handleRemoveAgent}
						onOpenAgentPicker={() => setAgentPickerOpen(true)}
						onToggleAgent={handleToggleAgent}
						organizationId={organizationId}
						organizationSlug={organizationSlug}
						selectedCapabilities={selectedCapabilities}
						onToggleCapability={handleToggleCapability}
						onRemoveCapability={handleRemoveCapability}
						selectedConversationMcpIds={selectedConversationMcpIds}
						onOpenConversationToolPicker={() =>
							setConversationToolPickerOpen(true)
						}
					/>
				) : (
					<LandingView
						firstName={firstName}
						selectedAgents={selectedAgents}
						onToggleAgent={handleToggleAgent}
						onRemoveAgent={handleRemoveAgent}
						onOpenAgentPicker={() => setAgentPickerOpen(true)}
						onSend={handleSend}
						organizationId={organizationId}
						selectedCapabilities={selectedCapabilities}
						onToggleCapability={handleToggleCapability}
						onRemoveCapability={handleRemoveCapability}
						selectedConversationMcpIds={selectedConversationMcpIds}
						onOpenConversationToolPicker={() =>
							setConversationToolPickerOpen(true)
						}
					/>
				)}
			</div>

			{/* Agent picker dialog */}
			<AgentPickerDialog
				open={agentPickerOpen}
				onClose={() => setAgentPickerOpen(false)}
				organizationId={organizationId}
				selectedAgentIds={selectedAgents.map((a) => a.agentId)}
				onToggle={handleToggleAgent}
			/>
			<ConversationToolPicker
				open={conversationToolPickerOpen}
				onOpenChange={setConversationToolPickerOpen}
				organizationId={organizationId ?? undefined}
				selectedIds={selectedConversationMcpIds}
				onChange={handleConversationToolChange}
			/>
		</div>
	);
}
