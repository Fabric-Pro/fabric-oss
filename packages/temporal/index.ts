/**
 * Temporal Package
 *
 * Provides durable workflow orchestration for the fabric-portal application.
 *
 * Main exports:
 * - getTemporalClient: Get Temporal client for starting workflows
 * - isTemporalAvailable: Check if Temporal is available
 * - Workflow types and inputs
 *
 * Usage:
 *   import { getTemporalClient } from '@repo/temporal';
 *
 *   const client = await getTemporalClient();
 *   const handle = await client.workflow.start(chatTitleGenerationWorkflow, {
 *     taskQueue: 'ai-chat',
 *     workflowId: 'title-chat-123',
 *     args: [{ chatId: '123', firstMessage: 'Hello', userId: 'user-1' }],
 *   });
 */

// SDK error types callers need for schedule error handling — re-exported so
// consumers outside this package don't need their own @temporalio/client
// dependency (the SDK version is pinned here with ~, and must stay single-source)
export {
	ScheduleAlreadyRunning,
	ScheduleNotFoundError,
} from "@temporalio/client";
export { executeMcpTool } from "./src/activities/orchestrator/execution/execute-mcp-tool";
export type {
	BulkStorySyncInput,
	BulkStorySyncResult,
	ContainerLevel,
	GetWorkItemsByIdsResult,
	KnownPmTool,
	ListWorkItemsResult,
	McpToolDefinition,
	PaginationInfo,
	PMAvailableState,
	PMToolCapabilities,
	PMWorkItemSummary,
	PmToolTier,
	StorySyncInput,
	StorySyncResult,
	SyncDirection,
	TaskCreationCapability,
	TaskGetCapability,
	TaskListCapability,
	TaskUpdateCapability,
	ToolInputSchema,
} from "./src/activities/pm-integration";
// PM Integration exports (for story/task sync with external PM tools)
export {
	analyzePMToolCapabilities,
	buildTaskCreationArgs,
	type ComposePmFieldPreviewInput,
	type ComposePmFieldPreviewResult,
	composePmFieldPreview,
	computePmHash,
	discoverPMToolCapabilities,
	// Custom field read-mapping — fronted by @repo/api's pm.* procedures
	type EnumeratePmFieldsInput,
	type EnumeratePmFieldsResult,
	enumeratePmFields,
	fetchPMItemsByIds,
	fetchPmComments,
	getContainerFetchWorkflow,
	getPMToolCapabilities,
	getPmToolTier,
	getStoriesToSync,
	getWorkItemsByIdsFromPM,
	listAllFizzyCards,
	listWorkItemsFromPM,
	PM_TOOL_TIERS,
	type PmFieldCatalogEntry,
	type PmFieldSuggestion,
	type PreviewPmFieldValue,
	type PreviewPmFieldValuesInput,
	type PreviewPmFieldValuesResult,
	parseAdoFormMetadata,
	parsePMItemFromGetOutput,
	previewPmFieldValues,
	type RecordPmSyncLogInput,
	recordPmSyncLog,
	// Field-mapping suggestion from sampled work items — fronted by pm.* procedures
	type SuggestPmFieldMappingInput,
	type SuggestPmFieldMappingResult,
	scoreFieldCandidates,
	searchWorkItemsFromPM,
	simpleHtmlToMarkdown,
	stripAttachmentBlock,
	suggestPmFieldMapping,
	syncBulkStoriesToPM,
	syncStoryToPM,
	syncTaskToPM,
	updateStoryExternalRefs,
} from "./src/activities/pm-integration";
// Client exports
export {
	closeTemporalConnection,
	getScheduleClient,
	getTemporalClient,
	getTemporalConfig,
	isTemporalAvailable,
} from "./src/client";
// Story drafting helper (shared across api + temporal callers)
export {
	type CreateStoryFromProposalParams,
	type CreateStoryFromProposalResult,
	createStoryFromProposal,
	type DraftBodyByKindParams,
	type DraftBodyByKindResolution,
	type DraftBodyByKindResult,
	draftBodyByKind,
} from "./src/lib/create-story-from-proposal";
// Async decision pre-check (card #1365) — shared with @repo/api's apply path so a
// fast-apply / chat "skip analysis" proposal that carried no ride-along result is
// still checked authoritatively server-side before the override log. Pure lib
// (DB + @repo/ai judge, no Temporal SDK), so it's safe to import from the API.
export {
	type RunDecisionPrecheckInput,
	runDecisionPrecheck,
} from "./src/lib/decision-precheck";
// Automatic semantic duplicate detection for newly-created stories.
// `triggerDuplicateDetection` (fire-and-forget background workflow) is the
// public entry point used by the AI create paths; `detectAndFlagDuplicateStories`
// is the underlying implementation (run inside the detectDuplicates activity).
export {
	type DetectDuplicateStoriesParams,
	type DetectDuplicateStoriesResult,
	detectAndFlagDuplicateStories,
} from "./src/lib/detect-duplicate-stories";
// Shared duplicate-detection orchestration core (embedding cache + candidate
// selection + 3-way verifier + verdict persistence). The @repo/api manual
// roadmap scan wraps this with its auth/bookkeeping; the auto-detect wrapper
// above adds the Temporal retry contract. No Temporal SDK imports — safe for
// the API runtime.
export {
	type DuplicateScanCoreParams,
	type DuplicateScanCoreResult,
	EmbeddingUnavailableError,
	runDuplicateScanCore,
} from "./src/lib/duplicate-scan-core";
// Lifecycle event dispatcher (shared across api + temporal callers)
export {
	type DispatchLifecycleEventInput,
	dispatchLifecycleEvent,
} from "./src/lib/lifecycle-dispatcher";
// Cross-kind prompt guard (Fizzy #2048) — the creation path runs it after
// classification, @repo/api's procedures run it before an edit. Pure lib (one
// binding query, no Temporal SDK, no orpc), so it is safe to import from the API
// runtime; prefer the `@repo/temporal/prompt-kind-guard` subpath there to avoid
// pulling this barrel's workflow graph in.
export {
	assertPromptKindCompatible,
	PromptKindMismatchError,
	type PromptKindScope,
	validatePromptForKind,
} from "./src/lib/prompt-kind-guard";
// Structure-preserving body merge. Exported for the enrichment preview
// procedure in @repo/api, so the diff a reviewer sees after re-targeting an
// enrichment is produced by the SAME merge the apply path will run — a preview
// computed a different way would be a preview of something else. Pure lib
// (prompt binding + @repo/ai, no Temporal SDK), so the API can import it.
export {
	type ReanalyzeBodyByKindParams,
	type ReanalyzeBodyByKindResult,
	reanalyzeBodyByKind,
} from "./src/lib/reanalyze-body-by-kind";
// Context summarization dispatcher (shared by the manual API trigger + the auto cron)
export {
	type ContextSummarizationInput,
	cancelContextSummarizationWorkflow,
	startContextSummarizationWorkflow,
} from "./src/lib/start-context-summarization";
export {
	type TriggerDuplicateDetectionParams,
	triggerDuplicateDetection,
} from "./src/lib/trigger-duplicate-detection";
// "Update using context" engine (shared across api + temporal callers) — the
// interactive procedures (documents + stories) and the scheduled document
// refresh must run the exact same prompt, schema, and retrieval.
export {
	type ContextItem,
	type ContextUpdateResult,
	ContextUpdateSchema,
	ContextUpdateTruncatedError,
	fetchProjectContextSources,
	formatContextItems,
	type ProjectContextSources,
	type RunContextUpdateArgs,
	runContextUpdate,
	UPDATE_WITH_CONTEXT_SYSTEM_PROMPT,
} from "./src/lib/update-with-context-core";
// MCP Tool Ingestion Client (for triggering workflows from API)
export {
	triggerFullMcpServerIngestion,
	triggerFullMcpToolIngestion,
	// Phase 1: Semantic Server Selection
	triggerMcpServerIngestion,
	triggerMcpToolDeletion,
	triggerMcpToolIngestion,
} from "./src/mcp-ingestion-client";
// OAuth Tool and Server Ingestion Client (for triggering workflows from API)
export {
	triggerOAuthServerIngestion,
	triggerOAuthToolIngestion,
} from "./src/oauth-ingestion-client";
// URL Context Sources — per-context Schedule helpers
export {
	buildUrlSourceScheduleId,
	type CreateUrlSourceScheduleArgs,
	type CreateUrlSourceScheduleResult,
	cadenceNextFireUtc,
	createUrlSourceSchedule,
	cronForRefreshMode,
	type DeleteUrlSourceScheduleArgs,
	deleteUrlSourceSchedule,
	isScheduledMode,
	MissingFirecrawlKeyError,
	parseContextIdFromScheduleId,
	type UpdateUrlSourceScheduleArgs,
	type UpdateUrlSourceScheduleResult,
	updateUrlSourceSchedule,
} from "./src/schedules/url-source-schedule";
export {
	buildWorkflowScheduleId,
	deleteWorkflowSchedule,
	findScheduleCron,
	isPlausibleCron,
	parseWorkflowIdFromScheduleId,
	type UpsertWorkflowScheduleArgs,
	upsertWorkflowSchedule,
	WORKFLOW_BUILDER_SCHEDULE_PREFIX,
} from "./src/schedules/workflow-builder-schedule";
// Type exports
export type {
	ChatMessageInput,
	ChatMessageOutput,
	ChatTitleGenerationInput,
	ChatTitleGenerationOutput,
	DirectChatProgressUpdate,
	DirectChatToolCall,
	DirectChatWorkflowConfirmation,
	DirectChatWorkflowInput,
	DirectChatWorkflowOutput,
	DocumentProcessingInput,
	DocumentProcessingOutput,
	RagContextRetrievalInput,
	RagContextRetrievalOutput,
	TemporalConfig,
	WorkerConfig,
	WorkflowStatus,
} from "./src/types";
// Workflow exports (for type references only - actual workflows are loaded by worker)
export type {
	chatMessageWorkflow,
	chatTitleGenerationWorkflow,
	directChatWorkflow,
	documentProcessingWorkflow,
	FabricMentionReplyWorkflowInput,
	FabricMentionReplyWorkflowOutput,
	fabricMentionReplyWorkflow,
	ragContextRetrievalWorkflow,
	StepExecutionContext,
} from "./src/workflows";
// Orchestrator workflow and signals (re-exported from workflows/index.ts with unique names)
// Context manager utilities for step context propagation
export {
	buildContextualDelegationMessage,
	buildStepContext,
	followUpSignal,
	formatContextForPrompt,
	getContextSummary,
	journeyStateQuery,
	mergeStepVariables,
	orchestratorApprovalSignal,
	orchestratorCancelSignal,
	orchestratorExecutionWorkflow,
	orchestratorPendingApprovalQuery,
	orchestratorPlanQuery,
	orchestratorProgressQuery,
	orchestratorStatusQuery,
	orchestratorVariablesQuery,
	pendingModificationQuery,
	updateVariableSignal,
	updateVariablesFromStep,
} from "./src/workflows";
// Agent Supervisor types
export type { ExecutionRequest } from "./src/workflows/agent-supervisor";
// Approval workflow signal (for signaling running workflows)
export { approveSignal } from "./src/workflows/approval-workflow";
// Backlog Apply Changes Workflow (contextual backlog updater)
export type {
	BacklogApplyChangesInput,
	BacklogApplyChangesOutput,
	BacklogApplyProgress,
} from "./src/workflows/backlog-apply-changes-workflow";
export {
	applyProgressQuery,
	backlogApplyChangesWorkflow,
	cancelApplySignal,
} from "./src/workflows/backlog-apply-changes-workflow";
// Backlog Context Analysis Workflow (contextual backlog updater)
export type {
	AnalysisStatus,
	BacklogContextAnalysisInput,
	BacklogContextAnalysisOutput,
	BacklogContextAnalysisProgress,
} from "./src/workflows/backlog-context-analysis-workflow";
export {
	analysisProgressQuery,
	analysisResultQuery,
	backlogContextAnalysisWorkflow,
	cancelAnalysisSignal,
} from "./src/workflows/backlog-context-analysis-workflow";
// Browser automation workflow types
export type { BrowserAutomationInput } from "./src/workflows/browser-automation";
export type {
	BrowserRagIngestionInput,
	BrowserRagIngestionOutput,
} from "./src/workflows/browser-rag-ingestion";
// Daily Brief workflow (cross-tool project digest)
export type {
	DailyBriefPhase,
	DailyBriefProgress,
	GenerateDailyBriefInput,
	GenerateDailyBriefOutput,
} from "./src/workflows/daily-brief-generation-workflow";
// Deep Researcher Workflow Types
export type {
	DeepResearcherInput,
	DeepResearcherOutput,
	DeepResearcherPhase,
	DeepResearcherProgress,
	DeepResearcherState,
	ResearchComplexity,
	SubAgentResult,
	SubTask,
} from "./src/workflows/deep-researcher";
// Newsletter workflow input/output (consumed by @repo/api's manual-send path).
// Mirrors the GenerateDailyBriefInput re-export above so the type is reachable
// via `import { GenerateAndSendNewsletterInput } from "@repo/temporal"`.
export type {
	GenerateAndSendNewsletterInput,
	GenerateAndSendNewsletterOutput,
} from "./src/workflows/generate-and-send-newsletter";
export type { HybridExecutionInput } from "./src/workflows/hybrid-execution";
// MCP Tool Ingestion Workflow Types
export type {
	McpToolIngestionInput,
	McpToolIngestionOutput,
} from "./src/workflows/mcp-tool-ingestion";
export type {
	MemberCascadeDeleteWorkflowInput,
	MemberCascadeDeleteWorkflowOutput,
} from "./src/workflows/member-cascade-delete";
// Member Cascade Delete Workflow (cleanup when user removed from org)
export { memberCascadeDeleteWorkflow } from "./src/workflows/member-cascade-delete";
// Orchestrator exports (CUGA-inspired multi-agent orchestration)
// Re-export OrchestratorStepResult as StepResult for backward compatibility
export type {
	AgentCapability,
	AgentVariable,
	ALTKConfig,
	ApprovalHistoryEntry,
	ApprovalSignalData,
	ExecutionMemorySummary,
	ExecutionMode,
	// Memory types
	FailureWarning,
	HybridRoutingResult,
	HybridRoutingSuggestion,
	OrchestratorProgressUpdate,
	OrchestratorStepResult,
	OrchestratorStepResult as StepResult,
	OrchestratorWorkflowInput,
	OrchestratorWorkflowOutput,
	PolicyContext,
	PolicyRule,
	RoutingDecision,
	SemanticMemoryResult,
	TaskPlan,
	TaskStep,
	Trajectory,
	TrajectoryStep,
} from "./src/workflows/orchestrator/types";
export {
	AGENT_REGISTRY,
	DEFAULT_ALTK_CONFIG,
	EXECUTION_MODE_CONFIGS,
} from "./src/workflows/orchestrator/types";
// Required connection and missing integration types for connection prompts
// Exported separately due to module resolution constraints
export type {
	MissingIntegration,
	RequiredConnection,
} from "./src/workflows/orchestrator/types/routing.types";
// Pure error classifier used by API procedures to classify retry/apply
// failures into the same { errorClass, errorMessage } shape the workflows
// stamp onto PendingBacklogProposal. No Temporal SDK calls — safe to import
// from non-workflow contexts.
export { unwrapPmSyncError } from "./src/workflows/pm-sync-error-unwrap";
// Project Deletion Workflows (soft delete cleanup and permanent delete)
export type {
	ProjectDeleteCleanupWorkflowInput,
	ProjectDeleteCleanupWorkflowOutput,
	ProjectPermanentDeleteWorkflowInput,
	ProjectPermanentDeleteWorkflowOutput,
} from "./src/workflows/project-deletion";
export {
	projectDeleteCleanupWorkflow,
	projectPermanentDeleteWorkflow,
} from "./src/workflows/project-deletion";
export type {
	StorySyncProgress,
	StorySyncWorkflowInput,
	StorySyncWorkflowOutput,
} from "./src/workflows/story-sync-workflow";
// Story Sync Workflow
export {
	cancelSyncSignal,
	progressQuery as storySyncProgressQuery,
	storySyncWorkflow,
} from "./src/workflows/story-sync-workflow";
// Teams Mention Handler Workflow
export {
	teamsMentionHandlerWorkflow,
	teamsMentionSignal,
} from "./src/workflows/teams-mention-handler";
export type { TemplateExecutionInput } from "./src/workflows/template-execution";
// Trigger System Workflows (Slack conversational threads)
export {
	type SlackMentionEvent,
	slackMentionHandlerWorkflow,
	slackMentionSignal,
} from "./src/workflows/trigger-system";
export type {
	TriggerWorkflowInput,
	TriggerWorkflowOutput,
} from "./src/workflows/trigger-system/types";
