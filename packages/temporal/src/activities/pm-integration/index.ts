/**
 * PM Integration Module
 *
 * Dynamic project management tool integration that works with any MCP server.
 * Uses tool schema introspection instead of hardcoded provider logic.
 */

// Field-mapping suggestion driven by the work item form definition
export {
	type AdoFormField,
	mergeAdoFormMetadata,
	parseAdoFormMetadata,
} from "./ado-form-metadata";
export {
	type ComposePmFieldPreviewInput,
	type ComposePmFieldPreviewResult,
	composePmFieldPreview,
} from "./compose-pm-field-preview";
// Field read-mapping enumeration
export {
	type EnumeratePmFieldsInput,
	type EnumeratePmFieldsResult,
	enumeratePmFields,
} from "./enumerate-pm-fields";
// Comment fetch exports
export {
	type FetchPmCommentsInput,
	fetchPmComments,
	MAX_CHARS_PER_COMMENT,
	MAX_COMMENTS,
	type PmComment,
} from "./fetch-pm-comments";
// Fabric-owned GitLab attachment block (Fizzy #1745) — strip before any
// remote GitLab description is written into a Fabric story or hashed.
export { stripAttachmentBlock } from "./gitlab-attachment-block";
// ADO State Poll exports
export {
	type FetchAdoWorkItemStatesInput,
	fetchAdoWorkItemStates,
	getAdoActiveProjects,
	type PmActiveProject,
	type PmWorkItemState,
	type ReconcileAdoStatesInput,
	type ReconcileAdoStatesResult,
	reconcileAdoStates,
	updateProjectPollTimestamp,
} from "./pm-state-poll";
// ADO State Poll Activation
export { activateAdoStatePoll } from "./pm-state-poll-activation";
// Content hash (pure; shared with the API resolve path — pull-drift re-stamp)
export { computePmHash } from "./pm-sync-hash";
// PM tool tier model (Task 0 capability-probe spike)
export {
	getPmToolTier,
	type KnownPmTool,
	PM_TOOL_TIERS,
	type PmToolTier,
} from "./pm-tool-tiers";
// Field read-mapping preview
export {
	type PreviewPmFieldValue,
	type PreviewPmFieldValuesInput,
	type PreviewPmFieldValuesResult,
	previewPmFieldValues,
} from "./preview-pm-field-values";
// Audit-log writer. Safe to call from non-Temporal callers (the oRPC import
// path) — it falls back to a null correlationId outside an activity context.
export {
	type RecordPmSyncLogInput,
	recordPmSyncLog,
} from "./record-pm-sync-log";
// Story sync exports
export {
	assembleFieldMappingDescription,
	type BulkStorySyncInput,
	type BulkStorySyncResult,
	createOrUpdateStoryFromPMItem,
	deleteStoriesNotInPMList,
	discoverPMToolCapabilities,
	evaluateReplaceModeActivation,
	type FieldMappingReplaceOptions,
	fetchPMItemsByIds,
	type GetWorkItemsByIdsResult,
	getPMToolCapabilities,
	getStoriesToSync,
	getWorkItemsByIdsFromPM,
	type ListWorkItemsResult,
	listAllFizzyCards,
	listWorkItemsFromPM,
	type PMAvailableState,
	type PMWorkItemSummary,
	parsePMItemFromGetOutput,
	type ReplaceModeReason,
	type StorySyncInput,
	type StorySyncResult,
	type SyncDirection,
	searchWorkItemsFromPM,
	simpleHtmlToMarkdown,
	syncBulkStoriesToPM,
	syncStoryToPM,
	syncTaskToPM,
	updateStoryExternalRefs,
} from "./story-sync";
export {
	type PmFieldSuggestion,
	type SuggestPmFieldMappingInput,
	type SuggestPmFieldMappingResult,
	scoreFieldCandidates,
	suggestPmFieldMapping,
} from "./suggest-pm-field-mapping";
// Tool analyzer exports
export {
	analyzePMToolCapabilities,
	buildFieldCatalogFromTypeFields,
	buildTaskCreationArgs,
	type ContainerLevel,
	getContainerFetchWorkflow,
	isPlumbingReferenceName,
	type McpToolDefinition,
	type PaginationInfo,
	type PMToolCapabilities,
	type PmFieldCatalogEntry,
	type TaskCommentsCapability,
	type TaskCreationCapability,
	type TaskGetCapability,
	type TaskListCapability,
	type TaskUpdateCapability,
	type ToolInputSchema,
} from "./tool-analyzer";
