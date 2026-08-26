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
	/** System prompt / instructions (for agent template instances) */
	systemPrompt?: string;
	/** Agent template instance ID */
	instanceId?: string;
	/** Custom starter messages for chat welcome (from agent config) */
	starterMessages?: Array<{ label: string; emoji: string; prompt: string }>;
	/** Optional initial draft text for contextual launches */
	initialInput?: string;
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
}

// Completed execution for collapsible display
export interface CompletedExecution {
	id: string;
	userMessage: string;
	imageUrls?: string[];
	stepResults: StepResult[];
	response?: string;
	completedAt: Date;
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
