"use client";

/**
 * FabricDirectChat - Direct chat component with streaming MCP tool execution
 *
 * This component uses SSE streaming for real-time response and tool call
 * visualization. It directly executes MCP tools via the Fabric AI API.
 *
 * Features:
 * - Real-time text streaming
 * - Progressive tool call visualization
 * - Semantic memory integration
 * - Workflow execution with confirmation
 * - Conversation persistence
 */

import {
	AI_CHAT_IMAGE_MIME_TYPES,
	AI_CHAT_SERVER_ALLOWED_EXTENSIONS,
	AI_CHAT_SERVER_ONLY_MIME_TYPES,
	buildAiChatAcceptAttribute,
	buildAiChatAttachmentEntry,
	DEFAULT_AI_CHAT_MAX_FILE_BYTES,
	DEFAULT_AI_CHAT_MIME_ALLOWLIST,
} from "@repo/utils/ai-chat-attachment";
import { useFabricAgentLauncher } from "@saas/agents/components/FabricAgentLauncher";
import { StoppedIndicator } from "@saas/agents/components/StoppedIndicator";
import { useSession } from "@saas/auth/hooks/use-session";
import type { FrameToolResult } from "@saas/frames/lib/frame-result";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ChatMessageInsertDiagramButton } from "@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton";
import { deriveDiagramTitle } from "@saas/projects/components/excalidraw-auto-insert/deriveDiagramTitle";
import { useActiveTipTapEditor } from "@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor";
import { useChatScopedProjectFromLauncher } from "@saas/projects/components/excalidraw-auto-insert/useChatScopedProject";
import { prepareImageForAi } from "@saas/projects/lib/image-upload-utils";
import { CopilotSidebarAttachments } from "@saas/shared/components/copilot/CopilotSidebarAttachments";
import type { AttachedFile as CopilotAttachedFile } from "@saas/shared/components/copilot/use-copilot-document-upload";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { orpcClient } from "@shared/lib/orpc-client";
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
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	BookmarkIcon,
	CheckCircle2,
	ChevronDown,
	ChevronLeft,
	DownloadIcon,
	FileCode2,
	File as FileIcon,
	FilePenLineIcon,
	GitBranch,
	ListChecksIcon,
	Loader2,
	NotebookPen,
	Paperclip,
	ScrollText,
	SquareTerminal,
	Wrench,
	XCircle,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
	Fragment,
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	CheckpointCreateButton,
	type CheckpointData,
	CheckpointHistory,
	CheckpointProvider,
	createCheckpoint,
} from "../../../../../components/ai-elements/checkpoint";
import {
	Confirmation,
	ConfirmationAction,
	ConfirmationActions,
	ConfirmationDescription,
	ConfirmationIcon,
	ConfirmationRequest,
	ConfirmationTitle,
} from "../../../../../components/ai-elements/confirmation";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "../../../../../components/ai-elements/conversation";
import { McpAppFrame } from "../../../../../components/ai-elements/McpAppFrame";
import {
	Message,
	MessageAvatar,
	MessageContent,
} from "../../../../../components/ai-elements/message";
import { Response } from "../../../../../components/ai-elements/response";
import { Sources } from "../../../../../components/ai-elements/sources";
import {
	type DirectStreamMessage,
	useDirectStream,
} from "../../hooks/useDirectStream";
import { useEscToStopOrClose } from "../../hooks/useEscToStopOrClose";
import { useSkillSlashCommand } from "../../hooks/useSkillSlashCommand";
import { useSkillSuggestions } from "../../hooks/useSkillSuggestions";
import { useToolSuggestions } from "../../hooks/useToolSuggestions";
import {
	buildComprehensiveFileContext,
	type CodeReference,
	deduplicateCodeReferences,
	extractCodeReferences,
	formatCodeReference,
	hasCodeReferences,
	identifyRelatedFiles,
} from "../../lib/code-references";
import { deriveTrajectorySteps } from "../../lib/derive-trajectory";
import {
	getSelectedConversationToolIds,
	mergeDirectConversationMetadata,
} from "../../lib/direct-chat-tools";
import {
	persistedToToolCallStatus,
	toolCallToPersistedStatus,
} from "../../lib/tool-call-status";
import { ConversationToolPicker } from "./ConversationToolPicker";
import {
	ActiveContextIndicator,
	AgentModelPicker,
	ChatInput,
	ChatWelcome,
	getLatestSuccessfulFrameFromGroups,
	InteractiveContentPanel,
	type SelectedAgent,
	type ToolCallItem,
	ToolCallList,
} from "./shared";
import { shouldShowAssistantActionCards } from "./shared/assistant-action-cards";
import { SkillAutocomplete } from "./shared/SkillAutocomplete";
import { SkillSuggestionChips } from "./shared/SkillSuggestionChips";
import { TrajectorySteps } from "./TrajectorySteps";

interface PendingConfirmation {
	workflowId: string;
	workflowName: string;
	workflowDescription?: string;
	messageId: string;
}

interface ProposedTaskDraft {
	id: string;
	title: string;
	description?: string;
}

interface PendingTaskDraft {
	messageId: string;
	tasks: ProposedTaskDraft[];
}

interface PendingProjectUpdateDraft {
	messageId: string;
	title: string;
	content: string;
}

interface PendingImplementationSession {
	messageId: string;
	summary: string;
}

interface PendingSkillDraft {
	messageId: string;
	name: string;
	slug: string;
	description: string;
	content: string;
	tags: string[];
	scope: "USER" | "ORGANIZATION";
}

interface SavedSkillAutomationPrompt {
	skillId: string;
	skillName: string;
	existingTags: string[];
	columnTag: string;
}

interface ResolvedCodeReferencePreview {
	ref: CodeReference;
	branch?: string | null;
	relatedFiles: string[];
}

/**
 * Attached file for document upload.
 *
 * This was a hand-maintained duplicate of the copilot hook's record, JSDoc and
 * all, which is how the two surfaces drifted: the hook grew an extraction
 * outcome and this copy did not, so a password-protected workbook uploaded
 * perfectly here and rendered a clean chip carrying nothing. Taking the shared
 * type means the next field arrives on both surfaces at once.
 *
 * `contextEntry` is the one genuinely local addition: the finished envelope for
 * this file, held on the record rather than assembled at send time so removing
 * a chip removes its content too.
 */
type AttachedFile = CopilotAttachedFile & {
	contextEntry?: string;
};

/**
 * What the picker advertises, derived rather than written out.
 *
 * The hand-kept string it replaces had gone stale twice over: it offered
 * neither `.xlsx` — which this surface has accepted since the Excel work — nor
 * `.csv`. Both were admitted by the server and by this surface's own
 * validation, so a user could only discover they worked by dragging one in.
 *
 * Loom runs no canvas compression step, so it advertises the full image set
 * including TIFF; see `AI_CHAT_SERVER_ONLY_MIME_TYPES` for why the Feature
 * Assistant's is narrower.
 */
const LOOM_FILE_ACCEPT = buildAiChatAcceptAttribute([
	...AI_CHAT_IMAGE_MIME_TYPES,
	...AI_CHAT_SERVER_ONLY_MIME_TYPES,
]);

interface ConversationDetail {
	id: string;
	messages: Array<{
		id: string;
		role: "user" | "assistant" | "system";
		content: string;
		timestamp: string;
		toolCalls?: Array<{
			id: string;
			name: string;
			args: Record<string, unknown>;
			result?: string;
			status?: "pending" | "running" | "success" | "error";
		}>;
		/**
		 * Stream lifecycle persisted alongside the message body so a
		 * page reload still surfaces the inline `Stopped` caption on
		 * cancelled turns (spec § 5.1 / AC-5). Optional for backwards
		 * compat with older persisted entries.
		 */
		streamStatus?: "streaming" | "completed" | "error" | "cancelled";
		cancelledAt?: string;
		/** Reasoning trace emitted before the model's answer (F-1171). */
		reasoningText?: string;
		/** Duration of the reasoning phase in milliseconds (F-1171). */
		reasoningDurationMs?: number;
	}>;
	metadata?: Record<string, unknown> | null;
}

/** Token usage info exported for parent components */
export interface DirectChatTokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
	maxTokens: number;
}

interface FabricDirectChatProps {
	organizationId?: string;
	reasoningMode: "lite" | "balanced" | "deep" | "planner";
	activeConversation?: ConversationDetail | null;
	activeConversationId?: string | null;
	onConversationSaved?: () => void;
	onConversationCreated?: (conversationId: string) => void;
	/**
	 * Fires when a turn starts and finishes streaming.
	 *
	 * The drawer needs it to know when expanding to the full page would lose
	 * work: this surface persists a turn on completion, so a turn still in
	 * flight exists only in this component's state and would not survive the
	 * navigation (#2040).
	 */
	onStreamingChange?: (isStreaming: boolean) => void;
	/** Enabled MCP config IDs - if provided, only these MCP servers will be used */
	enabledMcpConfigIds?: string[] | null;
	/** Enabled Fabric tool IDs - if provided, only these built-in tools will be used */
	enabledFabricToolIds?: string[] | null;
	/** Callback when documents are uploaded - provides the AiChat ID where documents are stored */
	onDocumentChatCreated?: (chatId: string) => void;
	/** Document chat ID where uploaded documents are stored (for RAG retrieval) */
	documentChatId?: string | null;
	/** Callback when token usage changes */
	onUsageChange?: (usage: DirectChatTokenUsage) => void;
	/** Attached workspace IDs for RAG context retrieval */
	attachedWorkspaceIds?: string[];
	/** Restrict workspace retrieval to these document IDs when provided */
	attachedDocumentIds?: string[];
	/** Attached project ID for visible context and conversation attachment */
	attachedProjectId?: string | null;
	/** Attached feature/story ID for approved task creation and implementation actions */
	attachedStoryId?: string | null;
	/** Attached task ID for task-scoped implementation actions */
	attachedTaskId?: string | null;
	/** Explicit attached code context from contextual launches */
	attachedCodeContext?: {
		filePath?: string | null;
		lineStart?: number | null;
		lineEnd?: number | null;
		repoName?: string | null;
		branch?: string | null;
		snippet?: string | null;
	} | null;
	/** GitHub repository URL for resolving file:line references */
	repositoryUrl?: string | null;
	/**
	 * Whether to offer the agent and model picker in the composer header.
	 *
	 * The simple interface mode hides it (#2040). Defaults to `true` so
	 * surfaces with no interface-mode concept of their own — the floating
	 * launcher, the document assistant — keep the picker until they grow one.
	 */
	showAgentPicker?: boolean;
	/**
	 * Whether to offer the chat-tools (MCP) picker in the composer.
	 *
	 * Simple mode hides it (#2040), same as the agent picker. Defaults to
	 * `true` so surfaces with no interface-mode concept keep it.
	 */
	showToolPicker?: boolean;
	/** System prompt / instructions for agent template instances */
	systemPrompt?: string;
	/** Agent template instance ID for metadata persistence */
	instanceId?: string;
	/** Optional initial draft text for contextual launches */
	initialInput?: string;
	/** Use a compact welcome layout for constrained surfaces like side sheets */
	compactMode?: boolean;
	/**
	 * Surface that mounts this component — threaded into the
	 * `useDirectStream` hook so the cancel telemetry event reports the
	 * right `surface` tag (spec § 10.1, task 3.3 wiring). The launcher
	 * passes `"fabric-agent-launcher"`; the standalone Loom Direct page
	 * leaves it unset so the hook default (`"loom-direct"`) takes over.
	 */
	surface?: "fabric-agent-launcher" | "loom-direct";
	/**
	 * Optional handler for the Esc key while the chat is idle. The
	 * component mounts a shared `useEscToStopOrClose` binding so Esc
	 * stops streaming when a turn is in-flight. When idle, this handler
	 * (if provided) is invoked — the launcher passes
	 * `() => setIsOpen(false)` so the panel closes; the standalone Loom
	 * Direct page leaves it unset so idle Esc is a no-op (AC-7 / spec
	 * § 8.8 / decision 9).
	 */
	onEscClose?: () => void;
	/**
	 * When false, suppresses the outer `<TrajectorySteps>` "Reasoning Trace"
	 * container above each assistant message. Individual tool/skill cards
	 * rendered by `<ToolCallList>` below are unaffected — they continue to
	 * surface skill execution status to the user.
	 *
	 * The Loom launcher passes `false` because:
	 *   1. `reasoningMode` is hardcoded to `"balanced"` in the launcher (see
	 *      FabricAgentLauncher.tsx history of PRs #1093/#1098/#1102/#1105),
	 *      so the AI SDK never emits `reasoning-delta` chunks and the
	 *      "thinking" step never materialises. Only tool/skill steps remain.
	 *   2. Showing only tool/skill steps inside a box titled
	 *      "Reasoning Trace" is misleading — users on staging reported it
	 *      reads as a broken reasoning surface rather than a tool log.
	 *   3. The individual tool/skill chips below the assistant message
	 *      already convey "which skill ran and finished" — the outer box
	 *      is redundant in the quick-page-copilot UX.
	 *
	 * Surfaces that DO want the reasoning-trace panel (full Fabric AI page
	 * at `/app/agents/fabric-ai` where users can pick `"deep"` mode and
	 * Anthropic thinking actually fires) leave this prop unset and get the
	 * default `true`.
	 */
	showTrajectorySteps?: boolean;
}

/**
 * Imperative handle for FabricDirectChat
 */
export interface FabricDirectChatHandle {
	setInput: (value: string) => void;
}

function formatLineRangeLabel(
	lineStart?: number | null,
	lineEnd?: number | null,
) {
	if (!lineStart) {
		return "";
	}
	if (lineEnd && lineEnd !== lineStart) {
		return `:${lineStart}-${lineEnd}`;
	}
	return `:${lineStart}`;
}

/**
 * Extract the original MCP tool name from a prefixed name
 * Returns the actual tool name as defined by the MCP server
 */
function getOriginalToolName(toolName: string | undefined | null): string {
	// Guard against undefined/null tool names
	if (!toolName) {
		return "unknown_tool";
	}

	// For MCP tools, extract the original name after the server prefix
	// Pattern: "server-key_original_tool_name" or "server-key-uuid_original_tool_name"
	// e.g., "fizzy-mcp-yl2fue_fizzy_get_boards" -> "fizzy_get_boards"
	const match = toolName.match(/^[a-z0-9-]+_(.+)$/i);
	if (match) {
		return match[1];
	}

	return toolName;
}

export const FabricDirectChat = forwardRef<
	FabricDirectChatHandle,
	FabricDirectChatProps
>(function FabricDirectChat(
	{
		organizationId,
		reasoningMode,
		activeConversation,
		activeConversationId: externalConversationId,
		onConversationSaved,
		onConversationCreated,
		onStreamingChange,
		enabledMcpConfigIds,
		enabledFabricToolIds,
		onDocumentChatCreated,
		documentChatId: externalDocumentChatId,
		onUsageChange,
		attachedWorkspaceIds,
		attachedDocumentIds,
		attachedProjectId,
		attachedStoryId,
		attachedTaskId,
		attachedCodeContext,
		repositoryUrl,
		showAgentPicker = true,
		showToolPicker = true,
		systemPrompt,
		instanceId,
		initialInput,
		compactMode = false,
		surface,
		onEscClose,
		showTrajectorySteps = true,
	},
	ref,
) {
	const { user } = useSession();
	const tooltipT = useTranslations("tooltips.agents");
	const userAvatarSrc = user?.image ?? "";
	const userDisplayName = user?.name ?? user?.email ?? "Me";

	// Document editor bridge — available when StoryWorkspace has registered its editor
	const { applyToDocument, launchContext } = useFabricAgentLauncher();

	// Excalidraw chat -> editor auto-insert (spec § 8.1 wiring F3).
	// The in-feature AI Assistant is the canonical happy path — the
	// launcher carries projectId + storyId, and the active-editor
	// registry resolves the story editor on the same page so the button
	// can insert without opening the picker. We compose the launcher
	// adapter's chat scope with the active org context (the adapter
	// returns `organizationId: null` by design and leaves the merge to
	// the wiring site, per `useChatScopedProject.ts:130-133`). All
	// downstream render-decision branches live inside the button
	// component itself — we only forward inputs from here.
	const launcherChatScope = useChatScopedProjectFromLauncher();
	const { organizationId: activeOrgId, organizationSlug: activeOrgSlug } =
		useOrganizationContext();
	const composedChatScope = useMemo(
		() => ({
			projectId: launcherChatScope.projectId,
			organizationId: activeOrgId,
			lastUserPromptForMessage:
				launcherChatScope.lastUserPromptForMessage,
		}),
		[
			launcherChatScope.projectId,
			launcherChatScope.lastUserPromptForMessage,
			activeOrgId,
		],
	);
	const excalidrawResolverOptions = useMemo(
		() => ({
			chatContext: {
				projectId: composedChatScope.projectId,
				organizationId: composedChatScope.organizationId,
				surface: "in-feature" as const,
			},
			launcherContext: launchContext,
		}),
		[
			composedChatScope.projectId,
			composedChatScope.organizationId,
			launchContext,
		],
	);
	const excalidrawResolverTarget = useActiveTipTapEditor(
		excalidrawResolverOptions,
	);

	// Local state for UI
	const [input, setInput] = useState(initialInput ?? "");
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [pendingConfirmation, setPendingConfirmation] =
		useState<PendingConfirmation | null>(null);
	const [pendingTaskDraft, setPendingTaskDraft] =
		useState<PendingTaskDraft | null>(null);
	const [pendingProjectUpdateDraft, setPendingProjectUpdateDraft] =
		useState<PendingProjectUpdateDraft | null>(null);
	const [pendingImplementationSession, setPendingImplementationSession] =
		useState<PendingImplementationSession | null>(null);
	const [pendingSkillDraft, setPendingSkillDraft] =
		useState<PendingSkillDraft | null>(null);
	const [savedSkillAutomationPrompt, setSavedSkillAutomationPrompt] =
		useState<SavedSkillAutomationPrompt | null>(null);
	const [isCreatingTasks, setIsCreatingTasks] = useState(false);
	const [isSavingProjectUpdateDraft, setIsSavingProjectUpdateDraft] =
		useState(false);
	const [
		isStartingImplementationSession,
		setIsStartingImplementationSession,
	] = useState(false);
	const [isSavingSkillDraft, setIsSavingSkillDraft] = useState(false);
	const [isSavingAutomationTag, setIsSavingAutomationTag] = useState(false);
	// Track loaded messages from history (separate from streaming)
	const [loadedMessages, setLoadedMessages] = useState<DirectStreamMessage[]>(
		[],
	);
	// Document attachments state
	const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
	// Track current document chat ID (from uploads or loaded from history)
	const [currentDocumentChatId, setCurrentDocumentChatId] = useState<
		string | null
	>(externalDocumentChatId || null);
	const [conversationToolPickerOpen, setConversationToolPickerOpen] =
		useState(false);
	// `null` means "no per-conversation override" — the live sidebar selection
	// (`enabledMcpConfigIds`) is used instead. Seeding this from the prop froze
	// the value at mount: the prop starts `[]`, `[]` is non-null so it won the
	// `??` chain below forever, and `[]` means "no MCP at all" downstream — so
	// every server the user later enabled in the control deck was dropped.
	const [selectedConversationMcpIds, setSelectedConversationMcpIds] =
		useState<string[] | null>(null);
	// Checkpoints state
	const [checkpoints, setCheckpoints] = useState<CheckpointData[]>([]);
	// Track if component has mounted (for hydration-safe rendering)
	const [hasMounted, setHasMounted] = useState(false);
	const [activeFrame, setActiveFrame] = useState<FrameToolResult | null>(
		null,
	);
	const [lastFrame, setLastFrame] = useState<FrameToolResult | null>(null);

	// Expose imperative handle for parent component
	useImperativeHandle(ref, () => ({
		setInput: (value: string) => {
			setInput(value);
		},
	}));

	// Skill slash-command hook
	const skillSlash = useSkillSlashCommand({ organizationId });

	// Handle input change with slash-command detection
	const handleInputChange = useCallback(
		(value: string) => {
			// Check for slash command
			if (value.startsWith("/")) {
				skillSlash.open(value.slice(1));
			} else {
				skillSlash.close();
			}
			setInput(value);
		},
		[setInput, skillSlash],
	);

	// Handle skill selection — fetch full content and prepend to input
	const handleSelectSkill = useCallback(
		async (skill: { id: string; name: string; description: string }) => {
			skillSlash.selectSkill(skill as any);
			try {
				const result = await orpcClient.skills.execute({
					id: skill.id,
					organizationId: organizationId ?? null,
				});
				const skillPrompt = `Using the "${result.name}" skill:\n\n${result.description}\n\n${result.content}\n\n`;
				setInput(skillPrompt);
				inputRef.current?.focus();
			} catch (error) {
				toast.error("Failed to load skill", {
					description:
						error instanceof Error
							? error.message
							: "Unknown error",
				});
			}
		},
		[organizationId, skillSlash, setInput],
	);

	// Handle keyboard events for skill autocomplete
	const handleInputAreaKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (skillSlash.isOpen && skillSlash.results.length > 0) {
				if (e.key === "Enter" || e.key === "Tab") {
					const selectedSkill =
						skillSlash.results[skillSlash.selectedIndex];
					if (selectedSkill) {
						e.preventDefault();
						e.stopPropagation();
						void handleSelectSkill(selectedSkill);
						return;
					}
				}
				const handled = skillSlash.handleKeyDown(e);
				if (handled) {
					e.stopPropagation();
				}
			}
		},
		[handleSelectSkill, skillSlash],
	);

	const [resolvedCodeReferences, setResolvedCodeReferences] = useState<
		CodeReference[]
	>([]);
	const [resolvedCodeReferencePreviews, setResolvedCodeReferencePreviews] =
		useState<ResolvedCodeReferencePreview[]>([]);

	const openFrame = (frame: FrameToolResult | null) => {
		setActiveFrame(frame);
		if (frame) {
			setLastFrame(frame);
		}
	};
	const fileInputRef = useRef<HTMLInputElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const lastPersistedRef = useRef<string | null>(null);
	const lastAutoOpenedFrameIdRef = useRef<string | null>(null);

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

	// Agent or model picked in the composer header.
	//
	// Single-select for now, deliberately. The turn projection that renders
	// several responses against one user message still lives in `CopilotPage`;
	// until it is shared, a multi-select here would look like it worked and
	// silently drop every response after the first (#2040).
	const [selectedAgent, setSelectedAgent] = useState<SelectedAgent | null>(
		null,
	);

	// Last-used agent is persisted server-side per (user × org). This reuses
	// the store Nexus already writes to rather than standing up a second one,
	// so the selection follows the user across surfaces — which is the point
	// of consolidating them (#2040).
	//
	// Gated on `showAgentPicker`: a surface that cannot show the picker must
	// neither hydrate a chip the user has no way to clear, nor overwrite the
	// stored selection on their behalf.
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
				// The persisted schema is a strict subset of SelectedAgent —
				// `instructions` has no column, so an instance-backed agent
				// rehydrates without them. Same fidelity Nexus has always had;
				// widening the schema is a separate change.
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
		onError: (err) => {
			// eslint-disable-next-line no-console -- intentional dev signal
			console.warn(
				"[FabricDirectChat] Agent selection persist failed",
				err,
			);
			toast.message("Couldn't save your agent choice.", {
				description:
					"It applies to this chat, but may not be here next time.",
			});
		},
	});

	// Hydrate once. The surface is single-select while the turn projection
	// still lives in CopilotPage, so a stored multi-agent selection collapses
	// to its first entry rather than being dropped.
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
		// The server supplies a default only when there is nothing saved, and
		// only when this tenant can actually run it — so it is null for an
		// organization without the provider, and no chip appears rather than
		// one that would fail on first use.
		const [first] = data.selectedAgents;
		const initial = first ?? data.defaultAgent;
		if (initial) {
			setSelectedAgent(initial as SelectedAgent);
		}
		// FR13: the server drops entries whose targets no longer resolve for
		// this tenant. Saying so is the difference between "my agent quietly
		// changed" and "my agent went away, and I know why".
		if (data.droppedCount > 0) {
			toast.message(
				first
					? "Some saved agents are no longer available."
					: "Your saved agent is no longer available.",
				{
					description: initial
						? `Using ${initial.name} for this chat.`
						: "Using your configured default for this chat.",
				},
			);
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

	// A picked entry overrides this surface's configured defaults for the turn.
	// A model only redirects which model runs; a registered agent also brings
	// its own instructions, tools and knowledge base. Every fallback keeps the
	// unpicked surface behaving exactly as it did before the picker existed.
	//
	// `enabledMcpConfigIds` is coalesced with `??` on purpose: the agent's
	// `null` means "fall back to user preferences" while `[]` means "no MCP at
	// all", and that distinction has to survive.
	const activeModelOverride = selectedAgent?.modelOverride;
	const activeInstanceId = selectedAgent?.instanceId ?? instanceId;
	const activeSystemPrompt = selectedAgent?.instructions ?? systemPrompt;
	const activeMcpConfigIds =
		selectedAgent?.enabledMcpConfigIds ??
		selectedConversationMcpIds ??
		enabledMcpConfigIds;
	// Union rather than override: the agent's knowledge base is additive to the
	// workspaces the user attached to this conversation, and dropping those
	// would silently narrow retrieval on a setting the user can see.
	const activeWorkspaceIds = useMemo(
		() =>
			Array.from(
				new Set([
					...(attachedWorkspaceIds ?? []),
					...(selectedAgent?.workspaceIds ?? []),
				]),
			),
		[attachedWorkspaceIds, selectedAgent],
	);

	// Use the streaming hook for real-time responses
	const {
		messages: streamMessages,
		isLoading,
		sendMessage: streamSendMessage,
		reset: resetStream,
		contextInfo,
		stop: stopStream,
	} = useDirectStream({
		organizationId,
		reasoningMode,
		modelOverride: activeModelOverride,
		enabledMcpConfigIds: activeMcpConfigIds,
		enabledFabricToolIds,
		instanceId: activeInstanceId,
		workspaceIds: activeWorkspaceIds,
		workspaceDocumentIds: attachedDocumentIds,
		projectId: attachedProjectId,
		// Focused entity the user is viewing (the page the agent was opened on),
		// so the backend can ground on its FULL content — sections, acceptance
		// criteria, document body — not a truncated project list.
		storyId: launchContext?.storyId,
		documentId: launchContext?.documentId,
		taskId: launchContext?.taskId,
		// Pass conversation ID so backend can fetch attached workspaces if frontend didn't load them yet
		conversationId: externalConversationId,
		systemPrompt: activeSystemPrompt,
		// Surface tag for cancel telemetry (spec § 10.1, task 3.3 wiring).
		// `surface` is undefined on the standalone Loom Direct page, so the
		// hook default (`"loom-direct"`) applies; the launcher passes
		// `"fabric-agent-launcher"`.
		...(surface ? { surface } : {}),
		onStopFailed: handleStopFailed,
	});

	useEffect(() => {
		onStreamingChange?.(isLoading);
	}, [isLoading, onStreamingChange]);

	// Stable `onStop` for ChatInput — wraps the hook's `stop()` with the
	// `"button"` trigger tag so cancel telemetry distinguishes the morph
	// click from the Esc keybinding.
	const handleStopFromButton = useCallback(() => {
		stopStream("button");
	}, [stopStream]);

	// Stable `onStop` for the shared Esc binding — wraps `stop()` with
	// the `"esc"` trigger tag so cancel telemetry distinguishes the
	// keypress from the morph click (spec § 10.1, decision 9 / AC-7).
	const handleStopFromEsc = useCallback(() => {
		stopStream("esc");
	}, [stopStream]);

	// Esc-context binding. While a turn is in-flight, Esc
	// stops generation. While idle, Esc invokes `onEscClose` if the
	// host passed one — the launcher uses this to close its panel; the
	// standalone Loom Direct page omits it so Esc-while-idle is a
	// no-op (AC-7).
	useEscToStopOrClose({
		isInFlight: isLoading,
		onStop: handleStopFromEsc,
		onClose: onEscClose,
	});

	// Set mounted state after hydration
	useEffect(() => {
		setHasMounted(true);
	}, []);

	// Tool suggestions - only show when not loading and input has content
	const { suggestions: toolSuggestions, isLoading: suggestionsLoading } =
		useToolSuggestions(input, {
			organizationId,
			enabledMcpConfigIds:
				selectedConversationMcpIds ?? enabledMcpConfigIds,
			enabled: !isLoading && input.trim().length >= 5,
			debounceMs: 400,
			minLength: 5,
		});

	// Report usage changes to parent
	useEffect(() => {
		if (onUsageChange && contextInfo.usage) {
			onUsageChange({
				inputTokens: contextInfo.usage.inputTokens || 0,
				outputTokens: contextInfo.usage.outputTokens || 0,
				totalTokens: contextInfo.usage.totalTokens || 0,
				reasoningTokens: contextInfo.usage.reasoningTokens,
				cachedInputTokens: contextInfo.usage.cachedInputTokens,
				maxTokens: contextInfo.maxTokens,
			});
		}
	}, [contextInfo.usage, contextInfo.maxTokens, onUsageChange]);

	// Resolve code references (file:line) from input
	const resolveCodeReferences = useCallback(
		async (
			text: string,
		): Promise<{
			resolvedText: string;
			refs: CodeReference[];
			unresolvedRefs: CodeReference[];
		}> => {
			const refs = extractCodeReferences(text);
			if (refs.length === 0 || !repositoryUrl) {
				return { resolvedText: text, refs: [], unresolvedRefs: [] };
			}

			const uniqueRefs = deduplicateCodeReferences(refs);
			const snippets: string[] = [];
			const resolvedRefs: CodeReference[] = [];
			const previewRefs: ResolvedCodeReferencePreview[] = [];

			for (const ref of uniqueRefs) {
				try {
					const result = await orpcClient.github.fetchFileContent({
						repositoryUrl,
						filePath: ref.filePath,
						ref: attachedCodeContext?.branch ?? undefined,
					});

					if (result.success && result.content) {
						const relatedFiles: Array<{
							path: string;
							content: string;
						}> = [];
						const candidatePaths = identifyRelatedFiles(
							ref.filePath,
							result.content,
							ref.lineStart,
							ref.lineEnd,
						).slice(0, 2);

						for (const candidatePath of candidatePaths) {
							try {
								const relatedResult =
									await orpcClient.github.fetchFileContent({
										repositoryUrl,
										filePath: candidatePath,
										ref:
											attachedCodeContext?.branch ??
											undefined,
									});

								if (
									relatedResult.success &&
									relatedResult.content
								) {
									relatedFiles.push({
										path: candidatePath,
										content: relatedResult.content,
									});
								}
							} catch (error) {
								console.warn(
									`Failed to fetch related file ${candidatePath}:`,
									error,
								);
							}
						}

						snippets.push(
							buildComprehensiveFileContext(
								ref.filePath,
								result.content,
								ref.lineStart,
								ref.lineEnd,
								relatedFiles,
								{
									surroundingLines: 8,
									includeImports: true,
									includeModuleSummary: true,
									maxRelatedFiles: 2,
								},
							),
						);
						resolvedRefs.push(ref);
						previewRefs.push({
							ref,
							branch: attachedCodeContext?.branch ?? undefined,
							relatedFiles: relatedFiles.map((file) => file.path),
						});
					}
				} catch (error) {
					// Silently skip files that can't be fetched
					console.warn(`Failed to fetch ${ref.filePath}:`, error);
				}
			}

			if (snippets.length === 0) {
				setResolvedCodeReferencePreviews([]);
				return {
					resolvedText: text,
					refs: [],
					unresolvedRefs: uniqueRefs,
				};
			}

			setResolvedCodeReferencePreviews(previewRefs);
			const resolvedText = `${text}\n\n---\nReferenced code:${snippets.join("\n")}`;
			const unresolvedRefs = uniqueRefs.filter(
				(ref) =>
					!resolvedRefs.some(
						(resolved) => resolved.fullMatch === ref.fullMatch,
					),
			);
			return { resolvedText, refs: resolvedRefs, unresolvedRefs };
		},
		[repositoryUrl],
	);

	// Combine loaded messages with streaming messages
	const messages: DirectStreamMessage[] =
		streamMessages.length > 0 ? streamMessages : loadedMessages;

	// Skill suggestions - based on last user message in conversation
	let lastUserMessage = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user" && m.content) {
			lastUserMessage = m.content;
			break;
		}
	}

	const {
		suggestions: skillSuggestions,
		isLoading: skillSuggestionsLoading,
		clear: clearSkillSuggestions,
	} = useSkillSuggestions(lastUserMessage, {
		organizationId,
		conversationId: conversationId ?? null,
		enabled:
			!isLoading &&
			messages.length > 0 &&
			lastUserMessage.trim().length >= 5,
		debounceMs: 400,
		minLength: 5,
	});

	// Clear skill suggestions when user starts typing
	useEffect(() => {
		if (input.trim().length > 0 && skillSuggestions.length > 0) {
			clearSkillSuggestions();
		}
	}, [input, skillSuggestions.length, clearSkillSuggestions]);

	const handleApplyToDocument = useCallback(() => {
		if (!applyToDocument) {
			return;
		}
		let lastAssistantContent: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant" && m.content) {
				lastAssistantContent = m.content;
				break;
			}
		}
		if (!lastAssistantContent) {
			toast.error("No assistant response to apply");
			return;
		}
		applyToDocument(lastAssistantContent);
		toast.success("Applied to document");
	}, [applyToDocument, messages]);

	useEffect(() => {
		const latestFrame = getLatestSuccessfulFrameFromGroups(
			messages.map((message) => message.toolCalls),
		);
		if (!latestFrame) {
			return;
		}
		if (lastAutoOpenedFrameIdRef.current === latestFrame.frameId) {
			return;
		}
		lastAutoOpenedFrameIdRef.current = latestFrame.frameId;
		openFrame(latestFrame);
	}, [messages]);

	// Load conversation when selected from history
	// IMPORTANT: Don't reset if we already have streaming messages from this session
	// This prevents clearing the conversation when URL is updated after first message
	useEffect(() => {
		if (activeConversation && externalConversationId) {
			const selectedIds = getSelectedConversationToolIds(
				activeConversation.metadata,
			);
			setSelectedConversationMcpIds(selectedIds ?? null);
			// CRITICAL: If we have streaming messages, we're in an active session.
			// Never reset streaming messages - they represent the current conversation state.
			// This handles the race condition where conversationId state update hasn't
			// taken effect yet when URL change triggers this effect.
			if (streamMessages.length > 0) {
				console.log(
					"[FabricDirectChat] Skipping reload - have active streaming messages",
					{
						streamCount: streamMessages.length,
						externalId: externalConversationId,
					},
				);
				// Still update conversationId if needed to stay in sync
				if (conversationId !== externalConversationId) {
					setConversationId(externalConversationId);
				}
				return;
			}

			if (
				externalConversationId !== conversationId ||
				loadedMessages.length === 0
			) {
				console.log(
					"[FabricDirectChat] Loading conversation:",
					activeConversation.id,
				);
				const loaded: DirectStreamMessage[] =
					activeConversation.messages.map((msg) => ({
						id: msg.id,
						// Conversations persist a third role — `system`, written
						// by `agents.conversations.recordOperationResult` — that
						// the chat API does not accept. Casting it through left
						// it in the outgoing `history`, and the route rejected
						// the whole request, so one operation-result row made a
						// thread permanently unusable ("Invalid request body").
						role: msg.role === "user" ? "user" : "assistant",
						content: msg.content,
						timestamp: new Date(msg.timestamp),
						toolCalls: msg.toolCalls?.map((tc) => ({
							id: tc.id,
							name: tc.name,
							args: tc.args,
							result: tc.result,
							status: persistedToToolCallStatus(
								tc.status ?? "pending",
							),
						})),
						// Carry persisted stream lifecycle through rehydration so
						// the inline `Stopped` caption survives a page reload
						// (spec § 5.1 / AC-5).
						streamStatus: msg.streamStatus,
						cancelledAt: msg.cancelledAt,
						// Carry reasoning trace through rehydration so the
						// "Thought for X.Ys" header renders correctly after reload.
						reasoningText: msg.reasoningText,
						reasoningDurationMs: msg.reasoningDurationMs,
					}));
				setLoadedMessages(loaded);
				setConversationId(activeConversation.id);
				resetStream(); // Clear any streaming state
			}
		}
	}, [
		externalConversationId,
		activeConversation,
		conversationId,
		loadedMessages.length,
		streamMessages.length,
		resetStream,
		enabledMcpConfigIds,
	]);

	// Track if we've saved this conversation (to avoid resetting after our own save)
	const savedConversationIdRef = useRef<string | null>(null);

	// Reset when user explicitly starts a new chat (clicks New Chat button)
	// This should NOT trigger when we save the current conversation
	useEffect(() => {
		// Only reset if:
		// 1. externalConversationId is null (user wants new chat or default state)
		// 2. conversationId is not null (we have a saved conversation)
		// 3. The conversationId is NOT one we just saved (it's from a previous session)
		if (
			externalConversationId === null &&
			conversationId !== null &&
			savedConversationIdRef.current !== conversationId
		) {
			console.log(
				"[FabricDirectChat] Starting new chat (external deselection)",
			);
			setLoadedMessages([]);
			setConversationId(null);
			setCurrentDocumentChatId(null);
			setSelectedConversationMcpIds(null);
			resetStream();
		}
	}, [
		externalConversationId,
		conversationId,
		resetStream,
		enabledMcpConfigIds,
	]);

	// Sync documentChatId when external prop changes (e.g., loading from history)
	useEffect(() => {
		if (
			externalDocumentChatId &&
			externalDocumentChatId !== currentDocumentChatId
		) {
			setCurrentDocumentChatId(externalDocumentChatId);
		}
	}, [externalDocumentChatId, currentDocumentChatId]);

	// Focus input on mount
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Persist conversation to database
	// The conversation has to carry an id before the turn finishes, or the
	// drawer's expand-to-full-page control has nothing to navigate to while a
	// reply is still streaming (#2040). Creating on send rather than on
	// completion also means a turn that dies mid-flight keeps the user's
	// question instead of discarding it.
	const eagerCreateRef = useRef<Promise<string | null> | null>(null);
	const eagerUserMessageIdRef = useRef<string | null>(null);

	// Cleared on every path that drops back to "no conversation" — explicit
	// new chat, external deselection, loading a different thread — so the next
	// turn creates its own row rather than appending to the previous one.
	useEffect(() => {
		if (conversationId === null) {
			eagerCreateRef.current = null;
			eagerUserMessageIdRef.current = null;
		}
	}, [conversationId]);

	const ensureConversation = useCallback(
		(userMsg: DirectStreamMessage): Promise<string | null> => {
			if (eagerCreateRef.current) {
				return eagerCreateRef.current;
			}
			const created = (async () => {
				try {
					const result = await orpcClient.agents.conversations.create(
						{
							organizationId,
							// Canonical RegisteredAgent.agentId from
							// seed-system-agents.ts — not the "fabric-ai" URL-slug
							// form, which drifted from the catalog.
							agentId: "fabric-workspace-assistant",
							title:
								userMsg.content.slice(0, 50) +
								(userMsg.content.length > 50 ? "..." : ""),
							messages: [
								{
									id: userMsg.id,
									role: "user" as const,
									content: userMsg.content,
									timestamp: userMsg.timestamp.toISOString(),
								},
							],
							metadata: mergeDirectConversationMetadata({
								documentChatId: currentDocumentChatId,
								instanceId,
								selectedMcpConfigIds:
									selectedConversationMcpIds ?? undefined,
							}),
						},
					);
					if (attachedProjectId) {
						await orpcClient.projects.conversations.attach({
							conversationId: result.id,
							projectId: attachedProjectId,
							organizationId,
						});
					}
					eagerUserMessageIdRef.current = userMsg.id;
					// Set before `setConversationId` so the new-chat reset
					// effect recognises this as our own write and leaves it be.
					savedConversationIdRef.current = result.id;
					setConversationId(result.id);
					onConversationCreated?.(result.id);
					return result.id;
				} catch (error) {
					console.error(
						"[FabricDirectChat] Failed to create conversation:",
						error,
					);
					// Dropped so the completion path retries rather than
					// inheriting a permanently failed promise.
					eagerCreateRef.current = null;
					return null;
				}
			})();
			eagerCreateRef.current = created;
			return created;
		},
		[
			organizationId,
			currentDocumentChatId,
			instanceId,
			selectedConversationMcpIds,
			attachedProjectId,
			onConversationCreated,
		],
	);

	// Fires when the user's message enters the stream, not when the reply
	// lands — that gap is exactly the window the expand control was blocked in.
	useEffect(() => {
		if (conversationId || !isLoading || eagerCreateRef.current) {
			return;
		}
		const lastUser = [...streamMessages]
			.reverse()
			.find((m) => m.role === "user");
		if (!lastUser) {
			return;
		}
		void ensureConversation(lastUser);
	}, [streamMessages, isLoading, conversationId, ensureConversation]);

	const persistConversation = useCallback(
		async (
			userMsg: DirectStreamMessage,
			assistantMsg: DirectStreamMessage,
		) => {
			// Avoid duplicate persistence
			const persistKey = `${userMsg.id}-${assistantMsg.id}`;
			if (lastPersistedRef.current === persistKey) {
				return;
			}
			lastPersistedRef.current = persistKey;

			console.log("[FabricDirectChat] Persisting conversation...", {
				conversationId,
				organizationId,
			});

			try {
				const userPayload = {
					id: userMsg.id,
					role: "user" as const,
					content: userMsg.content,
					timestamp: userMsg.timestamp.toISOString(),
				};
				const assistantPayload = {
					id: assistantMsg.id,
					role: "assistant" as const,
					content: assistantMsg.content,
					timestamp: assistantMsg.timestamp.toISOString(),
					toolCalls: assistantMsg.toolCalls?.map((tc) => ({
						id: tc.id,
						name: tc.name,
						args: tc.args as Record<string, unknown>,
						result:
							typeof tc.result === "string"
								? tc.result
								: JSON.stringify(tc.result),
						status: toolCallToPersistedStatus(tc.status),
					})),
					// Authoritative gate is server-side in the update-conversation
					// handler (FABRIC_PERSIST_REASONING_TRACE flag); the client
					// unconditionally forwards the fields and trusts the server to
					// strip them when the flag is disabled (F-1171).
					...(assistantMsg.reasoningText !== undefined
						? {
								reasoningText: assistantMsg.reasoningText,
								reasoningDurationMs:
									assistantMsg.reasoningDurationMs,
							}
						: {}),
					// Persist stream lifecycle so a page reload still
					// surfaces the inline `Stopped` caption (spec § 5.1
					// / AC-5).
					streamStatus: assistantMsg.streamStatus,
					cancelledAt: assistantMsg.cancelledAt,
				};

				// The turn normally created the row on send. Awaiting the same
				// promise rather than testing `conversationId` closes the race
				// where a fast reply lands before that state update commits —
				// which would otherwise write the turn to a second row.
				const targetConversationId =
					conversationId ?? (await ensureConversation(userMsg));

				if (!targetConversationId) {
					// Creation failed and already logged. Bail rather than
					// call addMessage with a null id.
					return;
				}

				console.log(
					"[FabricDirectChat] Adding messages to conversation:",
					targetConversationId,
				);
				// Skipped when the eager create already wrote it, which is the
				// usual path — re-adding would duplicate the question.
				if (eagerUserMessageIdRef.current !== userMsg.id) {
					await orpcClient.agents.conversations.addMessage({
						conversationId: targetConversationId,
						message: userPayload,
					});
				}
				await orpcClient.agents.conversations.addMessage({
					conversationId: targetConversationId,
					message: assistantPayload,
				});
				onConversationSaved?.();
			} catch (error) {
				console.error(
					"[FabricDirectChat] Failed to persist conversation:",
					error,
				);
			}
		},
		[
			conversationId,
			ensureConversation,
			onConversationSaved,
			enabledFabricToolIds,
		],
	);

	// Persist when streaming completes
	useEffect(() => {
		if (streamMessages.length >= 2 && !isLoading) {
			// Find the last user and assistant message pair
			const lastAssistant = [...streamMessages]
				.reverse()
				.find((m) => m.role === "assistant" && !m.isStreaming);
			const lastUser = [...streamMessages]
				.reverse()
				.find((m) => m.role === "user");

			// Persist when there's user-visible content OR when the user
			// stopped the response before any deltas arrived. Without the
			// streamStatus check an early Stop would lose the "Stopped"
			// caption on reload (spec AC-5).
			if (
				lastUser &&
				lastAssistant &&
				(lastAssistant.content ||
					lastAssistant.streamStatus === "cancelled")
			) {
				persistConversation(lastUser, lastAssistant);

				// Check for workflow confirmation in tool results
				for (const tc of lastAssistant.toolCalls || []) {
					if (
						tc.name === "execute_workflow" ||
						tc.name.endsWith("_execute_workflow")
					) {
						const result = tc.result as any;
						if (
							result?.requiresConfirmation &&
							result?.workflowId
						) {
							setPendingConfirmation({
								workflowId: result.workflowId,
								workflowName:
									result.workflowName || "Unknown Workflow",
								workflowDescription: result.description,
								messageId: lastAssistant.id,
							});
							break;
						}
					}
				}
			}
		}
	}, [streamMessages, isLoading, persistConversation]);

	// Checkpoint handlers
	const handleCreateCheckpoint = useCallback(
		(label?: string) => {
			const messageIndex = messages.length - 1;
			const checkpoint = createCheckpoint(
				messageIndex,
				messages.length,
				label,
				{
					tokenUsage: contextInfo.usage,
					conversationId,
				},
			);
			setCheckpoints((prev) => [...prev, checkpoint]);
			toast.success("Checkpoint created", {
				description: label || `After message ${messageIndex + 1}`,
			});
		},
		[messages.length, contextInfo.usage, conversationId],
	);

	const handleRestoreCheckpoint = useCallback(
		(checkpoint: CheckpointData) => {
			// Restore to checkpoint by truncating messages
			const restoredMessages = messages.slice(0, checkpoint.messageCount);
			// For now, we reset and use loaded messages approach
			// In a full implementation, this would also restore the stream state
			setLoadedMessages(restoredMessages);
			resetStream();
			toast.info("Restored to checkpoint", {
				description:
					checkpoint.label || `${checkpoint.messageCount} messages`,
			});
		},
		[messages, resetStream],
	);

	const handleDeleteCheckpoint = useCallback((checkpointId: string) => {
		setCheckpoints((prev) => prev.filter((cp) => cp.id !== checkpointId));
		toast.success("Checkpoint deleted");
	}, []);

	// Save conversation as a reusable Skill
	const handleSaveAsSkill = useCallback(async () => {
		if (messages.length < 2) {
			toast.error("Have a conversation first before saving as a Skill");
			return;
		}

		// Extract the conversation summary for the skill
		const userMessages = messages.filter((m) => m.role === "user");
		const assistantMessages = messages.filter(
			(m) => m.role === "assistant" && m.content,
		);

		if (userMessages.length === 0 || assistantMessages.length === 0) {
			toast.error(
				"Need both user and assistant messages to save as Skill",
			);
			return;
		}

		const firstUserMsg = userMessages[0].content;
		const skillName =
			firstUserMsg.slice(0, 60) + (firstUserMsg.length > 60 ? "..." : "");
		const skillSlug = firstUserMsg
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40);

		// Build skill content from the conversation
		const skillContent = messages
			.filter((m) => m.content)
			.map(
				(m) =>
					`**${m.role === "user" ? "User" : "Assistant"}:**\n${m.content}`,
			)
			.join("\n\n---\n\n");

		try {
			await orpcClient.skills.create({
				organizationId: organizationId ?? null,
				name: skillName,
				slug: skillSlug || `skill-${Date.now()}`,
				description: `Saved from conversation: ${firstUserMsg.slice(0, 120)}`,
				content: skillContent,
			});
			toast.success("Conversation saved as Skill", {
				description: `"${skillName}" is now available via /slash-commands`,
			});
		} catch (error) {
			toast.error("Failed to save Skill", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		}
	}, [messages, organizationId]);

	// Export conversation as Markdown file download
	const handleExportConversation = useCallback(() => {
		if (messages.length === 0) {
			toast.error("No conversation to export");
			return;
		}

		const timestamp = new Date().toISOString().slice(0, 10);
		const lines = [`# Fabric Agent Conversation — ${timestamp}`, ""];

		for (const msg of messages) {
			if (!msg.content) {
				continue;
			}
			const role = msg.role === "user" ? "You" : "Fabric Agent";
			lines.push(`## ${role}`);
			lines.push("");
			lines.push(msg.content);
			lines.push("");

			if (msg.toolCalls && msg.toolCalls.length > 0) {
				lines.push("**Tools used:**");
				for (const tc of msg.toolCalls) {
					const status =
						tc.status === "complete" ? "done" : tc.status;
					lines.push(`- \`${tc.name}\` (${status})`);
				}
				lines.push("");
			}
			lines.push("---");
			lines.push("");
		}

		const markdown = lines.join("\n");
		const blob = new Blob([markdown], {
			type: "text/markdown;charset=utf-8",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `fabric-conversation-${timestamp}.md`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);

		toast.success("Conversation exported as Markdown");
	}, [messages]);

	useEffect(() => {
		if (!conversationId) {
			return;
		}

		const persistSelection = async () => {
			try {
				await orpcClient.agents.conversations.update({
					id: conversationId,
					organizationId,
					metadata: mergeDirectConversationMetadata({
						existing: activeConversation?.metadata ?? undefined,
						documentChatId: currentDocumentChatId,
						instanceId,
						selectedMcpConfigIds:
							selectedConversationMcpIds ?? undefined,
					}),
				});
			} catch (error) {
				console.error(
					"[FabricDirectChat] Failed to persist conversation tool selection:",
					error,
				);
			}
		};

		void persistSelection();
	}, [
		conversationId,
		organizationId,
		activeConversation?.metadata,
		currentDocumentChatId,
		instanceId,
		selectedConversationMcpIds,
	]);

	// File attachment handlers
	const handleFileSelect = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const files = event.target.files;
			if (!files || files.length === 0) {
				return;
			}

			const maxFileSize = DEFAULT_AI_CHAT_MAX_FILE_BYTES;

			for (const file of Array.from(files)) {
				// Validate file size
				if (file.size > maxFileSize) {
					toast.error(
						`File "${file.name}" exceeds the ${Math.round(maxFileSize / (1024 * 1024))}MB limit (${(file.size / (1024 * 1024)).toFixed(2)}MB)`,
					);
					continue;
				}

				// Validate file type against the shared vocabulary, not a
				// hand-rolled list. The `accept` attribute is derived from that
				// same vocabulary (LOOM_FILE_ACCEPT), so a local list here that
				// omitted a format — as it did for `.xlsx` and `.csv` — let the
				// picker offer a file this gate then refused. The extension is
				// the fallback: paste and drop routinely deliver files with an
				// empty `type`. Server-allowed set because Loom runs no canvas
				// step and accepts TIFF.
				if (
					!DEFAULT_AI_CHAT_MIME_ALLOWLIST.includes(file.type) &&
					!AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test(file.name)
				) {
					toast.error(`File type not supported: ${file.name}`);
					continue;
				}

				// Images reach the model base64-encoded, which costs a third
				// more than the file on disk — so a file inside the raw cap
				// above can still be refused by the provider, surfacing much
				// later as a failed request with nothing actionable in it.
				// Shrink toward the byte budget, or say why it cannot be sent.
				let prepared = file;
				if (file.type.startsWith("image/")) {
					const shaped = await prepareImageForAi(file);
					if (!shaped.ok) {
						toast.error(shaped.error);
						continue;
					}
					prepared = shaped.file;
				}
				const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				const attachedFile: AttachedFile = {
					id: fileId,
					file: prepared,
					name: file.name,
					type: prepared.type,
					size: prepared.size,
					documentId: null,
					status: "pending",
				};

				setAttachedFiles((prev) => [...prev, attachedFile]);
			}

			// Reset file input
			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
		},
		[],
	);

	const removeAttachment = useCallback((fileId: string) => {
		setAttachedFiles((prev) => prev.filter((f) => f.id !== fileId));
	}, []);

	/**
	 * Pasted/dropped image enqueuer — enqueue only, identical to the paperclip
	 * `handleFileSelect` path. The actual three-step upload
	 * (`ai.documents.createUploadUrl` → upload → `process`) runs at
	 * **send-time** inside `uploadAttachments`, so paste and paperclip share a
	 * single upload pipeline with one source of truth for status transitions,
	 * error toasts, and chat-id assignment.
	 *
	 * Stable across renders so `ChatInput` does not reattach `onPaste`
	 * (decisions §6.2 — Loom is on a hot path).
	 */
	const pastedImageUploader = useCallback(
		async (file: File, _signal: AbortSignal): Promise<void> => {
			const fileId = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setAttachedFiles((prev) => [
				...prev,
				{
					id: fileId,
					file,
					name: file.name || "pasted-image",
					type: file.type || "application/octet-stream",
					size: file.size,
					documentId: null,
					status: "pending",
				},
			]);
		},
		[],
	);

	/**
	 * Mixed paste/drop — non-image files are routed to the existing file
	 * picker queue.
	 *
	 * The clipboard splitter sorts by `file.type.startsWith("image/")`, so a
	 * well-typed image never arrives here. A *badly*-typed one does: a `.png`
	 * whose `type` is empty (common for drags out of some apps and archives)
	 * fails the prefix test and lands in this queue. The list below therefore
	 * has to carry the image formats too — otherwise the same file is accepted
	 * through the paperclip and refused on paste, which is the divergence the
	 * previous comment here claimed did not exist.
	 */
	const onPasteNonImageFiles = useCallback((files: File[]): void => {
		const maxFileSize = DEFAULT_AI_CHAT_MAX_FILE_BYTES;

		for (const file of files) {
			if (file.size > maxFileSize) {
				toast.error(
					`File "${file.name}" exceeds the ${Math.round(maxFileSize / (1024 * 1024))}MB limit (${(file.size / (1024 * 1024)).toFixed(2)}MB)`,
				);
				continue;
			}
			// Same shared-vocabulary gate as the picker path above, so paste
			// and paperclip admit exactly the same formats. Server-allowed
			// extension set: Loom runs no canvas step and accepts TIFF.
			if (
				!DEFAULT_AI_CHAT_MIME_ALLOWLIST.includes(file.type) &&
				!AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test(file.name)
			) {
				toast.error(`File type not supported: ${file.name}`);
				continue;
			}
			const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setAttachedFiles((prev) => [
				...prev,
				{
					id: fileId,
					file,
					name: file.name,
					type: file.type,
					size: file.size,
					documentId: null,
					status: "pending",
				},
			]);
		}
	}, []);

	/**
	 * Upload attachments to S3 and trigger document processing
	 * Returns both document IDs and the chat ID where documents are stored
	 */
	const uploadAttachments = useCallback(async (): Promise<{
		documentIds: string[];
		inlineContexts: string[];
		chatId: string | undefined;
	}> => {
		const pendingFiles = attachedFiles.filter(
			(f) => f.status === "pending",
		);
		if (pendingFiles.length === 0) {
			return { documentIds: [], inlineContexts: [], chatId: undefined };
		}

		const documentIds: string[] = [];
		const inlineContexts: string[] = [];

		// Track the AiChat ID for documents (separate from AgentConversation)
		// This is critical for RAG context retrieval - documents are stored with this chatId
		// IMPORTANT: Start with existing chatId to add new documents to the same chat
		let aiChatId: string | undefined = currentDocumentChatId || undefined;

		for (const attachedFile of pendingFiles) {
			try {
				// Update status to uploading
				setAttachedFiles((prev) =>
					prev.map((f) =>
						f.id === attachedFile.id
							? { ...f, status: "uploading" as const }
							: f,
					),
				);

				// Request signed upload URL - API auto-creates chat if needed
				const {
					documentId,
					signedUploadUrl,
					useServerUpload,
					chatId: returnedChatId,
				} = await orpcClient.ai.documents.createUploadUrl({
					chatId: aiChatId, // Reuse the same chat for all documents
					organizationId: organizationId || undefined,
					filename: attachedFile.name,
					mimeType: attachedFile.type || "application/octet-stream",
					size: attachedFile.size,
				});

				// Store the chat ID for subsequent uploads and RAG retrieval
				if (!aiChatId && returnedChatId) {
					aiChatId = returnedChatId;
					console.log(
						"[FabricDirectChat] Got chatId for documents:",
						aiChatId,
					);
					// Store locally for persistence in conversation metadata
					setCurrentDocumentChatId(returnedChatId);
					// Notify parent component so it can display documents in sidebar
					onDocumentChatCreated?.(returnedChatId);
				}

				// Upload file - use presigned URL if available, otherwise server-side upload
				if (signedUploadUrl) {
					// Direct upload to S3 using presigned URL.
					//
					// `fetch` rejects only on a network-level failure: a 403 from
					// an expired signature or a 500 from storage resolves
					// normally. Without this check the catch below never fires,
					// the chip advances to `ready`, and `toast.success` tells the
					// user the file arrived when nothing was stored. The Feature
					// Assistant and Nexus have both checked this all along — Loom
					// was the one surface that did not.
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
					// Server-side upload for providers like Vercel Blob
					// Convert file to base64
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

				// Update status to processing and store chatId for RAG retrieval
				setAttachedFiles((prev) =>
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

				// Trigger document processing.
				//
				// The return value was previously discarded. It carries both
				// halves of what this surface was missing: the extracted text
				// (which becomes the inline envelope) and the outcome (which is
				// the only way the user learns a file was truncated, carried no
				// readable text, or could not be read at all).
				const processed = await orpcClient.ai.documents.process({
					documentId,
				});
				// No budget applied here: `process` already bounds what it
				// returns, and re-cutting client-side would report a second
				// truncation the user was never subject to.
				const contextEntry = buildAiChatAttachmentEntry(
					attachedFile.name,
					processed?.extractedContent ?? "",
				);

				// Update status to ready, carrying what was read
				setAttachedFiles((prev) =>
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
				console.error("File upload error:", error);
				setAttachedFiles((prev) =>
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
	}, [attachedFiles, organizationId, onDocumentChatCreated]);

	const sendMessage = async () => {
		if (!input.trim() || isLoading) {
			return;
		}

		let messageContent = input.trim();
		setInput("");

		// Resolve file:line references if repository is connected
		if (hasCodeReferences(messageContent) && !repositoryUrl) {
			toast.info(
				"Connect a repository to resolve file:line references in launcher chat.",
			);
		}
		const { resolvedText, refs, unresolvedRefs } =
			await resolveCodeReferences(messageContent);
		if (refs.length > 0) {
			messageContent = resolvedText;
			setResolvedCodeReferences(refs);
			toast.success(
				unresolvedRefs.length > 0
					? `Resolved ${refs.length} code reference${refs.length > 1 ? "s" : ""}. ${unresolvedRefs.length} could not be loaded.`
					: `Resolved ${refs.length} code reference${refs.length > 1 ? "s" : ""}`,
			);
		} else if (unresolvedRefs.length > 0) {
			setResolvedCodeReferences([]);
			setResolvedCodeReferencePreviews([]);
			toast.info(
				`Found ${unresolvedRefs.length} code reference${unresolvedRefs.length > 1 ? "s" : ""}, but Fabric Agent could not load them from the connected repository.`,
			);
		} else if (!hasCodeReferences(messageContent)) {
			setResolvedCodeReferences([]);
			setResolvedCodeReferencePreviews([]);
		}

		// Capture filenames BEFORE we clear `attachedFiles` so the bubble
		// caption can render the names on the user message that's about to
		// be added by `streamSendMessage`. Filenames-only — never IDs,
		// never extracted content — to keep the wire payload predictable
		// and avoid leaking content paths into UI state.
		const attachmentNames = attachedFiles
			.map((f) => f.name)
			.filter((name): name is string => Boolean(name));

		// Upload any pending attachments first and get the chatId for RAG
		let attachedDocumentIds: string[] = [];
		let inlineAttachmentContexts: string[] = [];
		let documentsChatId: string | undefined;

		if (attachedFiles.some((f) => f.status === "pending")) {
			const uploadResult = await uploadAttachments();
			attachedDocumentIds = uploadResult.documentIds;
			inlineAttachmentContexts = uploadResult.inlineContexts;
			documentsChatId = uploadResult.chatId;
			console.log("[FabricDirectChat] Upload result:", {
				documentIds: attachedDocumentIds,
				chatId: documentsChatId,
			});
		} else {
			// Get document IDs and chatId from already uploaded files
			const readyFiles = attachedFiles.filter(
				(f) => f.status === "ready" && f.documentId,
			);
			attachedDocumentIds = readyFiles.map((f) => f.documentId as string);
			// The envelope was built when the file finished processing, so a
			// re-send of an already-uploaded attachment delivers the same text
			// rather than silently degrading to retrieval-only.
			inlineAttachmentContexts = readyFiles
				.map((f) => f.contextEntry)
				.filter((entry): entry is string => Boolean(entry));
			// Get chatId from the first file that has it (all files in same upload share the same chatId)
			documentsChatId = readyFiles.find((f) => f.chatId)?.chatId;
		}

		// IMPORTANT: For follow-up messages, use currentDocumentChatId even if no new files attached
		// This ensures RAG can find all documents uploaded in this conversation session
		if (!documentsChatId && currentDocumentChatId) {
			documentsChatId = currentDocumentChatId;
			console.log(
				"[FabricDirectChat] Using existing documentChatId for RAG:",
				documentsChatId,
			);
		}

		// Clear attachments after getting IDs
		setAttachedFiles([]);

		// Build history from current messages
		const history = messages.map((m) => ({
			role: m.role,
			content: m.content,
		}));

		// Determine if this is the first message or a follow-up
		const isFirstMessage = messages.length === 0;

		// CRITICAL FIX: If we have messages from loaded history but streamMessages is empty,
		// we need to pass the existing messages to the hook so it can include them.
		// This avoids React batching issues where seedMessages + setMessages in the same
		// render cycle causes stale state.
		const existingMessagesToInclude =
			!isFirstMessage &&
			streamMessages.length === 0 &&
			messages.length > 0
				? messages
				: undefined;

		if (existingMessagesToInclude) {
			console.log(
				"[FabricDirectChat] Including existing messages in stream:",
				existingMessagesToInclude.length,
			);
		}

		// Use streaming hook to send message with document IDs and chatId for RAG
		// The chatId is critical - it tells the RAG system where to find the document chunks
		await streamSendMessage(
			messageContent,
			history,
			isFirstMessage,
			attachedDocumentIds.length > 0 ? attachedDocumentIds : undefined,
			documentsChatId, // Pass the chatId where documents are stored
			existingMessagesToInclude, // Pass existing messages to avoid React batching issues
			attachmentNames.length > 0 ? attachmentNames : undefined,
			inlineAttachmentContexts.length > 0
				? inlineAttachmentContexts
				: undefined,
		);
	};

	// State for workflow execution
	const [isExecutingWorkflow, setIsExecutingWorkflow] = useState(false);

	// Handle workflow execution confirmation - calls direct API, bypasses AI
	const handleConfirmExecution = useCallback(async () => {
		if (!pendingConfirmation) {
			return;
		}

		const confirmation = pendingConfirmation;
		setPendingConfirmation(null);
		setIsExecutingWorkflow(true);

		try {
			// NOTE: organizationId is intentionally NOT sent in the body.
			// The backend resolves it from the session to prevent cross-tenant access.
			const response = await fetch(
				"/api/agents/fabric-ai/execute-workflow",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workflowId: confirmation.workflowId,
					}),
				},
			);

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || "Failed to execute workflow");
			}

			toast.success("Workflow started", { description: data.message });

			// Send a follow-up message through the stream to show success
			await streamSendMessage(
				`The workflow "${confirmation.workflowName}" has been executed successfully.`,
				messages.map((m) => ({ role: m.role, content: m.content })),
			);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "An error occurred";
			toast.error("Execution failed", { description: errorMessage });
		} finally {
			setIsExecutingWorkflow(false);
		}
	}, [pendingConfirmation, organizationId, streamSendMessage, messages]);

	const handleDeclineExecution = useCallback(() => {
		if (!pendingConfirmation) {
			return;
		}

		setPendingConfirmation(null);
		toast.info("Workflow execution cancelled");
	}, [pendingConfirmation]);

	// Quick suggestion chips for welcome screen
	const quickSuggestions = [
		{
			label: "Plan",
			icon: <NotebookPen className="h-4 w-4" />,
			value: "Help me plan a new feature",
		},
		{
			label: "Code",
			icon: <SquareTerminal className="h-4 w-4" />,
			value: "Write code to implement this",
		},
		{
			label: "Document",
			icon: <ScrollText className="h-4 w-4" />,
			value: "Generate documentation",
		},
	];

	const handleSuggestionClick = (value: string) => {
		setInput(value);
		inputRef.current?.focus();
	};

	const handleActionPrompt = (value: string) => {
		setInput(value);
		inputRef.current?.focus();
	};

	const extractTaskDrafts = (content: string): ProposedTaskDraft[] => {
		const seen = new Set<string>();
		return content
			.split("\n")
			.map((line) =>
				line
					.trim()
					.replace(/^[-*]\s+/, "")
					.replace(/^\d+[.)]\s+/, "")
					.replace(/^\[[ xX]]\s+/, "")
					.replace(/^#+\s+/, ""),
			)
			.filter((line) => line.length >= 8 && line.length <= 180)
			.filter((line) => {
				const lower = line.toLowerCase();
				return ![
					"summary",
					"risks",
					"sources",
					"next steps",
					"implementation plan",
				].some(
					(heading) =>
						lower === heading || lower.startsWith(`${heading}:`),
				);
			})
			.map((line) => {
				const [title, ...rest] = line.split(/\s+[—–-]\s+|:\s+/);
				return {
					id: `task-${Math.random().toString(36).slice(2)}`,
					title: title.trim().slice(0, 120),
					description: rest.join(": ").trim() || undefined,
				};
			})
			.filter((task) => {
				const key = task.title.toLowerCase();
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			})
			.slice(0, 8);
	};

	const handlePreviewTasks = (message: DirectStreamMessage) => {
		const tasks = extractTaskDrafts(message.content);
		if (tasks.length === 0) {
			toast.info("No clear task list found", {
				description:
					"Ask Fabric to create an implementation checklist first, then preview tasks again.",
			});
			return;
		}
		setPendingTaskDraft({ messageId: message.id, tasks });
	};

	const handleCreateApprovedTasks = async () => {
		if (!pendingTaskDraft || !attachedProjectId || !attachedStoryId) {
			return;
		}

		setIsCreatingTasks(true);
		try {
			for (const task of pendingTaskDraft.tasks) {
				await orpcClient.projects.stories.tasks.create({
					projectId: attachedProjectId,
					storyId: attachedStoryId,
					organizationId: organizationId ?? null,
					title: task.title,
					description: task.description,
				});
			}
			toast.success("Tasks created", {
				description: `${pendingTaskDraft.tasks.length} task${pendingTaskDraft.tasks.length === 1 ? "" : "s"} added to the feature.`,
			});
			setPendingTaskDraft(null);
		} catch (error) {
			toast.error("Failed to create tasks", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsCreatingTasks(false);
		}
	};

	const buildProjectUpdateTitle = () => {
		const date = new Date().toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
		return `Project update draft — ${date}`;
	};

	const slugifySkillName = (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || `skill-${Date.now()}`;

	const buildSkillNameFromMessage = (message: DirectStreamMessage) => {
		const firstHeading = message.content
			.split("\n")
			.map((line) => line.trim().replace(/^#+\s+/, ""))
			.find((line) => line.length >= 8 && line.length <= 80);
		return firstHeading ?? "Reusable Fabric workflow";
	};

	const handlePreviewProjectUpdate = (message: DirectStreamMessage) => {
		setPendingProjectUpdateDraft({
			messageId: message.id,
			title: buildProjectUpdateTitle(),
			content: message.content.trim(),
		});
	};

	const handleSaveProjectUpdateDraft = async () => {
		if (!pendingProjectUpdateDraft || !attachedProjectId) {
			return;
		}

		setIsSavingProjectUpdateDraft(true);
		try {
			await orpcClient.artifacts.create({
				organizationId: organizationId ?? null,
				conversationId: conversationId ?? undefined,
				instanceId,
				projectId: attachedProjectId,
				type: "SUMMARY",
				title: pendingProjectUpdateDraft.title,
				description:
					"Draft project update created from a Fabric Agent response.",
				content: pendingProjectUpdateDraft.content,
				mimeType: "text/markdown",
				metadata: {
					kind: "project_update_draft",
					source: "fabric_agent_action_card",
					messageId: pendingProjectUpdateDraft.messageId,
				},
			});
			toast.success("Project update draft saved", {
				description:
					"Saved as a project artifact. You can review and edit it before sharing.",
			});
			setPendingProjectUpdateDraft(null);
		} catch (error) {
			toast.error("Failed to save draft", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsSavingProjectUpdateDraft(false);
		}
	};

	const handlePreviewImplementationSession = (
		message: DirectStreamMessage,
	) => {
		setPendingImplementationSession({
			messageId: message.id,
			summary: message.content.trim().slice(0, 1200),
		});
	};

	const handlePreviewSkillDraft = (message: DirectStreamMessage) => {
		const name = buildSkillNameFromMessage(message);
		const tags = ["fabric-agent"];
		if (attachedProjectId) {
			tags.push("project-workflow");
		}
		setPendingSkillDraft({
			messageId: message.id,
			name,
			slug: slugifySkillName(name),
			description: `Reusable workflow saved from Fabric Agent: ${message.content
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 160)}`,
			content: [
				"# Saved Fabric Agent Skill",
				"",
				"Use this workflow when the user asks for a similar outcome. Keep outputs advisory, cite sources where available, and ask for approval before making changes.",
				"",
				"## Workflow captured from conversation",
				message.content.trim(),
			].join("\n"),
			tags,
			scope: organizationId ? "ORGANIZATION" : "USER",
		});
	};

	const handleSaveApprovedSkill = async () => {
		if (!pendingSkillDraft) {
			return;
		}

		setIsSavingSkillDraft(true);
		try {
			const { skill } = await orpcClient.skills.create({
				organizationId: organizationId ?? null,
				name: pendingSkillDraft.name,
				slug: pendingSkillDraft.slug,
				description: pendingSkillDraft.description,
				content: pendingSkillDraft.content,
				tags: pendingSkillDraft.tags,
				scope: pendingSkillDraft.scope,
				isPublished: true,
			});
			toast.success("Skill saved", {
				description: `"${pendingSkillDraft.name}" is now available from the skills menu.`,
			});
			setSavedSkillAutomationPrompt({
				skillId: skill.id,
				skillName: skill.name,
				existingTags: skill.tags ?? pendingSkillDraft.tags,
				columnTag: "triage",
			});
			setPendingSkillDraft(null);
		} catch (error) {
			toast.error("Failed to save Skill", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsSavingSkillDraft(false);
		}
	};

	const handleSaveAutomationTag = async () => {
		if (!savedSkillAutomationPrompt) {
			return;
		}

		const columnTag = savedSkillAutomationPrompt.columnTag
			.trim()
			.toLowerCase();
		if (!columnTag) {
			toast.error("Enter a column tag first");
			return;
		}

		setIsSavingAutomationTag(true);
		try {
			const tags = Array.from(
				new Set([
					...savedSkillAutomationPrompt.existingTags,
					columnTag,
				]),
			);
			await orpcClient.skills.update({
				id: savedSkillAutomationPrompt.skillId,
				organizationId: organizationId ?? null,
				tags,
			});
			toast.success("Automation trigger saved", {
				description: `Skill will run when a feature enters a column tagged "${columnTag}".`,
			});
			setSavedSkillAutomationPrompt(null);
		} catch (error) {
			toast.error("Failed to save automation trigger", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsSavingAutomationTag(false);
		}
	};

	const handleStartImplementationSession = async () => {
		if (
			!pendingImplementationSession ||
			!attachedProjectId ||
			!attachedStoryId
		) {
			return;
		}

		setIsStartingImplementationSession(true);
		try {
			const result = await orpcClient.codingRuns.start({
				projectId: attachedProjectId,
				storyId: attachedStoryId,
				taskId: attachedTaskId ?? undefined,
				organizationId: organizationId ?? null,
				executionChannel: "BACKGROUND_AGENTS",
				provider: "BACKGROUND_AGENTS",
			});
			toast.success("Implementation session started", {
				description: `Coding run ${result.codingRunId} is queued.`,
			});
			setPendingImplementationSession(null);
		} catch (error) {
			toast.error("Failed to start implementation session", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsStartingImplementationSession(false);
		}
	};

	const buildAssistantActionCards = (message: DirectStreamMessage) => {
		if (!shouldShowAssistantActionCards(message, attachedProjectId)) {
			return [];
		}

		return [
			...(attachedStoryId
				? [
						{
							label: "Preview tasks",
							description:
								"Review extracted tasks, then approve creation.",
							icon: <ListChecksIcon className="size-3.5" />,
							onClick: () => handlePreviewTasks(message),
						},
					]
				: []),
			{
				label: "Preview update draft",
				description:
					"Review this answer as a project update draft before saving.",
				icon: <FilePenLineIcon className="size-3.5" />,
				onClick: () => handlePreviewProjectUpdate(message),
			},
			{
				label: "Draft project update",
				description: "Ask Fabric to rewrite this as an update first.",
				icon: <ScrollText className="size-3.5" />,
				onClick: () =>
					handleActionPrompt(
						"Using your previous response and the active project context, draft a concise project update. Keep it editable, cite source records, and do not publish it.",
					),
			},
			{
				label: "Create checklist",
				description:
					"Convert the recommendation into reviewable tasks/checks.",
				icon: <CheckCircle2 className="size-3.5" />,
				onClick: () =>
					handleActionPrompt(
						"Using your previous response and the active project context, turn this into a concise implementation checklist with validation steps. Do not create or update tasks unless I explicitly approve it. Put each proposed task on its own bullet line.",
					),
			},
			...(attachedStoryId
				? [
						{
							label: "Preview implementation handoff",
							description:
								"Review before starting a background implementation session.",
							icon: <SquareTerminal className="size-3.5" />,
							onClick: () =>
								handlePreviewImplementationSession(message),
						},
					]
				: []),
			{
				label: "Save workflow as Skill",
				description: "Preview reusable Skill metadata before saving.",
				icon: <BookmarkIcon className="size-3.5" />,
				onClick: () => handlePreviewSkillDraft(message),
			},
			{
				label: "Plan implementation",
				description:
					"Prepare a safe implementation plan before any handoff.",
				icon: <GitBranch className="size-3.5" />,
				onClick: () =>
					handleActionPrompt(
						"Using your previous response and the active project context, propose an implementation plan. Recommend whether planning, local agents, workspace agents, or background agents fit best, and ask for approval before starting anything.",
					),
			},
		];
	};

	return (
		<div className="flex h-full overflow-hidden">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* Messages Area */}
				{messages.length === 0 ? (
					compactMode ? (
						<div className="flex h-full flex-col px-4 py-4 sm:px-5 sm:py-5">
							<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-start gap-4">
								<div className="space-y-2">
									<h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
										{instanceId
											? "What should this agent do?"
											: "What can I help you build?"}
									</h2>
									<p className="max-w-2xl text-sm leading-6 text-muted-foreground">
										{instanceId
											? "This chat uses the agent's own instructions and attached tools."
											: "Your intelligent assistant for planning, coding, and more."}
									</p>
								</div>

								<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
									{quickSuggestions.map((suggestion) => (
										<button
											type="button"
											key={suggestion.label}
											onClick={() =>
												handleSuggestionClick(
													suggestion.value,
												)
											}
											className="flex min-h-24 flex-col items-start justify-between rounded-xl border border-border/70 bg-card px-3 py-3 text-left shadow-sm transition-colors hover:border-primary/30 hover:bg-accent/40"
										>
											<div className="flex size-8 items-center justify-center rounded-lg border border-primary/15 bg-primary/8 text-primary">
												{suggestion.icon}
											</div>
											<div className="space-y-1">
												<p className="text-sm font-medium text-foreground">
													{suggestion.label}
												</p>
												<p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
													{suggestion.value}
												</p>
											</div>
										</button>
									))}
								</div>
							</div>
						</div>
					) : (
						<ChatWelcome
							title={
								instanceId
									? "What should this agent do?"
									: "What can I help you build?"
							}
							subtitle={
								instanceId
									? "This chat uses the agent's own instructions and attached tools."
									: "Your intelligent assistant for planning, coding, and more"
							}
							suggestions={quickSuggestions}
							categories={[]} // No categories for direct mode - keep it simple
							onSuggestionClick={handleSuggestionClick}
						/>
					)
				) : (
					<Conversation className="flex-1 relative">
						<ConversationContent className="space-y-1 max-w-4xl mx-auto px-4 py-4">
							{messages.map((message) => {
								const actionCards =
									buildAssistantActionCards(message);
								// Caption rendered OUTSIDE the bubble for parity
								// with the AI Feature Assistant (PR #727):
								// paperclip + 11px filename, right-aligned,
								// no border / no background. Skipped on
								// assistant messages and on legacy
								// persisted user messages without
								// `attachmentNames`.
								const captionNames =
									message.role === "user" &&
									message.attachmentNames
										? message.attachmentNames
										: [];
								const trajectorySteps =
									message.role === "assistant"
										? deriveTrajectorySteps(message)
										: [];
								return (
									<Fragment key={message.id}>
										<Message
											from={message.role}
											className={cn(
												message.isError &&
													"bg-destructive/5 rounded-lg",
											)}
										>
											{/* Avatar */}
											{message.role === "assistant" ? (
												<div className="shrink-0 mt-1">
													<FabricLogo
														className="h-8 w-8"
														size={32}
													/>
												</div>
											) : (
												<MessageAvatar
													src={userAvatarSrc}
													name={userDisplayName}
													className="mt-1"
												/>
											)}

											{/* Message Content */}
											<MessageContent
												variant="flat"
												className={cn(
													message.role ===
														"assistant" &&
														"space-y-3",
													message.isError &&
														"border border-destructive/20",
												)}
											>
												{showTrajectorySteps &&
													trajectorySteps.length >
														0 && (
														<TrajectorySteps
															steps={
																trajectorySteps
															}
															isRunning={
																message.isStreaming ===
																true
															}
															defaultExpanded={
																message.isStreaming ===
																true
															}
															// `stepsExpandable={false}` mirrors the
															// `expandable={false}` we pass to ToolCallList
															// below. Without this, the inline trajectory
															// steps inside the "Reasoning Trace" box still
															// expand to raw Tool/Input/Output JSON — the
															// user reported this on staging after PR 1093:
															// the bottom "skill · Completed" card no longer
															// expanded but the in-trace step did. Both
															// surfaces now consistently render as static
															// rows in Fabric Loom.
															stepsExpandable={
																false
															}
														/>
													)}

												{/* Tool Calls - using shared ToolCallList component.
												 *
												 * `expandable={false}` collapses each tool/skill card
												 * to a static pill — no chevron, no click, no
												 * Parameters/Result JSON dump. The Fabric Loom launcher
												 * is a quick page copilot; users want to know WHICH
												 * tool ran (e.g., "skill · visual-generate-plan ·
												 * Completed") without seeing the raw envelope.
												 * Surfaces that need inspection (Orchestrator chat,
												 * agent runs) keep the default expandable=true.
												 */}
												{message.toolCalls &&
													message.toolCalls.length >
														0 && (
														<ToolCallList
															toolCalls={message.toolCalls.map(
																(
																	tc,
																	idx,
																): ToolCallItem => ({
																	id: `${message.id}-${idx}`,
																	name: tc.name,
																	serverName:
																		tc.serverName,
																	args: tc.args,
																	result: tc.result,
																	status: tc.status,
																}),
															)}
															defaultOpen={false}
															expandable={false}
															getDisplayName={
																getOriginalToolName
															}
															activeFrameId={
																activeFrame?.frameId
															}
															onOpenFrame={
																openFrame
															}
														/>
													)}

												{/* MCP App interactive UIs */}
												{message.toolCalls
													?.filter(
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

														// Excalidraw chat -> editor auto-insert (spec § 8.1 wiring
														// F3). The button is rendered as a sibling BELOW each
														// `<McpAppFrame>` ONLY for successful Excalidraw
														// `create_view` results — McpAppFrame itself is not
														// modified. Non-Excalidraw MCP resources
														// (calendar widgets, etc.) skip the button entirely.
														const isExcalidrawCreateView =
															tc.mcpAppResourceUri.includes(
																"excalidraw",
															) &&
															tc.status ===
																"complete";
														const excalidrawArgs =
															isExcalidrawCreateView &&
															tc.args &&
															typeof tc.args ===
																"object"
																? (tc.args as Record<
																		string,
																		unknown
																	>)
																: null;
														const excalidrawResult =
															isExcalidrawCreateView &&
															tc.result &&
															typeof tc.result ===
																"object"
																? (tc.result as Record<
																		string,
																		unknown
																	>)
																: null;
														const excalidrawCheckpointId =
															excalidrawResult &&
															typeof excalidrawResult.checkpointId ===
																"string"
																? excalidrawResult.checkpointId
																: excalidrawResult &&
																		typeof (
																			excalidrawResult as {
																				checkpoint_id?: unknown;
																			}
																		)
																			.checkpoint_id ===
																			"string"
																	? (
																			excalidrawResult as {
																				checkpoint_id: string;
																			}
																		)
																			.checkpoint_id
																	: "";
														const derivedTitle =
															deriveDiagramTitle({
																userPromptText:
																	composedChatScope.lastUserPromptForMessage(
																		message.id,
																	),
															});

														return (
															<Fragment
																key={tc.id}
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
																	className="mt-2"
																	onUpdateModelContext={(
																		content,
																	) => {
																		const text =
																			content
																				.filter(
																					(
																						c: any,
																					) =>
																						c?.type ===
																							"text" &&
																						c?.text,
																				)
																				.map(
																					(
																						c: any,
																					) =>
																						c.text,
																				)
																				.join(
																					"\n",
																				);
																		if (
																			text
																		) {
																			console.info(
																				"[DirectChat] Diagram edit context:",
																				text,
																			);
																		}
																	}}
																/>
																{isExcalidrawCreateView ? (
																	<ChatMessageInsertDiagramButton
																		surface="in-feature"
																		chatMessageId={
																			message.id
																		}
																		toolResult={{
																			elements:
																				excalidrawArgs?.elements,
																			appState:
																				excalidrawArgs?.appState,
																			checkpointId:
																				excalidrawCheckpointId,
																			mcpConfigId:
																				tc.mcpAppConfigId,
																			resourceUri:
																				tc.mcpAppResourceUri,
																		}}
																		organizationSlug={
																			activeOrgSlug
																		}
																		chatScope={
																			composedChatScope
																		}
																		resolverOptions={
																			excalidrawResolverOptions
																		}
																		resolverTarget={
																			excalidrawResolverTarget
																		}
																		title={
																			derivedTitle
																		}
																	/>
																) : null}
															</Fragment>
														);
													})}

												{/* Message Content - using ai-elements Response for proper markdown */}
												{message.content ? (
													<Response
														streaming={
															message.isStreaming
														}
													>
														{message.content}
													</Response>
												) : (
													/* Show "AI is thinking..." for streaming assistant with no content yet */
													message.role ===
														"assistant" &&
													message.isStreaming &&
													!(
														message.toolCalls
															?.length ?? 0
													) && (
														<div className="flex items-center gap-2">
															<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
															<span className="text-sm text-muted-foreground">
																{message.statusLabel ||
																	"AI is thinking..."}
															</span>
														</div>
													)
												)}

												{/* Editorial "Stopped" chip — rendered at the
												 * end of the assistant turn when the user
												 * halted it (spec § 4.2 / 8.9). */}
												{message.role === "assistant" &&
													message.streamStatus ===
														"cancelled" && (
														<StoppedIndicator />
													)}

												{/* RAG Sources - show document citations when available */}
												{message.sources &&
													message.sources.length >
														0 && (
														<div className="mt-3 pt-3 border-t border-muted">
															<Sources
																sources={
																	message.sources
																}
																defaultOpen={
																	false
																}
															/>
														</div>
													)}

												{actionCards.length > 0 && (
													<div className="mt-3 rounded-xl border border-border/70 bg-muted/25 p-3">
														<div className="mb-2 flex items-center justify-between gap-2">
															<div>
																<p className="text-xs font-semibold text-foreground">
																	Suggested
																	next actions
																</p>
																<p className="text-[11px] text-muted-foreground">
																	Draft-only.
																	Nothing
																	changes
																	until you
																	approve it.
																</p>
															</div>
															<Badge
																variant="secondary"
																className="text-[10px]"
															>
																Preview
															</Badge>
														</div>
														<div className="grid gap-2 sm:grid-cols-3">
															{actionCards.map(
																(action) => (
																	<button
																		key={
																			action.label
																		}
																		type="button"
																		onClick={
																			action.onClick
																		}
																		className="rounded-lg border border-border/70 bg-background/70 p-2 text-left transition-colors hover:border-primary/35 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
																	>
																		<div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
																			<span className="text-primary">
																				{
																					action.icon
																				}
																			</span>
																			{
																				action.label
																			}
																		</div>
																		<p className="text-[11px] leading-4 text-muted-foreground">
																			{
																				action.description
																			}
																		</p>
																	</button>
																),
															)}
														</div>
														<div className="mt-2 flex justify-end">
															<Button
																type="button"
																variant="ghost"
																size="sm"
																className="h-7 px-2 text-[11px]"
																onClick={() =>
																	handlePreviewSkillDraft(
																		message,
																	)
																}
															>
																<BookmarkIcon className="mr-1 size-3" />
																Save as Skill
															</Button>
														</div>
													</div>
												)}

												{pendingTaskDraft?.messageId ===
													message.id && (
													<Confirmation
														approvalState="requested"
														className="mt-3"
													>
														<ConfirmationTitle>
															<ConfirmationIcon />
															Create feature tasks
														</ConfirmationTitle>
														<ConfirmationDescription>
															Review the proposed
															tasks below. Fabric
															will only add them
															after you approve.
														</ConfirmationDescription>
														<div className="mt-3 space-y-2">
															{pendingTaskDraft.tasks.map(
																(task) => (
																	<div
																		key={
																			task.id
																		}
																		className="rounded-lg border border-border/70 bg-background/70 px-3 py-2"
																	>
																		<p className="text-sm font-medium text-foreground">
																			{
																				task.title
																			}
																		</p>
																		{task.description && (
																			<p className="mt-1 text-xs text-muted-foreground">
																				{
																					task.description
																				}
																			</p>
																		)}
																	</div>
																),
															)}
														</div>
														<ConfirmationRequest>
															<ConfirmationActions>
																<ConfirmationAction
																	onClick={
																		handleCreateApprovedTasks
																	}
																	disabled={
																		isLoading ||
																		isCreatingTasks
																	}
																	className="bg-green-600 text-white hover:bg-green-700"
																>
																	<CheckCircle2 className="mr-2 h-4 w-4" />
																	Create tasks
																</ConfirmationAction>
																<ConfirmationAction
																	onClick={() =>
																		setPendingTaskDraft(
																			null,
																		)
																	}
																	disabled={
																		isLoading ||
																		isCreatingTasks
																	}
																	variant="outline"
																	className="border-red-300 text-destructive hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
																>
																	<XCircle className="mr-2 h-4 w-4" />
																	Cancel
																</ConfirmationAction>
															</ConfirmationActions>
														</ConfirmationRequest>
													</Confirmation>
												)}

												{pendingProjectUpdateDraft?.messageId ===
													message.id && (
													<Confirmation
														approvalState="requested"
														className="mt-3"
													>
														<ConfirmationTitle>
															<ConfirmationIcon />
															Save project update
															draft
														</ConfirmationTitle>
														<ConfirmationDescription>
															Fabric will save
															this as a project
															artifact only after
															you approve. You can
															review and edit it
															before sharing.
														</ConfirmationDescription>
														<div className="mt-3 rounded-lg border border-border/70 bg-background/70 p-3">
															<p className="text-sm font-medium text-foreground">
																{
																	pendingProjectUpdateDraft.title
																}
															</p>
															<div className="mt-2 max-h-48 overflow-y-auto rounded border border-border/50 bg-muted/20 p-2 text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
																{
																	pendingProjectUpdateDraft.content
																}
															</div>
														</div>
														<ConfirmationRequest>
															<ConfirmationActions>
																<ConfirmationAction
																	onClick={
																		handleSaveProjectUpdateDraft
																	}
																	disabled={
																		isLoading ||
																		isSavingProjectUpdateDraft
																	}
																	className="bg-green-600 text-white hover:bg-green-700"
																>
																	<CheckCircle2 className="mr-2 h-4 w-4" />
																	Save draft
																</ConfirmationAction>
																<ConfirmationAction
																	onClick={() =>
																		setPendingProjectUpdateDraft(
																			null,
																		)
																	}
																	disabled={
																		isLoading ||
																		isSavingProjectUpdateDraft
																	}
																	variant="outline"
																	className="border-red-300 text-destructive hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
																>
																	<XCircle className="mr-2 h-4 w-4" />
																	Cancel
																</ConfirmationAction>
															</ConfirmationActions>
														</ConfirmationRequest>
													</Confirmation>
												)}

												{pendingImplementationSession?.messageId ===
													message.id && (
													<Confirmation
														approvalState="requested"
														className="mt-3"
													>
														<ConfirmationTitle>
															<ConfirmationIcon />
															Start implementation
															session
														</ConfirmationTitle>
														<ConfirmationDescription>
															Fabric will start a
															Background Agents
															implementation
															session for this
															feature only after
															you approve.
														</ConfirmationDescription>
														<div className="mt-3 space-y-2 rounded-lg border border-border/70 bg-background/70 p-3 text-xs">
															<div className="grid gap-2 sm:grid-cols-2">
																<div>
																	<p className="font-medium text-foreground">
																		Provider
																	</p>
																	<p className="text-muted-foreground">
																		Background
																		Agents
																	</p>
																</div>
																<div>
																	<p className="font-medium text-foreground">
																		Scope
																	</p>
																	<p className="text-muted-foreground">
																		{attachedTaskId
																			? "Current task"
																			: "Current feature"}
																	</p>
																</div>
															</div>
															<div>
																<p className="font-medium text-foreground">
																	Agent
																	context
																	preview
																</p>
																<div className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap rounded border border-border/50 bg-muted/20 p-2 text-muted-foreground">
																	{
																		pendingImplementationSession.summary
																	}
																</div>
															</div>
														</div>
														<ConfirmationRequest>
															<ConfirmationActions>
																<ConfirmationAction
																	onClick={
																		handleStartImplementationSession
																	}
																	disabled={
																		isLoading ||
																		isStartingImplementationSession
																	}
																	className="bg-green-600 text-white hover:bg-green-700"
																>
																	<CheckCircle2 className="mr-2 h-4 w-4" />
																	Start
																	session
																</ConfirmationAction>
																<ConfirmationAction
																	onClick={() =>
																		setPendingImplementationSession(
																			null,
																		)
																	}
																	disabled={
																		isLoading ||
																		isStartingImplementationSession
																	}
																	variant="outline"
																	className="border-red-300 text-destructive hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
																>
																	<XCircle className="mr-2 h-4 w-4" />
																	Cancel
																</ConfirmationAction>
															</ConfirmationActions>
														</ConfirmationRequest>
													</Confirmation>
												)}

												{pendingSkillDraft?.messageId ===
													message.id && (
													<Confirmation
														approvalState="requested"
														className="mt-3"
													>
														<ConfirmationTitle>
															<ConfirmationIcon />
															Save reusable Skill
														</ConfirmationTitle>
														<ConfirmationDescription>
															Review the Skill
															metadata before
															saving. Fabric will
															not add automation
															triggers unless you
															choose to after
															saving.
														</ConfirmationDescription>
														<div className="mt-3 space-y-3 rounded-lg border border-border/70 bg-background/70 p-3 text-xs">
															<div className="grid gap-2 sm:grid-cols-2">
																<div>
																	<p className="font-medium text-foreground">
																		Name
																	</p>
																	<p className="text-muted-foreground">
																		{
																			pendingSkillDraft.name
																		}
																	</p>
																</div>
																<div>
																	<p className="font-medium text-foreground">
																		Scope
																	</p>
																	<p className="text-muted-foreground">
																		{pendingSkillDraft.scope ===
																		"ORGANIZATION"
																			? "Organization"
																			: "Personal"}
																	</p>
																</div>
															</div>
															<div>
																<p className="font-medium text-foreground">
																	Description
																</p>
																<p className="text-muted-foreground">
																	{
																		pendingSkillDraft.description
																	}
																</p>
															</div>
															<div>
																<p className="font-medium text-foreground">
																	Tags
																</p>
																<div className="mt-1 flex flex-wrap gap-1">
																	{pendingSkillDraft.tags.map(
																		(
																			tag,
																		) => (
																			<Badge
																				key={
																					tag
																				}
																				variant="secondary"
																				className="text-[10px]"
																			>
																				{
																					tag
																				}
																			</Badge>
																		),
																	)}
																</div>
															</div>
														</div>
														<ConfirmationRequest>
															<ConfirmationActions>
																<ConfirmationAction
																	onClick={
																		handleSaveApprovedSkill
																	}
																	disabled={
																		isLoading ||
																		isSavingSkillDraft
																	}
																	className="bg-green-600 text-white hover:bg-green-700"
																>
																	<CheckCircle2 className="mr-2 h-4 w-4" />
																	Save Skill
																</ConfirmationAction>
																<ConfirmationAction
																	onClick={() =>
																		setPendingSkillDraft(
																			null,
																		)
																	}
																	disabled={
																		isLoading ||
																		isSavingSkillDraft
																	}
																	variant="outline"
																	className="border-red-300 text-destructive hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
																>
																	<XCircle className="mr-2 h-4 w-4" />
																	Cancel
																</ConfirmationAction>
															</ConfirmationActions>
														</ConfirmationRequest>
													</Confirmation>
												)}

												{savedSkillAutomationPrompt && (
													<Confirmation
														approvalState="requested"
														className="mt-3"
													>
														<ConfirmationTitle>
															<ConfirmationIcon />
															Add triage
															automation trigger
														</ConfirmationTitle>
														<ConfirmationDescription>
															Fabric can tag this
															Skill so the
															existing column
															automation runs it
															when a feature
															enters a matching
															column.
														</ConfirmationDescription>
														<div className="mt-3 rounded-lg border border-border/70 bg-background/70 p-3 text-xs">
															<p className="font-medium text-foreground">
																{
																	savedSkillAutomationPrompt.skillName
																}
															</p>
															<label className="mt-3 block text-[11px] font-medium text-muted-foreground">
																Column/tag to
																trigger on
																<input
																	value={
																		savedSkillAutomationPrompt.columnTag
																	}
																	onChange={(
																		event,
																	) =>
																		setSavedSkillAutomationPrompt(
																			(
																				prev,
																			) =>
																				prev
																					? {
																							...prev,
																							columnTag:
																								event
																									.target
																									.value,
																						}
																					: prev,
																		)
																	}
																	className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
																	placeholder="triage"
																/>
															</label>
														</div>
														<ConfirmationRequest>
															<ConfirmationActions>
																<ConfirmationAction
																	onClick={
																		handleSaveAutomationTag
																	}
																	disabled={
																		isLoading ||
																		isSavingAutomationTag
																	}
																	className="bg-green-600 text-white hover:bg-green-700"
																>
																	<CheckCircle2 className="mr-2 h-4 w-4" />
																	Save trigger
																</ConfirmationAction>
																<ConfirmationAction
																	onClick={() =>
																		setSavedSkillAutomationPrompt(
																			null,
																		)
																	}
																	disabled={
																		isLoading ||
																		isSavingAutomationTag
																	}
																	variant="outline"
																>
																	Skip
																</ConfirmationAction>
															</ConfirmationActions>
														</ConfirmationRequest>
													</Confirmation>
												)}

												{/* Workflow Execution Confirmation - using AI Elements Confirmation component */}
												{pendingConfirmation &&
													pendingConfirmation.messageId ===
														message.id && (
														<Confirmation
															approvalState="requested"
															className="mt-3"
														>
															<ConfirmationTitle>
																<ConfirmationIcon />
																Execute
																Workflow:{" "}
																{
																	pendingConfirmation.workflowName
																}
															</ConfirmationTitle>
															{pendingConfirmation.workflowDescription && (
																<ConfirmationDescription>
																	{
																		pendingConfirmation.workflowDescription
																	}
																</ConfirmationDescription>
															)}
															<ConfirmationRequest>
																<ConfirmationActions>
																	<ConfirmationAction
																		onClick={
																			handleConfirmExecution
																		}
																		disabled={
																			isLoading ||
																			isExecutingWorkflow
																		}
																		className="bg-green-600 hover:bg-green-700 text-white"
																	>
																		<CheckCircle2 className="h-4 w-4 mr-2" />
																		Execute
																	</ConfirmationAction>
																	<ConfirmationAction
																		onClick={
																			handleDeclineExecution
																		}
																		disabled={
																			isLoading ||
																			isExecutingWorkflow
																		}
																		variant="outline"
																		className="border-red-300 text-destructive hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
																	>
																		<XCircle className="h-4 w-4 mr-2" />
																		Cancel
																	</ConfirmationAction>
																</ConfirmationActions>
															</ConfirmationRequest>
														</Confirmation>
													)}
											</MessageContent>
										</Message>
										{captionNames.length > 0 && (
											<div className="-mt-1 mb-2 flex flex-wrap justify-end gap-x-3 gap-y-0.5 px-1 text-[11px] text-muted-foreground/70">
												{captionNames.map((name) => (
													<span
														key={name}
														className="inline-flex items-center gap-1"
													>
														<Paperclip
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
									</Fragment>
								);
							})}

							{/* Loading indicator - "AI is thinking..." message */}
							{/* Only show if loading AND no streaming assistant message exists */}
							{isLoading &&
								!messages.some(
									(m) =>
										m.role === "assistant" && m.isStreaming,
								) && (
									<Message from="assistant" className="py-2">
										<div className="shrink-0 mt-1">
											<FabricLogo
												className="h-8 w-8"
												size={32}
											/>
										</div>
										<MessageContent variant="flat">
											<div className="flex items-center gap-2">
												<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
												<span className="text-sm text-muted-foreground">
													AI is thinking...
												</span>
											</div>
										</MessageContent>
									</Message>
								)}
						</ConversationContent>
						<ConversationScrollButton />

						{/* Checkpoint controls - floating on right side */}
						<CheckpointProvider
							checkpoints={checkpoints}
							currentMessageIndex={messages.length - 1}
							onCreateCheckpoint={handleCreateCheckpoint}
							onRestoreCheckpoint={handleRestoreCheckpoint}
							onDeleteCheckpoint={handleDeleteCheckpoint}
						>
							<div className="absolute bottom-4 right-4 flex items-center gap-1 z-10">
								{!isLoading && messages.length >= 2 && (
									<>
										{applyToDocument && (
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="sm"
														onClick={
															handleApplyToDocument
														}
														className="h-8 w-8 p-0"
													>
														<FilePenLineIcon className="h-4 w-4" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													Apply last response to
													document
												</TooltipContent>
											</Tooltip>
										)}
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="sm"
													onClick={
														handleExportConversation
													}
													className="h-8 w-8 p-0"
												>
													<DownloadIcon className="h-4 w-4" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												Export conversation as Markdown
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="sm"
													onClick={handleSaveAsSkill}
													className="h-8 w-8 p-0"
												>
													<BookmarkIcon className="h-4 w-4" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												Save conversation as reusable
												Skill
											</TooltipContent>
										</Tooltip>
									</>
								)}
								{!isLoading && <CheckpointCreateButton />}
								{checkpoints.length > 0 && (
									<CheckpointHistory />
								)}
							</div>
						</CheckpointProvider>
					</Conversation>
				)}

				{/* Input Area - Enhanced styling */}
				<div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-4">
					<div className="max-w-4xl mx-auto space-y-3">
						{/*
						 * Attached Files Preview — the shared chip row, not a
						 * local copy of it.
						 *
						 * The block that stood here rendered filename, status,
						 * and removal and nothing else, so everything the
						 * server reports about what it actually read — a
						 * truncated file, a workbook with no readable text, the
						 * sheet list with hidden tabs marked — had no way to
						 * reach the user on this surface. The shared component
						 * already renders all of it from the record's
						 * `extraction` field.
						 */}
						<CopilotSidebarAttachments
							files={attachedFiles}
							onRemove={removeAttachment}
						/>

						{/* Tool Suggestions */}
						{toolSuggestions.length > 0 && !isLoading && (
							<div className="flex flex-wrap gap-2 items-center">
								<span className="text-xs text-muted-foreground flex items-center gap-1">
									<Wrench className="h-3 w-3" />
									Suggested tools:
								</span>
								<TooltipProvider>
									{toolSuggestions.map((suggestion, idx) => (
										<Tooltip
											key={`${suggestion.toolName}-${idx}`}
										>
											<TooltipTrigger asChild>
												<Badge
													variant="secondary"
													className="text-xs cursor-help rounded-full"
												>
													{suggestion.toolName}
												</Badge>
											</TooltipTrigger>
											<TooltipContent
												side="top"
												className="max-w-xs"
											>
												<div className="space-y-1">
													<p className="font-medium">
														{suggestion.configName}
													</p>
													{suggestion.description && (
														<p className="text-xs text-muted-foreground">
															{
																suggestion.description
															}
														</p>
													)}
													<p className="text-xs italic">
														{suggestion.reason}
													</p>
												</div>
											</TooltipContent>
										</Tooltip>
									))}
								</TooltipProvider>
								{suggestionsLoading && (
									<Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
								)}
							</div>
						)}

						{/*
						 * Off-screen (`sr-only`), not display:none.
						 * Chromium 124+ blocks the OS file picker on
						 * programmatic clicks targeting `display:none`
						 * file inputs.
						 */}
						<input
							ref={fileInputRef}
							type="file"
							multiple
							accept={LOOM_FILE_ACCEPT}
							onChange={handleFileSelect}
							className="sr-only"
							aria-hidden="true"
							tabIndex={-1}
						/>

						{/* Skill slash-command suggestions */}
						{skillSlash.isOpen && (
							<SkillAutocomplete
								results={skillSlash.results}
								isLoading={skillSlash.isLoading}
								selectedIndex={skillSlash.selectedIndex}
								onSelect={handleSelectSkill}
								onHover={(index) =>
									skillSlash.setSelectedIndex(index)
								}
								query={skillSlash.query}
							/>
						)}

						{/* Main Input - Using shared ChatInput component */}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: event delegation for slash-command keyboard nav */}
						<div onKeyDown={handleInputAreaKeyDown}>
							<ChatInput
								ref={inputRef}
								value={input}
								onChange={handleInputChange}
								onSend={sendMessage}
								onStop={handleStopFromButton}
								isLoading={isLoading}
								projectId={attachedProjectId ?? undefined}
								enableFileMentions={!!attachedProjectId}
								enableStoryMentions={!!attachedProjectId}
								enableUserMentions={!!organizationId}
								organizationId={organizationId}
								enableTemplateMentions={true}
								placeholder={
									attachedFiles.length > 0
										? "Ask about your documents..."
										: repositoryUrl
											? "Ask Fabric anything... Type / for skills or mention file.ts:42"
											: "Ask Fabric anything... Type / for skills"
								}
								onAttachClick={() =>
									fileInputRef.current?.click()
								}
								attachTooltip="Attach documents or images"
								enableImagePaste={true}
								imageUploader={pastedImageUploader}
								onPasteNonImageFiles={onPasteNonImageFiles}
								topSlot={
									(skillSuggestions.length > 0 ||
										skillSuggestionsLoading) && (
										<SkillSuggestionChips
											suggestions={skillSuggestions}
											organizationId={organizationId}
											onSuggestionClick={(
												skillContent,
											) => {
												setInput(skillContent);
												inputRef.current?.focus();
											}}
										/>
									)
								}
								headerSlot={
									hasMounted && (
										<div className="flex flex-col gap-2">
											<div className="flex flex-wrap items-center gap-2">
												{showAgentPicker ? (
													<AgentModelPicker
														selectedAgents={
															selectedAgent
																? [
																		selectedAgent,
																	]
																: []
														}
														onToggleAgent={
															handleToggleAgent
														}
														organizationId={
															organizationId
														}
													/>
												) : null}
												{/* The picker's own trigger is a
												    static label, so without this
												    the only way to see what is
												    picked is to reopen the
												    popover. */}
												{showAgentPicker &&
												selectedAgent ? (
													<Badge
														variant="secondary"
														className="gap-1 rounded-full"
													>
														<RobotIcon className="h-3 w-3" />
														{selectedAgent.name}
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
												<ActiveContextIndicator
													workspaceIds={
														attachedWorkspaceIds
													}
													projectId={
														attachedProjectId
													}
													mcpConfigIds={
														selectedConversationMcpIds ??
														enabledMcpConfigIds ??
														undefined
													}
													organizationId={
														organizationId
													}
												/>
												{attachedCodeContext?.filePath ? (
													<Badge
														variant="secondary"
														className="gap-1 rounded-full"
													>
														<FileIcon className="h-3 w-3" />
														{
															attachedCodeContext.filePath
														}
														{formatLineRangeLabel(
															attachedCodeContext.lineStart,
															attachedCodeContext.lineEnd,
														)}
													</Badge>
												) : null}
												{resolvedCodeReferences.map(
													(ref) => (
														<Badge
															key={ref.fullMatch}
															variant="outline"
															className="rounded-full"
														>
															{formatCodeReference(
																ref,
															)}
														</Badge>
													),
												)}
												{showToolPicker ? (
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
												) : null}
											</div>
											{attachedCodeContext?.filePath ||
											resolvedCodeReferencePreviews.length >
												0 ? (
												<div className="space-y-2 rounded-xl border border-border/70 bg-muted/25 p-3">
													<div className="flex items-center justify-between gap-3">
														<div>
															<p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
																Code context
																preview
															</p>
															<p className="text-xs text-muted-foreground">
																Fabric Agent
																will use this
																code context in
																the next reply.
															</p>
														</div>
														<Badge
															variant="secondary"
															className="rounded-full"
														>
															{resolvedCodeReferencePreviews.length >
															0
																? `${resolvedCodeReferencePreviews.length} resolved ref${resolvedCodeReferencePreviews.length > 1 ? "s" : ""}`
																: "Attached code"}
														</Badge>
													</div>
													{attachedCodeContext?.filePath ? (
														<Collapsible
															defaultOpen
														>
															<CollapsibleTrigger
																asChild
															>
																<Button
																	variant="ghost"
																	size="sm"
																	className="flex h-auto w-full items-start justify-between px-0 py-1 text-left hover:bg-transparent"
																>
																	<div className="space-y-1">
																		<div className="flex items-center gap-2 text-sm font-medium">
																			<FileCode2 className="size-4 text-primary" />
																			<span>
																				Attached
																				code
																			</span>
																		</div>
																		<p className="text-xs text-muted-foreground">
																			{
																				attachedCodeContext.filePath
																			}
																			{formatLineRangeLabel(
																				attachedCodeContext.lineStart,
																				attachedCodeContext.lineEnd,
																			)}
																		</p>
																	</div>
																	<ChevronDown className="size-4 text-muted-foreground" />
																</Button>
															</CollapsibleTrigger>
															<CollapsibleContent className="space-y-2 pt-1">
																<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
																	{attachedCodeContext.branch ? (
																		<Badge
																			variant="outline"
																			className="gap-1 rounded-full"
																		>
																			<GitBranch className="size-3" />
																			{
																				attachedCodeContext.branch
																			}
																		</Badge>
																	) : null}
																	{attachedCodeContext.repoName ? (
																		<Badge
																			variant="outline"
																			className="rounded-full"
																		>
																			{
																				attachedCodeContext.repoName
																			}
																		</Badge>
																	) : null}
																</div>
																{attachedCodeContext.snippet ? (
																	<pre className="overflow-x-auto rounded-lg border border-border/70 bg-background px-3 py-2 text-xs text-foreground">
																		<code>
																			{
																				attachedCodeContext.snippet
																			}
																		</code>
																	</pre>
																) : (
																	<p className="text-xs text-muted-foreground">
																		This
																		attached
																		file
																		range
																		will be
																		included
																		with
																		your
																		next
																		message.
																	</p>
																)}
															</CollapsibleContent>
														</Collapsible>
													) : null}
													{resolvedCodeReferencePreviews.map(
														(preview) => (
															<Collapsible
																key={
																	preview.ref
																		.fullMatch
																}
															>
																<CollapsibleTrigger
																	asChild
																>
																	<Button
																		variant="ghost"
																		size="sm"
																		className="flex h-auto w-full items-start justify-between px-0 py-1 text-left hover:bg-transparent"
																	>
																		<div className="space-y-1">
																			<div className="flex items-center gap-2 text-sm font-medium">
																				<FileCode2 className="size-4 text-primary" />
																				<span>
																					{formatCodeReference(
																						preview.ref,
																					)}
																				</span>
																			</div>
																			<p className="text-xs text-muted-foreground">
																				Resolved
																				from
																				the
																				connected
																				repository
																				{preview.branch
																					? ` on ${preview.branch}`
																					: ""}
																				{preview
																					.relatedFiles
																					.length >
																				0
																					? ` with ${preview.relatedFiles.length} related file${preview.relatedFiles.length > 1 ? "s" : ""}`
																					: ""}
																				.
																			</p>
																		</div>
																		<ChevronDown className="size-4 text-muted-foreground" />
																	</Button>
																</CollapsibleTrigger>
																<CollapsibleContent className="space-y-2 pt-1">
																	<div className="flex flex-wrap gap-2">
																		{preview.branch ? (
																			<Badge
																				variant="outline"
																				className="gap-1 rounded-full"
																			>
																				<GitBranch className="size-3" />
																				{
																					preview.branch
																				}
																			</Badge>
																		) : null}
																		<Badge
																			variant="secondary"
																			className="rounded-full"
																		>
																			{preview
																				.relatedFiles
																				.length >
																			0
																				? `${preview.relatedFiles.length} related file${preview.relatedFiles.length > 1 ? "s" : ""}`
																				: "Primary file only"}
																		</Badge>
																	</div>
																	{preview
																		.relatedFiles
																		.length >
																	0 ? (
																		<div className="space-y-1">
																			<p className="text-xs font-medium text-muted-foreground">
																				Included
																				related
																				files
																			</p>
																			<div className="flex flex-wrap gap-2">
																				{preview.relatedFiles.map(
																					(
																						filePath,
																					) => (
																						<Badge
																							key={
																								filePath
																							}
																							variant="outline"
																							className="gap-1 rounded-full"
																						>
																							<FileIcon className="size-3" />
																							{
																								filePath
																							}
																						</Badge>
																					),
																				)}
																			</div>
																		</div>
																	) : (
																		<p className="text-xs text-muted-foreground">
																			No
																			high-confidence
																			related
																			local
																			files
																			were
																			added
																			for
																			this
																			reference.
																		</p>
																	)}
																</CollapsibleContent>
															</Collapsible>
														),
													)}
												</div>
											) : null}
										</div>
									)
								}
							/>
						</div>
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
				onOpenChange={setConversationToolPickerOpen}
				organizationId={organizationId}
				// With no per-conversation override the chat runs on the
				// sidebar selection, so that is what the dialog must show —
				// otherwise enabled servers render unchecked.
				selectedIds={
					selectedConversationMcpIds ?? enabledMcpConfigIds ?? null
				}
				onChange={setSelectedConversationMcpIds}
			/>
		</div>
	);
});

FabricDirectChat.displayName = "FabricDirectChat";
