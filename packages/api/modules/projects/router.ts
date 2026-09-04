// Backlog analysis procedures

import { acknowledgeDecisionPrecheckProcedure } from "./procedures/acknowledge-decision-precheck";
import {
	cancelAgenticRunProcedure,
	createRunConfigurationProcedure,
	deleteRunConfigurationProcedure,
	dispatchAgenticRunProcedure,
	getAgenticRunProcedure,
	listAgenticRunsPageProcedure,
	listAgenticRunsProcedure,
	listRunConfigurationsProcedure,
	updateRunConfigurationProcedure,
} from "./procedures/agentic-runs";
import {
	createArchitectureDecisionCommentProcedure,
	listArchitectureDecisionCommentsProcedure,
} from "./procedures/architecture-decisions/comments";
import {
	acknowledgeArchitectureDecisionProcedure,
	createArchitectureDecisionProcedure,
	deleteArchitectureDecisionProcedure,
	getArchitectureDecisionProcedure,
	listArchitectureDecisionsProcedure,
	pinArchitectureDecisionProcedure,
	revertArchitectureDecisionVersionProcedure,
	updateArchitectureDecisionProcedure,
	vouchArchitectureDecisionProcedure,
} from "./procedures/architecture-decisions/crud";
import {
	createDecisionFromMeetingProcedure,
	dismissMeetingDecisionProcedure,
	listMeetingDecisionCandidatesProcedure,
} from "./procedures/architecture-decisions/meeting-decisions";
import { listDecisionOverridesProcedure } from "./procedures/architecture-decisions/overrides";
import { suggestDecisionMetadataProcedure } from "./procedures/architecture-decisions/suggest-metadata";
import {
	archiveDecisionTypeProcedure,
	listDecisionTypesProcedure,
	restoreDecisionTypeProcedure,
} from "./procedures/architecture-decisions/types";
import { listArchitectureDecisionVersionsProcedure } from "./procedures/architecture-decisions/versions";
// Azure DevOps code-repo setup procedures
import {
	listAzureDevOpsReposProcedure,
	startAzureDevOpsCodeSetupProcedure,
} from "./procedures/azure-devops";
import { analysisProgressProcedure } from "./procedures/backlog/analysis-progress";
import { applyChangesProcedure } from "./procedures/backlog/apply-changes";
import { applyProgressProcedure } from "./procedures/backlog/apply-progress";
import { cancelPendingProposalProcedure } from "./procedures/backlog/cancel-pending-proposal";
import { cancelProposalDraftProcedure } from "./procedures/backlog/cancel-proposal-draft";
import { dismissFailedProposalProcedure } from "./procedures/backlog/dismiss-failed-proposal";
import { getBacklogProposalsCountProcedure } from "./procedures/backlog/get-backlog-proposals-count";
import { getFailedProposalsCountProcedure } from "./procedures/backlog/get-failed-proposals-count";
import { getProposalDraftsProcedure } from "./procedures/backlog/get-proposal-drafts";
import { listBacklogAuditHistoryProcedure } from "./procedures/backlog/history-audit-list";
import { getBacklogSessionHistoryProcedure } from "./procedures/backlog/history-session-get";
import { listBacklogSessionHistoryProcedure } from "./procedures/backlog/history-sessions-list";
import { listCalendarMeetingsProcedure } from "./procedures/backlog/list-calendar-meetings";
import { retryAllFailedProposalsProcedure } from "./procedures/backlog/retry-all-failed-proposals";
import { retryFailedProposalProcedure } from "./procedures/backlog/retry-failed-proposal";
import { startAnalysisProcedure } from "./procedures/backlog/start-analysis";
import { startProposalDraftProcedure } from "./procedures/backlog/start-proposal-draft";
import { bulkDeleteProjectsProcedure } from "./procedures/bulk-delete-projects";
import { bulkReviewPendingStateChangesProcedure } from "./procedures/bulk-review-pending-state-changes";
import { githubPushWebhookProcedure } from "./procedures/code-indexing/github-webhook";
import { addGoogleDocsContextProcedure } from "./procedures/contexts/add-google-docs-context";
import { cancelDraftCrawlsProcedure } from "./procedures/contexts/cancel-draft-crawls";
import { cancelContextSummaryProcedure } from "./procedures/contexts/cancel-summary";
import { cancelUrlSourceCrawlProcedure } from "./procedures/contexts/cancel-url-source-crawl";
import { createContextProcedure } from "./procedures/contexts/create-context";
import { createContextDownloadUrlProcedure } from "./procedures/contexts/create-context-download-url";
import { createContextUploadUrlProcedure } from "./procedures/contexts/create-context-upload-url";
import { createContextsBatchDownloadUrlProcedure } from "./procedures/contexts/create-contexts-batch-download-url";
import { deleteContextProcedure } from "./procedures/contexts/delete-context";
import { embedProjectContextsProcedure } from "./procedures/contexts/embed-contexts";
import { getContextSummaryProcedure } from "./procedures/contexts/get-summary";
import { getContextSummaryVersionProcedure } from "./procedures/contexts/get-summary-version";
import { getUrlPageContentProcedure } from "./procedures/contexts/get-url-page-content";
import { googleDocsPickerSessionProcedure } from "./procedures/contexts/google-docs-picker-session";
import { listAvailableSlackChannelsProcedure } from "./procedures/contexts/list-available-slack-channels";
import { listAvailableTeamsChatsProcedure } from "./procedures/contexts/list-available-teams-chats";
import { listContextsProcedure } from "./procedures/contexts/list-contexts";
import { listContextSummaryHistoryProcedure } from "./procedures/contexts/list-summary-history";
import { listContextSummarySourcesProcedure } from "./procedures/contexts/list-summary-sources";
import { listUrlPagesProcedure } from "./procedures/contexts/list-url-pages";
import { processContextFileProcedure } from "./procedures/contexts/process-context-file";
import { processContextLinkProcedure } from "./procedures/contexts/process-context-link";
import { resolveContextSummaryReferenceProcedure } from "./procedures/contexts/resolve-summary-reference";
import { restoreContextSummaryVersionProcedure } from "./procedures/contexts/restore-summary-version";
import { resyncUrlPageProcedure } from "./procedures/contexts/resync-url-page";
import { resyncUrlSourceProcedure } from "./procedures/contexts/resync-url-source";
import { summarizeContextProcedure } from "./procedures/contexts/summarize-context";
import { contextSummaryStatusProcedure } from "./procedures/contexts/summary-status";
import { updateContextMetadataProcedure } from "./procedures/contexts/update-context-metadata";
import { updateContextSummaryProcedure } from "./procedures/contexts/update-summary";
import { updateUrlSourceProcedure } from "./procedures/contexts/update-url-source";
// Conversation attachment procedures
import {
	attachProjectProcedure,
	detachProjectProcedure,
	getConversationProjectProcedure,
} from "./procedures/conversations";
import { countPendingStateChangesProcedure } from "./procedures/count-pending-state-changes";
import { createDocumentProcedure } from "./procedures/create-document";
import { createProjectProcedure } from "./procedures/create-project";
import { deleteProjectDatabricksKnowledgeProcedure } from "./procedures/databricks-knowledge/delete-databricks-knowledge";
import { getProjectDatabricksKnowledgeProcedure } from "./procedures/databricks-knowledge/get-databricks-knowledge";
import { saveProjectDatabricksKnowledgeProcedure } from "./procedures/databricks-knowledge/save-databricks-knowledge";
import {
	getDecisionsViewProcedure,
	updateDecisionsViewProcedure,
} from "./procedures/decisions-view";
import { deleteAllDocumentsProcedure } from "./procedures/delete-all-documents";
import { deleteDocumentProcedure } from "./procedures/delete-document";
import { deleteProjectProcedure } from "./procedures/delete-project";
import { createDiagramProcedure } from "./procedures/diagrams/create-diagram";
import { createFromChatProcedure } from "./procedures/diagrams/create-from-chat";
import { deleteDiagramProcedure } from "./procedures/diagrams/delete-diagram";
import { getDiagramProcedure } from "./procedures/diagrams/get-diagram";
import { listDiagramsProcedure } from "./procedures/diagrams/list-diagrams";
import { updateDiagramProcedure } from "./procedures/diagrams/update-diagram";
import { applyDocumentAutoRefreshProposalProcedure } from "./procedures/documents/apply-auto-refresh-proposal";
import { batchGenerateDocumentsProcedure } from "./procedures/documents/batch-generate";
import { createMediaUploadUrlProcedure } from "./procedures/documents/create-media-upload-url";
import { deleteMediaProcedure } from "./procedures/documents/delete-media";
import { discardDocumentAutoRefreshProposalProcedure } from "./procedures/documents/discard-auto-refresh-proposal";
import { executeGitHubToolProcedure } from "./procedures/documents/execute-github-tool";
import { executeGitLabToolProcedure } from "./procedures/documents/execute-gitlab-tool";
import { fetchMeetingNotesProcedure } from "./procedures/documents/fetch-meeting-notes";
import { generateDocumentProcedure } from "./procedures/documents/generate-document";
import { getDocumentAutoRefreshProcedure } from "./procedures/documents/get-auto-refresh";
import { listDocumentAssetsProcedure } from "./procedures/documents/list-assets";
import { rejectRegenerationProcedure } from "./procedures/documents/reject-regeneration";
import { resolveMediaUrlsProcedure } from "./procedures/documents/resolve-media-urls";
import { searchMentionablesProcedure } from "./procedures/documents/search-mentionables";
import { setActiveDocumentProcedure } from "./procedures/documents/set-active";
import { setDocumentAutoRefreshProcedure } from "./procedures/documents/set-auto-refresh";
import { updateDocumentWithContextProcedure } from "./procedures/documents/update-with-context";
// Epic & Feature procedures
import { createEpicProcedure } from "./procedures/epics/create-epic";
import { createFeatureProcedure } from "./procedures/epics/create-feature";
import { deleteEpicProcedure } from "./procedures/epics/delete-epic";
import { deleteFeatureProcedure } from "./procedures/epics/delete-feature";
import { getHierarchyProcedure } from "./procedures/epics/get-hierarchy";
import { listEpicsProcedure } from "./procedures/epics/list-epics";
import { listFeaturesProcedure } from "./procedures/epics/list-features";
import { updateEpicProcedure } from "./procedures/epics/update-epic";
import { updateFeatureProcedure } from "./procedures/epics/update-feature";
import { getDocumentProcedure } from "./procedures/get-document";
import { getDocumentContextProcedure } from "./procedures/get-document-context";
import { getDocumentRecommendationsProcedure } from "./procedures/get-document-recommendations";
import { getProjectProcedure } from "./procedures/get-project";
import { getProjectStatsProcedure } from "./procedures/get-project-stats";
import { getReviewCenterCountProcedure } from "./procedures/get-review-center-count";
import { getReviewCenterItemsProcedure } from "./procedures/get-review-center-items";
// GitHub code-based setup procedures
import {
	codeBasedSetupStatusProcedure,
	listGitHubReposProcedure,
} from "./procedures/github";
// GitLab procedures
import { listGitLabProjectsProcedure } from "./procedures/gitlab/list-projects";
import {
	getKanbanUserPreferenceProcedure,
	updateKanbanUserPreferenceProcedure,
} from "./procedures/kanban-user-preference";
import { listDocumentsProcedure } from "./procedures/list-documents";
import { listDraftProjectsProcedure } from "./procedures/list-draft-projects";
import { listGuestProjectsProcedure } from "./procedures/list-guest-projects";
import { listPendingStateChangesProcedure } from "./procedures/list-pending-state-changes";
import { listPmSyncLogProcedure } from "./procedures/list-pm-sync-log";
import { listProjectsProcedure } from "./procedures/list-projects";
// Meeting Digest procedures
import {
	addActionItemLinkProcedure,
	extractInsightsProcedure,
	generateAgendaProcedure,
	generateProposalsProcedure,
	getAgendaProcedure,
	getMeetingProcedure,
	getPersonalInsightsProcedure,
	getPersonalTranscriptProcedure,
	importPersonalMeetingProcedure,
	linkActionItemsProcedure,
	listConfigurableMeetingsProcedure,
	listDigestProcedure,
	listPersonalMeetingsProcedure,
	listUpcomingMeetingsProcedure,
	proposeActionItemProcedure,
	removeActionItemLinkProcedure,
	saveAgendaProcedure,
	setActionItemCompletedProcedure,
	setIncludedProcedure,
} from "./procedures/meeting-digest";
// Meeting transcript sync procedures
import {
	disableMeetingTranscriptSyncProcedure,
	enableMeetingTranscriptSyncProcedure,
	getTranscriptContentProcedure,
	getTranscriptContextProcedure,
	linkMeetingProcedure,
	listDeletedMeetingsProcedure,
	listLinkedMeetingsProcedure,
	listSyncedTranscriptsProcedure,
	repairSyncProcedure,
	restoreMeetingProcedure,
	setAutoAnalyzeProcedure,
	setMeetingSyncActiveProcedure,
	triggerSyncNowProcedure,
	unlinkMeetingProcedure,
} from "./procedures/meeting-transcript-sync";
import { acceptInvitationProcedure } from "./procedures/members/accept-invitation";
import { declineInvitationProcedure } from "./procedures/members/decline-invitation";
import { dismissWelcomeWidgetProcedure } from "./procedures/members/dismiss-welcome-widget";
import { getEligibleUsersProcedure } from "./procedures/members/get-eligible-users";
import { getWelcomeWidgetProcedure } from "./procedures/members/get-welcome-widget";
import { inviteMemberProcedure } from "./procedures/members/invite-member";
import { listInvitationsProcedure } from "./procedures/members/list-invitations";
import { listMembersProcedure } from "./procedures/members/list-members";
import { listSentInvitationsProcedure } from "./procedures/members/list-sent-invitations";
import { lookupEmailStatusProcedure } from "./procedures/members/lookup-email-status";
import { removeMemberProcedure } from "./procedures/members/remove-member";
import { resendProjectInvitationProcedure } from "./procedures/members/resend-invitation";
import { revokeProjectInvitationProcedure } from "./procedures/members/revoke-invitation";
import { updateMemberRoleProcedure } from "./procedures/members/update-member-role";
// Notion PRD procedures
import {
	bindNotionPageProcedure,
	clearPrdSourceProcedure,
	getPrdSourceContentProcedure,
	getPrdSourceStatusProcedure,
	syncPrdSourceProcedure,
} from "./procedures/notion-prd";
import { permanentDeleteProjectProcedure } from "./procedures/permanent-delete-project";
import {
	analyseQaFindingProcedure,
	dismissQaFindingProcedure,
	getCiConfigTemplateProcedure,
	getProjectRepositoryPipelineSyncHealthProcedure,
	listPipelineRunsPageProcedure,
	listPipelineRunsProcedure,
	listPipelineSyncStatesProcedure,
	listQaFindingsProcedure,
	listQaPipelineSourcesProcedure,
	listTriggerablePipelinesProcedure,
	listUnmatchedAutomatedTestsProcedure,
	mergeQaFindingsProcedure,
	pipelineRunDetailProcedure,
	promoteQaFindingProcedure,
	setQaPipelineBranchProcedure,
	syncPipelineResultsProcedure,
	triggerPipelineProcedure,
} from "./procedures/pipeline-results";
import {
	analysePullRequestArchitectureProcedure,
	analysePullRequestQaProcedure,
	getPrReviewLensStatsProcedure,
	getPullRequestReviewProcedure,
	listPullRequestReviewsProcedure,
	postPullRequestReviewCommentProcedure,
	readPullRequestProcedure,
	setPullRequestFindingStatusProcedure,
} from "./procedures/pr-review";
import { setProjectFavoriteProcedure } from "./procedures/project-favorite";
import { checkProjectNameProcedure } from "./procedures/project-name-availability";
import { listProjectShortcutsProcedure } from "./procedures/project-shortcuts";
import {
	getProjectTabPreferencesProcedure,
	getProjectTabVisibilityProcedure,
	setProjectTabPreferencesProcedure,
	setProjectTabVisibilityProcedure,
} from "./procedures/project-tabs";
import {
	adoptBlogPostDraftProcedure,
	adoptCaseStudyDraftProcedure,
	adoptStakeholderEmailDraftProcedure,
	answerTopicQuestionProcedure,
	createPublishingTopicProcedure,
	generateBlogPostProcedure,
	generateCaseStudyProcedure,
	generatePlanningAnalysisProcedure,
	generatePublishingTopicsNowProcedure,
	generateShortPostProcedure,
	generateStakeholderEmailProcedure,
	getPlanningAnalysisProcedure,
	getPublishingSuiteSettingsProcedure,
	getPublishingTopicProcedure,
	latestPublishingCycleProcedure,
	listCycleChatDeliveriesProcedure,
	listPublishingCyclesProcedure,
	listPublishingTopicsProcedure,
	listTopicDecisionsProcedure,
	listTopicDraftsProcedure,
	saveBlogPostBodyProcedure,
	saveCaseStudyBodyProcedure,
	saveStakeholderEmailBodyProcedure,
	selectShortPostOptionProcedure,
	setTopicReadStateProcedure,
	setTopicSnoozeProcedure,
	updatePublishingSuiteSettingsProcedure,
	updatePublishingTopicPostTypesProcedure,
	updatePublishingTopicStatusProcedure,
} from "./procedures/publishing-suite";
import {
	createQaOpenQuestionProcedure,
	deleteQaOpenQuestionProcedure,
	listQaOpenQuestionsProcedure,
	updateQaOpenQuestionProcedure,
} from "./procedures/qa-open-questions";
import {
	createProjectEnvironmentProcedure,
	createProjectQaWebhookProcedure,
	deleteProjectEnvironmentProcedure,
	getProjectQaSettingsProcedure,
	getProjectQaWebhookProcedure,
	listEnvironmentCredentialsProcedure,
	listProjectEnvironmentsProcedure,
	revokeProjectQaWebhookProcedure,
	rotateProjectQaWebhookProcedure,
	setEnvironmentCredentialProcedure,
	updateProjectEnvironmentProcedure,
	updateProjectQaSettingsProcedure,
	updateProjectQaWebhookExpiryProcedure,
} from "./procedures/qa-settings";
import { getRagSettingsProcedure } from "./procedures/rag-settings/get-rag-settings";
import { reprocessContextsProcedure } from "./procedures/rag-settings/reprocess-contexts";
import { updateRagSettingsProcedure } from "./procedures/rag-settings/update-rag-settings";
// Project readiness checklist (Fizzy #2165)
import {
	getReadinessProcedure,
	markReadinessSeenProcedure,
	requestReadinessHelpProcedure,
	setReadinessItemNotApplicableProcedure,
	snoozeReadinessItemProcedure,
} from "./procedures/readiness";
import { recordProjectVisitProcedure } from "./procedures/record-project-visit";
import { attachPatToRepoIntegrationProcedure } from "./procedures/repository-integrations/attach-pat";
// Repository Integration procedures
import { cancelReindexRepoIntegrationProcedure } from "./procedures/repository-integrations/cancel-reindex";
import { connectRepoIntegrationProcedure } from "./procedures/repository-integrations/connect";
import { disconnectRepoIntegrationProcedure } from "./procedures/repository-integrations/disconnect";
import { repoIntegrationHealthProcedure } from "./procedures/repository-integrations/health";
import { listRepoIntegrationsProcedure } from "./procedures/repository-integrations/list";
import { reindexRepoIntegrationProcedure } from "./procedures/repository-integrations/reindex";
import { updateRepoIntegrationBranchProcedure } from "./procedures/repository-integrations/update-branch";
import { updateRepoIntegrationTagProcedure } from "./procedures/repository-integrations/update-tag";
import { resolveActiveMentionsProcedure } from "./procedures/resolve-active-mentions";
import { resolveContentDriftProcedure } from "./procedures/resolve-content-drift";
import { restoreProjectProcedure } from "./procedures/restore-project";
import { retrieveSpecContextProcedure } from "./procedures/retrieve-spec-context";
import { reviewPendingStateChangeProcedure } from "./procedures/review-pending-state-change";
import {
	getRoadmapViewProcedure,
	reorderRoadmapStoryOrderProcedure,
	updateRoadmapViewProcedure,
} from "./procedures/roadmap-view";
import { saveDraftProjectProcedure } from "./procedures/save-draft-project";
import { applyGroupingProcedure } from "./procedures/scan/apply-grouping";
import { applyReviewProcedure } from "./procedures/scan/apply-review";
import { listBranchScanStatusProcedure } from "./procedures/scan/branch-status";
import { bulkUpdateFindingsProcedure } from "./procedures/scan/bulk-update-findings";
import { cancelGroupingProcedure } from "./procedures/scan/cancel-grouping";
import { cancelReviewProcedure } from "./procedures/scan/cancel-review";
import { cancelScanProcedure } from "./procedures/scan/cancel-scan";
import { getGroupingProcedure } from "./procedures/scan/get-grouping";
import { getReviewProcedure } from "./procedures/scan/get-review";
import { getScanConfigProcedure } from "./procedures/scan/get-scan-config";
import { listActivityProcedure } from "./procedures/scan/list-activity";
import { listFindingsProcedure } from "./procedures/scan/list-findings";
import {
	getLatestScanProcedure,
	listScansProcedure,
} from "./procedures/scan/list-scans";
import { readdGroupingThemeProcedure } from "./procedures/scan/readd-grouping-theme";
import { reattachGroupingProcedure } from "./procedures/scan/reattach-grouping";
import { startGroupingProcedure } from "./procedures/scan/start-grouping";
import { startReviewProcedure } from "./procedures/scan/start-review";
import { triggerScanProcedure } from "./procedures/scan/trigger-scan";
import { updateFindingProcedure } from "./procedures/scan/update-finding";
import { updateScanConfigProcedure } from "./procedures/scan/update-scan-config";
import { searchCodeFilesProcedure } from "./procedures/search-code-files";
import { searchStoriesProcedure } from "./procedures/search-stories";
import { setActionItemRoutingProcedure } from "./procedures/set-action-item-routing";
// Slack channel monitor procedures (parallel to Teams channel monitor —
// event-driven instead of polling, but the same pending-proposal pipeline).
import {
	approvePendingProposalProcedure as approveSlackPendingProposalProcedure,
	backlogPendingProposalProcedure as backlogSlackPendingProposalProcedure,
	countPendingProposalsProcedure as countSlackPendingProposalsProcedure,
	disableSlackChannelMonitorProcedure,
	enableSlackChannelMonitorProcedure,
	getPendingProposalProcedure as getSlackPendingProposalProcedure,
	linkChannelProcedure as linkSlackChannelProcedure,
	listLinkedChannelsProcedure as listLinkedSlackChannelsProcedure,
	listPendingProposalsProcedure as listSlackPendingProposalsProcedure,
	rejectPendingProposalProcedure as rejectSlackPendingProposalProcedure,
	triggerMonitorNowProcedure as triggerSlackMonitorNowProcedure,
	unlinkChannelProcedure as unlinkSlackChannelProcedure,
} from "./procedures/slack-channel-monitor";
import {
	disableSlackHuddleIngestProcedure,
	enableSlackHuddleIngestProcedure,
	triggerNowProcedure as triggerSlackHuddleIngestNowProcedure,
} from "./procedures/slack-huddle-ingest";
// Existing project setup procedure
import { startExistingSetupProcedure } from "./procedures/start-existing-setup";
import { createAttachmentProcedure } from "./procedures/stories/attachments/create-attachment";
import { createAttachmentUploadUrlProcedure } from "./procedures/stories/attachments/create-attachment-upload-url";
import { listAttachmentsProcedure } from "./procedures/stories/attachments/list-attachments";
import { promoteAttachmentProcedure } from "./procedures/stories/attachments/promote-attachment";
import { removeAttachmentProcedure } from "./procedures/stories/attachments/remove-attachment";
import { setAttachmentDesignationProcedure } from "./procedures/stories/attachments/set-attachment-designation";
import { clearStoriesProcedure } from "./procedures/stories/clear-stories";
import {
	createStoryCommentProcedure,
	listStoryCommentsProcedure,
} from "./procedures/stories/comments";
import { convertStoryKindProcedure } from "./procedures/stories/convert-kind";
import { createMediaUploadUrlProcedure as createStoryMediaUploadUrlProcedure } from "./procedures/stories/create-media-upload-url";
import { createStoriesBatchDownloadUrlProcedure } from "./procedures/stories/create-stories-batch-download-url";
import { createStoryProcedure } from "./procedures/stories/create-story";
import { deleteStoryProcedure } from "./procedures/stories/delete-story";
import { dismissDuplicateProcedure } from "./procedures/stories/dismiss-duplicate";
import { dismissPmSyncConflictProcedure } from "./procedures/stories/dismiss-pm-sync-conflict";
import { dismissPmSyncFailureProcedure } from "./procedures/stories/dismiss-pm-sync-failure";
import { dismissPmSyncFailureBatchProcedure } from "./procedures/stories/dismiss-pm-sync-failure-batch";
import { enhanceFeatureProcedure } from "./procedures/stories/enhance-feature";
import { generateTasksProcedure } from "./procedures/stories/generate-tasks";
import { getStoryRegenerationStatusProcedure } from "./procedures/stories/get-regeneration-status";
import { getStoryProcedure } from "./procedures/stories/get-story";
import { listDuplicatesProcedure } from "./procedures/stories/list-duplicates";
import { listMeetingReferencesProcedure } from "./procedures/stories/list-meeting-references";
import { listStoriesProcedure } from "./procedures/stories/list-stories";
// Feature Maturation V2 — three-tab editor backend (spec 2026-06-09 §12)
import { acceptCleanSpecPatchProcedure } from "./procedures/stories/maturation/accept-clean-spec-patch";
import { amendAnswerProcedure } from "./procedures/stories/maturation/amend-answer";
import { answerQuestionProcedure } from "./procedures/stories/maturation/answer-question";
import { appendDecisionEntryProcedure } from "./procedures/stories/maturation/append-decision-entry";
import { ensureSeededProcedure } from "./procedures/stories/maturation/ensure-seeded";
import { evaluateAiReadinessProcedure } from "./procedures/stories/maturation/evaluate-ai-readiness";
import { generateQaAnalysisProcedure } from "./procedures/stories/maturation/generate-qa-analysis";
import { getApprovalModeProcedure } from "./procedures/stories/maturation/get-approval-mode";
import { getEditorStateProcedure } from "./procedures/stories/maturation/get-editor-state";
import { listDecisionLogProcedure } from "./procedures/stories/maturation/list-decision-log";
import { listQaAnalysisVersionsProcedure } from "./procedures/stories/maturation/list-qa-analysis-versions";
import { recordChangeNoteProcedure } from "./procedures/stories/maturation/record-change-note";
import { restoreQuestionProcedure } from "./procedures/stories/maturation/restore-question";
import { searchAssignableMembersProcedure } from "./procedures/stories/maturation/search-assignable-members";
import { setApprovalModeProcedure } from "./procedures/stories/maturation/set-approval-mode";
import { setAutoProposeAnswersProcedure } from "./procedures/stories/maturation/set-auto-propose-answers";
import { setQuestionAssigneesProcedure } from "./procedures/stories/maturation/set-question-assignees";
import { setWorkingNotesProcedure } from "./procedures/stories/maturation/set-working-notes";
import { summarizeChangesProcedure } from "./procedures/stories/maturation/summarize-changes";
import { mergeDuplicateProcedure } from "./procedures/stories/merge-duplicate";
import { moveStoryProcedure } from "./procedures/stories/move-story";
import { moveStoryRoadmapProcedure } from "./procedures/stories/move-story-roadmap";
import { openDecisionsProcedure } from "./procedures/stories/open-decisions";
// Stories procedures
import { previewEnrichmentProcedure } from "./procedures/stories/preview-enrichment";
import { checkPmSyncConflictsProcedure } from "./procedures/stories/preview-pm-sync-conflicts";
import { priorityHistoryProcedure } from "./procedures/stories/priority-history";
import { proposeDuplicateMergeProcedure } from "./procedures/stories/propose-duplicate-merge";
import { pushToKanbanProcedure } from "./procedures/stories/push-to-kanban";
import { queueForKanbanProcedure } from "./procedures/stories/queue-for-kanban";
import { reevaluateBugProcedure } from "./procedures/stories/reevaluate-bug";
import { reformatProposalBodyProcedure } from "./procedures/stories/reformat-proposal-body";
import { regenerateStoryTitleProcedure } from "./procedures/stories/regenerate-story-title";
import { reorderStoriesProcedure } from "./procedures/stories/reorder-stories";
import { reorderStoriesPriorityProcedure } from "./procedures/stories/reorder-stories-priority";
import { reorderStoriesRoadmapProcedure } from "./procedures/stories/reorder-stories-roadmap";
import {
	reprioritizeStoriesProcedure,
	reprioritizeStoryProcedure,
} from "./procedures/stories/reprioritize-stories";
import { resetStoriesPriorityOrderProcedure } from "./procedures/stories/reset-stories-priority-order";
import { resolveMediaUrlsProcedure as resolveStoryMediaUrlsProcedure } from "./procedures/stories/resolve-media-urls";
import { resolveStoryAttachmentContextForAgentProcedure } from "./procedures/stories/resolve-story-attachment-context-for-agent";
import { resolveStoryMediaForAgentProcedure } from "./procedures/stories/resolve-story-media-for-agent";
import { resolveStoryPromptProcedure } from "./procedures/stories/resolve-story-prompt";
import { retryPmSyncProcedure } from "./procedures/stories/retry-pm-sync";
import { retryPmSyncBatchProcedure } from "./procedures/stories/retry-pm-sync-batch";
import { scanDuplicatesProcedure } from "./procedures/stories/scan-duplicates";
import { semanticSearchProcedure } from "./procedures/stories/semantic-search";
import { setBlockedProcedure } from "./procedures/stories/set-blocked";
import { setStoryPriorityProcedure } from "./procedures/stories/set-story-priority";
import { shareStoryProcedure } from "./procedures/stories/share-story";
import { createStoryStatusProcedure } from "./procedures/stories/statuses/create-status";
import { deleteStoryStatusProcedure } from "./procedures/stories/statuses/delete-status";
import { listStoryStatusesProcedure } from "./procedures/stories/statuses/list-statuses";
import { reorderStoryStatusesProcedure } from "./procedures/stories/statuses/reorder-statuses";
import { updateStoryStatusProcedure } from "./procedures/stories/statuses/update-status";
import {
	cancelSyncProcedure,
	composeFieldPreviewProcedure,
	enumerateFieldsProcedure,
	getPMCapabilitiesProcedure,
	getTeamFieldValuesProcedure,
	importFromPMProcedure,
	listPMTicketsProcedure,
	listProjectTeamsProcedure,
	listProjectWorkItemTypesProcedure,
	previewTicketFieldsProcedure,
	proposeAiMergeProcedure,
	resolveConflictProcedure,
	suggestFieldMappingProcedure,
	syncProgressProcedure,
	syncStoriesBulkProcedure,
	syncStoryProcedure,
	testPMSyncProcedure,
} from "./procedures/stories/sync";
import {
	addStoryTagProcedure,
	listStoryTagsProcedure,
	removeStoryTagProcedure,
} from "./procedures/stories/tags";
import { cancelTaskAgentProcedure } from "./procedures/stories/tasks/cancel-agent";
import { cleanupStuckAgentsProcedure } from "./procedures/stories/tasks/cleanup-stuck-agents";
import {
	createTaskCommentProcedure,
	listTaskCommentsProcedure,
} from "./procedures/stories/tasks/comments";
import { createTaskProcedure } from "./procedures/stories/tasks/create-task";
import { deleteTaskProcedure } from "./procedures/stories/tasks/delete-task";
import { getAgentStatusProcedure } from "./procedures/stories/tasks/get-agent-status";
import { resolveCheckpointProcedure } from "./procedures/stories/tasks/resolve-checkpoint";
// Task Agent procedures
import { startTaskAgentProcedure } from "./procedures/stories/tasks/start-agent";
import { toggleTaskProcedure } from "./procedures/stories/tasks/toggle-task";
import { updateTaskProcedure } from "./procedures/stories/tasks/update-task";
import { updateDraftingStageProcedure } from "./procedures/stories/update-drafting-stage";
import { updateDraftingStageWithVersionProcedure } from "./procedures/stories/update-drafting-stage-with-version";
import { updateStoryProcedure } from "./procedures/stories/update-story";
import { updateWithContextProcedure } from "./procedures/stories/update-with-context";
import { listFeatureVersionsProcedure } from "./procedures/stories/versions/list-feature-versions";
import { restoreFeatureVersionProcedure } from "./procedures/stories/versions/restore-feature-version";
import { suggestTerminalStatusesProcedure } from "./procedures/suggest-terminal-statuses";
// Teams channel monitor procedures
import {
	approvePendingProposalProcedure,
	backlogPendingProposalProcedure,
	countPendingProposalsProcedure,
	disableTeamsChannelMonitorProcedure,
	enableTeamsChannelMonitorProcedure,
	getPendingProposalProcedure,
	linkChannelProcedure,
	listLinkedChannelsProcedure,
	listPendingProposalsProcedure,
	rejectPendingProposalProcedure,
	triggerMonitorNowProcedure,
	unlinkChannelProcedure,
} from "./procedures/teams-channel-monitor";
// Teams chat monitor procedures (parallel to channel monitor for group chats)
import {
	// Approve/reject re-exported from teams-channel-monitor (source-agnostic).
	approvePendingProposalProcedure as approveChatPendingProposalProcedure,
	backlogPendingProposalProcedure as backlogChatPendingProposalProcedure,
	countPendingProposalsProcedure as countChatPendingProposalsProcedure,
	disableTeamsChatMonitorProcedure,
	enableTeamsChatMonitorProcedure,
	getPendingProposalProcedure as getChatPendingProposalProcedure,
	linkChatProcedure,
	listPendingProposalsProcedure as listChatPendingProposalsProcedure,
	listLinkedChatsProcedure,
	rejectPendingProposalProcedure as rejectChatPendingProposalProcedure,
	triggerMonitorNowProcedure as triggerChatMonitorNowProcedure,
	unlinkChatProcedure,
} from "./procedures/teams-chat-monitor";
import {
	acceptTestCaseStepsProcedure,
	addCaseToPlanProcedure,
	aiDraftTestCasesProcedure,
	bulkDeleteTestCasesProcedure,
	bulkMutateTestCasesProcedure,
	cancelTestCaseDraftJobProcedure,
	cloneTestCaseProcedure,
	coverageForStoryProcedure,
	createTestCaseProcedure,
	createTestPlanProcedure,
	deleteTestCaseProcedure,
	deleteTestPlanProcedure,
	generatePlaywrightScriptProcedure,
	getActivityHistoryProcedure,
	getCoverageIndexProcedure,
	getPlaywrightScriptRevisionProcedure,
	getQaSignOffsProcedure,
	getResultHistoryProcedure,
	getTestCaseDraftJobProcedure,
	getTestCaseProcedure,
	getTestPlanProcedure,
	linkWorkItemProcedure,
	listDriftedTestCasesProcedure,
	listFeatureCoverageProcedure,
	listFeatureDraftRunsProcedure,
	listPlaywrightScriptRevisionsProcedure,
	listPlaywrightScriptSourcesProcedure,
	listTestCaseDraftJobsProcedure,
	listTestCasesProcedure,
	listTestPlansProcedure,
	proposeTestCaseStepsFromImplementationProcedure,
	proposeTestCaseStepsProcedure,
	recordQaSignOffProcedure,
	recordResultProcedure,
	rejectTestCaseStepsProcedure,
	removeCaseFromPlanProcedure,
	reorderPlanCasesProcedure,
	reorderTestCasesProcedure,
	resetResultsProcedure,
	restorePlaywrightScriptRevisionProcedure,
	revokeQaSignOffProcedure,
	setTestCaseCoverageTypeProcedure,
	testingSectionCountsProcedure,
	unlinkWorkItemProcedure,
	updateTestCaseProcedure,
	updateTestPlanProcedure,
} from "./procedures/test-cases";
import {
	dismissTestCasePmSyncFailureBatchProcedure,
	dismissTestCasePmSyncFailureProcedure,
	getTestCasePmCapabilitiesProcedure,
	importTestCaseFromPmProcedure,
	listPmTestCasesProcedure,
	retryTestCasePmSyncBatchProcedure,
	retryTestCasePmSyncProcedure,
	syncTestCasesBulkProcedure,
} from "./procedures/test-cases/sync";
import { updateDocumentProcedure } from "./procedures/update-document";
import { updateProjectProcedure } from "./procedures/update-project";
import { getUsageBreakdownProcedure } from "./procedures/usage/get-breakdown";
// AI usage reporting procedures
import { getConfiguredModelsProcedure } from "./procedures/usage/get-configured-models";
import { getUsageSummaryProcedure } from "./procedures/usage/get-summary";
import { getUsageTimeSeriesProcedure } from "./procedures/usage/get-time-series";
import { listRecentUsageProcedure } from "./procedures/usage/list-recent";
import { getVersionProcedure } from "./procedures/versions/get-version";
import { listVersionsProcedure } from "./procedures/versions/list-versions";
import { restoreVersionProcedure } from "./procedures/versions/restore-version";

export const projectsRouter = {
	// Project operations
	list: listProjectsProcedure,
	get: getProjectProcedure,
	create: createProjectProcedure,
	update: updateProjectProcedure,
	delete: deleteProjectProcedure,
	bulkDelete: bulkDeleteProjectsProcedure,
	restore: restoreProjectProcedure,
	permanentDelete: permanentDeleteProjectProcedure,
	stats: getProjectStatsProcedure,
	documentRecommendations: getDocumentRecommendationsProcedure,
	documentContext: getDocumentContextProcedure,
	specContext: retrieveSpecContextProcedure,
	saveDraft: saveDraftProjectProcedure,
	listDrafts: listDraftProjectsProcedure,
	// "Shared with me" — cross-org guest projects for the Personal workspace
	listGuest: listGuestProjectsProcedure,
	// Quick-access shortcuts (#1694). Flat keys — a fourth nesting level makes
	// the oRPC RPC link fall back to dot-separated paths and 404.
	shortcuts: listProjectShortcutsProcedure,
	setFavorite: setProjectFavoriteProcedure,
	recordVisit: recordProjectVisitProcedure,
	checkName: checkProjectNameProcedure,
	// Create-vs-Enrich routing for extracted action items — a project-level
	// opt-in read at ingestion time by all four capture-as-is analyzers.
	setActionItemRouting: setActionItemRoutingProcedure,
	kanbanPreference: {
		get: getKanbanUserPreferenceProcedure,
		update: updateKanbanUserPreferenceProcedure,
	},
	roadmapView: {
		get: getRoadmapViewProcedure,
		update: updateRoadmapViewProcedure,
		reorderStoryOrder: reorderRoadmapStoryOrderProcedure,
	},
	// Project-tab customization (Fizzy #1837): admin-level visibility overrides
	// + per-user personal prefs, both read by the web tab-bar resolver.
	tabVisibility: {
		get: getProjectTabVisibilityProcedure,
		set: setProjectTabVisibilityProcedure,
	},
	tabPreferences: {
		get: getProjectTabPreferencesProcedure,
		set: setProjectTabPreferencesProcedure,
	},

	// Document operations
	documents: {
		list: listDocumentsProcedure,
		get: getDocumentProcedure,
		create: createDocumentProcedure,
		update: updateDocumentProcedure,
		updateWithContext: updateDocumentWithContextProcedure,
		// Living Documents scheduled auto-refresh enrollment (feature-flagged)
		getAutoRefresh: getDocumentAutoRefreshProcedure,
		setAutoRefresh: setDocumentAutoRefreshProcedure,
		// A refresh PROPOSES by default; these are the human accept/reject half.
		applyAutoRefreshProposal: applyDocumentAutoRefreshProposalProcedure,
		discardAutoRefreshProposal: discardDocumentAutoRefreshProposalProcedure,
		acknowledgeDecisionPrecheck: acknowledgeDecisionPrecheckProcedure,
		delete: deleteDocumentProcedure,
		deleteAll: deleteAllDocumentsProcedure,
		generate: generateDocumentProcedure,
		rejectRegeneration: rejectRegenerationProcedure,
		batchGenerate: batchGenerateDocumentsProcedure,
		setActive: setActiveDocumentProcedure,
		fetchMeetingNotes: fetchMeetingNotesProcedure,
		executeGitHubTool: executeGitHubToolProcedure,
		executeGitLabTool: executeGitLabToolProcedure,

		// Version operations
		versions: {
			list: listVersionsProcedure,
			get: getVersionProcedure,
			restore: restoreVersionProcedure,
		},

		// Media operations (images, diagrams) — flattened to avoid 4-level nesting
		// which causes oRPC RPCLink to use dot-separated paths (404)
		createMediaUploadUrl: createMediaUploadUrlProcedure,
		resolveMediaUrls: resolveMediaUrlsProcedure,
		deleteMedia: deleteMediaProcedure,

		// Skill-generated artifacts (architecture diagrams, etc.)
		listAssets: listDocumentAssetsProcedure,

		// Resolve which @mention user IDs are still active project/org members
		resolveActiveMentions: resolveActiveMentionsProcedure,

		// Mention popover candidate search (project owner + accepted ProjectMembers)
		searchMentionables: searchMentionablesProcedure,
	},

	// Context operations
	contexts: {
		list: listContextsProcedure,
		create: createContextProcedure,
		delete: deleteContextProcedure,
		embed: embedProjectContextsProcedure,
		createUploadUrl: createContextUploadUrlProcedure,
		createDownloadUrl: createContextDownloadUrlProcedure,
		createBatchDownloadUrl: createContextsBatchDownloadUrlProcedure,
		processFile: processContextFileProcedure,
		processLink: processContextLinkProcedure,
		// Context Source Type Labeling (Fizzy #1888) — type label + AI
		// instructions on any source, independent of the LINK crawl settings
		updateMetadata: updateContextMetadataProcedure,
		// URL Context Sources (spec 2026-05-13-url-context-sources)
		updateUrlSource: updateUrlSourceProcedure,
		resyncUrlSource: resyncUrlSourceProcedure,
		cancelUrlSourceCrawl: cancelUrlSourceCrawlProcedure,
		// Unified Context Uploader Wizard (spec 2026-05-23) — batch helper
		// for the Discard Draft path; per-row cancel still uses
		// `cancelUrlSourceCrawl` above.
		cancelDraftCrawls: cancelDraftCrawlsProcedure,
		resyncUrlPage: resyncUrlPageProcedure,
		listUrlPages: listUrlPagesProcedure,
		getUrlPageContent: getUrlPageContentProcedure,
		// Integration context helpers
		listAvailableTeamsChats: listAvailableTeamsChatsProcedure,
		listAvailableSlackChannels: listAvailableSlackChannelsProcedure,
		googleDocsPickerSession: googleDocsPickerSessionProcedure,
		addGoogleDocs: addGoogleDocsContextProcedure,
		// Context Summarization — admin-triggered + poll + read
		summarize: summarizeContextProcedure,
		summaryStatus: contextSummaryStatusProcedure,
		getSummary: getContextSummaryProcedure,
		resolveSummaryReference: resolveContextSummaryReferenceProcedure,
		// Context Summary controls — cancel, history, view/restore, manual edit, sources
		cancelSummary: cancelContextSummaryProcedure,
		summaryHistory: listContextSummaryHistoryProcedure,
		getSummaryVersion: getContextSummaryVersionProcedure,
		restoreSummaryVersion: restoreContextSummaryVersionProcedure,
		updateSummary: updateContextSummaryProcedure,
		summarySources: listContextSummarySourcesProcedure,
	},

	// RAG settings operations
	ragSettings: {
		get: getRagSettingsProcedure,
		update: updateRagSettingsProcedure,
		reprocess: reprocessContextsProcedure,
	},

	// Project-level Databricks Vector Search knowledge binding (read-only)
	databricksKnowledge: {
		get: getProjectDatabricksKnowledgeProcedure,
		save: saveProjectDatabricksKnowledgeProcedure,
		delete: deleteProjectDatabricksKnowledgeProcedure,
	},

	// Security & accessibility scanning
	scan: {
		config: {
			get: getScanConfigProcedure,
			update: updateScanConfigProcedure,
		},
		trigger: triggerScanProcedure,
		// Best-effort cancel of a running scan — terminates the workflow and
		// flips the row terminal so the UI leaves "Scanning…" immediately.
		cancel: cancelScanProcedure,
		latest: getLatestScanProcedure,
		runs: listScansProcedure,
		activity: listActivityProcedure,
		// Per-branch scan status (Scanned / Stale / Not scanned / Scanning) for
		// the incremental-scan branch panel.
		branches: listBranchScanStatusProcedure,
		findings: {
			list: listFindingsProcedure,
			update: updateFindingProcedure,
			bulkUpdate: bulkUpdateFindingsProcedure,
		},
		review: {
			start: startReviewProcedure,
			latest: getReviewProcedure,
			apply: applyReviewProcedure,
			cancel: cancelReviewProcedure,
		},
		grouping: {
			start: startGroupingProcedure,
			latest: getGroupingProcedure,
			apply: applyGroupingProcedure,
			readd: readdGroupingThemeProcedure,
			cancel: cancelGroupingProcedure,
			reattach: reattachGroupingProcedure,
		},
	},

	// Conversation-project attachments
	conversations: {
		attach: attachProjectProcedure,
		detach: detachProjectProcedure,
		getProject: getConversationProjectProcedure,
	},

	// Project PRD source operations
	prdSource: {
		sync: syncPrdSourceProcedure,
		status: getPrdSourceStatusProcedure,
		content: getPrdSourceContentProcedure,
		clear: clearPrdSourceProcedure,
		bindNotionPage: bindNotionPageProcedure,
	},

	// Meeting transcript sync operations
	meetingTranscriptSync: {
		linkMeeting: linkMeetingProcedure,
		unlinkMeeting: unlinkMeetingProcedure,
		setMeetingSyncActive: setMeetingSyncActiveProcedure,
		restoreMeeting: restoreMeetingProcedure,
		repairSync: repairSyncProcedure,
		listDeletedMeetings: listDeletedMeetingsProcedure,
		listLinkedMeetings: listLinkedMeetingsProcedure,
		enable: enableMeetingTranscriptSyncProcedure,
		disable: disableMeetingTranscriptSyncProcedure,
		listTranscripts: listSyncedTranscriptsProcedure,
		getContext: getTranscriptContextProcedure,
		getContent: getTranscriptContentProcedure,
		triggerSync: triggerSyncNowProcedure,
		setAutoAnalyze: setAutoAnalyzeProcedure,
	},

	// Project readiness checklist — computed on read, never stored
	readiness: {
		get: getReadinessProcedure,
		markSeen: markReadinessSeenProcedure,
		snooze: snoozeReadinessItemProcedure,
		setNotApplicable: setReadinessItemNotApplicableProcedure,
		requestHelp: requestReadinessHelpProcedure,
	},

	// Meeting Digest (read-only aggregation + admin include/exclude)
	meetingDigest: {
		listDigest: listDigestProcedure,
		getMeeting: getMeetingProcedure,
		setIncluded: setIncludedProcedure,
		listConfigurable: listConfigurableMeetingsProcedure,
		extractInsights: extractInsightsProcedure,
		setActionItemCompleted: setActionItemCompletedProcedure,
		generateProposals: generateProposalsProcedure,
		proposeActionItem: proposeActionItemProcedure,
		// #1902 — action item to work item links. Matching is fire-and-forget
		// (mirrors extractInsights); add/remove are PROJECT_READ because the
		// card puts link curation in every project member's hands.
		linkActionItems: linkActionItemsProcedure,
		addActionItemLink: addActionItemLinkProcedure,
		removeActionItemLink: removeActionItemLinkProcedure,
		// #1899 — personal calendar meetings. Separate procedures, never a flag
		// on listDigest: FR4 requires personal data to be structurally absent
		// from the team-facing response, not absent because a boolean was right.
		listPersonalMeetings: listPersonalMeetingsProcedure,
		getPersonalTranscript: getPersonalTranscriptProcedure,
		// Ephemeral summary + action items for a personal meeting. Same
		// never-persisted contract as the transcript read it builds on.
		getPersonalInsights: getPersonalInsightsProcedure,
		// #2170 — the ONE personal-lane procedure that persists, and only on an
		// explicit, confirmed user action. Gated by its own
		// MEETING_CONTEXT_IMPORT flag on top of PERSONAL_MEETINGS, requires
		// CONTEXT_CREATE like any other way of adding project context, and is
		// audited asymmetrically: SUCCESS is recorded by the activity middleware
		// (a lean row, no input snapshot) because publishing content into an
		// org-visible project is exactly what an audit trail is for, while
		// FAILURE is suppressed in the error middleware — that one snapshots the
		// input, and a throw means the import did not happen, so the row would
		// leak a still-private meeting's join URL for nothing.
		importPersonalMeeting: importPersonalMeetingProcedure,
		// #1901a — upcoming calendar occurrences. The digest is otherwise
		// backward-only (buildDigestRows maps over synced transcripts), so there
		// was nowhere to hang a pre-meeting affordance.
		listUpcoming: listUpcomingMeetingsProcedure,
		// #1901 — pre-meeting agenda. Reading is PROJECT_READ for every member;
		// generating writes the SHARED row, so it is PROJECT_UPDATE like editing.
		getAgenda: getAgendaProcedure,
		generateAgenda: generateAgendaProcedure,
		saveAgenda: saveAgendaProcedure,
	},

	// Teams channel monitor operations
	teamsChannelMonitor: {
		linkChannel: linkChannelProcedure,
		unlinkChannel: unlinkChannelProcedure,
		listLinkedChannels: listLinkedChannelsProcedure,
		enable: enableTeamsChannelMonitorProcedure,
		disable: disableTeamsChannelMonitorProcedure,
		triggerMonitor: triggerMonitorNowProcedure,
		pendingProposals: {
			list: listPendingProposalsProcedure,
			get: getPendingProposalProcedure,
			count: countPendingProposalsProcedure,
			approve: approvePendingProposalProcedure,
			reject: rejectPendingProposalProcedure,
			backlog: backlogPendingProposalProcedure,
		},
	},

	// Slack channel monitor operations (event-driven equivalent to the Teams
	// channel monitor — fanout from the Slack webhook keeps it fresh).
	slackChannelMonitor: {
		linkChannel: linkSlackChannelProcedure,
		unlinkChannel: unlinkSlackChannelProcedure,
		listLinkedChannels: listLinkedSlackChannelsProcedure,
		enable: enableSlackChannelMonitorProcedure,
		disable: disableSlackChannelMonitorProcedure,
		triggerMonitor: triggerSlackMonitorNowProcedure,
		pendingProposals: {
			list: listSlackPendingProposalsProcedure,
			get: getSlackPendingProposalProcedure,
			count: countSlackPendingProposalsProcedure,
			approve: approveSlackPendingProposalProcedure,
			reject: rejectSlackPendingProposalProcedure,
			backlog: backlogSlackPendingProposalProcedure,
		},
	},

	// Slack huddle notes ingestion (poll-based, passive AI-Updates context —
	// independent of the event-driven slackChannelMonitor above).
	slackHuddleIngest: {
		enable: enableSlackHuddleIngestProcedure,
		disable: disableSlackHuddleIngestProcedure,
		triggerNow: triggerSlackHuddleIngestNowProcedure,
	},

	// Teams chat monitor operations (group chats only — parallel to channel monitor)
	teamsChatMonitor: {
		linkChat: linkChatProcedure,
		unlinkChat: unlinkChatProcedure,
		listLinkedChats: listLinkedChatsProcedure,
		enable: enableTeamsChatMonitorProcedure,
		disable: disableTeamsChatMonitorProcedure,
		triggerMonitor: triggerChatMonitorNowProcedure,
		pendingProposals: {
			list: listChatPendingProposalsProcedure,
			get: getChatPendingProposalProcedure,
			count: countChatPendingProposalsProcedure,
			approve: approveChatPendingProposalProcedure,
			reject: rejectChatPendingProposalProcedure,
			backlog: backlogChatPendingProposalProcedure,
		},
	},

	// Member operations
	members: {
		list: listMembersProcedure,
		invite: inviteMemberProcedure,
		lookupEmail: lookupEmailStatusProcedure,
		remove: removeMemberProcedure,
		updateRole: updateMemberRoleProcedure,
		getEligible: getEligibleUsersProcedure,
		listSentInvitations: listSentInvitationsProcedure,
		resendInvitation: resendProjectInvitationProcedure,
		revokeInvitation: revokeProjectInvitationProcedure,

		// Invitation operations
		invitations: {
			list: listInvitationsProcedure,
			accept: acceptInvitationProcedure,
			decline: declineInvitationProcedure,
			getWelcomeWidget: getWelcomeWidgetProcedure,
			dismissWelcomeWidget: dismissWelcomeWidgetProcedure,
		},
	},

	// Repository Integrations (project-level shared credentials)
	repositoryIntegrations: {
		list: listRepoIntegrationsProcedure,
		connect: connectRepoIntegrationProcedure,
		disconnect: disconnectRepoIntegrationProcedure,
		health: repoIntegrationHealthProcedure,
		updateBranch: updateRepoIntegrationBranchProcedure,
		attachPat: attachPatToRepoIntegrationProcedure,
		updateTag: updateRepoIntegrationTagProcedure,
		reindex: reindexRepoIntegrationProcedure,
		cancelReindex: cancelReindexRepoIntegrationProcedure,
	},

	// Existing project setup (multi-repo + sequential doc gen)
	existingSetup: {
		start: startExistingSetupProcedure,
	},

	// GitHub code-based setup operations.
	// `startCodeSetup` (the lighter single-repo `codeBasedProjectSetupWorkflow`)
	// was retired in favor of the unified `existingSetup.start` post-create path.
	// `setupStatus` is retained — `ProjectDetails` still polls
	// it for code-analysis progress.
	github: {
		listRepos: listGitHubReposProcedure,
		setupStatus: codeBasedSetupStatusProcedure,
	},

	// GitLab operations. `startCodeSetup` retired with the GitHub one (O1).
	gitlab: {
		listRepos: listGitLabProjectsProcedure,
	},

	// Azure DevOps operations (PAT-based code-repo discovery + setup)
	azureDevOps: {
		listRepos: listAzureDevOpsReposProcedure,
		startCodeSetup: startAzureDevOpsCodeSetupProcedure,
	},

	// Epics & Features (Hierarchy)
	epics: {
		list: listEpicsProcedure,
		create: createEpicProcedure,
		update: updateEpicProcedure,
		delete: deleteEpicProcedure,
	},

	features: {
		list: listFeaturesProcedure,
		create: createFeatureProcedure,
		update: updateFeatureProcedure,
		delete: deleteFeatureProcedure,
	},

	hierarchy: getHierarchyProcedure,

	// Backlog Analysis (Contextual Backlog Updater)
	backlog: {
		listMeetings: listCalendarMeetingsProcedure,
		startAnalysis: startAnalysisProcedure,
		analysisProgress: analysisProgressProcedure,
		applyChanges: applyChangesProcedure,
		applyProgress: applyProgressProcedure,

		// Persisted, team-shared in-review proposal drafts (one per proposal+kind)
		drafts: {
			start: startProposalDraftProcedure,
			list: getProposalDraftsProcedure,
			cancel: cancelProposalDraftProcedure,
		},

		// Failed-proposal recovery (AI Update sidebar + Teams/Slack failures)
		proposals: {
			failedCount: getFailedProposalsCountProcedure,
			backlogCount: getBacklogProposalsCountProcedure,
			retry: retryFailedProposalProcedure,
			retryAllFailed: retryAllFailedProposalsProcedure,
			dismiss: dismissFailedProposalProcedure,
			cancel: cancelPendingProposalProcedure,
		},

		// Read-only AI Backlog change history (Session history + Audit tabs)
		history: {
			sessions: {
				list: listBacklogSessionHistoryProcedure,
				get: getBacklogSessionHistoryProcedure,
			},
			audit: {
				list: listBacklogAuditHistoryProcedure,
			},
		},
	},

	// Architecture Decision Log (ADL)
	architectureDecisions: {
		list: listArchitectureDecisionsProcedure,
		get: getArchitectureDecisionProcedure,
		create: createArchitectureDecisionProcedure,
		update: updateArchitectureDecisionProcedure,
		delete: deleteArchitectureDecisionProcedure,
		acknowledge: acknowledgeArchitectureDecisionProcedure,
		comments: {
			list: listArchitectureDecisionCommentsProcedure,
			create: createArchitectureDecisionCommentProcedure,
		},
		versions: {
			list: listArchitectureDecisionVersionsProcedure,
			revert: revertArchitectureDecisionVersionProcedure,
		},
		meetingDecisions: {
			list: listMeetingDecisionCandidatesProcedure,
			createFrom: createDecisionFromMeetingProcedure,
			dismiss: dismissMeetingDecisionProcedure,
		},
		types: {
			list: listDecisionTypesProcedure,
			archive: archiveDecisionTypeProcedure,
			restore: restoreDecisionTypeProcedure,
		},
		suggestMetadata: suggestDecisionMetadataProcedure,
		pin: pinArchitectureDecisionProcedure,
		vouch: vouchArchitectureDecisionProcedure,
		view: {
			get: getDecisionsViewProcedure,
			update: updateDecisionsViewProcedure,
		},
		// Read-only admin list of accepted decision pre-check overrides
		overrides: {
			list: listDecisionOverridesProcedure,
		},
	},

	// Test Cases (authoring, work-item links, coverage rollup, plans, AI draft)
	testCases: {
		list: listTestCasesProcedure,
		/** Badge counts for the Testing tab's six sections, in one round trip. */
		sectionCounts: testingSectionCountsProcedure,
		get: getTestCaseProcedure,
		create: createTestCaseProcedure,
		update: updateTestCaseProcedure,
		delete: deleteTestCaseProcedure,
		reorder: reorderTestCasesProcedure,
		clone: cloneTestCaseProcedure,
		// The update path for cases whose feature text changed after they were
		// drafted: list what drifted, ask for a proposal, then accept or reject.
		// Accept/reject is the control — an AI proposes a suite change, a person
		// makes it.
		// Per-case coverage detail behind the richer traceability matrix: what
		// KIND of coverage a criterion has, where it lives, which commit last
		// proved it, and whether it still matches the feature.
		coverageIndex: {
			get: getCoverageIndexProcedure,
			setType: setTestCaseCoverageTypeProcedure,
		},
		// Who has approved a feature, and how many approvals the project wants.
		// The gate that reads them lives on the DONE transition in update-story.
		signOffs: {
			get: getQaSignOffsProcedure,
			record: recordQaSignOffProcedure,
			revoke: revokeQaSignOffProcedure,
		},
		drift: {
			list: listDriftedTestCasesProcedure,
			propose: proposeTestCaseStepsProcedure,
			// Same storage and the same Accept/Reject gate as `propose`; the
			// difference is what the steps were checked against, which is recorded
			// on the case so accepting knows whether it may clear the drift flag.
			proposeFromImplementation:
				proposeTestCaseStepsFromImplementationProcedure,
			accept: acceptTestCaseStepsProcedure,
			reject: rejectTestCaseStepsProcedure,
		},
		// Bulk by explicit ids OR by filter ("Select all N matching"), applied
		// server-side so the action covers the whole result set, not the page
		// the browser happens to have loaded.
		bulk: bulkMutateTestCasesProcedure,
		bulkDelete: bulkDeleteTestCasesProcedure,
		linkWorkItem: linkWorkItemProcedure,
		unlinkWorkItem: unlinkWorkItemProcedure,
		// Starts a durable background drafting run and returns its job id — the
		// drafting itself happens in a Temporal workflow, so the caller is free
		// the moment this returns.
		aiDraft: aiDraftTestCasesProcedure,
		// The run ledger: `list` is how a client rediscovers an in-flight run
		// after a reload, `get` resolves a finished run's batch of cases.
		draftJobs: {
			list: listTestCaseDraftJobsProcedure,
			get: getTestCaseDraftJobProcedure,
			cancel: cancelTestCaseDraftJobProcedure,
			// The QA tab's per-feature run history: every drafting run that
			// covered one feature, project-wide (not just the caller's).
			forFeature: listFeatureDraftRunsProcedure,
		},
		coverageForStory: coverageForStoryProcedure,
		// Batched sibling of `coverageForStory`: one row per work item with its
		// coverage rollup, searchable + paginated (the per-story call would be
		// N+1 across a features list or a picker).
		featureCoverage: listFeatureCoverageProcedure,
		// Run results: manual mark, project reset-all (history preserved),
		// and the per-case provenance history.
		recordResult: recordResultProcedure,
		resetResults: resetResultsProcedure,
		resultHistory: getResultHistoryProcedure,
		// The edit half of the per-case Activity timeline (merged client-side
		// with resultHistory).
		activityHistory: getActivityHistoryProcedure,
		generatePlaywrightScript: generatePlaywrightScriptProcedure,
		playwrightScript: {
			sources: listPlaywrightScriptSourcesProcedure,
			revisions: listPlaywrightScriptRevisionsProcedure,
			revision: getPlaywrightScriptRevisionProcedure,
			restore: restorePlaywrightScriptRevisionProcedure,
		},
		plans: {
			list: listTestPlansProcedure,
			get: getTestPlanProcedure,
			create: createTestPlanProcedure,
			update: updateTestPlanProcedure,
			delete: deleteTestPlanProcedure,
			addCase: addCaseToPlanProcedure,
			removeCase: removeCaseFromPlanProcedure,
			reorderCases: reorderPlanCasesProcedure,
		},
		sync: {
			bulk: syncTestCasesBulkProcedure,
			importFromPm: importTestCaseFromPmProcedure,
			listPmTestCases: listPmTestCasesProcedure,
			pmCapabilities: getTestCasePmCapabilitiesProcedure,
			retry: retryTestCasePmSyncProcedure,
			retryBatch: retryTestCasePmSyncBatchProcedure,
			dismiss: dismissTestCasePmSyncFailureProcedure,
			dismissBatch: dismissTestCasePmSyncFailureBatchProcedure,
		},
	},

	// Automated-test pipeline results — read surface for the QA tab.
	// Ingestion is driven by the temporal pipeline-results activities; these
	// procedures expose the recent runs and per-source fetch state for display.
	// Per-project QA policy (Settings ▸ Testing) + the deployment targets it
	// references (Settings ▸ Environments).
	qaSettings: {
		get: getProjectQaSettingsProcedure,
		update: updateProjectQaSettingsProcedure,
		webhook: {
			get: getProjectQaWebhookProcedure,
			create: createProjectQaWebhookProcedure,
			rotate: rotateProjectQaWebhookProcedure,
			updateExpiry: updateProjectQaWebhookExpiryProcedure,
			revoke: revokeProjectQaWebhookProcedure,
		},
	},
	// The QA open-questions log — testing unknowns tracked to resolution.
	qaOpenQuestions: {
		list: listQaOpenQuestionsProcedure,
		create: createQaOpenQuestionProcedure,
		update: updateQaOpenQuestionProcedure,
		delete: deleteQaOpenQuestionProcedure,
	},
	environments: {
		list: listProjectEnvironmentsProcedure,
		create: createProjectEnvironmentProcedure,
		update: updateProjectEnvironmentProcedure,
		delete: deleteProjectEnvironmentProcedure,
		/**
		 * Sign-in credentials for a target. Read returns a REDACTED summary; the
		 * secret has no read path to any client. Consumed by the agentic runner.
		 */
		credentials: {
			list: listEnvironmentCredentialsProcedure,
			set: setEnvironmentCredentialProcedure,
		},
	},

	/**
	 * Fabric-orchestrated test runs — a browser driven through a case's authored
	 * steps against a deployment target. Distinct from `pipelineResults`, which
	 * ingests runs the customer's own CI executed.
	 */
	agenticRuns: {
		dispatch: dispatchAgenticRunProcedure,
		list: listAgenticRunsProcedure,
		listPage: listAgenticRunsPageProcedure,
		get: getAgenticRunProcedure,
		cancel: cancelAgenticRunProcedure,
		/** Saved, reusable run shapes (mocks C8) — the run dialog's picker. */
		configurations: {
			list: listRunConfigurationsProcedure,
			create: createRunConfigurationProcedure,
			update: updateRunConfigurationProcedure,
			delete: deleteRunConfigurationProcedure,
		},
	},

	pipelineResults: {
		/** CI config a team can commit so its pipeline reports back. */
		ciConfigTemplate: getCiConfigTemplateProcedure,
		listRuns: listPipelineRunsProcedure,
		listRunsPage: listPipelineRunsPageProcedure,
		runDetail: pipelineRunDetailProcedure,
		unmatchedTests: listUnmatchedAutomatedTestsProcedure,
		syncStates: listPipelineSyncStatesProcedure,
		/** Per-repository sync health for Settings ▸ Development (card #2383). */
		syncHealth: getProjectRepositoryPipelineSyncHealthProcedure,
		sync: syncPipelineResultsProcedure,
		sources: listQaPipelineSourcesProcedure,
		setBranch: setQaPipelineBranchProcedure,
		/** Start a run in the customer's existing CI. */
		triggerable: listTriggerablePipelinesProcedure,
		trigger: triggerPipelineProcedure,
		/** Distinct CI failures tracked across runs.
		 * Named QA-explicitly: `listFindingsProcedure` already belongs to the
		 * SECURITY SCAN surface, and importing both unqualified made this
		 * registration silently resolve to that one. */
		findings: listQaFindingsProcedure,
		promoteFinding: promoteQaFindingProcedure,
		dismissFinding: dismissQaFindingProcedure,
		mergeFindings: mergeQaFindingsProcedure,
		analyseFinding: analyseQaFindingProcedure,
	},

	/**
	 * Pull requests Fabric has read.
	 *
	 * Ingest only: `read` fetches a PR's metadata and diff through the project's
	 * own repository credential and stores what it saw. No model is involved —
	 * the review lenses are built on top of this, against an ingest that can be
	 * inspected on its own.
	 */
	pullRequestReviews: {
		list: listPullRequestReviewsProcedure,
		get: getPullRequestReviewProcedure,
		read: readPullRequestProcedure,
		/**
		 * The QA lens (phase 2). Separate from `read` because the read is a fact
		 * that costs an API call and this is a judgement that costs credits — so
		 * re-reading a PR after a new commit never silently re-bills an analysis.
		 */
		analyseQa: analysePullRequestQaProcedure,
		/**
		 * The architecture lens (phase 3). COMPUTED from Atlas's import graph, not
		 * asked of a model — which is why it needs no false-positive gate: a cycle
		 * either exists in the graph or it does not.
		 */
		analyseArchitecture: analysePullRequestArchitectureProcedure,
		judgeFinding: setPullRequestFindingStatusProcedure,
		/**
		 * Each lens's FALSE-POSITIVE rate, project-wide — findings dismissed as
		 * "not correct" over findings judged, against the feature's stated
		 * target. Not the dismissal rate, which counts three reasons a CORRECT
		 * finding went unactioned.
		 */
		lensStats: getPrReviewLensStatsProcedure,
		/**
		 * Put the findings back on the pull request, as one comment per pull
		 * request edited in place. This procedure is the button; the webhook
		 * posts the same comment for projects that opted into automatic review.
		 */
		postComment: postPullRequestReviewCommentProcedure,
	},

	// Publishing Suite (AI-suggested + manual topic pipeline)
	publishingSuite: {
		listTopics: listPublishingTopicsProcedure,
		// #1851 (2A-1): the Topic Item Page's single-topic read. Returns the
		// same enriched shape `listTopics` returns, so the page header and the
		// Inbox row cannot drift apart.
		getTopic: getPublishingTopicProcedure,
		latestCycle: latestPublishingCycleProcedure,
		listCycles: listPublishingCyclesProcedure,
		cycleChatDeliveries: listCycleChatDeliveriesProcedure,
		createTopic: createPublishingTopicProcedure,
		updateTopicStatus: updatePublishingTopicStatusProcedure,
		updateTopicPostTypes: updatePublishingTopicPostTypesProcedure,
		setTopicSnooze: setTopicSnoozeProcedure,
		setTopicReadState: setTopicReadStateProcedure,
		getSettings: getPublishingSuiteSettingsProcedure,
		updateSettings: updatePublishingSuiteSettingsProcedure,
		generateNow: generatePublishingTopicsNowProcedure,
		// #1851 (2A-2): the topic's planning worksheet. `getPlanningAnalysis`
		// returns TWO rows — the latest attempt and the latest READY one — so a
		// failed regeneration cannot blank a good analysis the reader still wants.
		generatePlanningAnalysis: generatePlanningAnalysisProcedure,
		getPlanningAnalysis: getPlanningAnalysisProcedure,
		// #1851 (2A-3): the topic's decision thread — questions, their answers,
		// and the AI Updates a regeneration writes.
		listTopicDecisions: listTopicDecisionsProcedure,
		answerTopicQuestion: answerTopicQuestionProcedure,
		// #1853 (2B-1): the topic's generated-draft state, and the poll target
		// while a generation runs. Like `getPlanningAnalysis`, it returns TWO
		// rows per content type — the latest attempt and the latest READY one —
		// so a failed regeneration cannot blank a good draft the reader still
		// wants.
		listTopicDrafts: listTopicDraftsProcedure,
		// #1853 (2B-2): Short Post / Tweet. `generateShortPost` starts one run
		// and returns immediately — the panel polls `listTopicDrafts` for the
		// result. `selectShortPostOption` adopts one of the three generated
		// options as the topic's working draft; it takes the option's LABEL, not
		// its text, and reads the text from the stored draft.
		generateShortPost: generateShortPostProcedure,
		selectShortPostOption: selectShortPostOptionProcedure,
		// #1853 (2B-3): Blog Post. `generateBlogPost` starts one run the panel
		// polls for, and the FIRST run seeds the topic's working draft inside
		// the activity (DV5/FR21) — which is why this pair exists where the
		// short post needs only one: `adoptBlogPostDraft` replaces a body that
		// already exists, and `saveBlogPostBody` is the editor. Both are
		// compare-and-set on the working draft's `updatedAt`.
		generateBlogPost: generateBlogPostProcedure,
		adoptBlogPostDraft: adoptBlogPostDraftProcedure,
		saveBlogPostBody: saveBlogPostBodyProcedure,
		// #1854 (2C): Case Study. Same three-endpoint shape as the Blog Post —
		// the FIRST run seeds the working draft inside the activity, so
		// `adoptCaseStudyDraft` replaces a body that already exists and
		// `saveCaseStudyBody` is the editor; both are compare-and-set on the
		// working draft's `updatedAt`. The difference from the sibling is one
		// layer down: adoption composes the body with the SHARED
		// `composeCaseStudyWorkingDraftBody`, the same function the activity
		// seeds with, so the two texts cannot drift.
		generateCaseStudy: generateCaseStudyProcedure,
		adoptCaseStudyDraft: adoptCaseStudyDraftProcedure,
		saveCaseStudyBody: saveCaseStudyBodyProcedure,
		// #1854 (2C slice 2): Stakeholder Email, the fourth and last content
		// type. Same three-endpoint shape as the Case Study — the FIRST run
		// seeds the working draft inside the activity, so
		// `adoptStakeholderEmailDraft` replaces a body that already exists and
		// `saveStakeholderEmailBody` is the editor; both are compare-and-set on
		// the working draft's `updatedAt`. Adoption composes the body with the
		// SHARED `composeStakeholderEmailWorkingDraftBody`, the same function
		// the activity seeds with, so the two texts cannot drift.
		generateStakeholderEmail: generateStakeholderEmailProcedure,
		adoptStakeholderEmailDraft: adoptStakeholderEmailDraftProcedure,
		saveStakeholderEmailBody: saveStakeholderEmailBodyProcedure,
	},

	// User Stories & Tasks (Kanban)
	stories: {
		list: listStoriesProcedure,
		// #1902 — meetings whose action items reference this work item (FR5/FR6).
		listMeetingReferences: listMeetingReferencesProcedure,
		listDuplicates: listDuplicatesProcedure,
		scanDuplicates: scanDuplicatesProcedure,
		semanticSearch: semanticSearchProcedure,
		proposeDuplicateMerge: proposeDuplicateMergeProcedure,
		mergeDuplicate: mergeDuplicateProcedure,
		dismissDuplicate: dismissDuplicateProcedure,
		get: getStoryProcedure,
		create: createStoryProcedure,
		update: updateStoryProcedure,
		setBlocked: setBlockedProcedure,
		share: shareStoryProcedure,
		delete: deleteStoryProcedure,
		clear: clearStoriesProcedure,
		createBatchDownloadUrl: createStoriesBatchDownloadUrlProcedure,
		move: moveStoryProcedure,
		reorder: reorderStoriesProcedure,
		reorderRoadmap: reorderStoriesRoadmapProcedure,
		moveRoadmap: moveStoryRoadmapProcedure,
		// Roadmap "Priority" view: shared manual rank, its reset, and the batched
		// decision counts the ranking reads. The within-band ordering is computed
		// client-side.
		reorderPriority: reorderStoriesPriorityProcedure,
		resetPriorityOrder: resetStoriesPriorityOrderProcedure,
		openDecisions: openDecisionsProcedure,
		// Priority BAND writes and their trail. These two are the Priority
		// view's dedicated writers; the other band-changing paths (stories
		// .update, moveRoadmap, the AI backlog apply) reach the SAME
		// recordPriorityMove helper inside their own procedures — that shared
		// helper, not this router, is what keeps `priorityHistory` from ever
		// disagreeing with the field it describes.
		setPriority: setStoryPriorityProcedure,
		reprioritize: reprioritizeStoriesProcedure,
		reprioritizeStory: reprioritizeStoryProcedure,
		priorityHistory: priorityHistoryProcedure,
		pushToKanban: pushToKanbanProcedure,
		queueForKanban: queueForKanbanProcedure,
		generateTasks: generateTasksProcedure,
		regenerateTitle: regenerateStoryTitleProcedure,
		updateDraftingStage: updateDraftingStageProcedure,
		updateStageWithVersion: updateDraftingStageWithVersionProcedure,
		enhance: enhanceFeatureProcedure,
		// Fizzy #2048: the server picks the template for a detail-view action,
		// from the item's STORED kind. The caller sends no kind, no agent name.
		resolvePrompt: resolveStoryPromptProcedure,
		updateWithContext: updateWithContextProcedure,
		// Flip kind (BUG ↔ FEATURE) via the kebab convert-type action. Fizzy
		// #2048: this now also starts a rewrite of the body through the new
		// type's template, whose state is polled through `regenerationStatus`.
		convertKind: convertStoryKindProcedure,
		regenerationStatus: getStoryRegenerationStatusProcedure,
		// F-171: re-runs bug_reanalysis prompt; clears or re-affirms needsMoreInfo
		reevaluateBug: reevaluateBugProcedure,
		// Type-switch reformat: re-runs the proposed body through the target
		// kind's structure prompt when a reviewer flips a proposal Bug ↔ Feature.
		reformatProposalBody: reformatProposalBodyProcedure,
		// Create-vs-Enrich review: merges a proposed action item into a chosen
		// target ticket so the row can diff the real before/after when the
		// reviewer re-targets the enrichment. Persists nothing.
		previewEnrichment: previewEnrichmentProcedure,
		checkPmSyncConflicts: checkPmSyncConflictsProcedure,
		dismissPmSyncConflict: dismissPmSyncConflictProcedure,
		dismissPmSyncFailure: dismissPmSyncFailureProcedure,
		dismissPmSyncFailureBatch: dismissPmSyncFailureBatchProcedure,
		retryPmSync: retryPmSyncProcedure,
		retryPmSyncBatch: retryPmSyncBatchProcedure,

		// Media operations (pasted/dropped images in story descriptions) —
		// flattened to avoid 4-level nesting which causes oRPC RPCLink to
		// use dot-separated paths (404). Mirrors documents.* shape.
		createMediaUploadUrl: createStoryMediaUploadUrlProcedure,
		resolveMediaUrls: resolveStoryMediaUrlsProcedure,
		resolveMediaForAgent: resolveStoryMediaForAgentProcedure,

		// First-class file attachments (#1702 Part 1) — FLAT, mirroring the media
		// block above (4-level nesting would 404 via RPCLink dot-paths).
		createAttachmentUploadUrl: createAttachmentUploadUrlProcedure,
		resolveAttachmentContextForAgent:
			resolveStoryAttachmentContextForAgentProcedure,
		createAttachment: createAttachmentProcedure,
		listAttachments: listAttachmentsProcedure,
		promoteAttachment: promoteAttachmentProcedure,
		removeAttachment: removeAttachmentProcedure,
		setAttachmentDesignation: setAttachmentDesignationProcedure,

		// PM Tool Sync operations
		sync: syncStoryProcedure,
		syncBulk: syncStoriesBulkProcedure,
		syncProgress: syncProgressProcedure,
		cancelSync: cancelSyncProcedure,
		importFromPM: importFromPMProcedure,
		resolveConflict: resolveConflictProcedure,
		proposeAiMerge: proposeAiMergeProcedure,
		listPMTickets: listPMTicketsProcedure,
		pmCapabilities: getPMCapabilitiesProcedure,
		testPMSync: testPMSyncProcedure,
		listProjectTeams: listProjectTeamsProcedure,
		listProjectWorkItemTypes: listProjectWorkItemTypesProcedure,
		getTeamFieldValues: getTeamFieldValuesProcedure,

		// Status (Kanban columns) operations
		statuses: {
			list: listStoryStatusesProcedure,
			create: createStoryStatusProcedure,
			update: updateStoryStatusProcedure,
			delete: deleteStoryStatusProcedure,
			reorder: reorderStoryStatusesProcedure,
		},

		// Version operations
		versions: {
			list: listFeatureVersionsProcedure,
			restore: restoreFeatureVersionProcedure,
		},

		comments: {
			list: listStoryCommentsProcedure,
			create: createStoryCommentProcedure,
		},

		// Feature Maturation V2 — three-tab editor (TG3 non-gated backend).
		// Decision Log / working-notes / approval-mode writes are PM-sync
		// isolated (§7.7); only Clean Spec edits sync, fired by TG4.
		maturation: {
			getEditorState: getEditorStateProcedure,
			getApprovalMode: getApprovalModeProcedure,
			setApprovalMode: setApprovalModeProcedure,
			listDecisionLog: listDecisionLogProcedure,
			appendDecisionEntry: appendDecisionEntryProcedure,
			answerQuestion: answerQuestionProcedure,
			amendAnswer: amendAnswerProcedure,
			ensureSeeded: ensureSeededProcedure,
			setWorkingNotes: setWorkingNotesProcedure,
			summarizeChanges: summarizeChangesProcedure,
			recordChangeNote: recordChangeNoteProcedure,
			acceptCleanSpecPatch: acceptCleanSpecPatchProcedure,
			restoreQuestion: restoreQuestionProcedure,
			searchAssignableMembers: searchAssignableMembersProcedure,
			setQuestionAssignees: setQuestionAssigneesProcedure,
			setAutoProposeAnswers: setAutoProposeAnswersProcedure,
			generateQaAnalysis: generateQaAnalysisProcedure,
			qaAnalysisVersions: listQaAnalysisVersionsProcedure,
			evaluateAiReadiness: evaluateAiReadinessProcedure,
		},

		tags: {
			add: addStoryTagProcedure,
			remove: removeStoryTagProcedure,
			list: listStoryTagsProcedure,
		},

		// Task operations
		tasks: {
			create: createTaskProcedure,
			update: updateTaskProcedure,
			delete: deleteTaskProcedure,
			toggle: toggleTaskProcedure,
			comments: {
				list: listTaskCommentsProcedure,
				create: createTaskCommentProcedure,
			},
			// Task Agent operations
			agent: {
				start: startTaskAgentProcedure,
				status: getAgentStatusProcedure,
				resolveCheckpoint: resolveCheckpointProcedure,
				cancel: cancelTaskAgentProcedure,
				cleanupStuck: cleanupStuckAgentsProcedure,
			},
		},
	},

	// Diagram operations
	diagrams: {
		list: listDiagramsProcedure,
		get: getDiagramProcedure,
		create: createDiagramProcedure,
		createFromChat: createFromChatProcedure,
		update: updateDiagramProcedure,
		delete: deleteDiagramProcedure,
	},

	// AI usage reporting (per-project cost attribution)
	usage: {
		getSummary: getUsageSummaryProcedure,
		getBreakdown: getUsageBreakdownProcedure,
		getTimeSeries: getUsageTimeSeriesProcedure,
		listRecent: listRecentUsageProcedure,
		getConfiguredModels: getConfiguredModelsProcedure,
	},

	// PM State Changes (ADO state polling review)
	pmStateChanges: {
		list: listPendingStateChangesProcedure,
		count: countPendingStateChangesProcedure,
		review: reviewPendingStateChangeProcedure,
		bulkReview: bulkReviewPendingStateChangesProcedure,
		resolveContentDrift: resolveContentDriftProcedure,
		suggestTerminalStatuses: suggestTerminalStatusesProcedure,
	},

	// PM Sync audit log (Sync History tab — read-only)
	pmSyncLog: {
		list: listPmSyncLogProcedure,
	},

	// PM custom field read-mapping — enumerate a project's PM
	// fields and preview a real ticket's values so an admin can pick + order the
	// fields aggregated into Fabric content.
	pm: {
		enumerateFields: enumerateFieldsProcedure,
		previewTicketFields: previewTicketFieldsProcedure,
		suggestFieldMapping: suggestFieldMappingProcedure,
		composeFieldPreview: composeFieldPreviewProcedure,
	},

	// Unified Review Center (live actionable inbox — conflicts/failures/pull-drift)
	reviewCenter: {
		items: getReviewCenterItemsProcedure,
		count: getReviewCenterCountProcedure,
	},

	// Code Indexing (GitHub push webhook for auto-reindex)
	codeIndexing: {
		githubWebhook: githubPushWebhookProcedure,
	},

	// @mentions autocomplete search
	searchCodeFiles: searchCodeFilesProcedure,
	searchStories: searchStoriesProcedure,
};
