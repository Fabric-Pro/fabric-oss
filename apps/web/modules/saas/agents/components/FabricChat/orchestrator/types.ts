/**
 * Orchestrator Chat Types
 *
 * Type definitions for the Temporal Orchestrator Chat component.
 */

import type {
	ExecutionMode,
	MissingIntegration,
	RequiredConnection,
	StepResult,
	TaskPlan,
	TaskStep,
} from "@repo/temporal";
import type { ChatTurnTruncation } from "../../../lib/chat-turn-truncation";
import type { ClarificationTurn } from "../../../lib/clarification-turns";

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
			status?: string;
		}>;
	}>;
	metadata?: Record<string, unknown> | null;
}

// Activity state for sidebar display
export interface TemporalOrchestratorActivityState {
	isActive: boolean;
	currentPhase: string;
	routingDecision?: {
		primaryAgent: string;
		agentName: string;
		confidence: number;
		riskLevel?: string;
		/** MCP servers that need to be connected before proceeding */
		requiredConnections?: RequiredConnection[];
		/** Workflow integrations that need to be configured */
		missingIntegrations?: MissingIntegration[];
		/** Whether the task is blocked waiting for connections */
		blockedOnConnections?: boolean;
	};
	plan?: TaskPlan;
	completedSteps: number;
	totalSteps: number;
	currentStep?: TaskStep | null;
	pendingApproval?: {
		stepId: string;
		reason: string;
	};
}

/** Token usage info exported for parent components */
interface TemporalOrchestratorTokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
	maxTokens: number;
}

export interface FabricTemporalOrchestratorChatProps {
	organizationId?: string;
	reasoningMode: "lite" | "balanced" | "deep" | "planner";
	/**
	 * Runs every turn on this execution mode instead of the one
	 * `reasoningMode` maps to. Simple mode passes `iterative` (#2040): the
	 * iterative loop with no decomposition or reflection. The conversation
	 * still records `reasoningMode`.
	 */
	executionModeOverride?: ExecutionMode;
	welcomeMode?: "default" | "focused-agent";
	lockConversationToolPicker?: boolean;
	activeConversation?: ConversationDetail | null;
	activeConversationId?: string | null;
	onConversationSaved?: () => void;
	onConversationCreated?: (conversationId: string) => void;
	enabledToolIds?: string[] | null;
	enabledAgentIds?: string[] | null;
	enabledFabricToolIds?: string[] | null;
	/** Enabled workflow integration IDs */
	enabledIntegrationIds?: string[] | null;
	/** Prioritized tool IDs - get boosted confidence in routing */
	prioritizedToolIds?: string[];
	/** Prioritized agent IDs - get boosted confidence in routing */
	prioritizedAgentIds?: string[];
	/** Prioritized MCP server config IDs - tools from these get boosted */
	prioritizedMcpConfigIds?: string[];
	/** Prioritized integration IDs - get boosted confidence in routing */
	prioritizedIntegrationIds?: string[];
	/** Callback when tool priority changes */
	onToolPrioritize?: (toolId: string, prioritized: boolean) => void;
	/** Callback when agent priority changes */
	onAgentPrioritize?: (agentId: string, prioritized: boolean) => void;
	/** Callback when MCP server priority changes */
	onMcpPrioritize?: (configId: string, prioritized: boolean) => void;
	/** Callback when integration priority changes */
	onIntegrationPrioritize?: (
		integrationId: string,
		prioritized: boolean,
	) => void;
	/**
	 * Shows the model picker above the composer (#2040).
	 *
	 * Defaults to `false`, unlike `FabricDirectChat`'s `showAgentPicker`,
	 * because two of this component's three mount points — the registered-agent
	 * try workspace and the MCP chat dialog — exist to exercise one fixed
	 * agent. Offering to swap the model there would contradict the surface.
	 * The unified interface opts in for its Orchestrator tab.
	 */
	showAgentPicker?: boolean;
	/**
	 * What the picker lists — see `InterfaceModeChrome.agentPickerCatalog`.
	 * Defaults to models only. A picked agent or template applies only its
	 * model override here: its instructions would replace the orchestrator's
	 * own, so the chip says "not applied" when it carries no model.
	 */
	agentPickerCatalog?: "all" | "models";
	onActivityChange?: (activity: TemporalOrchestratorActivityState) => void;
	onUsageChange?: (usage: TemporalOrchestratorTokenUsage) => void;
	// Optional customization for different agent types
	agentId?: string;
	agentName?: string;
	agentDescription?: string;
	/** Attached workspace IDs for RAG context retrieval */
	attachedWorkspaceIds?: string[];
	/** Restrict workspace retrieval to these document IDs when provided */
	attachedDocumentIds?: string[];
	/** Attached project ID for project context retrieval */
	attachedProjectId?: string | null;
	/**
	 * Fires after the user removes the project from the chat (and, with a
	 * conversation open, after it was detached), so the parent drops its
	 * own copy — otherwise the `attachedProjectId` it passes would bring the
	 * project back.
	 */
	onProjectRemove?: () => void;
	/** System prompt / instructions (for agent template instances) */
	systemPrompt?: string;
	/** Agent template instance ID */
	instanceId?: string;
	/** Custom starter messages for chat welcome (from agent config) */
	starterMessages?: Array<{ label: string; emoji: string; prompt: string }>;
	/** Optional initial draft text for contextual launches */
	initialInput?: string;
	/**
	 * Files already in the composer when the chat mounts — the drawer's
	 * attachments carried over by Expand (#2040).
	 */
	initialAttachedDocuments?: import("@saas/shared/components/copilot/use-copilot-document-upload").AttachedFile[];
	/** Reports the unsent composer text, so Expand can carry it (#2040). */
	onDraftChange?: (draft: string) => void;
	/** Reports the composer's attached documents, so Expand can carry them. */
	onAttachmentsChange?: (
		attachments: import("@saas/shared/components/copilot/use-copilot-document-upload").AttachedFile[],
	) => void;
	/** Session-level selected templates that persist across conversations */
	sessionTemplates?: import("../../../hooks/useTemplateMention").MentionableTemplate[];
	/** Callback when selected templates change (for session persistence) */
	onSessionTemplatesChange?: (
		templates: import("../../../hooks/useTemplateMention").MentionableTemplate[],
	) => void;
	/**
	 * Optional handler for the Esc key while the chat is idle. The
	 * component mounts a shared `useEscToStopOrClose` binding so Esc
	 * stops the turn while streaming or paused on `pendingApproval`
	 * (AC-9). When idle, this handler (if provided) is invoked. The
	 * standalone Loom Orchestrator page leaves it unset so idle Esc is
	 * a no-op (AC-7 / spec § 8.8 / decision 9).
	 */
	onEscClose?: () => void;
	/**
	 * Fires when a turn starts and once it has landed — streamed AND saved.
	 * This component persists a turn client-side after the stream ends, so
	 * the drawer must not treat the stream's end as "safe to navigate"
	 * (#2040).
	 */
	onStreamingChange?: (isStreaming: boolean) => void;
	/**
	 * Narrow layout for the ⌘J drawer: a compact empty state, no memory or
	 * artifacts triggers, and interactive frames open only on request.
	 */
	compactMode?: boolean;
	/**
	 * Whether to offer the "Chat tools" (MCP) picker in the composer.
	 * Simple mode hides it (#2040). Defaults to `true`.
	 */
	showToolPicker?: boolean;
	/**
	 * Analytics tag for the cancel telemetry event. The workflow surface
	 * stays `loom-orchestrator` either way, so the clarifying-question card
	 * works on every mount.
	 */
	telemetrySurface?: "loom-orchestrator" | "fabric-agent-launcher";
	/**
	 * The most recent conversation, shown on the landing with a Resume
	 * link. The page passes it only while no conversation is open.
	 */
	recentConversation?: {
		id: string;
		title: string | null;
		updatedAt: string;
	} | null;
	/** Opens `recentConversation`. */
	onResumeConversation?: (id: string) => void;
	/** The AiChat uploaded documents are stored under (restored from history). */
	documentChatId?: string | null;
	/** Fires when the first upload creates that AiChat (page Files tab). */
	onDocumentChatCreated?: (chatId: string) => void;
}

// Completed execution for collapsible display
export interface CompletedExecution {
	id: string;
	userMessage: string;
	/**
	 * Id of the live stream message that asked this turn, when the turn ran in
	 * this session. The live list hides a user bubble by this id — never by its
	 * text, which would swallow a repeated question (review F31).
	 */
	userMessageId?: string;
	imageUrls?: string[];
	stepResults: StepResult[];
	response?: string;
	completedAt: Date;
	/**
	 * Clarifying questions answered during this execution, oldest first. Kept
	 * on the execution because the execution record — not the message array —
	 * is what rehydrates a conversation after a reload, and these have to reach
	 * the next turn's `history` or the clarity gate re-asks them (Fizzy #2406).
	 */
	clarifications?: ClarificationTurn[];
	/** The answer stopped at the output-token ceiling (review F25). */
	truncated?: ChatTurnTruncation;
	plan?: {
		id: string;
		description: string;
		riskLevel: string;
		steps: Array<{
			id: string;
			description: string;
			status: string;
			order: number;
			executor?: string;
			riskLevel?: string;
			requiresApproval?: boolean;
		}>;
	};
	/** Artifacts generated during execution */
	artifacts?: Array<{
		id: string;
		type:
			| "document"
			| "code"
			| "data"
			| "tool_result"
			| "file"
			| "error"
			| "chart";
		name?: string;
		content?: string;
		stepId?: string;
		createdAt?: string;
		metadata?: Record<string, unknown>;
	}>;
	/** Sources used during planning (for ArtifactsPanel persistence) */
	sourcesUsed?: string[];
}

// Agent registry for UI display
export const AGENT_DISPLAY_INFO: Record<
	string,
	{ name: string; icon: string }
> = {
	task_planner: { name: "Task Planner", icon: "📋" },
	document_generator: { name: "Document Generator", icon: "📝" },
	code_executor: { name: "Code Executor", icon: "💻" },
	prompt_enhancer: { name: "Prompt Enhancer", icon: "✨" },
	story_breakdown: { name: "Story Breakdown", icon: "📖" },
	mcp_tool_executor: { name: "MCP Tool Executor", icon: "🔧" },
	api_agent: { name: "API Agent", icon: "🔌" },
	cuga_generalist: { name: "CUGA Generalist", icon: "🤖" },
	workflow_executor: { name: "Workflow Executor", icon: "⚡" },
	reflection_agent: { name: "Reflection Agent", icon: "🔍" },
};

// Map reasoning mode to execution mode
export const REASONING_TO_EXECUTION: Record<string, ExecutionMode> = {
	lite: "fast",
	balanced: "balanced",
	deep: "accurate",
	planner: "save_reuse",
};
