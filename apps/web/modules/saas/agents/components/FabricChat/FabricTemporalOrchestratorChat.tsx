"use client";

/**
 * FabricTemporalOrchestratorChat - Temporal-based orchestrator chat component
 *
 * This component uses the durable Temporal orchestrator workflow for:
 * - Multi-agent task execution
 * - HITL approval flows
 * - Task plan visualization
 * - Progress tracking
 *
 * Based on CUGA architecture with Fabric-specific enhancements.
 */

import type { TaskPlan } from "@repo/temporal";
import {
	AI_CHAT_IMAGE_MIME_TYPES,
	AI_CHAT_SERVER_ALLOWED_EXTENSIONS,
	AI_CHAT_SERVER_ONLY_MIME_TYPES,
	buildAiChatAcceptAttribute,
	buildAiChatAttachmentEntry,
	DEFAULT_AI_CHAT_MAX_FILE_BYTES,
	DEFAULT_AI_CHAT_MIME_ALLOWLIST,
	isClientRenderableAiChatImage,
} from "@repo/utils/ai-chat-attachment";
import { StoppedIndicator } from "@saas/agents/components/StoppedIndicator";
import { LimitBanner } from "@saas/ai/components/shared/LimitBanner";
import { useSession } from "@saas/auth/hooks/use-session";
import type { FrameToolResult } from "@saas/frames/lib/frame-result";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
// F2 (spec § 8.1 / § 22.1) — chat → editor auto-insert button. Rendered
// as a sibling below each `<McpAppFrame>` for successful Excalidraw
// `create_view` tool results. Loom has no on-page editor, so the
// resolver falls to the picker path (spec FR-7) — that's handled by
// `ChatMessageInsertDiagramButton` itself; we only need to wire the
// chat-scope and per-tool-call envelope here.
import { ChatMessageInsertDiagramButton } from "@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton";
import { deriveDiagramTitle } from "@saas/projects/components/excalidraw-auto-insert/deriveDiagramTitle";
import { useActiveTipTapEditor } from "@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor";
import {
	type ChatScope,
	useChatScopedProjectFromOrchestratorStream,
} from "@saas/projects/components/excalidraw-auto-insert/useChatScopedProject";
import type { InsertDiagramToolResult } from "@saas/projects/components/excalidraw-auto-insert/useInsertDiagramAction";
import { prepareImageForAi } from "@saas/projects/lib/image-upload-utils";
import { ClarifyingQuestionCard } from "@saas/shared/components/copilot/ClarifyingQuestionCard";
import { CopilotSidebarAttachments } from "@saas/shared/components/copilot/CopilotSidebarAttachments";
import type { AttachedFile as CopilotAttachedFile } from "@saas/shared/components/copilot/use-copilot-document-upload";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircle,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	Loader2,
	NotebookPen,
	ScrollText,
	Search,
	SquareCheckBig,
	Wrench,
	XIcon,
} from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import {
	type ChangeEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
// AI Elements for consistent UI rendering
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "../../../../../components/ai-elements/conversation";
import {
	McpAppFrame,
	prefetchMcpAppHtml,
} from "../../../../../components/ai-elements/McpAppFrame";
import {
	Message,
	MessageAvatar,
	MessageContent,
} from "../../../../../components/ai-elements/message";
import {
	Plan,
	type PlanStep,
	type PlanStepStatus,
} from "../../../../../components/ai-elements/plan";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "../../../../../components/ai-elements/reasoning";
import { Response } from "../../../../../components/ai-elements/response";
import { generateMessageId } from "../../hooks/useConversationHistory";
import { useEscToStopOrClose } from "../../hooks/useEscToStopOrClose";
import {
	createExecutionRecord,
	type OrchestratorExecution,
	useOrchestratorConversation,
} from "../../hooks/useOrchestratorConversation";
import { useOrchestratorStream } from "../../hooks/useOrchestratorStream";
import {
	getSelectedOrchestratorToolIds,
	mergeOrchestratorConversationMetadata,
} from "../../lib/orchestrator-conversation-tools";
// CUGA-specific components
import { type CugaExecutionState, CugaExecutionView } from "../cuga";
import { CarriedOverContextBanner } from "./CarriedOverContextBanner";
import { ContextCompactionNotice } from "./ContextCompactionNotice";
import { ConversationHandoffCard } from "./ConversationHandoffCard";
import { ConversationToolPicker } from "./ConversationToolPicker";
import { ChartCard, isChartArtifact } from "./cards/ChartCard";
// Extracted orchestrator components
import {
	ActiveContextIndicator,
	AGENT_DISPLAY_INFO,
	ApprovalDialog,
	// Artifacts panel
	ArtifactsPanel,
	ArtifactsPanelTrigger,
	type CompletedExecution,
	// Connection dialog for MCP servers
	ConnectionRequiredDialog,
	type DocumentArtifact,
	type FabricTemporalOrchestratorChatProps,
	getToolInputSummary,
	hasDocumentArtifacts,
	// Memory panel
	MemoryPanel,
	MemoryPanelTrigger,
	// Phase indicator for sticky status display
	PhaseIndicator,
	// Planning transparency & visualization
	REASONING_TO_EXECUTION,
	type SourceReference,
	type TemporalOrchestratorActivityState,
} from "./orchestrator";
import {
	AgentModelPicker,
	ChatInput,
	ChatWelcome,
	getLatestSuccessfulFrameFromGroups,
	getLatestSuccessfulFrameToolResult,
	InteractiveContentPanel,
	type SelectedAgent,
	type ToolCallItem,
	ToolCallList,
} from "./shared";

// Re-export types for external consumers
export type { TemporalOrchestratorActivityState };

/** Convert a storage path to a proxy URL, or pass through if already a URL.
 *  Includes orgId for XOR tenant isolation when in organization context. */
function storagePathToProxyUrl(
	pathOrUrl: string,
	organizationId?: string | null,
): string {
	if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
		return pathOrUrl;
	}
	const orgParam = organizationId
		? `&orgId=${encodeURIComponent(organizationId)}`
		: "";
	return `/api/storage/image?path=${encodeURIComponent(pathOrUrl)}${orgParam}`;
}

const ASSISTANT_RESPONSE_SHELL_CLASSNAME =
	"rounded-[1.4rem] border border-border/60 bg-background/75 px-4 py-3 shadow-[0_18px_50px_-28px_hsl(var(--foreground)/0.55)] backdrop-blur-md supports-[backdrop-filter]:bg-background/55";

function stripPersistedAssistantLabelPrefix(content?: string): string {
	if (!content) {
		return "";
	}

	return content.replace(/^\[[^\]]+\]:\s*/, "");
}

/**
 * Composer-collected document record. The shared `CopilotAttachedFile` carries
 * the upload status + extraction outcome (so a chip can show a truncated or
 * unreadable read); `contextEntry` is the one local addition — the finished
 * attachment envelope for this file (built by the shared builder), held on the
 * record so removing the chip removes its content too. Mirrors Loom Direct's
 * `AttachedFile`.
 */
type AttachedFile = CopilotAttachedFile & {
	contextEntry?: string;
};

/**
 * What the Orchestrator paperclip advertises — documents plus the full image
 * set including TIFF, derived from the shared vocabulary rather than written
 * out (the accept vs. validate rule: one source for both). Identical to Loom
 * Direct's `LOOM_FILE_ACCEPT`; Loom runs no canvas compression step, so it
 * advertises the server-only image types too.
 */
const LOOM_ORCHESTRATOR_FILE_ACCEPT = buildAiChatAcceptAttribute([
	...AI_CHAT_IMAGE_MIME_TYPES,
	...AI_CHAT_SERVER_ONLY_MIME_TYPES,
]);

export function FabricTemporalOrchestratorChat({
	organizationId,
	reasoningMode,
	welcomeMode = "default",
	lockConversationToolPicker = false,
	activeConversation,
	activeConversationId,
	onConversationSaved,
	onConversationCreated,
	enabledToolIds = null,
	enabledAgentIds = null,
	enabledFabricToolIds = null,
	enabledIntegrationIds = null,
	prioritizedToolIds,
	prioritizedAgentIds,
	prioritizedMcpConfigIds,
	prioritizedIntegrationIds,
	onToolPrioritize,
	onAgentPrioritize,
	onMcpPrioritize,
	onIntegrationPrioritize,
	onActivityChange,
	onUsageChange: _onUsageChange, // TODO: Implement usage tracking for Temporal orchestrator
	agentId: _agentId = "fabric-ai",
	agentName: _agentName = "Fabric Loom",
	agentDescription:
		_agentDescription = "Durable multi-agent orchestration powered by Temporal.",
	attachedWorkspaceIds,
	attachedDocumentIds,
	attachedProjectId: propAttachedProjectId,
	systemPrompt,
	instanceId,
	showAgentPicker = false,
	starterMessages: agentStarterMessages,
	initialInput,
	sessionTemplates,
	onSessionTemplatesChange,
	onEscClose,
}: FabricTemporalOrchestratorChatProps) {
	const { user } = useSession();
	const tooltipT = useTranslations("tooltips.agents");
	const userAvatarSrc = user?.image ?? "";
	const userDisplayName = user?.name ?? user?.email ?? "Me";
	const { activeOrganization, isOrganizationAdmin } = useActiveOrganization();
	const canManageBilling = activeOrganization ? isOrganizationAdmin : true;
	const organizationSlug = activeOrganization?.slug ?? null;

	const [input, setInput] = useState(initialInput ?? "");
	const [completedExecutions, setCompletedExecutions] = useState<
		CompletedExecution[]
	>([]);
	// Template mention state
	const [templateInstructions, setTemplateInstructions] = useState<
		string | null
	>(null);
	const [templateIntegrationIds, setTemplateIntegrationIds] = useState<
		string[]
	>([]);
	const [templateMcpConfigIds, setTemplateMcpConfigIds] = useState<string[]>(
		[],
	);
	const [templateFabricToolIds, setTemplateFabricToolIds] = useState<
		string[]
	>([]);
	const [conversationId, setConversationId] = useState<string | null>(
		activeConversationId || null,
	);
	// Track attached project ID for project context retrieval
	const [attachedProjectId, setAttachedProjectId] = useState<string | null>(
		propAttachedProjectId ?? null,
	);
	// Track if component has mounted (for hydration-safe rendering)
	const [hasMounted, setHasMounted] = useState(false);
	const [activeFrame, setActiveFrame] = useState<FrameToolResult | null>(
		null,
	);
	const [lastFrame, setLastFrame] = useState<FrameToolResult | null>(null);
	const lastAutoOpenedFrameIdRef = useRef<string | null>(null);

	const openFrame = (frame: FrameToolResult | null) => {
		setActiveFrame(frame);
		if (frame) {
			setLastFrame(frame);
		}
	};
	// Artifacts panel state
	const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false);
	// Memory panel state
	const [isMemoryPanelOpen, setIsMemoryPanelOpen] = useState(false);
	// Connection required dialog state
	const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(false);
	const [conversationToolPickerOpen, setConversationToolPickerOpen] =
		useState(false);
	const [selectedConversationMcpIds, setSelectedConversationMcpIds] =
		useState<string[] | null>(null);
	// Store pending message to retry after connection
	const pendingMessageRef = useRef<string | null>(null);
	const lastStepRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// Image lightbox state
	const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(
		null,
	);
	useEffect(() => {
		if (!lightboxImageUrl) {
			return;
		}
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setLightboxImageUrl(null);
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [lightboxImageUrl]);

	// Image attachment state
	const [attachedImages, setAttachedImages] = useState<
		Array<{
			id: string;
			file: File;
			name: string;
			previewUrl: string;
			uploadedUrl?: string;
			/** S3 storage path - used for stable proxy URLs and passed to workflows */
			storagePath?: string;
			status: "pending" | "uploading" | "ready" | "error";
		}>
	>([]);
	// Document attachment state — a separate queue from images. Images feed the
	// multimodal-vision pipeline (upload-image → storagePath); documents feed
	// RAG + inline extracted text (createUploadUrl → process). One paperclip
	// fills both, split by MIME on selection.
	const [attachedDocuments, setAttachedDocuments] = useState<AttachedFile[]>(
		[],
	);
	// Chat ID that documents are stored under, for RAG retrieval across
	// follow-ups. Assigned by `createUploadUrl` on the first upload.
	const [currentDocumentChatId, setCurrentDocumentChatId] = useState<
		string | null
	>(null);
	// One hidden input behind the paperclip; `accept` offers images + documents.
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Set mounted state after hydration
	useEffect(() => {
		setHasMounted(true);
	}, []);

	// Track previous conversation ID to detect actual changes vs. refetches
	const prevConversationIdRef = useRef<string | null>(null);
	// Track which conversation has been hydrated to avoid re-hydrating on refetch
	const hydratedConversationRef = useRef<string | null>(null);
	// Track if we created a conversation in the current session (since activeConversationId was cleared)
	// This helps distinguish "parent cleared for new chat" from "parent hasn't updated prop yet"
	const createdConversationInSessionRef = useRef<boolean>(false);

	// Orchestrator conversation hook for full execution history persistence
	const {
		createConversation: createOrchestratorConversation,
		saveExecution,
		convertStepResults,
	} = useOrchestratorConversation({
		organizationId,
		executionMode: reasoningMode,
		instanceId,
	});

	// Track current execution record for updates
	const currentExecutionRef = useRef<OrchestratorExecution | null>(null);
	const approvalHistoryRef = useRef<OrchestratorExecution["approvalHistory"]>(
		[],
	);

	// Use ref for onActivityChange to avoid infinite loops when parent doesn't memoize the callback
	const onActivityChangeRef = useRef(onActivityChange);
	onActivityChangeRef.current = onActivityChange;

	// Stop-failure toast — fires when the fire-and-forget cancel POST
	// returns a non-2xx response. Visual state is NOT reverted (decision
	// 11 / AC-10); the user keeps the optimistic "Stopped" view and we
	// only surface a non-blocking note that trailing tokens may arrive.
	// Copy audited against fabric/standards/ai/ai-copy-tone.md — task 4.1.
	const handleStopFailed = useCallback(() => {
		toast.message(
			"Couldn't fully stop the response. Trailing tokens may still arrive.",
		);
	}, []);

	// Model selection for the orchestrator's own reasoning (#2040).
	//
	// Shares the store `FabricDirectChat` writes to, so a choice made on either
	// engine follows the user to the other — the point of consolidating the
	// surfaces. Only `modelOverride` is applied here: a registered agent also
	// carries `instructions`, and letting those replace the orchestrator's
	// system prompt would disable the planning, delegation and clarification
	// that make it an orchestrator rather than a direct chat.
	const [selectedAgent, setSelectedAgent] = useState<SelectedAgent | null>(
		null,
	);

	const agentSelectionQuery = useQuery({
		queryKey: ["chat-agent-selection", user?.id, organizationId ?? null],
		queryFn: async () => orpcClient.users.chatAgentSelection.get(),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: 1,
		enabled: Boolean(user?.id) && showAgentPicker,
	});

	const persistAgentSelection = useMutation({
		mutationFn: async (agents: SelectedAgent[]) =>
			orpcClient.users.chatAgentSelection.set({
				selectedAgents: agents.map((agent) => ({
					agentId: agent.agentId,
					name: agent.name,
					vendor: agent.vendor,
					modelOverride: agent.modelOverride,
					instanceId: agent.instanceId,
					description: agent.description,
					workspaceIds: agent.workspaceIds,
					enabledMcpConfigIds: agent.enabledMcpConfigIds,
					enabledIntegrationIds: agent.enabledIntegrationIds,
				})),
			}),
		onError: () => {
			toast.message("Couldn't save your model choice.", {
				description:
					"It applies to this chat, but may not be here next time.",
			});
		},
	});

	// Hydrate once. No FR13 "agent no longer available" notice here on purpose:
	// the server already drops unresolvable entries, and `FabricDirectChat`
	// reads the same store — announcing it from both engines would toast twice
	// for one fact.
	const agentSelectionHydratedRef = useRef(false);
	useEffect(() => {
		if (agentSelectionHydratedRef.current || !showAgentPicker) {
			return;
		}
		const data = agentSelectionQuery.data;
		if (!data) {
			return;
		}
		agentSelectionHydratedRef.current = true;
		const [first] = data.selectedAgents;
		const initial = first ?? data.defaultAgent;
		if (initial) {
			setSelectedAgent(initial as SelectedAgent);
		}
	}, [agentSelectionQuery.data, showAgentPicker]);

	const handleToggleAgent = useCallback(
		(agent: SelectedAgent) => {
			setSelectedAgent((current) => {
				const next = current?.agentId === agent.agentId ? null : agent;
				persistAgentSelection.mutate(next ? [next] : []);
				return next;
			});
		},
		[persistAgentSelection],
	);

	// Undefined for a registered agent, which carries no model of its own. The
	// run then resolves the workspace default exactly as it did before the
	// picker existed.
	const activeModelOverride = selectedAgent?.modelOverride;

	// Use the streaming orchestrator hook
	const {
		messages,
		isLoading,
		state,
		sendMessage,
		sendApproval,
		sendClarification,
		sendFollowUp,
		reset,
		isRunning,
		isAwaitingApproval,
		isComplete,
		isFollowUpEnabled,
		currentPhase,
		progressMessage,
		currentStep,
		completedSteps,
		totalSteps,
		stepResults,
		streamingToolCalls,
		planningAudit,
		artifacts,
		partykitStepProgress,
		stop: stopStream,
	} = useOrchestratorStream({
		organizationId,
		executionMode: REASONING_TO_EXECUTION[reasoningMode] || "balanced",
		enabledMcpConfigIds: selectedConversationMcpIds ?? enabledToolIds,
		enabledAgentIds: enabledAgentIds,
		enabledFabricToolIds: enabledFabricToolIds,
		enabledIntegrationIds: enabledIntegrationIds,
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		prioritizedIntegrationIds,
		workspaceIds: attachedWorkspaceIds,
		attachedDocumentIds,
		projectId: attachedProjectId,
		// Use the effective local conversation ID so embedded consumers like the
		// MCP try dialog keep follow-ups in the same thread even without a parent-
		// managed activeConversationId prop.
		conversationId,
		systemPrompt,
		instanceId,
		modelOverride: activeModelOverride,
		// Surface tag for the cancel telemetry event (spec § 10.1 /
		// task 3.3). Only consumer of `useOrchestratorStream` is the
		// standalone Loom Orchestrator chat, so the default applies.
		surface: "loom-orchestrator",
		onStopFailed: handleStopFailed,
	});

	// F2 — chat scope for the Excalidraw auto-insert
	// button. The Loom orchestrator carries `attachedProjectId` +
	// `organizationId` directly; the adapter walks the linear `messages`
	// array to derive `lastUserPromptForMessage`. The orchestrator's
	// surface tag is `"loom-orchestrator"` but the
	// telemetry / UI surface is `"loom"` — we pass the latter when
	// rendering the button.
	const excalidrawAutoInsertChatScope =
		useChatScopedProjectFromOrchestratorStream({
			projectId: attachedProjectId,
			organizationId: organizationId ?? null,
			messages,
		});

	// Stable `onStop` for ChatInput — wraps `stop()` with the `"button"`
	// trigger tag so cancel telemetry distinguishes the morph click from
	// the Esc keybinding.
	const handleStopFromButton = useCallback(() => {
		stopStream("button");
	}, [stopStream]);

	// Stable `onStop` for the shared Esc binding — tags telemetry as
	// `"esc"` so we can distinguish keypresses from morph clicks
	// (spec § 10.1, decision 9 / AC-7).
	const handleStopFromEsc = useCallback(() => {
		stopStream("esc");
	}, [stopStream]);

	// Esc-context binding. While a turn is in-flight or
	// paused on `pendingApproval`, Esc stops generation (AC-9 /
	// decision 20). While idle, Esc invokes `onEscClose` if the host
	// passed one — the standalone Loom Orchestrator page omits it so
	// Esc-while-idle is a no-op (AC-7).
	useEscToStopOrClose({
		isInFlight: isLoading || isAwaitingApproval,
		onStop: handleStopFromEsc,
		onClose: onEscClose,
	});

	// Debug: Log workspace IDs being passed to orchestrator
	useEffect(() => {
		console.log(
			"[OrchestratorChat] attachedWorkspaceIds:",
			attachedWorkspaceIds,
		);
	}, [attachedWorkspaceIds]);

	// Pre-fetch MCP App HTML when streaming tool calls arrive with a resourceUri.
	// This caches the widget HTML so the iframe loads instantly on mount,
	// enabling progressive streaming animations instead of a blank loading state.
	useEffect(() => {
		for (const tc of streamingToolCalls) {
			if (tc.mcpAppResourceUri && tc.mcpAppConfigId) {
				prefetchMcpAppHtml(
					tc.mcpAppConfigId,
					tc.mcpAppResourceUri,
					organizationId,
				);
			}
		}
	}, [streamingToolCalls, organizationId]);

	// Reset the active frame panel when the conversation changes (e.g. "+ New")
	useEffect(() => {
		setActiveFrame(null);
		setLastFrame(null);
		lastAutoOpenedFrameIdRef.current = null;
	}, [conversationId]);

	useEffect(() => {
		const latestStreamingFrame =
			getLatestSuccessfulFrameToolResult(streamingToolCalls);
		const latestCompletedFrame = getLatestSuccessfulFrameFromGroups(
			completedExecutions.flatMap((execution) =>
				execution.stepResults.map((result) => result.toolCalls),
			),
		);
		// Also check the live stepResults from the current execution —
		// completedExecutions is only updated on the NEXT message send, so
		// the current execution's results must be read from stepResults directly.
		const latestStepFrame = getLatestSuccessfulFrameFromGroups(
			stepResults.map((sr) => sr.toolCalls),
		);
		const latestFrame =
			latestStreamingFrame ?? latestStepFrame ?? latestCompletedFrame;
		if (!latestFrame) {
			return;
		}
		if (lastAutoOpenedFrameIdRef.current === latestFrame.frameId) {
			return;
		}
		lastAutoOpenedFrameIdRef.current = latestFrame.frameId;
		openFrame(latestFrame);
	}, [completedExecutions, streamingToolCalls, stepResults]);

	// Fetch attached project when conversationId changes
	const { data: conversationProjectData } = useQuery({
		...orpc.projects.conversations.getProject.queryOptions({
			input: {
				conversationId: conversationId || "",
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!conversationId,
	});

	// Fetch full conversation row to read carriedOverSummary for the
	// "continued from" banner. Cheap — already paginated by id.
	const { data: conversationData } = useQuery({
		queryKey: [
			"orchestrator-conversation-meta",
			conversationId,
			organizationId,
		],
		queryFn: async () => {
			if (!conversationId) {
				return null;
			}
			return await orpcClient.agents.conversations.get({
				id: conversationId,
				organizationId: organizationId ?? null,
			});
		},
		enabled: !!conversationId,
		staleTime: 30_000,
	});

	// Sync attached project from parent prop (pre-conversation selection)
	useEffect(() => {
		if (propAttachedProjectId !== undefined) {
			setAttachedProjectId(propAttachedProjectId ?? null);
		}
	}, [propAttachedProjectId]);

	// Sync attached project from conversation data (DB-persisted)
	// Only override if there's no parent prop selection (parent prop takes priority)
	useEffect(() => {
		if (
			propAttachedProjectId !== undefined &&
			propAttachedProjectId !== null
		) {
			// Parent prop is set — don't let DB query override it
			return;
		}
		if (conversationProjectData?.project) {
			setAttachedProjectId(conversationProjectData.project.id);
		} else if (
			conversationProjectData &&
			!conversationProjectData.project
		) {
			setAttachedProjectId(null);
		}
	}, [conversationProjectData, propAttachedProjectId]);

	// Combine SSE currentStep with PartyKit step progress for real-time updates
	// PartyKit often sends step info before SSE catches up, so use it as fallback
	const effectiveCurrentStep = useMemo(() => {
		// If SSE has a current step, prefer it (more structured)
		if (currentStep) {
			return currentStep;
		}

		// Fall back to PartyKit step progress when SSE hasn't caught up yet
		if (partykitStepProgress && isRunning) {
			return {
				id: partykitStepProgress.stepId,
				description:
					partykitStepProgress.stepDescription ||
					partykitStepProgress.message ||
					"Processing...",
				type: "agent" as const,
				order: partykitStepProgress.stepIndex ?? 0,
				status: "in_progress" as const,
			};
		}

		return null;
	}, [currentStep, partykitStepProgress, isRunning]);

	// Convert planning audit sources to SourceReference format for ArtifactsPanel
	const artifactSources = useMemo((): SourceReference[] => {
		// Map source types from planning audit to artifact source types
		const sourceTypeMap: Record<string, SourceReference["type"]> = {
			workspace_rag: "workspace",
			semantic_memory: "memory",
			letta_memory: "memory",
			trajectory_reuse: "memory",
			negative_memory: "memory",
			web_research: "web",
			mcp_tool_discovery: "code",
			agent_capabilities: "code",
			policy_enrichment: "document",
			user_input: "document",
		};

		// Get sources from current execution (if planning audit available)
		const currentSources = planningAudit?.sourcesUsed || [];

		// Get sources from completed executions (for persistence across refresh)
		const completedSources = completedExecutions.flatMap(
			(exec) => exec.sourcesUsed || [],
		);

		// Combine and dedupe
		const allSources = [
			...new Set([...currentSources, ...completedSources]),
		];

		return allSources.map((source, idx) => ({
			id: `source-${idx}`,
			title: source,
			type:
				sourceTypeMap[source.toLowerCase().replace(/ /g, "_")] ||
				"document",
		}));
	}, [planningAudit, completedExecutions]);

	// Convert workflow artifacts to DocumentArtifact format for ArtifactsPanel
	const documentArtifacts = useMemo((): DocumentArtifact[] => {
		// Combine current execution artifacts with completed execution artifacts
		const allArtifacts = [
			...(artifacts || []),
			// Include artifacts from completed executions (for persistence across refresh)
			...completedExecutions.flatMap((exec) => exec.artifacts || []),
		];

		if (allArtifacts.length === 0) {
			return [];
		}

		// Filter to document-like artifacts (documents, code, data, tool_result)
		// Only include artifacts with substantial content
		// Use a Set to dedupe by ID
		const seen = new Set<string>();
		return allArtifacts
			.filter((a) => {
				if (seen.has(a.id)) {
					return false;
				}
				seen.add(a.id);
				return (
					(a.type === "document" ||
						a.type === "code" ||
						a.type === "data" ||
						a.type === "tool_result") &&
					a.content &&
					a.content.length > 100
				);
			})
			.map((a) => {
				// Detect document type from content and metadata
				let docType: "markdown" | "html" | "code" | "json" | "text" =
					"text";
				const content = a.content || "";
				const format = a.metadata?.format as string | undefined;

				if (a.type === "code" || a.metadata?.language) {
					docType = "code";
				} else if (
					format === "markdown" ||
					content.includes("##") ||
					content.includes("**") ||
					content.startsWith("#")
				) {
					docType = "markdown";
				} else if (
					format === "html" ||
					content.trim().startsWith("<")
				) {
					docType = "html";
				} else if (format === "json" || a.type === "data") {
					// Check if content is actually JSON
					try {
						JSON.parse(content);
						docType = "json";
					} catch {
						docType = "markdown"; // Default to markdown for non-JSON data
					}
				} else if (a.type === "document") {
					docType = "markdown";
				}

				return {
					id: a.id,
					title: a.name || `${a.type} artifact`,
					type: docType,
					content,
					language: a.metadata?.language as string | undefined,
					createdAt: a.createdAt,
					metadata: a.metadata,
				};
			});
	}, [artifacts, completedExecutions]);

	// Sync internal conversationId with prop (for when user selects different conversation or starts new chat)
	useEffect(() => {
		const prevId = prevConversationIdRef.current;
		const newId = activeConversationId || null;
		const parentProvidedConversation =
			activeConversationId !== null && activeConversationId !== undefined;
		const shouldPreserveLocalConversation =
			!parentProvidedConversation &&
			createdConversationInSessionRef.current &&
			conversationId !== null;

		if (!shouldPreserveLocalConversation) {
			setConversationId(newId);
		}

		// Only reset state when conversation actually changes
		if (newId !== prevId) {
			// Clear state when:
			// 1. Starting new chat (newId is null and prevId was something)
			// 2. Switching to a different conversation (both exist but different)
			if (
				(!newId && prevId !== null) ||
				(newId && prevId && newId !== prevId)
			) {
				setCompletedExecutions([]);
				// Reset hydration tracking
				hydratedConversationRef.current = null;
				// Clear the last plan reference so sidebar doesn't show stale plan
				lastPlanRef.current = null;
				// Reset the streaming hook state to clear messages, stepResults, etc.
				reset();
				// Reset session tracking - parent explicitly changed/cleared the conversation
				createdConversationInSessionRef.current = false;
				// Notify parent to clear the plan display
				onActivityChangeRef.current?.({
					isActive: false,
					currentPhase: "idle",
					plan: undefined,
					routingDecision: undefined,
					completedSteps: 0,
					totalSteps: 0,
					currentStep: null,
					pendingApproval: undefined,
				});
			}
			// If parent acknowledges our conversation (sets activeConversationId to match),
			// we can also reset the session flag since they're now in sync
			if (newId && newId === conversationId) {
				createdConversationInSessionRef.current = false;
			}
			prevConversationIdRef.current = newId;
		}
	}, [activeConversationId, conversationId, reset]);

	// Track last known plan to preserve it after completion
	const lastPlanRef = useRef<TaskPlan | null>(null);
	if (state.plan) {
		lastPlanRef.current = state.plan;
	}

	// Track last execution ID to detect new completions
	const lastExecutionIdRef = useRef<string | null>(null);
	const lastUserMessageRef = useRef<string>("");
	const lastUserImageUrlsRef = useRef<string[] | undefined>(undefined);

	// Hydrate orchestrator metadata when loading a saved conversation
	useEffect(() => {
		if (!activeConversationId) {
			setSelectedConversationMcpIds(null);
			return;
		}

		setSelectedConversationMcpIds(
			getSelectedOrchestratorToolIds(activeConversation?.metadata),
		);
	}, [activeConversation?.metadata, activeConversationId]);

	useEffect(() => {
		// Only hydrate if we have a conversation and haven't hydrated this one yet
		if (
			activeConversation &&
			activeConversationId &&
			hydratedConversationRef.current !== activeConversationId
		) {
			// Check if this conversation has orchestrator metadata
			const metadata = (activeConversation as any).metadata as any;
			const isOrchestratorConversation =
				metadata?.mode === "orchestrator";

			if (isOrchestratorConversation) {
				const currentExecutionId = state.executionId;
				const rawExecutions: any[] = Array.isArray(metadata?.executions)
					? metadata.executions
					: [];

				// Build completedExecutions from persisted execution records
				let restoredExecutions: CompletedExecution[] = rawExecutions
					.filter(
						(exec: any) =>
							exec?.id &&
							exec.userMessage &&
							exec.id !== currentExecutionId,
					)
					.map((exec: any) => ({
						id: exec.id,
						userMessage: exec.userMessage,
						imageUrls: exec.imageUrls,
						stepResults: exec.stepResults || [],
						response: exec.finalResponse,
						completedAt: new Date(
							exec.completedAt || exec.startedAt,
						),
						plan: exec.plan
							? {
									id: exec.plan.id,
									description: exec.plan.description || "",
									riskLevel: exec.plan.riskLevel || "low",
									steps: (exec.plan.steps || []).map(
										(s: any) => ({
											id: s.id,
											description: s.description,
											status: s.status,
											order: s.order,
											executor: s.executor,
											riskLevel: s.riskLevel,
											requiresApproval:
												s.requiresApproval,
										}),
									),
								}
							: undefined,
						artifacts: exec.artifacts || [],
						sourcesUsed: exec.sourcesUsed || [],
					}));

				// Fallback: if metadata.executions is missing or empty (e.g. due
				// to a prior race condition), reconstruct from the persisted
				// messages array so the conversation content is still visible.
				// Skip if there is an active live execution (state.executionId
				// is set) — in that case the live view already handles
				// rendering and we must not create a duplicate completed
				// execution entry that would cause the same response to appear
				// twice (once from completedExecutions, once from the live
				// stepResults section).
				if (restoredExecutions.length === 0 && !state.executionId) {
					const msgs: Array<{
						role: string;
						content: string;
					}> = Array.isArray((activeConversation as any).messages)
						? (activeConversation as any).messages
						: [];

					const fallbackExecutions: CompletedExecution[] = [];
					for (let i = 0; i < msgs.length; i++) {
						const msg = msgs[i];
						if (msg.role === "user") {
							const next = msgs[i + 1];
							const assistantContent =
								next?.role === "assistant" ? next.content : "";
							fallbackExecutions.push({
								id: `msg-fallback-${i}`,
								userMessage: msg.content,
								stepResults: [],
								response: assistantContent,
								completedAt: new Date(
									(activeConversation as any).updatedAt ||
										Date.now(),
								),
								artifacts: [],
								sourcesUsed: [],
							});
							if (next?.role === "assistant") {
								i++; // skip assistant message we already consumed
							}
						}
					}
					restoredExecutions = fallbackExecutions;
				}

				setCompletedExecutions(restoredExecutions);

				// Report the last execution's plan to the parent for sidebar display
				const lastExecution = rawExecutions[rawExecutions.length - 1];
				if (lastExecution?.plan && onActivityChangeRef.current) {
					onActivityChangeRef.current({
						isActive: false,
						currentPhase: "complete",
						routingDecision: lastExecution.routingDecision,
						plan: lastExecution.plan,
						completedSteps: lastExecution.plan.steps.length,
						totalSteps: lastExecution.plan.steps.length,
						currentStep: null,
						pendingApproval: undefined,
					});
				}

				// Mark this conversation as hydrated
				hydratedConversationRef.current = activeConversationId;
			}
		}

		// Reset hydration tracking when conversation ID changes
		if (
			!activeConversationId ||
			(hydratedConversationRef.current &&
				activeConversationId !== hydratedConversationRef.current)
		) {
			hydratedConversationRef.current = null;
		}
	}, [
		activeConversation,
		activeConversationId,
		state.executionId,
		// Note: stepResults.length removed - we always exclude current execution now,
		// so we don't need to re-run based on stepResults changes
	]);

	useEffect(() => {
		if (!conversationId) {
			return;
		}

		// Skip if activeConversation hasn't loaded yet.
		// When a new conversation is just created, activeConversation is null
		// and calling update with existing=null would produce metadata without
		// executions, racing with saveExecution and corrupting the stored data.
		// saveExecution now handles persisting selectedMcpConfigIds atomically,
		// so we only need this effect for subsequent changes on loaded conversations.
		const existingMetadata =
			(activeConversation?.metadata as Record<string, unknown> | null) ??
			null;
		if (!existingMetadata) {
			return;
		}

		void orpcClient.agents.conversations
			.update({
				id: conversationId,
				metadata: mergeOrchestratorConversationMetadata({
					existing: existingMetadata,
					executionMode: reasoningMode,
					instanceId,
					selectedMcpConfigIds:
						selectedConversationMcpIds === null
							? undefined
							: selectedConversationMcpIds,
				}),
			})
			.catch((error) => {
				console.error(
					"[Orchestrator] Failed to persist conversation tool selection:",
					error,
				);
			});
	}, [
		conversationId,
		instanceId,
		reasoningMode,
		selectedConversationMcpIds,
		activeConversation,
	]);

	// Persist conversation with full execution metadata to database
	const persistConversation = useCallback(
		async (
			userContent: string,
			assistantContent: string,
			_toolCalls?: Array<{
				id: string;
				name: string;
				args: unknown;
				result?: unknown;
				status: string;
			}>,
		) => {
			try {
				// Determine execution status and any errors
				const hasError = state.status === "failed";
				const wasCancelled = state.status === "cancelled";
				// Detect rejection from response message or approval history
				const _wasRejected =
					approvalHistoryRef.current.some((a) => !a.approved) ||
					assistantContent?.includes("rejected") ||
					assistantContent?.includes("stopped");

				// Map to execution record status
				let executionStatus:
					| "running"
					| "complete"
					| "error"
					| "cancelled" = "complete";
				if (hasError) {
					executionStatus = "error";
				} else if (wasCancelled) {
					executionStatus = "cancelled";
				}
				// Rejections still count as "complete" since they finished normally

				const errorMessage =
					state.result?.error ||
					(hasError ? "Execution failed" : undefined);

				// Build complete execution record
				const execution: OrchestratorExecution = {
					id: state.executionId || `exec-${Date.now()}`,
					workflowId: state.executionId || undefined, // Use executionId as workflowId for now
					userMessage: userContent,
					imageUrls: lastUserImageUrlsRef.current,
					routingDecision: state.result?.routingDecision
						? {
								primaryAgent:
									state.result.routingDecision.primaryAgent,
								agentName:
									AGENT_DISPLAY_INFO[
										state.result.routingDecision
											.primaryAgent
									]?.name ||
									state.result.routingDecision.primaryAgent,
								confidence:
									state.result.routingDecision.confidence,
								riskLevel:
									state.result.routingDecision.riskLevel ||
									"low",
							}
						: undefined,
					plan: state.plan
						? {
								id: state.plan.id,
								description: state.plan.description || "",
								riskLevel: state.plan.riskLevel,
								steps: state.plan.steps.map((s) => ({
									id: s.id,
									description: s.description,
									status: s.status,
									order: s.order,
									riskLevel: s.riskLevel,
									requiresApproval: s.requiresApproval,
								})),
							}
						: undefined,
					stepResults: convertStepResults(stepResults),
					approvalHistory: approvalHistoryRef.current,
					variables: {},
					status: executionStatus,
					startedAt:
						currentExecutionRef.current?.startedAt ||
						new Date().toISOString(),
					completedAt: new Date().toISOString(),
					finalResponse: assistantContent,
					error: errorMessage,
					// Include artifacts for persistence
					artifacts: artifacts?.filter(
						(a) => a.content && a.content.length > 100,
					),
					// Include sources used for ArtifactsPanel persistence
					sourcesUsed: planningAudit?.sourcesUsed || [],
				};

				// Build messages for this execution
				const userMsg = {
					id: generateMessageId(),
					role: "user" as const,
					content: userContent,
					timestamp: execution.startedAt,
				};

				// Stream lifecycle metadata persisted alongside the message
				// body so a page reload still surfaces the inline `Stopped`
				// caption on cancelled turns (spec § 5.1 / AC-5). The
				// orchestrator hook stamps `cancelledAt` on the in-flight
				// assistant message in `messages`; pull it through so the
				// rehydrated copy carries the same instant.
				const cancelledAssistant = wasCancelled
					? [...messages]
							.reverse()
							.find(
								(m) =>
									m.role === "assistant" &&
									m.streamStatus === "cancelled",
							)
					: undefined;

				const assistantMsg = {
					id: generateMessageId(),
					role: "assistant" as const,
					content: assistantContent,
					timestamp: new Date().toISOString(),
					streamStatus: wasCancelled
						? ("cancelled" as const)
						: hasError
							? ("error" as const)
							: ("completed" as const),
					cancelledAt: cancelledAssistant?.cancelledAt,
				};

				if (!conversationId) {
					// Create new conversation with first execution
					const result =
						await createOrchestratorConversation(userContent);

					// Persist project attachment BEFORE setting conversationId.
					// setConversationId enables the getProject query — if we set it
					// first, the query races with the attach call and returns null,
					// which clears attachedProjectId via the sync effect.
					if (attachedProjectId) {
						try {
							await orpcClient.projects.conversations.attach({
								conversationId: result.id,
								projectId: attachedProjectId,
								organizationId: organizationId ?? null,
							});
						} catch (err) {
							console.warn(
								"[OrchestratorChat] Failed to persist project attachment:",
								err,
							);
						}
					}

					setConversationId(result.id);
					// Mark that we created this conversation in the current session
					// This helps distinguish "parent hasn't updated" from "parent cleared for new chat"
					createdConversationInSessionRef.current = true;
					onConversationCreated?.(result.id);

					// Save the execution to the new conversation.
					// Pass selectedConversationMcpIds so it is saved atomically
					// with the execution, preventing a race where the metadata
					// update effect fires first and corrupts the metadata.
					await saveExecution(
						result.id,
						execution,
						[userMsg, assistantMsg],
						selectedConversationMcpIds,
					);
				} else {
					// Add execution to existing conversation
					// First get existing messages to append to
					const existingConvo =
						await orpcClient.agents.conversations.get({
							id: conversationId,
						});
					const existingMessages = (existingConvo.messages ||
						[]) as (typeof userMsg)[];
					const allMessages = [
						...existingMessages,
						userMsg,
						assistantMsg,
					];

					await saveExecution(
						conversationId,
						execution,
						allMessages,
						selectedConversationMcpIds,
					);
				}

				// Reset tracking for next execution
				currentExecutionRef.current = null;
				approvalHistoryRef.current = [];

				onConversationSaved?.();
			} catch (error) {
				console.error(
					"[Orchestrator] Failed to persist conversation:",
					error,
				);
			}
		},
		[
			conversationId,
			state.executionId,
			state.status,
			state.result,
			state.plan,
			stepResults,
			artifacts,
			messages,
			convertStepResults,
			createOrchestratorConversation,
			saveExecution,
			onConversationCreated,
			onConversationSaved,
			selectedConversationMcpIds,
			planningAudit,
		],
	);

	// Track last completed execution for moving to collapsed panel when new message sent
	const lastCompletedExecutionRef = useRef<CompletedExecution | null>(null);

	// Track when an execution completes - DON'T add to collapsible panel yet, keep visible
	// Also handles rejections/cancellations where stepResults might be empty
	useEffect(() => {
		if (
			isComplete &&
			state.executionId &&
			state.executionId !== lastExecutionIdRef.current
		) {
			// Determine if this was a rejection/cancellation (check for various decline keywords)
			const wasRejected =
				state.status === "cancelled" ||
				state.result?.response?.toLowerCase().includes("rejected") ||
				state.result?.response?.toLowerCase().includes("declined") ||
				state.result?.response?.toLowerCase().includes("stopped") ||
				state.result?.error?.toLowerCase().includes("rejected") ||
				state.result?.error?.toLowerCase().includes("declined");
			const wasCancelled = state.status === "cancelled";
			const hasFailed = state.status === "failed";

			// Build response message - use state response, or create one for rejections/cancellations
			let responseMessage = state.result?.response || "";
			if (!responseMessage) {
				if (wasCancelled) {
					responseMessage = "Workflow was cancelled by user.";
				} else if (wasRejected) {
					const completedCount = stepResults.filter(
						(sr) => sr.status === "complete",
					).length;
					responseMessage =
						completedCount > 0
							? `Workflow stopped. Completed ${completedCount} step(s) before stopping.`
							: "Workflow stopped before any steps were completed.";
				} else if (hasFailed) {
					responseMessage =
						state.result?.error || "Execution failed.";
				} else {
					responseMessage = "Execution completed.";
				}
			}

			// Store the completed execution for later (will move to collapsible panel when new message sent)
			lastCompletedExecutionRef.current = {
				id: state.executionId,
				userMessage: lastUserMessageRef.current,
				imageUrls: lastUserImageUrlsRef.current,
				stepResults: [...stepResults],
				response: responseMessage,
				completedAt: new Date(),
				plan: state.plan
					? {
							id: state.plan.id,
							description: state.plan.description || "",
							riskLevel: state.plan.riskLevel,
							steps: state.plan.steps.map((s) => ({
								id: s.id,
								description: s.description,
								status: s.status,
								order: s.order,
								executor: s.executor,
								riskLevel: s.riskLevel,
								requiresApproval: s.requiresApproval,
							})),
						}
					: undefined,
			};

			lastExecutionIdRef.current = state.executionId;

			// Persist to database - even for rejections with empty stepResults
			const toolCalls = stepResults.flatMap((sr) =>
				sr.toolCalls.map((tc) => ({
					...tc,
					status: tc.status,
				})),
			);
			persistConversation(
				lastUserMessageRef.current,
				responseMessage,
				toolCalls,
			);
		}
	}, [
		isComplete,
		state.executionId,
		state.status,
		stepResults,
		state.result?.response,
		state.result?.error,
		persistConversation,
	]);

	// Report activity changes to parent
	useEffect(() => {
		const routingDecision = state.result?.routingDecision;
		const agentInfo = routingDecision
			? AGENT_DISPLAY_INFO[routingDecision.primaryAgent]
			: undefined;

		// Use the current plan or fall back to last known plan (preserves plan after completion)
		const planToUse = state.plan || lastPlanRef.current;

		// Use ref to avoid re-triggering when parent doesn't memoize callback
		onActivityChangeRef.current?.({
			isActive: isRunning || isAwaitingApproval,
			currentPhase,
			routingDecision: routingDecision
				? {
						primaryAgent: routingDecision.primaryAgent,
						agentName:
							agentInfo?.name || routingDecision.primaryAgent,
						confidence: routingDecision.confidence,
						riskLevel: routingDecision.riskLevel,
					}
				: undefined,
			plan: planToUse || undefined,
			completedSteps,
			totalSteps,
			currentStep,
			pendingApproval: state.pendingApproval || undefined,
		});
	}, [
		isRunning,
		isAwaitingApproval,
		currentPhase,
		state.plan,
		state.result?.routingDecision,
		state.pendingApproval,
		completedSteps,
		totalSteps,
		currentStep,
		// Note: onActivityChange removed from deps - we use ref pattern to avoid infinite loops
	]);

	// Show connection dialog when routing detects blocked connections (pre-flight)
	// or when mid-session OAuth authorization is required
	useEffect(() => {
		const routingDecision = state.result?.routingDecision;
		const blockedOnAuth = state.result?.blockedOnAuth;

		// Pre-flight connection requirement
		if (
			routingDecision?.blockedOnConnections &&
			routingDecision.requiredConnections &&
			routingDecision.requiredConnections.length > 0
		) {
			setIsConnectionDialogOpen(true);
			return;
		}

		// Mid-session OAuth authorization required
		if (blockedOnAuth?.configId && blockedOnAuth?.serverName) {
			console.log(
				"[Orchestrator] Mid-session OAuth required:",
				blockedOnAuth.serverName,
			);
			setIsConnectionDialogOpen(true);
		}
	}, [state.result?.routingDecision, state.result?.blockedOnAuth]);

	// Handle connection completion - retry the pending message
	const handleConnectionComplete = useCallback(() => {
		setIsConnectionDialogOpen(false);
		if (pendingMessageRef.current) {
			const message = pendingMessageRef.current;
			pendingMessageRef.current = null;
			// Small delay to allow dialog to close
			setTimeout(() => {
				setInput(message);
				toast.success(
					"Integration connected! You can now retry your request.",
				);
			}, 300);
		}
	}, []);

	// Handle skip connection
	const handleSkipConnection = useCallback(() => {
		setIsConnectionDialogOpen(false);
		pendingMessageRef.current = null;
		toast.info(
			"Continuing without connecting integrations. Some features may be limited.",
		);
	}, []);

	// Auto-scroll to last step when step results change (new step completed)
	useEffect(() => {
		if (stepResults.length > 0 && lastStepRef.current) {
			const timer = setTimeout(() => {
				lastStepRef.current?.scrollIntoView({
					behavior: "smooth",
					block: "end",
				});
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [stepResults.length]);

	// Focus input on mount
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Helper to detect modification indicators in message
	const hasModificationIndicators = (message: string): boolean => {
		const indicators = [
			"actually",
			"instead",
			"change",
			"modify",
			"update",
			"also add",
			"don't forget",
			"include",
			"skip",
			"remove",
			"wait",
			"stop",
			"cancel",
			"hold on",
			"pause",
		];
		const messageLower = message.toLowerCase();
		return indicators.some((ind) => messageLower.includes(ind));
	};

	// Attachment handlers
	const handleAttachClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	/**
	 * Enqueue a document into the RAG/inline queue after validating it against
	 * the shared vocabulary — the same gate the paperclip's `accept` is derived
	 * from, so the picker never offers a file this then refuses. The extension
	 * fallback catches paste/drop files that arrive with an empty `type`. Loom
	 * runs no canvas step, so it uses the server-allowed extension set.
	 */
	const enqueueDocument = useCallback((file: File): void => {
		if (file.size > DEFAULT_AI_CHAT_MAX_FILE_BYTES) {
			toast.error(
				`File "${file.name}" exceeds the ${Math.round(DEFAULT_AI_CHAT_MAX_FILE_BYTES / (1024 * 1024))}MB limit (${(file.size / (1024 * 1024)).toFixed(2)}MB)`,
			);
			return;
		}
		if (
			!DEFAULT_AI_CHAT_MIME_ALLOWLIST.includes(file.type) &&
			!AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test(file.name)
		) {
			toast.error(`File type not supported: ${file.name}`);
			return;
		}
		setAttachedDocuments((prev) => [
			...prev,
			{
				id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				file,
				name: file.name,
				type: file.type,
				size: file.size,
				documentId: null,
				status: "pending",
			},
		]);
	}, []);

	/**
	 * Single paperclip / picker for images and documents. Each file is routed
	 * by MIME: a client-renderable image (png/jpeg/webp/gif) feeds the existing
	 * multimodal-vision queue; everything else — documents and TIFF, which is
	 * not client-renderable — feeds the document queue, the same split Loom
	 * Direct makes. The image branch validates through the shared helper and
	 * the shared size cap rather than a hand-rolled list.
	 */
	const handleFileSelect = useCallback(
		async (e: ChangeEvent<HTMLInputElement>) => {
			const files = e.target.files;
			if (!files) {
				return;
			}

			const newImages: typeof attachedImages = [];
			for (const file of Array.from(files)) {
				if (isClientRenderableAiChatImage(file.type)) {
					if (file.size > DEFAULT_AI_CHAT_MAX_FILE_BYTES) {
						toast.error(
							`File too large (max ${Math.round(DEFAULT_AI_CHAT_MAX_FILE_BYTES / (1024 * 1024))}MB): ${file.name}`,
						);
						continue;
					}
					// Base64 adds a third on the wire, so a file inside the
					// raw cap above can still exceed what the model accepts —
					// failing later with nothing the user can act on.
					const shaped = await prepareImageForAi(file);
					if (!shaped.ok) {
						toast.error(shaped.error);
						continue;
					}
					newImages.push({
						id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						file: shaped.file,
						name: file.name,
						previewUrl: URL.createObjectURL(shaped.file),
						status: "pending",
					});
					continue;
				}
				enqueueDocument(file);
			}

			if (newImages.length > 0) {
				setAttachedImages((prev) => [...prev, ...newImages]);
			}

			// Reset input so the same file can be selected again
			e.target.value = "";
		},
		[enqueueDocument],
	);

	const removeAttachedImage = useCallback((id: string) => {
		setAttachedImages((prev) => {
			const img = prev.find((i) => i.id === id);
			if (img) {
				URL.revokeObjectURL(img.previewUrl);
			}
			return prev.filter((i) => i.id !== id);
		});
	}, []);

	const removeDocument = useCallback((fileId: string) => {
		setAttachedDocuments((prev) => prev.filter((f) => f.id !== fileId));
	}, []);

	/**
	 * Mixed paste/drop — the image half is handled by `imageUploader` /
	 * `enableImagePaste` (ChatInput's clipboard splitter routes `image/*` there);
	 * non-image files land here and go to the document queue via the same shared
	 * gate the picker uses.
	 */
	const onPasteNonImageFiles = useCallback(
		(files: File[]): void => {
			for (const file of files) {
				enqueueDocument(file);
			}
		},
		[enqueueDocument],
	);

	/**
	 * Pasted/dropped image enqueuer — enqueue only, identical to the paperclip
	 * `handleFileSelect` path. The actual upload (`POST
	 * /api/agents/fabric-ai/upload-image`) runs at **send-time** inside
	 * `uploadAttachedImages`, so paste and paperclip share a single upload
	 * pipeline with one source of truth for status transitions and the
	 * eventual `storagePath` returned to the orchestrator.
	 */
	const pastedImageUploader = useCallback(
		async (file: File, _signal: AbortSignal): Promise<void> => {
			const id = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			setAttachedImages((prev) => [
				...prev,
				{
					id,
					file,
					name: file.name || "pasted-image",
					previewUrl: URL.createObjectURL(file),
					status: "pending" as const,
				},
			]);
		},
		[],
	);

	/**
	 * Upload attached images and return their S3 storage paths.
	 * Storage paths (not signed URLs) are passed to workflows so images
	 * can be resolved via the proxy route (/api/storage/image?path=...)
	 * which generates fresh signed URLs on-demand.
	 */
	const uploadAttachedImages = useCallback(async (): Promise<string[]> => {
		const pendingImages = attachedImages.filter(
			(img) => img.status === "pending",
		);
		if (pendingImages.length === 0) {
			// Return storage paths from already-uploaded images
			return attachedImages
				.filter((img) => img.storagePath && img.status === "ready")
				.map((img) => img.storagePath as string);
		}

		const uploadedPaths: string[] = [];

		for (const img of pendingImages) {
			setAttachedImages((prev) =>
				prev.map((i) =>
					i.id === img.id ? { ...i, status: "uploading" } : i,
				),
			);

			try {
				const formData = new FormData();
				formData.append("file", img.file);
				// Pass organizationId so upload uses the correct tenant prefix
				// (session.activeOrganizationId can be stale in personal context)
				if (organizationId) {
					formData.append("organizationId", organizationId);
				}

				const response = await fetch(
					"/api/agents/fabric-ai/upload-image",
					{
						method: "POST",
						body: formData,
					},
				);

				if (!response.ok) {
					const error = await response.json();
					throw new Error(error.error || "Upload failed");
				}

				const result = await response.json();
				// Use storagePath (stable) instead of url (signed, expires in 1 hour)
				uploadedPaths.push(result.storagePath);

				setAttachedImages((prev) =>
					prev.map((i) =>
						i.id === img.id
							? {
									...i,
									status: "ready",
									uploadedUrl: result.url,
									storagePath: result.storagePath,
								}
							: i,
					),
				);
			} catch (error) {
				console.error("[ImageUpload] Failed:", error);
				setAttachedImages((prev) =>
					prev.map((i) =>
						i.id === img.id ? { ...i, status: "error" } : i,
					),
				);
				toast.error(`Failed to upload ${img.name}`);
			}
		}

		// Also include already-uploaded images (by storage path)
		const existingPaths = attachedImages
			.filter((img) => img.storagePath && img.status === "ready")
			.map((img) => img.storagePath as string);

		return [...existingPaths, ...uploadedPaths];
	}, [attachedImages, organizationId]);

	/**
	 * Upload pending documents (createUploadUrl → PUT/serverUpload → process),
	 * building the inline envelope for each via the shared `buildAiChatAttachmentEntry`
	 * so the surface carries the filename/body neutralizer with it. Returns the
	 * document IDs (for RAG retrieval) and the inline contexts (extracted text
	 * delivered directly to the model). Mirrors Loom Direct's `uploadAttachments`,
	 * including the `uploadResponse.ok` check — a 403/500 on the presigned PUT
	 * resolves normally, so without it the chip would advance to `ready` on a file
	 * that never stored.
	 */
	const uploadDocuments = useCallback(async (): Promise<{
		documentIds: string[];
		inlineContexts: string[];
		chatId: string | undefined;
	}> => {
		const pendingFiles = attachedDocuments.filter(
			(f) => f.status === "pending",
		);
		if (pendingFiles.length === 0) {
			return { documentIds: [], inlineContexts: [], chatId: undefined };
		}

		const documentIds: string[] = [];
		const inlineContexts: string[] = [];
		let aiChatId: string | undefined = currentDocumentChatId || undefined;

		for (const attachedFile of pendingFiles) {
			try {
				setAttachedDocuments((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? { ...f, status: "uploading" as const }
							: f,
					),
				);

				const {
					documentId,
					signedUploadUrl,
					useServerUpload,
					chatId: returnedChatId,
				} = await orpcClient.ai.documents.createUploadUrl({
					chatId: aiChatId,
					organizationId: organizationId || undefined,
					filename: attachedFile.name,
					mimeType: attachedFile.type || "application/octet-stream",
					size: attachedFile.size,
				});

				if (!aiChatId && returnedChatId) {
					aiChatId = returnedChatId;
					setCurrentDocumentChatId(returnedChatId);
				}

				if (signedUploadUrl) {
					const uploadResponse = await fetch(signedUploadUrl, {
						method: "PUT",
						body: attachedFile.file,
						headers: {
							"Content-Type":
								attachedFile.type || "application/octet-stream",
						},
					});
					if (!uploadResponse.ok) {
						throw new Error(
							`Upload failed with status ${uploadResponse.status}`,
						);
					}
				} else if (useServerUpload) {
					const arrayBuffer = await attachedFile.file.arrayBuffer();
					const base64 = btoa(
						new Uint8Array(arrayBuffer).reduce(
							(data, byte) => data + String.fromCharCode(byte),
							"",
						),
					);
					await orpcClient.ai.documents.upload({
						documentId,
						fileData: base64,
						mimeType:
							attachedFile.type || "application/octet-stream",
					});
				} else {
					throw new Error("No upload method available");
				}

				setAttachedDocuments((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? {
									...f,
									status: "processing" as const,
									documentId,
									chatId: aiChatId,
								}
							: f,
					),
				);

				// `process` already bounds what it returns, so no client-side
				// budget is applied here (a second cut would report a truncation
				// the user was never subject to).
				const processed = await orpcClient.ai.documents.process({
					documentId,
				});
				const contextEntry = buildAiChatAttachmentEntry(
					attachedFile.name,
					processed?.extractedContent ?? "",
				);

				setAttachedDocuments((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? {
									...f,
									status: "ready" as const,
									extraction: processed?.extraction,
									contextEntry,
								}
							: f,
					),
				);

				documentIds.push(documentId);
				inlineContexts.push(contextEntry);
				toast.success(`Uploaded ${attachedFile.name}`);
			} catch (error) {
				console.error("Document upload error:", error);
				setAttachedDocuments((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? {
									...f,
									status: "error" as const,
									error:
										error instanceof Error
											? error.message
											: "Upload failed",
								}
							: f,
					),
				);
				toast.error(`Failed to upload ${attachedFile.name}`);
			}
		}

		return { documentIds, inlineContexts, chatId: aiChatId };
	}, [attachedDocuments, currentDocumentChatId, organizationId]);

	const handleSendMessage = async () => {
		if (!input.trim() || isLoading) {
			return;
		}

		const content = input.trim();
		setInput("");

		// Store the message in case we need to retry after connection
		pendingMessageRef.current = content;

		// Check if this should be sent as a follow-up to an in-progress execution
		if (isFollowUpEnabled && !isComplete) {
			const isModification = hasModificationIndicators(content);
			const success = await sendFollowUp(content, isModification);
			if (success) {
				toast.info(
					isModification
						? "Modification request sent"
						: "Follow-up sent",
				);
				return;
			}
			// Follow-up failed — fall through to send as a new execution.
			// Do NOT restore input here: the fallback send below will use `content`
			// directly, and leaving text in the composer would invite duplicate sends.
			toast.info("Follow-up unavailable, starting new execution");
		}

		// Determine if this is a new chat
		// The parent's activeConversationId is the source of truth for intent:
		// - null/undefined = parent wants a new chat
		// - set to a value = parent wants to continue that conversation
		//
		// EXCEPTION: If we created a conversation in this session but parent hasn't
		// updated the prop yet, we should continue that conversation, not start a new one.
		// This handles the race condition where:
		// 1. User sends first message, we create conversation
		// 2. User sends second message before parent receives onConversationCreated callback
		// 3. Without this check, we'd incorrectly treat it as a new chat
		const parentWantsNewChat =
			activeConversationId === null || activeConversationId === undefined;
		const createdInSession = createdConversationInSessionRef.current;
		const isNewChat = parentWantsNewChat && !createdInSession;

		// CRITICAL: If this is a new chat, ensure state is clean
		// This handles the race condition where user sends message before useEffect reset completes
		if (isNewChat) {
			// Clear local component state immediately (don't wait for useEffect)
			if (conversationId) {
				setConversationId(null);
			}
			// Reset session tracking since we're starting fresh
			createdConversationInSessionRef.current = false;
			setCompletedExecutions([]);
			hydratedConversationRef.current = null;
			lastPlanRef.current = null;
			lastCompletedExecutionRef.current = null;
		}

		// Track the user message for the execution record
		lastUserMessageRef.current = content;

		// Initialize execution tracking
		currentExecutionRef.current = createExecutionRecord(
			`exec-${Date.now()}`,
			content,
			reasoningMode,
		);
		approvalHistoryRef.current = [];

		// Move the last completed execution to the collapsible panel (if any)
		// Only do this for follow-up messages in an existing conversation
		if (!isNewChat && lastCompletedExecutionRef.current) {
			// Capture the ref value before the state setter callback to avoid race conditions
			const executionToAdd = lastCompletedExecutionRef.current;
			setCompletedExecutions((prev) => {
				// Only add if not already in the list
				if (
					!prev.some((e) => e != null && e.id === executionToAdd.id)
				) {
					return [...prev, executionToAdd];
				}
				return prev;
			});
			lastCompletedExecutionRef.current = null;
		}

		// For follow-ups, include the full persisted thread context:
		// - completedExecutions contains earlier completed runs
		// - messages contains the latest visible run in the active thread
		const history = isNewChat
			? []
			: [
					...completedExecutions.flatMap((execution) => {
						const threadMessages: Array<{
							role: "user" | "assistant";
							content: string;
						}> = [];

						if (execution.userMessage?.trim()) {
							threadMessages.push({
								role: "user",
								content: execution.userMessage,
							});
						}

						if (execution.response?.trim()) {
							threadMessages.push({
								role: "assistant",
								content: stripPersistedAssistantLabelPrefix(
									execution.response,
								),
							});
						}

						return threadMessages;
					}),
					...messages
						.filter(
							(m) =>
								!m.isStreaming &&
								!m.isError &&
								(m.role === "user" || m.role === "assistant"),
						)
						.map((m) => ({
							role: m.role,
							content: m.content,
						})),
				];

		// Upload attached images if any
		let newlyAttachedImageUrls: string[] | undefined;
		if (attachedImages.length > 0) {
			try {
				newlyAttachedImageUrls = await uploadAttachedImages();
				// Clear attached images after upload
				for (const img of attachedImages) {
					URL.revokeObjectURL(img.previewUrl);
				}
				setAttachedImages([]);
			} catch (error) {
				console.error("[ImageUpload] Upload failed:", error);
				toast.error("Failed to upload images");
				return;
			}
		}

		// Upload attached documents and collect the two channels the route
		// consumes: `attachedDocumentIds` (RAG retrieval) and
		// `inlineAttachmentContexts` (extracted text delivered inline). Mirrors
		// Loom Direct — a re-send of an already-ready document reuses the
		// envelope built at processing time rather than degrading to
		// retrieval-only.
		let sessionDocumentIds: string[] = [];
		let inlineAttachmentContexts: string[] = [];
		if (attachedDocuments.length > 0) {
			if (attachedDocuments.some((f) => f.status === "pending")) {
				const uploadResult = await uploadDocuments();
				sessionDocumentIds = uploadResult.documentIds;
				inlineAttachmentContexts = uploadResult.inlineContexts;
			} else {
				const readyFiles = attachedDocuments.filter(
					(f) => f.status === "ready" && f.documentId,
				);
				sessionDocumentIds = readyFiles.map(
					(f) => f.documentId as string,
				);
				inlineAttachmentContexts = readyFiles
					.map((f) => f.contextEntry)
					.filter((entry): entry is string => Boolean(entry));
			}
			setAttachedDocuments([]);
		}

		// Build the full set of image URLs for the backend:
		// - User-uploaded images from all previous messages (original references)
		// - Generated images from the LATEST assistant response only (current state)
		// - Newly attached images for this message
		// This gives the LLM the original context + latest generated state without
		// accumulating every intermediate generation.
		let allImageUrls = newlyAttachedImageUrls;
		if (!isNewChat) {
			const collected: string[] = [];

			// 1. User-uploaded images from previous messages
			for (const m of messages) {
				if (m.imageUrls && m.imageUrls.length > 0) {
					collected.push(...m.imageUrls);
				}
			}

			// 2. Generated images from the latest assistant response
			const lastAssistant = [...messages]
				.reverse()
				.find((m) => m.role === "assistant" && m.content);
			if (lastAssistant?.content) {
				const imageProxyPattern =
					/\/api\/storage\/image\?path=([^&\s)]+)/g;
				let proxyMatch = imageProxyPattern.exec(lastAssistant.content);
				while (proxyMatch !== null) {
					try {
						collected.push(decodeURIComponent(proxyMatch[1]));
					} catch {
						// Skip malformed percent-encoded path fragments
					}
					proxyMatch = imageProxyPattern.exec(lastAssistant.content);
				}
			}

			if (collected.length > 0) {
				const newUrls = newlyAttachedImageUrls || [];
				allImageUrls = [...new Set([...collected, ...newUrls])];
			}
		}

		// Store only newly attached images for execution display (thumbnails).
		// allImageUrls (which includes carry-forward) is sent separately to the backend.
		lastUserImageUrlsRef.current = newlyAttachedImageUrls;

		// Pass forceNewChat flag and template instructions to ensure hook starts fresh for new chats
		// Template instructions are per-message scope (cleared after sending by ChatInput)
		// Template integration/MCP IDs are merged with enabled IDs for this message only
		await sendMessage(
			content,
			history,
			isNewChat,
			templateInstructions,
			templateIntegrationIds,
			templateMcpConfigIds,
			templateFabricToolIds,
			allImageUrls,
			newlyAttachedImageUrls,
			sessionDocumentIds.length > 0 ? sessionDocumentIds : undefined,
			inlineAttachmentContexts.length > 0
				? inlineAttachmentContexts
				: undefined,
		);
	};

	// Approval state for ApprovalDialog component
	const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);

	const handleApprove = async () => {
		setIsSubmittingApproval(true);
		try {
			// Track approval in history
			if (state.pendingApproval) {
				approvalHistoryRef.current.push({
					approvalId: `approval-${Date.now()}`,
					stepId: currentStep?.id || "unknown",
					stepDescription: state.pendingApproval.reason,
					riskLevel: state.plan?.riskLevel || "medium",
					requestedAt: new Date().toISOString(),
					decidedAt: new Date().toISOString(),
					approved: true,
				});
			}

			const success = await sendApproval(true);
			if (success) {
				toast.success("Approved - execution continuing");
			} else {
				toast.error("Failed to send approval");
			}
		} finally {
			setIsSubmittingApproval(false);
		}
	};

	const handleReject = async () => {
		setIsSubmittingApproval(true);
		try {
			// Track rejection in history
			if (state.pendingApproval) {
				approvalHistoryRef.current.push({
					approvalId: `approval-${Date.now()}`,
					stepId: currentStep?.id || "unknown",
					stepDescription: state.pendingApproval.reason,
					riskLevel: state.plan?.riskLevel || "medium",
					requestedAt: new Date().toISOString(),
					decidedAt: new Date().toISOString(),
					approved: false,
					feedback: "Rejected by user",
				});
			}

			const success = await sendApproval(false, "Rejected by user");
			if (success) {
				toast.info("Rejected - execution stopped");
			} else {
				toast.error("Failed to send rejection");
			}
		} finally {
			setIsSubmittingApproval(false);
		}
	};

	// Parse risk level from approval reason
	const parseApprovalReason = (reason: string) => {
		const riskMatch = reason.match(/^(LOW|MEDIUM|HIGH|CRITICAL) RISK:/i);
		const riskLevel = riskMatch ? riskMatch[1].toUpperCase() : "MEDIUM";
		const description = riskMatch
			? reason.replace(/^(LOW|MEDIUM|HIGH|CRITICAL) RISK:\s*/i, "")
			: reason;
		return { riskLevel, description };
	};

	const handleApprovalFeedback = async (feedback: string) => {
		if (!feedback.trim()) {
			return;
		}
		setIsSubmittingApproval(true);

		// Track feedback rejection in history
		if (state.pendingApproval) {
			approvalHistoryRef.current.push({
				approvalId: `approval-${Date.now()}`,
				stepId: currentStep?.id || "unknown",
				stepDescription: state.pendingApproval.reason || "Unknown",
				riskLevel: state.plan?.riskLevel || "medium",
				requestedAt: new Date().toISOString(),
				decidedAt: new Date().toISOString(),
				approved: false,
				feedback: feedback.trim(),
			});
		}

		const success = await sendApproval(false, feedback.trim());
		setIsSubmittingApproval(false);
		if (success) {
			toast.info("Feedback sent - execution will adjust");
		} else {
			toast.error("Failed to send feedback");
		}
	};

	// Quick suggestion chips for welcome screen
	const quickSuggestions = [
		{
			label: "Plan",
			icon: <NotebookPen className="h-4 w-4" />,
			value: "Help me plan a new feature",
		},
		{
			label: "Query",
			icon: <Search className="h-4 w-4" />,
			value: "Query my connected services",
		},
		{
			label: "Document",
			icon: <ScrollText className="h-4 w-4" />,
			value: "Generate documentation",
		},
		{
			label: "Tasks",
			icon: <SquareCheckBig className="h-4 w-4" />,
			value: "Create tasks in my project management tool",
		},
	];

	const handleSuggestionClick = (value: string) => {
		setInput(value);
		inputRef.current?.focus();
	};

	const focusedAgentSuggestions = [
		{
			label: "Capabilities",
			icon: <Search className="h-4 w-4" />,
			value: `Show me what ${_agentName} can help with`,
		},
		{
			label: "Best Input",
			icon: <NotebookPen className="h-4 w-4" />,
			value: `What is the best way to prompt ${_agentName}?`,
		},
		{
			label: "Example",
			icon: <ScrollText className="h-4 w-4" />,
			value: `Give me an example task for ${_agentName}`,
		},
		{
			label: "Try Task",
			icon: <SquareCheckBig className="h-4 w-4" />,
			value: `Use ${_agentName} to help me with this task`,
		},
	];

	const welcomeTitle =
		welcomeMode === "focused-agent"
			? `Work with ${_agentName}`
			: "What do you want to get done?";
	const welcomeSubtitle =
		welcomeMode === "focused-agent"
			? _agentDescription ||
				"Fabric will keep this run focused on the selected external agent and its capabilities."
			: "Ask Fabric to plan, research, generate, and coordinate work across your tools.";
	// Use agent-configured starter messages if available, otherwise defaults
	const agentSuggestions =
		agentStarterMessages && agentStarterMessages.length > 0
			? agentStarterMessages.map((msg) => ({
					label: msg.label,
					icon: <span className="text-sm">{msg.emoji}</span>,
					value: msg.prompt,
				}))
			: null;

	const welcomeSuggestions =
		agentSuggestions ??
		(welcomeMode === "focused-agent"
			? focusedAgentSuggestions
			: quickSuggestions);
	const welcomeTips =
		welcomeMode === "focused-agent"
			? [
					{
						text: "This workspace runs through the Temporal orchestrator, but delegation is constrained to the selected agent.",
					},
				]
			: [
					{
						text: "Runs keep plan state, approvals, and execution history together.",
					},
				];

	return (
		<div className="flex h-full overflow-hidden">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* Messages Area */}
				{messages.length === 0 && completedExecutions.length === 0 ? (
					<ChatWelcome
						title={welcomeTitle}
						subtitle={welcomeSubtitle}
						suggestions={welcomeSuggestions}
						categories={[]} // No categories for orchestrator - keep it focused
						onSuggestionClick={handleSuggestionClick}
						tips={welcomeTips}
					/>
				) : (
					<Conversation className="flex-1">
						<ConversationContent className="space-y-4 max-w-4xl mx-auto px-3 sm:px-4 py-4 overflow-x-hidden">
							{/* Carried-over context banner (shown for conversations created
								via "Continue in new chat" handoff). Renders the parent's
								exhaustion-synthesis summary as a collapsed banner so the
								message list itself stays clean. */}
							{conversationData?.carriedOverSummary && (
								<CarriedOverContextBanner
									summary={
										conversationData.carriedOverSummary
									}
									carriedOverAt={
										conversationData.carriedOverAt ?? null
									}
								/>
							)}
							{state.contextCompactions.length > 0 && (
								<ContextCompactionNotice
									compactions={state.contextCompactions}
								/>
							)}
							{/* Completed executions - each with its user message followed by step-by-step results */}
							{completedExecutions
								.filter(
									(e) => e != null && e.userMessage != null,
								)
								.map((execution) => (
									<div
										key={execution.id}
										className="space-y-4"
									>
										{/* User's question */}
										<Message from="user" className="py-2">
											<MessageContent
												variant="flat"
												className="max-w-[70%]"
											>
												{execution.imageUrls &&
													execution.imageUrls.length >
														0 && (
														<div className="flex gap-2 mb-2 flex-wrap">
															{execution.imageUrls.map(
																(url) => (
																	<button
																		key={
																			url
																		}
																		type="button"
																		onClick={() =>
																			setLightboxImageUrl(
																				storagePathToProxyUrl(
																					url,
																					organizationId,
																				),
																			)
																		}
																		className="cursor-pointer"
																	>
																		<Image
																			src={storagePathToProxyUrl(
																				url,
																				organizationId,
																			)}
																			alt="Attached"
																			width={
																				80
																			}
																			height={
																				80
																			}
																			unoptimized
																			className="h-20 w-20 rounded-md border object-cover transition-shadow hover:ring-2 hover:ring-primary"
																		/>
																	</button>
																),
															)}
														</div>
													)}
												<Response>
													{execution.userMessage}
												</Response>
											</MessageContent>
											<MessageAvatar
												src={userAvatarSrc}
												name={userDisplayName}
											/>
										</Message>

										{/* Execution Plan (if available) */}
										{execution.plan &&
											execution.plan.steps.length > 0 && (
												<div className="flex gap-3">
													<div className="shrink-0">
														<FabricLogo
															className="h-8 w-8"
															size={32}
														/>
													</div>
													<div className="flex-1 min-w-0">
														<Plan
															title="Execution Plan"
															description={
																execution.plan
																	.description ||
																undefined
															}
															defaultCollapsed={
																true
															}
															steps={execution.plan.steps.map(
																(
																	step,
																): PlanStep => ({
																	id: step.id,
																	title: step.description,
																	description:
																		step.executor
																			? `Assigned to: ${
																					AGENT_DISPLAY_INFO[
																						step.executor as keyof typeof AGENT_DISPLAY_INFO
																					]
																						?.name ||
																					step.executor
																				}`
																			: undefined,
																	status: "completed" as PlanStepStatus,
																}),
															)}
														/>
													</div>
												</div>
											)}

										{/* Step-by-step execution results */}
										<div className="flex gap-3">
											<div className="shrink-0">
												<FabricLogo
													className="h-8 w-8"
													size={32}
												/>
											</div>
											<div className="flex-1 min-w-0 space-y-4 overflow-hidden">
												{execution.stepResults.map(
													(result, resultIdx) => {
														const isLastStep =
															resultIdx ===
															execution
																.stepResults
																.length -
																1;

														return (
															<div
																key={
																	result.stepId
																}
																className="space-y-3"
															>
																{/* Step description header */}
																{execution
																	.stepResults
																	.length >
																	1 && (
																	<div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
																		{result.status ===
																		"error" ? (
																			<AlertCircle className="h-3.5 w-3.5 text-destructive" />
																		) : (
																			<CheckCircle2 className="h-3.5 w-3.5 text-success" />
																		)}
																		<span className="font-medium">
																			Step{" "}
																			{resultIdx +
																				1}
																			:
																		</span>
																		<span>
																			{
																				result.stepDescription
																			}
																		</span>
																	</div>
																)}

																{/* Tool calls - collapsible section */}
																{result
																	.toolCalls
																	.length >
																	0 && (
																	<Collapsible
																		defaultOpen={
																			false
																		}
																	>
																		<CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer py-1 group">
																			<ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
																			<Wrench className="h-3 w-3" />
																			<span>
																				{
																					result
																						.toolCalls
																						.length
																				}{" "}
																				tool
																				call
																				{result
																					.toolCalls
																					.length !==
																				1
																					? "s"
																					: ""}
																			</span>
																		</CollapsibleTrigger>
																		<CollapsibleContent>
																			<ToolCallList
																				toolCalls={result.toolCalls.map(
																					(
																						tc,
																						idx,
																					): ToolCallItem => ({
																						id: `${execution.id}-${result.stepId}-${idx}`,
																						name: tc.name,
																						args: tc.args,
																						result: tc.result,
																						status: tc.status,
																						error:
																							tc.status ===
																							"error"
																								? String(
																										tc.result,
																									)
																								: undefined,
																					}),
																				)}
																				defaultOpen={
																					false
																				}
																				getInputSummary={(
																					args,
																				) =>
																					getToolInputSummary(
																						args as Record<
																							string,
																							unknown
																						>,
																					)
																				}
																				activeFrameId={
																					activeFrame?.frameId
																				}
																				onOpenFrame={
																					openFrame
																				}
																			/>
																		</CollapsibleContent>
																	</Collapsible>
																)}

																{/* MCP App interactive UIs — persisted tool calls rendered after page refresh */}
																{result.toolCalls
																	.filter(
																		(tc) =>
																			(
																				tc as any
																			)
																				.mcpAppResourceUri &&
																			(
																				tc as any
																			)
																				.mcpAppConfigId &&
																			tc.status ===
																				"success",
																	)
																	.map(
																		(
																			tc,
																		) => (
																			<div
																				key={`completed-${execution.id}-${result.stepId}-${tc.id}`}
																			>
																				<McpAppFrame
																					resourceUri={
																						(
																							tc as any
																						)
																							.mcpAppResourceUri
																					}
																					configId={
																						(
																							tc as any
																						)
																							.mcpAppConfigId
																					}
																					organizationId={
																						organizationId
																					}
																					toolArgs={
																						tc.args as Record<
																							string,
																							unknown
																						>
																					}
																					toolResult={
																						tc.result
																					}
																					className="mt-3"
																				/>
																				<ExcalidrawAutoInsertSlot
																					toolCall={{
																						id: tc.id,
																						mcpAppResourceUri:
																							(
																								tc as any
																							)
																								.mcpAppResourceUri,
																						mcpAppConfigId:
																							(
																								tc as any
																							)
																								.mcpAppConfigId,
																						args: tc.args,
																						result: tc.result,
																					}}
																					chatMessageId={`${execution.id}-${result.stepId}-${tc.id}`}
																					chatScope={
																						excalidrawAutoInsertChatScope
																					}
																					organizationSlug={
																						organizationSlug
																					}
																				/>
																			</div>
																		),
																	)}

																{/* Step response: last step shows prominently, others in collapsed Reasoning */}
																{result.response && (
																	<div>
																		{isLastStep ? (
																			// Final answer - show prominently
																			<Response
																				className={
																					ASSISTANT_RESPONSE_SHELL_CLASSNAME
																				}
																			>
																				{stripPersistedAssistantLabelPrefix(
																					result.response,
																				)}
																			</Response>
																		) : (
																			// Intermediate step - show in collapsed Reasoning
																			<Reasoning
																				isStreaming={
																					false
																				}
																				duration={
																					result.durationMs
																						? Math.ceil(
																								result.durationMs /
																									1000,
																							)
																						: undefined
																				}
																			>
																				<ReasoningTrigger />
																				<ReasoningContent>
																					{stripPersistedAssistantLabelPrefix(
																						result.response,
																					)}
																				</ReasoningContent>
																			</Reasoning>
																		)}
																	</div>
																)}
															</div>
														);
													},
												)}

												{/* Chart artifacts from execution.artifacts (fallback for persisted charts) */}
												{execution.artifacts
													?.filter(
														(a) =>
															a.type ===
																"chart" &&
															a.content,
													)
													.map((artifact) => {
														try {
															const chartData =
																JSON.parse(
																	artifact.content ||
																		"{}",
																);
															if (
																isChartArtifact(
																	chartData,
																)
															) {
																return (
																	<ChartCard
																		key={
																			artifact.id
																		}
																		artifact={
																			chartData
																		}
																	/>
																);
															}
														} catch (e) {
															console.error(
																"[FabricChat] Failed to parse chart artifact:",
																e,
															);
														}
														return null;
													})}

												{/* Fallback: show response if no step results have it AND no document artifacts */}
												{execution.response &&
													!execution.stepResults.some(
														(s) => s.response,
													) &&
													!hasDocumentArtifacts(
														execution.stepResults,
													) && (
														<Response
															className={
																ASSISTANT_RESPONSE_SHELL_CLASSNAME
															}
														>
															{stripPersistedAssistantLabelPrefix(
																execution.response,
															)}
														</Response>
													)}
											</div>
										</div>
									</div>
								))}

							{/* Current user message (only if not in completedExecutions) */}
							{messages
								.filter((m) => m.role === "user")
								.map((message) => {
									// Skip if this message is already shown in a completed execution
									if (
										completedExecutions.some(
											(e) =>
												e != null &&
												e.userMessage ===
													message.content,
										)
									) {
										return null;
									}
									return (
										<Message
											key={message.id}
											from="user"
											className="py-2"
										>
											<MessageContent
												variant="flat"
												className="max-w-[70%]"
											>
												{message.imageUrls &&
													message.imageUrls.length >
														0 && (
														<div className="flex gap-2 mb-2 flex-wrap">
															{message.imageUrls.map(
																(url) => (
																	<button
																		key={
																			url
																		}
																		type="button"
																		onClick={() =>
																			setLightboxImageUrl(
																				storagePathToProxyUrl(
																					url,
																					organizationId,
																				),
																			)
																		}
																		className="cursor-pointer"
																	>
																		<Image
																			src={storagePathToProxyUrl(
																				url,
																				organizationId,
																			)}
																			alt="Attached"
																			width={
																				80
																			}
																			height={
																				80
																			}
																			unoptimized
																			className="h-20 w-20 rounded-md border object-cover transition-shadow hover:ring-2 hover:ring-primary"
																		/>
																	</button>
																),
															)}
														</div>
													)}
												<Response>
													{message.content}
												</Response>
											</MessageContent>
											<MessageAvatar
												src={userAvatarSrc}
												name={userDisplayName}
											/>
										</Message>
									);
								})}

							{/* Execution Plan - Show when plan is available and not yet completed */}
							{state.plan &&
								state.plan.steps.length > 0 &&
								!completedExecutions.some(
									(e) =>
										e != null && e.id === state.executionId,
								) && (
									<div className="flex gap-3">
										<div className="shrink-0">
											<FabricLogo
												className="h-8 w-8"
												size={32}
											/>
										</div>
										<div className="flex-1 min-w-0 space-y-4">
											<Plan
												title="Execution Plan"
												description={
													state.plan.description ||
													undefined
												}
												defaultCollapsed={
													!state.plan.steps.some(
														(s) =>
															s.status ===
																"in_progress" ||
															s.status ===
																"awaiting_approval",
													)
												}
												steps={state.plan.steps.map(
													(step): PlanStep => ({
														id: step.id,
														title: step.description,
														description:
															step.executor
																? `Assigned to: ${
																		AGENT_DISPLAY_INFO[
																			step.executor as keyof typeof AGENT_DISPLAY_INFO
																		]
																			?.name ||
																		step.executor
																	}`
																: undefined,
														status: (step.status ===
														"complete"
															? "completed"
															: step.status ===
																		"in_progress" ||
																	step.status ===
																		"awaiting_approval"
																? "in-progress"
																: step.status ===
																			"error" ||
																		step.status ===
																			"skipped"
																	? "failed"
																	: "pending") as PlanStepStatus,
													}),
												)}
											/>
										</div>
									</div>
								)}

							{/* Step Results - Sequential: each step shows tool calls then response */}
							{/* Don't render if execution is complete AND already in completedExecutions (to avoid duplication) */}
							{(stepResults.length > 0 ||
								streamingToolCalls.length > 0 ||
								effectiveCurrentStep) &&
								!completedExecutions.some(
									(e) =>
										e != null && e.id === state.executionId,
								) && (
									<div className="flex gap-3">
										<div className="shrink-0">
											<FabricLogo
												className="h-8 w-8"
												size={32}
											/>
										</div>
										<div className="flex-1 min-w-0 space-y-4 overflow-hidden">
											{/* Completed steps - each with its tool calls then response */}
											{stepResults.map(
												(result, resultIdx) => {
													// Look up executor from the plan
													const planStep =
														state.plan?.steps.find(
															(s) =>
																s.id ===
																result.stepId,
														);
													let executor =
														planStep?.executor;

													// If no executor from plan, try to extract from delegate tool call
													if (!executor) {
														const delegateCall =
															result.toolCalls.find(
																(tc) =>
																	tc.name.startsWith(
																		"delegate:",
																	),
															);
														if (delegateCall) {
															executor =
																delegateCall.name.replace(
																	"delegate:",
																	"",
																);
														}
													}

													// Check if there was a delegation error
													const delegationError =
														result.toolCalls.find(
															(tc) =>
																tc.name.startsWith(
																	"delegate:",
																) &&
																tc.status ===
																	"error",
														);

													// Is this the last step?
													const isLastStep =
														resultIdx ===
														stepResults.length - 1;

													return (
														<div
															key={result.stepId}
															className="space-y-3"
														>
															{/* Step description header */}
															{stepResults.length >
																1 && (
																<div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
																	{result.status ===
																	"error" ? (
																		<AlertCircle className="h-3.5 w-3.5 text-destructive" />
																	) : (
																		<CheckCircle2 className="h-3.5 w-3.5 text-success" />
																	)}
																	<span className="font-medium">
																		Step{" "}
																		{resultIdx +
																			1}
																		:
																	</span>
																	<span>
																		{
																			result.stepDescription
																		}
																	</span>
																	{executor && (
																		<span
																			className={cn(
																				"px-1.5 py-0.5 rounded text-[10px] font-medium",
																				delegationError
																					? "bg-red-100 dark:bg-red-900/30 text-destructive/80"
																					: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300",
																			)}
																		>
																			{delegationError
																				? `${executor} (fallback)`
																				: executor}
																		</span>
																	)}
																</div>
															)}

															{/* CUGA-specific execution view */}
															{executor ===
																"cuga_generalist" &&
																result.toolCalls.some(
																	(tc) =>
																		tc.name.includes(
																			"cuga",
																		) ||
																		tc.name.includes(
																			"browser",
																		),
																) && (
																	<CugaExecutionView
																		state={
																			{
																				status:
																					result.status ===
																					"complete"
																						? "complete"
																						: result.status ===
																								"error"
																							? "failed"
																							: "executing",
																				subtasks:
																					[],
																				variables:
																					{},
																				codeExecutions:
																					[],
																				hitlRequests:
																					[],
																				// Don't pass finalAnswer - the orchestrator shows the response in its own format below
																				finalAnswer:
																					undefined,
																				error:
																					result.status ===
																					"error"
																						? result.response
																						: undefined,
																			} satisfies CugaExecutionState
																		}
																		onHitlRespond={async () => {}}
																		className="mt-2"
																	/>
																)}

															{/* Tool calls - collapsible section */}
															{result.toolCalls
																.length > 0 && (
																<Collapsible
																	defaultOpen={
																		false
																	}
																>
																	<CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer py-1 group">
																		<ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
																		<Wrench className="h-3 w-3" />
																		<span>
																			{
																				result
																					.toolCalls
																					.length
																			}{" "}
																			tool
																			call
																			{result
																				.toolCalls
																				.length !==
																			1
																				? "s"
																				: ""}
																		</span>
																	</CollapsibleTrigger>
																	<CollapsibleContent>
																		<ToolCallList
																			toolCalls={result.toolCalls.map(
																				(
																					tc,
																					idx,
																				): ToolCallItem => ({
																					id: `${result.stepId}-${idx}`,
																					name: tc.name,
																					args: tc.args,
																					result: tc.result,
																					status: tc.status,
																					error:
																						tc.status ===
																						"error"
																							? String(
																									tc.result,
																								)
																							: undefined,
																				}),
																			)}
																			defaultOpen={
																				false
																			}
																			getInputSummary={(
																				args,
																			) =>
																				getToolInputSummary(
																					args as Record<
																						string,
																						unknown
																					>,
																				)
																			}
																			activeFrameId={
																				activeFrame?.frameId
																			}
																			onOpenFrame={
																				openFrame
																			}
																		/>
																	</CollapsibleContent>
																</Collapsible>
															)}

															{/* MCP App interactive UIs — rendered inline for tool calls with ui:// resource URIs */}
															{result.toolCalls
																.filter(
																	(tc) =>
																		tc.mcpAppResourceUri &&
																		tc.mcpAppConfigId &&
																		tc.status !==
																			"error",
																)
																.map((tc) => {
																	if (
																		!tc.mcpAppResourceUri ||
																		!tc.mcpAppConfigId
																	) {
																		return null;
																	}

																	return (
																		<div
																			key={
																				tc.id
																			}
																		>
																			<McpAppFrame
																				resourceUri={
																					tc.mcpAppResourceUri
																				}
																				configId={
																					tc.mcpAppConfigId
																				}
																				organizationId={
																					organizationId
																				}
																				toolArgs={
																					tc.args as Record<
																						string,
																						unknown
																					>
																				}
																				toolResult={
																					tc.result
																				}
																				className="mt-3"
																			/>
																			<ExcalidrawAutoInsertSlot
																				toolCall={{
																					id: tc.id,
																					mcpAppResourceUri:
																						tc.mcpAppResourceUri,
																					mcpAppConfigId:
																						tc.mcpAppConfigId,
																					args: tc.args,
																					result: tc.result,
																				}}
																				chatMessageId={`${state.executionId ?? "active"}-${result.stepId}-${tc.id}`}
																				chatScope={
																					excalidrawAutoInsertChatScope
																				}
																				organizationSlug={
																					organizationSlug
																				}
																			/>
																		</div>
																	);
																})}

															{/* Step response:
											    - For last step when complete: show prominently as the final answer
											    - For other steps: show in collapsed Reasoning component */}
															{result.response && (
																<div
																	ref={
																		isLastStep
																			? lastStepRef
																			: undefined
																	}
																>
																	{isLastStep &&
																	isComplete ? (
																		// Final answer - show prominently
																		<Response
																			className={
																				ASSISTANT_RESPONSE_SHELL_CLASSNAME
																			}
																		>
																			{
																				result.response
																			}
																		</Response>
																	) : (
																		// Intermediate step - show in collapsed Reasoning
																		<Reasoning
																			isStreaming={
																				false
																			}
																			duration={
																				result.durationMs
																					? Math.ceil(
																							result.durationMs /
																								1000,
																						)
																					: undefined
																			}
																		>
																			<ReasoningTrigger />
																			<ReasoningContent>
																				{
																					result.response
																				}
																			</ReasoningContent>
																		</Reasoning>
																	)}
																</div>
															)}
														</div>
													);
												},
											)}

											{/* Loading indicator between steps - show when running but no current step */}
											{isRunning &&
												!effectiveCurrentStep &&
												stepResults.length > 0 &&
												completedSteps < totalSteps && (
													<div className="flex items-center gap-2 text-xs text-muted-foreground pl-6 py-2">
														<div className="flex items-center gap-1">
															<div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce [animation-delay:0ms]" />
															<div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce [animation-delay:150ms]" />
															<div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce [animation-delay:300ms]" />
														</div>
														<span>
															Preparing next
															step...
														</span>
													</div>
												)}

											{/* Current step being executed - show streaming tool calls */}
											{effectiveCurrentStep && (
												<div className="space-y-3">
													{/* Current step header */}
													<div className="flex items-center gap-2 text-xs text-muted-foreground">
														<Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
														<span className="font-medium">
															Step{" "}
															{completedSteps + 1}
															:
														</span>
														<span>
															{
																effectiveCurrentStep.description
															}
														</span>
													</div>

													{/* Streaming tool calls - collapsible section */}
													{streamingToolCalls.length >
														0 && (
														<Collapsible
															defaultOpen={false}
														>
															<CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer py-1 group">
																<ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
																<Wrench className="h-3 w-3" />
																<span>
																	{
																		streamingToolCalls.length
																	}{" "}
																	tool call
																	{streamingToolCalls.length !==
																	1
																		? "s"
																		: ""}
																</span>
															</CollapsibleTrigger>
															<CollapsibleContent>
																<ToolCallList
																	toolCalls={streamingToolCalls.map(
																		(
																			tc,
																			idx,
																		): ToolCallItem => ({
																			id: `streaming-tool-${idx}-${tc.id}`,
																			name: tc.name,
																			args: tc.args,
																			result: tc.result,
																			status: tc.status,
																			error:
																				tc.status ===
																				"error"
																					? String(
																							tc.result,
																						)
																					: undefined,
																		}),
																	)}
																	defaultOpen={
																		false
																	}
																	getInputSummary={(
																		args,
																	) =>
																		getToolInputSummary(
																			args as Record<
																				string,
																				unknown
																			>,
																		)
																	}
																	activeFrameId={
																		activeFrame?.frameId
																	}
																	onOpenFrame={
																		openFrame
																	}
																/>
															</CollapsibleContent>
														</Collapsible>
													)}

													{/* MCP App interactive UIs — rendered during streaming for immediate feedback */}
													{streamingToolCalls
														.filter(
															(tc) =>
																tc.mcpAppResourceUri &&
																tc.mcpAppConfigId &&
																tc.status !==
																	"error",
														)
														.map((tc) => {
															if (
																!tc.mcpAppResourceUri ||
																!tc.mcpAppConfigId
															) {
																return null;
															}

															return (
																<div
																	key={`streaming-${tc.id}`}
																>
																	<McpAppFrame
																		resourceUri={
																			tc.mcpAppResourceUri
																		}
																		configId={
																			tc.mcpAppConfigId
																		}
																		organizationId={
																			organizationId
																		}
																		toolArgs={
																			tc.args as Record<
																				string,
																				unknown
																			>
																		}
																		toolResult={
																			tc.result
																		}
																		className="mt-3"
																	/>
																	<ExcalidrawAutoInsertSlot
																		toolCall={{
																			id: tc.id,
																			mcpAppResourceUri:
																				tc.mcpAppResourceUri,
																			mcpAppConfigId:
																				tc.mcpAppConfigId,
																			args: tc.args,
																			result: tc.result,
																		}}
																		chatMessageId={`streaming-${tc.id}`}
																		chatScope={
																			excalidrawAutoInsertChatScope
																		}
																		organizationSlug={
																			organizationSlug
																		}
																	/>
																</div>
															);
														})}

													{/* Show Reasoning component with thinking state while step is executing */}
													<Reasoning
														isStreaming={true}
													>
														<ReasoningTrigger />
														<ReasoningContent>{`Processing step: ${effectiveCurrentStep.description}`}</ReasoningContent>
													</Reasoning>
												</div>
											)}

											{/* Note: Final response is shown in the last step's Reasoning component above.
									    We don't show a separate final response section to avoid duplication. */}
										</div>
									</div>
								)}

							{/* MCP App UIs that persist beyond step completion.
						     Streaming tool calls with mcpAppResourceUri are kept alive after
						     step_complete to avoid unmount/remount of the iframe.
						     This section renders them when effectiveCurrentStep is null
						     (step completed but streaming McpAppFrame should stay visible). */}
							{!effectiveCurrentStep &&
								streamingToolCalls.filter(
									(tc) =>
										tc.mcpAppResourceUri &&
										tc.mcpAppConfigId &&
										tc.status !== "error",
								).length > 0 && (
									<div className="space-y-3">
										{streamingToolCalls
											.filter(
												(tc) =>
													tc.mcpAppResourceUri &&
													tc.mcpAppConfigId &&
													tc.status !== "error",
											)
											.map((tc) => {
												if (
													!tc.mcpAppResourceUri ||
													!tc.mcpAppConfigId
												) {
													return null;
												}
												return (
													<div
														key={`persist-${tc.id}`}
													>
														<McpAppFrame
															resourceUri={
																tc.mcpAppResourceUri
															}
															configId={
																tc.mcpAppConfigId
															}
															organizationId={
																organizationId
															}
															toolArgs={
																tc.args as Record<
																	string,
																	unknown
																>
															}
															toolResult={
																tc.result
															}
															className="mt-3"
														/>
														<ExcalidrawAutoInsertSlot
															toolCall={{
																id: tc.id,
																mcpAppResourceUri:
																	tc.mcpAppResourceUri,
																mcpAppConfigId:
																	tc.mcpAppConfigId,
																args: tc.args,
																result: tc.result,
															}}
															chatMessageId={`persist-${tc.id}`}
															chatScope={
																excalidrawAutoInsertChatScope
															}
															organizationSlug={
																organizationSlug
															}
														/>
													</div>
												);
											})}
									</div>
								)}

							{/* Streaming text + sticky phase indicator below */}
							{isRunning &&
								(() => {
									const streamingMsg = messages.find(
										(m) =>
											m.role === "assistant" &&
											m.isStreaming &&
											m.content,
									);
									const hasStreamingText =
										!!streamingMsg?.content;
									const showPhaseIndicator =
										currentPhase &&
										currentPhase !== "complete" &&
										currentPhase !== "error" &&
										// Hide phase indicator once all planned steps are complete
										!(
											totalSteps > 0 &&
											completedSteps >= totalSteps
										);
									// Show this section when there's streaming text or an active phase indicator
									if (
										!hasStreamingText &&
										!showPhaseIndicator
									) {
										return null;
									}
									return (
										<div className="flex gap-3">
											<div className="shrink-0">
												<FabricLogo
													className="h-8 w-8"
													size={32}
												/>
											</div>
											<div className="flex-1 min-w-0 space-y-2">
												{/* Streaming LLM response text */}
												{hasStreamingText && (
													<Response
														className={
															ASSISTANT_RESPONSE_SHELL_CLASSNAME
														}
														streaming
													>
														{streamingMsg.content}
													</Response>
												)}
												{/* Phase indicator - shows below text after it finishes, or with dots when waiting */}
												{showPhaseIndicator && (
													<div className="flex items-center gap-3">
														<PhaseIndicator
															phase={currentPhase}
															showDots={
																!hasStreamingText
															}
															message={
																progressMessage
															}
														/>
														{totalSteps > 0 && (
															<span className="text-xs text-muted-foreground">
																{completedSteps}{" "}
																/ {totalSteps}{" "}
																steps
															</span>
														)}
													</div>
												)}
											</div>
										</div>
									);
								})()}

							{/* Fizzy #962: Surface AI token-budget / provider-limit exhaustion
							    events so the user knows when a run was truncated or soft-degraded. */}
							{state.limitSignals.length > 0 &&
								Array.from(
									new Map(
										state.limitSignals.map((s) => [
											s.kind,
											s,
										]),
									).values(),
								).map((signal) => (
									<div
										key={signal.kind}
										className="flex gap-3"
									>
										<div className="shrink-0">
											<FabricLogo
												className="h-8 w-8"
												size={32}
											/>
										</div>
										<div className="flex-1 min-w-0">
											<LimitBanner
												signal={signal}
												canManageBilling={
													canManageBilling
												}
												organizationSlug={
													organizationSlug
												}
											/>
										</div>
									</div>
								))}

							{/* Direct response without tool calls - Show when LLM returns a response directly
						    (e.g., clarifying questions, simple answers) without executing any tools */}
							{isComplete &&
								stepResults.length === 0 &&
								state.result?.response &&
								!completedExecutions.some(
									(e) =>
										e != null && e.id === state.executionId,
								) && (
									<div className="flex gap-3">
										<div className="shrink-0">
											<FabricLogo
												className="h-8 w-8"
												size={32}
											/>
										</div>
										<div className="flex-1 min-w-0">
											<Response
												className={
													ASSISTANT_RESPONSE_SHELL_CLASSNAME
												}
											>
												{state.result.response}
											</Response>
										</div>
									</div>
								)}

							{/* Stopped assistant message — rendered when the
							 * user halted the active turn (spec § 4.2 / 8.9).
							 * The streaming-text branch above hides once
							 * `isRunning` flips to false, so the cancelled
							 * partial would otherwise vanish. We re-surface
							 * any assistant message with
							 * `streamStatus === "cancelled"` that hasn't
							 * been moved into `completedExecutions` yet. */}
							{messages
								.filter(
									(m) =>
										m.role === "assistant" &&
										m.streamStatus === "cancelled" &&
										!completedExecutions.some(
											(e) =>
												e != null &&
												e.userMessage != null &&
												e.id === state.executionId,
										),
								)
								.map((cancelledMessage) => (
									<div
										key={`cancelled-${cancelledMessage.id}`}
										className="flex gap-3"
									>
										<div className="shrink-0">
											<FabricLogo
												className="h-8 w-8"
												size={32}
											/>
										</div>
										<div className="flex-1 min-w-0">
											{cancelledMessage.content && (
												<Response
													className={
														ASSISTANT_RESPONSE_SHELL_CLASSNAME
													}
												>
													{cancelledMessage.content}
												</Response>
											)}
											{/* Editorial "Stopped" chip — rendered at
											 * the end of the cancelled turn
											 * (spec § 4.2 / 8.9). */}
											<StoppedIndicator />
										</div>
									</div>
								))}

							{/* Approval request - using ApprovalDialog with full task plan */}
							{isAwaitingApproval &&
								state.pendingApproval &&
								(() => {
									const { riskLevel, description } =
										parseApprovalReason(
											state.pendingApproval.reason,
										);
									return (
										<div className="flex gap-3">
											<div className="shrink-0">
												<FabricLogo
													className="h-8 w-8"
													size={32}
												/>
											</div>
											<div className="flex-1">
												<ApprovalDialog
													stepId={
														state.pendingApproval
															.stepId
													}
													description={description}
													riskLevel={riskLevel}
													onApprove={handleApprove}
													onReject={handleReject}
													onFeedback={
														handleApprovalFeedback
													}
													isSubmitting={
														isSubmittingApproval
													}
													plan={state.plan}
													currentStepId={
														effectiveCurrentStep?.id
													}
												/>
											</div>
										</div>
									);
								})()}

							{/* Clarifying question (HITL) — sibling of the
							 * approval request above. The orchestrator pauses
							 * before planning when the request is materially
							 * ambiguous. Reuses the same ClarifyingQuestionCard the
							 * document agents use; answering or dismissing signals
							 * the workflow via `sendClarification`, resuming the
							 * paused orchestration. Gated on `pendingClarification`
							 * alone (mutually exclusive with `pendingApproval` —
							 * both set the `awaiting_approval` status). The
							 * `clarificationId` key re-mounts the card for a fresh
							 * question so its internal resolved state resets. */}
							{state.pendingClarification && (
								<div className="flex gap-3">
									<div className="shrink-0">
										<FabricLogo
											className="h-8 w-8"
											size={32}
										/>
									</div>
									<div className="flex-1">
										<ClarifyingQuestionCard
											key={
												state.pendingClarification
													.clarificationId
											}
											question={
												state.pendingClarification
													.question
											}
											options={
												state.pendingClarification
													.options
											}
											onAnswer={({ answer }) => {
												void sendClarification(
													answer,
													false,
												);
											}}
											onDismiss={() => {
												void sendClarification(
													"",
													true,
												);
											}}
										/>
									</div>
								</div>
							)}
						</ConversationContent>
						<ConversationScrollButton />
					</Conversation>
				)}

				{/* Input Area - Using shared ChatInput component */}
				<div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-2 sm:p-4">
					<div className="max-w-4xl mx-auto min-w-0">
						{/* "Continue in new chat" handoff CTA. Renders above the
							input when the orchestrator hit its hard token-budget cap
							and produced an exhaustion synthesis. Clicking creates a
							sibling conversation pre-seeded with the summary as
							carried-over context, then navigates the user there. */}
						{state.handoffRecommended && conversationId && (
							<ConversationHandoffCard
								parentConversationId={conversationId}
								reason={state.handoffRecommended.reason}
								summary={state.handoffRecommended.summary}
								organizationId={organizationId}
								onContinue={(newConversationId) => {
									onConversationCreated?.(newConversationId);
								}}
							/>
						)}
						<ChatInput
							ref={inputRef}
							value={input}
							onChange={setInput}
							onSend={handleSendMessage}
							onStop={handleStopFromButton}
							// Stop is visible while the workflow is paused on
							// `pendingApproval` (AC-9 / decision 20) — cancel
							// implicitly rejects the proposed step.
							pendingApproval={isAwaitingApproval}
							isLoading={isLoading}
							placeholder="Ask Fabric anything... (type @ to mention a template)"
							attachTooltip="Attach files"
							attachDisabled={false}
							onAttachClick={handleAttachClick}
							enableImagePaste={true}
							imageUploader={pastedImageUploader}
							onPasteNonImageFiles={onPasteNonImageFiles}
							topSlot={
								attachedImages.length > 0 ||
								attachedDocuments.length > 0 ? (
									<div className="space-y-2">
										{attachedImages.length > 0 && (
											<div className="flex flex-wrap gap-2 p-2">
												{attachedImages.map((img) => (
													<div
														key={img.id}
														className="relative group rounded-lg overflow-hidden border border-border bg-muted/50"
														style={{
															width: 72,
															height: 72,
														}}
													>
														{/* biome-ignore lint/performance/noImgElement: existing preview UI */}
														<img
															src={img.previewUrl}
															alt={img.name}
															className="w-full h-full object-cover"
														/>
														{img.status ===
															"uploading" && (
															<div className="absolute inset-0 bg-black/40 flex items-center justify-center">
																<Loader2 className="h-4 w-4 animate-spin text-white" />
															</div>
														)}
														{img.status ===
															"error" && (
															<div className="absolute inset-0 bg-red-500/40 flex items-center justify-center">
																<AlertCircle className="h-4 w-4 text-white" />
															</div>
														)}
														<button
															type="button"
															onClick={() =>
																removeAttachedImage(
																	img.id,
																)
															}
															className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
														>
															&times;
														</button>
													</div>
												))}
											</div>
										)}
										{attachedDocuments.length > 0 && (
											<CopilotSidebarAttachments
												files={attachedDocuments}
												onRemove={removeDocument}
												textareaRef={inputRef}
											/>
										)}
									</div>
								) : undefined
							}
							projectId={attachedProjectId ?? undefined}
							enableFileMentions={!!attachedProjectId}
							enableStoryMentions={!!attachedProjectId}
							enableUserMentions={!!organizationId}
							organizationId={organizationId}
							enableTemplateMentions={true}
							initialSelectedTemplates={sessionTemplates}
							onSelectedTemplatesChange={onSessionTemplatesChange}
							onMergedInstructionsChange={setTemplateInstructions}
							onMergedIntegrationIdsChange={
								setTemplateIntegrationIds
							}
							onMergedMcpConfigIdsChange={setTemplateMcpConfigIds}
							onMergedFabricToolIdsChange={
								setTemplateFabricToolIds
							}
							headerSlot={
								hasMounted && (
									<div className="flex flex-wrap items-center justify-between gap-2">
										{/* Rendered only when opted in, so the
										    surfaces that leave the picker off
										    keep this row's original layout. */}
										{showAgentPicker && (
											<div className="flex flex-wrap items-center gap-2">
												<AgentModelPicker
													selectedAgents={
														selectedAgent
															? [selectedAgent]
															: []
													}
													onToggleAgent={
														handleToggleAgent
													}
													organizationId={
														organizationId
													}
													catalog="models"
												/>
												{selectedAgent ? (
													<Badge
														variant="secondary"
														className="gap-1 rounded-full"
														title={
															activeModelOverride
																? undefined
																: "Chosen on Direct. An agent doesn't set the orchestrator's model — pick a model to change it."
														}
													>
														<RobotIcon className="h-3 w-3" />
														{selectedAgent.name}
														{/* An agent carries no
														    model of its own, so
														    it cannot drive this
														    engine. Labelled
														    rather than dropped:
														    vanishing reads as
														    the selection having
														    been lost. */}
														{!activeModelOverride && (
															<span className="text-muted-foreground">
																not applied
															</span>
														)}
														<button
															type="button"
															onClick={() =>
																handleToggleAgent(
																	selectedAgent,
																)
															}
															aria-label={`Clear ${selectedAgent.name}`}
															className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
														>
															<XIcon className="h-3 w-3" />
														</button>
													</Badge>
												) : null}
											</div>
										)}
										<ActiveContextIndicator
											workspaceIds={attachedWorkspaceIds}
											mcpConfigIds={
												selectedConversationMcpIds ??
												enabledToolIds ??
												undefined
											}
											agentIds={
												enabledAgentIds || undefined
											}
											fabricToolIds={
												enabledFabricToolIds ||
												undefined
											}
											integrationIds={
												enabledIntegrationIds ||
												undefined
											}
											projectId={attachedProjectId}
											prioritizedToolIds={
												prioritizedToolIds
											}
											prioritizedAgentIds={
												prioritizedAgentIds
											}
											prioritizedMcpConfigIds={
												prioritizedMcpConfigIds
											}
											prioritizedIntegrationIds={
												prioritizedIntegrationIds
											}
											onToolPrioritize={onToolPrioritize}
											onAgentPrioritize={
												onAgentPrioritize
											}
											onMcpPrioritize={onMcpPrioritize}
											onIntegrationPrioritize={
												onIntegrationPrioritize
											}
											organizationId={organizationId}
										/>
										{!lockConversationToolPicker && (
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() =>
													setConversationToolPickerOpen(
														true,
													)
												}
											>
												<Wrench className="mr-2 h-4 w-4" />
												Chat tools
											</Button>
										)}
										{(state.plan ||
											artifactSources.length > 0 ||
											documentArtifacts.length > 0) && (
											<ArtifactsPanelTrigger
												onClick={() =>
													setIsArtifactsPanelOpen(
														true,
													)
												}
												planSteps={
													state.plan?.steps.length ||
													0
												}
												completedSteps={completedSteps}
												documentsCount={
													documentArtifacts.length
												}
												sourcesCount={
													artifactSources.length
												}
												isActive={isArtifactsPanelOpen}
											/>
										)}
										<MemoryPanelTrigger
											onClick={() =>
												setIsMemoryPanelOpen(true)
											}
											isActive={isMemoryPanelOpen}
										/>
									</div>
								)
							}
						/>
					</div>
				</div>
			</div>
			{activeFrame ? (
				<InteractiveContentPanel
					frame={activeFrame}
					onClose={() => setActiveFrame(null)}
					organizationId={organizationId}
				/>
			) : lastFrame ? (
				<div className="flex shrink-0 items-center border-l border-border/70 bg-background/95 px-2">
					{/* The frame title is the button's visible label, so no
						`aria-label` here — one would replace that name. */}
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => setActiveFrame(lastFrame)}
								className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								<ChevronLeft className="h-3.5 w-3.5" />
								<span className="max-w-[120px] truncate">
									{lastFrame.title || "Frame"}
								</span>
							</button>
						</TooltipTrigger>
						<TooltipContent>
							{tooltipT("reopenFramePanel")}
						</TooltipContent>
					</Tooltip>
				</div>
			) : null}
			<ConversationToolPicker
				open={conversationToolPickerOpen}
				onOpenChange={
					lockConversationToolPicker
						? () => undefined
						: setConversationToolPickerOpen
				}
				organizationId={organizationId}
				selectedIds={selectedConversationMcpIds}
				onChange={
					lockConversationToolPicker
						? () => undefined
						: setSelectedConversationMcpIds
				}
			/>

			{/* Artifacts Panel */}
			<ArtifactsPanel
				isOpen={isArtifactsPanelOpen}
				onClose={() => setIsArtifactsPanelOpen(false)}
				plan={
					state.plan
						? {
								id: state.plan.id,
								description: state.plan.description,
								riskLevel: state.plan.riskLevel,
								steps: state.plan.steps.map((step) => ({
									id: step.id,
									description: step.description,
									status: step.status,
									order: step.order,
									executor: step.executor,
									riskLevel: step.riskLevel,
									requiresApproval: step.requiresApproval,
									durationMs: step.durationMs,
								})),
							}
						: (() => {
								// Restore plan from completed executions for persistence
								const lastExec =
									completedExecutions[
										completedExecutions.length - 1
									];
								const lastPlan = lastExec?.plan;
								if (!lastPlan) {
									return null;
								}
								return {
									id: lastPlan.id,
									description: lastPlan.description,
									riskLevel: lastPlan.riskLevel as
										| "low"
										| "medium"
										| "high"
										| "critical",
									steps: lastPlan.steps.map((s) => ({
										id: s.id,
										description: s.description,
										status: s.status as
											| "pending"
											| "in_progress"
											| "complete"
											| "error"
											| "skipped"
											| "awaiting_approval",
										order: s.order,
										executor: s.executor,
										riskLevel: s.riskLevel as
											| "low"
											| "medium"
											| "high"
											| "critical"
											| undefined,
										requiresApproval: s.requiresApproval,
										durationMs: undefined,
									})),
								};
							})()
				}
				currentStepId={effectiveCurrentStep?.id}
				completedSteps={
					state.plan
						? completedSteps
						: completedExecutions[completedExecutions.length - 1]
								?.plan?.steps.length || 0
				}
				totalSteps={
					state.plan
						? totalSteps
						: completedExecutions[completedExecutions.length - 1]
								?.plan?.steps.length || 0
				}
				documents={documentArtifacts}
				sources={artifactSources}
				defaultTab="plan"
			/>

			{/* Memory Panel */}
			<MemoryPanel
				isOpen={isMemoryPanelOpen}
				onClose={() => setIsMemoryPanelOpen(false)}
				organizationId={organizationId}
			/>

			{/* Connection Required Dialog */}
			<ConnectionRequiredDialog
				open={isConnectionDialogOpen}
				onOpenChange={setIsConnectionDialogOpen}
				connections={
					// Mid-session OAuth auth required takes precedence
					state.result?.blockedOnAuth
						? [
								{
									serverId:
										state.result.blockedOnAuth.configId,
									serverName:
										state.result.blockedOnAuth.serverName,
									reason: "Authorization expired or required. Please reconnect to continue.",
									authType: "OAUTH2" as const,
									isSystemProvided: false,
									confidence: 1.0,
								},
							]
						: state.result?.routingDecision?.requiredConnections ||
							[]
				}
				missingIntegrations={
					// Don't show missing integrations when blocked on OAuth
					state.result?.blockedOnAuth
						? []
						: state.result?.routingDecision?.missingIntegrations ||
							[]
				}
				organizationId={organizationId}
				onConnectionComplete={handleConnectionComplete}
				onSkip={handleSkipConnection}
			/>

			{/*
			 * Off-screen (`sr-only`), not display:none. Chromium 124+ blocks
			 * the OS file picker on programmatic clicks targeting
			 * `display:none` inputs.
			 */}
			<input
				ref={fileInputRef}
				type="file"
				accept={LOOM_ORCHESTRATOR_FILE_ACCEPT}
				multiple
				onChange={handleFileSelect}
				className="sr-only"
				aria-hidden="true"
				tabIndex={-1}
			/>

			{/* Image lightbox overlay */}
			{lightboxImageUrl && (
				<button
					type="button"
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer border-none p-0 m-0"
					onClick={() => setLightboxImageUrl(null)}
					onKeyDown={(e) => {
						if (e.key === "Escape" || e.key === "Enter") {
							setLightboxImageUrl(null);
						}
					}}
				>
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by parent button */}
					{/* biome-ignore lint/performance/noImgElement: existing lightbox UI */}
					<img
						src={lightboxImageUrl}
						alt="Full size"
						className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg"
						onClick={(e) => e.stopPropagation()}
					/>
				</button>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// F2 — Excalidraw auto-insert button slot.
//
// Rendered as a sibling below each `<McpAppFrame>` invocation in this
// file. Hides for non-Excalidraw tool results so non-canvas MCP UIs
// (forms, dashboards, etc.) don't grow an inappropriate "Insert"
// button. Extracts `checkpointId` from `tc.result` using the canonical
// probe locations (`McpAppFrame.tsx` line 229) so we accept the same
// shape variations the canvas does.
//
// Loom carries the chat scope's `projectId` + `organizationId` directly
// from the page (`attachedProjectId` + the `organizationId` prop) — the
// resolver will fall to the picker path (spec FR-7) because Loom has
// no on-page editor, which is the intended behavior.
//
// Exported as a named (non-default) export so the F2 unit test can
// mount it directly without spinning up the entire orchestrator chat
// (3.7k LOC, dozens of dependencies). The wiring inside
// `FabricTemporalOrchestratorChat` above is the only production
// consumer.
// ---------------------------------------------------------------------------

/**
 * The minimum shape this slot reads from each tool call. Each McpAppFrame
 * call site already filters on `tc.mcpAppResourceUri && tc.mcpAppConfigId
 * && status !== "error"` — we mirror the same precondition before
 * touching the result.
 */
export interface OrchestratorExcalidrawToolCall {
	id: string;
	mcpAppResourceUri?: string;
	mcpAppConfigId?: string;
	args?: unknown;
	result?: unknown;
}

/**
 * Probe locations for `checkpointId` mirror `extractCheckpointId` in
 * `apps/web/components/ai-elements/McpAppFrame.tsx:229-273`. Kept as a
 * local copy to avoid taking a runtime dependency on the canvas
 * component (the canvas is loaded by `next/dynamic` and we want to keep
 * this slot lightweight enough to render on every chat message).
 */
function extractCheckpointIdLocal(toolResult: unknown): string | null {
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
 * Read `elements` and `appState` from the tool args. The
 * MCP `create_view` shape is `{ elements: ExcalidrawElement[],
 * appState?: ExcalidrawState }`; we tolerate `appState` being absent.
 */
function extractElementsAndAppState(toolArgs: unknown): {
	elements: unknown;
	appState: unknown;
} {
	if (!toolArgs || typeof toolArgs !== "object") {
		return { elements: [], appState: undefined };
	}
	const args = toolArgs as Record<string, unknown>;
	return {
		elements: args.elements ?? [],
		appState: args.appState,
	};
}

export interface ExcalidrawAutoInsertSlotProps {
	/** Tool call envelope from `result.toolCalls` / `streamingToolCalls`. */
	toolCall: OrchestratorExcalidrawToolCall;
	/**
	 * Stable chat-message id for this row. The slot composes the
	 * orchestrator's `execution.id` + step + tool-call id so the
	 * button memo key and idempotency key are stable across re-renders.
	 */
	chatMessageId: string;
	/** Chat scope produced by `useChatScopedProjectFromOrchestratorStream`. */
	chatScope: ChatScope;
	/** Org slug for the client-side flag short-circuit. */
	organizationSlug: string | null;
}

/**
 * F2 slot. Renders nothing for:
 *   - non-Excalidraw resources (`mcpAppResourceUri` doesn't include
 *     "excalidraw"),
 *   - missing MCP handles,
 *   - missing checkpointId on the tool result.
 *
 * The button itself owns the additional render-decision branches (flag
 * off, personal scope) — we only short-circuit the cases that aren't
 * relevant to Excalidraw at all so non-canvas MCP frames don't pay the
 * cost of mounting the button.
 */
export function ExcalidrawAutoInsertSlot({
	toolCall,
	chatMessageId,
	chatScope,
	organizationSlug,
}: ExcalidrawAutoInsertSlotProps): JSX.Element | null {
	const { mcpAppResourceUri, mcpAppConfigId } = toolCall;
	if (!mcpAppResourceUri || !mcpAppConfigId) {
		return null;
	}
	if (!mcpAppResourceUri.includes("excalidraw")) {
		return null;
	}
	const checkpointId = extractCheckpointIdLocal(toolCall.result);
	if (!checkpointId) {
		return null;
	}
	const { elements, appState } = extractElementsAndAppState(toolCall.args);
	const toolResult: InsertDiagramToolResult = {
		elements,
		appState,
		checkpointId,
		mcpConfigId: mcpAppConfigId,
		resourceUri: mcpAppResourceUri,
	};

	// Title derivation (spec § 6.3 / FR-3). The adapter's
	// `lastUserPromptForMessage` walks the orchestrator messages
	// backward from `chatMessageId`; the helper trims + caps + applies
	// the "Untitled diagram from chat" fallback.
	const userPromptText = chatScope.lastUserPromptForMessage(chatMessageId);
	const title = deriveDiagramTitle({ userPromptText });

	return (
		<ExcalidrawAutoInsertSlotInner
			surface="loom"
			chatMessageId={chatMessageId}
			toolResult={toolResult}
			organizationSlug={organizationSlug}
			chatScope={chatScope}
			title={title}
		/>
	);
}

interface ExcalidrawAutoInsertSlotInnerProps {
	surface: "loom";
	chatMessageId: string;
	toolResult: InsertDiagramToolResult;
	organizationSlug: string | null;
	chatScope: ChatScope;
	title: string;
}

/**
 * Inner slot. Calls `useActiveTipTapEditor` (a hook) and renders the
 * button. Split out so the outer slot can early-return without hooks
 * before paying the cost of subscribing to the TipTap editor registry.
 */
function ExcalidrawAutoInsertSlotInner({
	surface,
	chatMessageId,
	toolResult,
	organizationSlug,
	chatScope,
	title,
}: ExcalidrawAutoInsertSlotInnerProps): JSX.Element {
	// Spec § 9 — the resolver walks the registry for an editor in the
	// chat-scope project. Loom has no on-page editor, so the resolver
	// will fall to step 3 (defensive cross-tab) then step 4 (null) → the
	// button switches to the "Open a document to insert" picker variant.
	const resolverOptions = {
		chatContext: {
			projectId: chatScope.projectId,
			organizationId: chatScope.organizationId,
			surface,
		},
		launcherContext: null,
	} as const;
	const resolverTarget = useActiveTipTapEditor(resolverOptions);

	return (
		<div className="mt-2">
			<ChatMessageInsertDiagramButton
				surface={surface}
				chatMessageId={chatMessageId}
				toolResult={toolResult}
				organizationSlug={organizationSlug}
				chatScope={chatScope}
				resolverOptions={resolverOptions}
				resolverTarget={resolverTarget}
				title={title}
			/>
		</div>
	);
}
