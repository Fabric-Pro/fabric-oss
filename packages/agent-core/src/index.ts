/**
 * @repo/agent-core
 *
 * Core agent infrastructure for framework-agnostic agent management.
 * Provides:
 * - Agent adapter interface for any framework/language
 * - Agent registry for discovery and management
 * - CopilotKit integration helpers
 */

// A2A Protocol Module (Agent-to-Agent communication)
export type {
	A2AError,
	A2AMessage,
	A2ATask,
	A2AValidationResult,
	AgentCapabilities,
	AgentCard,
	AgentSkill,
	AIConfig,
	Artifact,
	DataPart,
	FilePart,
	MessagePart,
	SecureA2AClientOptions,
	SecureTenantContext,
	TaskEvent,
	TaskStatus,
	TextPart,
} from "./a2a";
export {
	A2AClient,
	A2AClientError,
	extractAgentMetadata,
	isA2AHealthy,
	SecureA2AClient,
	validateA2AEndpoint,
} from "./a2a";
// A2A Custom Agent Wrapper (for user-created custom agents)
export type {
	CustomAgentConfig,
	CustomAgentMcpClient,
	CustomAgentModelExecutor,
} from "./a2a/custom-agent-wrapper";
export {
	createCustomAgentA2AExecutor,
	generateAgentCard,
	generateSkillsFromConfig,
} from "./a2a/custom-agent-wrapper";
// A2A Server (for wrapping agents with A2A protocol)
export type {
	A2AAgentExecutor,
	A2AExecutionResult,
	A2AServerConfig,
	A2AStreamEvent,
} from "./a2a/server";
export {
	A2AServer,
	createLangGraphA2AExecutor,
	createLangGraphStreamingA2AExecutor,
} from "./a2a/server";
// Core interfaces
export type {
	AgentAdapter,
	AgentConfig,
	AgentContext,
	AgentHealthStatus,
	CopilotKitAgentAdapter,
	PredictiveStateConfig,
} from "./adapter";
// Adapters
export * from "./adapters";
// AG-UI Protocol
export type {
	AGUIEvent,
	AGUIEventType,
	AgentActivityIndicator,
	AgentActivityStatus,
	ErrorEvent,
	HumanInLoopRequestEvent,
	HumanInLoopResponseEvent,
	StateDeltaEvent,
	StreamChunkEvent,
	StreamEndEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "./ag-ui-protocol";
export {
	isAGUIEvent,
	isErrorEvent,
	isHumanInLoopRequestEvent,
	isHumanInLoopResponseEvent,
	isStateDeltaEvent,
	isStreamChunkEvent,
	isStreamEndEvent,
	isToolCallEvent,
	isToolResultEvent,
} from "./ag-ui-protocol";
// Errors
export {
	AgentAuthorizationError,
	AgentConfigurationError,
	AgentError,
	AgentExecutionError,
	AgentHealthCheckError,
	AgentNotFoundError,
	AgentTimeoutError,
} from "./errors";
// Human-in-the-Loop (HITL) Module
export type {
	HITLConfig,
	HITLOption,
	HITLRequest,
	HITLRequestType,
	HITLResponse,
	HITLRiskAssessment,
	HITLState,
	RiskAwareHITLRequest,
	// Risk-based types (CUGA-inspired)
	RiskLevel,
} from "./hitl";
export {
	CHOICE_PRESETS,
	createChoiceOptions,
	createRiskAwareHITLRequest,
	DEFAULT_HITL_CONFIG,
	DEFAULT_HITL_STATE,
	HITL_TOOLS,
	// Tools
	REQUEST_HUMAN_APPROVAL_TOOL,
	REQUEST_HUMAN_CHOICE_TOOL,
	REQUEST_HUMAN_INPUT_TOOL,
	requiresApproval,
	// Risk-based functions (CUGA-inspired)
	requiresRiskBasedApproval,
} from "./hitl";
// Metadata
export type {
	AGUIProtocolVersion,
	AgentCapability,
	AgentDiscoveryResult,
	AgentEndpoints,
	AgentMetadataResponse,
} from "./metadata";
export {
	AGUIProtocolVersionSchema,
	AgentCapabilitySchema,
	AgentDiscoveryResultSchema,
	AgentEndpointsSchema,
	AgentMetadataResponseSchema,
	hasRequiredEndpoints,
	safeValidateAgentMetadata,
	supportsAGUIProtocol,
	supportsCapability,
	ToolDefinitionSchema,
	validateAgentMetadata,
} from "./metadata-schema";
// Reasoning Modes Module
export type {
	ReasoningInput,
	ReasoningMode,
	ReasoningModeConfig,
	ReasoningNodeOptions,
	ReasoningOutput,
	ReasoningState,
	ReasoningStep,
} from "./reasoning";
export {
	addReasoningStep,
	BALANCED_MODE_CONFIG,
	createInitialReasoningState,
	createReasoningNode,
	DEEP_MODE_CONFIG,
	DEFAULT_REASONING_MODE,
	getReasoningModeConfig,
	LITE_MODE_CONFIG,
	REASONING_MODE_CONFIGS,
	suggestReasoningMode,
} from "./reasoning";
// Reflection Module
export type {
	DimensionEvaluation,
	QualityDimension,
	ReflectionConfig,
	ReflectionInput,
	ReflectionOutput,
	ReflectionResult,
	ReflectionState,
} from "./reflection";
export {
	calculateOverallScore,
	createReflectionNode,
	DEFAULT_REFLECTION_CONFIG,
	getCorrectionPrompt,
	getReflectionSystemPrompt,
	getReflectionUserPrompt,
	parseReflectionResponse,
} from "./reflection";
// Registry
export { AgentRegistry, globalAgentRegistry } from "./registry";
// Services (agent loader - no database dependency)
export type {
	AgentLoadContext,
	LoadedAgent,
} from "./services";
export {
	AgentLoaderService,
	getAgentLoader,
} from "./services";
// LangChain Model Factory (for LangGraph agents)
export type {
	LangChainModelConfig,
	ModelOptions,
	RuntimeProviderConfig,
} from "./services/langchain-models";
export {
	// Provider-aware model creation (recommended)
	createProviderModel,
	extractProviderConfig,
	// Async version with API fallback (for tenant context auth)
	getAgentModelAsync,
	getAgentModelFromConfig,
	REASONING_OUTPUT_TOKEN_ALLOWANCE,
	reasoningOutputAllowance,
	reasoningOutputAllowanceForConfig,
} from "./services/langchain-models";
export {
	type AgentUsageLoggerConfig,
	type AgentUsageLogOptions,
	extractUsageFromLangChainResponse,
	logAgentUsageFromRunnableConfig,
} from "./services/usage-logging";
// Tool Shortlisting Module
export type {
	CacheEntry,
	RankedTool,
	ShortlistConfig,
	ShortlistResult,
	TaskContext,
	ToolInfo,
} from "./tool-shortlisting";
export {
	DEFAULT_SHORTLIST_CONFIG,
	ToolShortlister,
} from "./tool-shortlisting";
// Trajectory Module (for execution visualization)
export type {
	AddNodeOptions,
	AgentTrajectory,
	CreateTrajectoryOptions,
	TrajectoryEdge,
	TrajectoryEvent,
	TrajectoryNode,
	TrajectoryNodeStatus,
	TrajectoryNodeType,
	TrajectoryStatus,
} from "./trajectory";
export {
	globalTrajectoryCollector,
	TrajectoryCollector,
} from "./trajectory";

// NOTE: Database-dependent services (AI Gateway, MCP Tools, Semantic Memory)
// are exported from a separate subpath: "@repo/agent-core/backend"
// to avoid ESM compatibility issues with agents that run as separate processes.
// Import them directly when needed:
//   import { getConfiguredAIModel } from "@repo/agent-core/backend"

// Multi-Tenant Runtime (re-exported from @repo/agent-runtime)
// NOTE: For full multi-tenant support, use "@repo/agent-core/runtime" or "@repo/agent-runtime" directly
// These are the most commonly used exports for convenience
export type {
	AgentErrorResponse,
	BaseAgentRequest,
	BaseAgentResponse,
	TenantContext,
	TenantModelConfig,
} from "@repo/agent-runtime";
export {
	getOptionalTenant,
	getTenant,
	hasScope,
	// API key resolution
	resolveApiKeyToTenant,
	// Tenant authentication middleware
	tenantAuth,
} from "@repo/agent-runtime";
// Fabric AI Integration
// Implements Fabric's Strategy → Context → Pattern composition model
export type {
	ComposeOptions,
	ComposeResult,
	DetectAndComposeOptions,
	EnhancePromptOptions,
	EnhancePromptResult,
	FabricContext,
	FabricPattern,
	// Legacy compatibility
	FabricPatternName,
	// Core types
	FabricStrategy,
} from "./fabric";
export {
	AGENT_PATTERN_PRESETS,
	// Core composition functions (recommended)
	composeFabricPrompt,
	detectAndCompose,
	detectFabricComponents,
	enhancePromptWithFabricPattern,
	FABRIC_CONTEXTS,
	// Constants
	FABRIC_PATTERNS,
	FABRIC_STRATEGIES,
	// Reusable composer class
	FabricPromptComposer,
	getContext,
	// Legacy compatibility
	getFabricPattern,
	getPattern,
	getStrategy,
	// API functions
	isFabricAvailable,
	listContexts,
	listFabricPatterns,
	listPatterns,
	listStrategies,
} from "./fabric";
// Security Middleware
export type { AuthConfig } from "./middleware/auth";
export {
	createAuthMiddleware,
	isAuthEnabled,
	loadAuthConfigFromEnv,
} from "./middleware/auth";
export type {} from "./middleware/rate-limit";
export {
	createRateLimitMiddleware,
	loadRateLimitConfigFromEnv,
} from "./middleware/rate-limit";
export {
	hoistRawStopReason,
	isOutputTruncated,
	resolveStopReason,
} from "./output-truncation";
export { PredictiveToolArgsAccumulator } from "./predictive-tool-args";
// Unified Server (single server for both AG-UI and A2A protocols)
export type {
	AgentRuntimeConfig,
	LangGraphExecutor,
	LangGraphPlatformStreamExecutor,
	LangGraphStreamEvent,
	LangGraphStreamExecutor,
	TransformResult,
	UnifiedServerConfig,
} from "./unified-server";
export { createUnifiedServer } from "./unified-server";
// Utilities
export {
	convertToSimpleMessages,
	getAssistantMessages,
	getLastMessageContent,
	type SimpleMessage,
	sanitizeMcpErrorMessage,
} from "./utils";
