/**
 * Export all activities
 * Activities must be exported from a single file for the worker
 */

// Original agent execution activities (registry-based)
// biome-ignore assist/source/organizeImports: Activity exports are intentionally grouped by domain.
export * from "./agent-execution";
// Shared agent execution core module (reusable by deployment-execution, template-instance, etc.)
export * from "./agent-execution-core";
// Agent health monitor activities (scheduled health checks for registered agents)
export {
	type AgentHealthCheckTarget,
	type CheckAgentHealthInput,
	type CheckAgentHealthOutput,
	checkAgentHealth,
	type GetAgentsNeedingHealthCheckInput,
	getAgentsNeedingHealthCheckActivity,
	type MarkStaleAgentsInput,
	type MarkStaleAgentsOutput,
	markStaleAgents,
} from "./agent-health-monitor";
// Agent loader activities
export {
	executeExternalAgent,
	getAgentRoutingContext,
	healthCheckAgent,
	loadAvailableAgents,
	updateAgentHealth,
} from "./agent-loader-activities";
// Agent Memory activities (COALA-inspired memory system)
export {
	type AgentMemoryToolResult,
	type ApplyMemoryEditInput,
	applyMemoryEditActivity,
	getAgentMemoryTools,
	type InitializeAgentMemoryInput,
	initializeAgentMemoryActivity,
	type LoadAgentMemoryInput,
	type LoadAgentMemoryOutput,
	loadAgentMemoryActivity,
	memoryListTool,
	memoryReadTool,
	memorySearchTool,
	memoryWriteTool,
	type ProposeMemoryUpdateInput,
	proposeMemoryUpdateActivity,
} from "./agent-memory";
// Agent supervisor activities (durable agent deployment)
export {
	type CancelPendingExecutionInput,
	type CheckDeploymentHealthInput,
	cancelPendingExecution,
	checkDeploymentHealth,
	type DeploymentConfig,
	type GetDeploymentConfigInput,
	getDeploymentConfig,
	type HealthCheckResult,
	type SaveDeploymentStateInput,
	type SelectTaskQueueInput,
	type StartAgentExecutionInput,
	saveDeploymentState,
	selectTaskQueue,
	startAgentExecution,
	type TaskQueueResult,
	type UpdateDeploymentHealthInput,
	type UpdateDeploymentStatusInput,
	updateDeploymentHealth,
	updateDeploymentStatus,
} from "./agent-supervisor";
// Agentic loop activities (advanced patterns: context pruning, sub-agent delegation, data source tools)
export {
	type ConversationContext,
	createDataSourceTools,
	createListDataSourcesTool,
	createMinimalDataSourceTools,
	createReadDocumentTool,
	createRunAgentTool,
	createSearchDataSourcesTool,
	createWorkspaceSummaryTool,
	type DataSourceConfig,
	type DocumentInfo,
	getAvailableAgents,
	getContextTokenCount,
	type Message,
	needsPruning,
	type PruneContextInput,
	type PruneContextOutput,
	pruneConversationContext,
	type RunAgentInput,
	type RunAgentMode,
	type RunAgentOutput,
	runAgent,
	type SearchResult,
	searchDataSources,
} from "./agentic-loop";
export * from "./approval-activities";
// Atlas activities (Atlas tab — analysis graph build + AI describe)
export {
	type AtlasStructureResult,
	atlasDeriveBusinessActivity,
	atlasDescribeModulesActivity,
	atlasFinalizeActivity,
	atlasMarkStatusActivity,
	atlasRunStructureActivity,
} from "./atlas";
// Attachment final-orphan reconciliation sweep activity (daily schedule)
export { sweepAttachmentFinalOrphansActivity } from "./attachment-final-orphan-sweep";
// Attachment retention-purge activity (daily schedule).
export { purgeExpiredAttachmentsActivity } from "./attachment-retention-purge";
export { purgeExpiredRunEvidenceActivity } from "./qa-evidence-retention";
// Attachment temp-orphan sweep activity (gated by FABRIC_ATTACHMENT_TEMP_ORPHAN_SWEEP_ENABLED)
export { sweepAttachmentTempOrphansActivity } from "./attachment-temp-orphan-sweep";
// Audit log retention activities (opt-in, gated by FABRIC_AUDIT_LOG_RETENTION_ENABLED)
export { purgeExpiredAuditRowsActivity } from "./audit-log-retention";
export {
	failStaleBackgroundJobsActivity,
	purgeExpiredBackgroundJobsActivity,
} from "./background-job-retention";
// Audit log sealing activities (opt-in, gated by FABRIC_AUDIT_LOG_SEALING_ENABLED)
export { sealAuditLogActivity } from "./audit-log-seal";
// Authority session cleanup activities
export { expireAuthoritySessionsActivity } from "./authority-cleanup";
export * from "./automation-template";
// Backlog apply watchdog activities (every-5-min cron — recovers proposals stuck mid-apply)
export * from "./backlog-apply-watchdog-activities";
export * from "./document-generation-watchdog-activities";
// Backlog-context activities are exported through withOrganizationLogContext:
// each run is wrapped in its input's organization log context so every log
// line it emits carries Properties["organizationId"] for tenant-scoped
// queries (security review of Fizzy #1234 — telemetry enrichment).
import {
	analyzeContextAndPropose as analyzeContextAndProposeImpl,
	applyBacklogChanges as applyBacklogChangesImpl,
	runBacklogDecisionPrecheckActivity as runBacklogDecisionPrecheckActivityImpl,
} from "./backlog-context/analyze-context";
import { autoAnalyzeMeetingTranscriptActivity as autoAnalyzeMeetingTranscriptActivityImpl } from "./backlog-context/auto-analyze-meeting-transcript";
import { draftProposalBodyActivity as draftProposalBodyActivityImpl } from "./backlog-context/draft-proposal-body";
import {
	fetchDecisionsForBacklog as fetchDecisionsForBacklogImpl,
	fetchMeetingTranscript as fetchMeetingTranscriptImpl,
	fetchNotionPageContent as fetchNotionPageContentImpl,
	fetchSecurityFindingsForBacklog as fetchSecurityFindingsForBacklogImpl,
	fetchSlackMessagesForBacklog as fetchSlackMessagesForBacklogImpl,
	fetchTeamsMessagesForBacklog as fetchTeamsMessagesForBacklogImpl,
	listCalendarMeetings as listCalendarMeetingsImpl,
	retrieveProjectRagContext as retrieveProjectRagContextImpl,
} from "./backlog-context/fetch-context";
import { fetchApplicationLogsForBacklog as fetchApplicationLogsForBacklogImpl } from "./backlog-context/fetch-application-logs";
import { withOrganizationLogContext } from "./backlog-context/organization-context";

export {
	type AnalyzeContextInput,
	type ApplyBacklogChangesInput,
	type ApplyBacklogChangesResult,
	type ChangeProposal,
	ChangeProposalSchema,
	mapPriority,
	mapSize,
	type RunBacklogDecisionPrecheckInput,
} from "./backlog-context/analyze-context";
export const analyzeContextAndPropose = withOrganizationLogContext(
	analyzeContextAndProposeImpl,
);
export const applyBacklogChanges = withOrganizationLogContext(
	applyBacklogChangesImpl,
);
export const runBacklogDecisionPrecheckActivity = withOrganizationLogContext(
	runBacklogDecisionPrecheckActivityImpl,
);
// Auto-analyze monitored meeting transcript activity (capture-as-is → proposal)
export {
	type AutoAnalyzeMeetingTranscriptInput,
	type AutoAnalyzeMeetingTranscriptOutput,
	type MarkMeetingTranscriptAnalysisFailedInput,
	MEETING_CAPTURE_USER_PROMPT,
	markMeetingTranscriptAnalysisFailedActivity,
} from "./backlog-context/auto-analyze-meeting-transcript";
export const autoAnalyzeMeetingTranscriptActivity = withOrganizationLogContext(
	autoAnalyzeMeetingTranscriptActivityImpl,
);
// Persisted in-review proposal draft (one per proposal+kind, team-shared)
export type { DraftProposalBodyInput } from "./backlog-context/draft-proposal-body";
export const draftProposalBodyActivity = withOrganizationLogContext(
	draftProposalBodyActivityImpl,
);
export {
	type BacklogSnapshot,
	fetchBacklogSnapshot,
} from "./backlog-context/fetch-backlog-snapshot";
// Backlog Context activities (contextual backlog updater)
export type {
	CalendarMeeting,
	FetchMeetingTranscriptInput,
	FetchMeetingTranscriptOutput,
	FetchNotionPageContentInput,
	FetchNotionPageContentOutput,
	FetchSlackMessagesForBacklogInput,
	FetchSlackMessagesForBacklogOutput,
	FetchTeamsMessagesForBacklogInput,
	FetchTeamsMessagesForBacklogOutput,
	ListCalendarMeetingsInput,
	ListCalendarMeetingsOutput,
	RetrieveProjectRagContextInput,
	RetrieveProjectRagContextOutput,
} from "./backlog-context/fetch-context";
export const fetchDecisionsForBacklog = withOrganizationLogContext(
	fetchDecisionsForBacklogImpl,
);
export const fetchMeetingTranscript = withOrganizationLogContext(
	fetchMeetingTranscriptImpl,
);
export const fetchNotionPageContent = withOrganizationLogContext(
	fetchNotionPageContentImpl,
);
export const fetchSecurityFindingsForBacklog = withOrganizationLogContext(
	fetchSecurityFindingsForBacklogImpl,
);
export const fetchSlackMessagesForBacklog = withOrganizationLogContext(
	fetchSlackMessagesForBacklogImpl,
);
export const fetchTeamsMessagesForBacklog = withOrganizationLogContext(
	fetchTeamsMessagesForBacklogImpl,
);
export const listCalendarMeetings = withOrganizationLogContext(
	listCalendarMeetingsImpl,
);
export const retrieveProjectRagContext = withOrganizationLogContext(
	retrieveProjectRagContextImpl,
);
export type {
	FetchApplicationLogsInput,
	FetchApplicationLogsOutput,
} from "./backlog-context/fetch-application-logs";
export const fetchApplicationLogsForBacklog = withOrganizationLogContext(
	fetchApplicationLogsForBacklogImpl,
);
export * from "./browser-automation";
export * from "./chat-activities";
// Code-Based Project Setup activities (GitHub MCP + orchestrator → docs)
export * from "./code-based-setup";
// Code Indexing activities (Phase 2: AST-aware code indexing)
export {
	type ChunkAndEmbedBatchOutput,
	type CleanupCloneDirInput,
	type CloneRepositoryInput,
	type CloneRepositoryOutput,
	type CodeIndexBatchInput,
	checkCodeIndexingEnabledActivity,
	chunkAndEmbedBatchActivity,
	cleanupCloneDirActivity,
	cloneRepositoryActivity,
	deleteChangedCodeVectorsActivity,
	deleteProjectCodeSymbolsActivity,
	type ExtractAndPersistSymbolsInput,
	type ExtractSymbolsActivityInput,
	type ExtractSymbolsActivityOutput,
	extractAndPersistSymbolsActivity,
	extractSymbolsActivity,
	type FileManifestEntry,
	failCodeIndexActivity,
	type GenerateFileSummariesOutput,
	generateFileSummariesActivity,
	getCodeEmbeddingModelActivity,
	initCodeIndexActivity,
	type PersistCodeSymbolsInput,
	type PersistCodeSymbolsOutput,
	persistCodeSymbolsActivity,
	type ReadFileManifestSliceInput,
	type ResolveRepoTokenInput,
	type ResolveRepoTokenOutput,
	readFileManifestSliceActivity,
	resolveRepoTokenActivity,
	type ScanForSecretsInput,
	type ScanForSecretsOutput,
	type SelectChangedFilesFromManifestInput,
	type SelectChangedFilesFromManifestOutput,
	scanForSecretsActivity,
	selectChangedFilesFromManifestActivity,
	type UpdateCodeIndexInput,
	updateCodeIndexActivity,
	type WalkFileTreeInput,
	type WalkFileTreeOutput,
	walkFileTreeActivity,
} from "./code-indexing";
// Coding Run activities (implementation session execution)
export {
	type AddCodingRunEventInput,
	addCodingRunEventActivity,
	type BuildImplementationPromptInput,
	buildImplementationPrompt,
	type CancelExecutionSessionInput,
	type CreateCodingRunRecordInput,
	type CreateExecutionSessionInput,
	cancelExecutionSession,
	createCodingRunRecord,
	createExecutionSession,
	type PollBackgroundAgentStatusOutput,
	type PollExecutionStatusInput,
	pollExecutionStatus,
	type SendExecutionPromptInput,
	type SyncCodingRunArtifactsInput,
	sendExecutionPrompt,
	syncCodingRunArtifacts,
	type UpdateCodingRunStatusInput,
	updateCodingRunStatusActivity,
} from "./coding-run";
// Connector sync activities (data connections)
export {
	type ConnectorConfig,
	createSyncJobActivity,
	type Document as ConnectorDocument,
	discoverResources,
	fetchResourceDocuments,
	garbageCollect,
	generateEmbeddings,
	loadConnectorConfig,
	loadSyncCursor,
	type Resource as ConnectorResource,
	saveSyncCursor,
	scheduleNextSync,
	storeDocuments,
	testConnection,
	updateConnectorStatus,
	updateSyncJobActivity,
} from "./connector-sync";
// Context deletion activities (single context deletion for Notion pages, uploads, etc.)
export {
	type DeleteSingleContextInput,
	type DeleteSingleContextOutput,
	deleteSingleContextActivity,
} from "./context-deletion";
// Context embedding activities (single context embedding for Notion pages, uploads, etc.)
export {
	type EmbedSingleContextInput,
	type EmbedSingleContextOutput,
	embedSingleContextActivity,
} from "./context-embedding";
// Context Summarization activities (compressed project-history digests)
export * from "./context-summarization";
// Conversation-bundle embedding recovery (scheduled sweep over captured channel
// bundles whose embed failed or crashed — Fizzy #2228)
export {
	type SweepConversationBundleEmbeddingsInput,
	type SweepConversationBundleEmbeddingsOutput,
	sweepConversationBundleEmbeddingsActivity,
} from "./conversation-bundle-embedding-sweep";
// Daily Brief activities (cross-tool project digest)
export {
	AHEAD_LOOKAHEAD_HOURS,
	type CollectAheadInput,
	type CollectDocumentChangesInput,
	type CollectDocumentChangesOutput,
	type CollectGitHubPullRequestsActivityInput,
	type CollectGitHubPullRequestsActivityOutput,
	type CollectGitHubReleasesActivityInput,
	type CollectGitHubReleasesActivityOutput,
	type CollectMeetingTranscriptsInput,
	type CollectMeetingTranscriptsOutput,
	type CollectStoryActivityInput,
	type CollectStoryActivityOutput,
	type CollectTeamsProposalsInput,
	type CollectTeamsProposalsOutput,
	collectAhead,
	collectDocumentChanges,
	collectGitHubPullRequestsActivity,
	collectGitHubReleasesActivity,
	collectMeetingTranscripts,
	collectStoryActivity,
	collectTeamsProposals,
	type DetectPriorityActionsInput,
	type DetectPriorityActionsOutput,
	detectPriorityActionsActivity,
	type ExtractedInsights,
	type ExtractMeetingInsightsInput,
	type ExtractMeetingInsightsOutput,
	extractMeetingInsightsActivity,
	type GitHubRepoFailure,
	MEETING_INSIGHTS_VERSION,
	loadReleaseNoteExclusionsActivity,
	type PersistDailyBriefInput,
	persistDailyBriefActivity,
	type SummarizeDailyBriefInput,
	type SummarizeDailyBriefOutput,
	type SummarizeReleaseNotesInput,
	type SummarizeReleaseNotesOutput,
	shouldIncludeMeeting,
	summarizeDailyBriefActivity,
	summarizeReleaseNotesActivity,
} from "./daily-brief";
// Publishing Suggestion activities (Publishing Suite 1A — collectors, tenant
// assertion, summarizer, and the Task 9 persistence boundary).
export * from "./publishing-suggestion";
// Planning & Analysis activities (Publishing Suite 2A-2 — the topic worksheet's
// generator and its failure marker).
export * from "./publishing-blog-post";
export * from "./publishing-planning";
export * from "./publishing-short-post";
// Deep Researcher activities (parallel sub-agent research workflow)
export * from "./deep-researcher";
// Deep Researcher activities (parallel sub-agent research coordination)
export {
	type AggregateResultsInput,
	type AggregateResultsOutput,
	type AnalyzeComplexityInput,
	type AnalyzeComplexityOutput,
	aggregateResults,
	analyzeComplexity,
	type CheckClarificationInput,
	type CheckClarificationOutput,
	checkClarificationNeeded,
	type DecomposeTaskInput,
	type DecomposeTaskOutput,
	decomposeTask,
	type EvaluateSuccessInput,
	type EvaluateSuccessOutput,
	type ExecuteDirectResearchInput,
	type ExecuteDirectResearchOutput,
	type ExecuteSubAgentInput,
	type ExecuteSubAgentOutput,
	evaluateSuccess,
	executeDirectResearch,
	executeSubAgent,
	type RefineSubTasksInput,
	type RefineSubTasksOutput,
	refineSubTasks,
} from "./deep-researcher";
// Deployment execution activities (Temporal-native agent execution)
export {
	buildExecutionContext,
	completeExecution,
	type DeploymentConfig as DeploymentExecutionConfig,
	type ExecutionContext,
	fetchKnowledge,
	type InvokeAgentResult,
	invokeDeploymentAgent,
	loadConversationHistory,
	loadDeploymentConfiguration,
	saveConversationMessages,
	signalSupervisorCompletion,
} from "./deployment-execution";
export * from "./direct-chat";
export * from "./document-eval";
export * from "./document-processing";
// Living Documents auto-refresh activities (hourly sweep + per-document refresh)
export {
	dispatchDocumentRefreshActivity,
	findDueDocumentsActivity,
	runDocumentRefreshActivity,
} from "./document-refresh";
// Draft project cleanup activities (daily cron sweeping abandoned wizard DRAFTs)
export {
	type CleanupAbandonedDraftsInput,
	type CleanupAbandonedDraftsOutput,
	cleanupAbandonedDraftsActivity,
	type DraftProjectCandidate,
	findAbandonedDrafts,
	type InFlightLinkRow,
} from "./draft-project-cleanup";
// Automatic semantic duplicate detection (run by the detectDuplicates workflow)
export {
	type DetectDuplicateStoriesParams,
	type DetectDuplicateStoriesResult,
	detectDuplicateStoriesActivity,
} from "./duplicate-detection";
// Evidence report generation activities
export {
	type GenerateEvidenceReportInput,
	type GenerateEvidenceReportOutput,
	generateEvidenceReport,
} from "./evidence";
// Existing Project Setup activities (multi-repo + backlog ingest + sequential doc gen)
export {
	type AppendAnalysisContentChunkInput,
	appendAnalysisContentChunk,
	type CreateAnalysisContextRecordInput,
	type CreateAnalysisContextRecordOutput,
	type CreateExistingProjectDocumentRecordsInput,
	type CreateExistingProjectDocumentRecordsOutput,
	createAnalysisContextRecord,
	createExistingProjectDocumentRecords,
	type EmbedCodeAnalysisContextInput,
	embedCodeAnalysisContext,
	type IngestBacklogForRAGInput,
	type IngestBacklogForRAGOutput,
	ingestBacklogForRAG,
	type UpdateProjectRagSettingsInput,
	updateProjectRagSettings,
} from "./existing-project-setup";
// Fabric AI activities (https://github.com/Fabric-Pro/fabric-ai)
export {
	type AnalyzeYouTubeVideoInput,
	type AnalyzeYouTubeVideoOutput,
	analyzeYouTubeVideo,
	checkFabricHealth,
	type ExecuteFabricPatternInput,
	type ExecuteFabricPatternOutput,
	type ExtractYouTubeTranscriptInput,
	type ExtractYouTubeTranscriptOutput,
	executeFabricPattern,
	extractYouTubeTranscript,
	fabricAiActivities,
	type ListContextsOutput,
	// Strategy and context types
	type ListStrategiesOutput,
	listContextsActivity,
	listFabricPatternsActivity,
	// Strategies and contexts
	listStrategiesActivity,
	type ScrapeAndAnalyzeInput,
	type ScrapeAndAnalyzeOutput,
	// Web scraping and search types
	type ScrapeUrlInput,
	type ScrapeUrlOutput,
	type SearchAndAnalyzeInput,
	type SearchAndAnalyzeOutput,
	type SearchWebInput,
	type SearchWebOutput,
	scrapeAndAnalyzeActivity,
	// Web scraping and search
	scrapeUrlActivity,
	searchAndAnalyzeActivity,
	searchWebActivity,
	type TranscribeAndAnalyzeInput,
	type TranscribeAndAnalyzeOutput,
	type TranscribeAudioInput,
	type TranscribeAudioOutput,
	transcribeAndAnalyzeActivity,
	transcribeAudioActivity,
} from "./fabric-ai";
export * from "./fabric-mention-comments";
export * from "./fizzy-activities";
// Frame Export activities (PDF generation).
//
// The unsuffixed aliases are the activity type names `exportFrameToPDF` has
// scheduled since it shipped — see the comment on `FrameExportProxies` in
// `workflows/frame-export.ts`. Without them the worker registers nothing that
// workflow asks for and every frame export fails; with them the historical
// names resolve, so no scheduled command has to change. Do not remove them
// while histories that recorded those names can still be replayed.
export {
	generatePDFActivity,
	generatePDFActivity as generatePDF,
	getFrameContentActivity,
	getFrameContentActivity as getFrameContent,
	uploadToS3Activity,
	uploadToS3Activity as uploadToS3,
} from "./frame-export";
// Goal-oriented agent activities (iterative goal achievement)
export {
	attemptStepRecovery,
	type CompleteGoalInput,
	type CreateGoalOrientedPlanInput,
	type CreateGoalOrientedPlanOutput,
	completeGoalExecution,
	createGoalOrientedPlan,
	type ExecuteGoalStepInput,
	type ExecuteGoalStepOutput,
	executeGoalStep,
	type RecoveryInput,
	type RecoveryOutput,
	type VerifyGoalInput,
	verifyGoalAchievement,
} from "./goal-oriented-agent";
// Letta memory activities
export {
	cacheToolResult,
	getCachedToolResult,
	getCachedToolsSummary,
	getRoutingSuggestions,
	getRoutingSuggestions as getLettaRoutingSuggestions,
	initializeLettaMemory,
	recordExecution,
	recordExecution as recordLettaExecution,
} from "./letta-memory-activities";
// Letta security utilities
export {
	checkLettaRateLimit,
	LETTA_RATE_LIMITS,
	type LettaSecurityContext,
	LettaSecurityError,
	type LettaSecurityErrorCode,
	logSecurityEvent,
	MAX_CACHE_ENTRIES,
	MAX_CACHE_ENTRY_SIZE,
	MAX_MEMORY_BLOCK_SIZE,
	type SecurityValidationResult,
	sanitizeToolResult,
	validateLettaOperation,
	validateMemoryBlockContent,
	verifyAgentIdentity,
	verifyLettaAgentOwnership,
} from "./letta-security";
export * from "./mcp-activities";
// MCP Tool Ingestion activities
export {
	type DeleteMcpToolsInput,
	type DeleteMcpToolsOutput,
	deleteMcpToolsActivity,
	type IngestAllMcpServersInput,
	type IngestAllMcpServersOutput,
	type IngestAllMcpToolsInput,
	type IngestAllMcpToolsOutput,
	// MCP Server Ingestion activities (Phase 1: semantic routing)
	type IngestMcpServerInput,
	type IngestMcpServerOutput,
	type IngestMcpToolsInput,
	type IngestMcpToolsOutput,
	ingestAllMcpServersActivity,
	ingestAllMcpToolsActivity,
	ingestMcpServerActivity,
	ingestMcpToolsActivity,
} from "./mcp-tool-ingestion";
// Meeting Transcript sync activities (auto-sync Teams meeting transcripts as project context)
export {
	type CheckTranscriptAlreadySyncedInput,
	checkTranscriptAlreadySynced,
	type FetchAndStoreMeetingTranscriptInput,
	type FetchAndStoreMeetingTranscriptOutput,
	fetchAndStoreMeetingTranscript,
	type GetLinkedMeetingJoinUrlsInput,
	getLinkedMeetingJoinUrlsActivity,
	type LinkedMeetingJoinUrl,
	type ListRecentMeetingInstancesInput,
	listRecentMeetingInstancesForLinkedUrls,
	type MeetingInstance,
	type UpdateMeetingTranscriptSyncLastRunInput,
	updateMeetingTranscriptSyncLastRunActivity,
} from "./meeting-transcript-sync";
// Meeting Agenda activities (#1901 — pre-meeting agenda generation)
export * from "./meeting-agenda";
// Meeting Digest activities (#1902 — action item to work item linking)
export * from "./meeting-digest";
// Member cascade delete activities (cleanup when user removed from org)
export {
	clearUserOrgSessionsActivity,
	deleteUserAgentTemplateInstancesInOrgActivity,
	deleteUserChatsInOrgActivity,
	deleteUserMcpConfigsInOrgActivity,
	deleteUserProjectsInOrgActivity,
	deleteUserWorkflowsInOrgActivity,
	deleteUserWorkspacesInOrgActivity,
	type MemberCascadeDeleteInput,
	type MemberCascadeDeleteOutput,
	removeUserProjectMembershipsInOrgActivity,
	removeUserWorkspaceMembershipsInOrgActivity,
} from "./member-cascade-delete";
// Monitoring activities
export {
	type CloseIntegrationIncidentInput,
	type CloseIntegrationIncidentOutput,
	closeIntegrationIncident,
	type DispatchProjectServiceAlertDigestInput,
	type DispatchProjectServiceAlertDigestOutput,
	type DispatchWeeklyDigestInput,
	type DispatchWeeklyDigestOutput,
	dispatchProjectServiceAlertDigestActivity,
	dispatchWeeklyDigestActivity,
	type GetProviderRegistrationInput,
	getProviderRegistration,
	type IncidentDetectionMethod,
	type IncidentEventType,
	type IncidentKind,
	type IncidentSeverity,
	type IncidentStatus,
	type ListProviderRegistryInput,
	listProviderRegistry,
	type MarkProviderNotConfiguredInput,
	type MarkProviderNotConfiguredOutput,
	markProviderNotConfigured,
	type NotifyIncidentInput,
	type NotifyIncidentOutput,
	notifyIncident,
	type PollStatusPageInput,
	type PollStatusPageOpenIncident,
	type PollStatusPageOutput,
	type ProviderHealthStatus,
	type ProviderRegistrySerializable,
	type PruneIncidentsInput,
	type PruneIncidentsOutput,
	pollStatusPage,
	pruneIncidents,
	runSyntheticProbe,
	type DispatchStatusAnnouncementNotificationsActivityOutput,
	type DispatchStatusAnnouncementNotificationsInput,
	dispatchStatusAnnouncementNotificationsActivity,
	type SyntheticProbeOutput,
	type SyntheticProbeProviderKey,
	type UpsertIntegrationIncidentInput,
	type UpsertIntegrationIncidentOutput,
	upsertIntegrationIncident,
} from "./monitoring";
// Newsletter activities (external release-notes newsletter)
export {
	curateNewsletterFromReleasesActivity,
	curateStakeholderReleaseNotesActivity,
	dispatchNewsletterSendActivity,
	finalizeNewsletterSendActivity,
	findDueNewsletterProjectsActivity,
	holdNewsletterForApprovalActivity,
	loadActiveSubscribersActivity,
	loadApprovedNewsletterSendActivity,
	sendNewsletterApprovalChatMessagesActivity,
	sendNewsletterApprovalEmailsActivity,
	sendNewsletterChatMessagesActivity,
	sendNewsletterEmailsActivity,
} from "./newsletter";
// Notification external-delivery activities (email + webhook fan-out)
export {
	buildWebhookPayload,
	type DeliveryOutcome,
	type NotificationDeliveryActivityInput,
	sendNotificationEmailActivity,
	sendNotificationWebhookActivity,
} from "./notifications";
// Notion PRD sync activities (sync Notion page as PRD source)
// OAuth Tool Ingestion activities
export {
	// OAuth Server Ingestion activities (Phase 1: semantic routing)
	type IngestOAuthServerInput,
	type IngestOAuthServerOutput,
	type IngestOAuthToolsInput,
	type IngestOAuthToolsOutput,
	ingestOAuthIntegrationToolsActivity,
	ingestOAuthServerActivity,
} from "./oauth-tool-ingestion";
// Orchestrator activities - explicitly re-export to avoid conflicts
// Now using modular structure from ./orchestrator instead of monolithic orchestrator-activities.ts
export {
	// Iterative Agent Execution
	type AgentIterationResult,
	type AgentToolCall,
	// Intent-clarity (HITL clarifying question before planning)
	type AnalyzeIntentClarityInput,
	type AnalyzeIntentClarityResult,
	analyzeAndRoute,
	analyzeIntentClarityActivity,
	// Trust-based approval activities (Phase 3)
	analyzePlanApprovalActivity,
	// Plan Adaptation
	analyzePlanModificationActivity,
	// Fabric AI Pattern Enrichment (Strategy → Context → Pattern)
	applyFabricPatternEnrichment,
	applyPolicyEnrichment,
	// Tool Call Risk Assessment
	assessToolCallRisk,
	autoWireStepsActivity,
	type CheckStepAuthorityInput,
	type CheckStepAuthorityOutput,
	// Conversation Compaction (mid-execution history summarization)
	type CompactConversationInput,
	type CompactConversationResult,
	checkContextBudgetActivity,
	// Runtime authority check (Pipes-style authorization)
	approveAuthoritySessionActivity,
	checkStepAuthorityActivity,
	denyAuthoritySessionActivity,
	checkStepAutoApprovalActivity,
	// Recovery Management (Phase 2.3)
	classifyFailureActivity,
	compactConversationHistoryActivity,
	createOrchestratorApprovalRequest,
	createTaskPlan,
	// Default-MCP routing — registry list activity (drives keyword scan)
	type DefaultEnabledMcpServerEntry,
	type DelegateToAgentInput,
	type DelegateToAgentOutput,
	delegateToAgent,
	detectOperationType,
	detectUserIntent,
	estimateStepTokensActivity,
	executeAgentAsTool,
	executeDatabricksKnowledgeSearchActivity,
	executeMcpTool,
	executeStep,
	type FabricPatternEnrichmentInput,
	type FabricPatternEnrichmentOutput,
	// Default-MCP routing — config lookup activity. The `findExcalidraw…`
	// alias is preserved for replay-compat against pre-rename histories.
	type FindDefaultMcpConfigArgs,
	type FindDefaultMcpConfigResult,
	fetchToolsFromServerIds,
	findDefaultMcpConfigActivity,
	findExcalidrawConfigActivity,
	findSimilarTrajectory,
	type GenericVerificationInput,
	type GenericVerificationResult,
	getApprovalStatus as getOrchestratorApprovalStatus,
	getRetryDelayActivity,
	getTrustConfigActivity,
	// Step I/O Contracts (Phase 4.2)
	inferAndValidateContractsActivity,
	listDefaultEnabledMcpServersActivity,
	listFabricComponents,
	// Resource Preloading (Performance Optimization)
	loadInstanceMemoryActivity,
	preloadMcpToolsForConfigsActivity,
	preloadResourcesActivity,
	// Publishes MCP default-tool analytics signals to the SSE pipeline
	// via Redis pub/sub.
	publishMcpDefaultToolSignalActivity,
	type ResolvedAgent,
	type RunAgentIterationInput,
	recordApprovalOutcomeActivity,
	reflectOnOutput,
	// Agent delegation activities (A2A protocol)
	resolveAgentEndpoint,
	// Workspace document retrieval
	retrieveWorkspaceDocumentsActivity,
	runAgentIteration,
	saveTrajectory,
	// Tool, Agent & Integration Discovery (semantic search)
	searchAvailableAgents,
	searchAvailableIntegrations,
	searchAvailableTools,
	shouldRetryActivity,
	shouldSearchIntegrations,
	// Context Summarization (Phase 4.3)
	summarizeContextActivity,
	// Large Tool Result Summarization
	summarizeLargeToolResult,
	// Context Synthesis
	synthesizeContext,
	type ToolCallRiskAssessment,
	triggerWorkflow,
	updateApprovalTaskStatus,
	updateExecutionProgress,
	// Plan validation (Phase 2)
	validatePlan,
	validateWithALTK,
	// Operation verification (generic)
	verifyOperation,
} from "./orchestrator";
export * from "./orchestrator-memory";
// Orchestrator memory activities (Qdrant-based semantic memory)
export {
	embedAndStoreTrajectory,
	getHybridRoutingSuggestions,
	searchSemanticMemory,
} from "./orchestrator-memory-activities";
// PM Integration - Bulk-sync conflict guard (detect via preview, then stamp CONFLICT)
export { detectAndStampPmPushConflict } from "./pm-integration/detect-pm-push-conflict";
// PM Integration - Custom field read-mapping enumeration + preview
export {
	type EnumeratePmFieldsInput,
	type EnumeratePmFieldsResult,
	enumeratePmFields,
} from "./pm-integration/enumerate-pm-fields";
// PM Integration - Fetch PM hierarchy (epics, features, stories from PM tool)
export {
	detectAdoWorkItemTypes,
	type FetchPMHierarchyInput,
	fetchPMWorkItemsByType,
	type PMHierarchyResult,
} from "./pm-integration/fetch-pm-hierarchy";
// PM Integration - Hierarchy sync (epic, feature, story sync to PM tool)
export {
	type SyncWorkItemInput,
	type SyncWorkItemResult,
	syncWorkItemToPM,
	type WorkItemType,
} from "./pm-integration/hierarchy-sync";
// PM Integration - ADO State Polling activities
export {
	type FetchAdoWorkItemStatesInput,
	fetchAdoWorkItemStates,
	getAdoActiveProjects,
	type PmActiveProject,
	type PmWorkItemState,
	type ReconcileAdoStatesInput,
	type ReconcileAdoStatesResult,
	reconcileAdoStates,
	reconcileMissingTickets,
	updateProjectPollTimestamp,
} from "./pm-integration/pm-state-poll";
// PM Integration - ADO State Poll Activation
export { activateAdoStatePoll } from "./pm-integration/pm-state-poll-activation";
export {
	type PreviewPmFieldValue,
	type PreviewPmFieldValuesInput,
	type PreviewPmFieldValuesResult,
	previewPmFieldValues,
} from "./pm-integration/preview-pm-field-values";
// PM Integration - Conflict preview (read-only sibling of syncWorkItemToPM)
export {
	type PreviewPmSyncConflictInput,
	type PreviewPmSyncConflictResult,
	previewPmSyncConflict,
} from "./pm-integration/preview-pm-sync-conflict";
// PM Integration - Sync audit-log write helper (one row per sync outcome)
export {
	type RecordPmSyncLogInput,
	recordPmSyncLog,
} from "./pm-integration/record-pm-sync-log";
// PM Integration - Sync state recording activities (used by workflow catch path)
export {
	clearPmSyncPendingIfLeaked,
	type RecordPmSyncFailureInput,
	recordPmSyncFailure,
} from "./pm-integration/record-pm-sync-state";
// PM Integration - Server-side apply/proposal PM-config resolution (per-user + REST fallback)
export {
	type ResolveApplyPmConfigInput,
	type ResolveApplyPmConfigResult,
	resolveApplyPmConfig,
} from "./pm-integration/resolve-apply-pm-config";
// PM Integration activities (dynamic PM tool sync)
export {
	createOrUpdateStoryFromPMItem,
	deleteStoriesNotInPMList,
	discoverPMToolCapabilities,
	fetchPMItemsByIds,
	getPMToolCapabilities,
	getStoriesToSync,
	listAllFizzyCards,
	listWorkItemsFromPM,
	searchWorkItemsFromPM,
	syncBulkStoriesToPM,
	syncStoryToPM,
	syncTaskToPM,
	updateStoryExternalRefs,
} from "./pm-integration/story-sync";
// PM Integration - Test case sync activities (QA feature)
export {
	createOrUpdateTestCaseFromPMItem,
	getTestCasesToSync,
	updateTestCaseExternalRefs,
} from "./pm-integration/test-case-sync";
// PM Integration - Test case EXECUTION result push (deferred). Proxied by
// `testCaseSyncWorkflow` behind `patched("test-case-execution-sync-v1")`.
export { pushTestCaseExecutionToPM } from "./pm-integration/test-execution-sync";
// QA pipeline-results sync (cards 1834/1688) — the live "pull" from connected CI
// (ADO Test Runs) into the ingestion engine + RCA→BUG. Proxied by
// `syncPipelineResultsWorkflow`.
export { syncPipelineResultsForProject } from "./pipeline-results/sync-pipeline-results";
// Enumeration for the scheduled sweep — who to sync when nobody pressed a button.
export {
	listProjectsDueForPipelineSyncActivity,
	type ProjectDueForPipelineSync,
	reapStaleAgenticRunsActivity,
} from "./pipeline-results/list-projects-due-for-sync";
// Fabric-orchestrated test runs — the "run" verb. The browser half drives one
// case; the lifecycle half resolves what to run and records the outcome through
// the SAME ingestion helpers CI results use.
export {
	type AgenticStepResult,
	type RunAgenticCaseInput,
	type RunAgenticCaseResult,
	runAgenticCase,
} from "./qa-agentic-run/run-case";
export {
	type RunScriptedCaseInput,
	runScriptedCase,
} from "./qa-agentic-run/run-scripted-case";
export {
	AGENTIC_RUN_BATCH_SIZE,
	loadStagedAgenticBatches,
	stageAgenticBatch,
} from "./qa-agentic-run/run-batching";
export {
	persistAgenticRun,
	prepareAgenticRun,
	recordAgenticCaseProgressActivity,
} from "./qa-agentic-run/run-lifecycle";
// Durable AI test-case drafting — the billable per-feature step, plus the
// ledger bookends its workflow drives.
export {
	type DraftTestCasesForFeatureInput,
	type DraftTestCasesForFeatureResult,
	draftTestCasesForFeature,
} from "./test-cases/draft-test-cases-for-feature";
export {
	beginTestCaseDraftJob,
	finalizeTestCaseDraftJob,
	recordTestCaseDraftOutcome,
} from "./test-cases/test-case-draft-job";
// PM Sync Log retention activity (opt-in, gated by FABRIC_PM_SYNC_LOG_RETENTION_ENABLED)
export { purgeExpiredPmSyncLogRowsActivity } from "./pm-sync-log-retention";
// Operation-result chat message activity (#1412 — wired into completion
// phases by PR2; unused-but-registered in PR1 so the worker bundle is
// ready when the workflow callers ship).
export {
	type PostOperationResultInput,
	type PostOperationResultOutput,
	postOperationResultActivity,
} from "./post-operation-result";
export * from "./preflight-validation";
export * from "./project-context-embedding";
// Project context processing activities (post-creation uploads)
export {
	getProjectContextStatus,
	processProjectContext,
	retryProjectContext,
	updateProjectContextStatus,
} from "./project-context-processing";
export * from "./project-contexts-reprocess";
// Project deletion activities (soft delete, permanent delete, cleanup)
export {
	captureProjectDocumentIdsActivity,
	type DeleteProjectAttachmentsFromStorageInput,
	type DeleteProjectAttachmentsFromStorageOutput,
	type DeleteProjectFromQdrantInput,
	type DeleteProjectFromQdrantOutput,
	deleteProjectAttachmentsFromStorageActivity,
	deleteProjectDocumentBlobsFromStorageActivity,
	deleteProjectFromQdrantActivity,
	type ExpiredProject,
	type GetExpiredProjectsInput,
	getExpiredProjectsActivity,
	getProjectsNeedingReminderActivity,
	type PermanentDeleteProjectFromDbInput,
	type PermanentDeleteProjectFromDbOutput,
	type ProjectNeedingReminder,
	permanentDeleteProjectFromDbActivity,
	type SendProjectDeletionReminderInput,
	type SendProjectDeletionReminderOutput,
	sendProjectDeletionReminderActivity,
} from "./project-deletion";
export * from "./project-document-generation";
// Project metadata activities (orchestrator project context injection)
export {
	getProjectMetadataActivity,
	retrieveProjectContextsActivity,
} from "./project-metadata";
export * from "./prompt-activities";
export * from "./rag-activities";
// Repository Integration Health Check activities (token validation, refresh, PAT check)
export {
	type CheckIntegrationHealthInput,
	type CheckIntegrationHealthOutput,
	checkRepoIntegrationHealth,
	type FetchActiveIntegrationsOutput,
	fetchActiveRepoIntegrations,
	type LogRepoContextAccessedInput,
	logRepoContextAccessedActivity,
	type ValidatePatInput,
	type ValidatePatOutput,
	validateAzureDevOpsPat,
} from "./repo-health-check";
export { purgeExpiredConversationsActivity } from "./conversation-retention";
export { purgeExpiredRequestSpansActivity } from "./request-span-retention";
// Sandbox activities (Cloudflare Sandbox for code execution)
export {
	type CommitInput,
	type CreateSandboxSessionInput,
	commitInSandbox,
	createSandboxSession,
	destroySandboxSession,
	type ExecInput,
	execInSandbox,
	executeCodeChangeWorkflow,
	type FileInput,
	finalizeCodeChanges,
	getSandboxDiff,
	type PushInput,
	pushFromSandbox,
	type RunClaudeInput,
	readSandboxFile,
	runClaudeInSandbox,
	type SandboxSessionContext,
	type WriteFileInput,
	writeSandboxFile,
} from "./sandbox";
// Schedule trigger activities (for Temporal scheduled executions)
export { signalSupervisorForScheduledExecution } from "./schedule-trigger";
// Scheduled report activities (fire due report instances on a 15-min Temporal Schedule)
export {
	dispatchScheduledReportActivity,
	findDueReportInstancesActivity,
	reconcileScheduledReportInstancesActivity,
} from "./scheduled-report";
// Search Project Slack Messages (Slack parity with Teams)
export {
	checkProjectHasSlackIntegration,
	type FetchRecentSlackMessagesInput,
	type FetchRecentSlackMessagesResult,
	fetchRecentSlackMessages,
	SEARCH_SLACK_MESSAGES_TOOL_DEFINITION,
	type SearchProjectSlackMessagesInput,
	type SearchProjectSlackMessagesResult,
	type SlackSearchMessage,
	searchProjectSlackMessages,
} from "./search-project-slack-messages";
export {
	checkProjectHasTeamsIntegration,
	type FetchRecentTeamsMessagesInput,
	type FetchRecentTeamsMessagesResult,
	fetchRecentTeamsMessages,
	type SearchProjectTeamsMessagesInput,
	type SearchProjectTeamsMessagesResult,
	searchProjectTeamsMessages,
	type TeamsSearchMessage,
} from "./search-project-teams-messages";
export {
	createFirstClassFrame,
	getFirstClassFrame,
	listFirstClassFrames,
	shareFirstClassFrame,
	updateFirstClassFrame,
} from "./shared/frame-service";
// Agent Skills tool dispatch (for list_skills / load_skill / read_skill_file)
export {
	type ExecuteSkillToolInput,
	type ExecuteSkillToolOutput,
	executeSkillToolActivity,
} from "./skill-tool-execution";
// Slack Channel Monitor activities (event-driven ingestion from linked Slack channels)
export {
	type AnalyzeSlackThreadInput,
	type AnalyzeSlackThreadOutput,
	analyzeSlackThreadActivity,
	type BackfillSlackChannelInput,
	type BackfillSlackChannelOutput,
	backfillSlackChannelActivity,
	type FetchSlackThreadContextInput,
	type FetchSlackThreadContextOutput,
	fetchSlackThreadContextActivity,
	formatSlackThreadForBacklog,
	type GetLinkedHuddleChannelsInput,
	getLinkedHuddleChannelsActivity,
	type IngestHuddleNotesForChannelInput,
	type IngestHuddleNotesForChannelOutput,
	ingestHuddleNotesForChannelActivity,
	type LinkedHuddleChannel,
	type RecordSlackChannelFailureForKeyInput,
	type RecordSlackChannelFailureInput,
	recordSlackChannelFailureActivity,
	recordSlackChannelFailureForKeyActivity,
	type SlackThreadMessage,
	type UpdateSlackChannelCursorInput,
	type UpdateSlackChannelMonitorLastRunInput,
	type UpdateSlackHuddleIngestLastRunInput,
	updateSlackChannelCursorActivity,
	updateSlackChannelMonitorLastRunActivity,
	updateSlackHuddleIngestLastRunActivity,
} from "./slack-channel-monitor";
// Work-item body regeneration after a BUG <-> FEATURE conversion (Fizzy #2048)
export {
	type CloseRegenerationJobInput,
	type CloseRegenerationJobStatus,
	closeRegenerationJobActivity,
} from "./stories/close-regeneration-job";
export {
	type RegenerateBodyForKindInput,
	type RegenerateBodyForKindResult,
	type RegenerateBodyForKindStatus,
	regenerateBodyForKindActivity,
} from "./stories/regenerate-body-for-kind";
// Task Agent activities (Weft-style agent execution for story tasks)
export {
	type AddWorkflowLogInput,
	type AgentMessage,
	addWorkflowLog,
	type BroadcastProgressInput,
	broadcastProgress,
	type ExecuteAgentTurnInput,
	type ExecuteAgentTurnOutput,
	type ExecuteMcpToolInput,
	executeAgentTurn,
	executeTaskAgentTool,
	formatLiveUrlSourcesForPrompt,
	type GatherLiveUrlSourcesInput,
	gatherLiveUrlSources,
	type InitializeWorkflowPlanInput,
	initializeWorkflowPlan,
	type LiveUrlContent,
	type LiveUrlContentMode,
	type LoadMcpConfigurationInput,
	loadMcpConfiguration,
	type MCPConfiguration,
	type UpdateWorkflowPlanInput,
	updateWorkflowPlan,
} from "./task-agent";
// Teams Channel Monitor activities (scheduled poll of linked Teams channels for backlog proposals)
export {
	type AnalyzeChannelThreadInput,
	type AnalyzeChannelThreadOutput,
	analyzeChannelThreadActivity,
	type ClearTeamsChannelFailureInput,
	clearTeamsChannelFailureActivity,
	type FetchedThread,
	type FetchedThreadReply,
	type FetchNewChannelThreadsInput,
	type FetchNewChannelThreadsOutput,
	fetchNewChannelThreadsActivity,
	finalizePendingProposalActivity,
	formatTeamsThreadForBacklog,
	type GetLinkedChannelsForMonitorInput,
	getLinkedChannelsForMonitorActivity,
	type LinkedChannelForMonitor,
	type RecordTeamsChannelFailureInput,
	recordTeamsChannelFailureActivity,
	setTeamsChannelScanPageTokenActivity,
	type UpdateTeamsChannelMonitorLastRunInput,
	updateTeamsChannelCursorActivity,
	updateTeamsChannelMonitorLastRunActivity,
} from "./teams-channel-monitor";
// Teams Chat Monitor activities (scheduled poll of linked Teams group chats for backlog proposals)
export {
	type AnalyzeChatThreadInput,
	type AnalyzeChatThreadOutput,
	analyzeChatThreadActivity,
	type ClearTeamsChatFailureInput,
	clearTeamsChatFailureActivity,
	type FetchedChatMessage,
	type FetchedChatThread,
	type FetchNewChatThreadsInput,
	type FetchNewChatThreadsOutput,
	fetchNewChatThreadsActivity,
	formatTeamsChatThreadForBacklog,
	type GetLinkedChatsForMonitorInput,
	getLinkedChatsForMonitorActivity,
	type LinkedChatForMonitor,
	type RecordTeamsChatFailureInput,
	recordTeamsChatFailureActivity,
	setTeamsChatScanPageTokenActivity,
	type UpdateTeamsChatMonitorLastRunInput,
	updateTeamsChatCursorActivity,
	updateTeamsChatMonitorLastRunActivity,
} from "./teams-chat-monitor";
// Teams Mention activities
export {
	loadTeamsThreadMapping,
	postToTeams,
	saveTeamsThreadMappingContext,
	upsertTeamsThreadMapping,
} from "./teams-mention";
// Template Instance activities (replaces legacy report-generation)
export {
	emitReportExecutionNotification,
	executeAgentDataGatheringLoop,
	executeInstanceAiAnalysis,
	fetchInstanceDataSources,
	fetchReportTemplateSkills,
	fetchTemplateInstanceWithTemplate,
	indexInstanceArtifactForRag,
	renderInstanceReport,
	resolveReportConnections,
	sendReportExecutionEmail,
	storeInstanceArtifact,
	templateInstanceActivities,
	updateInstanceExecutionStatus,
} from "./template-instance";
// Template Instance data fetching (handler-based with RAG support)
export {
	cleanupRagCollection,
	executeAiAnalysis,
	fetchDataSources,
} from "./template-instance/data-fetching";
export * from "./title-activities";
// Trigger System activities (webhooks, schedules, Slack mentions)
export * from "./trigger-system/index";
// URL Context Sources activities (Firecrawl scrape/crawl + per-page upsert/embed + schedule reconciliation)
export {
	type BulkInitUrlPagesActivityInput,
	type BulkInitUrlPagesActivityOutput,
	bulkInitUrlPagesActivity,
	type EmbedUrlPageActivityInput,
	type EmbedUrlPageActivityOutput,
	embedUrlPageActivity,
	type FirecrawlCrawlActivityInput,
	type FirecrawlCrawlActivityOutput,
	type FirecrawlMapActivityInput,
	type FirecrawlMapActivityOutput,
	type FirecrawlScrapeActivityInput,
	type FirecrawlScrapeActivityOutput,
	firecrawlCrawlActivity,
	firecrawlMapActivity,
	firecrawlScrapeActivity,
	type PruneOrphanUrlPagesActivityInput,
	type PruneOrphanUrlPagesActivityOutput,
	pruneOrphanUrlPagesActivity,
	type ReconcileUrlSourceSchedulesActivityInput,
	type ReconcileUrlSourceSchedulesActivityOutput,
	reconcileUrlSourceSchedulesActivity,
	type UpdateParentStatusActivityInput,
	type UpdateParentStatusActivityOutput,
	type UpsertUrlPageActivityInput,
	type UpsertUrlPageActivityOutput,
	updateParentStatusActivity,
	upsertUrlPageActivity,
} from "./url-source";
// Weave activities (database, sandbox, utilities — orchestration handled by Fabric Loom)
export * from "./weave";
// Wizard cleanup activities
export {
	type CleanupWizardTempContextsInput,
	type CleanupWizardTempContextsOutput,
	cleanupWizardTempContextsActivity,
} from "./wizard-cleanup";
// Wizard context embedding activities
export {
	type ChunkedWizardContext,
	chunkWizardContextContent,
	generateWizardContextEmbeddings,
	getWizardTempContextsForEmbedding,
	storeWizardContextsInQdrant,
	updateWizardContextEmbeddingStatus,
	type WizardContextForEmbedding,
} from "./wizard-context-embedding";
// Wizard context processing activities (unified pipeline)
export {
	processWizardTempContext,
	retryWizardTempContext,
	updateWizardContextStatus,
} from "./wizard-context-processing";
// Wizard to project binding activities
export {
	type BindWizardEmbeddingsInput,
	type BindWizardEmbeddingsOutput,
	bindWizardEmbeddingsToProjectActivity,
} from "./wizard-to-project-binding";
export * from "./workflow-builder-execution";
export * from "./workflow-builder-reconcile-schedules";
export * from "./workflow-schedule-kickoff";

// Workspace document activities

// Health-probe eligibility (shared between the monitor and the manual health-check procedure)
export { isProbeableAgent } from "../lib/agent-probeable";
// Agent URL resolution utility (shared between orchestrator delegation and health-check procedures)
export { resolveAgentUrl } from "../lib/agent-url-resolver";
// Security & Accessibility scanning activities
export * from "./ai-cost-reconciliation";
export * from "./security-scan";
export {
	deleteWorkspaceDocumentFromQdrant,
	processWorkspaceDocument,
	reprocessWorkspaceDocument,
	updateWorkspaceDocumentStatus,
} from "./workspace-document-activities";
