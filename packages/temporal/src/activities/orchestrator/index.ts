/**
 * Orchestrator Activities Module
 *
 * This module provides a modular, organized structure for orchestrator activities.
 * All activities have been migrated from the monolithic orchestrator-activities.ts.
 *
 * Module Organization:
 * - types: All activity input/output interfaces
 * - utils: Helper functions (JSON parsing, tool learning, model selection)
 * - tools: Dynamic tool/capability discovery and caching
 * - context: Context analysis, synthesis, and management
 * - research: AI SDK powered research agent for context gathering
 * - routing: Task analysis, routing decisions, and capability discovery
 * - planning: Task plan creation, decomposition, execution strategies, I/O contracts
 * - execution: Step execution, MCP tool execution, agent-as-tool, strategy execution
 * - delegation: Agent resolution, capabilities, and A2A delegation
 * - policy: Policy enrichment, validation, and reflection
 * - workflow: Workflow triggering
 * - trajectory: Trajectory storage and retrieval
 * - approval: HITL approval workflows, trust management, templates
 * - learning: Tool usage patterns, execution patterns, negative memory
 * - observability: Execution tracking, debugging tools
 */

// =============================================================================
// Approval - HITL approval workflows
// =============================================================================
// biome-ignore assist/source/organizeImports: Orchestrator exports are intentionally grouped by domain.
export {
	// Trust-based approval activities
	analyzePlanApprovalActivity,
	checkStepAutoApprovalActivity,
	createOrchestratorApprovalRequest,
	getApprovalStatus,
	getTrustConfigActivity,
	recordApprovalOutcomeActivity,
	updateApprovalTaskStatus,
	updateExecutionProgress,
} from "./approval";
// Intent-clarity — HITL clarifying question before committing to a plan
export {
	type AnalyzeIntentClarityInput,
	type AnalyzeIntentClarityResult,
	analyzeIntentClarityActivity,
} from "./clarification";
// Runtime authority check activity (Pipes-style authorization)
export {
	approveAuthoritySessionActivity,
	type CheckStepAuthorityInput,
	type CheckStepAuthorityOutput,
	checkStepAuthorityActivity,
	denyAuthoritySessionActivity,
} from "./authority-check";
// =============================================================================
// Context - Context analysis, synthesis, and management
// =============================================================================
export {
	addResearchResults,
	analyzeContextRequirements,
	ContextSummarizer,
	type ContextWindow,
	checkContextBudgetActivity,
	contextSummarizer,
	createContextBag,
	estimateStepTokensActivity,
	formatContextForDelegation,
	getRelevantContext,
	hasResearch,
	hasSynthesizedContext,
	IncrementalSummarizer,
	type SummarizationResult,
	setSynthesizedContext,
	// Phase 4.3: Context Summarization
	summarizeContextActivity,
	synthesizeContext,
	updateContextBag,
} from "./context";
// =============================================================================
// Delegation - Agent resolution, capabilities, A2A
// =============================================================================
export {
	agentHasCapability,
	buildContextualDelegationMessage,
	buildDelegationMessage,
	buildResearchQueryMessage,
	buildSimpleDelegationMessage,
	delegateToAgent,
	determineDelegationStrategy,
	getAgentCapabilities,
	isAgentSuitableForTask,
	resolveAgentEndpoint,
	resolveAgentUrl,
	summarizeConversationHistory,
	truncateText,
} from "./delegation";

// =============================================================================
// Execution - Step execution, MCP tools, agent-as-tool, strategy execution
// =============================================================================
export {
	// Iterative Agent Execution
	type AgentIterationResult,
	type AgentToolCall,
	// Conversation Compaction (mid-execution history summarization)
	type CompactConversationInput,
	type CompactConversationResult,
	// Phase 2.3: Recovery Management
	classifyFailure,
	// Activity wrappers for Temporal workflow compatibility
	classifyFailureActivity,
	compactConversationHistoryActivity,
	createCheckpoint,
	createRetryStep,
	detectOperationType,
	detectOperationTypeFromTool,
	type ExecuteStrategyInput,
	type ExecuteStrategyOutput,
	type ExecutionCheckpoint,
	executeAgentAsTool,
	executeDirectStrategy,
	executeMcpTool,
	executeStep,
	executeStrategy,
	extractCountFromResult,
	extractEntityType,
	extractEntityTypeDestructive,
	extractExpectedCountFromContext,
	extractTargetEntityName,
	findVerificationTool,
	formatRecoveryError,
	type GenericVerificationInput,
	type GenericVerificationResult,
	getRecoveryStrategies,
	getRetryDelay,
	getRetryDelayActivity,
	isBulkOperation,
	isDestructiveStep,
	isEmptyOrNotFound,
	isSpecificItemOperation,
	type OperationType,
	type PhaseResult,
	type RecoveryContext,
	type RecoveryDecision,
	type RecoveryStrategy,
	type RunAgentIterationInput,
	restoreFromCheckpoint,
	runAgentIteration,
	selectRecoveryStrategy,
	shouldRetry,
	shouldRetryActivity,
	// Large Tool Result Summarization
	summarizeLargeToolResult,
	type VerificationInput,
	type VerificationResult,
	// Destructive Operation Verification (legacy)
	verifyDestructiveOperation,
	// Generic Operation Verification (new comprehensive system)
	verifyOperation,
} from "./execution";
// =============================================================================
// Instance - Agent instance memory loading
// =============================================================================
export {
	type LoadInstanceMemoryInput,
	type LoadInstanceMemoryOutput,
	loadInstanceMemoryActivity,
} from "./instance";
export {
	type AgentDatabricksBinding,
	buildDatabricksKnowledgeToolDefinition,
	type DatabricksKnowledgeSearchResult,
	executeDatabricksKnowledgeSearchActivity,
	type ExecuteDatabricksKnowledgeSearchActivityInput,
	type LoadAgentDatabricksBindingsInput,
} from "../shared/databricks-knowledge";
// =============================================================================
// Planning - Task plan creation, decomposition, execution strategies
// =============================================================================
export {
	// Operation Risk Detection
	assessToolCallRisk,
	// Planning
	autoWireStepsActivity,
	type ContractValidationResult,
	createEnhancedTaskPlan,
	createTaskPlan,
	type DetectionInput,
	detectOperationRisk,
	EXECUTION_STRATEGIES,
	explainRiskAssessment,
	getStrategyPhases,
	// Phase 4.2: Step I/O Contracts
	inferAndValidateContractsActivity,
	isParallelizableStrategy,
	type OperationType as RiskOperationType,
	type PlanValidationResult,
	type RiskAssessment,
	type RiskLevel,
	type StepIOContract,
	selectExecutionStrategy,
	strategyRequiresResearch,
	type ToolCallRiskAssessment,
	type ValidatePlanInput,
	// Phase 2: Plan Validation
	validatePlan,
	validateToolsForDestructivePatterns,
} from "./planning";
// =============================================================================
// Policy - Policy enrichment, validation, reflection
// =============================================================================
export {
	// Fabric AI pattern enrichment (Strategy → Context → Pattern)
	applyFabricPatternEnrichment,
	applyPolicyEnrichment,
	FABRIC_CONTEXTS,
	FABRIC_PATTERNS,
	FABRIC_STRATEGIES,
	type FabricPatternEnrichmentInput,
	type FabricPatternEnrichmentOutput,
	listFabricComponents,
	ORCHESTRATOR_ENRICHMENT_PRESETS,
	reflectOnOutput,
	validateWithALTK,
} from "./policy";
// =============================================================================
// Research - AI SDK powered research agent
// =============================================================================
export {
	buildResearchTools,
	executeResearchAgent,
	getResearchToolName,
	isResearchTool,
} from "./research";
// =============================================================================
// Routing - Task analysis, routing decisions, capability discovery
// =============================================================================
export {
	analyzeAndRoute,
	detectUserIntent,
	discoverCapabilities,
	getAvailableAgentsList,
	getAvailableMcpToolsList,
	matchCapabilities,
	shouldSearchIntegrations,
} from "./routing";
// =============================================================================
// Tools - Dynamic tool/capability discovery and caching
// =============================================================================
export {
	agentSearchToolDefinition,
	type CacheEntry,
	type CacheStats,
	cosineSimilarity,
	// Capability Embeddings
	EmbeddingCache,
	type EmbeddingCacheEntry,
	type EmbeddingCacheOptions,
	type EmbeddingSearchResult,
	embeddingCache,
	fetchToolsFromServerIds,
	// Default-MCP config lookup (managed-default surface routing helper).
	// `findExcalidrawConfigActivity` is the legacy alias preserved for
	// replay-compat against pre-rename dev histories.
	type FindDefaultMcpConfigArgs,
	type FindDefaultMcpConfigResult,
	findDefaultMcpConfigActivity,
	findExcalidrawConfigActivity,
	// Default-enabled MCP server registry — drives keyword-based eager routing
	type DefaultEnabledMcpServerEntry,
	listDefaultEnabledMcpServersActivity,
	getOrGenerateEmbedding,
	getOrGenerateEmbeddings,
	hybridScore,
	loadToolDefinitions,
	mergeSearchResults,
	// Pre-load MCP tools for focused agents
	preloadMcpToolsForConfigsActivity,
	rebuildToolIndex,
	type SearchAvailableAgentsInput,
	type SearchAvailableAgentsOutput,
	type SearchAvailableIntegrationsInput,
	type SearchAvailableToolsInput,
	type SearchAvailableToolsOutput,
	searchAvailableAgents,
	searchAvailableIntegrations,
	// Tool Search
	searchAvailableTools,
	semanticSearch,
	semanticSearchPrecomputed,
	type ToolCategory,
	// Tool Index
	ToolIndex,
	type ToolIndexEntry,
	type ToolSearchOptions,
	type ToolSearchResult,
	toolIndex,
	toolSearchToolDefinition,
} from "./tools";
// =============================================================================
// Trajectory - Trajectory storage and retrieval
// =============================================================================
export { findSimilarTrajectory, saveTrajectory } from "./trajectory";
// =============================================================================
// Types - All activity input/output interfaces
// =============================================================================
export * from "./types";
// =============================================================================
// Utils - Helper functions
// =============================================================================
export {
	getAiModel,
	getToolLearningContext,
	// Registered as an orchestrator activity so the workflow can fire it
	// via `proxyActivities` whenever `state.mcpDefaultToolSignals` gains
	// a new entry (success or failure).
	publishMcpDefaultToolSignalActivity,
	recordFailedToolCall,
	recordSuccessfulToolCall,
	safeParseJson,
} from "./utils";
// =============================================================================
// Workflow - Workflow triggering
// =============================================================================
export { triggerWorkflow } from "./workflow";

// =============================================================================
// Re-exports from Related Modules (for convenience)
// =============================================================================

// Workspace document retrieval (from direct-chat activities)
export { retrieveWorkspaceDocumentsActivity } from "../direct-chat";
// Letta memory activities
export {
	cacheToolResult,
	getCachedToolResult,
	getRoutingSuggestions,
	initializeLettaMemory,
	recordExecution,
} from "../letta-memory-activities";
// Qdrant memory activities
export {
	embedAndStoreTrajectory,
	getHybridRoutingSuggestions,
	searchSemanticMemory,
} from "../orchestrator-memory-activities";
// Project context retrieval (for project_rag_query tool)
export { retrieveProjectContextsActivity } from "../project-metadata";
// Live integration message search (for search_slack_messages / search_teams_messages tools)
export { searchProjectSlackMessages } from "../search-project-slack-messages";
export { searchProjectTeamsMessages } from "../search-project-teams-messages";
export type {
	ExecuteSkillToolInput,
	ExecuteSkillToolOutput,
} from "../skill-tool-execution";
// Agent Skills tool dispatch (for list_skills / load_skill / read_skill_file)
export { executeSkillToolActivity } from "../skill-tool-execution";
// =============================================================================
// Config - Centralized configuration constants
// =============================================================================
export {
	ACTIVITY_TIMEOUTS,
	CONTEXT_LIMITS,
	DEFAULT_CAPABILITY_PRIORITY,
	DEFAULT_RISK_LEVELS,
	HEARTBEAT_INTERVALS,
	STEP_LIMITS,
	TOKEN_LIMITS,
} from "./config";

// =============================================================================
// Journey - Multi-turn conversation and journey state management
// =============================================================================
export {
	type Assumption,
	addConversationTurn,
	analyzeJourneyInput,
	applyJourneyUpdate,
	type Blocker,
	type Clarification,
	type ContinueJourneyInput,
	type ConversationTurn,
	type CreateJourneyInput,
	// Functions
	createJourneyState,
	type Decision,
	deserializeJourneyState,
	getAssumptionsContext,
	getBlockersContext,
	getConversationContext,
	getDecisionContext,
	getFullJourneyContext,
	getJourneySummary,
	type JourneyAnalysisResult,
	type JourneyContext,
	type JourneyMetrics,
	type JourneyPhase,
	// Types
	type JourneyState,
	type JourneyStateUpdate,
	type PlanModification,
	recordAssumption,
	recordBlocker,
	recordDecision,
	type StepResult,
	serializeJourneyState,
} from "./journey";
// =============================================================================
// Learning - Tool Usage Patterns, Execution Patterns, Negative Memory
// =============================================================================
export {
	getToolPatternActivity,
	queryToolLearningsActivity,
	// Persistent Qdrant store
	recordToolUsageActivity,
	searchSimilarToolContextsActivity,
	// Types
	type ToolCallRecord,
	type ToolLearningResult,
	type ToolUsagePattern,
} from "./learning";

// =============================================================================
// Plan Adaptation - Mid-execution plan modification
// =============================================================================
export {
	analyzePlanModification,
	analyzePlanModificationActivity,
	applyPlanModifications,
	createModificationRecord,
	describePlanChanges,
	type ExecutionAction,
	hasModificationIndicators,
	type ModificationType,
	type PlanChanges,
	type PlanModificationAnalysis,
	requiresConfirmation,
	validateModifiedPlan,
} from "./planning/plan-adapter";
// =============================================================================
// Preload - Resource preloading for efficiency
// =============================================================================
export {
	type PreloadedResources,
	type PreloadResourcesInput,
	preloadResourcesActivity,
} from "./preload";
// =============================================================================
// Presentation - Factory AI-style plan presentation
// =============================================================================
export {
	type PresentationOptions,
	presentCompletion,
	presentError,
	presentPlan,
	presentProgress,
} from "./presentation";
// =============================================================================
// Semantic Intent Matching - Dynamic capability discovery
// =============================================================================
export {
	type CapabilityDescriptor,
	type CapabilityMatch,
	clearEmbeddingCache,
	type DetectedIntent,
	detectUserIntentSemantic,
	intentToRoutingHints,
	loadCapabilities,
	precomputeCapabilityEmbeddings,
	type SemanticIntentResult,
	type UserPreference,
} from "./routing/semantic-intent-matcher";
