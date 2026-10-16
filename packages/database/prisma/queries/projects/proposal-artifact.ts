/**
 * Proposal artifact (Fizzy #2801, #2946) queries: the live sections of an
 * in-flight coordinated Proposal run, the Internal Analysis runs and their
 * findings, the members' answers to those findings, and the document's style
 * settings. Each concern lives in a sibling `proposal-artifact-*` module; this
 * file is their public surface, and the helpers they share stay out of it.
 */

export {
	claimLiveAttempt,
	clearLiveContent,
	type LiveRunAttempt,
	resetLiveSections,
	writeLiveSections,
} from "./proposal-artifact-live";
export {
	type ClaimedRerun,
	type ClaimRerunConflictReason,
	type ClaimRerunInput,
	type ClaimRerunResult,
	claimRerun,
	proposalAnalysisRerunKey,
} from "./proposal-artifact-rerun";
export {
	type ClearFindingResponseResult,
	clearFindingResponse,
	type FindingResponseCurrent,
	type FindingResponseValidationCode,
	FindingResponseValidationError,
	type FindingResponseView,
	listResponsesForDocument,
	normalizeFindingResponseText,
	type UpsertFindingResponseInput,
	type UpsertFindingResponseResult,
	upsertFindingResponse,
} from "./proposal-artifact-responses";
export {
	type AnalysisFindingInput,
	type AnalysisRunInput,
	type ComputeProseHash,
	type CreateAnalysisRunInput,
	type CreateAnalysisRunResult,
	completeAnalysisRun,
	createAnalysisRun,
	failAnalysisRun,
	getAnalysisForCurrentContent,
	getAnalysisRunInput,
	getLatestAnalysisForDocument,
	getRunSourceContext,
	isAnalysisRunTimedOut,
	markAnalysisRunning,
	type ProposalAnalysisForContent,
	type ProposalAnalysisNewerRun,
	type ProposalAnalysisShownRun,
	type ProposalAnalysisView,
	type RunSourceContext,
} from "./proposal-artifact-runs";
export {
	PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH,
	PROPOSAL_ANALYSIS_KINDS,
	PROPOSAL_ANALYSIS_MATCH_WINDOW,
	PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH,
	PROPOSAL_ANALYSIS_STATUSES,
	PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE,
	PROPOSAL_ANALYSIS_TIMEOUT_MS,
	PROPOSAL_FINDING_RESPONSE_KINDS,
	PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH,
	PROPOSAL_FINDING_SEVERITIES,
	PROPOSAL_FINDING_TYPES,
	PROPOSAL_STYLE_MAX_ACCENT_COLORS,
	PROPOSAL_STYLE_MAX_DIRECTION_LENGTH,
	type ProposalAnalysisKind,
	type ProposalAnalysisStatus,
	type ProposalArtifactGuardedOutcome,
	ProposalArtifactTenantError,
	type ProposalFindingResponseKind,
	type ProposalFindingSeverity,
	type ProposalFindingType,
} from "./proposal-artifact-shared";
export {
	normalizeSourceManifest,
	PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH,
	PROPOSAL_SOURCE_MANIFEST_KINDS,
	PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH,
	PROPOSAL_SOURCE_MANIFEST_MAX_ENTRIES,
	type ProposalEvidenceCompanySourceRow,
	type ProposalEvidenceContextRow,
	type ProposalSourceManifest,
	type ProposalSourceManifestEntry,
	type ProposalSourceManifestEntryInput,
	type ProposalSourceManifestKind,
	parseStoredSourceManifest,
	readProposalEvidenceSources,
} from "./proposal-artifact-source-manifest";
export {
	type DocumentStyleFields,
	type DocumentStyleValidationCode,
	DocumentStyleValidationError,
	type DocumentStyleView,
	getDocumentStyle,
	normalizeDocumentStyleFields,
	upsertDocumentStyle,
} from "./proposal-artifact-style";
