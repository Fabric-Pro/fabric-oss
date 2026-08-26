/**
 * A2A Protocol Types
 * Implementation of Google's Agent2Agent protocol for inter-agent communication
 * @see https://a2a-protocol.org/latest/specification/
 */

/**
 * Agent Card - Discovery metadata served at /.well-known/agent.json
 */
export interface AgentCard {
	name: string;
	description: string;
	url: string;
	protocolVersion: string; // "0.3.0"
	capabilities: AgentCapabilities;
	skills: AgentSkill[];
	securitySchemes?: Record<string, SecurityScheme>;
	defaultInputModes?: InputMode[];
	defaultOutputModes?: OutputMode[];
	/** Tags for categorization and capability matching */
	tags?: string[];
}

export interface AgentCapabilities {
	streaming?: boolean;
	pushNotifications?: boolean;
	stateTransitionHistory?: boolean;

	// =============================================================================
	// Generalist Agent Capabilities (for autonomous multi-step execution)
	// =============================================================================

	/**
	 * Whether this agent can handle complete tasks autonomously without step-by-step orchestration.
	 * When true, the orchestrator should delegate entire tasks rather than breaking them into steps.
	 */
	autonomousExecution?: boolean;

	/**
	 * Whether this agent has internal task decomposition and planning capabilities.
	 * Agents with this capability can break down complex tasks into subtasks.
	 */
	taskDecomposition?: boolean;

	/**
	 * Whether this agent preserves context across subtasks/steps.
	 * Agents with this capability maintain variables, state, and memory across execution.
	 */
	contextPreservation?: boolean;

	/**
	 * Whether this agent can execute code (Python, JavaScript, etc.)
	 * with sandbox support (Docker, E2B, local).
	 */
	codeExecution?: boolean;

	/**
	 * Whether this agent can automate browser interactions using Playwright or similar.
	 * Includes navigation, clicking, form filling, screenshots, etc.
	 */
	browserAutomation?: boolean;

	/**
	 * Whether this agent can orchestrate API calls and integrate with external services.
	 */
	apiOrchestration?: boolean;

	/**
	 * Whether this agent can perform file operations (read, write, create, delete).
	 */
	fileOperations?: boolean;

	/**
	 * Whether this agent has persistent memory for learning from past executions.
	 * Agents with memory can retrieve tips, avoid past mistakes, and improve over time.
	 */
	memoryEnabled?: boolean;

	/**
	 * Whether this agent can learn from past executions and improve over time.
	 */
	learningEnabled?: boolean;

	/**
	 * Whether this agent is aware of Fabric's multi-tenancy (userId + organizationId).
	 * Agents without this should be treated as stateless with no workspace/memory access.
	 */
	multiTenancyAware?: boolean;

	/**
	 * Whether this agent runs in a sandboxed environment for security.
	 */
	sandboxed?: boolean;

	/**
	 * Maximum autonomy level this agent supports.
	 * - 'step': Only handles single steps (default for simple agents)
	 * - 'subtask': Can handle subtasks with multiple steps
	 * - 'task': Can handle complete tasks autonomously
	 * - 'session': Can maintain context across multiple tasks in a session
	 */
	maxAutonomyLevel?: "step" | "subtask" | "task" | "session";
}

/**
 * Agent Skill - Defines a specific capability an agent can perform
 * Based on the Agent Skills open standard (https://agentskills.io/)
 *
 * Skills provide task-specific instructions and metadata for agents,
 * complementing the broader AgentCapabilities for capability detection.
 */
export interface AgentSkill {
	/** Unique identifier for the skill */
	id: string;
	/** Human-readable name */
	name: string;
	/** Detailed description of what this skill does */
	description: string;
	/** JSON Schema for skill parameters/inputs */
	parameters?: JSONSchema;
	/** Example prompts or use cases */
	examples?: string[];
	/** Tags for categorization and matching */
	tags?: string[];

	// =============================================================================
	// Agent Skills Standard Extensions (https://agentskills.io/specification)
	// =============================================================================

	/**
	 * Compatibility information for this skill.
	 * Specifies which agent frameworks, models, or platforms this skill works with.
	 */
	compatibility?: {
		/** Agent frameworks this skill is compatible with */
		frameworks?: string[];
		/** AI models this skill works best with */
		models?: string[];
		/** Minimum version requirements */
		minVersion?: string;
	};

	/**
	 * Additional metadata for the skill.
	 * Can include custom fields for specific use cases.
	 */
	metadata?: {
		/** Author or maintainer of the skill */
		author?: string;
		/** Version of the skill definition */
		version?: string;
		/** License for the skill */
		license?: string;
		/** URL to skill documentation */
		documentationUrl?: string;
		/** Risk level when using this skill */
		riskLevel?: "low" | "medium" | "high" | "critical";
		/** Whether this skill requires human approval */
		requiresApproval?: boolean;
		/** Estimated execution time in seconds */
		estimatedDurationSeconds?: number;
		/** Custom fields */
		[key: string]: unknown;
	};

	/**
	 * Output schema for the skill result.
	 * Helps orchestrators understand what to expect from skill execution.
	 */
	outputSchema?: JSONSchema;

	/**
	 * Dependencies on other skills or capabilities.
	 * Used for skill composition and validation.
	 */
	dependencies?: {
		/** Required skills that must be available */
		requiredSkills?: string[];
		/** Required capabilities the agent must have */
		requiredCapabilities?: (keyof AgentCapabilities)[];
		/** Required MCP tools or services */
		requiredMcpTools?: string[];
	};
}

export type InputMode = "text" | "file" | "data";
export type OutputMode = "text" | "file" | "data";

export interface SecurityScheme {
	type: "apiKey" | "oauth2" | "http" | "openIdConnect" | "mutualTLS";
	in?: "header" | "query";
	name?: string;
	scheme?: string;
	flows?: OAuthFlows;
	openIdConnectUrl?: string;
	metadataUrl?: string;
}

export interface OAuthFlows {
	clientCredentials?: {
		tokenUrl: string;
		scopes?: Record<string, string>;
	};
}

// JSON Schema type (simplified)
export interface JSONSchema {
	type?: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	description?: string;
	items?: JSONSchema;
	enum?: unknown[];
}

/**
 * Task - Core unit of work in A2A
 */
export interface A2ATask {
	id: string;
	contextId?: string;
	status: TaskStatus;
	messages: A2AMessage[];
	artifacts?: Artifact[];
	metadata?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}

export type TaskStatus =
	| "submitted"
	| "working"
	| "input-required"
	| "completed"
	| "failed"
	| "canceled";

/**
 * Message - Turn-based communication
 */
export interface A2AMessage {
	role: "user" | "agent";
	parts: MessagePart[];
	metadata?: Record<string, unknown>;
}

export type MessagePart = TextPart | FilePart | DataPart;

export interface TextPart {
	type: "text";
	text: string;
}

export interface FilePart {
	type: "file";
	file: {
		name: string;
		mimeType: string;
		bytes?: string; // Base64 encoded
		uri?: string;
	};
}

export interface DataPart {
	type: "data";
	data: Record<string, unknown>;
}

/**
 * Artifact - Output files/data from task execution
 */
export interface Artifact {
	id: string;
	name: string;
	description?: string;
	mimeType: string;
	parts: MessagePart[];
}

// =============================================================================
// Delegation Mode Types (for generalist agent orchestration)
// =============================================================================

/**
 * Delegation mode determines how the orchestrator delegates work to agents.
 * - 'complete-task': Delegate the entire task for autonomous execution
 * - 'single-step': Delegate only a single step (traditional approach)
 */
export type DelegationMode = "complete-task" | "single-step";

/**
 * Code execution artifact - represents code that was executed
 */
export interface CodeExecutionArtifact {
	id: string;
	code: string;
	language: "python" | "javascript" | "typescript" | "shell";
	status: "pending" | "running" | "complete" | "failed";
	output?: string;
	error?: string;
	executionTimeMs?: number;
	sandbox?: "local" | "docker" | "e2b";
	variables?: Record<string, unknown>;
}

/**
 * Browser state artifact - represents browser automation state
 */
export interface BrowserStateArtifact {
	screenshot?: string; // Base64 encoded
	url: string;
	title?: string;
	viewport?: { width: number; height: number };
	currentAction?: {
		type: "click" | "type" | "select" | "scroll" | "navigate";
		target?: string;
		value?: string;
		status: "pending" | "executing" | "complete" | "failed";
	};
}

/**
 * Subtask artifact - represents a subtask in task decomposition
 */
export interface SubtaskArtifact {
	id: string;
	description: string;
	status: "pending" | "running" | "complete" | "failed" | "skipped";
	app?: string;
	type?: "api" | "web" | "code" | "generate";
	output?: string;
	error?: string;
	executionTimeMs?: number;
	children?: SubtaskArtifact[];
}

/**
 * Extended A2A Task with delegation context
 */
export interface A2ATaskWithDelegation extends A2ATask {
	/**
	 * How this task should be delegated to the agent.
	 * - 'complete-task': Agent handles the entire task autonomously
	 * - 'single-step': Agent handles only this specific step
	 */
	delegationMode?: DelegationMode;

	/**
	 * Whether context should be preserved across subtasks.
	 * When true, the agent should maintain variables and state.
	 */
	preserveContext?: boolean;

	/**
	 * Variables inherited from the parent orchestrator or previous steps.
	 * The agent should use these as starting context.
	 */
	inheritedVariables?: Record<string, unknown>;

	/**
	 * Parent task ID if this is a delegated subtask.
	 */
	parentTaskId?: string;

	/**
	 * Expected artifact types from this task.
	 * Helps the agent know what outputs to produce.
	 */
	expectedArtifacts?: Array<
		"code" | "browser-state" | "subtasks" | "variables" | "file"
	>;

	/**
	 * Code executions produced during task execution.
	 */
	codeExecutions?: CodeExecutionArtifact[];

	/**
	 * Browser state during execution (for browser automation tasks).
	 */
	browserState?: BrowserStateArtifact;

	/**
	 * Subtasks created during task decomposition.
	 */
	subtasks?: SubtaskArtifact[];

	/**
	 * Final variables after task execution.
	 */
	finalVariables?: Record<string, unknown>;
}

/**
 * Task Events for streaming
 */
export type TaskEvent =
	| TaskStatusEvent
	| TaskMessageEvent
	| TaskArtifactEvent
	| TaskErrorEvent;

export interface TaskStatusEvent {
	type: "status";
	taskId: string;
	status: TaskStatus;
	timestamp: string;
}

export interface TaskMessageEvent {
	type: "message";
	taskId: string;
	message: A2AMessage;
	timestamp: string;
}

export interface TaskArtifactEvent {
	type: "artifact";
	taskId: string;
	artifact: Artifact;
	timestamp: string;
}

export interface TaskErrorEvent {
	type: "error";
	taskId: string;
	error: A2AError;
	timestamp: string;
}

/**
 * A2A Error
 */
export interface A2AError {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

/**
 * Request/Response types
 */
export interface SendMessageRequest {
	message: A2AMessage;
	contextId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Extended SendMessageRequest with delegation context for generalist agents
 */
export interface SendMessageRequestWithDelegation extends SendMessageRequest {
	/**
	 * How this task should be delegated to the agent.
	 */
	delegationMode?: DelegationMode;

	/**
	 * Whether context should be preserved across subtasks.
	 */
	preserveContext?: boolean;

	/**
	 * Variables inherited from the parent orchestrator.
	 */
	inheritedVariables?: Record<string, unknown>;

	/**
	 * Parent task ID for tracking delegation chains.
	 */
	parentTaskId?: string;

	/**
	 * Expected artifact types from this task.
	 */
	expectedArtifacts?: Array<
		"code" | "browser-state" | "subtasks" | "variables" | "file"
	>;

	/**
	 * Original full task description (for complete-task delegation).
	 * This is the user's original request, not a decomposed step.
	 */
	originalTaskDescription?: string;

	/**
	 * Multi-tenancy context for workspace and memory isolation.
	 */
	tenantContext?: {
		userId: string;
		organizationId?: string;
	};
}

export interface SendMessageResponse {
	task: A2ATask;
}

/**
 * Extended SendMessageResponse with generalist agent outputs
 */
export interface SendMessageResponseWithDelegation extends SendMessageResponse {
	task: A2ATaskWithDelegation;
}

/**
 * Validation result for A2A endpoint
 */
export interface A2AValidationResult {
	valid: boolean;
	protocolVersion?: string;
	agentCard?: AgentCard;
	capabilities: {
		agentCard: boolean;
		sendMessage: boolean;
		streaming: boolean;
		taskManagement: boolean;
	};
	errors: string[];
}
