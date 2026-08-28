/**
 * Prisma Zod Generator - Single File (inlined)
 * Auto-generated. Do not edit.
 */

import * as z from 'zod';
// File: TransactionIsolationLevel.schema.ts

export const TransactionIsolationLevelSchema = z.enum(['ReadUncommitted', 'ReadCommitted', 'RepeatableRead', 'Serializable'])

export type TransactionIsolationLevel = z.infer<typeof TransactionIsolationLevelSchema>;

// File: UserScalarFieldEnum.schema.ts

export const UserScalarFieldEnumSchema = z.enum(['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt', 'username', 'role', 'banned', 'banReason', 'banExpires', 'onboardingComplete', 'mustChangePassword', 'welcomeEmailSentAt', 'lastSeenAt', 'paymentsCustomerId', 'locale', 'timezone', 'twoFactorEnabled', 'mfaPromptDismissedAt', 'mfaPromptSnoozedUntil', 'onboardingTourState', 'defaultFunctionTags', 'firecrawlApiKey', 'firecrawlEnabled', 'firecrawlConfiguredAt', 'firecrawlLastUsedAt', 'azureAiApiKey', 'azureAiConfiguredAt', 'azureAiEnabled', 'azureAiEndpoint', 'azureAiLastUsedAt', 'azureAiModelRouterName', 'azureAiProjectName', 'azureAiRegion', 'azureAiResourceGroup', 'azureAiSubscriptionId', 'azureAiTenantId', 'azureAiUseModelRouter', 'useDelegatedExecution', 'lastActiveOrganizationId', 'failedLoginAttempts', 'lockedUntil', 'lastFailedLoginAt'])

export type UserScalarFieldEnum = z.infer<typeof UserScalarFieldEnumSchema>;

// File: SessionScalarFieldEnum.schema.ts

export const SessionScalarFieldEnumSchema = z.enum(['id', 'expiresAt', 'ipAddress', 'userAgent', 'userId', 'impersonatedBy', 'activeOrganizationId', 'token', 'createdAt', 'updatedAt', 'twoFactorStepUpGrantedAt'])

export type SessionScalarFieldEnum = z.infer<typeof SessionScalarFieldEnumSchema>;

// File: AccountScalarFieldEnum.schema.ts

export const AccountScalarFieldEnumSchema = z.enum(['id', 'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken', 'expiresAt', 'password', 'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'scope', 'createdAt', 'updatedAt'])

export type AccountScalarFieldEnum = z.infer<typeof AccountScalarFieldEnumSchema>;

// File: VerificationScalarFieldEnum.schema.ts

export const VerificationScalarFieldEnumSchema = z.enum(['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'])

export type VerificationScalarFieldEnum = z.infer<typeof VerificationScalarFieldEnumSchema>;

// File: WaitlistScalarFieldEnum.schema.ts

export const WaitlistScalarFieldEnumSchema = z.enum(['id', 'email', 'name', 'source', 'metadata', 'createdAt'])

export type WaitlistScalarFieldEnum = z.infer<typeof WaitlistScalarFieldEnumSchema>;

// File: PasskeyScalarFieldEnum.schema.ts

export const PasskeyScalarFieldEnumSchema = z.enum(['id', 'name', 'publicKey', 'userId', 'credentialID', 'counter', 'deviceType', 'backedUp', 'transports', 'createdAt', 'aaguid'])

export type PasskeyScalarFieldEnum = z.infer<typeof PasskeyScalarFieldEnumSchema>;

// File: TwoFactorScalarFieldEnum.schema.ts

export const TwoFactorScalarFieldEnumSchema = z.enum(['id', 'secret', 'backupCodes', 'userId', 'verified', 'failedVerificationCount', 'lockedUntil', 'stepUpFailedCount', 'stepUpLockedUntil', 'stepUpEpoch'])

export type TwoFactorScalarFieldEnum = z.infer<typeof TwoFactorScalarFieldEnumSchema>;

// File: OrganizationScalarFieldEnum.schema.ts

export const OrganizationScalarFieldEnumSchema = z.enum(['id', 'name', 'slug', 'logo', 'createdAt', 'metadata', 'paymentsCustomerId', 'timezone', 'firecrawlApiKey', 'firecrawlEnabled', 'firecrawlConfiguredAt', 'firecrawlLastUsedAt', 'azureAiApiKey', 'azureAiConfiguredAt', 'azureAiEnabled', 'azureAiEndpoint', 'azureAiLastUsedAt', 'azureAiModelRouterName', 'azureAiProjectName', 'azureAiRegion', 'azureAiResourceGroup', 'azureAiSubscriptionId', 'azureAiTenantId', 'azureAiUseModelRouter', 'useDelegatedExecution', 'documentAssistantHistoryEnabled', 'featureMaturationV2Enabled', 'aiAnswerRecommendationsEnabled', 'requireTwoFactor', 'attachmentRetentionDays', 'attachmentRetentionDaysUpdatedAt', 'canShareFramesPublicly', 'allowedFrameShareDomains'])

export type OrganizationScalarFieldEnum = z.infer<typeof OrganizationScalarFieldEnumSchema>;

// File: OrganizationRagSettingsScalarFieldEnum.schema.ts

export const OrganizationRagSettingsScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'chunkSize', 'chunkOverlap', 'splitMethod', 'embeddingModel', 'topK', 'similarityThreshold', 'enableReranking', 'createdAt', 'updatedAt'])

export type OrganizationRagSettingsScalarFieldEnum = z.infer<typeof OrganizationRagSettingsScalarFieldEnumSchema>;

// File: MemberScalarFieldEnum.schema.ts

export const MemberScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'role', 'createdAt'])

export type MemberScalarFieldEnum = z.infer<typeof MemberScalarFieldEnumSchema>;

// File: InvitationScalarFieldEnum.schema.ts

export const InvitationScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'email', 'role', 'status', 'teamId', 'expiresAt', 'inviterId', 'createdAt'])

export type InvitationScalarFieldEnum = z.infer<typeof InvitationScalarFieldEnumSchema>;

// File: PurchaseScalarFieldEnum.schema.ts

export const PurchaseScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'type', 'customerId', 'subscriptionId', 'productId', 'status', 'createdAt', 'updatedAt'])

export type PurchaseScalarFieldEnum = z.infer<typeof PurchaseScalarFieldEnumSchema>;

// File: AiCreditAccountScalarFieldEnum.schema.ts

export const AiCreditAccountScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'usedCreditUsd', 'createdAt', 'updatedAt'])

export type AiCreditAccountScalarFieldEnum = z.infer<typeof AiCreditAccountScalarFieldEnumSchema>;

// File: AiOutcomeEventScalarFieldEnum.schema.ts

export const AiOutcomeEventScalarFieldEnumSchema = z.enum(['id', 'featureKey', 'outcome', 'subjectType', 'subjectId', 'modelCanonicalName', 'promptVersionId', 'comment', 'userId', 'organizationId', 'projectId', 'createdAt', 'updatedAt'])

export type AiOutcomeEventScalarFieldEnum = z.infer<typeof AiOutcomeEventScalarFieldEnumSchema>;

// File: AiChatScalarFieldEnum.schema.ts

export const AiChatScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'title', 'messages', 'toolSelectionMode', 'pinned', 'createdAt', 'updatedAt', 'workflowId', 'workflowRunId', 'workflowStatus', 'lastError', 'retryCount', 'lastRetryAt', 'projectId'])

export type AiChatScalarFieldEnum = z.infer<typeof AiChatScalarFieldEnumSchema>;

// File: AiChatMcpConfigScalarFieldEnum.schema.ts

export const AiChatMcpConfigScalarFieldEnumSchema = z.enum(['id', 'chatId', 'mcpConfigId', 'userId', 'organizationId', 'enabled', 'source', 'createdAt', 'updatedAt'])

export type AiChatMcpConfigScalarFieldEnum = z.infer<typeof AiChatMcpConfigScalarFieldEnumSchema>;

// File: ChatDocumentScalarFieldEnum.schema.ts

export const ChatDocumentScalarFieldEnumSchema = z.enum(['id', 'chatId', 'userId', 'organizationId', 'filename', 'mimeType', 'size', 's3Path', 'status', 'errorMessage', 'workflowId', 'workflowRunId', 'workflowStatus', 'lastError', 'retryCount', 'lastRetryAt', 'extractorUsed', 'extractionTime', 'extractionCost', 'pageCount', 'hasTables', 'hasImages', 'createdAt', 'updatedAt'])

export type ChatDocumentScalarFieldEnum = z.infer<typeof ChatDocumentScalarFieldEnumSchema>;

// File: DocumentChunkScalarFieldEnum.schema.ts

export const DocumentChunkScalarFieldEnumSchema = z.enum(['id', 'documentId', 'chatId', 'userId', 'organizationId', 'content', 'chunkIndex', 'metadata', 'createdAt'])

export type DocumentChunkScalarFieldEnum = z.infer<typeof DocumentChunkScalarFieldEnumSchema>;

// File: OrganizationRagProviderScalarFieldEnum.schema.ts

export const OrganizationRagProviderScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'providerName', 'encryptedApiKey', 'endpoint', 'isDefault', 'priority', 'enabled', 'createdAt', 'updatedAt', 'lastUsedAt', 'documentsProcessed', 'totalCost'])

export type OrganizationRagProviderScalarFieldEnum = z.infer<typeof OrganizationRagProviderScalarFieldEnumSchema>;

// File: OrganizationSearchProviderScalarFieldEnum.schema.ts

export const OrganizationSearchProviderScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'providerName', 'encryptedApiKey', 'endpoint', 'isDefault', 'priority', 'enabled', 'createdAt', 'updatedAt', 'lastUsedAt', 'searchesCount', 'totalCost'])

export type OrganizationSearchProviderScalarFieldEnum = z.infer<typeof OrganizationSearchProviderScalarFieldEnumSchema>;

// File: UserRagProviderScalarFieldEnum.schema.ts

export const UserRagProviderScalarFieldEnumSchema = z.enum(['id', 'userId', 'providerName', 'encryptedApiKey', 'endpoint', 'isDefault', 'priority', 'enabled', 'createdAt', 'updatedAt', 'lastUsedAt', 'documentsProcessed', 'totalCost'])

export type UserRagProviderScalarFieldEnum = z.infer<typeof UserRagProviderScalarFieldEnumSchema>;

// File: UserSearchProviderScalarFieldEnum.schema.ts

export const UserSearchProviderScalarFieldEnumSchema = z.enum(['id', 'userId', 'providerName', 'encryptedApiKey', 'endpoint', 'isDefault', 'priority', 'enabled', 'createdAt', 'updatedAt', 'lastUsedAt', 'searchesCount', 'totalCost'])

export type UserSearchProviderScalarFieldEnum = z.infer<typeof UserSearchProviderScalarFieldEnumSchema>;

// File: UserApiKeyScalarFieldEnum.schema.ts

export const UserApiKeyScalarFieldEnumSchema = z.enum(['id', 'userId', 'name', 'keyHash', 'keyPrefix', 'scopes', 'expiresAt', 'lastUsedAt', 'usageCount', 'isActive', 'createdAt', 'updatedAt'])

export type UserApiKeyScalarFieldEnum = z.infer<typeof UserApiKeyScalarFieldEnumSchema>;

// File: OrganizationApiKeyScalarFieldEnum.schema.ts

export const OrganizationApiKeyScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'createdByUserId', 'name', 'keyHash', 'keyPrefix', 'scopes', 'expiresAt', 'lastUsedAt', 'usageCount', 'isActive', 'createdAt', 'updatedAt'])

export type OrganizationApiKeyScalarFieldEnum = z.infer<typeof OrganizationApiKeyScalarFieldEnumSchema>;

// File: AgentScalarFieldEnum.schema.ts

export const AgentScalarFieldEnumSchema = z.enum(['id', 'agentId', 'name', 'displayName', 'description', 'heroEmojis', 'heroImageUrl', 'framework', 'runtimeVersion', 'deploymentUrl', 'status', 'scope', 'userId', 'organizationId', 'config', 'metadata', 'createdAt', 'updatedAt', 'lastHealthCheck', 'lastDeployedAt', 'aiModel', 'aiModelConfig', 'aiProvider', 'useGlobalAiProvider'])

export type AgentScalarFieldEnum = z.infer<typeof AgentScalarFieldEnumSchema>;

// File: AgentTaskScalarFieldEnum.schema.ts

export const AgentTaskScalarFieldEnumSchema = z.enum(['id', 'agentId', 'userId', 'organizationId', 'status', 'stage', 'input', 'state', 'result', 'error', 'workflowId', 'runId', 'framework', 'createdAt', 'updatedAt', 'completedAt'])

export type AgentTaskScalarFieldEnum = z.infer<typeof AgentTaskScalarFieldEnumSchema>;

// File: AgentApprovalScalarFieldEnum.schema.ts

export const AgentApprovalScalarFieldEnumSchema = z.enum(['id', 'taskId', 'userId', 'status', 'changes', 'feedback', 'confidence', 'createdAt', 'decidedAt', 'expiresAt', 'weaveExecutionId', 'weavePlanId', 'weaveContext'])

export type AgentApprovalScalarFieldEnum = z.infer<typeof AgentApprovalScalarFieldEnumSchema>;

// File: IntegrationApprovalScalarFieldEnum.schema.ts

export const IntegrationApprovalScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'pluginSlug', 'endpoint', 'args', 'riskLevel', 'status', 'expiresAt', 'createdAt', 'decidedAt', 'decidedById'])

export type IntegrationApprovalScalarFieldEnum = z.infer<typeof IntegrationApprovalScalarFieldEnumSchema>;

// File: ChannelEventReceiptScalarFieldEnum.schema.ts

export const ChannelEventReceiptScalarFieldEnumSchema = z.enum(['id', 'channel', 'externalEventId', 'receivedAt'])

export type ChannelEventReceiptScalarFieldEnum = z.infer<typeof ChannelEventReceiptScalarFieldEnumSchema>;

// File: ChannelThreadMappingScalarFieldEnum.schema.ts

export const ChannelThreadMappingScalarFieldEnumSchema = z.enum(['id', 'channel', 'channelId', 'threadId', 'status', 'workflowId', 'agentId', 'triggerId', 'userId', 'organizationId', 'lastMessageAt', 'timeoutAt', 'createdAt', 'updatedAt'])

export type ChannelThreadMappingScalarFieldEnum = z.infer<typeof ChannelThreadMappingScalarFieldEnumSchema>;

// File: RegisteredAgentScalarFieldEnum.schema.ts

export const RegisteredAgentScalarFieldEnumSchema = z.enum(['id', 'agentId', 'name', 'displayName', 'description', 'framework', 'deploymentUrl', 'status', 'scope', 'autonomyLevel', 'userId', 'organizationId', 'config', 'metadata', 'lastHealthCheck', 'consecutiveHealthFailures', 'lastHealthError', 'createdAt', 'updatedAt'])

export type RegisteredAgentScalarFieldEnum = z.infer<typeof RegisteredAgentScalarFieldEnumSchema>;

// File: RegisteredAgentSuggestionScalarFieldEnum.schema.ts

export const RegisteredAgentSuggestionScalarFieldEnumSchema = z.enum(['id', 'agentId', 'key', 'userId', 'organizationId', 'kind', 'title', 'description', 'payload', 'state', 'source', 'conversationId', 'createdAt', 'updatedAt'])

export type RegisteredAgentSuggestionScalarFieldEnum = z.infer<typeof RegisteredAgentSuggestionScalarFieldEnumSchema>;

// File: AgentConversationScalarFieldEnum.schema.ts

export const AgentConversationScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'agentId', 'title', 'messages', 'trajectory', 'metadata', 'pinned', 'status', 'createdAt', 'updatedAt', 'parentConversationId', 'carriedOverSummary', 'carriedOverAt'])

export type AgentConversationScalarFieldEnum = z.infer<typeof AgentConversationScalarFieldEnumSchema>;

// File: SDLCArtifactScalarFieldEnum.schema.ts

export const SDLCArtifactScalarFieldEnumSchema = z.enum(['id', 'taskId', 'organizationId', 'stage', 'artifactType', 'name', 'content', 'format', 'metadata', 'version', 'qdrantId', 'createdAt', 'updatedAt'])

export type SDLCArtifactScalarFieldEnum = z.infer<typeof SDLCArtifactScalarFieldEnumSchema>;

// File: SDLCPipelineScalarFieldEnum.schema.ts

export const SDLCPipelineScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'userId', 'organizationId', 'status', 'currentStage', 'stages', 'progress', 'createdAt', 'updatedAt', 'completedAt'])

export type SDLCPipelineScalarFieldEnum = z.infer<typeof SDLCPipelineScalarFieldEnumSchema>;

// File: ProjectScalarFieldEnum.schema.ts

export const ProjectScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'heroEmojis', 'heroImageUrl', 'goals', 'techStack', 'features', 'projectTypes', 'status', 'projectPhase', 'expectedDevelopmentStartDate', 'tags', 'color', 'icon', 'userId', 'organizationId', 'projectManagementMcpServerId', 'projectManagementMcpConfigId', 'projectManagementContainerId', 'projectManagementContainerName', 'projectManagementAdditionalContext', 'logSourceProvider', 'logSourceConfig', 'adoStatePollActive', 'autoPushPmSync', 'syncAttachments', 'attachmentRetentionDays', 'attachmentRetentionDaysUpdatedAt', 'readOnlyMode', 'lastAdoStatePollAt', 'pmTerminalStatuses', 'pmAutoCloseEnabled', 'pmFieldMappingEnabled', 'prdSourceTitle', 'prdSourceUrl', 'prdSourceContextId', 'prdSourceSyncedAt', 'meetingTranscriptSyncEnabled', 'meetingTranscriptSyncIntervalMin', 'meetingTranscriptSyncLastRun', 'meetingTranscriptSyncWorkflowId', 'meetingTranscriptAutoAnalyzeEnabled', 'actionItemRoutingEnabled', 'teamsChannelMonitorEnabled', 'teamsChannelMonitorIntervalMin', 'teamsChannelMonitorQuietWindowMin', 'teamsChannelMonitorLastRun', 'teamsChannelMonitorWorkflowId', 'teamsChatMonitorEnabled', 'teamsChatMonitorIntervalMin', 'teamsChatMonitorQuietWindowMin', 'teamsChatMonitorLastRun', 'teamsChatMonitorWorkflowId', 'slackChannelMonitorEnabled', 'slackChannelMonitorWorkflowId', 'slackChannelMonitorLastRun', 'slackChannelMonitorDebounceMs', 'slackChannelMonitorMaxHoldMs', 'slackHuddleIngestEnabled', 'slackHuddleIngestEnabledAt', 'slackHuddleIngestIntervalMin', 'slackHuddleIngestLastRun', 'slackHuddleIngestWorkflowId', 'repositoryUrl', 'repositoryOwner', 'repositoryName', 'defaultBranch', 'implementationDefaultChannel', 'implementationDefaultProvider', 'implementationDefaultWorkingDirectory', 'primaryWebsiteUrl', 'additionalWebsiteUrls', 'codeAnalysisStatus', 'codeAnalysisWorkflowId', 'draftKey', 'wizardState', 'nextStoryNumber', 'lastDuplicateScanAt', 'hiddenMaturationStatuses', 'clarifyingQuestionFrequency', 'qaStrategyLevel', 'generateManualTestCases', 'applyTddApproach', 'projectTabConfig', 'autoCreateBugsFromFailures', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'scheduledPermanentDeleteAt', 'deletionReminderSentAt'])

export type ProjectScalarFieldEnum = z.infer<typeof ProjectScalarFieldEnumSchema>;

// File: ProjectDocumentScalarFieldEnum.schema.ts

export const ProjectDocumentScalarFieldEnumSchema = z.enum(['id', 'projectId', 'type', 'title', 'content', 'status', 'version', 'generationPrompt', 'generationError', 'generationProgress', 'generationStartedAt', 'generationCompletedAt', 'workflowId', 'runId', 'wordCount', 'lastEditedBy', 'decisionPrecheck', 'source', 'sourceContextId', 'isActive', 'qdrantId', 'embeddedAt', 'contentHash', 'createdAt', 'updatedAt', 'userId', 'organizationId'])

export type ProjectDocumentScalarFieldEnum = z.infer<typeof ProjectDocumentScalarFieldEnumSchema>;

// File: ProjectDocumentAssetScalarFieldEnum.schema.ts

export const ProjectDocumentAssetScalarFieldEnumSchema = z.enum(['id', 'projectDocumentId', 'filename', 'contentType', 'storageKey', 'sizeBytes', 'sha256', 'sortOrder', 'userId', 'organizationId', 'createdAt'])

export type ProjectDocumentAssetScalarFieldEnum = z.infer<typeof ProjectDocumentAssetScalarFieldEnumSchema>;

// File: ProjectContextScalarFieldEnum.schema.ts

export const ProjectContextScalarFieldEnumSchema = z.enum(['id', 'projectId', 'type', 'content', 'qdrantId', 'embeddedAt', 'metadata', 's3Path', 's3Bucket', 'originalFilename', 'mimeType', 'fileSize', 'extractionStatus', 'extractionError', 'extractedAt', 'sourceUrl', 'sourceTitle', 'knowledgeBaseSourceCategory', 'knowledgeBaseSourceCategoryOther', 'urlScope', 'urlMaxPages', 'urlRefreshMode', 'urlNextRefreshAt', 'urlLastSyncedAt', 'urlScheduleId', 'urlActiveWorkflowId', 'sourceType', 'aiInstructions', 'userId', 'organizationId', 'ownerKey', 'createdAt', 'updatedAt'])

export type ProjectContextScalarFieldEnum = z.infer<typeof ProjectContextScalarFieldEnumSchema>;

// File: ProjectReadinessItemStateScalarFieldEnum.schema.ts

export const ProjectReadinessItemStateScalarFieldEnumSchema = z.enum(['id', 'projectId', 'itemKey', 'state', 'personalForUserId', 'snoozeUntil', 'everHelpRequested', 'helpRequestedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectReadinessItemStateScalarFieldEnum = z.infer<typeof ProjectReadinessItemStateScalarFieldEnumSchema>;

// File: ProjectReadinessVerdictScalarFieldEnum.schema.ts

export const ProjectReadinessVerdictScalarFieldEnumSchema = z.enum(['id', 'projectId', 'itemKey', 'isComplete', 'changedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectReadinessVerdictScalarFieldEnum = z.infer<typeof ProjectReadinessVerdictScalarFieldEnumSchema>;

// File: ProjectContextUrlPageScalarFieldEnum.schema.ts

export const ProjectContextUrlPageScalarFieldEnumSchema = z.enum(['id', 'parentContextId', 'projectId', 'pageUrl', 'pageTitle', 'content', 'qdrantId', 'embeddedAt', 'lastFetchedAt', 'etag', 'lastModifiedHeader', 'contentHash', 'chunkCount', 'extractionStatus', 'extractionError', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectContextUrlPageScalarFieldEnum = z.infer<typeof ProjectContextUrlPageScalarFieldEnumSchema>;

// File: ProjectContextConversationBundleScalarFieldEnum.schema.ts

export const ProjectContextConversationBundleScalarFieldEnumSchema = z.enum(['id', 'parentContextId', 'projectId', 'providerThreadId', 'content', 'contentHash', 'messageCount', 'bundleStartedAt', 'bundleEndedAt', 'qdrantId', 'embeddingLeaseAt', 'embeddedAt', 'extractionStatus', 'extractionError', 'userId', 'organizationId', 'ownerKey', 'createdAt', 'updatedAt'])

export type ProjectContextConversationBundleScalarFieldEnum = z.infer<typeof ProjectContextConversationBundleScalarFieldEnumSchema>;

// File: ProjectContextConversationClaimScalarFieldEnum.schema.ts

export const ProjectContextConversationClaimScalarFieldEnumSchema = z.enum(['id', 'parentContextId', 'projectId', 'providerMessageId', 'providerThreadId', 'messageCreatedAt', 'bundleId', 'userId', 'organizationId', 'ownerKey', 'createdAt', 'updatedAt'])

export type ProjectContextConversationClaimScalarFieldEnum = z.infer<typeof ProjectContextConversationClaimScalarFieldEnumSchema>;

// File: ProjectContextPendingVectorCleanupScalarFieldEnum.schema.ts

export const ProjectContextPendingVectorCleanupScalarFieldEnumSchema = z.enum(['id', 'projectId', 'contextIds', 'attempts', 'lastError', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectContextPendingVectorCleanupScalarFieldEnum = z.infer<typeof ProjectContextPendingVectorCleanupScalarFieldEnumSchema>;

// File: ProjectContextSummaryScalarFieldEnum.schema.ts

export const ProjectContextSummaryScalarFieldEnumSchema = z.enum(['id', 'projectId', 'content', 'status', 'trigger', 'coveredThrough', 'snapshotThrough', 'coveredContextCount', 'tokenCount', 'references', 'engineVersion', 'stats', 'sourceSelection', 'manualEdit', 'editedByUserId', 'spentInputTokens', 'spentOutputTokens', 'spentCostMicroUsd', 'model', 'error', 'triggeredByUserId', 'qdrantId', 'embeddedAt', 'supersededById', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectContextSummaryScalarFieldEnum = z.infer<typeof ProjectContextSummaryScalarFieldEnumSchema>;

// File: WizardTempContextScalarFieldEnum.schema.ts

export const WizardTempContextScalarFieldEnumSchema = z.enum(['id', 'sessionId', 'userId', 'organizationId', 'type', 'content', 'qdrantId', 'embeddedAt', 'metadata', 's3Path', 's3Bucket', 'originalFilename', 'mimeType', 'fileSize', 'extractionStatus', 'extractionError', 'extractedAt', 'createdAt', 'expiresAt'])

export type WizardTempContextScalarFieldEnum = z.infer<typeof WizardTempContextScalarFieldEnumSchema>;

// File: DocumentVersionScalarFieldEnum.schema.ts

export const DocumentVersionScalarFieldEnumSchema = z.enum(['id', 'documentId', 'version', 'content', 'changeDescription', 'changedBy', 'createdAt', 'promptVersionId', 'userId', 'organizationId'])

export type DocumentVersionScalarFieldEnum = z.infer<typeof DocumentVersionScalarFieldEnumSchema>;

// File: DocumentAutoRefreshSettingsScalarFieldEnum.schema.ts

export const DocumentAutoRefreshSettingsScalarFieldEnumSchema = z.enum(['id', 'documentId', 'projectId', 'enabled', 'cadence', 'deployPendingSince', 'autoApply', 'pendingContent', 'pendingSummary', 'pendingProposedAt', 'pendingBaselineVersion', 'createdByUserId', 'lastRefreshedAt', 'lastAttemptAt', 'lastRefreshStatus', 'lastRefreshSummary', 'createdAt', 'updatedAt', 'userId', 'organizationId'])

export type DocumentAutoRefreshSettingsScalarFieldEnum = z.infer<typeof DocumentAutoRefreshSettingsScalarFieldEnumSchema>;

// File: ProjectRagSettingsScalarFieldEnum.schema.ts

export const ProjectRagSettingsScalarFieldEnumSchema = z.enum(['id', 'projectId', 'chunkSize', 'chunkOverlap', 'splitMethod', 'embeddingModel', 'topK', 'similarityThreshold', 'enableReranking', 'rerankTopK', 'rerankerProvider', 'enableEpisodicMemory', 'codeSearchEnabled', 'codeSearchProvider', 'codeEmbeddingModel', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectRagSettingsScalarFieldEnum = z.infer<typeof ProjectRagSettingsScalarFieldEnumSchema>;

// File: ProjectScanConfigScalarFieldEnum.schema.ts

export const ProjectScanConfigScalarFieldEnumSchema = z.enum(['id', 'projectId', 'securityEnabled', 'accessibilityEnabled', 'enforcementMode', 'autoScanOnMaturation', 'maturationGate', 'semgrepEnabled', 'gitHistoryEnabled', 'autoReviewFindings', 'scanBranch', 'declinedGroupingThemes', 'customRules', 'severityRubric', 'securityKnowledgePacks', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectScanConfigScalarFieldEnum = z.infer<typeof ProjectScanConfigScalarFieldEnumSchema>;

// File: ProjectScanScalarFieldEnum.schema.ts

export const ProjectScanScalarFieldEnumSchema = z.enum(['id', 'projectId', 'storyId', 'status', 'trigger', 'targetType', 'mode', 'branch', 'securityRequested', 'accessibilityRequested', 'securityFindingCount', 'accessibilityFindingCount', 'modelName', 'inputTokens', 'outputTokens', 'costUsd', 'durationMs', 'error', 'workflowId', 'startedAt', 'completedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectScanScalarFieldEnum = z.infer<typeof ProjectScanScalarFieldEnumSchema>;

// File: ProjectScanCheckpointScalarFieldEnum.schema.ts

export const ProjectScanCheckpointScalarFieldEnumSchema = z.enum(['id', 'projectId', 'branch', 'commitSha', 'lastScanId', 'lastScannedAt', 'changedFileCount', 'changedCommitCount', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectScanCheckpointScalarFieldEnum = z.infer<typeof ProjectScanCheckpointScalarFieldEnumSchema>;

// File: ScanFindingScalarFieldEnum.schema.ts

export const ScanFindingScalarFieldEnumSchema = z.enum(['id', 'scanId', 'projectId', 'storyId', 'category', 'severity', 'title', 'description', 'remediation', 'ruleSource', 'isCustomRule', 'location', 'sourceUrl', 'evidence', 'status', 'confidence', 'fingerprint', 'firstDetectedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ScanFindingScalarFieldEnum = z.infer<typeof ScanFindingScalarFieldEnumSchema>;

// File: ScanActivityScalarFieldEnum.schema.ts

export const ScanActivityScalarFieldEnumSchema = z.enum(['id', 'projectId', 'type', 'scanId', 'findingId', 'storyId', 'summary', 'metadata', 'userId', 'organizationId', 'createdAt'])

export type ScanActivityScalarFieldEnum = z.infer<typeof ScanActivityScalarFieldEnumSchema>;

// File: ScanFindingReviewScalarFieldEnum.schema.ts

export const ScanFindingReviewScalarFieldEnumSchema = z.enum(['id', 'projectId', 'status', 'proposals', 'reviewedCount', 'modelName', 'inputTokens', 'outputTokens', 'costUsd', 'durationMs', 'error', 'workflowId', 'startedAt', 'completedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ScanFindingReviewScalarFieldEnum = z.infer<typeof ScanFindingReviewScalarFieldEnumSchema>;

// File: ScanFindingGroupingScalarFieldEnum.schema.ts

export const ScanFindingGroupingScalarFieldEnumSchema = z.enum(['id', 'projectId', 'scanId', 'status', 'results', 'createdCount', 'updatedCount', 'skippedCount', 'failedCount', 'themeCount', 'findingCount', 'modelName', 'inputTokens', 'outputTokens', 'costUsd', 'durationMs', 'error', 'workflowId', 'startedAt', 'completedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ScanFindingGroupingScalarFieldEnum = z.infer<typeof ScanFindingGroupingScalarFieldEnumSchema>;

// File: ProjectCodeIndexScalarFieldEnum.schema.ts

export const ProjectCodeIndexScalarFieldEnumSchema = z.enum(['id', 'projectId', 'repositoryIntegrationId', 'branch', 'commitSha', 'filesIndexed', 'chunksCreated', 'summariesCreated', 'indexedFileCount', 'totalFileCount', 'indexedAt', 'indexDurationMs', 'status', 'error', 'lastFullIndexAt', 'lastIncrementalAt', 'fileManifest', 'redactionManifest', 'workflowId', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectCodeIndexScalarFieldEnum = z.infer<typeof ProjectCodeIndexScalarFieldEnumSchema>;

// File: CodeSymbolScalarFieldEnum.schema.ts

export const CodeSymbolScalarFieldEnumSchema = z.enum(['id', 'projectId', 'name', 'type', 'filePath', 'lineStart', 'lineEnd', 'signature', 'language', 'userId', 'organizationId', 'createdAt'])

export type CodeSymbolScalarFieldEnum = z.infer<typeof CodeSymbolScalarFieldEnumSchema>;

// File: AtlasAnalysisScalarFieldEnum.schema.ts

export const AtlasAnalysisScalarFieldEnumSchema = z.enum(['id', 'projectId', 'repositoryIntegrationId', 'provider', 'repositoryUrl', 'repositoryName', 'branch', 'status', 'analyzedCommitSha', 'analyzedCommitAt', 'analyzedAt', 'lastFullAnalysisAt', 'lastIncrementalAt', 'nodeCount', 'edgeCount', 'filesAnalyzed', 'fileManifest', 'techStack', 'publishedPackages', 'businessTour', 'businessSignature', 'workflowId', 'error', 'analysisModel', 'analysisDurationMs', 'promptTokens', 'completionTokens', 'totalTokens', 'costMicroUsd', 'reasoning', 'activeRunStatus', 'activeRunStartedAt', 'appliedUserOverrides', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type AtlasAnalysisScalarFieldEnum = z.infer<typeof AtlasAnalysisScalarFieldEnumSchema>;

// File: AtlasParseCheckpointScalarFieldEnum.schema.ts

export const AtlasParseCheckpointScalarFieldEnumSchema = z.enum(['id', 'analysisId', 'projectId', 'commitSha', 'path', 'language', 'namespace', 'loc', 'symbolCount', 'contentHash', 'contentPreview', 'importSpecs', 'userId', 'organizationId', 'createdAt'])

export type AtlasParseCheckpointScalarFieldEnum = z.infer<typeof AtlasParseCheckpointScalarFieldEnumSchema>;

// File: AtlasNodeScalarFieldEnum.schema.ts

export const AtlasNodeScalarFieldEnumSchema = z.enum(['id', 'analysisId', 'projectId', 'mode', 'kind', 'key', 'label', 'filePath', 'language', 'parentKey', 'technicalDescription', 'businessDescription', 'category', 'contentPreview', 'documentation', 'metrics', 'layout', 'contentHash', 'qdrantPointId', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type AtlasNodeScalarFieldEnum = z.infer<typeof AtlasNodeScalarFieldEnumSchema>;

// File: AtlasEdgeScalarFieldEnum.schema.ts

export const AtlasEdgeScalarFieldEnumSchema = z.enum(['id', 'analysisId', 'projectId', 'mode', 'kind', 'sourceKey', 'targetKey', 'weight', 'userId', 'organizationId', 'createdAt'])

export type AtlasEdgeScalarFieldEnum = z.infer<typeof AtlasEdgeScalarFieldEnumSchema>;

// File: AtlasAnalysisRunScalarFieldEnum.schema.ts

export const AtlasAnalysisRunScalarFieldEnumSchema = z.enum(['id', 'analysisId', 'projectId', 'triggeredByUserId', 'mode', 'status', 'branch', 'commitSha', 'commitAt', 'nodeCount', 'edgeCount', 'filesAnalyzed', 'modulesDescribed', 'model', 'promptTokens', 'completionTokens', 'totalTokens', 'costMicroUsd', 'error', 'startedAt', 'completedAt', 'durationMs', 'userId', 'organizationId'])

export type AtlasAnalysisRunScalarFieldEnum = z.infer<typeof AtlasAnalysisRunScalarFieldEnumSchema>;

// File: AtlasConversationScalarFieldEnum.schema.ts

export const AtlasConversationScalarFieldEnumSchema = z.enum(['id', 'projectId', 'repositoryIntegrationId', 'mode', 'title', 'visibility', 'messages', 'isSystemScope', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type AtlasConversationScalarFieldEnum = z.infer<typeof AtlasConversationScalarFieldEnumSchema>;

// File: AtlasNodeOverrideScalarFieldEnum.schema.ts

export const AtlasNodeOverrideScalarFieldEnumSchema = z.enum(['id', 'projectId', 'repositoryIntegrationId', 'branch', 'mode', 'key', 'userDescription', 'userCategory', 'updatedByUserId', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type AtlasNodeOverrideScalarFieldEnum = z.infer<typeof AtlasNodeOverrideScalarFieldEnumSchema>;

// File: AtlasNodeOverrideHistoryScalarFieldEnum.schema.ts

export const AtlasNodeOverrideHistoryScalarFieldEnumSchema = z.enum(['id', 'overrideId', 'field', 'oldValue', 'newValue', 'editedByUserId', 'userId', 'organizationId', 'createdAt'])

export type AtlasNodeOverrideHistoryScalarFieldEnum = z.infer<typeof AtlasNodeOverrideHistoryScalarFieldEnumSchema>;

// File: AtlasCrossEdgeScalarFieldEnum.schema.ts

export const AtlasCrossEdgeScalarFieldEnumSchema = z.enum(['id', 'projectId', 'mode', 'kind', 'detection', 'sourceAnalysisId', 'sourceKey', 'targetAnalysisId', 'targetKey', 'weight', 'description', 'userId', 'organizationId', 'createdAt'])

export type AtlasCrossEdgeScalarFieldEnum = z.infer<typeof AtlasCrossEdgeScalarFieldEnumSchema>;

// File: AtlasCrossLinkScalarFieldEnum.schema.ts

export const AtlasCrossLinkScalarFieldEnumSchema = z.enum(['id', 'projectId', 'status', 'signature', 'repositoryIntegrationIds', 'edgeCount', 'model', 'totalTokens', 'costMicroUsd', 'error', 'startedAt', 'completedAt', 'durationMs', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type AtlasCrossLinkScalarFieldEnum = z.infer<typeof AtlasCrossLinkScalarFieldEnumSchema>;

// File: AtlasCrossLinkRunScalarFieldEnum.schema.ts

export const AtlasCrossLinkRunScalarFieldEnumSchema = z.enum(['id', 'projectId', 'triggeredByUserId', 'trigger', 'status', 'repositoryIntegrationIds', 'edgeCount', 'model', 'totalTokens', 'costMicroUsd', 'error', 'startedAt', 'completedAt', 'durationMs', 'userId', 'organizationId', 'createdAt'])

export type AtlasCrossLinkRunScalarFieldEnum = z.infer<typeof AtlasCrossLinkRunScalarFieldEnumSchema>;

// File: AtlasSystemLayoutScalarFieldEnum.schema.ts

export const AtlasSystemLayoutScalarFieldEnumSchema = z.enum(['id', 'projectId', 'mode', 'nodeId', 'x', 'y', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type AtlasSystemLayoutScalarFieldEnum = z.infer<typeof AtlasSystemLayoutScalarFieldEnumSchema>;

// File: AtlasEdgeOverrideScalarFieldEnum.schema.ts

export const AtlasEdgeOverrideScalarFieldEnumSchema = z.enum(['id', 'projectId', 'branch', 'mode', 'sourceRepositoryIntegrationId', 'sourceKey', 'targetRepositoryIntegrationId', 'targetKey', 'kind', 'userDescription', 'isManual', 'isCrossRepo', 'isAiGenerated', 'isUserKind', 'deletedAt', 'updatedByUserId', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type AtlasEdgeOverrideScalarFieldEnum = z.infer<typeof AtlasEdgeOverrideScalarFieldEnumSchema>;

// File: AtlasEdgeOverrideHistoryScalarFieldEnum.schema.ts

export const AtlasEdgeOverrideHistoryScalarFieldEnumSchema = z.enum(['id', 'overrideId', 'action', 'oldValue', 'newValue', 'editedByUserId', 'userId', 'organizationId', 'createdAt'])

export type AtlasEdgeOverrideHistoryScalarFieldEnum = z.infer<typeof AtlasEdgeOverrideHistoryScalarFieldEnumSchema>;

// File: ProjectLinkedMeetingScalarFieldEnum.schema.ts

export const ProjectLinkedMeetingScalarFieldEnumSchema = z.enum(['id', 'projectId', 'joinUrl', 'subject', 'organizer', 'includedInDigest', 'linkedAt', 'userId', 'organizationId'])

export type ProjectLinkedMeetingScalarFieldEnum = z.infer<typeof ProjectLinkedMeetingScalarFieldEnumSchema>;

// File: ProjectMeetingTranscriptScalarFieldEnum.schema.ts

export const ProjectMeetingTranscriptScalarFieldEnumSchema = z.enum(['id', 'projectId', 'linkedMeetingId', 'meetingId', 'transcriptId', 'meetingSubject', 'meetingDate', 'contextId', 'summary', 'keywords', 'speakerNames', 'contentLength', 'wasSummarized', 'extractedDecisions', 'dismissedDecisionIndexes', 'extractedActionItems', 'extractedQuestions', 'insightsExtractedAt', 'insightsVersion', 'analysisStatus', 'analysisStartedAt', 'analysisError', 'analysisFailedAt', 'analyzedAt', 'analyzedProposalId', 'actionItemsLinkedAt', 'actionItemsLinkVersion', 'syncedAt', 'userId', 'organizationId'])

export type ProjectMeetingTranscriptScalarFieldEnum = z.infer<typeof ProjectMeetingTranscriptScalarFieldEnumSchema>;

// File: ProjectMeetingActionItemScalarFieldEnum.schema.ts

export const ProjectMeetingActionItemScalarFieldEnumSchema = z.enum(['id', 'transcriptId', 'orderIndex', 'text', 'tentativeOwnerName', 'dueHint', 'completedAt', 'completedById', 'sourceQuote', 'anchorLine', 'createdAt', 'userId', 'organizationId'])

export type ProjectMeetingActionItemScalarFieldEnum = z.infer<typeof ProjectMeetingActionItemScalarFieldEnumSchema>;

// File: MeetingActionItemLinkScalarFieldEnum.schema.ts

export const MeetingActionItemLinkScalarFieldEnumSchema = z.enum(['id', 'transcriptId', 'projectId', 'itemKey', 'itemTextSnapshot', 'storyId', 'origin', 'status', 'similarity', 'confidence', 'reasoning', 'createdById', 'createdAt', 'dismissedAt', 'dismissedById', 'userId', 'organizationId'])

export type MeetingActionItemLinkScalarFieldEnum = z.infer<typeof MeetingActionItemLinkScalarFieldEnumSchema>;

// File: ProjectMeetingAgendaScalarFieldEnum.schema.ts

export const ProjectMeetingAgendaScalarFieldEnumSchema = z.enum(['id', 'projectId', 'linkedMeetingId', 'occurrenceStart', 'status', 'content', 'generatedStructure', 'contextStats', 'promptProvenance', 'generatedAt', 'generationError', 'temporalWorkflowId', 'editedAt', 'editedById', 'version', 'createdAt', 'createdById', 'userId', 'organizationId'])

export type ProjectMeetingAgendaScalarFieldEnum = z.infer<typeof ProjectMeetingAgendaScalarFieldEnumSchema>;

// File: ProjectSlackHuddleNoteScalarFieldEnum.schema.ts

export const ProjectSlackHuddleNoteScalarFieldEnumSchema = z.enum(['id', 'projectId', 'linkedChannelId', 'canvasId', 'channelId', 'slackTeamId', 'huddleTranscriptFileId', 'huddleSummaryId', 'huddleDateStart', 'huddleDateEnd', 'title', 'contextId', 'contentHash', 'contentLength', 'wasSummarized', 'speakerNames', 'syncedAt', 'updatedAt', 'userId', 'organizationId'])

export type ProjectSlackHuddleNoteScalarFieldEnum = z.infer<typeof ProjectSlackHuddleNoteScalarFieldEnumSchema>;

// File: ProjectLinkedTeamsChannelScalarFieldEnum.schema.ts

export const ProjectLinkedTeamsChannelScalarFieldEnumSchema = z.enum(['id', 'projectId', 'teamId', 'channelId', 'teamName', 'channelName', 'channelWebUrl', 'linkedAt', 'lastMessageCreatedAt', 'lastMessageId', 'scanPageToken', 'consecutiveFailures', 'lastErrorMessage', 'lastErrorAt', 'userId', 'organizationId', 'tenantId'])

export type ProjectLinkedTeamsChannelScalarFieldEnum = z.infer<typeof ProjectLinkedTeamsChannelScalarFieldEnumSchema>;

// File: ProjectLinkedTeamsChannelSeenMessageScalarFieldEnum.schema.ts

export const ProjectLinkedTeamsChannelSeenMessageScalarFieldEnumSchema = z.enum(['id', 'linkedChannelId', 'messageId', 'createdAt', 'pendingProposalId'])

export type ProjectLinkedTeamsChannelSeenMessageScalarFieldEnum = z.infer<typeof ProjectLinkedTeamsChannelSeenMessageScalarFieldEnumSchema>;

// File: ProjectLinkedTeamsChatScalarFieldEnum.schema.ts

export const ProjectLinkedTeamsChatScalarFieldEnumSchema = z.enum(['id', 'projectId', 'chatId', 'chatTopic', 'chatWebUrl', 'linkedAt', 'lastMessageCreatedAt', 'lastMessageId', 'scanPageToken', 'consecutiveFailures', 'lastErrorMessage', 'lastErrorAt', 'userId', 'organizationId'])

export type ProjectLinkedTeamsChatScalarFieldEnum = z.infer<typeof ProjectLinkedTeamsChatScalarFieldEnumSchema>;

// File: ProjectLinkedTeamsChatSeenMessageScalarFieldEnum.schema.ts

export const ProjectLinkedTeamsChatSeenMessageScalarFieldEnumSchema = z.enum(['id', 'linkedChatId', 'messageId', 'createdAt', 'pendingProposalId'])

export type ProjectLinkedTeamsChatSeenMessageScalarFieldEnum = z.infer<typeof ProjectLinkedTeamsChatSeenMessageScalarFieldEnumSchema>;

// File: ProjectLinkedSlackChannelScalarFieldEnum.schema.ts

export const ProjectLinkedSlackChannelScalarFieldEnumSchema = z.enum(['id', 'projectId', 'slackTeamId', 'channelId', 'teamName', 'channelName', 'channelWebUrl', 'linkedAt', 'monitorEnabled', 'monitorEnabledAt', 'backfillCompleteAt', 'lastMessageTs', 'consecutiveFailures', 'lastErrorMessage', 'lastErrorAt', 'userId', 'organizationId'])

export type ProjectLinkedSlackChannelScalarFieldEnum = z.infer<typeof ProjectLinkedSlackChannelScalarFieldEnumSchema>;

// File: ProjectLinkedSlackChannelSeenMessageScalarFieldEnum.schema.ts

export const ProjectLinkedSlackChannelSeenMessageScalarFieldEnumSchema = z.enum(['id', 'linkedChannelId', 'messageTs', 'createdAt', 'pendingProposalId'])

export type ProjectLinkedSlackChannelSeenMessageScalarFieldEnum = z.infer<typeof ProjectLinkedSlackChannelSeenMessageScalarFieldEnumSchema>;

// File: PendingBacklogProposalScalarFieldEnum.schema.ts

export const PendingBacklogProposalScalarFieldEnumSchema = z.enum(['id', 'projectId', 'source', 'status', 'proposal', 'summary', 'changeCount', 'sourceMetadata', 'appliedChangeIndexes', 'applyWorkflowId', 'applyStartedAt', 'applyError', 'errorClass', 'errorMessage', 'failedAt', 'createdAt', 'reviewedAt', 'reviewedBy', 'appliedAt', 'userId', 'organizationId'])

export type PendingBacklogProposalScalarFieldEnum = z.infer<typeof PendingBacklogProposalScalarFieldEnumSchema>;

// File: BacklogProposalDraftScalarFieldEnum.schema.ts

export const BacklogProposalDraftScalarFieldEnumSchema = z.enum(['id', 'proposalId', 'kind', 'status', 'description', 'acceptanceCriteria', 'needsMoreInfo', 'workflowId', 'error', 'startedAt', 'completedAt', 'createdBy'])

export type BacklogProposalDraftScalarFieldEnum = z.infer<typeof BacklogProposalDraftScalarFieldEnumSchema>;

// File: BacklogUpdateSessionScalarFieldEnum.schema.ts

export const BacklogUpdateSessionScalarFieldEnumSchema = z.enum(['id', 'projectId', 'pendingProposalId', 'conversationId', 'source', 'status', 'summary', 'changes', 'changeCount', 'createCount', 'updateCount', 'messages', 'appliedCount', 'failedCount', 'syncedToPMCount', 'errors', 'finalizedAt', 'createdAt', 'userId', 'organizationId'])

export type BacklogUpdateSessionScalarFieldEnum = z.infer<typeof BacklogUpdateSessionScalarFieldEnumSchema>;

// File: ProjectPresenceScalarFieldEnum.schema.ts

export const ProjectPresenceScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userId', 'userName', 'userImage', 'lastSeenAt', 'activeTab', 'editingDocId', 'organizationId'])

export type ProjectPresenceScalarFieldEnum = z.infer<typeof ProjectPresenceScalarFieldEnumSchema>;

// File: ProjectActivityScalarFieldEnum.schema.ts

export const ProjectActivityScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userId', 'userName', 'activityType', 'resourceType', 'resourceId', 'resourceName', 'metadata', 'createdAt', 'organizationId'])

export type ProjectActivityScalarFieldEnum = z.infer<typeof ProjectActivityScalarFieldEnumSchema>;

// File: AuditLogScalarFieldEnum.schema.ts

export const AuditLogScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'actorType', 'actorEmailSnapshot', 'actorNameSnapshot', 'impersonatedById', 'action', 'category', 'severity', 'outcome', 'resourceType', 'resourceId', 'resourceName', 'projectId', 'ipAddress', 'userAgent', 'requestId', 'sessionId', 'metadata', 'durationMs', 'createdAt'])

export type AuditLogScalarFieldEnum = z.infer<typeof AuditLogScalarFieldEnumSchema>;

// File: AuditLogSealScalarFieldEnum.schema.ts

export const AuditLogSealScalarFieldEnumSchema = z.enum(['id', 'sequence', 'periodStart', 'periodEnd', 'rowCount', 'contentHash', 'prevSealHash', 'sealHash', 'signature', 'keyId', 'version', 'createdAt'])

export type AuditLogSealScalarFieldEnum = z.infer<typeof AuditLogSealScalarFieldEnumSchema>;

// File: PmSyncLogScalarFieldEnum.schema.ts

export const PmSyncLogScalarFieldEnumSchema = z.enum(['id', 'createdAt', 'direction', 'entityType', 'entityId', 'title', 'pmTool', 'status', 'errorPayload', 'batchId', 'actorUserId', 'correlationId', 'durationMs', 'externalId', 'externalUrl', 'organizationId', 'userId', 'projectId'])

export type PmSyncLogScalarFieldEnum = z.infer<typeof PmSyncLogScalarFieldEnumSchema>;

// File: RequestSpanScalarFieldEnum.schema.ts

export const RequestSpanScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'correlationId', 'kind', 'name', 'startedAt', 'durationMs', 'status', 'errorMessage', 'attributes', 'createdAt'])

export type RequestSpanScalarFieldEnum = z.infer<typeof RequestSpanScalarFieldEnumSchema>;

// File: ProjectUserPreferenceScalarFieldEnum.schema.ts

export const ProjectUserPreferenceScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userId', 'organizationId', 'kanbanLocalRepoPath', 'inviteWidgetDismissedAt', 'inviteWidgetDismissedInviteExpiry', 'roadmapView', 'roadmapStoryOrder', 'decisionsView', 'favoritedAt', 'lastVisitedAt', 'projectTabPrefs', 'createdAt', 'updatedAt'])

export type ProjectUserPreferenceScalarFieldEnum = z.infer<typeof ProjectUserPreferenceScalarFieldEnumSchema>;

// File: ProjectUserFunctionTagScalarFieldEnum.schema.ts

export const ProjectUserFunctionTagScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userId', 'organizationId', 'tags', 'confirmedAt', 'confirmationVersion', 'createdAt', 'updatedAt'])

export type ProjectUserFunctionTagScalarFieldEnum = z.infer<typeof ProjectUserFunctionTagScalarFieldEnumSchema>;

// File: DailyBriefScalarFieldEnum.schema.ts

export const DailyBriefScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'generatedAt', 'timeWindowStart', 'timeWindowEnd', 'timeWindowKind', 'status', 'content', 'errorMessage', 'generatedByUserId', 'temporalWorkflowId', 'aiUsageTokens'])

export type DailyBriefScalarFieldEnum = z.infer<typeof DailyBriefScalarFieldEnumSchema>;

// File: DailyBriefViewScalarFieldEnum.schema.ts

export const DailyBriefViewScalarFieldEnumSchema = z.enum(['id', 'dailyBriefId', 'userId', 'organizationId', 'viewedAt'])

export type DailyBriefViewScalarFieldEnum = z.infer<typeof DailyBriefViewScalarFieldEnumSchema>;

// File: NewsletterSettingsScalarFieldEnum.schema.ts

export const NewsletterSettingsScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'enabled', 'cadence', 'dayOfWeek', 'dayOfMonth', 'sendHourUtc', 'lastSentAt', 'lookbackDays', 'detailLevel', 'deliveryDestination', 'chatChannels', 'approvalChatChannels', 'requireApproval', 'publicWidgetEnabled', 'publicEmbedToken', 'publicEmbedTokenVersion', 'publicWidgetTheme', 'publicWidgetAccent', 'publicWidgetConfig', 'createdByUserId', 'createdAt', 'updatedAt'])

export type NewsletterSettingsScalarFieldEnum = z.infer<typeof NewsletterSettingsScalarFieldEnumSchema>;

// File: NewsletterSubscriberScalarFieldEnum.schema.ts

export const NewsletterSubscriberScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'email', 'name', 'status', 'unsubscribeToken', 'createdByUserId', 'createdAt', 'unsubscribedAt', 'embedTokenVersion'])

export type NewsletterSubscriberScalarFieldEnum = z.infer<typeof NewsletterSubscriberScalarFieldEnumSchema>;

// File: NewsletterSendScalarFieldEnum.schema.ts

export const NewsletterSendScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'dedupeKey', 'status', 'skipReason', 'trigger', 'timeWindowStart', 'timeWindowEnd', 'recipientCount', 'sentCount', 'failedCount', 'content', 'detailLevel', 'deliveryDestination', 'requireApproval', 'chatChannels', 'reviewedByUserId', 'reviewedAt', 'rejectionReason', 'removedHighlightIndexes', 'aiUsageTokens', 'temporalWorkflowId', 'errorMessage', 'triggeredByUserId', 'createdAt', 'completedAt'])

export type NewsletterSendScalarFieldEnum = z.infer<typeof NewsletterSendScalarFieldEnumSchema>;

// File: NewsletterDeliveryScalarFieldEnum.schema.ts

export const NewsletterDeliveryScalarFieldEnumSchema = z.enum(['id', 'sendId', 'projectId', 'organizationId', 'userId', 'recipientEmail', 'status', 'attemptCount', 'errorMessage', 'claimedAt', 'sentAt'])

export type NewsletterDeliveryScalarFieldEnum = z.infer<typeof NewsletterDeliveryScalarFieldEnumSchema>;

// File: NewsletterChatDeliveryScalarFieldEnum.schema.ts

export const NewsletterChatDeliveryScalarFieldEnumSchema = z.enum(['id', 'sendId', 'projectId', 'organizationId', 'userId', 'platform', 'kind', 'externalTeamId', 'channelId', 'status', 'errorMessage', 'postedMessageId', 'createdAt', 'deliveredAt'])

export type NewsletterChatDeliveryScalarFieldEnum = z.infer<typeof NewsletterChatDeliveryScalarFieldEnumSchema>;

// File: ProjectBriefCursorScalarFieldEnum.schema.ts

export const ProjectBriefCursorScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userId', 'organizationId', 'lastReviewedAt', 'updatedAt'])

export type ProjectBriefCursorScalarFieldEnum = z.infer<typeof ProjectBriefCursorScalarFieldEnumSchema>;

// File: DailyBriefReleaseNoteExclusionScalarFieldEnum.schema.ts

export const DailyBriefReleaseNoteExclusionScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'kind', 'targetKey', 'repoFullName', 'prNumber', 'storyIdentifier', 'reason', 'excludedByUserId', 'createdAt'])

export type DailyBriefReleaseNoteExclusionScalarFieldEnum = z.infer<typeof DailyBriefReleaseNoteExclusionScalarFieldEnumSchema>;

// File: ProjectMemberScalarFieldEnum.schema.ts

export const ProjectMemberScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userId', 'role', 'invitedBy', 'invitedAt', 'acceptedAt', 'expiresAt'])

export type ProjectMemberScalarFieldEnum = z.infer<typeof ProjectMemberScalarFieldEnumSchema>;

// File: ProjectInvitationScalarFieldEnum.schema.ts

export const ProjectInvitationScalarFieldEnumSchema = z.enum(['id', 'projectId', 'email', 'role', 'status', 'invitedBy', 'message', 'expiresAt', 'createdAt', 'respondedAt'])

export type ProjectInvitationScalarFieldEnum = z.infer<typeof ProjectInvitationScalarFieldEnumSchema>;

// File: DocumentLockScalarFieldEnum.schema.ts

export const DocumentLockScalarFieldEnumSchema = z.enum(['id', 'documentId', 'userId', 'userName', 'acquiredAt', 'expiresAt', 'lastHeartbeat', 'organizationId'])

export type DocumentLockScalarFieldEnum = z.infer<typeof DocumentLockScalarFieldEnumSchema>;

// File: ProjectStoryStatusScalarFieldEnum.schema.ts

export const ProjectStoryStatusScalarFieldEnumSchema = z.enum(['id', 'projectId', 'name', 'color', 'order', 'isDefault', 'isFinal', 'requiresApproval', 'createdAt', 'updatedAt'])

export type ProjectStoryStatusScalarFieldEnum = z.infer<typeof ProjectStoryStatusScalarFieldEnumSchema>;

// File: UserStoryScalarFieldEnum.schema.ts

export const UserStoryScalarFieldEnumSchema = z.enum(['id', 'projectId', 'statusId', 'identifier', 'title', 'description', 'acceptanceCriteria', 'kind', 'priority', 'size', 'storyPoints', 'order', 'roadmapOrder', 'priorityOrder', 'priorityChangedAt', 'priorityChangeReason', 'labels', 'createdById', 'assigneeId', 'externalId', 'externalUrl', 'externalMcpServerId', 'pmAutoSyncEnabled', 'lastSyncedStatusId', 'pipelineExecutionId', 'source', 'originTestCaseId', 'bugFingerprint', 'sourceMeetingTranscriptId', 'createdFromProposalId', 'aiGeneratedTitle', 'titleSource', 'releaseNotes', 'draftingStage', 'draftingStageUpdatedAt', 'maturationStatus', 'coverageOverrideReason', 'coverageOverrideById', 'coverageOverrideAt', 'pmTicketTerminal', 'pmTicketTerminalStatus', 'pmAutoHidden', 'version', 'needsMoreInfo', 'blocked', 'blockedReason', 'reporterName', 'reporterSource', 'reporterSourceUrl', 'lastSyncedPmHash', 'lastSyncedAt', 'lastPmSyncStatus', 'lastPmSyncError', 'lastPmSyncAttemptAt', 'mergedIntoStoryId', 'lastEditedAt', 'lastEditedByName', 'lastEditedSource', 'summaryDigest', 'workingNotesContent', 'lastQuestionScanHash', 'lastSummaryHash', 'lastContextUpdateAt', 'maturationV2OptedIn', 'autoProposeAnswers', 'qaAnalysis', 'cleanSpecApprovalMode', 'decisionLogApprovalMode', 'summaryQuestionsApprovalMode', 'createdAt', 'updatedAt'])

export type UserStoryScalarFieldEnum = z.infer<typeof UserStoryScalarFieldEnumSchema>;

// File: StoryPriorityChangeScalarFieldEnum.schema.ts

export const StoryPriorityChangeScalarFieldEnumSchema = z.enum(['id', 'storyId', 'projectId', 'fromPriority', 'toPriority', 'source', 'reason', 'actorId', 'actorName', 'createdAt'])

export type StoryPriorityChangeScalarFieldEnum = z.infer<typeof StoryPriorityChangeScalarFieldEnumSchema>;

// File: StoryTagScalarFieldEnum.schema.ts

export const StoryTagScalarFieldEnumSchema = z.enum(['id', 'storyId', 'value', 'createdById', 'createdAt'])

export type StoryTagScalarFieldEnum = z.infer<typeof StoryTagScalarFieldEnumSchema>;

// File: StoryAttachmentScalarFieldEnum.schema.ts

export const StoryAttachmentScalarFieldEnumSchema = z.enum(['id', 'storyId', 'filename', 'mimeType', 'sizeBytes', 'storageKey', 'designation', 'source', 'uploaderUserId', 'sourceTool', 'externalAttachmentId', 'contentHash', 'promotedAt', 'externalAuthor', 'externalCreatedAt', 'missingStreak', 'extractedText', 'extractedAt', 'createdAt', 'updatedAt', 'deletedAt'])

export type StoryAttachmentScalarFieldEnum = z.infer<typeof StoryAttachmentScalarFieldEnumSchema>;

// File: StoryAttachmentSyncIssueScalarFieldEnum.schema.ts

export const StoryAttachmentSyncIssueScalarFieldEnumSchema = z.enum(['id', 'storyId', 'sourceTool', 'filename', 'reason', 'detectedAt'])

export type StoryAttachmentSyncIssueScalarFieldEnum = z.infer<typeof StoryAttachmentSyncIssueScalarFieldEnumSchema>;

// File: StoryDuplicateLinkScalarFieldEnum.schema.ts

export const StoryDuplicateLinkScalarFieldEnumSchema = z.enum(['id', 'projectId', 'storyAId', 'storyBId', 'similarity', 'confidence', 'reasoning', 'status', 'linkType', 'verifiedContentHashA', 'verifiedContentHashB', 'detectedAt', 'resolvedAt', 'resolvedById', 'createdAt', 'updatedAt'])

export type StoryDuplicateLinkScalarFieldEnum = z.infer<typeof StoryDuplicateLinkScalarFieldEnumSchema>;

// File: StoryDuplicateEmbeddingScalarFieldEnum.schema.ts

export const StoryDuplicateEmbeddingScalarFieldEnumSchema = z.enum(['id', 'storyId', 'projectId', 'contentHash', 'model', 'embedding', 'createdAt', 'updatedAt'])

export type StoryDuplicateEmbeddingScalarFieldEnum = z.infer<typeof StoryDuplicateEmbeddingScalarFieldEnumSchema>;

// File: StoryRoutingEmbeddingScalarFieldEnum.schema.ts

export const StoryRoutingEmbeddingScalarFieldEnumSchema = z.enum(['id', 'storyId', 'projectId', 'contentHash', 'model', 'embedding', 'createdAt', 'updatedAt'])

export type StoryRoutingEmbeddingScalarFieldEnum = z.infer<typeof StoryRoutingEmbeddingScalarFieldEnumSchema>;

// File: FeatureVersionScalarFieldEnum.schema.ts

export const FeatureVersionScalarFieldEnumSchema = z.enum(['id', 'storyId', 'version', 'description', 'acceptanceCriteria', 'draftingStage', 'changeDescription', 'changedBy', 'createdAt', 'userId', 'organizationId', 'summaryDigestSnapshot', 'workingNotesSnapshot', 'changeSummary'])

export type FeatureVersionScalarFieldEnum = z.infer<typeof FeatureVersionScalarFieldEnumSchema>;

// File: StoryTaskScalarFieldEnum.schema.ts

export const StoryTaskScalarFieldEnumSchema = z.enum(['id', 'storyId', 'identifier', 'title', 'description', 'isCompleted', 'order', 'estimatedHours', 'externalId', 'createdAt', 'updatedAt', 'assignedAgentId', 'agentTaskId', 'agentStatus', 'agentStartedAt', 'agentCompletedAt', 'agentError', 'repositoryUrl', 'repositoryOwner', 'repositoryName', 'targetBranch', 'artifactUrl', 'artifactType'])

export type StoryTaskScalarFieldEnum = z.infer<typeof StoryTaskScalarFieldEnumSchema>;

// File: UserStoryCommentScalarFieldEnum.schema.ts

export const UserStoryCommentScalarFieldEnumSchema = z.enum(['id', 'storyId', 'authorId', 'authorType', 'content', 'parentId', 'sourceCommentId', 'workflowId', 'metadata', 'organizationId', 'createdAt', 'updatedAt', 'deletedAt'])

export type UserStoryCommentScalarFieldEnum = z.infer<typeof UserStoryCommentScalarFieldEnumSchema>;

// File: StoryTaskCommentScalarFieldEnum.schema.ts

export const StoryTaskCommentScalarFieldEnumSchema = z.enum(['id', 'taskId', 'authorId', 'authorType', 'content', 'parentId', 'sourceCommentId', 'workflowId', 'metadata', 'organizationId', 'createdAt', 'updatedAt', 'deletedAt'])

export type StoryTaskCommentScalarFieldEnum = z.infer<typeof StoryTaskCommentScalarFieldEnumSchema>;

// File: DecisionLogEntryScalarFieldEnum.schema.ts

export const DecisionLogEntryScalarFieldEnumSchema = z.enum(['id', 'userStoryId', 'parentId', 'authorType', 'authorUserId', 'status', 'summary', 'content', 'impactedSection', 'topic', 'questionId', 'source', 'decidedBy', 'authorName', 'sourceProvenance', 'answerSource', 'metadata', 'organizationId', 'userId', 'deletedAt', 'createdAt', 'updatedAt'])

export type DecisionLogEntryScalarFieldEnum = z.infer<typeof DecisionLogEntryScalarFieldEnumSchema>;

// File: MaturationApprovalPreferenceScalarFieldEnum.schema.ts

export const MaturationApprovalPreferenceScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'cleanSpecMode', 'decisionLogMode', 'summaryQuestionsMode', 'autoAcceptAll', 'createdAt', 'updatedAt'])

export type MaturationApprovalPreferenceScalarFieldEnum = z.infer<typeof MaturationApprovalPreferenceScalarFieldEnumSchema>;

// File: ArchitectureDecisionScalarFieldEnum.schema.ts

export const ArchitectureDecisionScalarFieldEnumSchema = z.enum(['id', 'projectId', 'identifier', 'title', 'contextProblem', 'decision', 'rationale', 'decisionDrivers', 'alternativesConsidered', 'consequences', 'status', 'domain', 'decisionDate', 'participantUserIds', 'participantsText', 'supersededById', 'relatedDecisionIds', 'pinnedAt', 'createdById', 'lastEditedById', 'currentVersion', 'vouchedAt', 'vouchedById', 'contextId', 'sourceKind', 'sourceMetadata', 'decisionTypeId', 'ownerUserId', 'duration', 'priorityFlagged', 'priorityFlaggedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt', 'deletedAt'])

export type ArchitectureDecisionScalarFieldEnum = z.infer<typeof ArchitectureDecisionScalarFieldEnumSchema>;

// File: ArchitectureDecisionCommentScalarFieldEnum.schema.ts

export const ArchitectureDecisionCommentScalarFieldEnumSchema = z.enum(['id', 'architectureDecisionId', 'authorId', 'authorType', 'content', 'parentId', 'decisionVersion', 'organizationId', 'createdAt', 'updatedAt', 'deletedAt'])

export type ArchitectureDecisionCommentScalarFieldEnum = z.infer<typeof ArchitectureDecisionCommentScalarFieldEnumSchema>;

// File: ArchitectureDecisionVersionScalarFieldEnum.schema.ts

export const ArchitectureDecisionVersionScalarFieldEnumSchema = z.enum(['id', 'architectureDecisionId', 'version', 'title', 'contextProblem', 'decision', 'rationale', 'decisionDrivers', 'alternativesConsidered', 'consequences', 'status', 'decisionDate', 'participantUserIds', 'participantsText', 'decisionTypeId', 'ownerUserId', 'duration', 'priorityFlagged', 'editedById', 'editedByName', 'userId', 'organizationId', 'createdAt'])

export type ArchitectureDecisionVersionScalarFieldEnum = z.infer<typeof ArchitectureDecisionVersionScalarFieldEnumSchema>;

// File: DecisionTypeScalarFieldEnum.schema.ts

export const DecisionTypeScalarFieldEnumSchema = z.enum(['id', 'projectId', 'name', 'origin', 'archivedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type DecisionTypeScalarFieldEnum = z.infer<typeof DecisionTypeScalarFieldEnumSchema>;

// File: PublishingSuggestionCycleScalarFieldEnum.schema.ts

export const PublishingSuggestionCycleScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'status', 'actorUserId', 'triggeredByUserId', 'startedAt', 'completedAt', 'executionTimeoutAt', 'coveredThrough', 'sourceCoverage', 'sourceFailures', 'preferencesHash', 'temporalWorkflowId', 'occurrenceKey', 'error', 'notificationOutcome', 'notificationOutcomeVersion', 'notificationOutcomeAt', 'createdAt', 'updatedAt'])

export type PublishingSuggestionCycleScalarFieldEnum = z.infer<typeof PublishingSuggestionCycleScalarFieldEnumSchema>;

// File: PublishingTopicScalarFieldEnum.schema.ts

export const PublishingTopicScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'cycleId', 'title', 'pitch', 'status', 'origin', 'createdById', 'declineReason', 'snoozedUntil', 'snoozeReason', 'publishedUrl', 'provenance', 'suggestedPostTypes', 'contributorUserIds', 'relevantFunctionTags', 'postTypeRecommendations', 'postTypesOverridden', 'userPostTypes', 'angle', 'subject', 'subjectKey', 'dedupeKey', 'createdAt', 'updatedAt'])

export type PublishingTopicScalarFieldEnum = z.infer<typeof PublishingTopicScalarFieldEnumSchema>;

// File: PublishingTopicReadScalarFieldEnum.schema.ts

export const PublishingTopicReadScalarFieldEnumSchema = z.enum(['id', 'topicId', 'userId', 'projectId', 'organizationId', 'readAt'])

export type PublishingTopicReadScalarFieldEnum = z.infer<typeof PublishingTopicReadScalarFieldEnumSchema>;

// File: PublishingSuiteSettingsScalarFieldEnum.schema.ts

export const PublishingSuiteSettingsScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'cadence', 'lookbackDays', 'notificationsEnabled', 'chatChannels', 'preferredThemes', 'preferredPostTypes', 'strategicPriorities', 'createdByUserId', 'createdAt', 'updatedAt'])

export type PublishingSuiteSettingsScalarFieldEnum = z.infer<typeof PublishingSuiteSettingsScalarFieldEnumSchema>;

// File: PublishingNotificationDeliveryScalarFieldEnum.schema.ts

export const PublishingNotificationDeliveryScalarFieldEnumSchema = z.enum(['id', 'cycleId', 'projectId', 'organizationId', 'userId', 'recipientUserId', 'channel', 'status', 'reason', 'errorMessage', 'createdAt', 'claimedAt', 'claimToken', 'lastAttemptAt', 'deliveredAt', 'expiresAt', 'attemptCount'])

export type PublishingNotificationDeliveryScalarFieldEnum = z.infer<typeof PublishingNotificationDeliveryScalarFieldEnumSchema>;

// File: PublishingChatDeliveryScalarFieldEnum.schema.ts

export const PublishingChatDeliveryScalarFieldEnumSchema = z.enum(['id', 'cycleId', 'projectId', 'organizationId', 'userId', 'platform', 'externalTeamId', 'channelId', 'status', 'reason', 'errorMessage', 'postedMessageId', 'createdAt', 'deliveredAt'])

export type PublishingChatDeliveryScalarFieldEnum = z.infer<typeof PublishingChatDeliveryScalarFieldEnumSchema>;

// File: TestCaseScalarFieldEnum.schema.ts

export const TestCaseScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'identifier', 'title', 'description', 'state', 'priority', 'ownerId', 'tags', 'automationStatus', 'order', 'createdById', 'automationRef', 'automationFilePath', 'automationExternalUrl', 'playwrightScript', 'coverageType', 'draftedFromSpecHash', 'proposedSteps', 'proposedAt', 'proposedFrom', 'currentResult', 'lastRunAt', 'lastRunSource', 'lastRunByLabel', 'externalId', 'externalUrl', 'externalMcpServerId', 'pmAutoSyncEnabled', 'lastSyncedPmHash', 'lastSyncedAt', 'lastPmSyncStatus', 'lastPmSyncError', 'lastPmSyncAttemptAt', 'contextId', 'createdAt', 'updatedAt', 'deletedAt'])

export type TestCaseScalarFieldEnum = z.infer<typeof TestCaseScalarFieldEnumSchema>;

// File: TestCaseStepScalarFieldEnum.schema.ts

export const TestCaseStepScalarFieldEnumSchema = z.enum(['id', 'testCaseId', 'order', 'action', 'expected', 'data', 'sharedStepId', 'createdAt', 'updatedAt'])

export type TestCaseStepScalarFieldEnum = z.infer<typeof TestCaseStepScalarFieldEnumSchema>;

// File: TestPlanScalarFieldEnum.schema.ts

export const TestPlanScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'identifier', 'name', 'description', 'state', 'order', 'createdById', 'createdAt', 'updatedAt', 'deletedAt'])

export type TestPlanScalarFieldEnum = z.infer<typeof TestPlanScalarFieldEnumSchema>;

// File: TestPlanCaseScalarFieldEnum.schema.ts

export const TestPlanCaseScalarFieldEnumSchema = z.enum(['id', 'planId', 'testCaseId', 'order', 'section', 'createdAt'])

export type TestPlanCaseScalarFieldEnum = z.infer<typeof TestPlanCaseScalarFieldEnumSchema>;

// File: TestCaseWorkItemLinkScalarFieldEnum.schema.ts

export const TestCaseWorkItemLinkScalarFieldEnumSchema = z.enum(['id', 'testCaseId', 'userStoryId', 'acceptanceCriterionRefs', 'acceptanceCriterionRef', 'linkType', 'createdAt'])

export type TestCaseWorkItemLinkScalarFieldEnum = z.infer<typeof TestCaseWorkItemLinkScalarFieldEnumSchema>;

// File: TestResultEventScalarFieldEnum.schema.ts

export const TestResultEventScalarFieldEnumSchema = z.enum(['id', 'testCaseId', 'result', 'source', 'occurredAt', 'changedByUserId', 'actorLabel', 'testPlanId', 'pipelineRunId', 'externalRunRef', 'externalRunUrl', 'scriptRevisionId', 'note', 'createdAt'])

export type TestResultEventScalarFieldEnum = z.infer<typeof TestResultEventScalarFieldEnumSchema>;

// File: TestPipelineRunScalarFieldEnum.schema.ts

export const TestPipelineRunScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'provider', 'externalRunId', 'pipelineName', 'branch', 'commitSha', 'runUrl', 'status', 'startedAt', 'finishedAt', 'durationMs', 'totalCount', 'passedCount', 'failedCount', 'skippedCount', 'otherCount', 'triggeredByActor', 'triggeredByActorAvatarUrl', 'results', 'createdAt', 'updatedAt', 'deletedAt'])

export type TestPipelineRunScalarFieldEnum = z.infer<typeof TestPipelineRunScalarFieldEnumSchema>;

// File: TestFindingScalarFieldEnum.schema.ts

export const TestFindingScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'fingerprint', 'testName', 'classname', 'failureMessage', 'status', 'occurrences', 'firstSeenAt', 'lastSeenAt', 'suspectedCause', 'suspectedKind', 'analysedAt', 'analysisModel', 'analysisDiff', 'testCaseId', 'lastPipelineRunId', 'promotedStoryId', 'createdAt', 'updatedAt', 'deletedAt'])

export type TestFindingScalarFieldEnum = z.infer<typeof TestFindingScalarFieldEnumSchema>;

// File: TestPipelineSyncStateScalarFieldEnum.schema.ts

export const TestPipelineSyncStateScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'provider', 'pipelineKey', 'lastRunExternalId', 'lastCommitSha', 'pageToken', 'lastFetchedAt', 'status', 'lastError', 'lastErrorDetail', 'lastErrorKind', 'lastErrorAt', 'lastAttemptStartedAt', 'createdAt', 'updatedAt'])

export type TestPipelineSyncStateScalarFieldEnum = z.infer<typeof TestPipelineSyncStateScalarFieldEnumSchema>;

// File: TestAgenticRunScalarFieldEnum.schema.ts

export const TestAgenticRunScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'status', 'runMode', 'workflowId', 'environmentId', 'targetBaseUrl', 'environmentType', 'estimatedCostUsd', 'costCapUsd', 'actualCostUsd', 'browser', 'resolution', 'caseCount', 'passedCount', 'failedCount', 'blockedCount', 'needsReviewCount', 'refusalReason', 'pipelineRunId', 'triggeredByUserId', 'startedAt', 'finishedAt', 'createdAt', 'updatedAt'])

export type TestAgenticRunScalarFieldEnum = z.infer<typeof TestAgenticRunScalarFieldEnumSchema>;

// File: TestRunConfigurationScalarFieldEnum.schema.ts

export const TestRunConfigurationScalarFieldEnumSchema = z.enum(['id', 'projectId', 'name', 'isSystem', 'runMode', 'environmentId', 'browser', 'resolution', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type TestRunConfigurationScalarFieldEnum = z.infer<typeof TestRunConfigurationScalarFieldEnumSchema>;

// File: TestAgenticCaseResultScalarFieldEnum.schema.ts

export const TestAgenticCaseResultScalarFieldEnumSchema = z.enum(['id', 'runId', 'testCaseId', 'result', 'failureMessage', 'durationMs', 'modelCalls', 'scriptRevisionId', 'label', 'steps', 'projectId', 'organizationId', 'userId', 'createdAt'])

export type TestAgenticCaseResultScalarFieldEnum = z.infer<typeof TestAgenticCaseResultScalarFieldEnumSchema>;

// File: TestRunEvidenceScalarFieldEnum.schema.ts

export const TestRunEvidenceScalarFieldEnumSchema = z.enum(['id', 'bucket', 'storageKey', 'projectId', 'runId', 'testCaseId', 'stepOrder', 'organizationId', 'userId', 'capturedAt'])

export type TestRunEvidenceScalarFieldEnum = z.infer<typeof TestRunEvidenceScalarFieldEnumSchema>;

// File: TestAgenticStepLogScalarFieldEnum.schema.ts

export const TestAgenticStepLogScalarFieldEnumSchema = z.enum(['id', 'testResultEventId', 'order', 'action', 'expected', 'status', 'observation', 'evidenceKey', 'createdAt'])

export type TestAgenticStepLogScalarFieldEnum = z.infer<typeof TestAgenticStepLogScalarFieldEnumSchema>;

// File: TestCaseScriptRevisionScalarFieldEnum.schema.ts

export const TestCaseScriptRevisionScalarFieldEnumSchema = z.enum(['id', 'projectId', 'testCaseId', 'script', 'origin', 'authoredByUserId', 'authorNameSnapshot', 'authorEmailSnapshot', 'sourceResultEventId', 'restoredFromRevisionId', 'createdAt'])

export type TestCaseScriptRevisionScalarFieldEnum = z.infer<typeof TestCaseScriptRevisionScalarFieldEnumSchema>;

// File: ProjectQaSettingsScalarFieldEnum.schema.ts

export const ProjectQaSettingsScalarFieldEnumSchema = z.enum(['id', 'projectId', 'strategyDepth', 'requiredTestTypes', 'confidenceThreshold', 'indexCoverageEnabled', 'coverageTarget', 'requiredQaSignOffs', 'prReviewAutoReviewEnabled', 'prReviewQaLensEnabled', 'prReviewArchitectureLensEnabled', 'architectureRules', 'resolutions', 'browsers', 'rulesMarkdown', 'implementationNotes', 'evidencePolicy', 'evidenceRetentionDays', 'scepticRolesEnabled', 'scepticRoles', 'pipelineSyncEnabled', 'pipelineSyncIntervalMinutes', 'defaultEnvironmentId', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectQaSettingsScalarFieldEnum = z.infer<typeof ProjectQaSettingsScalarFieldEnumSchema>;

// File: PullRequestReviewScalarFieldEnum.schema.ts

export const PullRequestReviewScalarFieldEnumSchema = z.enum(['id', 'projectId', 'integrationId', 'provider', 'repoOwner', 'repoName', 'prNumber', 'title', 'authorLabel', 'headSha', 'baseSha', 'prUrl', 'diff', 'diffTruncated', 'changedFiles', 'status', 'failureText', 'requestedById', 'postedCommentId', 'qaAnalysedAt', 'qaAnalysisModel', 'architectureAnalysedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type PullRequestReviewScalarFieldEnum = z.infer<typeof PullRequestReviewScalarFieldEnumSchema>;

// File: PullRequestReviewFindingScalarFieldEnum.schema.ts

export const PullRequestReviewFindingScalarFieldEnumSchema = z.enum(['id', 'reviewId', 'projectId', 'organizationId', 'userId', 'lens', 'severity', 'title', 'detail', 'filePath', 'line', 'recommendation', 'storyId', 'criterionRef', 'status', 'dismissalReason', 'promotedStoryId', 'model', 'createdAt', 'updatedAt'])

export type PullRequestReviewFindingScalarFieldEnum = z.infer<typeof PullRequestReviewFindingScalarFieldEnumSchema>;

// File: PrReviewJudgementScalarFieldEnum.schema.ts

export const PrReviewJudgementScalarFieldEnumSchema = z.enum(['id', 'projectId', 'lens', 'fingerprint', 'status', 'dismissalReason', 'judgedById', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type PrReviewJudgementScalarFieldEnum = z.infer<typeof PrReviewJudgementScalarFieldEnumSchema>;

// File: QaSignOffScalarFieldEnum.schema.ts

export const QaSignOffScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userStoryId', 'signedById', 'signedByLabel', 'note', 'userId', 'organizationId', 'createdAt'])

export type QaSignOffScalarFieldEnum = z.infer<typeof QaSignOffScalarFieldEnumSchema>;

// File: QaOpenQuestionScalarFieldEnum.schema.ts

export const QaOpenQuestionScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userStoryId', 'question', 'answer', 'status', 'askedByLabel', 'askedById', 'answeredById', 'answeredAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type QaOpenQuestionScalarFieldEnum = z.infer<typeof QaOpenQuestionScalarFieldEnumSchema>;

// File: ProjectEnvironmentScalarFieldEnum.schema.ts

export const ProjectEnvironmentScalarFieldEnumSchema = z.enum(['id', 'projectId', 'type', 'name', 'baseUrl', 'signInUrl', 'authKind', 'authUsername', 'encryptedAuthSecret', 'authHeaderName', 'authUpdatedAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectEnvironmentScalarFieldEnum = z.infer<typeof ProjectEnvironmentScalarFieldEnumSchema>;

// File: ProjectQaWebhookScalarFieldEnum.schema.ts

export const ProjectQaWebhookScalarFieldEnumSchema = z.enum(['id', 'projectId', 'encryptedSecret', 'secretHint', 'previousEncryptedSecret', 'previousSecretRetiresAt', 'expiresAt', 'lastDeliveryAt', 'deliveryCount', 'lastError', 'lastErrorAt', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type ProjectQaWebhookScalarFieldEnum = z.infer<typeof ProjectQaWebhookScalarFieldEnumSchema>;

// File: ProjectQaWebhookDeliveryScalarFieldEnum.schema.ts

export const ProjectQaWebhookDeliveryScalarFieldEnumSchema = z.enum(['id', 'webhookId', 'provider', 'deliveryId', 'bodyDigest', 'receivedAt'])

export type ProjectQaWebhookDeliveryScalarFieldEnum = z.infer<typeof ProjectQaWebhookDeliveryScalarFieldEnumSchema>;

// File: TestCaseActivityScalarFieldEnum.schema.ts

export const TestCaseActivityScalarFieldEnumSchema = z.enum(['id', 'testCaseId', 'type', 'actorUserId', 'actorLabel', 'fromValue', 'toValue', 'metadata', 'occurredAt', 'createdAt'])

export type TestCaseActivityScalarFieldEnum = z.infer<typeof TestCaseActivityScalarFieldEnumSchema>;

// File: QaAnalysisVersionScalarFieldEnum.schema.ts

export const QaAnalysisVersionScalarFieldEnumSchema = z.enum(['id', 'userStoryId', 'projectId', 'depth', 'specHash', 'content', 'generatedByUserId', 'generatedAt', 'createdAt'])

export type QaAnalysisVersionScalarFieldEnum = z.infer<typeof QaAnalysisVersionScalarFieldEnumSchema>;

// File: TestCaseDraftJobScalarFieldEnum.schema.ts

export const TestCaseDraftJobScalarFieldEnumSchema = z.enum(['id', 'projectId', 'organizationId', 'userId', 'requestedById', 'status', 'storyIds', 'totalFeatures', 'processedFeatures', 'createdCaseIds', 'featureOutcomes', 'error', 'workflowId', 'startedAt', 'completedAt', 'createdAt', 'updatedAt'])

export type TestCaseDraftJobScalarFieldEnum = z.infer<typeof TestCaseDraftJobScalarFieldEnumSchema>;

// File: StorySubtaskScalarFieldEnum.schema.ts

export const StorySubtaskScalarFieldEnumSchema = z.enum(['id', 'taskId', 'title', 'isCompleted', 'order', 'createdAt', 'updatedAt'])

export type StorySubtaskScalarFieldEnum = z.infer<typeof StorySubtaskScalarFieldEnumSchema>;

// File: TaskWorkflowPlanScalarFieldEnum.schema.ts

export const TaskWorkflowPlanScalarFieldEnumSchema = z.enum(['id', 'taskId', 'projectId', 'userId', 'organizationId', 'status', 'temporalWorkflowId', 'summary', 'steps', 'currentStepIndex', 'checkpointData', 'result', 'createdAt', 'updatedAt'])

export type TaskWorkflowPlanScalarFieldEnum = z.infer<typeof TaskWorkflowPlanScalarFieldEnumSchema>;

// File: TaskWorkflowLogScalarFieldEnum.schema.ts

export const TaskWorkflowLogScalarFieldEnumSchema = z.enum(['id', 'planId', 'stepId', 'timestamp', 'level', 'message', 'metadata'])

export type TaskWorkflowLogScalarFieldEnum = z.infer<typeof TaskWorkflowLogScalarFieldEnumSchema>;

// File: MCPServerScalarFieldEnum.schema.ts

export const MCPServerScalarFieldEnumSchema = z.enum(['id', 'key', 'name', 'description', 'heroEmojis', 'heroImageUrl', 'defaultUrl', 'command', 'docsUrl', 'transport', 'authMethods', 'apiKeyMethod', 'oauthDiscoveryUrl', 'oauthAuthorizationEndpoint', 'oauthTokenEndpoint', 'dcrRegistrationEndpoint', 'isSystemProvided', 'isImplemented', 'defaultEnabled', 'eagerKeywords', 'eagerToolName', 'suppressOnEager', 'iconUrl', 'author', 'repositoryUrl', 'category', 'tags', 'createdById', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type MCPServerScalarFieldEnum = z.infer<typeof MCPServerScalarFieldEnumSchema>;

// File: McpRegistryVersionScalarFieldEnum.schema.ts

export const McpRegistryVersionScalarFieldEnumSchema = z.enum(['id', 'version', 'updatedAt'])

export type McpRegistryVersionScalarFieldEnum = z.infer<typeof McpRegistryVersionScalarFieldEnumSchema>;

// File: MCPConfigScalarFieldEnum.schema.ts

export const MCPConfigScalarFieldEnumSchema = z.enum(['id', 'mcpServerId', 'userId', 'organizationId', 'displayName', 'heroEmojis', 'heroImageUrl', 'baseUrl', 'commandArgs', 'transport', 'authType', 'apiKeyMethod', 'oauthClientId', 'encryptedOauthClientSecret', 'encryptedApiKey', 'encryptedAccessToken', 'accessTokenHash', 'dcrRegistrationEndpoint', 'dcrClientMetadata', 'dcrRegisteredAt', 'encryptedRefreshToken', 'tokenExpiresAt', 'scopes', 'enabled', 'isManagedDefault', 'status', 'lastHealthCheckAt', 'consecutiveFailures', 'failoverUrl', 'oauthMetadataCache', 'oauthMetadataCachedAt', 'refreshFailureCount', 'lastRefreshFailedAt', 'lastRefreshError', 'needsReauth', 'encryptedAtlassianCloudAccessToken', 'encryptedAtlassianCloudRefreshToken', 'atlassianCloudTokenExpiresAt', 'atlassianCloudSiteUrl', 'atlassianCloudCloudId', 'atlassianCloudAccessibleResources', 'atlassianCloudScopes', 'atlassianCloudConnectedAt', 'atlassianCloudRefreshFailureCount', 'atlassianCloudLastRefreshFailedAt', 'atlassianCloudLastRefreshError', 'cachedTools', 'toolsCachedAt', 'toolCount', 'description', 'domainKeywords', 'exampleQueries', 'createdAt', 'updatedAt'])

export type MCPConfigScalarFieldEnum = z.infer<typeof MCPConfigScalarFieldEnumSchema>;

// File: MCPOAuthStateScalarFieldEnum.schema.ts

export const MCPOAuthStateScalarFieldEnumSchema = z.enum(['id', 'state', 'mcpServerId', 'configId', 'userId', 'organizationId', 'codeVerifier', 'redirectUri', 'createdAt', 'expiresAt'])

export type MCPOAuthStateScalarFieldEnum = z.infer<typeof MCPOAuthStateScalarFieldEnumSchema>;

// File: MCPClientSessionScalarFieldEnum.schema.ts

export const MCPClientSessionScalarFieldEnumSchema = z.enum(['id', 'token', 'configId', 'userId', 'organizationId', 'createdAt', 'expiresAt'])

export type MCPClientSessionScalarFieldEnum = z.infer<typeof MCPClientSessionScalarFieldEnumSchema>;

// File: MCPToolConfigScalarFieldEnum.schema.ts

export const MCPToolConfigScalarFieldEnumSchema = z.enum(['id', 'mcpConfigId', 'toolName', 'stakeLevel', 'isEnabled', 'customConfig', 'createdAt', 'updatedAt'])

export type MCPToolConfigScalarFieldEnum = z.infer<typeof MCPToolConfigScalarFieldEnumSchema>;

// File: MCPToolApprovalScalarFieldEnum.schema.ts

export const MCPToolApprovalScalarFieldEnumSchema = z.enum(['id', 'toolConfigId', 'instanceId', 'targetHash', 'targetDisplay', 'approvedBy', 'approvedAt', 'expiresAt'])

export type MCPToolApprovalScalarFieldEnum = z.infer<typeof MCPToolApprovalScalarFieldEnumSchema>;

// File: AuthoritySessionScalarFieldEnum.schema.ts

export const AuthoritySessionScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'runType', 'runId', 'status', 'requestedAt', 'approvedAt', 'expiresAt', 'revokedAt', 'completedAt', 'requestedByAgentId', 'approvalInstructions'])

export type AuthoritySessionScalarFieldEnum = z.infer<typeof AuthoritySessionScalarFieldEnumSchema>;

// File: AuthorityGrantScalarFieldEnum.schema.ts

export const AuthorityGrantScalarFieldEnumSchema = z.enum(['id', 'authoritySessionId', 'kind', 'providerType', 'providerKey', 'providerRefId', 'providerDisplayName', 'accessLevel', 'toolScope', 'requestFingerprint', 'status', 'approvedBy', 'approvedAt', 'expiresAt', 'consumedAt', 'deniedAt', 'denialReason', 'metadata'])

export type AuthorityGrantScalarFieldEnum = z.infer<typeof AuthorityGrantScalarFieldEnumSchema>;

// File: PromptScalarFieldEnum.schema.ts

export const PromptScalarFieldEnumSchema = z.enum(['id', 'key', 'name', 'slug', 'description', 'scope', 'userId', 'organizationId', 'forkedFromId', 'format', 'promptType', 'structuredFormat', 'category', 'tags', 'heroEmojis', 'heroImageUrl', 'mediaUrl', 'isPublic', 'isUnlisted', 'isFeatured', 'featuredAt', 'forDevs', 'usageCount', 'viewCount', 'voteCount', 'lastUsedAt', 'deletedAt', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'])

export type PromptScalarFieldEnum = z.infer<typeof PromptScalarFieldEnumSchema>;

// File: PromptVersionScalarFieldEnum.schema.ts

export const PromptVersionScalarFieldEnumSchema = z.enum(['id', 'promptId', 'version', 'content', 'variables', 'changeNote', 'createdBy', 'createdAt', 'userId', 'organizationId', 'scope'])

export type PromptVersionScalarFieldEnum = z.infer<typeof PromptVersionScalarFieldEnumSchema>;

// File: PromptBindingScalarFieldEnum.schema.ts

export const PromptBindingScalarFieldEnumSchema = z.enum(['id', 'targetType', 'targetKey', 'documentType', 'storyKind', 'scope', 'userId', 'organizationId', 'projectId', 'promptVersionId', 'isDefault', 'createdAt', 'updatedAt'])

export type PromptBindingScalarFieldEnum = z.infer<typeof PromptBindingScalarFieldEnumSchema>;

// File: PromptVoteScalarFieldEnum.schema.ts

export const PromptVoteScalarFieldEnumSchema = z.enum(['id', 'promptId', 'userId', 'createdAt'])

export type PromptVoteScalarFieldEnum = z.infer<typeof PromptVoteScalarFieldEnumSchema>;

// File: PromptTagScalarFieldEnum.schema.ts

export const PromptTagScalarFieldEnumSchema = z.enum(['id', 'name', 'slug', 'color', 'description', 'createdAt', 'updatedAt'])

export type PromptTagScalarFieldEnum = z.infer<typeof PromptTagScalarFieldEnumSchema>;

// File: PromptTagRelationScalarFieldEnum.schema.ts

export const PromptTagRelationScalarFieldEnumSchema = z.enum(['promptId', 'tagId'])

export type PromptTagRelationScalarFieldEnum = z.infer<typeof PromptTagRelationScalarFieldEnumSchema>;

// File: PromptCommentScalarFieldEnum.schema.ts

export const PromptCommentScalarFieldEnumSchema = z.enum(['id', 'promptId', 'authorId', 'parentId', 'content', 'score', 'flagged', 'flaggedAt', 'flaggedBy', 'deletedAt', 'createdAt', 'updatedAt', 'organizationId', 'scope'])

export type PromptCommentScalarFieldEnum = z.infer<typeof PromptCommentScalarFieldEnumSchema>;

// File: PromptCommentVoteScalarFieldEnum.schema.ts

export const PromptCommentVoteScalarFieldEnumSchema = z.enum(['userId', 'commentId', 'value', 'createdAt', 'organizationId'])

export type PromptCommentVoteScalarFieldEnum = z.infer<typeof PromptCommentVoteScalarFieldEnumSchema>;

// File: PromptChangeRequestScalarFieldEnum.schema.ts

export const PromptChangeRequestScalarFieldEnumSchema = z.enum(['id', 'promptId', 'authorId', 'proposedTitle', 'proposedContent', 'originalTitle', 'originalContent', 'reason', 'reviewNote', 'status', 'createdAt', 'updatedAt', 'organizationId', 'scope'])

export type PromptChangeRequestScalarFieldEnum = z.infer<typeof PromptChangeRequestScalarFieldEnumSchema>;

// File: PromptNominationScalarFieldEnum.schema.ts

export const PromptNominationScalarFieldEnumSchema = z.enum(['id', 'promptVersionId', 'nominatedById', 'targetScope', 'organizationId', 'targets', 'changeSummary', 'summaryDegraded', 'status', 'reviewedById', 'reviewedAt', 'createdAt', 'updatedAt'])

export type PromptNominationScalarFieldEnum = z.infer<typeof PromptNominationScalarFieldEnumSchema>;

// File: PromptConnectionScalarFieldEnum.schema.ts

export const PromptConnectionScalarFieldEnumSchema = z.enum(['id', 'sourceId', 'targetId', 'label', 'order', 'createdAt', 'updatedAt', 'organizationId'])

export type PromptConnectionScalarFieldEnum = z.infer<typeof PromptConnectionScalarFieldEnumSchema>;

// File: DocumentTypeScalarFieldEnum.schema.ts

export const DocumentTypeScalarFieldEnumSchema = z.enum(['id', 'key', 'name', 'description', 'icon', 'createdAt', 'updatedAt'])

export type DocumentTypeScalarFieldEnum = z.infer<typeof DocumentTypeScalarFieldEnumSchema>;

// File: AzureAgentDeploymentScalarFieldEnum.schema.ts

export const AzureAgentDeploymentScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'agentId', 'azureAgentId', 'azureProjectName', 'displayName', 'description', 'framework', 'agentType', 'instructions', 'model', 'tools', 'endpoint', 'version', 'status', 'supportsAgUi', 'agUiVersion', 'config', 'metadata', 'createdAt', 'updatedAt', 'deployedAt'])

export type AzureAgentDeploymentScalarFieldEnum = z.infer<typeof AzureAgentDeploymentScalarFieldEnumSchema>;

// File: AzureAiModelDeploymentScalarFieldEnum.schema.ts

export const AzureAiModelDeploymentScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'deploymentName', 'modelName', 'modelFamily', 'publisher', 'endpoint', 'region', 'sku', 'capacity', 'isDefault', 'isModelRouter', 'routingRules', 'status', 'healthStatus', 'lastHealthCheck', 'tags', 'createdAt', 'updatedAt'])

export type AzureAiModelDeploymentScalarFieldEnum = z.infer<typeof AzureAiModelDeploymentScalarFieldEnumSchema>;

// File: CloudProviderConfigScalarFieldEnum.schema.ts

export const CloudProviderConfigScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'provider', 'enabled', 'isDefault', 'isEmbeddingProvider', 'priority', 'config', 'encryptedApiKey', 'clientId', 'encryptedClientSecret', 'displayName', 'description', 'tags', 'healthStatus', 'lastHealthCheck', 'lastUsedAt', 'createdAt', 'updatedAt'])

export type CloudProviderConfigScalarFieldEnum = z.infer<typeof CloudProviderConfigScalarFieldEnumSchema>;

// File: ModelRouterConfigScalarFieldEnum.schema.ts

export const ModelRouterConfigScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'strategy', 'enabled', 'rules', 'totalRequests', 'totalCost', 'avgLatency', 'createdAt', 'updatedAt'])

export type ModelRouterConfigScalarFieldEnum = z.infer<typeof ModelRouterConfigScalarFieldEnumSchema>;

// File: UserCloudProviderConfigScalarFieldEnum.schema.ts

export const UserCloudProviderConfigScalarFieldEnumSchema = z.enum(['id', 'userId', 'provider', 'enabled', 'isDefault', 'isEmbeddingProvider', 'priority', 'config', 'encryptedApiKey', 'clientId', 'encryptedClientSecret', 'displayName', 'description', 'tags', 'healthStatus', 'lastHealthCheck', 'lastUsedAt', 'createdAt', 'updatedAt'])

export type UserCloudProviderConfigScalarFieldEnum = z.infer<typeof UserCloudProviderConfigScalarFieldEnumSchema>;

// File: WorkflowScalarFieldEnum.schema.ts

export const WorkflowScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'heroEmojis', 'heroImageUrl', 'status', 'triggerType', 'triggerConfig', 'nodes', 'edges', 'variables', 'settings', 'version', 'isTemplate', 'templateId', 'userId', 'organizationId', 'projectId', 'createdAt', 'updatedAt', 'lastRunAt', 'publishedAt', 'publishedBy', 'publishedVersion', 'webhookSecret'])

export type WorkflowScalarFieldEnum = z.infer<typeof WorkflowScalarFieldEnumSchema>;

// File: WorkflowVersionScalarFieldEnum.schema.ts

export const WorkflowVersionScalarFieldEnumSchema = z.enum(['id', 'workflowId', 'version', 'nodes', 'edges', 'variables', 'settings', 'triggerConfig', 'changelog', 'isPublished', 'publishedAt', 'createdBy', 'createdAt', 'userId', 'organizationId'])

export type WorkflowVersionScalarFieldEnum = z.infer<typeof WorkflowVersionScalarFieldEnumSchema>;

// File: WorkflowExecutionScalarFieldEnum.schema.ts

export const WorkflowExecutionScalarFieldEnumSchema = z.enum(['id', 'workflowId', 'version', 'status', 'triggerType', 'triggerInput', 'output', 'error', 'startedAt', 'completedAt', 'duration', 'temporalRunId', 'userId', 'organizationId', 'pipelineId'])

export type WorkflowExecutionScalarFieldEnum = z.infer<typeof WorkflowExecutionScalarFieldEnumSchema>;

// File: WorkflowExecutionLogScalarFieldEnum.schema.ts

export const WorkflowExecutionLogScalarFieldEnumSchema = z.enum(['id', 'executionId', 'nodeId', 'nodeName', 'nodeType', 'status', 'input', 'output', 'error', 'startedAt', 'completedAt', 'duration', 'userId', 'organizationId'])

export type WorkflowExecutionLogScalarFieldEnum = z.infer<typeof WorkflowExecutionLogScalarFieldEnumSchema>;

// File: WorkflowIntegrationScalarFieldEnum.schema.ts

export const WorkflowIntegrationScalarFieldEnumSchema = z.enum(['id', 'workflowId', 'userId', 'organizationId', 'provider', 'name', 'credentials', 'settings', 'isActive', 'createdAt', 'updatedAt', 'lastUsedAt'])

export type WorkflowIntegrationScalarFieldEnum = z.infer<typeof WorkflowIntegrationScalarFieldEnumSchema>;

// File: ProjectDatabricksKnowledgeBindingScalarFieldEnum.schema.ts

export const ProjectDatabricksKnowledgeBindingScalarFieldEnumSchema = z.enum(['id', 'projectId', 'integrationId', 'allowedResources', 'isEnabled', 'createdAt', 'updatedAt', 'createdBy'])

export type ProjectDatabricksKnowledgeBindingScalarFieldEnum = z.infer<typeof ProjectDatabricksKnowledgeBindingScalarFieldEnumSchema>;

// File: WorkflowApiKeyScalarFieldEnum.schema.ts

export const WorkflowApiKeyScalarFieldEnumSchema = z.enum(['id', 'workflowId', 'name', 'keyHash', 'keyPrefix', 'permissions', 'expiresAt', 'lastUsedAt', 'usageCount', 'isActive', 'createdAt', 'createdBy', 'userId', 'organizationId'])

export type WorkflowApiKeyScalarFieldEnum = z.infer<typeof WorkflowApiKeyScalarFieldEnumSchema>;

// File: BrowserTaskScalarFieldEnum.schema.ts

export const BrowserTaskScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'status', 'sessionId', 'url', 'actions', 'extractors', 'result', 'screenshots', 'error', 'metadata', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'workflowId', 'runId'])

export type BrowserTaskScalarFieldEnum = z.infer<typeof BrowserTaskScalarFieldEnumSchema>;

// File: AutomationTemplateScalarFieldEnum.schema.ts

export const AutomationTemplateScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'workflowSteps', 'parameters', 'sourceTaskId', 'userId', 'organizationId', 'isPublic', 'version', 'category', 'tags', 'useCount', 'lastUsedAt', 'createdAt', 'updatedAt'])

export type AutomationTemplateScalarFieldEnum = z.infer<typeof AutomationTemplateScalarFieldEnumSchema>;

// File: OpenAPIServiceScalarFieldEnum.schema.ts

export const OpenAPIServiceScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'specUrl', 'baseUrl', 'specVersion', 'heroEmojis', 'heroImageUrl', 'specTitle', 'specDescription', 'specHash', 'lastSyncedAt', 'authType', 'authLocation', 'authKey', 'encryptedAuthValue', 'oauth2TokenUrl', 'oauth2AuthorizationUrl', 'oauth2ClientId', 'encryptedOauth2Secret', 'oauth2Scopes', 'encryptedAccessToken', 'encryptedRefreshToken', 'tokenExpiresAt', 'userId', 'organizationId', 'createdById', 'status', 'errorMessage', 'toolCount', 'category', 'tags', 'createdAt', 'updatedAt'])

export type OpenAPIServiceScalarFieldEnum = z.infer<typeof OpenAPIServiceScalarFieldEnumSchema>;

// File: OpenAPIToolScalarFieldEnum.schema.ts

export const OpenAPIToolScalarFieldEnumSchema = z.enum(['id', 'serviceId', 'operationId', 'name', 'description', 'method', 'path', 'parametersSchema', 'requestBodySchema', 'responseSchema', 'pathParams', 'queryParams', 'headerParams', 'deprecated', 'tags', 'enabled', 'useCount', 'lastUsedAt', 'avgResponseTime', 'errorRate', 'createdAt', 'updatedAt'])

export type OpenAPIToolScalarFieldEnum = z.infer<typeof OpenAPIToolScalarFieldEnumSchema>;

// File: OpenAPIServiceConfigScalarFieldEnum.schema.ts

export const OpenAPIServiceConfigScalarFieldEnumSchema = z.enum(['id', 'serviceId', 'userId', 'organizationId', 'enabled', 'customBaseUrl', 'customAuthType', 'encryptedCustomAuthValue', 'enabledToolIds', 'disabledToolIds', 'maxRequestsPerMinute', 'createdAt', 'updatedAt'])

export type OpenAPIServiceConfigScalarFieldEnum = z.infer<typeof OpenAPIServiceConfigScalarFieldEnumSchema>;

// File: AgentWorkspaceFileScalarFieldEnum.schema.ts

export const AgentWorkspaceFileScalarFieldEnumSchema = z.enum(['id', 'conversationId', 'userId', 'organizationId', 'path', 'name', 'extension', 'mimeType', 'content', 'size', 'fileType', 'version', 'previousVersionId', 'status', 'shareToken', 'shareScope', 'isPublic', 'sourceRunType', 'sourceRunId', 'authoritySessionId', 'providerKeys', 'metadata', 'description', 'createdAt', 'updatedAt'])

export type AgentWorkspaceFileScalarFieldEnum = z.infer<typeof AgentWorkspaceFileScalarFieldEnumSchema>;

// File: FrameSharingGrantScalarFieldEnum.schema.ts

export const FrameSharingGrantScalarFieldEnumSchema = z.enum(['id', 'frameId', 'email', 'invitedBy', 'invitedAt', 'lastAccessedAt', 'accessCount'])

export type FrameSharingGrantScalarFieldEnum = z.infer<typeof FrameSharingGrantScalarFieldEnumSchema>;

// File: FrameEditHistoryScalarFieldEnum.schema.ts

export const FrameEditHistoryScalarFieldEnumSchema = z.enum(['id', 'frameId', 'editType', 'oldString', 'newString', 'contentSnapshot', 'editedBy', 'editedAt', 'revertedToVersion'])

export type FrameEditHistoryScalarFieldEnum = z.infer<typeof FrameEditHistoryScalarFieldEnumSchema>;

// File: FrameTemplateScalarFieldEnum.schema.ts

export const FrameTemplateScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'category', 'content', 'variables', 'organizationId', 'isSystem', 'createdAt', 'updatedAt'])

export type FrameTemplateScalarFieldEnum = z.infer<typeof FrameTemplateScalarFieldEnumSchema>;

// File: WorkspaceScalarFieldEnum.schema.ts

export const WorkspaceScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'userId', 'organizationId', 'type', 'status', 'documentLimit', 'createdAt', 'updatedAt'])

export type WorkspaceScalarFieldEnum = z.infer<typeof WorkspaceScalarFieldEnumSchema>;

// File: WorkspaceDocumentScalarFieldEnum.schema.ts

export const WorkspaceDocumentScalarFieldEnumSchema = z.enum(['id', 'workspaceId', 'filename', 'originalFilename', 'mimeType', 'size', 's3Bucket', 's3Path', 'status', 'processingError', 'extractedText', 'extractorUsed', 'pageCount', 'wordCount', 'qdrantPointIds', 'embeddedAt', 'chunkCount', 'metadata', 'workflowId', 'createdAt', 'updatedAt', 'uploadedBy'])

export type WorkspaceDocumentScalarFieldEnum = z.infer<typeof WorkspaceDocumentScalarFieldEnumSchema>;

// File: WorkspaceDocumentChunkScalarFieldEnum.schema.ts

export const WorkspaceDocumentChunkScalarFieldEnumSchema = z.enum(['id', 'documentId', 'content', 'chunkIndex', 'qdrantId', 'startOffset', 'endOffset', 'pageNumber', 'headings'])

export type WorkspaceDocumentChunkScalarFieldEnum = z.infer<typeof WorkspaceDocumentChunkScalarFieldEnumSchema>;

// File: WorkspaceAdministratorScalarFieldEnum.schema.ts

export const WorkspaceAdministratorScalarFieldEnumSchema = z.enum(['id', 'workspaceId', 'userId', 'addedBy', 'addedAt'])

export type WorkspaceAdministratorScalarFieldEnum = z.infer<typeof WorkspaceAdministratorScalarFieldEnumSchema>;

// File: WorkspaceContributorScalarFieldEnum.schema.ts

export const WorkspaceContributorScalarFieldEnumSchema = z.enum(['id', 'workspaceId', 'userId', 'addedBy', 'addedAt'])

export type WorkspaceContributorScalarFieldEnum = z.infer<typeof WorkspaceContributorScalarFieldEnumSchema>;

// File: WorkspaceStakeholderScalarFieldEnum.schema.ts

export const WorkspaceStakeholderScalarFieldEnumSchema = z.enum(['id', 'workspaceId', 'userId', 'addedBy', 'addedAt'])

export type WorkspaceStakeholderScalarFieldEnum = z.infer<typeof WorkspaceStakeholderScalarFieldEnumSchema>;

// File: WorkspaceAgentScalarFieldEnum.schema.ts

export const WorkspaceAgentScalarFieldEnumSchema = z.enum(['id', 'workspaceId', 'agentId', 'addedBy', 'addedAt'])

export type WorkspaceAgentScalarFieldEnum = z.infer<typeof WorkspaceAgentScalarFieldEnumSchema>;

// File: WorkspaceConversationScalarFieldEnum.schema.ts

export const WorkspaceConversationScalarFieldEnumSchema = z.enum(['id', 'workspaceId', 'conversationId', 'allowedDocumentIds', 'accessLevel', 'attachedAt', 'attachedBy'])

export type WorkspaceConversationScalarFieldEnum = z.infer<typeof WorkspaceConversationScalarFieldEnumSchema>;

// File: ProjectConversationScalarFieldEnum.schema.ts

export const ProjectConversationScalarFieldEnumSchema = z.enum(['id', 'projectId', 'conversationId', 'attachedAt', 'attachedBy'])

export type ProjectConversationScalarFieldEnum = z.infer<typeof ProjectConversationScalarFieldEnumSchema>;

// File: DocumentAssistantConversationScalarFieldEnum.schema.ts

export const DocumentAssistantConversationScalarFieldEnumSchema = z.enum(['id', 'conversationId', 'documentRefKind', 'documentRefId', 'projectId', 'organizationId', 'userId', 'visibility', 'visibilityLockedAt', 'archivedAt', 'createdAt', 'updatedAt'])

export type DocumentAssistantConversationScalarFieldEnum = z.infer<typeof DocumentAssistantConversationScalarFieldEnumSchema>;

// File: WorkspaceRagSettingsScalarFieldEnum.schema.ts

export const WorkspaceRagSettingsScalarFieldEnumSchema = z.enum(['id', 'workspaceId', 'chunkSize', 'chunkOverlap', 'splitMethod', 'embeddingModel', 'topK', 'similarityThreshold', 'enableReranking', 'createdAt', 'updatedAt'])

export type WorkspaceRagSettingsScalarFieldEnum = z.infer<typeof WorkspaceRagSettingsScalarFieldEnumSchema>;

// File: AiModelScalarFieldEnum.schema.ts

export const AiModelScalarFieldEnumSchema = z.enum(['id', 'canonicalName', 'displayName', 'description', 'family', 'vendor', 'capabilities', 'contextWindow', 'maxOutputTokens', 'speedTier', 'qualityTier', 'inputCostPer1M', 'outputCostPer1M', 'suitableForTasks', 'isActive', 'deprecatedAt', 'replacementModelId', 'releaseDate', 'metadata', 'createdAt', 'updatedAt'])

export type AiModelScalarFieldEnum = z.infer<typeof AiModelScalarFieldEnumSchema>;

// File: AiModelProviderMappingScalarFieldEnum.schema.ts

export const AiModelProviderMappingScalarFieldEnumSchema = z.enum(['id', 'modelId', 'provider', 'providerModelId', 'maxContextWindow', 'supportedFeatures', 'isAvailable', 'availabilityNote', 'inputCostPer1M', 'outputCostPer1M', 'createdAt', 'updatedAt'])

export type AiModelProviderMappingScalarFieldEnum = z.infer<typeof AiModelProviderMappingScalarFieldEnumSchema>;

// File: AiTaskModelDefaultScalarFieldEnum.schema.ts

export const AiTaskModelDefaultScalarFieldEnumSchema = z.enum(['id', 'taskType', 'complexity', 'modelId', 'provider', 'priority', 'requiresToolCalling', 'minContextWindow', 'createdAt', 'updatedAt'])

export type AiTaskModelDefaultScalarFieldEnum = z.infer<typeof AiTaskModelDefaultScalarFieldEnumSchema>;

// File: UserModelPreferenceScalarFieldEnum.schema.ts

export const UserModelPreferenceScalarFieldEnumSchema = z.enum(['id', 'userId', 'provider', 'taskType', 'modelId', 'customParameters', 'createdAt', 'updatedAt'])

export type UserModelPreferenceScalarFieldEnum = z.infer<typeof UserModelPreferenceScalarFieldEnumSchema>;

// File: UserOrchestratorPreferencesScalarFieldEnum.schema.ts

export const UserOrchestratorPreferencesScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'enabledMcpConfigIds', 'enabledAgentIds', 'enabledWorkspaceIds', 'trustConfiguration', 'autonomyLevel', 'chatMode', 'reasoningMode', 'uiMode', 'createdAt', 'updatedAt'])

export type UserOrchestratorPreferencesScalarFieldEnum = z.infer<typeof UserOrchestratorPreferencesScalarFieldEnumSchema>;

// File: UserChatAgentSelectionScalarFieldEnum.schema.ts

export const UserChatAgentSelectionScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'version', 'selectedAgents', 'createdAt', 'updatedAt'])

export type UserChatAgentSelectionScalarFieldEnum = z.infer<typeof UserChatAgentSelectionScalarFieldEnumSchema>;

// File: NotificationPreferenceScalarFieldEnum.schema.ts

export const NotificationPreferenceScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'mentions', 'replies', 'assignments', 'status', 'syncProject', 'aiAgent', 'publishingSuggestions', 'publishingEmails', 'reportEmails', 'reviewEmails', 'stackedCardStyle', 'createdAt', 'updatedAt'])

export type NotificationPreferenceScalarFieldEnum = z.infer<typeof NotificationPreferenceScalarFieldEnumSchema>;

// File: OrganizationModelPreferenceScalarFieldEnum.schema.ts

export const OrganizationModelPreferenceScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'provider', 'taskType', 'modelId', 'customParameters', 'createdAt', 'updatedAt'])

export type OrganizationModelPreferenceScalarFieldEnum = z.infer<typeof OrganizationModelPreferenceScalarFieldEnumSchema>;

// File: AiProviderFallbackScalarFieldEnum.schema.ts

export const AiProviderFallbackScalarFieldEnumSchema = z.enum(['id', 'primaryProvider', 'fallbackProvider', 'priority', 'taskTypes', 'triggerOnErrors', 'cooldownSeconds', 'isActive', 'scope', 'userId', 'organizationId', 'createdAt', 'updatedAt', 'lastTriggeredAt', 'triggerCount'])

export type AiProviderFallbackScalarFieldEnum = z.infer<typeof AiProviderFallbackScalarFieldEnumSchema>;

// File: ApprovalTemplateScalarFieldEnum.schema.ts

export const ApprovalTemplateScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'criteria', 'behavior', 'scope', 'userId', 'organizationId', 'usageCount', 'lastUsed', 'isActive', 'createdAt', 'updatedAt'])

export type ApprovalTemplateScalarFieldEnum = z.infer<typeof ApprovalTemplateScalarFieldEnumSchema>;

// File: AiUsageLogScalarFieldEnum.schema.ts

export const AiUsageLogScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'projectId', 'providerConfigId', 'provider', 'modelCanonicalName', 'providerModelId', 'taskType', 'agentId', 'conversationId', 'featureKey', 'promptVersionId', 'jobType', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens', 'costCents', 'costMicroUsd', 'gatewayGenerationId', 'costIsActual', 'latencyMs', 'billingCategory', 'billingCustomerId', 'success', 'errorMessage', 'createdAt'])

export type AiUsageLogScalarFieldEnum = z.infer<typeof AiUsageLogScalarFieldEnumSchema>;

// File: AiUsageLimitScalarFieldEnum.schema.ts

export const AiUsageLimitScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'projectId', 'name', 'providerConfigId', 'modelCanonicalName', 'taskType', 'dimension', 'window', 'maxValue', 'enforcement', 'bannerThresholdPercent', 'createdById', 'archivedAt', 'createdAt', 'updatedAt'])

export type AiUsageLimitScalarFieldEnum = z.infer<typeof AiUsageLimitScalarFieldEnumSchema>;

// File: AiUsageLimitCounterScalarFieldEnum.schema.ts

export const AiUsageLimitCounterScalarFieldEnumSchema = z.enum(['id', 'limitId', 'windowStart', 'usedTokens', 'usedMicroUsd', 'createdAt', 'lastUpdatedAt'])

export type AiUsageLimitCounterScalarFieldEnum = z.infer<typeof AiUsageLimitCounterScalarFieldEnumSchema>;

// File: ReportTemplateScalarFieldEnum.schema.ts

export const ReportTemplateScalarFieldEnumSchema = z.enum(['id', 'name', 'description', 'heroEmojis', 'heroImageUrl', 'templateType', 'category', 'tags', 'definition', 'parameters', 'outputFormat', 'connections', 'fabricConfig', 'schedule', 'evidenceProjectId', 'evidenceReportSlug', 'evidenceConfig', 'userId', 'organizationId', 'scope', 'isPublic', 'version', 'useCount', 'lastUsedAt', 'createdAt', 'updatedAt'])

export type ReportTemplateScalarFieldEnum = z.infer<typeof ReportTemplateScalarFieldEnumSchema>;

// File: TemplateInstanceScalarFieldEnum.schema.ts

export const TemplateInstanceScalarFieldEnumSchema = z.enum(['id', 'templateId', 'userId', 'organizationId', 'sId', 'version', 'status', 'name', 'description', 'heroEmojis', 'connections', 'parameterDefaults', 'fabricConfig', 'schedule', 'nextRunAt', 'lastRunAt', 'scheduleMode', 'isActive', 'runCount', 'createdAt', 'updatedAt'])

export type TemplateInstanceScalarFieldEnum = z.infer<typeof TemplateInstanceScalarFieldEnumSchema>;

// File: TemplateInstanceExecutionScalarFieldEnum.schema.ts

export const TemplateInstanceExecutionScalarFieldEnumSchema = z.enum(['id', 'instanceId', 'userId', 'organizationId', 'status', 'startedAt', 'completedAt', 'duration', 'parameters', 'fabricEnrichment', 'dataSources', 'workflowId', 'runId', 'error', 'cancelledBy', 'cancelledAt', 'notificationEmittedAt', 'emailSentAt', 'mcpDiagnostics', 'createdAt'])

export type TemplateInstanceExecutionScalarFieldEnum = z.infer<typeof TemplateInstanceExecutionScalarFieldEnumSchema>;

// File: TemplateInstanceArtifactScalarFieldEnum.schema.ts

export const TemplateInstanceArtifactScalarFieldEnumSchema = z.enum(['id', 'executionId', 'userId', 'organizationId', 'name', 'description', 'artifactType', 's3Path', 's3Bucket', 'mimeType', 'size', 'content', 'metadata', 'qdrantId', 'embeddedAt', 'chunkCount', 'createdAt'])

export type TemplateInstanceArtifactScalarFieldEnum = z.infer<typeof TemplateInstanceArtifactScalarFieldEnumSchema>;

// File: TemplateInstanceArtifactChunkScalarFieldEnum.schema.ts

export const TemplateInstanceArtifactChunkScalarFieldEnumSchema = z.enum(['id', 'artifactId', 'content', 'chunkIndex', 'qdrantId', 'metadata', 'userId', 'organizationId'])

export type TemplateInstanceArtifactChunkScalarFieldEnum = z.infer<typeof TemplateInstanceArtifactChunkScalarFieldEnumSchema>;

// File: ReportExecutionScalarFieldEnum.schema.ts

export const ReportExecutionScalarFieldEnumSchema = z.enum(['id', 'templateId', 'userId', 'organizationId', 'status', 'startedAt', 'completedAt', 'duration', 'parameters', 'dateRange', 'dataSources', 'workflowId', 'runId', 'error', 'createdAt'])

export type ReportExecutionScalarFieldEnum = z.infer<typeof ReportExecutionScalarFieldEnumSchema>;

// File: ReportArtifactScalarFieldEnum.schema.ts

export const ReportArtifactScalarFieldEnumSchema = z.enum(['id', 'executionId', 'templateId', 'userId', 'organizationId', 'name', 'description', 'artifactType', 's3Path', 's3Bucket', 'mimeType', 'size', 'content', 'metadata', 'qdrantId', 'embeddedAt', 'chunkCount', 'evidenceEmbedUrl', 'createdAt'])

export type ReportArtifactScalarFieldEnum = z.infer<typeof ReportArtifactScalarFieldEnumSchema>;

// File: ReportArtifactChunkScalarFieldEnum.schema.ts

export const ReportArtifactChunkScalarFieldEnumSchema = z.enum(['id', 'artifactId', 'content', 'chunkIndex', 'qdrantId', 'metadata', 'userId', 'organizationId'])

export type ReportArtifactChunkScalarFieldEnum = z.infer<typeof ReportArtifactChunkScalarFieldEnumSchema>;

// File: TemplateInstanceArtifactEmailDeliveryScalarFieldEnum.schema.ts

export const TemplateInstanceArtifactEmailDeliveryScalarFieldEnumSchema = z.enum(['id', 'artifactId', 'sendId', 'userId', 'organizationId', 'recipientUserId', 'recipientEmail', 'messageBody', 'status', 'errorMessage', 'sentAt', 'createdAt'])

export type TemplateInstanceArtifactEmailDeliveryScalarFieldEnum = z.infer<typeof TemplateInstanceArtifactEmailDeliveryScalarFieldEnumSchema>;

// File: AgentTemplateScalarFieldEnum.schema.ts

export const AgentTemplateScalarFieldEnumSchema = z.enum(['id', 'slug', 'name', 'displayName', 'description', 'heroEmojis', 'heroImageUrl', 'category', 'tags', 'instructions', 'suggestedModel', 'modelConfig', 'promptBindingId', 'documentType', 'scope', 'userId', 'organizationId', 'isPublished', 'isFeatured', 'useCount', 'lastUsedAt', 'version', 'createdAt', 'updatedAt'])

export type AgentTemplateScalarFieldEnum = z.infer<typeof AgentTemplateScalarFieldEnumSchema>;

// File: AgentTemplateInstanceScalarFieldEnum.schema.ts

export const AgentTemplateInstanceScalarFieldEnumSchema = z.enum(['id', 'templateId', 'userId', 'organizationId', 'sId', 'version', 'status', 'name', 'description', 'heroEmojis', 'heroImageUrl', 'customInstructions', 'toolConnections', 'triggers', 'modelOverride', 'modelConfig', 'workspaceIds', 'executionMode', 'goal', 'successCriteria', 'maxIterations', 'memoryAutoApprove', 'runCount', 'lastRunAt', 'isApiExposed', 'apiConfig', 'createdAt', 'updatedAt'])

export type AgentTemplateInstanceScalarFieldEnum = z.infer<typeof AgentTemplateInstanceScalarFieldEnumSchema>;

// File: AgentTemplateConversationScalarFieldEnum.schema.ts

export const AgentTemplateConversationScalarFieldEnumSchema = z.enum(['id', 'instanceId', 'userId', 'organizationId', 'instanceVersion', 'title', 'isPinned', 'isArchived', 'messages', 'context', 'inputTokens', 'outputTokens', 'createdAt', 'updatedAt'])

export type AgentTemplateConversationScalarFieldEnum = z.infer<typeof AgentTemplateConversationScalarFieldEnumSchema>;

// File: AgentTemplateExecutionScalarFieldEnum.schema.ts

export const AgentTemplateExecutionScalarFieldEnumSchema = z.enum(['id', 'instanceId', 'userId', 'organizationId', 'triggerType', 'triggerData', 'status', 'startedAt', 'completedAt', 'duration', 'input', 'output', 'error', 'workflowId', 'runId', 'createdAt'])

export type AgentTemplateExecutionScalarFieldEnum = z.infer<typeof AgentTemplateExecutionScalarFieldEnumSchema>;

// File: AgentMCPServerConfigurationScalarFieldEnum.schema.ts

export const AgentMCPServerConfigurationScalarFieldEnumSchema = z.enum(['id', 'instanceId', 'mcpConfigId', 'name', 'description', 'integrationIds', 'dataSourceIds', 'tableIds', 'childAgentId', 'timeFrameDuration', 'timeFrameUnit', 'jsonSchema', 'authLevel', 'isEnabled', 'createdAt', 'updatedAt'])

export type AgentMCPServerConfigurationScalarFieldEnum = z.infer<typeof AgentMCPServerConfigurationScalarFieldEnumSchema>;

// File: AgentIntegrationConfigurationScalarFieldEnum.schema.ts

export const AgentIntegrationConfigurationScalarFieldEnumSchema = z.enum(['id', 'instanceId', 'integrationId', 'integrationType', 'allowedResources', 'timeFrameDuration', 'timeFrameUnit', 'accessLevel', 'isEnabled', 'createdAt', 'updatedAt'])

export type AgentIntegrationConfigurationScalarFieldEnum = z.infer<typeof AgentIntegrationConfigurationScalarFieldEnumSchema>;

// File: AgentDeploymentScalarFieldEnum.schema.ts

export const AgentDeploymentScalarFieldEnumSchema = z.enum(['id', 'instanceId', 'userId', 'organizationId', 'name', 'slug', 'status', 'deployedAt', 'pausedAt', 'terminatedAt', 'lastActiveAt', 'supervisorWorkflowId', 'supervisorRunId', 'taskQueue', 'healthStatus', 'lastHealthCheck', 'consecutiveFailures', 'maxConcurrentExecutions', 'currentExecutions', 'rateLimitPerMinute', 'rateLimitPerHour', 'activeTriggers', 'dailyExecutionLimit', 'monthlyExecutionLimit', 'dailyExecutionCount', 'monthlyExecutionCount', 'quotaResetAt', 'version', 'createdAt', 'updatedAt'])

export type AgentDeploymentScalarFieldEnum = z.infer<typeof AgentDeploymentScalarFieldEnumSchema>;

// File: AgentDeploymentExecutionScalarFieldEnum.schema.ts

export const AgentDeploymentExecutionScalarFieldEnumSchema = z.enum(['id', 'deploymentId', 'userId', 'organizationId', 'executionId', 'triggerType', 'triggerId', 'triggerData', 'status', 'queuedAt', 'startedAt', 'completedAt', 'duration', 'priority', 'input', 'output', 'error', 'workflowId', 'runId', 'inputTokens', 'outputTokens', 'totalCost', 'metadata', 'createdAt', 'updatedAt'])

export type AgentDeploymentExecutionScalarFieldEnum = z.infer<typeof AgentDeploymentExecutionScalarFieldEnumSchema>;

// File: AgentExecutionStepScalarFieldEnum.schema.ts

export const AgentExecutionStepScalarFieldEnumSchema = z.enum(['id', 'executionId', 'stepNumber', 'stepType', 'name', 'description', 'startedAt', 'completedAt', 'duration', 'input', 'output', 'error', 'status', 'userId', 'organizationId', 'createdAt'])

export type AgentExecutionStepScalarFieldEnum = z.infer<typeof AgentExecutionStepScalarFieldEnumSchema>;

// File: AgentDeploymentTriggerScalarFieldEnum.schema.ts

export const AgentDeploymentTriggerScalarFieldEnumSchema = z.enum(['id', 'deploymentId', 'type', 'config', 'webhookSecret', 'webhookUrl', 'cronExpression', 'timezone', 'nextRunAt', 'lastRunAt', 'slackChannelId', 'slackTeamId', 'projectId', 'isActive', 'totalExecutions', 'lastExecutionId', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type AgentDeploymentTriggerScalarFieldEnum = z.infer<typeof AgentDeploymentTriggerScalarFieldEnumSchema>;

// File: SlackThreadMappingScalarFieldEnum.schema.ts

export const SlackThreadMappingScalarFieldEnumSchema = z.enum(['id', 'slackTeamId', 'slackChannelId', 'slackThreadTs', 'deploymentId', 'triggerId', 'workflowId', 'conversationId', 'status', 'lastMessageTs', 'timeoutAt', 'contextJson', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type SlackThreadMappingScalarFieldEnum = z.infer<typeof SlackThreadMappingScalarFieldEnumSchema>;

// File: SlackEventReceiptScalarFieldEnum.schema.ts

export const SlackEventReceiptScalarFieldEnumSchema = z.enum(['id', 'slackEventId', 'slackTeamId', 'slackChannelId', 'slackMessageTs', 'processedAt', 'organizationId', 'userId'])

export type SlackEventReceiptScalarFieldEnum = z.infer<typeof SlackEventReceiptScalarFieldEnumSchema>;

// File: TeamsEventReceiptScalarFieldEnum.schema.ts

export const TeamsEventReceiptScalarFieldEnumSchema = z.enum(['id', 'teamsEventId', 'channelId', 'teamId', 'messageId', 'receivedAt', 'userId', 'organizationId'])

export type TeamsEventReceiptScalarFieldEnum = z.infer<typeof TeamsEventReceiptScalarFieldEnumSchema>;

// File: AgentDeploymentMetricsScalarFieldEnum.schema.ts

export const AgentDeploymentMetricsScalarFieldEnumSchema = z.enum(['id', 'deploymentId', 'windowStart', 'windowEnd', 'windowType', 'totalExecutions', 'successfulExecutions', 'failedExecutions', 'cancelledExecutions', 'timedOutExecutions', 'avgDurationMs', 'p50DurationMs', 'p95DurationMs', 'p99DurationMs', 'totalInputTokens', 'totalOutputTokens', 'totalCost', 'executionsByTrigger', 'userId', 'organizationId', 'createdAt'])

export type AgentDeploymentMetricsScalarFieldEnum = z.infer<typeof AgentDeploymentMetricsScalarFieldEnumSchema>;

// File: TaskQueueShardScalarFieldEnum.schema.ts

export const TaskQueueShardScalarFieldEnumSchema = z.enum(['id', 'queueName', 'shardType', 'organizationId', 'currentDepth', 'maxDepth', 'activeWorkers', 'targetWorkers', 'isHealthy', 'lastHealthCheck', 'totalProcessed', 'avgLatencyMs', 'createdAt', 'updatedAt'])

export type TaskQueueShardScalarFieldEnum = z.infer<typeof TaskQueueShardScalarFieldEnumSchema>;

// File: OrganizationDeploymentQuotaScalarFieldEnum.schema.ts

export const OrganizationDeploymentQuotaScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'maxDeployments', 'maxConcurrentExecutions', 'dailyExecutionLimit', 'monthlyExecutionLimit', 'currentDeployments', 'dailyExecutionCount', 'monthlyExecutionCount', 'dailyResetAt', 'monthlyResetAt', 'customLimits', 'createdAt', 'updatedAt'])

export type OrganizationDeploymentQuotaScalarFieldEnum = z.infer<typeof OrganizationDeploymentQuotaScalarFieldEnumSchema>;

// File: UserDeploymentQuotaScalarFieldEnum.schema.ts

export const UserDeploymentQuotaScalarFieldEnumSchema = z.enum(['id', 'userId', 'maxDeployments', 'maxConcurrentExecutions', 'dailyExecutionLimit', 'monthlyExecutionLimit', 'currentDeployments', 'dailyExecutionCount', 'monthlyExecutionCount', 'dailyResetAt', 'monthlyResetAt', 'createdAt', 'updatedAt'])

export type UserDeploymentQuotaScalarFieldEnum = z.infer<typeof UserDeploymentQuotaScalarFieldEnumSchema>;

// File: AgentMemoryFileScalarFieldEnum.schema.ts

export const AgentMemoryFileScalarFieldEnumSchema = z.enum(['id', 'agentInstanceId', 'userId', 'organizationId', 'path', 'fileType', 'content', 'contentHash', 'version', 'isValid', 'validationError', 'lastModifiedBy', 'createdAt', 'updatedAt', 'sourceSkillId', 'isEnabled'])

export type AgentMemoryFileScalarFieldEnum = z.infer<typeof AgentMemoryFileScalarFieldEnumSchema>;

// File: AgentMemoryEditScalarFieldEnum.schema.ts

export const AgentMemoryEditScalarFieldEnumSchema = z.enum(['id', 'memoryFileId', 'agentInstanceId', 'userId', 'organizationId', 'operation', 'path', 'oldContent', 'newContent', 'reason', 'status', 'autoApproved', 'approvedBy', 'approvedAt', 'rejectionReason', 'createdAt'])

export type AgentMemoryEditScalarFieldEnum = z.infer<typeof AgentMemoryEditScalarFieldEnumSchema>;

// File: SkillScalarFieldEnum.schema.ts

export const SkillScalarFieldEnumSchema = z.enum(['id', 'slug', 'name', 'description', 'content', 'category', 'tags', 'scope', 'userId', 'organizationId', 'version', 'isPublished', 'useCount', 'createdAt', 'updatedAt'])

export type SkillScalarFieldEnum = z.infer<typeof SkillScalarFieldEnumSchema>;

// File: SkillFileScalarFieldEnum.schema.ts

export const SkillFileScalarFieldEnumSchema = z.enum(['id', 'skillId', 'path', 'contentType', 'storageKey', 'sizeBytes', 'sha256', 'version', 'createdAt', 'updatedAt'])

export type SkillFileScalarFieldEnum = z.infer<typeof SkillFileScalarFieldEnumSchema>;

// File: AgentTemplateSkillScalarFieldEnum.schema.ts

export const AgentTemplateSkillScalarFieldEnumSchema = z.enum(['id', 'templateId', 'skillId', 'isRequired', 'sortOrder', 'createdAt'])

export type AgentTemplateSkillScalarFieldEnum = z.infer<typeof AgentTemplateSkillScalarFieldEnumSchema>;

// File: ReportTemplateSkillScalarFieldEnum.schema.ts

export const ReportTemplateSkillScalarFieldEnumSchema = z.enum(['id', 'templateId', 'skillId', 'isRequired', 'sortOrder', 'createdAt'])

export type ReportTemplateSkillScalarFieldEnum = z.infer<typeof ReportTemplateSkillScalarFieldEnumSchema>;

// File: OrchestratorMemoryPreferencesScalarFieldEnum.schema.ts

export const OrchestratorMemoryPreferencesScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'responseStyle', 'verbosity', 'codeLanguage', 'timezone', 'language', 'preferences', 'recentProjectIds', 'recentWorkspaceIds', 'lastActiveAt', 'createdAt', 'updatedAt'])

export type OrchestratorMemoryPreferencesScalarFieldEnum = z.infer<typeof OrchestratorMemoryPreferencesScalarFieldEnumSchema>;

// File: EpisodicMemoryScalarFieldEnum.schema.ts

export const EpisodicMemoryScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'projectId', 'workspaceId', 'conversationId', 'agentId', 'title', 'summary', 'keyTopics', 'userIntents', 'outcome', 'messageCount', 'turnCount', 'toolsUsed', 'agentsUsed', 'conversationStartedAt', 'conversationEndedAt', 'createdAt', 'qdrantPointId', 'qdrantCollection'])

export type EpisodicMemoryScalarFieldEnum = z.infer<typeof EpisodicMemoryScalarFieldEnumSchema>;

// File: GoldenReferenceScalarFieldEnum.schema.ts

export const GoldenReferenceScalarFieldEnumSchema = z.enum(['id', 'documentType', 'name', 'description', 'content', 'projectContext', 'requiredSections', 'keyPhrases', 'qdrantPointId', 'qdrantCollection', 'version', 'isActive', 'scope', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type GoldenReferenceScalarFieldEnum = z.infer<typeof GoldenReferenceScalarFieldEnumSchema>;

// File: DocumentEvalScalarFieldEnum.schema.ts

export const DocumentEvalScalarFieldEnumSchema = z.enum(['id', 'projectDocumentId', 'documentVersion', 'goldenReferenceId', 'overallScore', 'passed', 'threshold', 'structureScore', 'coverageScore', 'similarityScore', 'qualityScore', 'evalVersion', 'contentHash', 'costUsd', 'evalMode', 'llmProvider', 'llmModel', 'nlpDurationMs', 'llmDurationMs', 'nlpScores', 'llmScores', 'feedback', 'suggestions', 'missingSections', 'missingPhrases', 'workflowId', 'executionTimeMs', 'userId', 'organizationId', 'createdAt'])

export type DocumentEvalScalarFieldEnum = z.infer<typeof DocumentEvalScalarFieldEnumSchema>;

// File: OrganizationEvalBudgetScalarFieldEnum.schema.ts

export const OrganizationEvalBudgetScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'monthlyBudgetUsd', 'currentMonthUsd', 'lastResetAt', 'createdAt', 'updatedAt'])

export type OrganizationEvalBudgetScalarFieldEnum = z.infer<typeof OrganizationEvalBudgetScalarFieldEnumSchema>;

// File: DocumentEvalMetricScalarFieldEnum.schema.ts

export const DocumentEvalMetricScalarFieldEnumSchema = z.enum(['id', 'documentEvalId', 'metricName', 'category', 'score', 'weight', 'rawValue', 'description', 'metadata', 'createdAt'])

export type DocumentEvalMetricScalarFieldEnum = z.infer<typeof DocumentEvalMetricScalarFieldEnumSchema>;

// File: OffloadedToolOutputScalarFieldEnum.schema.ts

export const OffloadedToolOutputScalarFieldEnumSchema = z.enum(['id', 'executionId', 'toolName', 'summary', 'fullOutput', 'outputSizeBytes', 'contentHash', 'expiresAt', 'userId', 'organizationId', 'createdAt'])

export type OffloadedToolOutputScalarFieldEnum = z.infer<typeof OffloadedToolOutputScalarFieldEnumSchema>;

// File: DynamicAgentConfigScalarFieldEnum.schema.ts

export const DynamicAgentConfigScalarFieldEnumSchema = z.enum(['id', 'name', 'displayName', 'description', 'avatarUrl', 'userId', 'organizationId', 'scope', 'systemPrompt', 'instructionSections', 'enabledToolIds', 'workspaceIds', 'connectorIds', 'canDelegateToAgents', 'delegatableAgentIds', 'maxRecursionDepth', 'aiModel', 'aiProvider', 'temperature', 'maxIterations', 'maxTokensPerTurn', 'timeoutMs', 'version', 'versionNotes', 'previousVersionId', 'status', 'createdAt', 'updatedAt', 'publishedAt'])

export type DynamicAgentConfigScalarFieldEnum = z.infer<typeof DynamicAgentConfigScalarFieldEnumSchema>;

// File: DynamicAgentTriggerScalarFieldEnum.schema.ts

export const DynamicAgentTriggerScalarFieldEnumSchema = z.enum(['id', 'agentConfigId', 'type', 'name', 'description', 'isEnabled', 'schedule', 'timezone', 'webhookSecret', 'eventType', 'eventFilter', 'inputTemplate', 'lastTriggeredAt', 'nextScheduledAt', 'triggerCount', 'createdAt', 'updatedAt'])

export type DynamicAgentTriggerScalarFieldEnum = z.infer<typeof DynamicAgentTriggerScalarFieldEnumSchema>;

// File: DynamicAgentExecutionScalarFieldEnum.schema.ts

export const DynamicAgentExecutionScalarFieldEnumSchema = z.enum(['id', 'agentConfigId', 'triggerId', 'temporalWorkflowId', 'temporalRunId', 'userId', 'organizationId', 'status', 'input', 'output', 'error', 'iterationCount', 'totalTokensUsed', 'totalToolCalls', 'totalDelegations', 'durationMs', 'conversationHistory', 'toolOutputRefs', 'metadata', 'startedAt', 'completedAt', 'createdAt', 'updatedAt'])

export type DynamicAgentExecutionScalarFieldEnum = z.infer<typeof DynamicAgentExecutionScalarFieldEnumSchema>;

// File: DynamicAgentFavoriteScalarFieldEnum.schema.ts

export const DynamicAgentFavoriteScalarFieldEnumSchema = z.enum(['id', 'userId', 'agentConfigId', 'createdAt'])

export type DynamicAgentFavoriteScalarFieldEnum = z.infer<typeof DynamicAgentFavoriteScalarFieldEnumSchema>;

// File: DataConnectionScalarFieldEnum.schema.ts

export const DataConnectionScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'provider', 'name', 'status', 'credentialId', 'externalWorkspaceId', 'externalWorkspaceName', 'accessToken', 'refreshToken', 'tokenExpiresAt', 'credentials', 'config', 'lastSyncAt', 'lastSyncError', 'createdAt', 'updatedAt', 'createdBy'])

export type DataConnectionScalarFieldEnum = z.infer<typeof DataConnectionScalarFieldEnumSchema>;

// File: DataConnectionCredentialScalarFieldEnum.schema.ts

export const DataConnectionCredentialScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'provider', 'name', 'credentialType', 'encryptedPayload', 'createdAt', 'updatedAt', 'createdBy'])

export type DataConnectionCredentialScalarFieldEnum = z.infer<typeof DataConnectionCredentialScalarFieldEnumSchema>;

// File: ErrorRateIncidentScalarFieldEnum.schema.ts

export const ErrorRateIncidentScalarFieldEnumSchema = z.enum(['id', 'alertName', 'severity', 'service', 'feature', 'errorClass', 'status', 'firedAt', 'resolvedAt', 'acknowledgedAt', 'acknowledgedBy', 'burnRate1h', 'burnRate5m', 'errorCount', 'alertmanagerFingerprint', 'createdAt', 'updatedAt'])

export type ErrorRateIncidentScalarFieldEnum = z.infer<typeof ErrorRateIncidentScalarFieldEnumSchema>;

// File: IntegrationIncidentScalarFieldEnum.schema.ts

export const IntegrationIncidentScalarFieldEnumSchema = z.enum(['id', 'providerKey', 'providerName', 'status', 'severity', 'health', 'startedAt', 'resolvedAt', 'acknowledgedAt', 'acknowledgedBy', 'detectionMethod', 'statusPageUrl', 'statusPageIncidentId', 'affectedComponents', 'summary', 'alertmanagerFingerprint', 'createdAt', 'updatedAt'])

export type IntegrationIncidentScalarFieldEnum = z.infer<typeof IntegrationIncidentScalarFieldEnumSchema>;

// File: ComponentIncidentScalarFieldEnum.schema.ts

export const ComponentIncidentScalarFieldEnumSchema = z.enum(['id', 'componentKey', 'componentName', 'status', 'severity', 'firedAt', 'resolvedAt', 'acknowledgedAt', 'acknowledgedBy', 'autoResolved', 'summary', 'alertmanagerFingerprint', 'createdAt', 'updatedAt'])

export type ComponentIncidentScalarFieldEnum = z.infer<typeof ComponentIncidentScalarFieldEnumSchema>;

// File: IncidentEventScalarFieldEnum.schema.ts

export const IncidentEventScalarFieldEnumSchema = z.enum(['id', 'errorRateIncidentId', 'integrationIncidentId', 'componentIncidentId', 'eventType', 'message', 'payload', 'actorUserId', 'createdAt'])

export type IncidentEventScalarFieldEnum = z.infer<typeof IncidentEventScalarFieldEnumSchema>;

// File: IntegrationProviderRegistryScalarFieldEnum.schema.ts

export const IntegrationProviderRegistryScalarFieldEnumSchema = z.enum(['id', 'providerKey', 'displayName', 'currentHealth', 'lastPolledAt', 'lastIncidentId', 'statusPageUrl', 'statusPageApiUrl', 'statusPagePolling', 'syntheticProbeEnabled', 'syntheticProbeInterval', 'breakerKey', 'affectedFeatures', 'dataConnectionProvider', 'createdAt', 'updatedAt'])

export type IntegrationProviderRegistryScalarFieldEnum = z.infer<typeof IntegrationProviderRegistryScalarFieldEnumSchema>;

// File: StatusUpdateScalarFieldEnum.schema.ts

export const StatusUpdateScalarFieldEnumSchema = z.enum(['id', 'title', 'body', 'lifecycle', 'impact', 'affectedComponentKeys', 'affectedProviderKeys', 'startedAt', 'resolvedAt', 'scheduledFor', 'componentIncidentId', 'integrationIncidentId', 'publishedByUserId', 'createdAt', 'updatedAt'])

export type StatusUpdateScalarFieldEnum = z.infer<typeof StatusUpdateScalarFieldEnumSchema>;

// File: StatusUpdateRevisionScalarFieldEnum.schema.ts

export const StatusUpdateRevisionScalarFieldEnumSchema = z.enum(['id', 'statusUpdateId', 'lifecycle', 'body', 'authorUserId', 'createdAt'])

export type StatusUpdateRevisionScalarFieldEnum = z.infer<typeof StatusUpdateRevisionScalarFieldEnumSchema>;

// File: DataSyncJobScalarFieldEnum.schema.ts

export const DataSyncJobScalarFieldEnumSchema = z.enum(['id', 'connectionId', 'status', 'type', 'totalItems', 'processedItems', 'failedItems', 'startedAt', 'completedAt', 'error', 'stats', 'workflowId', 'runId', 'createdAt', 'updatedAt'])

export type DataSyncJobScalarFieldEnum = z.infer<typeof DataSyncJobScalarFieldEnumSchema>;

// File: BackgroundJobScalarFieldEnum.schema.ts

export const BackgroundJobScalarFieldEnumSchema = z.enum(['id', 'kind', 'status', 'title', 'sourceType', 'sourceId', 'counts', 'steps', 'error', 'errorClass', 'workflowId', 'runId', 'startedAt', 'completedAt', 'heartbeatAt', 'projectId', 'userId', 'organizationId', 'createdAt', 'updatedAt'])

export type BackgroundJobScalarFieldEnum = z.infer<typeof BackgroundJobScalarFieldEnumSchema>;

// File: SyncedResourceScalarFieldEnum.schema.ts

export const SyncedResourceScalarFieldEnumSchema = z.enum(['id', 'connectionId', 'externalId', 'externalPath', 'resourceType', 'title', 'contentHash', 'metadata', 'workspaceId', 'documentId', 'lastSyncedAt', 'syncStatus', 'syncError', 'sizeBytes', 'textLength', 'createdAt', 'updatedAt'])

export type SyncedResourceScalarFieldEnum = z.infer<typeof SyncedResourceScalarFieldEnumSchema>;

// File: DataSyncScheduleScalarFieldEnum.schema.ts

export const DataSyncScheduleScalarFieldEnumSchema = z.enum(['id', 'connectionId', 'frequency', 'cronExpression', 'isActive', 'lastRunAt', 'nextRunAt', 'createdAt', 'updatedAt'])

export type DataSyncScheduleScalarFieldEnum = z.infer<typeof DataSyncScheduleScalarFieldEnumSchema>;

// File: ExternalApiUsageLogScalarFieldEnum.schema.ts

export const ExternalApiUsageLogScalarFieldEnumSchema = z.enum(['id', 'apiKeyType', 'apiKeyId', 'apiKeyPrefix', 'instanceId', 'deploymentId', 'userId', 'organizationId', 'executionId', 'endpoint', 'method', 'statusCode', 'latencyMs', 'inputTokens', 'outputTokens', 'estimatedCost', 'clientIp', 'userAgent', 'createdAt'])

export type ExternalApiUsageLogScalarFieldEnum = z.infer<typeof ExternalApiUsageLogScalarFieldEnumSchema>;

// File: KanbanQueueScalarFieldEnum.schema.ts

export const KanbanQueueScalarFieldEnumSchema = z.enum(['id', 'projectId', 'storyId', 'organizationId', 'createdById', 'status', 'context', 'queuedAt', 'pulledAt', 'completedAt', 'branchName'])

export type KanbanQueueScalarFieldEnum = z.infer<typeof KanbanQueueScalarFieldEnumSchema>;

// File: CodingRunScalarFieldEnum.schema.ts

export const CodingRunScalarFieldEnumSchema = z.enum(['id', 'projectId', 'storyId', 'storyTaskId', 'userId', 'organizationId', 'weaveExecutionId', 'executionChannel', 'provider', 'providerSessionId', 'providerMetadata', 'externalUrl', 'externalStatus', 'status', 'repositoryUrl', 'repositoryOwner', 'repositoryName', 'targetBranch', 'workingDirectory', 'pullRequestUrl', 'pullRequestNumber', 'pullRequestBranch', 'promptText', 'workflowId', 'lastProviderEventAt', 'startedAt', 'lastError', 'createdAt', 'updatedAt'])

export type CodingRunScalarFieldEnum = z.infer<typeof CodingRunScalarFieldEnumSchema>;

// File: CodingRunEventScalarFieldEnum.schema.ts

export const CodingRunEventScalarFieldEnumSchema = z.enum(['id', 'codingRunId', 'eventType', 'providerEventId', 'payloadJson', 'createdAt'])

export type CodingRunEventScalarFieldEnum = z.infer<typeof CodingRunEventScalarFieldEnumSchema>;

// File: DiagramScalarFieldEnum.schema.ts

export const DiagramScalarFieldEnumSchema = z.enum(['id', 'title', 'elements', 'appState', 'checkpointId', 'mcpConfigId', 'userId', 'organizationId', 'projectId', 'createdAt', 'updatedAt'])

export type DiagramScalarFieldEnum = z.infer<typeof DiagramScalarFieldEnumSchema>;

// File: ProjectRepositoryIntegrationScalarFieldEnum.schema.ts

export const ProjectRepositoryIntegrationScalarFieldEnumSchema = z.enum(['id', 'projectId', 'provider', 'authMethod', 'repositoryUrl', 'repositoryOwner', 'repositoryName', 'defaultBranch', 'roleTag', 'qaBranch', 'pinnedBranches', 'encryptedAccessToken', 'encryptedRefreshToken', 'tokenExpiresAt', 'tokenScopes', 'encryptedPat', 'azureOrganization', 'status', 'lastHealthCheck', 'lastError', 'probeFailCount', 'refreshTokenRejectedAt', 'configuredByUserId', 'createdAt', 'updatedAt'])

export type ProjectRepositoryIntegrationScalarFieldEnum = z.infer<typeof ProjectRepositoryIntegrationScalarFieldEnumSchema>;

// File: ProjectWeaveConfigScalarFieldEnum.schema.ts

export const ProjectWeaveConfigScalarFieldEnumSchema = z.enum(['id', 'projectId', 'userId', 'organizationId', 'patternConfig', 'shuttleConfig', 'requireReview', 'requireSecurityReview', 'autoExecuteSimple', 'complexityThreshold', 'enabledSkills', 'enabledMcpTools', 'categoryRouting', 'createdAt', 'updatedAt'])

export type ProjectWeaveConfigScalarFieldEnum = z.infer<typeof ProjectWeaveConfigScalarFieldEnumSchema>;

// File: WeavePlanScalarFieldEnum.schema.ts

export const WeavePlanScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'projectId', 'userStoryId', 'storyTaskId', 'name', 'description', 'status', 'checkboxes', 'createdAt', 'updatedAt'])

export type WeavePlanScalarFieldEnum = z.infer<typeof WeavePlanScalarFieldEnumSchema>;

// File: WeavePlanTemplateScalarFieldEnum.schema.ts

export const WeavePlanTemplateScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'projectId', 'name', 'description', 'category', 'message', 'checkboxes', 'useCount', 'createdAt', 'updatedAt'])

export type WeavePlanTemplateScalarFieldEnum = z.infer<typeof WeavePlanTemplateScalarFieldEnumSchema>;

// File: WeaveExecutionScalarFieldEnum.schema.ts

export const WeaveExecutionScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'planId', 'projectId', 'workflowId', 'runId', 'sandboxSessionId', 'status', 'currentStep', 'checkboxes', 'artifacts', 'error', 'createdAt', 'updatedAt', 'startedAt', 'completedAt'])

export type WeaveExecutionScalarFieldEnum = z.infer<typeof WeaveExecutionScalarFieldEnumSchema>;

// File: ChatArtifactScalarFieldEnum.schema.ts

export const ChatArtifactScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'conversationId', 'instanceId', 'projectId', 'type', 'title', 'description', 'content', 'mimeType', 's3Path', 's3Bucket', 'fileSize', 'metadata', 'version', 'parentId', 'indexedAt', 'qdrantId', 'createdAt', 'updatedAt'])

export type ChatArtifactScalarFieldEnum = z.infer<typeof ChatArtifactScalarFieldEnumSchema>;

// File: NotificationScalarFieldEnum.schema.ts

export const NotificationScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'type', 'category', 'title', 'snippet', 'link', 'iconKey', 'projectId', 'storyId', 'taskId', 'commentId', 'documentId', 'actorUserId', 'payload', 'readAt', 'archivedAt', 'dedupeKey', 'createdAt', 'updatedAt'])

export type NotificationScalarFieldEnum = z.infer<typeof NotificationScalarFieldEnumSchema>;

// File: NotificationDeliveryPreferenceScalarFieldEnum.schema.ts

export const NotificationDeliveryPreferenceScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'emailEnabled', 'webhookEnabled', 'encryptedWebhookUrl', 'encryptedWebhookSecret', 'createdAt', 'updatedAt'])

export type NotificationDeliveryPreferenceScalarFieldEnum = z.infer<typeof NotificationDeliveryPreferenceScalarFieldEnumSchema>;

// File: SubscriptionScalarFieldEnum.schema.ts

export const SubscriptionScalarFieldEnumSchema = z.enum(['id', 'userId', 'organizationId', 'subjectType', 'subjectId', 'createdAt'])

export type SubscriptionScalarFieldEnum = z.infer<typeof SubscriptionScalarFieldEnumSchema>;

// File: PendingPmStateChangeScalarFieldEnum.schema.ts

export const PendingPmStateChangeScalarFieldEnumSchema = z.enum(['id', 'projectId', 'entityType', 'entityId', 'externalId', 'previousState', 'newState', 'proposedAction', 'status', 'detectedPmHash', 'expectedExternalMcpServerId', 'createdAt', 'reviewedAt', 'reviewedBy'])

export type PendingPmStateChangeScalarFieldEnum = z.infer<typeof PendingPmStateChangeScalarFieldEnumSchema>;

// File: PmTicketMissingStreakScalarFieldEnum.schema.ts

export const PmTicketMissingStreakScalarFieldEnumSchema = z.enum(['id', 'projectId', 'entityType', 'entityId', 'externalId', 'missStreak', 'firstMissingAt', 'lastMissingAt', 'lastCountedRunId'])

export type PmTicketMissingStreakScalarFieldEnum = z.infer<typeof PmTicketMissingStreakScalarFieldEnumSchema>;

// File: FeatureFlagOverrideScalarFieldEnum.schema.ts

export const FeatureFlagOverrideScalarFieldEnumSchema = z.enum(['key', 'enabled', 'updatedAt', 'updatedBy'])

export type FeatureFlagOverrideScalarFieldEnum = z.infer<typeof FeatureFlagOverrideScalarFieldEnumSchema>;

// File: SortOrder.schema.ts

export const SortOrderSchema = z.enum(['asc', 'desc'])

export type SortOrder = z.infer<typeof SortOrderSchema>;

// File: NullableJsonNullValueInput.schema.ts

export const NullableJsonNullValueInputSchema = z.enum(['DbNull', 'JsonNull'])

export type NullableJsonNullValueInput = z.infer<typeof NullableJsonNullValueInputSchema>;

// File: JsonNullValueInput.schema.ts

export const JsonNullValueInputSchema = z.enum(['JsonNull'])

export type JsonNullValueInput = z.infer<typeof JsonNullValueInputSchema>;

// File: QueryMode.schema.ts

export const QueryModeSchema = z.enum(['default', 'insensitive'])

export type QueryMode = z.infer<typeof QueryModeSchema>;

// File: JsonNullValueFilter.schema.ts

export const JsonNullValueFilterSchema = z.enum(['DbNull', 'JsonNull', 'AnyNull'])

export type JsonNullValueFilter = z.infer<typeof JsonNullValueFilterSchema>;

// File: NullsOrder.schema.ts

export const NullsOrderSchema = z.enum(['first', 'last'])

export type NullsOrder = z.infer<typeof NullsOrderSchema>;

// File: FunctionTag.schema.ts

export const FunctionTagSchema = z.enum(['PRODUCT_OWNER', 'PRODUCT_CONTRIBUTOR', 'DEVELOPER', 'ARCHITECT', 'SDET_QA', 'SME', 'STAKEHOLDER', 'DESIGNER'])

export type FunctionTag = z.infer<typeof FunctionTagSchema>;

// File: ChunkSplitMethod.schema.ts

export const ChunkSplitMethodSchema = z.enum(['PARAGRAPH', 'SENTENCE', 'FIXED', 'RECURSIVE', 'DOCUMENT', 'SEMANTIC'])

export type ChunkSplitMethod = z.infer<typeof ChunkSplitMethodSchema>;

// File: EmbeddingModel.schema.ts

export const EmbeddingModelSchema = z.enum(['TEXT_EMBEDDING_3_SMALL', 'TEXT_EMBEDDING_3_LARGE'])

export type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;

// File: PurchaseType.schema.ts

export const PurchaseTypeSchema = z.enum(['SUBSCRIPTION', 'ONE_TIME'])

export type PurchaseType = z.infer<typeof PurchaseTypeSchema>;

// File: AiOutcomeKind.schema.ts

export const AiOutcomeKindSchema = z.enum(['ACCEPTED_AS_IS', 'ACCEPTED_WITH_EDITS', 'REJECTED', 'RATED_UP', 'RATED_DOWN'])

export type AiOutcomeKind = z.infer<typeof AiOutcomeKindSchema>;

// File: AiChatToolSelectionMode.schema.ts

export const AiChatToolSelectionModeSchema = z.enum(['DEFAULT', 'ONLY_SELECTED', 'DISABLED'])

export type AiChatToolSelectionMode = z.infer<typeof AiChatToolSelectionModeSchema>;

// File: WorkflowStatus.schema.ts

export const WorkflowStatusSchema = z.enum(['NONE', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED'])

export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

// File: DocumentStatus.schema.ts

export const DocumentStatusSchema = z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED'])

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

// File: AgentFramework.schema.ts

export const AgentFrameworkSchema = z.enum(['LANGGRAPH', 'MICROSOFT', 'PYDANTIC_AI', 'CREWAI', 'AUTOGEN', 'OPENAI', 'CUSTOM', 'A2A', 'MCP', 'ORCHESTRATOR', 'COPILOTKIT', 'FABRIC_NATIVE'])

export type AgentFramework = z.infer<typeof AgentFrameworkSchema>;

// File: AgentStatus.schema.ts

export const AgentStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'DEPLOYING', 'ERROR', 'MAINTENANCE'])

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// File: AgentScope.schema.ts

export const AgentScopeSchema = z.enum(['SYSTEM', 'ORGANIZATION', 'USER'])

export type AgentScope = z.infer<typeof AgentScopeSchema>;

// File: AIProvider.schema.ts

export const AIProviderSchema = z.enum(['VERCEL_GATEWAY', 'CLOUDFLARE_AI', 'OPENROUTER', 'AZURE_AI_FOUNDRY', 'AWS_BEDROCK', 'GOOGLE_VERTEX_AI', 'DATABRICKS', 'OPENAI_DIRECT', 'ANTHROPIC_DIRECT', 'GROQ', 'TOGETHER_AI', 'DEEPSEEK', 'COHERE', 'MISTRAL_AI', 'FIREWORKS', 'PERPLEXITY', 'XAI', 'CEREBRAS', 'REPLICATE', 'HUGGINGFACE', 'HYBRID', 'CUSTOM', 'AZURE_OPENAI', 'NETLIFY'])

export type AIProvider = z.infer<typeof AIProviderSchema>;

// File: AutonomyLevel.schema.ts

export const AutonomyLevelSchema = z.enum(['CONSERVATIVE', 'BALANCED', 'AUTONOMOUS'])

export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

// File: RegisteredAgentSuggestionKind.schema.ts

export const RegisteredAgentSuggestionKindSchema = z.enum(['INSTRUCTIONS', 'TOOLS', 'SKILLS', 'MODEL', 'KNOWLEDGE', 'SUB_AGENT', 'RELIABILITY', 'DISCOVERY'])

export type RegisteredAgentSuggestionKind = z.infer<typeof RegisteredAgentSuggestionKindSchema>;

// File: RegisteredAgentSuggestionState.schema.ts

export const RegisteredAgentSuggestionStateSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'OUTDATED'])

export type RegisteredAgentSuggestionState = z.infer<typeof RegisteredAgentSuggestionStateSchema>;

// File: AgentConversationStatus.schema.ts

export const AgentConversationStatusSchema = z.enum(['ACTIVE', 'ARCHIVED'])

export type AgentConversationStatus = z.infer<typeof AgentConversationStatusSchema>;

// File: ProjectStatus.schema.ts

export const ProjectStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED', 'COMPLETED'])

export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

// File: ProjectPhase.schema.ts

export const ProjectPhaseSchema = z.enum(['DISCOVERY_PLANNING', 'DEVELOPMENT_EXECUTION'])

export type ProjectPhase = z.infer<typeof ProjectPhaseSchema>;

// File: CodingRunExecutionChannel.schema.ts

export const CodingRunExecutionChannelSchema = z.enum(['BACKGROUND_AGENTS', 'LOCAL_AGENTS'])

export type CodingRunExecutionChannel = z.infer<typeof CodingRunExecutionChannelSchema>;

// File: CodingRunProvider.schema.ts

export const CodingRunProviderSchema = z.enum(['BACKGROUND_AGENTS', 'KANBAN_LOCAL'])

export type CodingRunProvider = z.infer<typeof CodingRunProviderSchema>;

// File: CodeAnalysisStatus.schema.ts

export const CodeAnalysisStatusSchema = z.enum(['SCANNING', 'COMPLETED', 'FAILED'])

export type CodeAnalysisStatus = z.infer<typeof CodeAnalysisStatusSchema>;

// File: ClarifyingQuestionFrequency.schema.ts

export const ClarifyingQuestionFrequencySchema = z.enum(['MINIMAL', 'BALANCED', 'THOROUGH'])

export type ClarifyingQuestionFrequency = z.infer<typeof ClarifyingQuestionFrequencySchema>;

// File: QaStrategyLevel.schema.ts

export const QaStrategyLevelSchema = z.enum(['LIGHT', 'STANDARD', 'STRICT'])

export type QaStrategyLevel = z.infer<typeof QaStrategyLevelSchema>;

// File: ProjectDocumentType.schema.ts

export const ProjectDocumentTypeSchema = z.enum(['GENERAL', 'BUSINESS_CASE', 'PRD', 'PROPOSAL', 'ARCHITECTURE', 'TECHNICAL_SPEC', 'USER_STORY', 'API_SPEC', 'QA_STRATEGY', 'TEST_PLAN', 'TEST_REPORT', 'TRACEABILITY_MATRIX', 'SRS'])

export type ProjectDocumentType = z.infer<typeof ProjectDocumentTypeSchema>;

// File: ProjectDocumentStatus.schema.ts

export const ProjectDocumentStatusSchema = z.enum(['DRAFT', 'GENERATING', 'IN_PROGRESS', 'REVIEW', 'COMPLETE', 'FAILED'])

export type ProjectDocumentStatus = z.infer<typeof ProjectDocumentStatusSchema>;

// File: DocumentSource.schema.ts

export const DocumentSourceSchema = z.enum(['GENERATED', 'IMPORTED', 'EXTERNAL'])

export type DocumentSource = z.infer<typeof DocumentSourceSchema>;

// File: ProjectContextType.schema.ts

export const ProjectContextTypeSchema = z.enum(['FILE', 'LINK', 'TEXT', 'DOCUMENT', 'TECH_STACK', 'FEATURES', 'GOALS', 'DESCRIPTION', 'IMAGE', 'SPREADSHEET', 'INTEGRATION', 'MEETING_TRANSCRIPT', 'SLACK_HUDDLE_NOTES', 'CODE_FILE', 'CODE_FILE_SUMMARY', 'ARCHITECTURE_DECISION', 'TEST_CASE', 'API_SPEC'])

export type ProjectContextType = z.infer<typeof ProjectContextTypeSchema>;

// File: ExtractionStatus.schema.ts

export const ExtractionStatusSchema = z.enum(['PENDING', 'EXTRACTING', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

// File: KnowledgeBaseSourceCategory.schema.ts

export const KnowledgeBaseSourceCategorySchema = z.enum(['KNOWLEDGE_BASE_WIKI', 'PRODUCT_DOCUMENTATION', 'TECHNICAL_DEVELOPER_DOCUMENTATION', 'API_DOCUMENTATION', 'HELP_CENTER_SUPPORT_DOCS', 'MARKETING_WEBSITE', 'COMPLIANCE_SECURITY_DOCUMENTATION', 'OTHER'])

export type KnowledgeBaseSourceCategory = z.infer<typeof KnowledgeBaseSourceCategorySchema>;

// File: UrlSourceScope.schema.ts

export const UrlSourceScopeSchema = z.enum(['SINGLE_PAGE', 'PATH_PREFIX'])

export type UrlSourceScope = z.infer<typeof UrlSourceScopeSchema>;

// File: UrlRefreshMode.schema.ts

export const UrlRefreshModeSchema = z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'LIVE'])

export type UrlRefreshMode = z.infer<typeof UrlRefreshModeSchema>;

// File: ProjectReadinessItemStateValue.schema.ts

export const ProjectReadinessItemStateValueSchema = z.enum(['SNOOZED', 'NOT_APPLICABLE', 'HELP_REQUESTED'])

export type ProjectReadinessItemStateValue = z.infer<typeof ProjectReadinessItemStateValueSchema>;

// File: ContextSummaryStatus.schema.ts

export const ContextSummaryStatusSchema = z.enum(['PENDING', 'GENERATING', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type ContextSummaryStatus = z.infer<typeof ContextSummaryStatusSchema>;

// File: ContextSummaryTrigger.schema.ts

export const ContextSummaryTriggerSchema = z.enum(['AUTO', 'MANUAL'])

export type ContextSummaryTrigger = z.infer<typeof ContextSummaryTriggerSchema>;

// File: ScanEnforcementMode.schema.ts

export const ScanEnforcementModeSchema = z.enum(['WARN', 'BLOCK'])

export type ScanEnforcementMode = z.infer<typeof ScanEnforcementModeSchema>;

// File: FeatureDraftingStage.schema.ts

export const FeatureDraftingStageSchema = z.enum(['PLACEHOLDER', 'PASSIVE_ANALYSIS', 'ACTIVE_ANALYSIS', 'SANITY_CHECK', 'DRAFT', 'PUBLISHED', 'DECLINED', 'CLOSED'])

export type FeatureDraftingStage = z.infer<typeof FeatureDraftingStageSchema>;

// File: ScanStatus.schema.ts

export const ScanStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'])

export type ScanStatus = z.infer<typeof ScanStatusSchema>;

// File: ScanTrigger.schema.ts

export const ScanTriggerSchema = z.enum(['MANUAL', 'MATURATION_GATE'])

export type ScanTrigger = z.infer<typeof ScanTriggerSchema>;

// File: ScanTargetType.schema.ts

export const ScanTargetTypeSchema = z.enum(['PROJECT', 'FEATURE'])

export type ScanTargetType = z.infer<typeof ScanTargetTypeSchema>;

// File: ScanMode.schema.ts

export const ScanModeSchema = z.enum(['FULL', 'INCREMENTAL'])

export type ScanMode = z.infer<typeof ScanModeSchema>;

// File: ScanCategory.schema.ts

export const ScanCategorySchema = z.enum(['SECURITY', 'ACCESSIBILITY'])

export type ScanCategory = z.infer<typeof ScanCategorySchema>;

// File: ScanSeverity.schema.ts

export const ScanSeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])

export type ScanSeverity = z.infer<typeof ScanSeveritySchema>;

// File: ScanFindingStatus.schema.ts

export const ScanFindingStatusSchema = z.enum(['OPEN', 'RESOLVED', 'DISMISSED'])

export type ScanFindingStatus = z.infer<typeof ScanFindingStatusSchema>;

// File: ScanActivityType.schema.ts

export const ScanActivityTypeSchema = z.enum(['SCAN_STARTED', 'SCAN_COMPLETED', 'SCAN_FAILED', 'FINDING_RESOLVED', 'FINDING_DISMISSED', 'FINDING_REOPENED', 'FINDING_CONVERTED', 'FINDING_EDITED', 'CONFIG_UPDATED', 'FINDINGS_PURGED', 'FINDINGS_REVIEWED', 'REVIEW_STARTED', 'REVIEW_CANCELLED', 'FINDINGS_GROUPED'])

export type ScanActivityType = z.infer<typeof ScanActivityTypeSchema>;

// File: GroupingRunStatus.schema.ts

export const GroupingRunStatusSchema = z.enum(['PENDING', 'RUNNING', 'AWAITING_REVIEW', 'APPLYING', 'COMPLETED', 'FAILED'])

export type GroupingRunStatus = z.infer<typeof GroupingRunStatusSchema>;

// File: CodeIndexStatus.schema.ts

export const CodeIndexStatusSchema = z.enum(['PENDING', 'INDEXING', 'READY', 'STALE', 'FAILED'])

export type CodeIndexStatus = z.infer<typeof CodeIndexStatusSchema>;

// File: AtlasStatus.schema.ts

export const AtlasStatusSchema = z.enum(['NOT_ANALYZED', 'PENDING', 'ANALYZING', 'READY', 'FAILED'])

export type AtlasStatus = z.infer<typeof AtlasStatusSchema>;

// File: AtlasGraphMode.schema.ts

export const AtlasGraphModeSchema = z.enum(['TECHNICAL', 'BUSINESS'])

export type AtlasGraphMode = z.infer<typeof AtlasGraphModeSchema>;

// File: AtlasNodeKind.schema.ts

export const AtlasNodeKindSchema = z.enum(['DIRECTORY', 'MODULE', 'FILE', 'CAPABILITY', 'DOMAIN'])

export type AtlasNodeKind = z.infer<typeof AtlasNodeKindSchema>;

// File: AtlasEdgeKind.schema.ts

export const AtlasEdgeKindSchema = z.enum(['CONTAINS', 'IMPORTS', 'DEPENDS_ON', 'COVERS', 'RELATES_TO'])

export type AtlasEdgeKind = z.infer<typeof AtlasEdgeKindSchema>;

// File: AtlasRunStatus.schema.ts

export const AtlasRunStatusSchema = z.enum(['RUNNING', 'READY', 'FAILED'])

export type AtlasRunStatus = z.infer<typeof AtlasRunStatusSchema>;

// File: AtlasChatVisibility.schema.ts

export const AtlasChatVisibilitySchema = z.enum(['PRIVATE', 'SHARED'])

export type AtlasChatVisibility = z.infer<typeof AtlasChatVisibilitySchema>;

// File: AtlasCrossEdgeKind.schema.ts

export const AtlasCrossEdgeKindSchema = z.enum(['SHARES_LIBRARY', 'DEPENDS_ON', 'CALLS_API', 'RELATES_TO'])

export type AtlasCrossEdgeKind = z.infer<typeof AtlasCrossEdgeKindSchema>;

// File: AtlasCrossEdgeDetection.schema.ts

export const AtlasCrossEdgeDetectionSchema = z.enum(['STRUCTURAL', 'AI'])

export type AtlasCrossEdgeDetection = z.infer<typeof AtlasCrossEdgeDetectionSchema>;

// File: AtlasCrossLinkStatus.schema.ts

export const AtlasCrossLinkStatusSchema = z.enum(['PENDING', 'RUNNING', 'READY', 'FAILED'])

export type AtlasCrossLinkStatus = z.infer<typeof AtlasCrossLinkStatusSchema>;

// File: MeetingTranscriptAnalysisStatus.schema.ts

export const MeetingTranscriptAnalysisStatusSchema = z.enum(['NOT_SCANNED', 'IN_PROGRESS', 'SCANNED', 'FAILED'])

export type MeetingTranscriptAnalysisStatus = z.infer<typeof MeetingTranscriptAnalysisStatusSchema>;

// File: MeetingActionItemLinkOrigin.schema.ts

export const MeetingActionItemLinkOriginSchema = z.enum(['AUTO', 'MANUAL', 'CREATED'])

export type MeetingActionItemLinkOrigin = z.infer<typeof MeetingActionItemLinkOriginSchema>;

// File: MeetingActionItemLinkStatus.schema.ts

export const MeetingActionItemLinkStatusSchema = z.enum(['ACTIVE', 'DISMISSED'])

export type MeetingActionItemLinkStatus = z.infer<typeof MeetingActionItemLinkStatusSchema>;

// File: MeetingAgendaStatus.schema.ts

export const MeetingAgendaStatusSchema = z.enum(['GENERATING', 'READY', 'FAILED'])

export type MeetingAgendaStatus = z.infer<typeof MeetingAgendaStatusSchema>;

// File: PendingBacklogProposalSource.schema.ts

export const PendingBacklogProposalSourceSchema = z.enum(['TEAMS_CHANNEL', 'TEAMS_CHAT', 'SLACK_CHANNEL', 'AI_UPDATE_SIDEBAR', 'MONITORED_MEETING'])

export type PendingBacklogProposalSource = z.infer<typeof PendingBacklogProposalSourceSchema>;

// File: PendingBacklogProposalStatus.schema.ts

export const PendingBacklogProposalStatusSchema = z.enum(['PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'FAILED', 'SUPERSEDED', 'BACKLOG'])

export type PendingBacklogProposalStatus = z.infer<typeof PendingBacklogProposalStatusSchema>;

// File: StoryKind.schema.ts

export const StoryKindSchema = z.enum(['FEATURE', 'BUG'])

export type StoryKind = z.infer<typeof StoryKindSchema>;

// File: BacklogProposalDraftStatus.schema.ts

export const BacklogProposalDraftStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type BacklogProposalDraftStatus = z.infer<typeof BacklogProposalDraftStatusSchema>;

// File: BacklogUpdateSessionStatus.schema.ts

export const BacklogUpdateSessionStatusSchema = z.enum(['APPLYING', 'APPLIED', 'PARTIALLY_APPLIED', 'FAILED'])

export type BacklogUpdateSessionStatus = z.infer<typeof BacklogUpdateSessionStatusSchema>;

// File: PmSyncLogStatus.schema.ts

export const PmSyncLogStatusSchema = z.enum(['SUCCESS', 'FAILURE', 'CONFLICT'])

export type PmSyncLogStatus = z.infer<typeof PmSyncLogStatusSchema>;

// File: ProjectMemberRole.schema.ts

export const ProjectMemberRoleSchema = z.enum(['OWNER', 'PROJECT_ADMIN', 'EDITOR', 'COMMENTER', 'VIEWER'])

export type ProjectMemberRole = z.infer<typeof ProjectMemberRoleSchema>;

// File: ProjectInvitationStatus.schema.ts

export const ProjectInvitationStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED'])

export type ProjectInvitationStatus = z.infer<typeof ProjectInvitationStatusSchema>;

// File: StoryPriority.schema.ts

export const StoryPrioritySchema = z.enum(['P0_CRITICAL', 'P1_HIGH', 'P2_MEDIUM', 'P3_LOW'])

export type StoryPriority = z.infer<typeof StoryPrioritySchema>;

// File: StorySize.schema.ts

export const StorySizeSchema = z.enum(['XS', 'S', 'M', 'L', 'XL'])

export type StorySize = z.infer<typeof StorySizeSchema>;

// File: StorySource.schema.ts

export const StorySourceSchema = z.enum(['MANUAL', 'JIRA', 'AZURE_DEVOPS', 'FIZZY', 'GITLAB', 'LINEAR', 'GITHUB', 'AI_UPDATE', 'APPROVED_PROPOSAL', 'CUSTOM_AGENT', 'SLACK', 'SECURITY_SCAN', 'PIPELINE_FAILURE'])

export type StorySource = z.infer<typeof StorySourceSchema>;

// File: StoryTitleSource.schema.ts

export const StoryTitleSourceSchema = z.enum(['AI', 'DESCRIPTION_FALLBACK', 'UNTITLED_FALLBACK'])

export type StoryTitleSource = z.infer<typeof StoryTitleSourceSchema>;

// File: MaturationStatus.schema.ts

export const MaturationStatusSchema = z.enum(['TO_DO', 'DISCOVERY', 'DONE'])

export type MaturationStatus = z.infer<typeof MaturationStatusSchema>;

// File: ReporterSource.schema.ts

export const ReporterSourceSchema = z.enum(['SLACK', 'TEAMS', 'MANUAL'])

export type ReporterSource = z.infer<typeof ReporterSourceSchema>;

// File: PmSyncStatus.schema.ts

export const PmSyncStatusSchema = z.enum(['PENDING', 'SUCCESS', 'CONFLICT', 'FAILED'])

export type PmSyncStatus = z.infer<typeof PmSyncStatusSchema>;

// File: LastEditSource.schema.ts

export const LastEditSourceSchema = z.enum(['MANUAL', 'AI_BACKLOG_UPDATE', 'AI_MATURATION', 'CONFLICT_RESOLUTION', 'PM_PULL'])

export type LastEditSource = z.infer<typeof LastEditSourceSchema>;

// File: MaturationApprovalMode.schema.ts

export const MaturationApprovalModeSchema = z.enum(['AUTO_ACCEPT', 'MANUAL'])

export type MaturationApprovalMode = z.infer<typeof MaturationApprovalModeSchema>;

// File: PriorityChangeSource.schema.ts

export const PriorityChangeSourceSchema = z.enum(['AI', 'MANUAL'])

export type PriorityChangeSource = z.infer<typeof PriorityChangeSourceSchema>;

// File: StoryAttachmentDesignation.schema.ts

export const StoryAttachmentDesignationSchema = z.enum(['LOCKED', 'UNLOCKED'])

export type StoryAttachmentDesignation = z.infer<typeof StoryAttachmentDesignationSchema>;

// File: StoryAttachmentSource.schema.ts

export const StoryAttachmentSourceSchema = z.enum(['FABRIC', 'PM_SYNCED'])

export type StoryAttachmentSource = z.infer<typeof StoryAttachmentSourceSchema>;

// File: DuplicateLinkStatus.schema.ts

export const DuplicateLinkStatusSchema = z.enum(['PENDING', 'DISMISSED', 'RESOLVED', 'NOT_DUPLICATE'])

export type DuplicateLinkStatus = z.infer<typeof DuplicateLinkStatusSchema>;

// File: DuplicateLinkType.schema.ts

export const DuplicateLinkTypeSchema = z.enum(['DUPLICATE', 'OVERLAP'])

export type DuplicateLinkType = z.infer<typeof DuplicateLinkTypeSchema>;

// File: ProjectCommentAuthorType.schema.ts

export const ProjectCommentAuthorTypeSchema = z.enum(['USER', 'AGENT'])

export type ProjectCommentAuthorType = z.infer<typeof ProjectCommentAuthorTypeSchema>;

// File: DecisionAuthorType.schema.ts

export const DecisionAuthorTypeSchema = z.enum(['USER', 'AGENT'])

export type DecisionAuthorType = z.infer<typeof DecisionAuthorTypeSchema>;

// File: DecisionStatus.schema.ts

export const DecisionStatusSchema = z.enum(['OPEN', 'RESOLVED', 'REJECTED', 'FORMATTING_ONLY', 'POSSIBLY_RESOLVED'])

export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

// File: DecisionSource.schema.ts

export const DecisionSourceSchema = z.enum(['HUMAN', 'AI_CONFIRMED'])

export type DecisionSource = z.infer<typeof DecisionSourceSchema>;

// File: AnswerSource.schema.ts

export const AnswerSourceSchema = z.enum(['AI_SUGGESTED', 'AI_EDITED', 'MANUAL'])

export type AnswerSource = z.infer<typeof AnswerSourceSchema>;

// File: ArchitectureDecisionStatus.schema.ts

export const ArchitectureDecisionStatusSchema = z.enum(['PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'DEPRECATED', 'REJECTED'])

export type ArchitectureDecisionStatus = z.infer<typeof ArchitectureDecisionStatusSchema>;

// File: DecisionDuration.schema.ts

export const DecisionDurationSchema = z.enum(['LONG_STANDING', 'SHORT_TERM'])

export type DecisionDuration = z.infer<typeof DecisionDurationSchema>;

// File: DecisionTypeOrigin.schema.ts

export const DecisionTypeOriginSchema = z.enum(['AI', 'HUMAN'])

export type DecisionTypeOrigin = z.infer<typeof DecisionTypeOriginSchema>;

// File: PublishingCycleStatus.schema.ts

export const PublishingCycleStatusSchema = z.enum(['GENERATING', 'READY', 'NO_TOPICS', 'INSUFFICIENT_CONTEXT', 'FAILED'])

export type PublishingCycleStatus = z.infer<typeof PublishingCycleStatusSchema>;

// File: PublishingTopicStatus.schema.ts

export const PublishingTopicStatusSchema = z.enum(['SUGGESTION', 'SELECTED', 'IN_PROGRESS', 'PUBLISHED', 'DECLINED'])

export type PublishingTopicStatus = z.infer<typeof PublishingTopicStatusSchema>;

// File: PublishingTopicOrigin.schema.ts

export const PublishingTopicOriginSchema = z.enum(['AI', 'MANUAL'])

export type PublishingTopicOrigin = z.infer<typeof PublishingTopicOriginSchema>;

// File: PublishingTopicPostType.schema.ts

export const PublishingTopicPostTypeSchema = z.enum(['TWEET', 'BLOG_POST', 'CASE_STUDY', 'STAKEHOLDER_EMAIL'])

export type PublishingTopicPostType = z.infer<typeof PublishingTopicPostTypeSchema>;

// File: TestCaseState.schema.ts

export const TestCaseStateSchema = z.enum(['PROPOSED', 'DRAFT', 'READY', 'CLOSED'])

export type TestCaseState = z.infer<typeof TestCaseStateSchema>;

// File: TestCasePriority.schema.ts

export const TestCasePrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])

export type TestCasePriority = z.infer<typeof TestCasePrioritySchema>;

// File: AutomationStatus.schema.ts

export const AutomationStatusSchema = z.enum(['NOT_AUTOMATED', 'PLANNED', 'AUTOMATED'])

export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

// File: QaCoverageType.schema.ts

export const QaCoverageTypeSchema = z.enum(['UNIT', 'INTEGRATION', 'E2E', 'MANUAL'])

export type QaCoverageType = z.infer<typeof QaCoverageTypeSchema>;

// File: TestCaseProposalSource.schema.ts

export const TestCaseProposalSourceSchema = z.enum(['SPEC', 'IMPLEMENTATION'])

export type TestCaseProposalSource = z.infer<typeof TestCaseProposalSourceSchema>;

// File: TestResult.schema.ts

export const TestResultSchema = z.enum(['NOT_RUN', 'PASSED', 'FAILED', 'BLOCKED', 'SKIPPED'])

export type TestResult = z.infer<typeof TestResultSchema>;

// File: ResultSource.schema.ts

export const ResultSourceSchema = z.enum(['MANUAL', 'PM_SYNC', 'PIPELINE'])

export type ResultSource = z.infer<typeof ResultSourceSchema>;

// File: TestPlanState.schema.ts

export const TestPlanStateSchema = z.enum(['ACTIVE', 'INACTIVE'])

export type TestPlanState = z.infer<typeof TestPlanStateSchema>;

// File: TestFindingStatus.schema.ts

export const TestFindingStatusSchema = z.enum(['OPEN', 'RESOLVED', 'PROMOTED', 'IGNORED'])

export type TestFindingStatus = z.infer<typeof TestFindingStatusSchema>;

// File: TestFailureKind.schema.ts

export const TestFailureKindSchema = z.enum(['PRODUCT_BUG', 'TEST_DEFECT', 'ENVIRONMENT', 'FLAKY', 'UNKNOWN'])

export type TestFailureKind = z.infer<typeof TestFailureKindSchema>;

// File: AgenticRunStatus.schema.ts

export const AgenticRunStatusSchema = z.enum(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'REFUSED', 'NEEDS_REVIEW'])

export type AgenticRunStatus = z.infer<typeof AgenticRunStatusSchema>;

// File: QaRunMode.schema.ts

export const QaRunModeSchema = z.enum(['MODE_A', 'MODE_B'])

export type QaRunMode = z.infer<typeof QaRunModeSchema>;

// File: ProjectEnvironmentType.schema.ts

export const ProjectEnvironmentTypeSchema = z.enum(['STAGING', 'QA', 'PRODUCTION'])

export type ProjectEnvironmentType = z.infer<typeof ProjectEnvironmentTypeSchema>;

// File: AgenticStepStatus.schema.ts

export const AgenticStepStatusSchema = z.enum(['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'NEEDS_REVIEW'])

export type AgenticStepStatus = z.infer<typeof AgenticStepStatusSchema>;

// File: TestCaseScriptRevisionOrigin.schema.ts

export const TestCaseScriptRevisionOriginSchema = z.enum(['MANUAL', 'AGENT_RUN_AND_REPO', 'REPO_ONLY', 'REVERT'])

export type TestCaseScriptRevisionOrigin = z.infer<typeof TestCaseScriptRevisionOriginSchema>;

// File: QaStrategyDepth.schema.ts

export const QaStrategyDepthSchema = z.enum(['EASY', 'AVERAGE', 'HARD'])

export type QaStrategyDepth = z.infer<typeof QaStrategyDepthSchema>;

// File: QaEvidencePolicy.schema.ts

export const QaEvidencePolicySchema = z.enum(['SCREENSHOT_REQUIRED', 'OPTIONAL', 'NONE'])

export type QaEvidencePolicy = z.infer<typeof QaEvidencePolicySchema>;

// File: QaOpenQuestionStatus.schema.ts

export const QaOpenQuestionStatusSchema = z.enum(['OPEN', 'ANSWERED', 'DEFERRED'])

export type QaOpenQuestionStatus = z.infer<typeof QaOpenQuestionStatusSchema>;

// File: EnvironmentAuthKind.schema.ts

export const EnvironmentAuthKindSchema = z.enum(['NONE', 'FORM', 'TOKEN', 'HEADER'])

export type EnvironmentAuthKind = z.infer<typeof EnvironmentAuthKindSchema>;

// File: TestCaseActivityType.schema.ts

export const TestCaseActivityTypeSchema = z.enum(['CREATED', 'STATE_CHANGED', 'PRIORITY_CHANGED', 'RENAMED', 'STEPS_CHANGED', 'AUTOMATION_CHANGED', 'PM_LINK_CHANGED'])

export type TestCaseActivityType = z.infer<typeof TestCaseActivityTypeSchema>;

// File: TestCaseDraftJobStatus.schema.ts

export const TestCaseDraftJobStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'])

export type TestCaseDraftJobStatus = z.infer<typeof TestCaseDraftJobStatusSchema>;

// File: MCPTransport.schema.ts

export const MCPTransportSchema = z.enum(['SSE', 'HTTP', 'STDIO'])

export type MCPTransport = z.infer<typeof MCPTransportSchema>;

// File: MCPApiKeyMethod.schema.ts

export const MCPApiKeyMethodSchema = z.enum(['BEARER', 'HEADER', 'PLAIN'])

export type MCPApiKeyMethod = z.infer<typeof MCPApiKeyMethodSchema>;

// File: MCPAuthType.schema.ts

export const MCPAuthTypeSchema = z.enum(['NONE', 'API_KEY', 'OAUTH2'])

export type MCPAuthType = z.infer<typeof MCPAuthTypeSchema>;

// File: MCPStatus.schema.ts

export const MCPStatusSchema = z.enum(['HEALTHY', 'DEGRADED', 'UNAVAILABLE'])

export type MCPStatus = z.infer<typeof MCPStatusSchema>;

// File: StakeLevel.schema.ts

export const StakeLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH'])

export type StakeLevel = z.infer<typeof StakeLevelSchema>;

// File: AuthorityRunType.schema.ts

export const AuthorityRunTypeSchema = z.enum(['ORCHESTRATOR', 'WORKFLOW', 'MCP_GATEWAY', 'AGENT_INSTANCE'])

export type AuthorityRunType = z.infer<typeof AuthorityRunTypeSchema>;

// File: AuthoritySessionStatus.schema.ts

export const AuthoritySessionStatusSchema = z.enum(['PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'COMPLETED'])

export type AuthoritySessionStatus = z.infer<typeof AuthoritySessionStatusSchema>;

// File: AuthorityGrantKind.schema.ts

export const AuthorityGrantKindSchema = z.enum(['BROAD', 'REQUEST'])

export type AuthorityGrantKind = z.infer<typeof AuthorityGrantKindSchema>;

// File: AuthorityProviderType.schema.ts

export const AuthorityProviderTypeSchema = z.enum(['MCP', 'INTEGRATION', 'FABRIC_NATIVE'])

export type AuthorityProviderType = z.infer<typeof AuthorityProviderTypeSchema>;

// File: AuthorityAccessLevel.schema.ts

export const AuthorityAccessLevelSchema = z.enum(['READ', 'WRITE'])

export type AuthorityAccessLevel = z.infer<typeof AuthorityAccessLevelSchema>;

// File: AuthorityGrantStatus.schema.ts

export const AuthorityGrantStatusSchema = z.enum(['PENDING', 'APPROVED', 'DENIED', 'CONSUMED', 'EXPIRED', 'REVOKED'])

export type AuthorityGrantStatus = z.infer<typeof AuthorityGrantStatusSchema>;

// File: PromptScope.schema.ts

export const PromptScopeSchema = z.enum(['SYSTEM', 'ORG', 'USER'])

export type PromptScope = z.infer<typeof PromptScopeSchema>;

// File: PromptFormat.schema.ts

export const PromptFormatSchema = z.enum(['PLAIN_TEXT', 'MARKDOWN', 'HANDLEBARS', 'MUSTACHE', 'LIQUID', 'JINJA2'])

export type PromptFormat = z.infer<typeof PromptFormatSchema>;

// File: PromptContentType.schema.ts

export const PromptContentTypeSchema = z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'STRUCTURED', 'SKILL'])

export type PromptContentType = z.infer<typeof PromptContentTypeSchema>;

// File: StructuredFormat.schema.ts

export const StructuredFormatSchema = z.enum(['JSON', 'YAML'])

export type StructuredFormat = z.infer<typeof StructuredFormatSchema>;

// File: PromptTargetType.schema.ts

export const PromptTargetTypeSchema = z.enum(['AGENT', 'FEATURE', 'WORKFLOW', 'DOCUMENT'])

export type PromptTargetType = z.infer<typeof PromptTargetTypeSchema>;

// File: PromptChangeRequestStatus.schema.ts

export const PromptChangeRequestStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED'])

export type PromptChangeRequestStatus = z.infer<typeof PromptChangeRequestStatusSchema>;

// File: PromptNominationStatus.schema.ts

export const PromptNominationStatusSchema = z.enum(['PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN', 'SUPERSEDED'])

export type PromptNominationStatus = z.infer<typeof PromptNominationStatusSchema>;

// File: DeploymentStatus.schema.ts

export const DeploymentStatusSchema = z.enum(['PROVISIONING', 'ACTIVE', 'UPDATING', 'DELETING', 'FAILED', 'SUSPENDED'])

export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

// File: HealthStatus.schema.ts

export const HealthStatusSchema = z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN'])

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

// File: WorkflowBuilderStatus.schema.ts

export const WorkflowBuilderStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ACTIVE', 'PAUSED', 'ARCHIVED'])

export type WorkflowBuilderStatus = z.infer<typeof WorkflowBuilderStatusSchema>;

// File: WorkflowTriggerType.schema.ts

export const WorkflowTriggerTypeSchema = z.enum(['MANUAL', 'WEBHOOK', 'SCHEDULE', 'EVENT'])

export type WorkflowTriggerType = z.infer<typeof WorkflowTriggerTypeSchema>;

// File: WorkflowExecutionStatus.schema.ts

export const WorkflowExecutionStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])

export type WorkflowExecutionStatus = z.infer<typeof WorkflowExecutionStatusSchema>;

// File: WorkflowNodeStatus.schema.ts

export const WorkflowNodeStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED'])

export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatusSchema>;

// File: WorkflowIntegrationProvider.schema.ts

export const WorkflowIntegrationProviderSchema = z.enum(['AI_GATEWAY', 'ASANA', 'ATTIO', 'BITBUCKET', 'BLOB', 'CANVA', 'CLERK', 'CLICKUP', 'CONFLUENCE', 'CUSTOM_WEBHOOK', 'DATABASE', 'DATABRICKS_VECTOR_SEARCH', 'FAL', 'FIRECRAWL', 'FRESHSERVICE', 'FRONT', 'GITHUB', 'GITLAB', 'GMAIL', 'GOOGLE_DRIVE', 'HUBSPOT', 'INTERCOM', 'JIRA', 'LINEAR', 'MCP', 'MICROSOFT_GRAPH', 'NHTSA_VPIC', 'NOTION', 'PERPLEXITY', 'RESEND', 'SALESFORCE', 'SLACK', 'STRIPE', 'SUPERAGENT', 'TELEGRAM', 'WEBFLOW', 'ZENDESK'])

export type WorkflowIntegrationProvider = z.infer<typeof WorkflowIntegrationProviderSchema>;

// File: BrowserTaskStatus.schema.ts

export const BrowserTaskStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type BrowserTaskStatus = z.infer<typeof BrowserTaskStatusSchema>;

// File: OpenAPIAuthType.schema.ts

export const OpenAPIAuthTypeSchema = z.enum(['NONE', 'API_KEY', 'BEARER', 'BASIC', 'OAUTH2'])

export type OpenAPIAuthType = z.infer<typeof OpenAPIAuthTypeSchema>;

// File: OpenAPIAuthLocation.schema.ts

export const OpenAPIAuthLocationSchema = z.enum(['HEADER', 'QUERY', 'COOKIE'])

export type OpenAPIAuthLocation = z.infer<typeof OpenAPIAuthLocationSchema>;

// File: OpenAPIServiceStatus.schema.ts

export const OpenAPIServiceStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'ERROR', 'SYNCING'])

export type OpenAPIServiceStatus = z.infer<typeof OpenAPIServiceStatusSchema>;

// File: AgentFileType.schema.ts

export const AgentFileTypeSchema = z.enum(['DOCUMENT', 'CODE', 'DATA', 'CONFIG', 'OUTPUT', 'ARTIFACT', 'FRAME', 'SLIDESHOW'])

export type AgentFileType = z.infer<typeof AgentFileTypeSchema>;

// File: AgentFileStatus.schema.ts

export const AgentFileStatusSchema = z.enum(['DRAFT', 'COMPLETE', 'ARCHIVED'])

export type AgentFileStatus = z.infer<typeof AgentFileStatusSchema>;

// File: FrameShareScope.schema.ts

export const FrameShareScopeSchema = z.enum(['PRIVATE', 'EMAILS_ONLY', 'WORKSPACE_AND_EMAILS', 'PUBLIC'])

export type FrameShareScope = z.infer<typeof FrameShareScopeSchema>;

// File: WorkspaceType.schema.ts

export const WorkspaceTypeSchema = z.enum(['PERSONAL', 'CUSTOM'])

export type WorkspaceType = z.infer<typeof WorkspaceTypeSchema>;

// File: WorkspaceStatus.schema.ts

export const WorkspaceStatusSchema = z.enum(['ACTIVE', 'ARCHIVED'])

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

// File: WorkspaceDocumentStatus.schema.ts

export const WorkspaceDocumentStatusSchema = z.enum(['PENDING', 'UPLOADING', 'UPLOADED', 'EXTRACTING', 'CHUNKING', 'EMBEDDING', 'STORING', 'READY', 'FAILED'])

export type WorkspaceDocumentStatus = z.infer<typeof WorkspaceDocumentStatusSchema>;

// File: WorkspaceAccessLevel.schema.ts

export const WorkspaceAccessLevelSchema = z.enum(['READ', 'WRITE'])

export type WorkspaceAccessLevel = z.infer<typeof WorkspaceAccessLevelSchema>;

// File: DocumentRefKind.schema.ts

export const DocumentRefKindSchema = z.enum(['PROJECT_DOCUMENT', 'USER_STORY'])

export type DocumentRefKind = z.infer<typeof DocumentRefKindSchema>;

// File: DocumentAssistantVisibility.schema.ts

export const DocumentAssistantVisibilitySchema = z.enum(['SHARED', 'PRIVATE'])

export type DocumentAssistantVisibility = z.infer<typeof DocumentAssistantVisibilitySchema>;

// File: SpeedTier.schema.ts

export const SpeedTierSchema = z.enum(['FAST', 'BALANCED', 'QUALITY'])

export type SpeedTier = z.infer<typeof SpeedTierSchema>;

// File: QualityTier.schema.ts

export const QualityTierSchema = z.enum(['BASIC', 'STANDARD', 'PREMIUM'])

export type QualityTier = z.infer<typeof QualityTierSchema>;

// File: AiModelCapability.schema.ts

export const AiModelCapabilitySchema = z.enum(['TEXT', 'IMAGE', 'AUDIO', 'EMBEDDING', 'TOOL_CALLING', 'VISION', 'CODE', 'REASONING'])

export type AiModelCapability = z.infer<typeof AiModelCapabilitySchema>;

// File: AiTaskType.schema.ts

export const AiTaskTypeSchema = z.enum(['SIMPLE', 'COMPLEX', 'REASONING', 'CHAT', 'TOOL_CALLING', 'EMBEDDING', 'IMAGE', 'AUDIO', 'EVAL'])

export type AiTaskType = z.infer<typeof AiTaskTypeSchema>;

// File: TaskComplexity.schema.ts

export const TaskComplexitySchema = z.enum(['SIMPLE', 'MEDIUM', 'COMPLEX'])

export type TaskComplexity = z.infer<typeof TaskComplexitySchema>;

// File: AiUsageBillingCategory.schema.ts

export const AiUsageBillingCategorySchema = z.enum(['INCLUDED_CREDIT', 'STRIPE_METERED', 'EXTERNAL_BYOK', 'PLATFORM_UNBILLED'])

export type AiUsageBillingCategory = z.infer<typeof AiUsageBillingCategorySchema>;

// File: AiUsageLimitDimension.schema.ts

export const AiUsageLimitDimensionSchema = z.enum(['TOKENS', 'SPEND_USD'])

export type AiUsageLimitDimension = z.infer<typeof AiUsageLimitDimensionSchema>;

// File: AiUsageLimitWindow.schema.ts

export const AiUsageLimitWindowSchema = z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'])

export type AiUsageLimitWindow = z.infer<typeof AiUsageLimitWindowSchema>;

// File: AiUsageLimitEnforcement.schema.ts

export const AiUsageLimitEnforcementSchema = z.enum(['HARD', 'SOFT'])

export type AiUsageLimitEnforcement = z.infer<typeof AiUsageLimitEnforcementSchema>;

// File: ReportTemplateType.schema.ts

export const ReportTemplateTypeSchema = z.enum(['GANTT_CHART', 'BURNDOWN', 'SPRINT_COMPLETION', 'FEATURE_SUMMARY', 'MONTHLY_REPORT', 'QUARTERLY_REPORT', 'INTEGRATION_ACTIVITY', 'CUSTOM'])

export type ReportTemplateType = z.infer<typeof ReportTemplateTypeSchema>;

// File: ReportOutputFormat.schema.ts

export const ReportOutputFormatSchema = z.enum(['MARKDOWN', 'HTML', 'PDF', 'EVIDENCE_EMBED', 'MULTI_FORMAT'])

export type ReportOutputFormat = z.infer<typeof ReportOutputFormatSchema>;

// File: ReportTemplateScope.schema.ts

export const ReportTemplateScopeSchema = z.enum(['SYSTEM', 'ORGANIZATION', 'USER'])

export type ReportTemplateScope = z.infer<typeof ReportTemplateScopeSchema>;

// File: TemplateInstanceStatus.schema.ts

export const TemplateInstanceStatusSchema = z.enum(['PENDING', 'ACTIVE', 'ARCHIVED', 'DRAFT'])

export type TemplateInstanceStatus = z.infer<typeof TemplateInstanceStatusSchema>;

// File: ScheduleMode.schema.ts

export const ScheduleModeSchema = z.enum(['INHERITED', 'CUSTOM', 'OFF'])

export type ScheduleMode = z.infer<typeof ScheduleModeSchema>;

// File: TemplateExecutionStatus.schema.ts

export const TemplateExecutionStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type TemplateExecutionStatus = z.infer<typeof TemplateExecutionStatusSchema>;

// File: ReportArtifactType.schema.ts

export const ReportArtifactTypeSchema = z.enum(['MARKDOWN', 'PDF', 'HTML', 'EVIDENCE_EMBED', 'CHART_DATA', 'CSV', 'JSON'])

export type ReportArtifactType = z.infer<typeof ReportArtifactTypeSchema>;

// File: ReportExecutionStatus.schema.ts

export const ReportExecutionStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type ReportExecutionStatus = z.infer<typeof ReportExecutionStatusSchema>;

// File: ReportEmailDeliveryStatus.schema.ts

export const ReportEmailDeliveryStatusSchema = z.enum(['SENT', 'FAILED'])

export type ReportEmailDeliveryStatus = z.infer<typeof ReportEmailDeliveryStatusSchema>;

// File: AgentTemplateCategory.schema.ts

export const AgentTemplateCategorySchema = z.enum(['DATA', 'DESIGN', 'ENGINEERING', 'FINANCE', 'HIRING', 'KNOWLEDGE', 'LEGAL', 'MARKETING', 'OPERATIONS', 'PRODUCT', 'PRODUCT_MANAGEMENT', 'PRODUCTIVITY', 'SALES', 'SUPPORT', 'GENERAL'])

export type AgentTemplateCategory = z.infer<typeof AgentTemplateCategorySchema>;

// File: AgentTemplateScope.schema.ts

export const AgentTemplateScopeSchema = z.enum(['SYSTEM', 'ORGANIZATION', 'USER'])

export type AgentTemplateScope = z.infer<typeof AgentTemplateScopeSchema>;

// File: AgentInstanceStatus.schema.ts

export const AgentInstanceStatusSchema = z.enum(['DRAFT', 'PENDING', 'ACTIVE', 'ARCHIVED'])

export type AgentInstanceStatus = z.infer<typeof AgentInstanceStatusSchema>;

// File: AgentExecutionStatus.schema.ts

export const AgentExecutionStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type AgentExecutionStatus = z.infer<typeof AgentExecutionStatusSchema>;

// File: AgentDeploymentStatus.schema.ts

export const AgentDeploymentStatusSchema = z.enum(['PENDING', 'DEPLOYING', 'ACTIVE', 'PAUSED', 'DEGRADED', 'FAILED', 'TERMINATED'])

export type AgentDeploymentStatus = z.infer<typeof AgentDeploymentStatusSchema>;

// File: AgentDeploymentHealthStatus.schema.ts

export const AgentDeploymentHealthStatusSchema = z.enum(['UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY'])

export type AgentDeploymentHealthStatus = z.infer<typeof AgentDeploymentHealthStatusSchema>;

// File: DeploymentExecutionStatus.schema.ts

export const DeploymentExecutionStatusSchema = z.enum(['PENDING', 'RUNNING', 'WAITING_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])

export type DeploymentExecutionStatus = z.infer<typeof DeploymentExecutionStatusSchema>;

// File: DeploymentTriggerType.schema.ts

export const DeploymentTriggerTypeSchema = z.enum(['MANUAL', 'WEBHOOK', 'SLACK', 'SCHEDULE', 'EMAIL', 'API', 'LIFECYCLE_EVENT', 'CHANNEL_MESSAGE'])

export type DeploymentTriggerType = z.infer<typeof DeploymentTriggerTypeSchema>;

// File: AgentMemoryFileType.schema.ts

export const AgentMemoryFileTypeSchema = z.enum(['AGENTS_MD', 'MCP_JSON', 'SKILL', 'KNOWLEDGE', 'CONVERSATION', 'CUSTOM'])

export type AgentMemoryFileType = z.infer<typeof AgentMemoryFileTypeSchema>;

// File: AgentMemoryEditOperation.schema.ts

export const AgentMemoryEditOperationSchema = z.enum(['CREATE', 'UPDATE', 'DELETE'])

export type AgentMemoryEditOperation = z.infer<typeof AgentMemoryEditOperationSchema>;

// File: AgentMemoryEditStatus.schema.ts

export const AgentMemoryEditStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED'])

export type AgentMemoryEditStatus = z.infer<typeof AgentMemoryEditStatusSchema>;

// File: GoldenReferenceScope.schema.ts

export const GoldenReferenceScopeSchema = z.enum(['SYSTEM', 'USER', 'ORG'])

export type GoldenReferenceScope = z.infer<typeof GoldenReferenceScopeSchema>;

// File: DynamicAgentStatus.schema.ts

export const DynamicAgentStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED', 'DEPRECATED'])

export type DynamicAgentStatus = z.infer<typeof DynamicAgentStatusSchema>;

// File: DynamicAgentTriggerType.schema.ts

export const DynamicAgentTriggerTypeSchema = z.enum(['MANUAL', 'SCHEDULED', 'WEBHOOK', 'EVENT', 'MENTION'])

export type DynamicAgentTriggerType = z.infer<typeof DynamicAgentTriggerTypeSchema>;

// File: DynamicAgentExecutionStatus.schema.ts

export const DynamicAgentExecutionStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'])

export type DynamicAgentExecutionStatus = z.infer<typeof DynamicAgentExecutionStatusSchema>;

// File: DataConnectionProvider.schema.ts

export const DataConnectionProviderSchema = z.enum(['GOOGLE_DRIVE', 'S3', 'GOOGLE_STORAGE', 'R2', 'DROPBOX', 'AIRTABLE', 'CODA', 'GITBOOK', 'NOTION', 'CONFLUENCE', 'TEAMS', 'INTERCOM', 'GITHUB', 'GITLAB', 'BITBUCKET', 'LINEAR', 'ASANA', 'CLICKUP', 'SLACK', 'SNOWFLAKE', 'BIGQUERY', 'ZENDESK', 'GONG', 'GMAIL', 'JIRA', 'MICROSOFT_365', 'SALESFORCE', 'HUBSPOT'])

export type DataConnectionProvider = z.infer<typeof DataConnectionProviderSchema>;

// File: DataConnectionStatus.schema.ts

export const DataConnectionStatusSchema = z.enum(['PENDING', 'CONNECTED', 'SYNCING', 'ERROR', 'PAUSED', 'EXPIRED'])

export type DataConnectionStatus = z.infer<typeof DataConnectionStatusSchema>;

// File: IncidentSeverity.schema.ts

export const IncidentSeveritySchema = z.enum(['SEV1', 'SEV2', 'SEV3'])

export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

// File: IncidentStatus.schema.ts

export const IncidentStatusSchema = z.enum(['FIRING', 'ACKNOWLEDGED', 'RESOLVED'])

export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

// File: ProviderHealthStatus.schema.ts

export const ProviderHealthStatusSchema = z.enum(['OPERATIONAL', 'DEGRADED', 'PARTIAL_OUTAGE', 'MAJOR_OUTAGE', 'MAINTENANCE', 'UNKNOWN', 'NOT_CONFIGURED'])

export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>;

// File: IncidentDetectionMethod.schema.ts

export const IncidentDetectionMethodSchema = z.enum(['STATUSPAGE_POLL', 'SYNTHETIC_PROBE', 'BREAKER_OPEN', 'ALERT_MANAGER', 'WEBHOOK'])

export type IncidentDetectionMethod = z.infer<typeof IncidentDetectionMethodSchema>;

// File: IncidentEventType.schema.ts

export const IncidentEventTypeSchema = z.enum(['FIRED', 'RE_FIRED', 'ACKNOWLEDGED', 'COMMENT', 'AUTO_RESOLVED', 'MANUAL_RESOLVED'])

export type IncidentEventType = z.infer<typeof IncidentEventTypeSchema>;

// File: StatusUpdateLifecycle.schema.ts

export const StatusUpdateLifecycleSchema = z.enum(['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'])

export type StatusUpdateLifecycle = z.infer<typeof StatusUpdateLifecycleSchema>;

// File: StatusUpdateImpact.schema.ts

export const StatusUpdateImpactSchema = z.enum(['NONE', 'MINOR', 'MAJOR', 'CRITICAL'])

export type StatusUpdateImpact = z.infer<typeof StatusUpdateImpactSchema>;

// File: SyncJobStatus.schema.ts

export const SyncJobStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type SyncJobStatus = z.infer<typeof SyncJobStatusSchema>;

// File: SyncJobType.schema.ts

export const SyncJobTypeSchema = z.enum(['FULL', 'INCREMENTAL', 'SELECTIVE'])

export type SyncJobType = z.infer<typeof SyncJobTypeSchema>;

// File: BackgroundJobKind.schema.ts

export const BackgroundJobKindSchema = z.enum(['TEAMS_CHANNEL_MONITOR', 'TEAMS_CHAT_MONITOR', 'SLACK_CHANNEL_MONITOR', 'SLACK_BACKFILL', 'CODE_INDEXING', 'CONTEXT_PROCESSING', 'STORY_KIND_REGENERATION', 'PUBLISHING_TOPIC_GENERATION'])

export type BackgroundJobKind = z.infer<typeof BackgroundJobKindSchema>;

// File: BackgroundJobStatus.schema.ts

export const BackgroundJobStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED'])

export type BackgroundJobStatus = z.infer<typeof BackgroundJobStatusSchema>;

// File: ResourceSyncStatus.schema.ts

export const ResourceSyncStatusSchema = z.enum(['PENDING', 'SYNCED', 'FAILED', 'DELETED', 'EXCLUDED'])

export type ResourceSyncStatus = z.infer<typeof ResourceSyncStatusSchema>;

// File: SyncFrequency.schema.ts

export const SyncFrequencySchema = z.enum(['REALTIME', 'EVERY_5_MIN', 'HOURLY', 'EVERY_8_HOURS', 'DAILY', 'WEEKLY', 'CUSTOM'])

export type SyncFrequency = z.infer<typeof SyncFrequencySchema>;

// File: KanbanQueueStatus.schema.ts

export const KanbanQueueStatusSchema = z.enum(['PENDING', 'PULLED', 'COMPLETED', 'CANCELLED'])

export type KanbanQueueStatus = z.infer<typeof KanbanQueueStatusSchema>;

// File: CodingRunStatus.schema.ts

export const CodingRunStatusSchema = z.enum(['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_REVIEW', 'PR_OPENED', 'COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED_STALE'])

export type CodingRunStatus = z.infer<typeof CodingRunStatusSchema>;

// File: RepositoryProvider.schema.ts

export const RepositoryProviderSchema = z.enum(['GITHUB', 'GITLAB', 'AZURE_DEVOPS'])

export type RepositoryProvider = z.infer<typeof RepositoryProviderSchema>;

// File: RepositoryAuthMethod.schema.ts

export const RepositoryAuthMethodSchema = z.enum(['OAUTH', 'PAT'])

export type RepositoryAuthMethod = z.infer<typeof RepositoryAuthMethodSchema>;

// File: RepositoryIntegrationStatus.schema.ts

export const RepositoryIntegrationStatusSchema = z.enum(['ACTIVE', 'TOKEN_EXPIRED', 'REPO_UNAVAILABLE', 'ERROR', 'DISCONNECTED'])

export type RepositoryIntegrationStatus = z.infer<typeof RepositoryIntegrationStatusSchema>;

// File: WeavePlanStatus.schema.ts

export const WeavePlanStatusSchema = z.enum(['DRAFT', 'PENDING_APPROVAL', 'NEEDS_REVISION', 'APPROVED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'])

export type WeavePlanStatus = z.infer<typeof WeavePlanStatusSchema>;

// File: WeaveExecutionStatus.schema.ts

export const WeaveExecutionStatusSchema = z.enum(['PENDING', 'RUNNING', 'PAUSED', 'CHECKPOINT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED_STALE'])

export type WeaveExecutionStatus = z.infer<typeof WeaveExecutionStatusSchema>;

// File: ChatArtifactType.schema.ts

export const ChatArtifactTypeSchema = z.enum(['RESEARCH_REPORT', 'CODE', 'DOCUMENT', 'DATA', 'CHART', 'FILE', 'SUMMARY'])

export type ChatArtifactType = z.infer<typeof ChatArtifactTypeSchema>;

// File: NotificationType.schema.ts

export const NotificationTypeSchema = z.enum(['STORY_MENTION', 'STORY_COMMENT_REPLY', 'STORY_ASSIGNED', 'TASK_MENTION', 'TASK_COMMENT_REPLY', 'COMMENT_MENTION', 'DOCUMENT_MENTION', 'AGENT_REPLY_READY', 'STORY_STATUS_CHANGED', 'PM_SYNC_CONFLICT', 'AI_USAGE_LIMIT_WARNING', 'AI_USAGE_LIMIT_REACHED', 'INTEGRATION_INCIDENT', 'SYSTEM_INCIDENT', 'CONTEXT_INDEXING_STARTED', 'CONTEXT_INDEXING_COMPLETED', 'REPO_INTEGRATION_TOKEN_EXPIRED', 'SECURITY_SCAN_COMPLETED', 'PROJECT_SERVICE_ALERT_DIGEST', 'REPORT_COMPLETED', 'REPORT_FAILED', 'SECURITY_TICKETS_GENERATED', 'DOCUMENT_UPDATED', 'FEATURE_UPDATED', 'STORY_SHARED', 'NEWSLETTER_APPROVAL_PENDING', 'TEST_CASES_DRAFTED', 'STATUS_ANNOUNCEMENT', 'PUBLISHING_TOPICS_READY', 'PROMPT_DEFAULT_UPDATED', 'PROMPT_NOMINATION_PENDING', 'PM_ATTACHMENT_SYNC_FAILED', 'DECISION_OWNER_ASSIGNED', 'DECISION_OWNER_UPDATED'])

export type NotificationType = z.infer<typeof NotificationTypeSchema>;

// File: NotificationCategory.schema.ts

export const NotificationCategorySchema = z.enum(['MENTION', 'REPLY', 'ASSIGNMENT', 'STATUS', 'AGENT', 'PROJECT', 'SYSTEM', 'BILLING', 'CONTEXT_INDEXING_STARTED', 'CONTEXT_INDEXING_COMPLETED', 'SUBSCRIPTION', 'PUBLISHING', 'DECISION_OWNER_ASSIGNED', 'DECISION_OWNER_UPDATED'])

export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

// File: SubscriptionSubjectType.schema.ts

export const SubscriptionSubjectTypeSchema = z.enum(['DOCUMENT', 'FEATURE'])

export type SubscriptionSubjectType = z.infer<typeof SubscriptionSubjectTypeSchema>;

// File: PmStateChangeEntityType.schema.ts

export const PmStateChangeEntityTypeSchema = z.enum(['EPIC', 'FEATURE', 'STORY', 'TEST_CASE'])

export type PmStateChangeEntityType = z.infer<typeof PmStateChangeEntityTypeSchema>;

// File: PendingPmStateChangeAction.schema.ts

export const PendingPmStateChangeActionSchema = z.enum(['HIDE', 'UNHIDE', 'FLAG_MISSING', 'CONTENT_DRIFT'])

export type PendingPmStateChangeAction = z.infer<typeof PendingPmStateChangeActionSchema>;

// File: PendingPmStateChangeStatus.schema.ts

export const PendingPmStateChangeStatusSchema = z.enum(['PENDING', 'APPROVED', 'DISMISSED'])

export type PendingPmStateChangeStatus = z.infer<typeof PendingPmStateChangeStatusSchema>;

// File: ProviderCategory.schema.ts

export const ProviderCategorySchema = z.enum(['GATEWAY', 'DIRECT'])

export type ProviderCategory = z.infer<typeof ProviderCategorySchema>;

// File: User.schema.ts

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  username: z.string().nullish(),
  role: z.string().nullish(),
  banned: z.boolean().nullish(),
  banReason: z.string().nullish(),
  banExpires: z.date().nullish(),
  onboardingComplete: z.boolean(),
  mustChangePassword: z.boolean(),
  welcomeEmailSentAt: z.date().nullish(),
  lastSeenAt: z.date().nullish(),
  paymentsCustomerId: z.string().nullish(),
  locale: z.string().nullish(),
  timezone: z.string().nullish(),
  twoFactorEnabled: z.boolean().nullish(),
  mfaPromptDismissedAt: z.date().nullish(),
  mfaPromptSnoozedUntil: z.date().nullish(),
  onboardingTourState: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  defaultFunctionTags: z.array(FunctionTagSchema),
  firecrawlApiKey: z.string().nullish(),
  firecrawlEnabled: z.boolean(),
  firecrawlConfiguredAt: z.date().nullish(),
  firecrawlLastUsedAt: z.date().nullish(),
  azureAiApiKey: z.string().nullish(),
  azureAiConfiguredAt: z.date().nullish(),
  azureAiEnabled: z.boolean(),
  azureAiEndpoint: z.string().nullish(),
  azureAiLastUsedAt: z.date().nullish(),
  azureAiModelRouterName: z.string().nullish(),
  azureAiProjectName: z.string().nullish(),
  azureAiRegion: z.string().nullish(),
  azureAiResourceGroup: z.string().nullish(),
  azureAiSubscriptionId: z.string().nullish(),
  azureAiTenantId: z.string().nullish(),
  azureAiUseModelRouter: z.boolean(),
  useDelegatedExecution: z.boolean().default(true),
  lastActiveOrganizationId: z.string().nullish(),
  failedLoginAttempts: z.number().int(),
  lockedUntil: z.date().nullish(),
  lastFailedLoginAt: z.date().nullish(),
});

export type UserType = z.infer<typeof UserSchema>;


// File: Session.schema.ts

export const SessionSchema = z.object({
  id: z.string(),
  expiresAt: z.date(),
  ipAddress: z.string().nullish(),
  userAgent: z.string().nullish(),
  userId: z.string(),
  impersonatedBy: z.string().nullish(),
  activeOrganizationId: z.string().nullish(),
  token: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  twoFactorStepUpGrantedAt: z.date().nullish(),
});

export type SessionType = z.infer<typeof SessionSchema>;


// File: Account.schema.ts

export const AccountSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  providerId: z.string(),
  userId: z.string(),
  accessToken: z.string().nullish(),
  refreshToken: z.string().nullish(),
  idToken: z.string().nullish(),
  expiresAt: z.date().nullish(),
  password: z.string().nullish(),
  accessTokenExpiresAt: z.date().nullish(),
  refreshTokenExpiresAt: z.date().nullish(),
  scope: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AccountType = z.infer<typeof AccountSchema>;


// File: Verification.schema.ts

export const VerificationSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  value: z.string(),
  expiresAt: z.date(),
  createdAt: z.date().nullish(),
  updatedAt: z.date().nullish(),
});

export type VerificationType = z.infer<typeof VerificationSchema>;


// File: Waitlist.schema.ts

export const WaitlistSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullish(),
  source: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
});

export type WaitlistType = z.infer<typeof WaitlistSchema>;


// File: Passkey.schema.ts

export const PasskeySchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  publicKey: z.string(),
  userId: z.string(),
  credentialID: z.string(),
  counter: z.number().int(),
  deviceType: z.string(),
  backedUp: z.boolean(),
  transports: z.string().nullish(),
  createdAt: z.date().nullish(),
  aaguid: z.string().nullish(),
});

export type PasskeyType = z.infer<typeof PasskeySchema>;


// File: TwoFactor.schema.ts

export const TwoFactorSchema = z.object({
  id: z.string(),
  secret: z.string(),
  backupCodes: z.string(),
  userId: z.string(),
  verified: z.boolean().default(true),
  failedVerificationCount: z.number().int(),
  lockedUntil: z.date().nullish(),
  stepUpFailedCount: z.number().int(),
  stepUpLockedUntil: z.date().nullish(),
  stepUpEpoch: z.number().int(),
});

export type TwoFactorType = z.infer<typeof TwoFactorSchema>;


// File: Organization.schema.ts

export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullish(),
  logo: z.string().nullish(),
  createdAt: z.date(),
  metadata: z.string().nullish(),
  paymentsCustomerId: z.string().nullish(),
  timezone: z.string().nullish(),
  firecrawlApiKey: z.string().nullish(),
  firecrawlEnabled: z.boolean(),
  firecrawlConfiguredAt: z.date().nullish(),
  firecrawlLastUsedAt: z.date().nullish(),
  azureAiApiKey: z.string().nullish(),
  azureAiConfiguredAt: z.date().nullish(),
  azureAiEnabled: z.boolean(),
  azureAiEndpoint: z.string().nullish(),
  azureAiLastUsedAt: z.date().nullish(),
  azureAiModelRouterName: z.string().nullish(),
  azureAiProjectName: z.string().nullish(),
  azureAiRegion: z.string().nullish(),
  azureAiResourceGroup: z.string().nullish(),
  azureAiSubscriptionId: z.string().nullish(),
  azureAiTenantId: z.string().nullish(),
  azureAiUseModelRouter: z.boolean(),
  useDelegatedExecution: z.boolean().default(true),
  documentAssistantHistoryEnabled: z.boolean().default(true),
  featureMaturationV2Enabled: z.boolean().default(true),
  aiAnswerRecommendationsEnabled: z.boolean(),
  requireTwoFactor: z.boolean(),
  attachmentRetentionDays: z.number().int().nullish(),
  attachmentRetentionDaysUpdatedAt: z.date().nullish(),
  canShareFramesPublicly: z.boolean().default(true),
  allowedFrameShareDomains: z.array(z.string()),
});

export type OrganizationType = z.infer<typeof OrganizationSchema>;


// File: OrganizationRagSettings.schema.ts

export const OrganizationRagSettingsSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  chunkSize: z.number().int().nullish(),
  chunkOverlap: z.number().int().nullish(),
  splitMethod: ChunkSplitMethodSchema.nullish(),
  embeddingModel: EmbeddingModelSchema.nullish(),
  topK: z.number().int().nullish(),
  similarityThreshold: z.number().nullish(),
  enableReranking: z.boolean().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrganizationRagSettingsType = z.infer<typeof OrganizationRagSettingsSchema>;


// File: Member.schema.ts

export const MemberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: z.date(),
});

export type MemberType = z.infer<typeof MemberSchema>;


// File: Invitation.schema.ts

export const InvitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: z.string().nullish(),
  status: z.string(),
  teamId: z.string().nullish(),
  expiresAt: z.date(),
  inviterId: z.string(),
  createdAt: z.date(),
});

export type InvitationType = z.infer<typeof InvitationSchema>;


// File: Purchase.schema.ts

export const PurchaseSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  type: PurchaseTypeSchema,
  customerId: z.string(),
  subscriptionId: z.string().nullish(),
  productId: z.string(),
  status: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PurchaseModel = z.infer<typeof PurchaseSchema>;

// File: AiCreditAccount.schema.ts

export const AiCreditAccountSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  usedCreditUsd: z.union([z.string().regex(/^-?\d+(\.\d+)?$/, { message: "Must be a valid decimal string" }), z.number()]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AiCreditAccountType = z.infer<typeof AiCreditAccountSchema>;


// File: AiOutcomeEvent.schema.ts

export const AiOutcomeEventSchema = z.object({
  id: z.string(),
  featureKey: z.string(),
  outcome: AiOutcomeKindSchema,
  subjectType: z.string(),
  subjectId: z.string(),
  modelCanonicalName: z.string().nullish(),
  promptVersionId: z.string().nullish(),
  comment: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  projectId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AiOutcomeEventType = z.infer<typeof AiOutcomeEventSchema>;


// File: AiChat.schema.ts

export const AiChatSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  title: z.string().nullish(),
  messages: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  toolSelectionMode: AiChatToolSelectionModeSchema.default("DEFAULT"),
  pinned: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  workflowId: z.string().nullish(),
  workflowRunId: z.string().nullish(),
  workflowStatus: WorkflowStatusSchema.default("NONE"),
  lastError: z.string().nullish(),
  retryCount: z.number().int(),
  lastRetryAt: z.date().nullish(),
  projectId: z.string().nullish(),
});

export type AiChatType = z.infer<typeof AiChatSchema>;


// File: AiChatMcpConfig.schema.ts

export const AiChatMcpConfigSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  mcpConfigId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  enabled: z.boolean().default(true),
  source: z.string().default("conversation"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AiChatMcpConfigType = z.infer<typeof AiChatMcpConfigSchema>;


// File: ChatDocument.schema.ts

export const ChatDocumentSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  s3Path: z.string(),
  status: DocumentStatusSchema.default("PENDING"),
  errorMessage: z.string().nullish(),
  workflowId: z.string().nullish(),
  workflowRunId: z.string().nullish(),
  workflowStatus: WorkflowStatusSchema.default("NONE"),
  lastError: z.string().nullish(),
  retryCount: z.number().int(),
  lastRetryAt: z.date().nullish(),
  extractorUsed: z.string().nullish(),
  extractionTime: z.number().int().nullish(),
  extractionCost: z.number().nullish(),
  pageCount: z.number().int().nullish(),
  hasTables: z.boolean(),
  hasImages: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ChatDocumentType = z.infer<typeof ChatDocumentSchema>;


// File: DocumentChunk.schema.ts

export const DocumentChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  chatId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  content: z.string(),
  chunkIndex: z.number().int(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("{}"),
  createdAt: z.date(),
});

export type DocumentChunkType = z.infer<typeof DocumentChunkSchema>;


// File: OrganizationRagProvider.schema.ts

export const OrganizationRagProviderSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  providerName: z.string(),
  encryptedApiKey: z.string().nullish(),
  endpoint: z.string().nullish(),
  isDefault: z.boolean(),
  priority: z.number().int(),
  enabled: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastUsedAt: z.date().nullish(),
  documentsProcessed: z.number().int(),
  totalCost: z.number(),
});

export type OrganizationRagProviderType = z.infer<typeof OrganizationRagProviderSchema>;


// File: OrganizationSearchProvider.schema.ts

export const OrganizationSearchProviderSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  providerName: z.string(),
  encryptedApiKey: z.string().nullish(),
  endpoint: z.string().nullish(),
  isDefault: z.boolean(),
  priority: z.number().int(),
  enabled: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastUsedAt: z.date().nullish(),
  searchesCount: z.number().int(),
  totalCost: z.number(),
});

export type OrganizationSearchProviderType = z.infer<typeof OrganizationSearchProviderSchema>;


// File: UserRagProvider.schema.ts

export const UserRagProviderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  providerName: z.string(),
  encryptedApiKey: z.string().nullish(),
  endpoint: z.string().nullish(),
  isDefault: z.boolean(),
  priority: z.number().int(),
  enabled: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastUsedAt: z.date().nullish(),
  documentsProcessed: z.number().int(),
  totalCost: z.number(),
});

export type UserRagProviderType = z.infer<typeof UserRagProviderSchema>;


// File: UserSearchProvider.schema.ts

export const UserSearchProviderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  providerName: z.string(),
  encryptedApiKey: z.string().nullish(),
  endpoint: z.string().nullish(),
  isDefault: z.boolean(),
  priority: z.number().int(),
  enabled: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastUsedAt: z.date().nullish(),
  searchesCount: z.number().int(),
  totalCost: z.number(),
});

export type UserSearchProviderType = z.infer<typeof UserSearchProviderSchema>;


// File: UserApiKey.schema.ts

export const UserApiKeySchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  keyHash: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.date().nullish(),
  lastUsedAt: z.date().nullish(),
  usageCount: z.number().int(),
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserApiKeyType = z.infer<typeof UserApiKeySchema>;


// File: OrganizationApiKey.schema.ts

export const OrganizationApiKeySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  createdByUserId: z.string(),
  name: z.string(),
  keyHash: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.date().nullish(),
  lastUsedAt: z.date().nullish(),
  usageCount: z.number().int(),
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrganizationApiKeyType = z.infer<typeof OrganizationApiKeySchema>;


// File: Agent.schema.ts

export const AgentSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  framework: AgentFrameworkSchema,
  runtimeVersion: z.string().default("v1"),
  deploymentUrl: z.string().nullish(),
  status: AgentStatusSchema.default("ACTIVE"),
  scope: AgentScopeSchema.default("USER"),
  userId: z.string(),
  organizationId: z.string().nullish(),
  config: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastHealthCheck: z.date().nullish(),
  lastDeployedAt: z.date().nullish(),
  aiModel: z.string().nullish(),
  aiModelConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  aiProvider: AIProviderSchema.nullish(),
  useGlobalAiProvider: z.boolean().default(true),
});

export type AgentType = z.infer<typeof AgentSchema>;


// File: AgentTask.schema.ts

export const AgentTaskSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  status: z.string(),
  stage: z.string(),
  input: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  state: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  result: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  workflowId: z.string().nullish(),
  runId: z.string().nullish(),
  framework: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullish(),
});

export type AgentTaskType = z.infer<typeof AgentTaskSchema>;


// File: AgentApproval.schema.ts

export const AgentApprovalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  userId: z.string(),
  status: z.string(),
  changes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  feedback: z.string().nullish(),
  confidence: z.number().nullish(),
  createdAt: z.date(),
  decidedAt: z.date().nullish(),
  expiresAt: z.date().nullish(),
  weaveExecutionId: z.string().nullish(),
  weavePlanId: z.string().nullish(),
  weaveContext: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
});

export type AgentApprovalType = z.infer<typeof AgentApprovalSchema>;


// File: IntegrationApproval.schema.ts

export const IntegrationApprovalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  pluginSlug: z.string(),
  endpoint: z.string(),
  args: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  riskLevel: z.string(),
  status: z.string().default("pending"),
  expiresAt: z.date(),
  createdAt: z.date(),
  decidedAt: z.date().nullish(),
  decidedById: z.string().nullish(),
});

export type IntegrationApprovalType = z.infer<typeof IntegrationApprovalSchema>;


// File: ChannelEventReceipt.schema.ts

export const ChannelEventReceiptSchema = z.object({
  id: z.string(),
  channel: z.string(),
  externalEventId: z.string(),
  receivedAt: z.date(),
});

export type ChannelEventReceiptType = z.infer<typeof ChannelEventReceiptSchema>;


// File: ChannelThreadMapping.schema.ts

export const ChannelThreadMappingSchema = z.object({
  id: z.string(),
  channel: z.string(),
  channelId: z.string(),
  threadId: z.string(),
  status: z.string().default("active"),
  workflowId: z.string().nullish(),
  agentId: z.string().nullish(),
  triggerId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  lastMessageAt: z.date().nullish(),
  timeoutAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ChannelThreadMappingType = z.infer<typeof ChannelThreadMappingSchema>;


// File: RegisteredAgent.schema.ts

export const RegisteredAgentSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullish(),
  framework: z.string(),
  deploymentUrl: z.string().nullish(),
  status: z.string().default("ACTIVE"),
  scope: z.string().default("USER"),
  autonomyLevel: AutonomyLevelSchema.default("BALANCED"),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  config: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  lastHealthCheck: z.date().nullish(),
  consecutiveHealthFailures: z.number().int(),
  lastHealthError: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type RegisteredAgentType = z.infer<typeof RegisteredAgentSchema>;


// File: RegisteredAgentSuggestion.schema.ts

export const RegisteredAgentSuggestionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  key: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  kind: RegisteredAgentSuggestionKindSchema,
  title: z.string(),
  description: z.string(),
  payload: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  state: RegisteredAgentSuggestionStateSchema.default("PENDING"),
  source: z.string().default("generated"),
  conversationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type RegisteredAgentSuggestionType = z.infer<typeof RegisteredAgentSuggestionSchema>;


// File: AgentConversation.schema.ts

export const AgentConversationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  agentId: z.string(),
  title: z.string().nullish(),
  messages: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  trajectory: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  pinned: z.boolean(),
  status: AgentConversationStatusSchema.default("ACTIVE"),
  createdAt: z.date(),
  updatedAt: z.date(),
  parentConversationId: z.string().nullish(),
  carriedOverSummary: z.string().nullish(),
  carriedOverAt: z.date().nullish(),
});

export type AgentConversationType = z.infer<typeof AgentConversationSchema>;


// File: SDLCArtifact.schema.ts

export const SDLCArtifactSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  organizationId: z.string(),
  stage: z.string(),
  artifactType: z.string(),
  name: z.string(),
  content: z.string(),
  format: z.string().default("markdown"),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  version: z.string().default("1.0"),
  qdrantId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SDLCArtifactType = z.infer<typeof SDLCArtifactSchema>;


// File: SDLCPipeline.schema.ts

export const SDLCPipelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  status: z.string(),
  currentStage: z.string().nullish(),
  stages: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  progress: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullish(),
});

export type SDLCPipelineType = z.infer<typeof SDLCPipelineSchema>;


// File: Project.schema.ts

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  goals: z.string().nullish(),
  techStack: z.array(z.string()),
  features: z.array(z.string()),
  projectTypes: z.array(z.string()),
  status: ProjectStatusSchema.default("DRAFT"),
  projectPhase: ProjectPhaseSchema.nullish(),
  expectedDevelopmentStartDate: z.date().nullish(),
  tags: z.array(z.string()),
  color: z.string().nullish(),
  icon: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  projectManagementMcpServerId: z.string().nullish(),
  projectManagementMcpConfigId: z.string().nullish(),
  projectManagementContainerId: z.string().nullish(),
  projectManagementContainerName: z.string().nullish(),
  projectManagementAdditionalContext: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  logSourceProvider: z.string().nullish(),
  logSourceConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  adoStatePollActive: z.boolean(),
  autoPushPmSync: z.boolean(),
  syncAttachments: z.boolean(),
  attachmentRetentionDays: z.number().int().nullish(),
  attachmentRetentionDaysUpdatedAt: z.date().nullish(),
  readOnlyMode: z.boolean(),
  lastAdoStatePollAt: z.date().nullish(),
  pmTerminalStatuses: z.array(z.string()),
  pmAutoCloseEnabled: z.boolean(),
  pmFieldMappingEnabled: z.boolean(),
  prdSourceTitle: z.string().nullish(),
  prdSourceUrl: z.string().nullish(),
  prdSourceContextId: z.string().nullish(),
  prdSourceSyncedAt: z.date().nullish(),
  meetingTranscriptSyncEnabled: z.boolean(),
  meetingTranscriptSyncIntervalMin: z.number().int().nullish(),
  meetingTranscriptSyncLastRun: z.date().nullish(),
  meetingTranscriptSyncWorkflowId: z.string().nullish(),
  meetingTranscriptAutoAnalyzeEnabled: z.boolean(),
  actionItemRoutingEnabled: z.boolean(),
  teamsChannelMonitorEnabled: z.boolean(),
  teamsChannelMonitorIntervalMin: z.number().int().nullish(),
  teamsChannelMonitorQuietWindowMin: z.number().int().default(60).nullish(),
  teamsChannelMonitorLastRun: z.date().nullish(),
  teamsChannelMonitorWorkflowId: z.string().nullish(),
  teamsChatMonitorEnabled: z.boolean(),
  teamsChatMonitorIntervalMin: z.number().int().nullish(),
  teamsChatMonitorQuietWindowMin: z.number().int().default(60).nullish(),
  teamsChatMonitorLastRun: z.date().nullish(),
  teamsChatMonitorWorkflowId: z.string().nullish(),
  slackChannelMonitorEnabled: z.boolean(),
  slackChannelMonitorWorkflowId: z.string().nullish(),
  slackChannelMonitorLastRun: z.date().nullish(),
  slackChannelMonitorDebounceMs: z.number().int().default(30000).nullish(),
  slackChannelMonitorMaxHoldMs: z.number().int().default(300000).nullish(),
  slackHuddleIngestEnabled: z.boolean(),
  slackHuddleIngestEnabledAt: z.date().nullish(),
  slackHuddleIngestIntervalMin: z.number().int().nullish(),
  slackHuddleIngestLastRun: z.date().nullish(),
  slackHuddleIngestWorkflowId: z.string().nullish(),
  repositoryUrl: z.string().nullish(),
  repositoryOwner: z.string().nullish(),
  repositoryName: z.string().nullish(),
  defaultBranch: z.string().nullish(),
  implementationDefaultChannel: CodingRunExecutionChannelSchema.nullish(),
  implementationDefaultProvider: CodingRunProviderSchema.nullish(),
  implementationDefaultWorkingDirectory: z.string().nullish(),
  primaryWebsiteUrl: z.string().nullish(),
  additionalWebsiteUrls: z.array(z.string()),
  codeAnalysisStatus: CodeAnalysisStatusSchema.nullish(),
  codeAnalysisWorkflowId: z.string().nullish(),
  draftKey: z.string().nullish(),
  wizardState: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  nextStoryNumber: z.number().int().default(1),
  lastDuplicateScanAt: z.date().nullish(),
  hiddenMaturationStatuses: z.array(z.string()),
  clarifyingQuestionFrequency: ClarifyingQuestionFrequencySchema.default("BALANCED"),
  qaStrategyLevel: QaStrategyLevelSchema.default("STANDARD"),
  generateManualTestCases: z.boolean().default(true),
  applyTddApproach: z.boolean(),
  projectTabConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  autoCreateBugsFromFailures: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
  deletedBy: z.string().nullish(),
  scheduledPermanentDeleteAt: z.date().nullish(),
  deletionReminderSentAt: z.date().nullish(),
});

export type ProjectType = z.infer<typeof ProjectSchema>;


// File: ProjectDocument.schema.ts

export const ProjectDocumentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: ProjectDocumentTypeSchema,
  title: z.string(),
  content: z.string(),
  status: ProjectDocumentStatusSchema.default("DRAFT"),
  version: z.number().int().default(1),
  generationPrompt: z.string().nullish(),
  generationError: z.string().nullish(),
  generationProgress: z.number().int(),
  generationStartedAt: z.date().nullish(),
  generationCompletedAt: z.date().nullish(),
  workflowId: z.string().nullish(),
  runId: z.string().nullish(),
  wordCount: z.number().int().nullish(),
  lastEditedBy: z.string().nullish(),
  decisionPrecheck: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  source: DocumentSourceSchema.default("GENERATED"),
  sourceContextId: z.string().nullish(),
  isActive: z.boolean().default(true),
  qdrantId: z.string().nullish(),
  embeddedAt: z.date().nullish(),
  contentHash: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectDocumentModel = z.infer<typeof ProjectDocumentSchema>;

// File: ProjectDocumentAsset.schema.ts

export const ProjectDocumentAssetSchema = z.object({
  id: z.string(),
  projectDocumentId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  storageKey: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  sortOrder: z.number().int(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type ProjectDocumentAssetType = z.infer<typeof ProjectDocumentAssetSchema>;


// File: ProjectContext.schema.ts

export const ProjectContextSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: ProjectContextTypeSchema,
  content: z.string(),
  qdrantId: z.string().nullish(),
  embeddedAt: z.date().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  s3Path: z.string().nullish(),
  s3Bucket: z.string().nullish(),
  originalFilename: z.string().nullish(),
  mimeType: z.string().nullish(),
  fileSize: z.number().int().nullish(),
  extractionStatus: ExtractionStatusSchema.default("PENDING"),
  extractionError: z.string().nullish(),
  extractedAt: z.date().nullish(),
  sourceUrl: z.string().nullish(),
  sourceTitle: z.string().nullish(),
  knowledgeBaseSourceCategory: KnowledgeBaseSourceCategorySchema.nullish(),
  knowledgeBaseSourceCategoryOther: z.string().nullish(),
  urlScope: UrlSourceScopeSchema.nullish(),
  urlMaxPages: z.number().int().nullish(),
  urlRefreshMode: UrlRefreshModeSchema.nullish(),
  urlNextRefreshAt: z.date().nullish(),
  urlLastSyncedAt: z.date().nullish(),
  urlScheduleId: z.string().nullish(),
  urlActiveWorkflowId: z.string().nullish(),
  sourceType: z.string().nullish(),
  aiInstructions: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  ownerKey: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectContextModel = z.infer<typeof ProjectContextSchema>;

// File: ProjectReadinessItemState.schema.ts

export const ProjectReadinessItemStateSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  itemKey: z.string(),
  state: ProjectReadinessItemStateValueSchema,
  personalForUserId: z.string().nullish(),
  snoozeUntil: z.date().nullish(),
  everHelpRequested: z.boolean(),
  helpRequestedAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectReadinessItemStateType = z.infer<typeof ProjectReadinessItemStateSchema>;


// File: ProjectReadinessVerdict.schema.ts

export const ProjectReadinessVerdictSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  itemKey: z.string(),
  isComplete: z.boolean(),
  changedAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectReadinessVerdictType = z.infer<typeof ProjectReadinessVerdictSchema>;


// File: ProjectContextUrlPage.schema.ts

export const ProjectContextUrlPageSchema = z.object({
  id: z.string(),
  parentContextId: z.string(),
  projectId: z.string(),
  pageUrl: z.string(),
  pageTitle: z.string().nullish(),
  content: z.string(),
  qdrantId: z.string().nullish(),
  embeddedAt: z.date().nullish(),
  lastFetchedAt: z.date(),
  etag: z.string().nullish(),
  lastModifiedHeader: z.string().nullish(),
  contentHash: z.string(),
  chunkCount: z.number().int(),
  extractionStatus: ExtractionStatusSchema.default("PENDING"),
  extractionError: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectContextUrlPageType = z.infer<typeof ProjectContextUrlPageSchema>;


// File: ProjectContextConversationBundle.schema.ts

export const ProjectContextConversationBundleSchema = z.object({
  id: z.string(),
  parentContextId: z.string(),
  projectId: z.string(),
  providerThreadId: z.string().nullish(),
  content: z.string(),
  contentHash: z.string(),
  messageCount: z.number().int(),
  bundleStartedAt: z.date(),
  bundleEndedAt: z.date().nullish(),
  qdrantId: z.string().nullish(),
  embeddingLeaseAt: z.date().nullish(),
  embeddedAt: z.date().nullish(),
  extractionStatus: ExtractionStatusSchema.default("PENDING"),
  extractionError: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  ownerKey: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectContextConversationBundleType = z.infer<typeof ProjectContextConversationBundleSchema>;


// File: ProjectContextConversationClaim.schema.ts

export const ProjectContextConversationClaimSchema = z.object({
  id: z.string(),
  parentContextId: z.string(),
  projectId: z.string(),
  providerMessageId: z.string(),
  providerThreadId: z.string().nullish(),
  messageCreatedAt: z.date().nullish(),
  bundleId: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  ownerKey: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectContextConversationClaimType = z.infer<typeof ProjectContextConversationClaimSchema>;


// File: ProjectContextPendingVectorCleanup.schema.ts

export const ProjectContextPendingVectorCleanupSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  contextIds: z.array(z.string()),
  attempts: z.number().int(),
  lastError: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectContextPendingVectorCleanupType = z.infer<typeof ProjectContextPendingVectorCleanupSchema>;


// File: ProjectContextSummary.schema.ts

export const ProjectContextSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  content: z.string(),
  status: ContextSummaryStatusSchema.default("PENDING"),
  trigger: ContextSummaryTriggerSchema,
  coveredThrough: z.date(),
  snapshotThrough: z.date().nullish(),
  coveredContextCount: z.number().int(),
  tokenCount: z.number().int().nullish(),
  references: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  engineVersion: z.number().int().default(1),
  stats: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  sourceSelection: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  manualEdit: z.boolean(),
  editedByUserId: z.string().nullish(),
  spentInputTokens: z.number().int().nullish(),
  spentOutputTokens: z.number().int().nullish(),
  spentCostMicroUsd: z.bigint().nullish(),
  model: z.string().nullish(),
  error: z.string().nullish(),
  triggeredByUserId: z.string().nullish(),
  qdrantId: z.string().nullish(),
  embeddedAt: z.date().nullish(),
  supersededById: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectContextSummaryType = z.infer<typeof ProjectContextSummarySchema>;


// File: WizardTempContext.schema.ts

export const WizardTempContextSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  type: ProjectContextTypeSchema,
  content: z.string(),
  qdrantId: z.string().nullish(),
  embeddedAt: z.date().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  s3Path: z.string(),
  s3Bucket: z.string(),
  originalFilename: z.string(),
  mimeType: z.string(),
  fileSize: z.number().int(),
  extractionStatus: ExtractionStatusSchema.default("PENDING"),
  extractionError: z.string().nullish(),
  extractedAt: z.date().nullish(),
  createdAt: z.date(),
  expiresAt: z.date(),
});

export type WizardTempContextType = z.infer<typeof WizardTempContextSchema>;


// File: DocumentVersion.schema.ts

export const DocumentVersionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  version: z.number().int(),
  content: z.string(),
  changeDescription: z.string().nullish(),
  changedBy: z.string().nullish(),
  createdAt: z.date(),
  promptVersionId: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type DocumentVersionType = z.infer<typeof DocumentVersionSchema>;


// File: DocumentAutoRefreshSettings.schema.ts

export const DocumentAutoRefreshSettingsSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  projectId: z.string(),
  enabled: z.boolean(),
  cadence: z.string().default("BIWEEKLY"),
  deployPendingSince: z.date().nullish(),
  autoApply: z.boolean(),
  pendingContent: z.string().nullish(),
  pendingSummary: z.string().nullish(),
  pendingProposedAt: z.date().nullish(),
  pendingBaselineVersion: z.number().int().nullish(),
  createdByUserId: z.string(),
  lastRefreshedAt: z.date().nullish(),
  lastAttemptAt: z.date().nullish(),
  lastRefreshStatus: z.string().nullish(),
  lastRefreshSummary: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type DocumentAutoRefreshSettingsType = z.infer<typeof DocumentAutoRefreshSettingsSchema>;


// File: ProjectRagSettings.schema.ts

export const ProjectRagSettingsSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  chunkSize: z.number().int().default(3000),
  chunkOverlap: z.number().int().default(500),
  splitMethod: ChunkSplitMethodSchema.default("DOCUMENT"),
  embeddingModel: EmbeddingModelSchema.default("TEXT_EMBEDDING_3_SMALL"),
  topK: z.number().int().default(50),
  similarityThreshold: z.number().default(0.30000000000000004),
  enableReranking: z.boolean().default(true),
  rerankTopK: z.number().int().default(10),
  rerankerProvider: z.string().default("cross-encoder"),
  enableEpisodicMemory: z.boolean().default(true),
  codeSearchEnabled: z.boolean(),
  codeSearchProvider: z.string().nullish(),
  codeEmbeddingModel: z.string().default("TEXT_EMBEDDING_3_SMALL").nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectRagSettingsType = z.infer<typeof ProjectRagSettingsSchema>;


// File: ProjectScanConfig.schema.ts

export const ProjectScanConfigSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  securityEnabled: z.boolean().default(true),
  accessibilityEnabled: z.boolean().default(true),
  enforcementMode: ScanEnforcementModeSchema.default("WARN"),
  autoScanOnMaturation: z.boolean().default(true),
  maturationGate: FeatureDraftingStageSchema.default("PUBLISHED"),
  semgrepEnabled: z.boolean(),
  gitHistoryEnabled: z.boolean(),
  autoReviewFindings: z.boolean().default(true),
  scanBranch: z.string().nullish(),
  declinedGroupingThemes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  customRules: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  severityRubric: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  securityKnowledgePacks: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectScanConfigType = z.infer<typeof ProjectScanConfigSchema>;


// File: ProjectScan.schema.ts

export const ProjectScanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  storyId: z.string().nullish(),
  status: ScanStatusSchema.default("PENDING"),
  trigger: ScanTriggerSchema.default("MANUAL"),
  targetType: ScanTargetTypeSchema.default("PROJECT"),
  mode: ScanModeSchema.default("FULL"),
  branch: z.string().nullish(),
  securityRequested: z.boolean().default(true),
  accessibilityRequested: z.boolean().default(true),
  securityFindingCount: z.number().int(),
  accessibilityFindingCount: z.number().int(),
  modelName: z.string().nullish(),
  inputTokens: z.number().int().nullish(),
  outputTokens: z.number().int().nullish(),
  costUsd: z.number().nullish(),
  durationMs: z.number().int().nullish(),
  error: z.string().nullish(),
  workflowId: z.string().nullish(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectScanType = z.infer<typeof ProjectScanSchema>;


// File: ProjectScanCheckpoint.schema.ts

export const ProjectScanCheckpointSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  lastScanId: z.string().nullish(),
  lastScannedAt: z.date(),
  changedFileCount: z.number().int().nullish(),
  changedCommitCount: z.number().int().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectScanCheckpointType = z.infer<typeof ProjectScanCheckpointSchema>;


// File: ScanFinding.schema.ts

export const ScanFindingSchema = z.object({
  id: z.string(),
  scanId: z.string(),
  projectId: z.string(),
  storyId: z.string().nullish(),
  category: ScanCategorySchema,
  severity: ScanSeveritySchema,
  title: z.string(),
  description: z.string(),
  remediation: z.string(),
  ruleSource: z.string(),
  isCustomRule: z.boolean(),
  location: z.string().nullish(),
  sourceUrl: z.string().nullish(),
  evidence: z.string().nullish(),
  status: ScanFindingStatusSchema.default("OPEN"),
  confidence: z.number().nullish(),
  fingerprint: z.string().nullish(),
  firstDetectedAt: z.date().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ScanFindingType = z.infer<typeof ScanFindingSchema>;


// File: ScanActivity.schema.ts

export const ScanActivitySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: ScanActivityTypeSchema,
  scanId: z.string().nullish(),
  findingId: z.string().nullish(),
  storyId: z.string().nullish(),
  summary: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type ScanActivityModel = z.infer<typeof ScanActivitySchema>;

// File: ScanFindingReview.schema.ts

export const ScanFindingReviewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: ScanStatusSchema.default("PENDING"),
  proposals: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  reviewedCount: z.number().int(),
  modelName: z.string().nullish(),
  inputTokens: z.number().int().nullish(),
  outputTokens: z.number().int().nullish(),
  costUsd: z.number().nullish(),
  durationMs: z.number().int().nullish(),
  error: z.string().nullish(),
  workflowId: z.string().nullish(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ScanFindingReviewType = z.infer<typeof ScanFindingReviewSchema>;


// File: ScanFindingGrouping.schema.ts

export const ScanFindingGroupingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  scanId: z.string().nullish(),
  status: GroupingRunStatusSchema.default("PENDING"),
  results: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdCount: z.number().int(),
  updatedCount: z.number().int(),
  skippedCount: z.number().int(),
  failedCount: z.number().int(),
  themeCount: z.number().int(),
  findingCount: z.number().int(),
  modelName: z.string().nullish(),
  inputTokens: z.number().int().nullish(),
  outputTokens: z.number().int().nullish(),
  costUsd: z.number().nullish(),
  durationMs: z.number().int().nullish(),
  error: z.string().nullish(),
  workflowId: z.string().nullish(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ScanFindingGroupingType = z.infer<typeof ScanFindingGroupingSchema>;


// File: ProjectCodeIndex.schema.ts

export const ProjectCodeIndexSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryIntegrationId: z.string().nullish(),
  branch: z.string().default("main"),
  commitSha: z.string(),
  filesIndexed: z.number().int(),
  chunksCreated: z.number().int(),
  summariesCreated: z.number().int(),
  indexedFileCount: z.number().int().nullish(),
  totalFileCount: z.number().int().nullish(),
  indexedAt: z.date(),
  indexDurationMs: z.number().int().nullish(),
  status: CodeIndexStatusSchema.default("PENDING"),
  error: z.string().nullish(),
  lastFullIndexAt: z.date().nullish(),
  lastIncrementalAt: z.date().nullish(),
  fileManifest: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  redactionManifest: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  workflowId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectCodeIndexType = z.infer<typeof ProjectCodeIndexSchema>;


// File: CodeSymbol.schema.ts

export const CodeSymbolSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  type: z.string(),
  filePath: z.string(),
  lineStart: z.number().int(),
  lineEnd: z.number().int().nullish(),
  signature: z.string().nullish(),
  language: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type CodeSymbolType = z.infer<typeof CodeSymbolSchema>;


// File: AtlasAnalysis.schema.ts

export const AtlasAnalysisSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryIntegrationId: z.string().nullish(),
  provider: z.string(),
  repositoryUrl: z.string(),
  repositoryName: z.string().nullish(),
  branch: z.string().default("main"),
  status: AtlasStatusSchema.default("NOT_ANALYZED"),
  analyzedCommitSha: z.string().nullish(),
  analyzedCommitAt: z.date().nullish(),
  analyzedAt: z.date().nullish(),
  lastFullAnalysisAt: z.date().nullish(),
  lastIncrementalAt: z.date().nullish(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  filesAnalyzed: z.number().int(),
  fileManifest: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  techStack: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  publishedPackages: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  businessTour: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  businessSignature: z.string().nullish(),
  workflowId: z.string().nullish(),
  error: z.string().nullish(),
  analysisModel: z.string().nullish(),
  analysisDurationMs: z.number().int().nullish(),
  promptTokens: z.number().int().nullish(),
  completionTokens: z.number().int().nullish(),
  totalTokens: z.number().int().nullish(),
  costMicroUsd: z.number().int().nullish(),
  reasoning: z.string().nullish(),
  activeRunStatus: AtlasStatusSchema.nullish(),
  activeRunStartedAt: z.date().nullish(),
  appliedUserOverrides: z.boolean().default(true),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AtlasAnalysisType = z.infer<typeof AtlasAnalysisSchema>;


// File: AtlasParseCheckpoint.schema.ts

export const AtlasParseCheckpointSchema = z.object({
  id: z.string(),
  analysisId: z.string(),
  projectId: z.string(),
  commitSha: z.string(),
  path: z.string(),
  language: z.string(),
  namespace: z.string().nullish(),
  loc: z.number().int(),
  symbolCount: z.number().int(),
  contentHash: z.string(),
  contentPreview: z.string(),
  importSpecs: z.array(z.string()),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type AtlasParseCheckpointType = z.infer<typeof AtlasParseCheckpointSchema>;


// File: AtlasNode.schema.ts

export const AtlasNodeSchema = z.object({
  id: z.string(),
  analysisId: z.string(),
  projectId: z.string(),
  mode: AtlasGraphModeSchema,
  kind: AtlasNodeKindSchema,
  key: z.string(),
  label: z.string(),
  filePath: z.string().nullish(),
  language: z.string().nullish(),
  parentKey: z.string().nullish(),
  technicalDescription: z.string().nullish(),
  businessDescription: z.string().nullish(),
  category: z.string().nullish(),
  contentPreview: z.string().nullish(),
  documentation: z.string().nullish(),
  metrics: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  layout: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  contentHash: z.string().nullish(),
  qdrantPointId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AtlasNodeType = z.infer<typeof AtlasNodeSchema>;


// File: AtlasEdge.schema.ts

export const AtlasEdgeSchema = z.object({
  id: z.string(),
  analysisId: z.string(),
  projectId: z.string(),
  mode: AtlasGraphModeSchema,
  kind: AtlasEdgeKindSchema,
  sourceKey: z.string(),
  targetKey: z.string(),
  weight: z.number().int().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type AtlasEdgeType = z.infer<typeof AtlasEdgeSchema>;


// File: AtlasAnalysisRun.schema.ts

export const AtlasAnalysisRunSchema = z.object({
  id: z.string(),
  analysisId: z.string(),
  projectId: z.string(),
  triggeredByUserId: z.string().nullish(),
  mode: z.string(),
  status: AtlasRunStatusSchema.default("RUNNING"),
  branch: z.string().nullish(),
  commitSha: z.string().nullish(),
  commitAt: z.date().nullish(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  filesAnalyzed: z.number().int(),
  modulesDescribed: z.number().int(),
  model: z.string().nullish(),
  promptTokens: z.number().int().nullish(),
  completionTokens: z.number().int().nullish(),
  totalTokens: z.number().int().nullish(),
  costMicroUsd: z.number().int().nullish(),
  error: z.string().nullish(),
  startedAt: z.date(),
  completedAt: z.date().nullish(),
  durationMs: z.number().int().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
});

export type AtlasAnalysisRunType = z.infer<typeof AtlasAnalysisRunSchema>;


// File: AtlasConversation.schema.ts

export const AtlasConversationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryIntegrationId: z.string().nullish(),
  mode: AtlasGraphModeSchema.default("BUSINESS"),
  title: z.string().default("New conversation"),
  visibility: AtlasChatVisibilitySchema.default("PRIVATE"),
  messages: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  isSystemScope: z.boolean(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AtlasConversationType = z.infer<typeof AtlasConversationSchema>;


// File: AtlasNodeOverride.schema.ts

export const AtlasNodeOverrideSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryIntegrationId: z.string().nullish(),
  branch: z.string().default("main"),
  mode: AtlasGraphModeSchema,
  key: z.string(),
  userDescription: z.string().nullish(),
  userCategory: z.string().nullish(),
  updatedByUserId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AtlasNodeOverrideType = z.infer<typeof AtlasNodeOverrideSchema>;


// File: AtlasNodeOverrideHistory.schema.ts

export const AtlasNodeOverrideHistorySchema = z.object({
  id: z.string(),
  overrideId: z.string(),
  field: z.string(),
  oldValue: z.string().nullish(),
  newValue: z.string().nullish(),
  editedByUserId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type AtlasNodeOverrideHistoryType = z.infer<typeof AtlasNodeOverrideHistorySchema>;


// File: AtlasCrossEdge.schema.ts

export const AtlasCrossEdgeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  mode: AtlasGraphModeSchema,
  kind: AtlasCrossEdgeKindSchema,
  detection: AtlasCrossEdgeDetectionSchema,
  sourceAnalysisId: z.string(),
  sourceKey: z.string().nullish(),
  targetAnalysisId: z.string(),
  targetKey: z.string().nullish(),
  weight: z.number().int().nullish(),
  description: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type AtlasCrossEdgeType = z.infer<typeof AtlasCrossEdgeSchema>;


// File: AtlasCrossLink.schema.ts

export const AtlasCrossLinkSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: AtlasCrossLinkStatusSchema.default("PENDING"),
  signature: z.string().nullish(),
  repositoryIntegrationIds: z.array(z.string()),
  edgeCount: z.number().int(),
  model: z.string().nullish(),
  totalTokens: z.number().int().nullish(),
  costMicroUsd: z.number().int().nullish(),
  error: z.string().nullish(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  durationMs: z.number().int().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AtlasCrossLinkType = z.infer<typeof AtlasCrossLinkSchema>;


// File: AtlasCrossLinkRun.schema.ts

export const AtlasCrossLinkRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  triggeredByUserId: z.string().nullish(),
  trigger: z.string(),
  status: AtlasRunStatusSchema.default("RUNNING"),
  repositoryIntegrationIds: z.array(z.string()),
  edgeCount: z.number().int(),
  model: z.string().nullish(),
  totalTokens: z.number().int().nullish(),
  costMicroUsd: z.number().int().nullish(),
  error: z.string().nullish(),
  startedAt: z.date(),
  completedAt: z.date().nullish(),
  durationMs: z.number().int().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type AtlasCrossLinkRunType = z.infer<typeof AtlasCrossLinkRunSchema>;


// File: AtlasSystemLayout.schema.ts

export const AtlasSystemLayoutSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  mode: AtlasGraphModeSchema,
  nodeId: z.string(),
  x: z.number(),
  y: z.number(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AtlasSystemLayoutType = z.infer<typeof AtlasSystemLayoutSchema>;


// File: AtlasEdgeOverride.schema.ts

export const AtlasEdgeOverrideSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branch: z.string().default("main"),
  mode: AtlasGraphModeSchema,
  sourceRepositoryIntegrationId: z.string().nullish(),
  sourceKey: z.string(),
  targetRepositoryIntegrationId: z.string().nullish(),
  targetKey: z.string(),
  kind: z.string(),
  userDescription: z.string().nullish(),
  isManual: z.boolean(),
  isCrossRepo: z.boolean(),
  isAiGenerated: z.boolean(),
  isUserKind: z.boolean(),
  deletedAt: z.date().nullish(),
  updatedByUserId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AtlasEdgeOverrideType = z.infer<typeof AtlasEdgeOverrideSchema>;


// File: AtlasEdgeOverrideHistory.schema.ts

export const AtlasEdgeOverrideHistorySchema = z.object({
  id: z.string(),
  overrideId: z.string(),
  action: z.string(),
  oldValue: z.string().nullish(),
  newValue: z.string().nullish(),
  editedByUserId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type AtlasEdgeOverrideHistoryType = z.infer<typeof AtlasEdgeOverrideHistorySchema>;


// File: ProjectLinkedMeeting.schema.ts

export const ProjectLinkedMeetingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  joinUrl: z.string(),
  subject: z.string().nullish(),
  organizer: z.string().nullish(),
  includedInDigest: z.boolean().default(true),
  linkedAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectLinkedMeetingType = z.infer<typeof ProjectLinkedMeetingSchema>;


// File: ProjectMeetingTranscript.schema.ts

export const ProjectMeetingTranscriptSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  linkedMeetingId: z.string(),
  meetingId: z.string(),
  transcriptId: z.string(),
  meetingSubject: z.string().nullish(),
  meetingDate: z.date().nullish(),
  contextId: z.string().nullish(),
  summary: z.string().nullish(),
  keywords: z.array(z.string()),
  speakerNames: z.array(z.string()),
  contentLength: z.number().int().nullish(),
  wasSummarized: z.boolean(),
  extractedDecisions: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  dismissedDecisionIndexes: z.array(z.number().int()),
  extractedActionItems: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  extractedQuestions: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  insightsExtractedAt: z.date().nullish(),
  insightsVersion: z.number().int().nullish(),
  analysisStatus: MeetingTranscriptAnalysisStatusSchema.default("NOT_SCANNED"),
  analysisStartedAt: z.date().nullish(),
  analysisError: z.string().nullish(),
  analysisFailedAt: z.date().nullish(),
  analyzedAt: z.date().nullish(),
  analyzedProposalId: z.string().nullish(),
  actionItemsLinkedAt: z.date().nullish(),
  actionItemsLinkVersion: z.number().int().nullish(),
  syncedAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectMeetingTranscriptType = z.infer<typeof ProjectMeetingTranscriptSchema>;


// File: ProjectMeetingActionItem.schema.ts

export const ProjectMeetingActionItemSchema = z.object({
  id: z.string(),
  transcriptId: z.string(),
  orderIndex: z.number().int(),
  text: z.string(),
  tentativeOwnerName: z.string().nullish(),
  dueHint: z.string().nullish(),
  completedAt: z.date().nullish(),
  completedById: z.string().nullish(),
  sourceQuote: z.string().nullish(),
  anchorLine: z.number().int().nullish(),
  createdAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectMeetingActionItemType = z.infer<typeof ProjectMeetingActionItemSchema>;


// File: MeetingActionItemLink.schema.ts

export const MeetingActionItemLinkSchema = z.object({
  id: z.string(),
  transcriptId: z.string(),
  projectId: z.string(),
  itemKey: z.string(),
  itemTextSnapshot: z.string(),
  storyId: z.string(),
  origin: MeetingActionItemLinkOriginSchema,
  status: MeetingActionItemLinkStatusSchema.default("ACTIVE"),
  similarity: z.number().nullish(),
  confidence: z.number().nullish(),
  reasoning: z.string().nullish(),
  createdById: z.string().nullish(),
  createdAt: z.date(),
  dismissedAt: z.date().nullish(),
  dismissedById: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type MeetingActionItemLinkType = z.infer<typeof MeetingActionItemLinkSchema>;


// File: ProjectMeetingAgenda.schema.ts

export const ProjectMeetingAgendaSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  linkedMeetingId: z.string(),
  occurrenceStart: z.date(),
  status: MeetingAgendaStatusSchema.default("GENERATING"),
  content: z.string().nullish(),
  generatedStructure: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  contextStats: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  promptProvenance: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  generatedAt: z.date().nullish(),
  generationError: z.string().nullish(),
  temporalWorkflowId: z.string().nullish(),
  editedAt: z.date().nullish(),
  editedById: z.string().nullish(),
  version: z.number().int().default(1),
  createdAt: z.date(),
  createdById: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectMeetingAgendaType = z.infer<typeof ProjectMeetingAgendaSchema>;


// File: ProjectSlackHuddleNote.schema.ts

export const ProjectSlackHuddleNoteSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  linkedChannelId: z.string(),
  canvasId: z.string(),
  channelId: z.string(),
  slackTeamId: z.string(),
  huddleTranscriptFileId: z.string().nullish(),
  huddleSummaryId: z.string().nullish(),
  huddleDateStart: z.date().nullish(),
  huddleDateEnd: z.date().nullish(),
  title: z.string().nullish(),
  contextId: z.string().nullish(),
  contentHash: z.string().nullish(),
  contentLength: z.number().int().nullish(),
  wasSummarized: z.boolean(),
  speakerNames: z.array(z.string()),
  syncedAt: z.date(),
  updatedAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectSlackHuddleNoteType = z.infer<typeof ProjectSlackHuddleNoteSchema>;


// File: ProjectLinkedTeamsChannel.schema.ts

export const ProjectLinkedTeamsChannelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  teamId: z.string(),
  channelId: z.string(),
  teamName: z.string().nullish(),
  channelName: z.string().nullish(),
  channelWebUrl: z.string().nullish(),
  linkedAt: z.date(),
  lastMessageCreatedAt: z.date().nullish(),
  lastMessageId: z.string().nullish(),
  scanPageToken: z.string().nullish(),
  consecutiveFailures: z.number().int(),
  lastErrorMessage: z.string().nullish(),
  lastErrorAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  tenantId: z.string().nullish(),
});

export type ProjectLinkedTeamsChannelType = z.infer<typeof ProjectLinkedTeamsChannelSchema>;


// File: ProjectLinkedTeamsChannelSeenMessage.schema.ts

export const ProjectLinkedTeamsChannelSeenMessageSchema = z.object({
  id: z.string(),
  linkedChannelId: z.string(),
  messageId: z.string(),
  createdAt: z.date(),
  pendingProposalId: z.string().nullish(),
});

export type ProjectLinkedTeamsChannelSeenMessageType = z.infer<typeof ProjectLinkedTeamsChannelSeenMessageSchema>;


// File: ProjectLinkedTeamsChat.schema.ts

export const ProjectLinkedTeamsChatSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  chatId: z.string(),
  chatTopic: z.string().nullish(),
  chatWebUrl: z.string().nullish(),
  linkedAt: z.date(),
  lastMessageCreatedAt: z.date().nullish(),
  lastMessageId: z.string().nullish(),
  scanPageToken: z.string().nullish(),
  consecutiveFailures: z.number().int(),
  lastErrorMessage: z.string().nullish(),
  lastErrorAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectLinkedTeamsChatType = z.infer<typeof ProjectLinkedTeamsChatSchema>;


// File: ProjectLinkedTeamsChatSeenMessage.schema.ts

export const ProjectLinkedTeamsChatSeenMessageSchema = z.object({
  id: z.string(),
  linkedChatId: z.string(),
  messageId: z.string(),
  createdAt: z.date(),
  pendingProposalId: z.string().nullish(),
});

export type ProjectLinkedTeamsChatSeenMessageType = z.infer<typeof ProjectLinkedTeamsChatSeenMessageSchema>;


// File: ProjectLinkedSlackChannel.schema.ts

export const ProjectLinkedSlackChannelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  slackTeamId: z.string(),
  channelId: z.string(),
  teamName: z.string().nullish(),
  channelName: z.string().nullish(),
  channelWebUrl: z.string().nullish(),
  linkedAt: z.date(),
  monitorEnabled: z.boolean(),
  monitorEnabledAt: z.date().nullish(),
  backfillCompleteAt: z.date().nullish(),
  lastMessageTs: z.string().nullish(),
  consecutiveFailures: z.number().int(),
  lastErrorMessage: z.string().nullish(),
  lastErrorAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectLinkedSlackChannelType = z.infer<typeof ProjectLinkedSlackChannelSchema>;


// File: ProjectLinkedSlackChannelSeenMessage.schema.ts

export const ProjectLinkedSlackChannelSeenMessageSchema = z.object({
  id: z.string(),
  linkedChannelId: z.string(),
  messageTs: z.string(),
  createdAt: z.date(),
  pendingProposalId: z.string().nullish(),
});

export type ProjectLinkedSlackChannelSeenMessageType = z.infer<typeof ProjectLinkedSlackChannelSeenMessageSchema>;


// File: PendingBacklogProposal.schema.ts

export const PendingBacklogProposalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  source: PendingBacklogProposalSourceSchema,
  status: PendingBacklogProposalStatusSchema.default("PENDING"),
  proposal: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  summary: z.string(),
  changeCount: z.number().int(),
  sourceMetadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  appliedChangeIndexes: z.array(z.number().int()),
  applyWorkflowId: z.string().nullish(),
  applyStartedAt: z.date().nullish(),
  applyError: z.string().nullish(),
  errorClass: z.string().nullish(),
  errorMessage: z.string().nullish(),
  failedAt: z.date().nullish(),
  createdAt: z.date(),
  reviewedAt: z.date().nullish(),
  reviewedBy: z.string().nullish(),
  appliedAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type PendingBacklogProposalType = z.infer<typeof PendingBacklogProposalSchema>;


// File: BacklogProposalDraft.schema.ts

export const BacklogProposalDraftSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  kind: StoryKindSchema,
  status: BacklogProposalDraftStatusSchema.default("RUNNING"),
  description: z.string().nullish(),
  acceptanceCriteria: z.string().nullish(),
  needsMoreInfo: z.boolean().nullish(),
  workflowId: z.string().nullish(),
  error: z.string().nullish(),
  startedAt: z.date(),
  completedAt: z.date().nullish(),
  createdBy: z.string().nullish(),
});

export type BacklogProposalDraftType = z.infer<typeof BacklogProposalDraftSchema>;


// File: BacklogUpdateSession.schema.ts

export const BacklogUpdateSessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  pendingProposalId: z.string().nullish(),
  conversationId: z.string().nullish(),
  source: z.string().default("AI_UPDATE_SIDEBAR"),
  status: BacklogUpdateSessionStatusSchema.default("APPLYING"),
  summary: z.string(),
  changes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  changeCount: z.number().int(),
  createCount: z.number().int(),
  updateCount: z.number().int(),
  messages: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  appliedCount: z.number().int(),
  failedCount: z.number().int(),
  syncedToPMCount: z.number().int(),
  errors: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  finalizedAt: z.date().nullish(),
  createdAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type BacklogUpdateSessionType = z.infer<typeof BacklogUpdateSessionSchema>;


// File: ProjectPresence.schema.ts

export const ProjectPresenceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  userName: z.string(),
  userImage: z.string().nullish(),
  lastSeenAt: z.date(),
  activeTab: z.string().nullish(),
  editingDocId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ProjectPresenceType = z.infer<typeof ProjectPresenceSchema>;


// File: ProjectActivity.schema.ts

export const ProjectActivitySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  userName: z.string(),
  activityType: z.string(),
  resourceType: z.string().nullish(),
  resourceId: z.string().nullish(),
  resourceName: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  organizationId: z.string().nullish(),
});

export type ProjectActivityType = z.infer<typeof ProjectActivitySchema>;


// File: AuditLog.schema.ts

export const AuditLogSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  actorType: z.string(),
  actorEmailSnapshot: z.string().nullish(),
  actorNameSnapshot: z.string().nullish(),
  impersonatedById: z.string().nullish(),
  action: z.string(),
  category: z.string(),
  severity: z.string(),
  outcome: z.string(),
  resourceType: z.string().nullish(),
  resourceId: z.string().nullish(),
  resourceName: z.string().nullish(),
  projectId: z.string().nullish(),
  ipAddress: z.string().nullish(),
  userAgent: z.string().nullish(),
  requestId: z.string().nullish(),
  sessionId: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  durationMs: z.number().int().nullish(),
  createdAt: z.date(),
});

export type AuditLogType = z.infer<typeof AuditLogSchema>;


// File: AuditLogSeal.schema.ts

export const AuditLogSealSchema = z.object({
  id: z.string(),
  sequence: z.number().int(),
  periodStart: z.date(),
  periodEnd: z.date(),
  rowCount: z.number().int(),
  contentHash: z.string(),
  prevSealHash: z.string().nullish(),
  sealHash: z.string(),
  signature: z.string(),
  keyId: z.string(),
  version: z.string(),
  createdAt: z.date(),
});

export type AuditLogSealType = z.infer<typeof AuditLogSealSchema>;


// File: PmSyncLog.schema.ts

export const PmSyncLogSchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  direction: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  title: z.string(),
  pmTool: z.string(),
  status: PmSyncLogStatusSchema,
  errorPayload: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  batchId: z.string().nullish(),
  actorUserId: z.string().nullish(),
  correlationId: z.string().nullish(),
  durationMs: z.number().int().nullish(),
  externalId: z.string().nullish(),
  externalUrl: z.string().nullish(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  projectId: z.string().nullish(),
});

export type PmSyncLogType = z.infer<typeof PmSyncLogSchema>;


// File: RequestSpan.schema.ts

export const RequestSpanSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  correlationId: z.string(),
  kind: z.string(),
  name: z.string(),
  startedAt: z.date(),
  durationMs: z.number().int().nullish(),
  status: z.string(),
  errorMessage: z.string().nullish(),
  attributes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
});

export type RequestSpanType = z.infer<typeof RequestSpanSchema>;


// File: ProjectUserPreference.schema.ts

export const ProjectUserPreferenceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  kanbanLocalRepoPath: z.string().nullish(),
  inviteWidgetDismissedAt: z.date().nullish(),
  inviteWidgetDismissedInviteExpiry: z.date().nullish(),
  roadmapView: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  roadmapStoryOrder: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  decisionsView: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  favoritedAt: z.date().nullish(),
  lastVisitedAt: z.date().nullish(),
  projectTabPrefs: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectUserPreferenceType = z.infer<typeof ProjectUserPreferenceSchema>;


// File: ProjectUserFunctionTag.schema.ts

export const ProjectUserFunctionTagSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  tags: z.array(FunctionTagSchema),
  confirmedAt: z.date().nullish(),
  confirmationVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectUserFunctionTagType = z.infer<typeof ProjectUserFunctionTagSchema>;


// File: DailyBrief.schema.ts

export const DailyBriefSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  generatedAt: z.date(),
  timeWindowStart: z.date(),
  timeWindowEnd: z.date(),
  timeWindowKind: z.string(),
  status: z.string(),
  content: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  errorMessage: z.string().nullish(),
  generatedByUserId: z.string(),
  temporalWorkflowId: z.string().nullish(),
  aiUsageTokens: z.number().int().nullish(),
});

export type DailyBriefType = z.infer<typeof DailyBriefSchema>;


// File: DailyBriefView.schema.ts

export const DailyBriefViewSchema = z.object({
  id: z.string(),
  dailyBriefId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  viewedAt: z.date(),
});

export type DailyBriefViewType = z.infer<typeof DailyBriefViewSchema>;


// File: NewsletterSettings.schema.ts

export const NewsletterSettingsSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  enabled: z.boolean(),
  cadence: z.string().default("WEEKLY"),
  dayOfWeek: z.number().int().default(1),
  dayOfMonth: z.number().int().default(1),
  sendHourUtc: z.number().int().default(9),
  lastSentAt: z.date().nullish(),
  lookbackDays: z.number().int().nullish(),
  detailLevel: z.string().default("STANDARD"),
  deliveryDestination: z.string().default("EMAIL"),
  chatChannels: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  approvalChatChannels: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  requireApproval: z.boolean(),
  publicWidgetEnabled: z.boolean(),
  publicEmbedToken: z.string().nullish(),
  publicEmbedTokenVersion: z.number().int().default(1),
  publicWidgetTheme: z.string().nullish(),
  publicWidgetAccent: z.string().nullish(),
  publicWidgetConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdByUserId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type NewsletterSettingsType = z.infer<typeof NewsletterSettingsSchema>;


// File: NewsletterSubscriber.schema.ts

export const NewsletterSubscriberSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  email: z.string(),
  name: z.string().nullish(),
  status: z.string().default("ACTIVE"),
  unsubscribeToken: z.string(),
  createdByUserId: z.string(),
  createdAt: z.date(),
  unsubscribedAt: z.date().nullish(),
  embedTokenVersion: z.number().int().nullish(),
});

export type NewsletterSubscriberType = z.infer<typeof NewsletterSubscriberSchema>;


// File: NewsletterSend.schema.ts

export const NewsletterSendSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  dedupeKey: z.string(),
  status: z.string(),
  skipReason: z.string().nullish(),
  trigger: z.string(),
  timeWindowStart: z.date(),
  timeWindowEnd: z.date(),
  recipientCount: z.number().int(),
  sentCount: z.number().int(),
  failedCount: z.number().int(),
  content: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  detailLevel: z.string().nullish(),
  deliveryDestination: z.string().nullish(),
  requireApproval: z.boolean(),
  chatChannels: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  reviewedByUserId: z.string().nullish(),
  reviewedAt: z.date().nullish(),
  rejectionReason: z.string().nullish(),
  removedHighlightIndexes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  aiUsageTokens: z.number().int().nullish(),
  temporalWorkflowId: z.string().nullish(),
  errorMessage: z.string().nullish(),
  triggeredByUserId: z.string().nullish(),
  createdAt: z.date(),
  completedAt: z.date().nullish(),
});

export type NewsletterSendType = z.infer<typeof NewsletterSendSchema>;


// File: NewsletterDelivery.schema.ts

export const NewsletterDeliverySchema = z.object({
  id: z.string(),
  sendId: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  recipientEmail: z.string(),
  status: z.string(),
  attemptCount: z.number().int(),
  errorMessage: z.string().nullish(),
  claimedAt: z.date(),
  sentAt: z.date().nullish(),
});

export type NewsletterDeliveryType = z.infer<typeof NewsletterDeliverySchema>;


// File: NewsletterChatDelivery.schema.ts

export const NewsletterChatDeliverySchema = z.object({
  id: z.string(),
  sendId: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  platform: z.string(),
  kind: z.string().default("CONTENT"),
  externalTeamId: z.string(),
  channelId: z.string(),
  status: z.string(),
  errorMessage: z.string().nullish(),
  postedMessageId: z.string().nullish(),
  createdAt: z.date(),
  deliveredAt: z.date().nullish(),
});

export type NewsletterChatDeliveryType = z.infer<typeof NewsletterChatDeliverySchema>;


// File: ProjectBriefCursor.schema.ts

export const ProjectBriefCursorSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  lastReviewedAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectBriefCursorType = z.infer<typeof ProjectBriefCursorSchema>;


// File: DailyBriefReleaseNoteExclusion.schema.ts

export const DailyBriefReleaseNoteExclusionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string(),
  kind: z.string(),
  targetKey: z.string(),
  repoFullName: z.string().nullish(),
  prNumber: z.number().int().nullish(),
  storyIdentifier: z.string().nullish(),
  reason: z.string().nullish(),
  excludedByUserId: z.string(),
  createdAt: z.date(),
});

export type DailyBriefReleaseNoteExclusionType = z.infer<typeof DailyBriefReleaseNoteExclusionSchema>;


// File: ProjectMember.schema.ts

export const ProjectMemberSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  role: ProjectMemberRoleSchema.default("VIEWER"),
  invitedBy: z.string(),
  invitedAt: z.date(),
  acceptedAt: z.date().nullish(),
  expiresAt: z.date().nullish(),
});

export type ProjectMemberType = z.infer<typeof ProjectMemberSchema>;


// File: ProjectInvitation.schema.ts

export const ProjectInvitationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  email: z.string(),
  role: ProjectMemberRoleSchema.default("VIEWER"),
  status: ProjectInvitationStatusSchema.default("PENDING"),
  invitedBy: z.string(),
  message: z.string().nullish(),
  expiresAt: z.date(),
  createdAt: z.date(),
  respondedAt: z.date().nullish(),
});

export type ProjectInvitationType = z.infer<typeof ProjectInvitationSchema>;


// File: DocumentLock.schema.ts

export const DocumentLockSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  userId: z.string(),
  userName: z.string(),
  acquiredAt: z.date(),
  expiresAt: z.date(),
  lastHeartbeat: z.date(),
  organizationId: z.string().nullish(),
});

export type DocumentLockType = z.infer<typeof DocumentLockSchema>;


// File: ProjectStoryStatus.schema.ts

export const ProjectStoryStatusSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string(),
  order: z.number().int(),
  isDefault: z.boolean(),
  isFinal: z.boolean(),
  requiresApproval: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectStoryStatusType = z.infer<typeof ProjectStoryStatusSchema>;


// File: UserStory.schema.ts

export const UserStorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  statusId: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  acceptanceCriteria: z.string().nullish(),
  kind: StoryKindSchema.default("FEATURE"),
  priority: StoryPrioritySchema.default("P2_MEDIUM"),
  size: StorySizeSchema.nullish(),
  storyPoints: z.number().int().nullish(),
  order: z.number(),
  roadmapOrder: z.number(),
  priorityOrder: z.number().nullish(),
  priorityChangedAt: z.date().nullish(),
  priorityChangeReason: z.string().nullish(),
  labels: z.array(z.string()),
  createdById: z.string(),
  assigneeId: z.string().nullish(),
  externalId: z.string().nullish(),
  externalUrl: z.string().nullish(),
  externalMcpServerId: z.string().nullish(),
  pmAutoSyncEnabled: z.boolean(),
  lastSyncedStatusId: z.string().nullish(),
  pipelineExecutionId: z.string().nullish(),
  source: StorySourceSchema.default("MANUAL"),
  originTestCaseId: z.string().nullish(),
  bugFingerprint: z.string().nullish(),
  sourceMeetingTranscriptId: z.string().nullish(),
  createdFromProposalId: z.string().nullish(),
  aiGeneratedTitle: z.boolean(),
  titleSource: StoryTitleSourceSchema.nullish(),
  releaseNotes: z.string().nullish(),
  draftingStage: FeatureDraftingStageSchema.default("PLACEHOLDER"),
  draftingStageUpdatedAt: z.date().nullish(),
  maturationStatus: MaturationStatusSchema.nullish(),
  coverageOverrideReason: z.string().nullish(),
  coverageOverrideById: z.string().nullish(),
  coverageOverrideAt: z.date().nullish(),
  pmTicketTerminal: z.boolean(),
  pmTicketTerminalStatus: z.string().nullish(),
  pmAutoHidden: z.boolean(),
  version: z.number().int().default(1),
  needsMoreInfo: z.boolean(),
  blocked: z.boolean(),
  blockedReason: z.string().nullish(),
  reporterName: z.string().nullish(),
  reporterSource: ReporterSourceSchema.nullish(),
  reporterSourceUrl: z.string().nullish(),
  lastSyncedPmHash: z.string().nullish(),
  lastSyncedAt: z.date().nullish(),
  lastPmSyncStatus: PmSyncStatusSchema.nullish(),
  lastPmSyncError: z.string().nullish(),
  lastPmSyncAttemptAt: z.date().nullish(),
  mergedIntoStoryId: z.string().nullish(),
  lastEditedAt: z.date().nullish(),
  lastEditedByName: z.string().nullish(),
  lastEditedSource: LastEditSourceSchema.nullish(),
  summaryDigest: z.string().nullish(),
  workingNotesContent: z.string().nullish(),
  lastQuestionScanHash: z.string().nullish(),
  lastSummaryHash: z.string().nullish(),
  lastContextUpdateAt: z.date().nullish(),
  maturationV2OptedIn: z.boolean(),
  autoProposeAnswers: z.boolean().default(true),
  qaAnalysis: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  cleanSpecApprovalMode: MaturationApprovalModeSchema.nullish(),
  decisionLogApprovalMode: MaturationApprovalModeSchema.nullish(),
  summaryQuestionsApprovalMode: MaturationApprovalModeSchema.nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserStoryType = z.infer<typeof UserStorySchema>;


// File: StoryPriorityChange.schema.ts

export const StoryPriorityChangeSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  projectId: z.string(),
  fromPriority: StoryPrioritySchema.nullish(),
  toPriority: StoryPrioritySchema,
  source: PriorityChangeSourceSchema,
  reason: z.string().nullish(),
  actorId: z.string().nullish(),
  actorName: z.string().nullish(),
  createdAt: z.date(),
});

export type StoryPriorityChangeType = z.infer<typeof StoryPriorityChangeSchema>;


// File: StoryTag.schema.ts

export const StoryTagSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  value: z.string(),
  createdById: z.string().nullish(),
  createdAt: z.date(),
});

export type StoryTagType = z.infer<typeof StoryTagSchema>;


// File: StoryAttachment.schema.ts

export const StoryAttachmentSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  storageKey: z.string(),
  designation: StoryAttachmentDesignationSchema.default("LOCKED"),
  source: StoryAttachmentSourceSchema.default("FABRIC"),
  uploaderUserId: z.string().nullish(),
  sourceTool: z.string().nullish(),
  externalAttachmentId: z.string().nullish(),
  contentHash: z.string().nullish(),
  promotedAt: z.date().nullish(),
  externalAuthor: z.string().nullish(),
  externalCreatedAt: z.date().nullish(),
  missingStreak: z.number().int(),
  extractedText: z.string().nullish(),
  extractedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type StoryAttachmentType = z.infer<typeof StoryAttachmentSchema>;


// File: StoryAttachmentSyncIssue.schema.ts

export const StoryAttachmentSyncIssueSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  sourceTool: z.string(),
  filename: z.string(),
  reason: z.string(),
  detectedAt: z.date(),
});

export type StoryAttachmentSyncIssueType = z.infer<typeof StoryAttachmentSyncIssueSchema>;


// File: StoryDuplicateLink.schema.ts

export const StoryDuplicateLinkSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  storyAId: z.string(),
  storyBId: z.string(),
  similarity: z.number(),
  confidence: z.number(),
  reasoning: z.string().nullish(),
  status: DuplicateLinkStatusSchema.default("PENDING"),
  linkType: DuplicateLinkTypeSchema.default("DUPLICATE"),
  verifiedContentHashA: z.string().nullish(),
  verifiedContentHashB: z.string().nullish(),
  detectedAt: z.date(),
  resolvedAt: z.date().nullish(),
  resolvedById: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type StoryDuplicateLinkType = z.infer<typeof StoryDuplicateLinkSchema>;


// File: StoryDuplicateEmbedding.schema.ts

export const StoryDuplicateEmbeddingSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  projectId: z.string(),
  contentHash: z.string(),
  model: z.string(),
  embedding: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type StoryDuplicateEmbeddingType = z.infer<typeof StoryDuplicateEmbeddingSchema>;


// File: StoryRoutingEmbedding.schema.ts

export const StoryRoutingEmbeddingSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  projectId: z.string(),
  contentHash: z.string(),
  model: z.string(),
  embedding: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type StoryRoutingEmbeddingType = z.infer<typeof StoryRoutingEmbeddingSchema>;


// File: FeatureVersion.schema.ts

export const FeatureVersionSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  version: z.number().int(),
  description: z.string().nullish(),
  acceptanceCriteria: z.string().nullish(),
  draftingStage: FeatureDraftingStageSchema,
  changeDescription: z.string().nullish(),
  changedBy: z.string().nullish(),
  createdAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  summaryDigestSnapshot: z.string().nullish(),
  workingNotesSnapshot: z.string().nullish(),
  changeSummary: z.array(z.string()),
});

export type FeatureVersionType = z.infer<typeof FeatureVersionSchema>;


// File: StoryTask.schema.ts

export const StoryTaskSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  isCompleted: z.boolean(),
  order: z.number(),
  estimatedHours: z.number().nullish(),
  externalId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  assignedAgentId: z.string().nullish(),
  agentTaskId: z.string().nullish(),
  agentStatus: z.string().nullish(),
  agentStartedAt: z.date().nullish(),
  agentCompletedAt: z.date().nullish(),
  agentError: z.string().nullish(),
  repositoryUrl: z.string().nullish(),
  repositoryOwner: z.string().nullish(),
  repositoryName: z.string().nullish(),
  targetBranch: z.string().nullish(),
  artifactUrl: z.string().nullish(),
  artifactType: z.string().nullish(),
});

export type StoryTaskType = z.infer<typeof StoryTaskSchema>;


// File: UserStoryComment.schema.ts

export const UserStoryCommentSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  authorId: z.string(),
  authorType: ProjectCommentAuthorTypeSchema.default("USER"),
  content: z.string(),
  parentId: z.string().nullish(),
  sourceCommentId: z.string().nullish(),
  workflowId: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type UserStoryCommentType = z.infer<typeof UserStoryCommentSchema>;


// File: StoryTaskComment.schema.ts

export const StoryTaskCommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  authorId: z.string(),
  authorType: ProjectCommentAuthorTypeSchema.default("USER"),
  content: z.string(),
  parentId: z.string().nullish(),
  sourceCommentId: z.string().nullish(),
  workflowId: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type StoryTaskCommentType = z.infer<typeof StoryTaskCommentSchema>;


// File: DecisionLogEntry.schema.ts

export const DecisionLogEntrySchema = z.object({
  id: z.string(),
  userStoryId: z.string(),
  parentId: z.string().nullish(),
  authorType: DecisionAuthorTypeSchema,
  authorUserId: z.string().nullish(),
  status: DecisionStatusSchema.default("OPEN"),
  summary: z.string().nullish(),
  content: z.string().nullish(),
  impactedSection: z.string().nullish(),
  topic: z.string().nullish(),
  questionId: z.string().nullish(),
  source: DecisionSourceSchema.default("HUMAN"),
  decidedBy: z.string().nullish(),
  authorName: z.string().nullish(),
  sourceProvenance: z.string().nullish(),
  answerSource: AnswerSourceSchema.nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  organizationId: z.string().nullish(),
  userId: z.string(),
  deletedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DecisionLogEntryType = z.infer<typeof DecisionLogEntrySchema>;


// File: MaturationApprovalPreference.schema.ts

export const MaturationApprovalPreferenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  cleanSpecMode: MaturationApprovalModeSchema.default("AUTO_ACCEPT"),
  decisionLogMode: MaturationApprovalModeSchema.default("AUTO_ACCEPT"),
  summaryQuestionsMode: MaturationApprovalModeSchema.default("MANUAL"),
  autoAcceptAll: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type MaturationApprovalPreferenceType = z.infer<typeof MaturationApprovalPreferenceSchema>;


// File: ArchitectureDecision.schema.ts

export const ArchitectureDecisionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  identifier: z.string(),
  title: z.string(),
  contextProblem: z.string(),
  decision: z.string(),
  rationale: z.string(),
  decisionDrivers: z.string().nullish(),
  alternativesConsidered: z.string().nullish(),
  consequences: z.string().nullish(),
  status: ArchitectureDecisionStatusSchema.default("PROPOSED"),
  domain: z.string().nullish(),
  decisionDate: z.date(),
  participantUserIds: z.array(z.string()),
  participantsText: z.string().nullish(),
  supersededById: z.string().nullish(),
  relatedDecisionIds: z.array(z.string()),
  pinnedAt: z.date().nullish(),
  createdById: z.string(),
  lastEditedById: z.string().nullish(),
  currentVersion: z.number().int().default(1),
  vouchedAt: z.date().nullish(),
  vouchedById: z.string().nullish(),
  contextId: z.string().nullish(),
  sourceKind: z.string().nullish(),
  sourceMetadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  decisionTypeId: z.string().nullish(),
  ownerUserId: z.string().nullish(),
  duration: DecisionDurationSchema.nullish(),
  priorityFlagged: z.boolean(),
  priorityFlaggedAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type ArchitectureDecisionType = z.infer<typeof ArchitectureDecisionSchema>;


// File: ArchitectureDecisionComment.schema.ts

export const ArchitectureDecisionCommentSchema = z.object({
  id: z.string(),
  architectureDecisionId: z.string(),
  authorId: z.string(),
  authorType: ProjectCommentAuthorTypeSchema.default("USER"),
  content: z.string(),
  parentId: z.string().nullish(),
  decisionVersion: z.number().int().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type ArchitectureDecisionCommentType = z.infer<typeof ArchitectureDecisionCommentSchema>;


// File: ArchitectureDecisionVersion.schema.ts

export const ArchitectureDecisionVersionSchema = z.object({
  id: z.string(),
  architectureDecisionId: z.string(),
  version: z.number().int(),
  title: z.string(),
  contextProblem: z.string(),
  decision: z.string(),
  rationale: z.string(),
  decisionDrivers: z.string().nullish(),
  alternativesConsidered: z.string().nullish(),
  consequences: z.string().nullish(),
  status: ArchitectureDecisionStatusSchema,
  decisionDate: z.date(),
  participantUserIds: z.array(z.string()),
  participantsText: z.string().nullish(),
  decisionTypeId: z.string().nullish(),
  ownerUserId: z.string().nullish(),
  duration: DecisionDurationSchema.nullish(),
  priorityFlagged: z.boolean(),
  editedById: z.string(),
  editedByName: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type ArchitectureDecisionVersionType = z.infer<typeof ArchitectureDecisionVersionSchema>;


// File: DecisionType.schema.ts

export const DecisionTypeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  origin: DecisionTypeOriginSchema.default("HUMAN"),
  archivedAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DecisionTypeType = z.infer<typeof DecisionTypeSchema>;


// File: PublishingSuggestionCycle.schema.ts

export const PublishingSuggestionCycleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  status: PublishingCycleStatusSchema.default("GENERATING"),
  actorUserId: z.string(),
  triggeredByUserId: z.string().nullish(),
  startedAt: z.date(),
  completedAt: z.date().nullish(),
  executionTimeoutAt: z.date().nullish(),
  coveredThrough: z.date(),
  sourceCoverage: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  sourceFailures: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  preferencesHash: z.string().nullish(),
  temporalWorkflowId: z.string().nullish(),
  occurrenceKey: z.string().nullish(),
  error: z.string().nullish(),
  notificationOutcome: z.string().default("NOT_APPLICABLE"),
  notificationOutcomeVersion: z.number().int(),
  notificationOutcomeAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PublishingSuggestionCycleType = z.infer<typeof PublishingSuggestionCycleSchema>;


// File: PublishingTopic.schema.ts

export const PublishingTopicSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  cycleId: z.string().nullish(),
  title: z.string(),
  pitch: z.string().nullish(),
  status: PublishingTopicStatusSchema.default("SUGGESTION"),
  origin: PublishingTopicOriginSchema,
  createdById: z.string().nullish(),
  declineReason: z.string().nullish(),
  snoozedUntil: z.date().nullish(),
  snoozeReason: z.string().nullish(),
  publishedUrl: z.string().nullish(),
  provenance: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  suggestedPostTypes: z.array(PublishingTopicPostTypeSchema),
  contributorUserIds: z.array(z.string()),
  relevantFunctionTags: z.array(FunctionTagSchema),
  postTypeRecommendations: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  postTypesOverridden: z.boolean(),
  userPostTypes: z.array(PublishingTopicPostTypeSchema),
  angle: z.string().nullish(),
  subject: z.string().nullish(),
  subjectKey: z.string().nullish(),
  dedupeKey: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PublishingTopicType = z.infer<typeof PublishingTopicSchema>;


// File: PublishingTopicRead.schema.ts

export const PublishingTopicReadSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  userId: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  readAt: z.date(),
});

export type PublishingTopicReadType = z.infer<typeof PublishingTopicReadSchema>;


// File: PublishingSuiteSettings.schema.ts

export const PublishingSuiteSettingsSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  cadence: z.string().default("MANUAL"),
  lookbackDays: z.number().int().nullish(),
  notificationsEnabled: z.boolean().default(true),
  chatChannels: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  preferredThemes: z.array(z.string()),
  preferredPostTypes: z.array(PublishingTopicPostTypeSchema),
  strategicPriorities: z.string().nullish(),
  createdByUserId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PublishingSuiteSettingsType = z.infer<typeof PublishingSuiteSettingsSchema>;


// File: PublishingNotificationDelivery.schema.ts

export const PublishingNotificationDeliverySchema = z.object({
  id: z.string(),
  cycleId: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  recipientUserId: z.string(),
  channel: z.string(),
  status: z.string(),
  reason: z.string().nullish(),
  errorMessage: z.string().nullish(),
  createdAt: z.date(),
  claimedAt: z.date().nullish(),
  claimToken: z.string().nullish(),
  lastAttemptAt: z.date().nullish(),
  deliveredAt: z.date().nullish(),
  expiresAt: z.date().nullish(),
  attemptCount: z.number().int(),
});

export type PublishingNotificationDeliveryType = z.infer<typeof PublishingNotificationDeliverySchema>;


// File: PublishingChatDelivery.schema.ts

export const PublishingChatDeliverySchema = z.object({
  id: z.string(),
  cycleId: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  platform: z.string(),
  externalTeamId: z.string(),
  channelId: z.string(),
  status: z.string(),
  reason: z.string().nullish(),
  errorMessage: z.string().nullish(),
  postedMessageId: z.string().nullish(),
  createdAt: z.date(),
  deliveredAt: z.date().nullish(),
});

export type PublishingChatDeliveryType = z.infer<typeof PublishingChatDeliverySchema>;


// File: TestCase.schema.ts

export const TestCaseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  state: TestCaseStateSchema.default("DRAFT"),
  priority: TestCasePrioritySchema.default("MEDIUM"),
  ownerId: z.string().nullish(),
  tags: z.array(z.string()),
  automationStatus: AutomationStatusSchema.default("NOT_AUTOMATED"),
  order: z.number(),
  createdById: z.string(),
  automationRef: z.string().nullish(),
  automationFilePath: z.string().nullish(),
  automationExternalUrl: z.string().nullish(),
  playwrightScript: z.string().nullish(),
  coverageType: QaCoverageTypeSchema.nullish(),
  draftedFromSpecHash: z.string().nullish(),
  proposedSteps: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  proposedAt: z.date().nullish(),
  proposedFrom: TestCaseProposalSourceSchema.nullish(),
  currentResult: TestResultSchema.default("NOT_RUN"),
  lastRunAt: z.date().nullish(),
  lastRunSource: ResultSourceSchema.nullish(),
  lastRunByLabel: z.string().nullish(),
  externalId: z.string().nullish(),
  externalUrl: z.string().nullish(),
  externalMcpServerId: z.string().nullish(),
  pmAutoSyncEnabled: z.boolean(),
  lastSyncedPmHash: z.string().nullish(),
  lastSyncedAt: z.date().nullish(),
  lastPmSyncStatus: PmSyncStatusSchema.nullish(),
  lastPmSyncError: z.string().nullish(),
  lastPmSyncAttemptAt: z.date().nullish(),
  contextId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type TestCaseType = z.infer<typeof TestCaseSchema>;


// File: TestCaseStep.schema.ts

export const TestCaseStepSchema = z.object({
  id: z.string(),
  testCaseId: z.string(),
  order: z.number(),
  action: z.string(),
  expected: z.string(),
  data: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  sharedStepId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TestCaseStepType = z.infer<typeof TestCaseStepSchema>;


// File: TestPlan.schema.ts

export const TestPlanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  identifier: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  state: TestPlanStateSchema.default("ACTIVE"),
  order: z.number(),
  createdById: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type TestPlanType = z.infer<typeof TestPlanSchema>;


// File: TestPlanCase.schema.ts

export const TestPlanCaseSchema = z.object({
  id: z.string(),
  planId: z.string(),
  testCaseId: z.string(),
  order: z.number(),
  section: z.string().nullish(),
  createdAt: z.date(),
});

export type TestPlanCaseType = z.infer<typeof TestPlanCaseSchema>;


// File: TestCaseWorkItemLink.schema.ts

export const TestCaseWorkItemLinkSchema = z.object({
  id: z.string(),
  testCaseId: z.string(),
  userStoryId: z.string(),
  acceptanceCriterionRefs: z.array(z.string()),
  acceptanceCriterionRef: z.string().nullish(),
  linkType: z.string().default("TESTS"),
  createdAt: z.date(),
});

export type TestCaseWorkItemLinkType = z.infer<typeof TestCaseWorkItemLinkSchema>;


// File: TestResultEvent.schema.ts

export const TestResultEventSchema = z.object({
  id: z.string(),
  testCaseId: z.string(),
  result: TestResultSchema,
  source: ResultSourceSchema,
  occurredAt: z.date(),
  changedByUserId: z.string().nullish(),
  actorLabel: z.string().nullish(),
  testPlanId: z.string().nullish(),
  pipelineRunId: z.string().nullish(),
  externalRunRef: z.string().nullish(),
  externalRunUrl: z.string().nullish(),
  scriptRevisionId: z.string().nullish(),
  note: z.string().nullish(),
  createdAt: z.date(),
});

export type TestResultEventType = z.infer<typeof TestResultEventSchema>;


// File: TestPipelineRun.schema.ts

export const TestPipelineRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  provider: z.string(),
  externalRunId: z.string(),
  pipelineName: z.string().nullish(),
  branch: z.string().nullish(),
  commitSha: z.string().nullish(),
  runUrl: z.string().nullish(),
  status: z.string().nullish(),
  startedAt: z.date().nullish(),
  finishedAt: z.date().nullish(),
  durationMs: z.number().int().nullish(),
  totalCount: z.number().int(),
  passedCount: z.number().int(),
  failedCount: z.number().int(),
  skippedCount: z.number().int(),
  otherCount: z.number().int(),
  triggeredByActor: z.string().nullish(),
  triggeredByActorAvatarUrl: z.string().nullish(),
  results: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type TestPipelineRunType = z.infer<typeof TestPipelineRunSchema>;


// File: TestFinding.schema.ts

export const TestFindingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  fingerprint: z.string(),
  testName: z.string(),
  classname: z.string().nullish(),
  failureMessage: z.string().nullish(),
  status: TestFindingStatusSchema.default("OPEN"),
  occurrences: z.number().int().default(1),
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
  suspectedCause: z.string().nullish(),
  suspectedKind: TestFailureKindSchema.nullish(),
  analysedAt: z.date().nullish(),
  analysisModel: z.string().nullish(),
  analysisDiff: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  testCaseId: z.string().nullish(),
  lastPipelineRunId: z.string().nullish(),
  promotedStoryId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type TestFindingType = z.infer<typeof TestFindingSchema>;


// File: TestPipelineSyncState.schema.ts

export const TestPipelineSyncStateSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  provider: z.string(),
  pipelineKey: z.string(),
  lastRunExternalId: z.string().nullish(),
  lastCommitSha: z.string().nullish(),
  pageToken: z.string().nullish(),
  lastFetchedAt: z.date().nullish(),
  status: z.string().nullish(),
  lastError: z.string().nullish(),
  lastErrorDetail: z.string().nullish(),
  lastErrorKind: z.string().nullish(),
  lastErrorAt: z.date().nullish(),
  lastAttemptStartedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TestPipelineSyncStateType = z.infer<typeof TestPipelineSyncStateSchema>;


// File: TestAgenticRun.schema.ts

export const TestAgenticRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  status: AgenticRunStatusSchema.default("QUEUED"),
  runMode: QaRunModeSchema.default("MODE_A"),
  workflowId: z.string().nullish(),
  environmentId: z.string().nullish(),
  targetBaseUrl: z.string(),
  environmentType: ProjectEnvironmentTypeSchema,
  estimatedCostUsd: z.union([z.string().regex(/^-?\d+(\.\d+)?$/, { message: "Must be a valid decimal string" }), z.number()]),
  costCapUsd: z.union([z.string().regex(/^-?\d+(\.\d+)?$/, { message: "Must be a valid decimal string" }), z.number()]),
  actualCostUsd: z.union([z.string().regex(/^-?\d+(\.\d+)?$/, { message: "Must be a valid decimal string" }), z.number()]).nullish(),
  browser: z.string(),
  resolution: z.string(),
  caseCount: z.number().int(),
  passedCount: z.number().int(),
  failedCount: z.number().int(),
  blockedCount: z.number().int(),
  needsReviewCount: z.number().int(),
  refusalReason: z.string().nullish(),
  pipelineRunId: z.string().nullish(),
  triggeredByUserId: z.string().nullish(),
  startedAt: z.date().nullish(),
  finishedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TestAgenticRunType = z.infer<typeof TestAgenticRunSchema>;


// File: TestRunConfiguration.schema.ts

export const TestRunConfigurationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  runMode: QaRunModeSchema.default("MODE_A"),
  environmentId: z.string().nullish(),
  browser: z.string().nullish(),
  resolution: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TestRunConfigurationType = z.infer<typeof TestRunConfigurationSchema>;


// File: TestAgenticCaseResult.schema.ts

export const TestAgenticCaseResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  testCaseId: z.string(),
  result: z.string(),
  failureMessage: z.string().nullish(),
  durationMs: z.number().int(),
  modelCalls: z.number().int(),
  scriptRevisionId: z.string().nullish(),
  label: z.string().nullish(),
  steps: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  createdAt: z.date(),
});

export type TestAgenticCaseResultType = z.infer<typeof TestAgenticCaseResultSchema>;


// File: TestRunEvidence.schema.ts

export const TestRunEvidenceSchema = z.object({
  id: z.string(),
  bucket: z.string(),
  storageKey: z.string(),
  projectId: z.string(),
  runId: z.string(),
  testCaseId: z.string(),
  stepOrder: z.number().int(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  capturedAt: z.date(),
});

export type TestRunEvidenceType = z.infer<typeof TestRunEvidenceSchema>;


// File: TestAgenticStepLog.schema.ts

export const TestAgenticStepLogSchema = z.object({
  id: z.string(),
  testResultEventId: z.string(),
  order: z.number(),
  action: z.string(),
  expected: z.string(),
  status: AgenticStepStatusSchema,
  observation: z.string().nullish(),
  evidenceKey: z.string().nullish(),
  createdAt: z.date(),
});

export type TestAgenticStepLogType = z.infer<typeof TestAgenticStepLogSchema>;


// File: TestCaseScriptRevision.schema.ts

export const TestCaseScriptRevisionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  testCaseId: z.string(),
  script: z.string(),
  origin: TestCaseScriptRevisionOriginSchema,
  authoredByUserId: z.string().nullish(),
  authorNameSnapshot: z.string().nullish(),
  authorEmailSnapshot: z.string().nullish(),
  sourceResultEventId: z.string().nullish(),
  restoredFromRevisionId: z.string().nullish(),
  createdAt: z.date(),
});

export type TestCaseScriptRevisionType = z.infer<typeof TestCaseScriptRevisionSchema>;


// File: ProjectQaSettings.schema.ts

export const ProjectQaSettingsSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  strategyDepth: QaStrategyDepthSchema.default("AVERAGE"),
  requiredTestTypes: z.array(z.string()),
  confidenceThreshold: z.number().int().default(80),
  indexCoverageEnabled: z.boolean().default(true),
  coverageTarget: z.number().int().default(80),
  requiredQaSignOffs: z.number().int(),
  prReviewAutoReviewEnabled: z.boolean(),
  prReviewQaLensEnabled: z.boolean().default(true),
  prReviewArchitectureLensEnabled: z.boolean().default(true),
  architectureRules: z.string().nullish(),
  resolutions: z.array(z.string()),
  browsers: z.array(z.string()),
  rulesMarkdown: z.string().nullish(),
  implementationNotes: z.string().nullish(),
  evidencePolicy: QaEvidencePolicySchema.default("SCREENSHOT_REQUIRED"),
  evidenceRetentionDays: z.number().int().default(90),
  scepticRolesEnabled: z.boolean().default(true),
  scepticRoles: z.array(z.string()),
  pipelineSyncEnabled: z.boolean().default(true),
  pipelineSyncIntervalMinutes: z.number().int().default(15),
  defaultEnvironmentId: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectQaSettingsType = z.infer<typeof ProjectQaSettingsSchema>;


// File: PullRequestReview.schema.ts

export const PullRequestReviewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  integrationId: z.string(),
  provider: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  prNumber: z.number().int(),
  title: z.string(),
  authorLabel: z.string().nullish(),
  headSha: z.string(),
  baseSha: z.string(),
  prUrl: z.string().nullish(),
  diff: z.string().nullish(),
  diffTruncated: z.boolean(),
  changedFiles: z.number().int(),
  status: z.string().default("READ"),
  failureText: z.string().nullish(),
  requestedById: z.string(),
  postedCommentId: z.bigint().nullish(),
  qaAnalysedAt: z.date().nullish(),
  qaAnalysisModel: z.string().nullish(),
  architectureAnalysedAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PullRequestReviewType = z.infer<typeof PullRequestReviewSchema>;


// File: PullRequestReviewFinding.schema.ts

export const PullRequestReviewFindingSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  lens: z.string(),
  severity: z.string().default("MEDIUM"),
  title: z.string(),
  detail: z.string(),
  filePath: z.string().nullish(),
  line: z.number().int().nullish(),
  recommendation: z.string().nullish(),
  storyId: z.string().nullish(),
  criterionRef: z.string().nullish(),
  status: z.string().default("OPEN"),
  dismissalReason: z.string().nullish(),
  promotedStoryId: z.string().nullish(),
  model: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PullRequestReviewFindingType = z.infer<typeof PullRequestReviewFindingSchema>;


// File: PrReviewJudgement.schema.ts

export const PrReviewJudgementSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  lens: z.string(),
  fingerprint: z.string(),
  status: z.string(),
  dismissalReason: z.string().nullish(),
  judgedById: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PrReviewJudgementType = z.infer<typeof PrReviewJudgementSchema>;


// File: QaSignOff.schema.ts

export const QaSignOffSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userStoryId: z.string(),
  signedById: z.string(),
  signedByLabel: z.string(),
  note: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type QaSignOffType = z.infer<typeof QaSignOffSchema>;


// File: QaOpenQuestion.schema.ts

export const QaOpenQuestionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userStoryId: z.string().nullish(),
  question: z.string(),
  answer: z.string().nullish(),
  status: QaOpenQuestionStatusSchema.default("OPEN"),
  askedByLabel: z.string(),
  askedById: z.string().nullish(),
  answeredById: z.string().nullish(),
  answeredAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type QaOpenQuestionType = z.infer<typeof QaOpenQuestionSchema>;


// File: ProjectEnvironment.schema.ts

export const ProjectEnvironmentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: ProjectEnvironmentTypeSchema.default("STAGING"),
  name: z.string(),
  baseUrl: z.string(),
  signInUrl: z.string().nullish(),
  authKind: EnvironmentAuthKindSchema.default("NONE"),
  authUsername: z.string().nullish(),
  encryptedAuthSecret: z.string().nullish(),
  authHeaderName: z.string().nullish(),
  authUpdatedAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectEnvironmentModel = z.infer<typeof ProjectEnvironmentSchema>;

// File: ProjectQaWebhook.schema.ts

export const ProjectQaWebhookSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  encryptedSecret: z.string(),
  secretHint: z.string(),
  previousEncryptedSecret: z.string().nullish(),
  previousSecretRetiresAt: z.date().nullish(),
  expiresAt: z.date().nullish(),
  lastDeliveryAt: z.date().nullish(),
  deliveryCount: z.number().int(),
  lastError: z.string().nullish(),
  lastErrorAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectQaWebhookType = z.infer<typeof ProjectQaWebhookSchema>;


// File: ProjectQaWebhookDelivery.schema.ts

export const ProjectQaWebhookDeliverySchema = z.object({
  id: z.string(),
  webhookId: z.string(),
  provider: z.string(),
  deliveryId: z.string(),
  bodyDigest: z.string(),
  receivedAt: z.date(),
});

export type ProjectQaWebhookDeliveryType = z.infer<typeof ProjectQaWebhookDeliverySchema>;


// File: TestCaseActivity.schema.ts

export const TestCaseActivitySchema = z.object({
  id: z.string(),
  testCaseId: z.string(),
  type: TestCaseActivityTypeSchema,
  actorUserId: z.string().nullish(),
  actorLabel: z.string().nullish(),
  fromValue: z.string().nullish(),
  toValue: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  occurredAt: z.date(),
  createdAt: z.date(),
});

export type TestCaseActivityModel = z.infer<typeof TestCaseActivitySchema>;

// File: QaAnalysisVersion.schema.ts

export const QaAnalysisVersionSchema = z.object({
  id: z.string(),
  userStoryId: z.string(),
  projectId: z.string(),
  depth: z.string(),
  specHash: z.string(),
  content: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  generatedByUserId: z.string().nullish(),
  generatedAt: z.date(),
  createdAt: z.date(),
});

export type QaAnalysisVersionType = z.infer<typeof QaAnalysisVersionSchema>;


// File: TestCaseDraftJob.schema.ts

export const TestCaseDraftJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  requestedById: z.string(),
  status: TestCaseDraftJobStatusSchema.default("PENDING"),
  storyIds: z.array(z.string()),
  totalFeatures: z.number().int(),
  processedFeatures: z.number().int(),
  createdCaseIds: z.array(z.string()),
  featureOutcomes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  workflowId: z.string().nullish(),
  startedAt: z.date(),
  completedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TestCaseDraftJobType = z.infer<typeof TestCaseDraftJobSchema>;


// File: StorySubtask.schema.ts

export const StorySubtaskSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  isCompleted: z.boolean(),
  order: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type StorySubtaskType = z.infer<typeof StorySubtaskSchema>;


// File: TaskWorkflowPlan.schema.ts

export const TaskWorkflowPlanSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  status: z.string().default("planning"),
  temporalWorkflowId: z.string().nullish(),
  summary: z.string().nullish(),
  steps: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  currentStepIndex: z.number().int().nullish(),
  checkpointData: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  result: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TaskWorkflowPlanType = z.infer<typeof TaskWorkflowPlanSchema>;


// File: TaskWorkflowLog.schema.ts

export const TaskWorkflowLogSchema = z.object({
  id: z.string(),
  planId: z.string(),
  stepId: z.string().nullish(),
  timestamp: z.date(),
  level: z.string(),
  message: z.string(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
});

export type TaskWorkflowLogType = z.infer<typeof TaskWorkflowLogSchema>;


// File: MCPServer.schema.ts

export const MCPServerSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  defaultUrl: z.string().nullish(),
  command: z.string().nullish(),
  docsUrl: z.string().nullish(),
  transport: MCPTransportSchema.default("HTTP"),
  authMethods: z.array(MCPAuthTypeSchema),
  apiKeyMethod: MCPApiKeyMethodSchema.nullish(),
  oauthDiscoveryUrl: z.string().nullish(),
  oauthAuthorizationEndpoint: z.string().nullish(),
  oauthTokenEndpoint: z.string().nullish(),
  dcrRegistrationEndpoint: z.string().nullish(),
  isSystemProvided: z.boolean().default(true),
  isImplemented: z.boolean(),
  defaultEnabled: z.boolean(),
  eagerKeywords: z.array(z.string()),
  eagerToolName: z.string().nullish(),
  suppressOnEager: z.array(z.string()),
  iconUrl: z.string().nullish(),
  author: z.string().nullish(),
  repositoryUrl: z.string().nullish(),
  category: z.string().nullish(),
  tags: z.array(z.string()),
  createdById: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type MCPServerType = z.infer<typeof MCPServerSchema>;


// File: McpRegistryVersion.schema.ts

export const McpRegistryVersionSchema = z.object({
  id: z.number().int(),
  version: z.bigint().default(BigInt(1)),
  updatedAt: z.date(),
});

export type McpRegistryVersionType = z.infer<typeof McpRegistryVersionSchema>;


// File: MCPConfig.schema.ts

export const MCPConfigSchema = z.object({
  id: z.string(),
  mcpServerId: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  displayName: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  baseUrl: z.string().nullish(),
  commandArgs: z.array(z.string()),
  transport: MCPTransportSchema.nullish(),
  authType: MCPAuthTypeSchema,
  apiKeyMethod: MCPApiKeyMethodSchema.default("BEARER"),
  oauthClientId: z.string().nullish(),
  encryptedOauthClientSecret: z.string().nullish(),
  encryptedApiKey: z.string().nullish(),
  encryptedAccessToken: z.string().nullish(),
  accessTokenHash: z.string().nullish(),
  dcrRegistrationEndpoint: z.string().nullish(),
  dcrClientMetadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  dcrRegisteredAt: z.date().nullish(),
  encryptedRefreshToken: z.string().nullish(),
  tokenExpiresAt: z.date().nullish(),
  scopes: z.array(z.string()),
  enabled: z.boolean().default(true),
  isManagedDefault: z.boolean(),
  status: MCPStatusSchema.default("HEALTHY"),
  lastHealthCheckAt: z.date().nullish(),
  consecutiveFailures: z.number().int(),
  failoverUrl: z.string().nullish(),
  oauthMetadataCache: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  oauthMetadataCachedAt: z.date().nullish(),
  refreshFailureCount: z.number().int(),
  lastRefreshFailedAt: z.date().nullish(),
  lastRefreshError: z.string().nullish(),
  needsReauth: z.boolean(),
  encryptedAtlassianCloudAccessToken: z.string().nullish(),
  encryptedAtlassianCloudRefreshToken: z.string().nullish(),
  atlassianCloudTokenExpiresAt: z.date().nullish(),
  atlassianCloudSiteUrl: z.string().nullish(),
  atlassianCloudCloudId: z.string().nullish(),
  atlassianCloudAccessibleResources: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  atlassianCloudScopes: z.array(z.string()),
  atlassianCloudConnectedAt: z.date().nullish(),
  atlassianCloudRefreshFailureCount: z.number().int(),
  atlassianCloudLastRefreshFailedAt: z.date().nullish(),
  atlassianCloudLastRefreshError: z.string().nullish(),
  cachedTools: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  toolsCachedAt: z.date().nullish(),
  toolCount: z.number().int(),
  description: z.string().nullish(),
  domainKeywords: z.array(z.string()),
  exampleQueries: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type MCPConfigType = z.infer<typeof MCPConfigSchema>;


// File: MCPOAuthState.schema.ts

export const MCPOAuthStateSchema = z.object({
  id: z.string(),
  state: z.string(),
  mcpServerId: z.string(),
  configId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  codeVerifier: z.string().nullish(),
  redirectUri: z.string().nullish(),
  createdAt: z.date(),
  expiresAt: z.date(),
});

export type MCPOAuthStateType = z.infer<typeof MCPOAuthStateSchema>;


// File: MCPClientSession.schema.ts

export const MCPClientSessionSchema = z.object({
  id: z.string(),
  token: z.string(),
  configId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  expiresAt: z.date(),
});

export type MCPClientSessionType = z.infer<typeof MCPClientSessionSchema>;


// File: MCPToolConfig.schema.ts

export const MCPToolConfigSchema = z.object({
  id: z.string(),
  mcpConfigId: z.string(),
  toolName: z.string(),
  stakeLevel: StakeLevelSchema.default("MEDIUM"),
  isEnabled: z.boolean().default(true),
  customConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type MCPToolConfigType = z.infer<typeof MCPToolConfigSchema>;


// File: MCPToolApproval.schema.ts

export const MCPToolApprovalSchema = z.object({
  id: z.string(),
  toolConfigId: z.string(),
  instanceId: z.string(),
  targetHash: z.string(),
  targetDisplay: z.string().nullish(),
  approvedBy: z.string(),
  approvedAt: z.date(),
  expiresAt: z.date().nullish(),
});

export type MCPToolApprovalType = z.infer<typeof MCPToolApprovalSchema>;


// File: AuthoritySession.schema.ts

export const AuthoritySessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  runType: AuthorityRunTypeSchema,
  runId: z.string().nullish(),
  status: AuthoritySessionStatusSchema.default("PENDING"),
  requestedAt: z.date(),
  approvedAt: z.date().nullish(),
  expiresAt: z.date(),
  revokedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  requestedByAgentId: z.string().nullish(),
  approvalInstructions: z.string().nullish(),
});

export type AuthoritySessionType = z.infer<typeof AuthoritySessionSchema>;


// File: AuthorityGrant.schema.ts

export const AuthorityGrantSchema = z.object({
  id: z.string(),
  authoritySessionId: z.string(),
  kind: AuthorityGrantKindSchema.default("BROAD"),
  providerType: AuthorityProviderTypeSchema,
  providerKey: z.string(),
  providerRefId: z.string().nullish(),
  providerDisplayName: z.string().nullish(),
  accessLevel: AuthorityAccessLevelSchema,
  toolScope: z.array(z.string()),
  requestFingerprint: z.string().nullish(),
  status: AuthorityGrantStatusSchema.default("PENDING"),
  approvedBy: z.string().nullish(),
  approvedAt: z.date().nullish(),
  expiresAt: z.date(),
  consumedAt: z.date().nullish(),
  deniedAt: z.date().nullish(),
  denialReason: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
});

export type AuthorityGrantType = z.infer<typeof AuthorityGrantSchema>;


// File: Prompt.schema.ts

export const PromptSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  slug: z.string().nullish(),
  description: z.string().nullish(),
  scope: PromptScopeSchema,
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  forkedFromId: z.string().nullish(),
  format: PromptFormatSchema.default("PLAIN_TEXT"),
  promptType: PromptContentTypeSchema.default("TEXT"),
  structuredFormat: StructuredFormatSchema.nullish(),
  category: z.string().nullish(),
  tags: z.array(z.string()),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  mediaUrl: z.string().nullish(),
  isPublic: z.boolean(),
  isUnlisted: z.boolean(),
  isFeatured: z.boolean(),
  featuredAt: z.date().nullish(),
  forDevs: z.boolean(),
  usageCount: z.number().int(),
  viewCount: z.number().int(),
  voteCount: z.number().int(),
  lastUsedAt: z.date().nullish(),
  deletedAt: z.date().nullish(),
  createdBy: z.string(),
  updatedBy: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PromptType = z.infer<typeof PromptSchema>;


// File: PromptVersion.schema.ts

export const PromptVersionSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  version: z.number().int(),
  content: z.string(),
  variables: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  changeNote: z.string().nullish(),
  createdBy: z.string(),
  createdAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  scope: PromptScopeSchema.nullish(),
});

export type PromptVersionType = z.infer<typeof PromptVersionSchema>;


// File: PromptBinding.schema.ts

export const PromptBindingSchema = z.object({
  id: z.string(),
  targetType: PromptTargetTypeSchema,
  targetKey: z.string(),
  documentType: z.string(),
  storyKind: StoryKindSchema.nullish(),
  scope: PromptScopeSchema,
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  projectId: z.string().nullish(),
  promptVersionId: z.string(),
  isDefault: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PromptBindingType = z.infer<typeof PromptBindingSchema>;


// File: PromptVote.schema.ts

export const PromptVoteSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  userId: z.string(),
  createdAt: z.date(),
});

export type PromptVoteType = z.infer<typeof PromptVoteSchema>;


// File: PromptTag.schema.ts

export const PromptTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string().default("#6366f1"),
  description: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PromptTagType = z.infer<typeof PromptTagSchema>;


// File: PromptTagRelation.schema.ts

export const PromptTagRelationSchema = z.object({
  promptId: z.string(),
  tagId: z.string(),
});

export type PromptTagRelationType = z.infer<typeof PromptTagRelationSchema>;


// File: PromptComment.schema.ts

export const PromptCommentSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  authorId: z.string(),
  parentId: z.string().nullish(),
  content: z.string(),
  score: z.number().int(),
  flagged: z.boolean(),
  flaggedAt: z.date().nullish(),
  flaggedBy: z.string().nullish(),
  deletedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  organizationId: z.string().nullish(),
  scope: PromptScopeSchema.nullish(),
});

export type PromptCommentType = z.infer<typeof PromptCommentSchema>;


// File: PromptCommentVote.schema.ts

export const PromptCommentVoteSchema = z.object({
  userId: z.string(),
  commentId: z.string(),
  value: z.number().int(),
  createdAt: z.date(),
  organizationId: z.string().nullish(),
});

export type PromptCommentVoteType = z.infer<typeof PromptCommentVoteSchema>;


// File: PromptChangeRequest.schema.ts

export const PromptChangeRequestSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  authorId: z.string(),
  proposedTitle: z.string().nullish(),
  proposedContent: z.string(),
  originalTitle: z.string(),
  originalContent: z.string(),
  reason: z.string().nullish(),
  reviewNote: z.string().nullish(),
  status: PromptChangeRequestStatusSchema.default("PENDING"),
  createdAt: z.date(),
  updatedAt: z.date(),
  organizationId: z.string().nullish(),
  scope: PromptScopeSchema.nullish(),
});

export type PromptChangeRequestType = z.infer<typeof PromptChangeRequestSchema>;


// File: PromptNomination.schema.ts

export const PromptNominationSchema = z.object({
  id: z.string(),
  promptVersionId: z.string(),
  nominatedById: z.string(),
  targetScope: PromptScopeSchema,
  organizationId: z.string().nullish(),
  targets: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  changeSummary: z.string().nullish(),
  summaryDegraded: z.boolean(),
  status: PromptNominationStatusSchema.default("PENDING"),
  reviewedById: z.string().nullish(),
  reviewedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PromptNominationType = z.infer<typeof PromptNominationSchema>;


// File: PromptConnection.schema.ts

export const PromptConnectionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  label: z.string().nullish(),
  order: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
  organizationId: z.string().nullish(),
});

export type PromptConnectionType = z.infer<typeof PromptConnectionSchema>;


// File: DocumentType.schema.ts

export const DocumentTypeSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  icon: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DocumentTypeType = z.infer<typeof DocumentTypeSchema>;


// File: AzureAgentDeployment.schema.ts

export const AzureAgentDeploymentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  agentId: z.string().nullish(),
  azureAgentId: z.string(),
  azureProjectName: z.string(),
  displayName: z.string(),
  description: z.string().nullish(),
  framework: AgentFrameworkSchema,
  agentType: z.string(),
  instructions: z.string().nullish(),
  model: z.string().nullish(),
  tools: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  endpoint: z.string(),
  version: z.string(),
  status: DeploymentStatusSchema.default("PROVISIONING"),
  supportsAgUi: z.boolean().default(true),
  agUiVersion: z.string().nullish(),
  config: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deployedAt: z.date().nullish(),
});

export type AzureAgentDeploymentType = z.infer<typeof AzureAgentDeploymentSchema>;


// File: AzureAiModelDeployment.schema.ts

export const AzureAiModelDeploymentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  deploymentName: z.string(),
  modelName: z.string(),
  modelFamily: z.string(),
  publisher: z.string().nullish(),
  endpoint: z.string(),
  region: z.string(),
  sku: z.string().nullish(),
  capacity: z.number().int().nullish(),
  isDefault: z.boolean(),
  isModelRouter: z.boolean(),
  routingRules: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  status: DeploymentStatusSchema.default("PROVISIONING"),
  healthStatus: HealthStatusSchema.default("UNKNOWN"),
  lastHealthCheck: z.date().nullish(),
  tags: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AzureAiModelDeploymentType = z.infer<typeof AzureAiModelDeploymentSchema>;


// File: CloudProviderConfig.schema.ts

export const CloudProviderConfigSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  provider: AIProviderSchema,
  enabled: z.boolean().default(true),
  isDefault: z.boolean(),
  isEmbeddingProvider: z.boolean(),
  priority: z.number().int(),
  config: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  encryptedApiKey: z.string().nullish(),
  clientId: z.string().nullish(),
  encryptedClientSecret: z.string().nullish(),
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  tags: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  healthStatus: HealthStatusSchema.default("UNKNOWN"),
  lastHealthCheck: z.date().nullish(),
  lastUsedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type CloudProviderConfigType = z.infer<typeof CloudProviderConfigSchema>;


// File: ModelRouterConfig.schema.ts

export const ModelRouterConfigSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  strategy: z.string().default("cost"),
  enabled: z.boolean().default(true),
  rules: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  totalRequests: z.number().int(),
  totalCost: z.number(),
  avgLatency: z.number().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ModelRouterConfigType = z.infer<typeof ModelRouterConfigSchema>;


// File: UserCloudProviderConfig.schema.ts

export const UserCloudProviderConfigSchema = z.object({
  id: z.string(),
  userId: z.string(),
  provider: AIProviderSchema,
  enabled: z.boolean().default(true),
  isDefault: z.boolean(),
  isEmbeddingProvider: z.boolean(),
  priority: z.number().int(),
  config: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  encryptedApiKey: z.string().nullish(),
  clientId: z.string().nullish(),
  encryptedClientSecret: z.string().nullish(),
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  tags: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  healthStatus: HealthStatusSchema.default("UNKNOWN"),
  lastHealthCheck: z.date().nullish(),
  lastUsedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserCloudProviderConfigType = z.infer<typeof UserCloudProviderConfigSchema>;


// File: Workflow.schema.ts

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  status: WorkflowBuilderStatusSchema.default("DRAFT"),
  triggerType: WorkflowTriggerTypeSchema.default("MANUAL"),
  triggerConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  nodes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  edges: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  variables: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  settings: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  version: z.number().int().default(1),
  isTemplate: z.boolean(),
  templateId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  projectId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastRunAt: z.date().nullish(),
  publishedAt: z.date().nullish(),
  publishedBy: z.string().nullish(),
  publishedVersion: z.number().int().nullish(),
  webhookSecret: z.string().nullish(),
});

export type WorkflowType = z.infer<typeof WorkflowSchema>;


// File: WorkflowVersion.schema.ts

export const WorkflowVersionSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  version: z.number().int(),
  nodes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  edges: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  variables: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  settings: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  triggerConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  changelog: z.string().nullish(),
  isPublished: z.boolean(),
  publishedAt: z.date().nullish(),
  createdBy: z.string().nullish(),
  createdAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type WorkflowVersionType = z.infer<typeof WorkflowVersionSchema>;


// File: WorkflowExecution.schema.ts

export const WorkflowExecutionSchema = z.object({
  id: z.string(),
  workflowId: z.string().nullish(),
  version: z.number().int(),
  status: WorkflowExecutionStatusSchema.default("PENDING"),
  triggerType: WorkflowTriggerTypeSchema,
  triggerInput: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  output: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  startedAt: z.date(),
  completedAt: z.date().nullish(),
  duration: z.number().int().nullish(),
  temporalRunId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  pipelineId: z.string().nullish(),
});

export type WorkflowExecutionType = z.infer<typeof WorkflowExecutionSchema>;


// File: WorkflowExecutionLog.schema.ts

export const WorkflowExecutionLogSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  nodeId: z.string(),
  nodeName: z.string().nullish(),
  nodeType: z.string(),
  status: WorkflowNodeStatusSchema.default("PENDING"),
  input: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  output: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  startedAt: z.date(),
  completedAt: z.date().nullish(),
  duration: z.number().int().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type WorkflowExecutionLogType = z.infer<typeof WorkflowExecutionLogSchema>;


// File: WorkflowIntegration.schema.ts

export const WorkflowIntegrationSchema = z.object({
  id: z.string(),
  workflowId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  provider: WorkflowIntegrationProviderSchema,
  name: z.string(),
  credentials: z.string(),
  settings: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastUsedAt: z.date().nullish(),
});

export type WorkflowIntegrationType = z.infer<typeof WorkflowIntegrationSchema>;


// File: ProjectDatabricksKnowledgeBinding.schema.ts

export const ProjectDatabricksKnowledgeBindingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  integrationId: z.string(),
  allowedResources: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  isEnabled: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
  createdBy: z.string(),
});

export type ProjectDatabricksKnowledgeBindingType = z.infer<typeof ProjectDatabricksKnowledgeBindingSchema>;


// File: WorkflowApiKey.schema.ts

export const WorkflowApiKeySchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  name: z.string(),
  keyHash: z.string(),
  keyPrefix: z.string(),
  permissions: z.array(z.string()),
  expiresAt: z.date().nullish(),
  lastUsedAt: z.date().nullish(),
  usageCount: z.number().int(),
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  createdBy: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type WorkflowApiKeyType = z.infer<typeof WorkflowApiKeySchema>;


// File: BrowserTask.schema.ts

export const BrowserTaskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  status: BrowserTaskStatusSchema.default("PENDING"),
  sessionId: z.string().nullish(),
  url: z.string(),
  actions: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  extractors: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  result: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  screenshots: z.array(z.string()),
  error: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  workflowId: z.string().nullish(),
  runId: z.string().nullish(),
});

export type BrowserTaskType = z.infer<typeof BrowserTaskSchema>;


// File: AutomationTemplate.schema.ts

export const AutomationTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  workflowSteps: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  parameters: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  sourceTaskId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  isPublic: z.boolean(),
  version: z.number().int().default(1),
  category: z.string().nullish(),
  tags: z.array(z.string()),
  useCount: z.number().int(),
  lastUsedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AutomationTemplateType = z.infer<typeof AutomationTemplateSchema>;


// File: OpenAPIService.schema.ts

export const OpenAPIServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  specUrl: z.string(),
  baseUrl: z.string().nullish(),
  specVersion: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  specTitle: z.string().nullish(),
  specDescription: z.string().nullish(),
  specHash: z.string().nullish(),
  lastSyncedAt: z.date().nullish(),
  authType: OpenAPIAuthTypeSchema.default("NONE"),
  authLocation: OpenAPIAuthLocationSchema.nullish(),
  authKey: z.string().nullish(),
  encryptedAuthValue: z.string().nullish(),
  oauth2TokenUrl: z.string().nullish(),
  oauth2AuthorizationUrl: z.string().nullish(),
  oauth2ClientId: z.string().nullish(),
  encryptedOauth2Secret: z.string().nullish(),
  oauth2Scopes: z.array(z.string()),
  encryptedAccessToken: z.string().nullish(),
  encryptedRefreshToken: z.string().nullish(),
  tokenExpiresAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdById: z.string(),
  status: OpenAPIServiceStatusSchema.default("ACTIVE"),
  errorMessage: z.string().nullish(),
  toolCount: z.number().int(),
  category: z.string().nullish(),
  tags: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OpenAPIServiceType = z.infer<typeof OpenAPIServiceSchema>;


// File: OpenAPITool.schema.ts

export const OpenAPIToolSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  operationId: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  method: z.string(),
  path: z.string(),
  parametersSchema: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  requestBodySchema: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  responseSchema: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  pathParams: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  queryParams: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  headerParams: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  deprecated: z.boolean(),
  tags: z.array(z.string()),
  enabled: z.boolean().default(true),
  useCount: z.number().int(),
  lastUsedAt: z.date().nullish(),
  avgResponseTime: z.number(),
  errorRate: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OpenAPIToolType = z.infer<typeof OpenAPIToolSchema>;


// File: OpenAPIServiceConfig.schema.ts

export const OpenAPIServiceConfigSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  enabled: z.boolean().default(true),
  customBaseUrl: z.string().nullish(),
  customAuthType: OpenAPIAuthTypeSchema.nullish(),
  encryptedCustomAuthValue: z.string().nullish(),
  enabledToolIds: z.array(z.string()),
  disabledToolIds: z.array(z.string()),
  maxRequestsPerMinute: z.number().int().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OpenAPIServiceConfigType = z.infer<typeof OpenAPIServiceConfigSchema>;


// File: AgentWorkspaceFile.schema.ts

export const AgentWorkspaceFileSchema = z.object({
  id: z.string(),
  conversationId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  path: z.string(),
  name: z.string(),
  extension: z.string().nullish(),
  mimeType: z.string().nullish(),
  content: z.string(),
  size: z.number().int(),
  fileType: AgentFileTypeSchema.default("DOCUMENT"),
  version: z.number().int().default(1),
  previousVersionId: z.string().nullish(),
  status: AgentFileStatusSchema.default("DRAFT"),
  shareToken: z.string().nullish(),
  shareScope: FrameShareScopeSchema.default("PRIVATE"),
  isPublic: z.boolean(),
  sourceRunType: z.string().nullish(),
  sourceRunId: z.string().nullish(),
  authoritySessionId: z.string().nullish(),
  providerKeys: z.array(z.string()),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  description: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentWorkspaceFileType = z.infer<typeof AgentWorkspaceFileSchema>;


// File: FrameSharingGrant.schema.ts

export const FrameSharingGrantSchema = z.object({
  id: z.string(),
  frameId: z.string(),
  email: z.string().nullish(),
  invitedBy: z.string(),
  invitedAt: z.date(),
  lastAccessedAt: z.date().nullish(),
  accessCount: z.number().int(),
});

export type FrameSharingGrantType = z.infer<typeof FrameSharingGrantSchema>;


// File: FrameEditHistory.schema.ts

export const FrameEditHistorySchema = z.object({
  id: z.string(),
  frameId: z.string(),
  editType: z.string(),
  oldString: z.string().nullish(),
  newString: z.string().nullish(),
  contentSnapshot: z.string().nullish(),
  editedBy: z.string(),
  editedAt: z.date(),
  revertedToVersion: z.number().int().nullish(),
});

export type FrameEditHistoryType = z.infer<typeof FrameEditHistorySchema>;


// File: FrameTemplate.schema.ts

export const FrameTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  category: z.string(),
  content: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  variables: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  organizationId: z.string().nullish(),
  isSystem: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type FrameTemplateType = z.infer<typeof FrameTemplateSchema>;


// File: Workspace.schema.ts

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  type: WorkspaceTypeSchema.default("CUSTOM"),
  status: WorkspaceStatusSchema.default("ACTIVE"),
  documentLimit: z.number().int().default(20),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type WorkspaceModel = z.infer<typeof WorkspaceSchema>;

// File: WorkspaceDocument.schema.ts

export const WorkspaceDocumentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  filename: z.string(),
  originalFilename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  s3Bucket: z.string(),
  s3Path: z.string(),
  status: WorkspaceDocumentStatusSchema.default("PENDING"),
  processingError: z.string().nullish(),
  extractedText: z.string().nullish(),
  extractorUsed: z.string().nullish(),
  pageCount: z.number().int().nullish(),
  wordCount: z.number().int().nullish(),
  qdrantPointIds: z.array(z.string()),
  embeddedAt: z.date().nullish(),
  chunkCount: z.number().int(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  workflowId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  uploadedBy: z.string(),
});

export type WorkspaceDocumentType = z.infer<typeof WorkspaceDocumentSchema>;


// File: WorkspaceDocumentChunk.schema.ts

export const WorkspaceDocumentChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  content: z.string(),
  chunkIndex: z.number().int(),
  qdrantId: z.string().nullish(),
  startOffset: z.number().int().nullish(),
  endOffset: z.number().int().nullish(),
  pageNumber: z.number().int().nullish(),
  headings: z.array(z.string()),
});

export type WorkspaceDocumentChunkType = z.infer<typeof WorkspaceDocumentChunkSchema>;


// File: WorkspaceAdministrator.schema.ts

export const WorkspaceAdministratorSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  addedBy: z.string(),
  addedAt: z.date(),
});

export type WorkspaceAdministratorType = z.infer<typeof WorkspaceAdministratorSchema>;


// File: WorkspaceContributor.schema.ts

export const WorkspaceContributorSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  addedBy: z.string(),
  addedAt: z.date(),
});

export type WorkspaceContributorType = z.infer<typeof WorkspaceContributorSchema>;


// File: WorkspaceStakeholder.schema.ts

export const WorkspaceStakeholderSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  addedBy: z.string(),
  addedAt: z.date(),
});

export type WorkspaceStakeholderType = z.infer<typeof WorkspaceStakeholderSchema>;


// File: WorkspaceAgent.schema.ts

export const WorkspaceAgentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  addedBy: z.string(),
  addedAt: z.date(),
});

export type WorkspaceAgentType = z.infer<typeof WorkspaceAgentSchema>;


// File: WorkspaceConversation.schema.ts

export const WorkspaceConversationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  allowedDocumentIds: z.array(z.string()),
  accessLevel: WorkspaceAccessLevelSchema.default("READ"),
  attachedAt: z.date(),
  attachedBy: z.string(),
});

export type WorkspaceConversationType = z.infer<typeof WorkspaceConversationSchema>;


// File: ProjectConversation.schema.ts

export const ProjectConversationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  conversationId: z.string(),
  attachedAt: z.date(),
  attachedBy: z.string(),
});

export type ProjectConversationType = z.infer<typeof ProjectConversationSchema>;


// File: DocumentAssistantConversation.schema.ts

export const DocumentAssistantConversationSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  documentRefKind: DocumentRefKindSchema,
  documentRefId: z.string(),
  projectId: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string(),
  visibility: DocumentAssistantVisibilitySchema.default("SHARED"),
  visibilityLockedAt: z.date().nullish(),
  archivedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DocumentAssistantConversationType = z.infer<typeof DocumentAssistantConversationSchema>;


// File: WorkspaceRagSettings.schema.ts

export const WorkspaceRagSettingsSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  chunkSize: z.number().int().default(3000),
  chunkOverlap: z.number().int().default(500),
  splitMethod: ChunkSplitMethodSchema.default("DOCUMENT"),
  embeddingModel: EmbeddingModelSchema.default("TEXT_EMBEDDING_3_SMALL"),
  topK: z.number().int().default(5),
  similarityThreshold: z.number().default(0.5),
  enableReranking: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type WorkspaceRagSettingsType = z.infer<typeof WorkspaceRagSettingsSchema>;


// File: AiModel.schema.ts

export const AiModelSchema = z.object({
  id: z.string(),
  canonicalName: z.string(),
  displayName: z.string(),
  description: z.string().nullish(),
  family: z.string(),
  vendor: z.string(),
  capabilities: z.array(AiModelCapabilitySchema),
  contextWindow: z.number().int(),
  maxOutputTokens: z.number().int().nullish(),
  speedTier: SpeedTierSchema.default("BALANCED"),
  qualityTier: QualityTierSchema.default("STANDARD"),
  inputCostPer1M: z.number().nullish(),
  outputCostPer1M: z.number().nullish(),
  suitableForTasks: z.array(AiTaskTypeSchema),
  isActive: z.boolean().default(true),
  deprecatedAt: z.date().nullish(),
  replacementModelId: z.string().nullish(),
  releaseDate: z.date().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AiModelType = z.infer<typeof AiModelSchema>;


// File: AiModelProviderMapping.schema.ts

export const AiModelProviderMappingSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  provider: AIProviderSchema,
  providerModelId: z.string(),
  maxContextWindow: z.number().int().nullish(),
  supportedFeatures: z.array(z.string()),
  isAvailable: z.boolean().default(true),
  availabilityNote: z.string().nullish(),
  inputCostPer1M: z.number().nullish(),
  outputCostPer1M: z.number().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AiModelProviderMappingType = z.infer<typeof AiModelProviderMappingSchema>;


// File: AiTaskModelDefault.schema.ts

export const AiTaskModelDefaultSchema = z.object({
  id: z.string(),
  taskType: AiTaskTypeSchema,
  complexity: TaskComplexitySchema.default("MEDIUM"),
  modelId: z.string(),
  provider: AIProviderSchema.nullish(),
  priority: z.number().int(),
  requiresToolCalling: z.boolean(),
  minContextWindow: z.number().int().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AiTaskModelDefaultType = z.infer<typeof AiTaskModelDefaultSchema>;


// File: UserModelPreference.schema.ts

export const UserModelPreferenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  provider: AIProviderSchema,
  taskType: AiTaskTypeSchema,
  modelId: z.string(),
  customParameters: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserModelPreferenceType = z.infer<typeof UserModelPreferenceSchema>;


// File: UserOrchestratorPreferences.schema.ts

export const UserOrchestratorPreferencesSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  enabledMcpConfigIds: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  enabledAgentIds: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  enabledWorkspaceIds: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  trustConfiguration: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  autonomyLevel: AutonomyLevelSchema.default("BALANCED"),
  chatMode: z.string().default("orchestrator"),
  reasoningMode: z.string().default("balanced"),
  uiMode: z.string().default("simple"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserOrchestratorPreferencesType = z.infer<typeof UserOrchestratorPreferencesSchema>;


// File: UserChatAgentSelection.schema.ts

export const UserChatAgentSelectionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  version: z.number().int().default(1),
  selectedAgents: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserChatAgentSelectionType = z.infer<typeof UserChatAgentSelectionSchema>;


// File: NotificationPreference.schema.ts

export const NotificationPreferenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  mentions: z.boolean().default(true),
  replies: z.boolean().default(true),
  assignments: z.boolean().default(true),
  status: z.boolean().default(true),
  syncProject: z.boolean().default(true),
  aiAgent: z.boolean().default(true),
  publishingSuggestions: z.boolean().default(true),
  publishingEmails: z.boolean().default(true),
  reportEmails: z.boolean().default(true),
  reviewEmails: z.boolean().default(true),
  stackedCardStyle: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type NotificationPreferenceType = z.infer<typeof NotificationPreferenceSchema>;


// File: OrganizationModelPreference.schema.ts

export const OrganizationModelPreferenceSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  provider: AIProviderSchema,
  taskType: AiTaskTypeSchema,
  modelId: z.string(),
  customParameters: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrganizationModelPreferenceType = z.infer<typeof OrganizationModelPreferenceSchema>;


// File: AiProviderFallback.schema.ts

export const AiProviderFallbackSchema = z.object({
  id: z.string(),
  primaryProvider: AIProviderSchema,
  fallbackProvider: AIProviderSchema,
  priority: z.number().int(),
  taskTypes: z.array(AiTaskTypeSchema),
  triggerOnErrors: z.array(z.string()),
  cooldownSeconds: z.number().int().default(60),
  isActive: z.boolean().default(true),
  scope: z.string().default("SYSTEM"),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastTriggeredAt: z.date().nullish(),
  triggerCount: z.number().int(),
});

export type AiProviderFallbackType = z.infer<typeof AiProviderFallbackSchema>;


// File: ApprovalTemplate.schema.ts

export const ApprovalTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  criteria: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  behavior: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  scope: z.string().default("USER"),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  usageCount: z.number().int(),
  lastUsed: z.date().nullish(),
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ApprovalTemplateType = z.infer<typeof ApprovalTemplateSchema>;


// File: AiUsageLog.schema.ts

export const AiUsageLogSchema = z.object({
  id: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  projectId: z.string().nullish(),
  providerConfigId: z.string().nullish(),
  provider: AIProviderSchema,
  modelCanonicalName: z.string().nullish(),
  providerModelId: z.string(),
  taskType: AiTaskTypeSchema.nullish(),
  agentId: z.string().nullish(),
  conversationId: z.string().nullish(),
  featureKey: z.string().nullish(),
  promptVersionId: z.string().nullish(),
  jobType: z.string().nullish(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  totalTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  cacheCreationInputTokens: z.number().int(),
  reasoningTokens: z.number().int(),
  costCents: z.number().int(),
  costMicroUsd: z.number().int(),
  gatewayGenerationId: z.string().nullish(),
  costIsActual: z.boolean(),
  latencyMs: z.number().int(),
  billingCategory: AiUsageBillingCategorySchema.nullish(),
  billingCustomerId: z.string().nullish(),
  success: z.boolean().default(true),
  errorMessage: z.string().nullish(),
  createdAt: z.date(),
});

export type AiUsageLogType = z.infer<typeof AiUsageLogSchema>;


// File: AiUsageLimit.schema.ts

export const AiUsageLimitSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  projectId: z.string().nullish(),
  name: z.string().nullish(),
  providerConfigId: z.string().nullish(),
  modelCanonicalName: z.string().nullish(),
  taskType: AiTaskTypeSchema.nullish(),
  dimension: AiUsageLimitDimensionSchema,
  window: AiUsageLimitWindowSchema,
  maxValue: z.bigint(),
  enforcement: AiUsageLimitEnforcementSchema,
  bannerThresholdPercent: z.number().int().default(90),
  createdById: z.string(),
  archivedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AiUsageLimitType = z.infer<typeof AiUsageLimitSchema>;


// File: AiUsageLimitCounter.schema.ts

export const AiUsageLimitCounterSchema = z.object({
  id: z.string(),
  limitId: z.string(),
  windowStart: z.date(),
  usedTokens: z.bigint().default(BigInt(0)),
  usedMicroUsd: z.bigint().default(BigInt(0)),
  createdAt: z.date(),
  lastUpdatedAt: z.date(),
});

export type AiUsageLimitCounterType = z.infer<typeof AiUsageLimitCounterSchema>;


// File: ReportTemplate.schema.ts

export const ReportTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  templateType: ReportTemplateTypeSchema,
  category: z.string().nullish(),
  tags: z.array(z.string()),
  definition: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  parameters: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  outputFormat: ReportOutputFormatSchema.default("MARKDOWN"),
  connections: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  fabricConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  schedule: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  evidenceProjectId: z.string().nullish(),
  evidenceReportSlug: z.string().nullish(),
  evidenceConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  scope: ReportTemplateScopeSchema.default("USER"),
  isPublic: z.boolean(),
  version: z.number().int().default(1),
  useCount: z.number().int(),
  lastUsedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ReportTemplateModel = z.infer<typeof ReportTemplateSchema>;

// File: TemplateInstance.schema.ts

export const TemplateInstanceSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  sId: z.string(),
  version: z.number().int().default(1),
  status: TemplateInstanceStatusSchema.default("ACTIVE"),
  name: z.string(),
  description: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  connections: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  parameterDefaults: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  fabricConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  schedule: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  nextRunAt: z.date().nullish(),
  lastRunAt: z.date().nullish(),
  scheduleMode: ScheduleModeSchema.default("INHERITED"),
  isActive: z.boolean().default(true),
  runCount: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TemplateInstanceType = z.infer<typeof TemplateInstanceSchema>;


// File: TemplateInstanceExecution.schema.ts

export const TemplateInstanceExecutionSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  status: TemplateExecutionStatusSchema.default("PENDING"),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  duration: z.number().int().nullish(),
  parameters: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  fabricEnrichment: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  dataSources: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  workflowId: z.string().nullish(),
  runId: z.string().nullish(),
  error: z.string().nullish(),
  cancelledBy: z.string().nullish(),
  cancelledAt: z.date().nullish(),
  notificationEmittedAt: z.date().nullish(),
  emailSentAt: z.date().nullish(),
  mcpDiagnostics: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
});

export type TemplateInstanceExecutionType = z.infer<typeof TemplateInstanceExecutionSchema>;


// File: TemplateInstanceArtifact.schema.ts

export const TemplateInstanceArtifactSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  name: z.string(),
  description: z.string().nullish(),
  artifactType: ReportArtifactTypeSchema,
  s3Path: z.string().nullish(),
  s3Bucket: z.string().nullish(),
  mimeType: z.string(),
  size: z.number().int(),
  content: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  qdrantId: z.string().nullish(),
  embeddedAt: z.date().nullish(),
  chunkCount: z.number().int(),
  createdAt: z.date(),
});

export type TemplateInstanceArtifactType = z.infer<typeof TemplateInstanceArtifactSchema>;


// File: TemplateInstanceArtifactChunk.schema.ts

export const TemplateInstanceArtifactChunkSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  content: z.string(),
  chunkIndex: z.number().int(),
  qdrantId: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type TemplateInstanceArtifactChunkType = z.infer<typeof TemplateInstanceArtifactChunkSchema>;


// File: ReportExecution.schema.ts

export const ReportExecutionSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  status: ReportExecutionStatusSchema.default("PENDING"),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  duration: z.number().int().nullish(),
  parameters: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  dateRange: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  dataSources: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  workflowId: z.string().nullish(),
  runId: z.string().nullish(),
  error: z.string().nullish(),
  createdAt: z.date(),
});

export type ReportExecutionType = z.infer<typeof ReportExecutionSchema>;


// File: ReportArtifact.schema.ts

export const ReportArtifactSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  templateId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  name: z.string(),
  description: z.string().nullish(),
  artifactType: ReportArtifactTypeSchema,
  s3Path: z.string().nullish(),
  s3Bucket: z.string().nullish(),
  mimeType: z.string(),
  size: z.number().int(),
  content: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  qdrantId: z.string().nullish(),
  embeddedAt: z.date().nullish(),
  chunkCount: z.number().int(),
  evidenceEmbedUrl: z.string().nullish(),
  createdAt: z.date(),
});

export type ReportArtifactModel = z.infer<typeof ReportArtifactSchema>;

// File: ReportArtifactChunk.schema.ts

export const ReportArtifactChunkSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  content: z.string(),
  chunkIndex: z.number().int(),
  qdrantId: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type ReportArtifactChunkType = z.infer<typeof ReportArtifactChunkSchema>;


// File: TemplateInstanceArtifactEmailDelivery.schema.ts

export const TemplateInstanceArtifactEmailDeliverySchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  sendId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  recipientUserId: z.string().nullish(),
  recipientEmail: z.string(),
  messageBody: z.string().nullish(),
  status: ReportEmailDeliveryStatusSchema.default("SENT"),
  errorMessage: z.string().nullish(),
  sentAt: z.date(),
  createdAt: z.date(),
});

export type TemplateInstanceArtifactEmailDeliveryType = z.infer<typeof TemplateInstanceArtifactEmailDeliverySchema>;


// File: AgentTemplate.schema.ts

export const AgentTemplateSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  category: AgentTemplateCategorySchema,
  tags: z.array(z.string()),
  instructions: z.string(),
  suggestedModel: z.string().nullish(),
  modelConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  promptBindingId: z.string().nullish(),
  documentType: ProjectDocumentTypeSchema.nullish(),
  scope: AgentTemplateScopeSchema.default("SYSTEM"),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  isPublished: z.boolean().default(true),
  isFeatured: z.boolean(),
  useCount: z.number().int(),
  lastUsedAt: z.date().nullish(),
  version: z.number().int().default(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentTemplateType = z.infer<typeof AgentTemplateSchema>;


// File: AgentTemplateInstance.schema.ts

export const AgentTemplateInstanceSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  sId: z.string(),
  version: z.number().int().default(1),
  status: AgentInstanceStatusSchema.default("ACTIVE"),
  name: z.string(),
  description: z.string().nullish(),
  heroEmojis: z.array(z.string()),
  heroImageUrl: z.string().nullish(),
  customInstructions: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  toolConnections: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("{}"),
  triggers: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  modelOverride: z.string().nullish(),
  modelConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  workspaceIds: z.array(z.string()),
  executionMode: z.string().default("single_turn"),
  goal: z.string().nullish(),
  successCriteria: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  maxIterations: z.number().int().default(10),
  memoryAutoApprove: z.boolean(),
  runCount: z.number().int(),
  lastRunAt: z.date().nullish(),
  isApiExposed: z.boolean(),
  apiConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentTemplateInstanceType = z.infer<typeof AgentTemplateInstanceSchema>;


// File: AgentTemplateConversation.schema.ts

export const AgentTemplateConversationSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  instanceVersion: z.number().int().nullish(),
  title: z.string().nullish(),
  isPinned: z.boolean(),
  isArchived: z.boolean(),
  messages: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  context: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentTemplateConversationType = z.infer<typeof AgentTemplateConversationSchema>;


// File: AgentTemplateExecution.schema.ts

export const AgentTemplateExecutionSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  triggerType: z.string().nullish(),
  triggerData: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  status: AgentExecutionStatusSchema.default("PENDING"),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  duration: z.number().int().nullish(),
  input: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  output: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  workflowId: z.string().nullish(),
  runId: z.string().nullish(),
  createdAt: z.date(),
});

export type AgentTemplateExecutionType = z.infer<typeof AgentTemplateExecutionSchema>;


// File: AgentMCPServerConfiguration.schema.ts

export const AgentMCPServerConfigurationSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  mcpConfigId: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  integrationIds: z.array(z.string()),
  dataSourceIds: z.array(z.string()),
  tableIds: z.array(z.string()),
  childAgentId: z.string().nullish(),
  timeFrameDuration: z.number().int().nullish(),
  timeFrameUnit: z.string().nullish(),
  jsonSchema: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  authLevel: z.string().default("medium"),
  isEnabled: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentMCPServerConfigurationType = z.infer<typeof AgentMCPServerConfigurationSchema>;


// File: AgentIntegrationConfiguration.schema.ts

export const AgentIntegrationConfigurationSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  integrationId: z.string(),
  integrationType: z.string(),
  allowedResources: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  timeFrameDuration: z.number().int().nullish(),
  timeFrameUnit: z.string().nullish(),
  accessLevel: z.string().default("read"),
  isEnabled: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentIntegrationConfigurationType = z.infer<typeof AgentIntegrationConfigurationSchema>;


// File: AgentDeployment.schema.ts

export const AgentDeploymentSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  name: z.string(),
  slug: z.string(),
  status: AgentDeploymentStatusSchema.default("PENDING"),
  deployedAt: z.date().nullish(),
  pausedAt: z.date().nullish(),
  terminatedAt: z.date().nullish(),
  lastActiveAt: z.date().nullish(),
  supervisorWorkflowId: z.string().nullish(),
  supervisorRunId: z.string().nullish(),
  taskQueue: z.string().nullish(),
  healthStatus: AgentDeploymentHealthStatusSchema.default("UNKNOWN"),
  lastHealthCheck: z.date().nullish(),
  consecutiveFailures: z.number().int(),
  maxConcurrentExecutions: z.number().int().default(5),
  currentExecutions: z.number().int(),
  rateLimitPerMinute: z.number().int().default(60),
  rateLimitPerHour: z.number().int().default(500),
  activeTriggers: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  dailyExecutionLimit: z.number().int().nullish(),
  monthlyExecutionLimit: z.number().int().nullish(),
  dailyExecutionCount: z.number().int(),
  monthlyExecutionCount: z.number().int(),
  quotaResetAt: z.date().nullish(),
  version: z.number().int().default(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentDeploymentType = z.infer<typeof AgentDeploymentSchema>;


// File: AgentDeploymentExecution.schema.ts

export const AgentDeploymentExecutionSchema = z.object({
  id: z.string(),
  deploymentId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  executionId: z.string(),
  triggerType: z.string(),
  triggerId: z.string().nullish(),
  triggerData: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  status: DeploymentExecutionStatusSchema.default("PENDING"),
  queuedAt: z.date(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  duration: z.number().int().nullish(),
  priority: z.number().int().default(5),
  input: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  output: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  workflowId: z.string().nullish(),
  runId: z.string().nullish(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  totalCost: z.union([z.string().regex(/^-?\d+(\.\d+)?$/, { message: "Must be a valid decimal string" }), z.number()]).nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentDeploymentExecutionType = z.infer<typeof AgentDeploymentExecutionSchema>;


// File: AgentExecutionStep.schema.ts

export const AgentExecutionStepSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  stepNumber: z.number().int(),
  stepType: z.string(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  duration: z.number().int().nullish(),
  input: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  output: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  status: z.string().default("pending"),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type AgentExecutionStepType = z.infer<typeof AgentExecutionStepSchema>;


// File: AgentDeploymentTrigger.schema.ts

export const AgentDeploymentTriggerSchema = z.object({
  id: z.string(),
  deploymentId: z.string(),
  type: DeploymentTriggerTypeSchema,
  config: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  webhookSecret: z.string().nullish(),
  webhookUrl: z.string().nullish(),
  cronExpression: z.string().nullish(),
  timezone: z.string().nullish(),
  nextRunAt: z.date().nullish(),
  lastRunAt: z.date().nullish(),
  slackChannelId: z.string().nullish(),
  slackTeamId: z.string().nullish(),
  projectId: z.string().nullish(),
  isActive: z.boolean().default(true),
  totalExecutions: z.number().int(),
  lastExecutionId: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AgentDeploymentTriggerType = z.infer<typeof AgentDeploymentTriggerSchema>;


// File: SlackThreadMapping.schema.ts

export const SlackThreadMappingSchema = z.object({
  id: z.string(),
  slackTeamId: z.string(),
  slackChannelId: z.string(),
  slackThreadTs: z.string(),
  deploymentId: z.string(),
  triggerId: z.string().nullish(),
  workflowId: z.string().nullish(),
  conversationId: z.string().nullish(),
  status: z.string().default("active"),
  lastMessageTs: z.string().nullish(),
  timeoutAt: z.date().nullish(),
  contextJson: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SlackThreadMappingType = z.infer<typeof SlackThreadMappingSchema>;


// File: SlackEventReceipt.schema.ts

export const SlackEventReceiptSchema = z.object({
  id: z.string(),
  slackEventId: z.string(),
  slackTeamId: z.string(),
  slackChannelId: z.string().nullish(),
  slackMessageTs: z.string().nullish(),
  processedAt: z.date(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
});

export type SlackEventReceiptType = z.infer<typeof SlackEventReceiptSchema>;


// File: TeamsEventReceipt.schema.ts

export const TeamsEventReceiptSchema = z.object({
  id: z.string(),
  teamsEventId: z.string(),
  channelId: z.string(),
  teamId: z.string().nullish(),
  messageId: z.string(),
  receivedAt: z.date(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
});

export type TeamsEventReceiptType = z.infer<typeof TeamsEventReceiptSchema>;


// File: AgentDeploymentMetrics.schema.ts

export const AgentDeploymentMetricsSchema = z.object({
  id: z.string(),
  deploymentId: z.string(),
  windowStart: z.date(),
  windowEnd: z.date(),
  windowType: z.string(),
  totalExecutions: z.number().int(),
  successfulExecutions: z.number().int(),
  failedExecutions: z.number().int(),
  cancelledExecutions: z.number().int(),
  timedOutExecutions: z.number().int(),
  avgDurationMs: z.number().int().nullish(),
  p50DurationMs: z.number().int().nullish(),
  p95DurationMs: z.number().int().nullish(),
  p99DurationMs: z.number().int().nullish(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalCost: z.union([z.string().regex(/^-?\d+(\.\d+)?$/, { message: "Must be a valid decimal string" }), z.number()]).nullish(),
  executionsByTrigger: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("{}"),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type AgentDeploymentMetricsType = z.infer<typeof AgentDeploymentMetricsSchema>;


// File: TaskQueueShard.schema.ts

export const TaskQueueShardSchema = z.object({
  id: z.string(),
  queueName: z.string(),
  shardType: z.string(),
  organizationId: z.string().nullish(),
  currentDepth: z.number().int(),
  maxDepth: z.number().int().default(1000),
  activeWorkers: z.number().int(),
  targetWorkers: z.number().int().default(2),
  isHealthy: z.boolean().default(true),
  lastHealthCheck: z.date().nullish(),
  totalProcessed: z.number().int(),
  avgLatencyMs: z.number().int().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TaskQueueShardType = z.infer<typeof TaskQueueShardSchema>;


// File: OrganizationDeploymentQuota.schema.ts

export const OrganizationDeploymentQuotaSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  maxDeployments: z.number().int().default(10),
  maxConcurrentExecutions: z.number().int().default(50),
  dailyExecutionLimit: z.number().int().default(1000),
  monthlyExecutionLimit: z.number().int().default(20000),
  currentDeployments: z.number().int(),
  dailyExecutionCount: z.number().int(),
  monthlyExecutionCount: z.number().int(),
  dailyResetAt: z.date().nullish(),
  monthlyResetAt: z.date().nullish(),
  customLimits: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrganizationDeploymentQuotaType = z.infer<typeof OrganizationDeploymentQuotaSchema>;


// File: UserDeploymentQuota.schema.ts

export const UserDeploymentQuotaSchema = z.object({
  id: z.string(),
  userId: z.string(),
  maxDeployments: z.number().int().default(3),
  maxConcurrentExecutions: z.number().int().default(10),
  dailyExecutionLimit: z.number().int().default(100),
  monthlyExecutionLimit: z.number().int().default(2000),
  currentDeployments: z.number().int(),
  dailyExecutionCount: z.number().int(),
  monthlyExecutionCount: z.number().int(),
  dailyResetAt: z.date().nullish(),
  monthlyResetAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserDeploymentQuotaType = z.infer<typeof UserDeploymentQuotaSchema>;


// File: AgentMemoryFile.schema.ts

export const AgentMemoryFileSchema = z.object({
  id: z.string(),
  agentInstanceId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  path: z.string(),
  fileType: AgentMemoryFileTypeSchema,
  content: z.string(),
  contentHash: z.string(),
  version: z.number().int().default(1),
  isValid: z.boolean().default(true),
  validationError: z.string().nullish(),
  lastModifiedBy: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  sourceSkillId: z.string().nullish(),
  isEnabled: z.boolean().default(true),
});

export type AgentMemoryFileModel = z.infer<typeof AgentMemoryFileSchema>;

// File: AgentMemoryEdit.schema.ts

export const AgentMemoryEditSchema = z.object({
  id: z.string(),
  memoryFileId: z.string().nullish(),
  agentInstanceId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  operation: AgentMemoryEditOperationSchema,
  path: z.string(),
  oldContent: z.string().nullish(),
  newContent: z.string(),
  reason: z.string().nullish(),
  status: AgentMemoryEditStatusSchema.default("PENDING"),
  autoApproved: z.boolean(),
  approvedBy: z.string().nullish(),
  approvedAt: z.date().nullish(),
  rejectionReason: z.string().nullish(),
  createdAt: z.date(),
});

export type AgentMemoryEditType = z.infer<typeof AgentMemoryEditSchema>;


// File: Skill.schema.ts

export const SkillSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  category: z.string().nullish(),
  tags: z.array(z.string()),
  scope: AgentTemplateScopeSchema.default("SYSTEM"),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  version: z.number().int().default(1),
  isPublished: z.boolean().default(true),
  useCount: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SkillType = z.infer<typeof SkillSchema>;


// File: SkillFile.schema.ts

export const SkillFileSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  path: z.string(),
  contentType: z.string(),
  storageKey: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  version: z.number().int().default(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SkillFileType = z.infer<typeof SkillFileSchema>;


// File: AgentTemplateSkill.schema.ts

export const AgentTemplateSkillSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  skillId: z.string(),
  isRequired: z.boolean().default(true),
  sortOrder: z.number().int(),
  createdAt: z.date(),
});

export type AgentTemplateSkillType = z.infer<typeof AgentTemplateSkillSchema>;


// File: ReportTemplateSkill.schema.ts

export const ReportTemplateSkillSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  skillId: z.string(),
  isRequired: z.boolean().default(true),
  sortOrder: z.number().int(),
  createdAt: z.date(),
});

export type ReportTemplateSkillType = z.infer<typeof ReportTemplateSkillSchema>;


// File: OrchestratorMemoryPreferences.schema.ts

export const OrchestratorMemoryPreferencesSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  responseStyle: z.string().nullish(),
  verbosity: z.string().nullish(),
  codeLanguage: z.string().nullish(),
  timezone: z.string().nullish(),
  language: z.string().nullish(),
  preferences: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("{}"),
  recentProjectIds: z.array(z.string()),
  recentWorkspaceIds: z.array(z.string()),
  lastActiveAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrchestratorMemoryPreferencesType = z.infer<typeof OrchestratorMemoryPreferencesSchema>;


// File: EpisodicMemory.schema.ts

export const EpisodicMemorySchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  projectId: z.string().nullish(),
  workspaceId: z.string().nullish(),
  conversationId: z.string(),
  agentId: z.string().nullish(),
  title: z.string(),
  summary: z.string(),
  keyTopics: z.array(z.string()),
  userIntents: z.array(z.string()),
  outcome: z.string(),
  messageCount: z.number().int(),
  turnCount: z.number().int(),
  toolsUsed: z.array(z.string()),
  agentsUsed: z.array(z.string()),
  conversationStartedAt: z.date(),
  conversationEndedAt: z.date().nullish(),
  createdAt: z.date(),
  qdrantPointId: z.string().nullish(),
  qdrantCollection: z.string().nullish(),
});

export type EpisodicMemoryType = z.infer<typeof EpisodicMemorySchema>;


// File: GoldenReference.schema.ts

export const GoldenReferenceSchema = z.object({
  id: z.string(),
  documentType: ProjectDocumentTypeSchema,
  name: z.string(),
  description: z.string().nullish(),
  content: z.string(),
  projectContext: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  requiredSections: z.array(z.string()),
  keyPhrases: z.array(z.string()),
  qdrantPointId: z.string().nullish(),
  qdrantCollection: z.string().nullish(),
  version: z.number().int().default(1),
  isActive: z.boolean().default(true),
  scope: GoldenReferenceScopeSchema.default("SYSTEM"),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type GoldenReferenceType = z.infer<typeof GoldenReferenceSchema>;


// File: DocumentEval.schema.ts

export const DocumentEvalSchema = z.object({
  id: z.string(),
  projectDocumentId: z.string(),
  documentVersion: z.number().int(),
  goldenReferenceId: z.string().nullish(),
  overallScore: z.number(),
  passed: z.boolean(),
  threshold: z.number().default(70.0),
  structureScore: z.number(),
  coverageScore: z.number(),
  similarityScore: z.number(),
  qualityScore: z.number(),
  evalVersion: z.number().int().default(1),
  contentHash: z.string().nullish(),
  costUsd: z.number(),
  evalMode: z.string().default("hybrid"),
  llmProvider: z.string().nullish(),
  llmModel: z.string().nullish(),
  nlpDurationMs: z.number().int().nullish(),
  llmDurationMs: z.number().int().nullish(),
  nlpScores: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  llmScores: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  feedback: z.string().nullish(),
  suggestions: z.array(z.string()),
  missingSections: z.array(z.string()),
  missingPhrases: z.array(z.string()),
  workflowId: z.string().nullish(),
  executionTimeMs: z.number().int().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type DocumentEvalType = z.infer<typeof DocumentEvalSchema>;


// File: OrganizationEvalBudget.schema.ts

export const OrganizationEvalBudgetSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  monthlyBudgetUsd: z.number().default(100.0).nullish(),
  currentMonthUsd: z.number(),
  lastResetAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrganizationEvalBudgetType = z.infer<typeof OrganizationEvalBudgetSchema>;


// File: DocumentEvalMetric.schema.ts

export const DocumentEvalMetricSchema = z.object({
  id: z.string(),
  documentEvalId: z.string(),
  metricName: z.string(),
  category: z.string(),
  score: z.number(),
  weight: z.number().default(1.0),
  rawValue: z.number().nullish(),
  description: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
});

export type DocumentEvalMetricType = z.infer<typeof DocumentEvalMetricSchema>;


// File: OffloadedToolOutput.schema.ts

export const OffloadedToolOutputSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  fullOutput: z.string(),
  outputSizeBytes: z.number().int(),
  contentHash: z.string(),
  expiresAt: z.date().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
});

export type OffloadedToolOutputType = z.infer<typeof OffloadedToolOutputSchema>;


// File: DynamicAgentConfig.schema.ts

export const DynamicAgentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  scope: AgentScopeSchema.default("USER"),
  systemPrompt: z.string(),
  instructionSections: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  enabledToolIds: z.array(z.string()),
  workspaceIds: z.array(z.string()),
  connectorIds: z.array(z.string()),
  canDelegateToAgents: z.boolean(),
  delegatableAgentIds: z.array(z.string()),
  maxRecursionDepth: z.number().int().default(4),
  aiModel: z.string().nullish(),
  aiProvider: z.string().nullish(),
  temperature: z.number().nullish(),
  maxIterations: z.number().int().default(50),
  maxTokensPerTurn: z.number().int().default(8000),
  timeoutMs: z.number().int().default(1800000),
  version: z.number().int().default(1),
  versionNotes: z.string().nullish(),
  previousVersionId: z.string().nullish(),
  status: DynamicAgentStatusSchema.default("DRAFT"),
  createdAt: z.date(),
  updatedAt: z.date(),
  publishedAt: z.date().nullish(),
});

export type DynamicAgentConfigType = z.infer<typeof DynamicAgentConfigSchema>;


// File: DynamicAgentTrigger.schema.ts

export const DynamicAgentTriggerSchema = z.object({
  id: z.string(),
  agentConfigId: z.string(),
  type: DynamicAgentTriggerTypeSchema,
  name: z.string(),
  description: z.string().nullish(),
  isEnabled: z.boolean().default(true),
  schedule: z.string().nullish(),
  timezone: z.string().default("UTC").nullish(),
  webhookSecret: z.string().nullish(),
  eventType: z.string().nullish(),
  eventFilter: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  inputTemplate: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  lastTriggeredAt: z.date().nullish(),
  nextScheduledAt: z.date().nullish(),
  triggerCount: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DynamicAgentTriggerModel = z.infer<typeof DynamicAgentTriggerSchema>;

// File: DynamicAgentExecution.schema.ts

export const DynamicAgentExecutionSchema = z.object({
  id: z.string(),
  agentConfigId: z.string(),
  triggerId: z.string().nullish(),
  temporalWorkflowId: z.string().nullish(),
  temporalRunId: z.string().nullish(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  status: DynamicAgentExecutionStatusSchema.default("PENDING"),
  input: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  output: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  iterationCount: z.number().int(),
  totalTokensUsed: z.number().int(),
  totalToolCalls: z.number().int(),
  totalDelegations: z.number().int(),
  durationMs: z.number().int().nullish(),
  conversationHistory: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  toolOutputRefs: z.array(z.string()),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DynamicAgentExecutionType = z.infer<typeof DynamicAgentExecutionSchema>;


// File: DynamicAgentFavorite.schema.ts

export const DynamicAgentFavoriteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  agentConfigId: z.string(),
  createdAt: z.date(),
});

export type DynamicAgentFavoriteType = z.infer<typeof DynamicAgentFavoriteSchema>;


// File: DataConnection.schema.ts

export const DataConnectionSchema = z.object({
  id: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  provider: DataConnectionProviderSchema,
  name: z.string(),
  status: DataConnectionStatusSchema.default("PENDING"),
  credentialId: z.string().nullish(),
  externalWorkspaceId: z.string().nullish(),
  externalWorkspaceName: z.string().nullish(),
  accessToken: z.string().nullish(),
  refreshToken: z.string().nullish(),
  tokenExpiresAt: z.date().nullish(),
  credentials: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  config: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  lastSyncAt: z.date().nullish(),
  lastSyncError: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  createdBy: z.string(),
});

export type DataConnectionType = z.infer<typeof DataConnectionSchema>;


// File: DataConnectionCredential.schema.ts

export const DataConnectionCredentialSchema = z.object({
  id: z.string(),
  userId: z.string().nullish(),
  organizationId: z.string().nullish(),
  provider: DataConnectionProviderSchema,
  name: z.string(),
  credentialType: z.string().nullish(),
  encryptedPayload: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  createdBy: z.string(),
});

export type DataConnectionCredentialType = z.infer<typeof DataConnectionCredentialSchema>;


// File: ErrorRateIncident.schema.ts

export const ErrorRateIncidentSchema = z.object({
  id: z.string(),
  alertName: z.string(),
  severity: IncidentSeveritySchema,
  service: z.string(),
  feature: z.string(),
  errorClass: z.string().nullish(),
  status: IncidentStatusSchema.default("FIRING"),
  firedAt: z.date(),
  resolvedAt: z.date().nullish(),
  acknowledgedAt: z.date().nullish(),
  acknowledgedBy: z.string().nullish(),
  burnRate1h: z.number().nullish(),
  burnRate5m: z.number().nullish(),
  errorCount: z.number().int(),
  alertmanagerFingerprint: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ErrorRateIncidentType = z.infer<typeof ErrorRateIncidentSchema>;


// File: IntegrationIncident.schema.ts

export const IntegrationIncidentSchema = z.object({
  id: z.string(),
  providerKey: z.string(),
  providerName: z.string(),
  status: IncidentStatusSchema.default("FIRING"),
  severity: IncidentSeveritySchema,
  health: ProviderHealthStatusSchema,
  startedAt: z.date(),
  resolvedAt: z.date().nullish(),
  acknowledgedAt: z.date().nullish(),
  acknowledgedBy: z.string().nullish(),
  detectionMethod: IncidentDetectionMethodSchema,
  statusPageUrl: z.string().nullish(),
  statusPageIncidentId: z.string().nullish(),
  affectedComponents: z.array(z.string()),
  summary: z.string().nullish(),
  alertmanagerFingerprint: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type IntegrationIncidentType = z.infer<typeof IntegrationIncidentSchema>;


// File: ComponentIncident.schema.ts

export const ComponentIncidentSchema = z.object({
  id: z.string(),
  componentKey: z.string(),
  componentName: z.string(),
  status: IncidentStatusSchema.default("FIRING"),
  severity: IncidentSeveritySchema,
  firedAt: z.date(),
  resolvedAt: z.date().nullish(),
  acknowledgedAt: z.date().nullish(),
  acknowledgedBy: z.string().nullish(),
  autoResolved: z.boolean(),
  summary: z.string().nullish(),
  alertmanagerFingerprint: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ComponentIncidentType = z.infer<typeof ComponentIncidentSchema>;


// File: IncidentEvent.schema.ts

export const IncidentEventSchema = z.object({
  id: z.string(),
  errorRateIncidentId: z.string().nullish(),
  integrationIncidentId: z.string().nullish(),
  componentIncidentId: z.string().nullish(),
  eventType: IncidentEventTypeSchema,
  message: z.string().nullish(),
  payload: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  actorUserId: z.string().nullish(),
  createdAt: z.date(),
});

export type IncidentEventModel = z.infer<typeof IncidentEventSchema>;

// File: IntegrationProviderRegistry.schema.ts

export const IntegrationProviderRegistrySchema = z.object({
  id: z.string(),
  providerKey: z.string(),
  displayName: z.string(),
  currentHealth: ProviderHealthStatusSchema.default("UNKNOWN"),
  lastPolledAt: z.date().nullish(),
  lastIncidentId: z.string().nullish(),
  statusPageUrl: z.string().nullish(),
  statusPageApiUrl: z.string().nullish(),
  statusPagePolling: z.boolean().default(true),
  syntheticProbeEnabled: z.boolean(),
  syntheticProbeInterval: z.string().nullish(),
  breakerKey: z.string().nullish(),
  affectedFeatures: z.array(z.string()),
  dataConnectionProvider: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type IntegrationProviderRegistryType = z.infer<typeof IntegrationProviderRegistrySchema>;


// File: StatusUpdate.schema.ts

export const StatusUpdateSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  lifecycle: StatusUpdateLifecycleSchema.default("INVESTIGATING"),
  impact: StatusUpdateImpactSchema,
  affectedComponentKeys: z.array(z.string()),
  affectedProviderKeys: z.array(z.string()),
  startedAt: z.date(),
  resolvedAt: z.date().nullish(),
  scheduledFor: z.date().nullish(),
  componentIncidentId: z.string().nullish(),
  integrationIncidentId: z.string().nullish(),
  publishedByUserId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type StatusUpdateType = z.infer<typeof StatusUpdateSchema>;


// File: StatusUpdateRevision.schema.ts

export const StatusUpdateRevisionSchema = z.object({
  id: z.string(),
  statusUpdateId: z.string(),
  lifecycle: StatusUpdateLifecycleSchema,
  body: z.string(),
  authorUserId: z.string().nullish(),
  createdAt: z.date(),
});

export type StatusUpdateRevisionType = z.infer<typeof StatusUpdateRevisionSchema>;


// File: DataSyncJob.schema.ts

export const DataSyncJobSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  status: SyncJobStatusSchema.default("PENDING"),
  type: SyncJobTypeSchema.default("FULL"),
  totalItems: z.number().int().nullish(),
  processedItems: z.number().int(),
  failedItems: z.number().int(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  error: z.string().nullish(),
  stats: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  workflowId: z.string().nullish(),
  runId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DataSyncJobType = z.infer<typeof DataSyncJobSchema>;


// File: BackgroundJob.schema.ts

export const BackgroundJobSchema = z.object({
  id: z.string(),
  kind: BackgroundJobKindSchema,
  status: BackgroundJobStatusSchema.default("RUNNING"),
  title: z.string(),
  sourceType: z.string().nullish(),
  sourceId: z.string().nullish(),
  counts: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("{}"),
  steps: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default("[]"),
  error: z.string().nullish(),
  errorClass: z.string().nullish(),
  workflowId: z.string(),
  runId: z.string().nullish(),
  startedAt: z.date(),
  completedAt: z.date().nullish(),
  heartbeatAt: z.date(),
  projectId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type BackgroundJobType = z.infer<typeof BackgroundJobSchema>;


// File: SyncedResource.schema.ts

export const SyncedResourceSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  externalId: z.string(),
  externalPath: z.string().nullish(),
  resourceType: z.string(),
  title: z.string(),
  contentHash: z.string().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  workspaceId: z.string().nullish(),
  documentId: z.string().nullish(),
  lastSyncedAt: z.date().nullish(),
  syncStatus: ResourceSyncStatusSchema.default("PENDING"),
  syncError: z.string().nullish(),
  sizeBytes: z.number().int().nullish(),
  textLength: z.number().int().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SyncedResourceType = z.infer<typeof SyncedResourceSchema>;


// File: DataSyncSchedule.schema.ts

export const DataSyncScheduleSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  frequency: SyncFrequencySchema.default("HOURLY"),
  cronExpression: z.string().nullish(),
  isActive: z.boolean().default(true),
  lastRunAt: z.date().nullish(),
  nextRunAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DataSyncScheduleType = z.infer<typeof DataSyncScheduleSchema>;


// File: ExternalApiUsageLog.schema.ts

export const ExternalApiUsageLogSchema = z.object({
  id: z.string(),
  apiKeyType: z.string(),
  apiKeyId: z.string(),
  apiKeyPrefix: z.string(),
  instanceId: z.string().nullish(),
  deploymentId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  executionId: z.string().nullish(),
  endpoint: z.string(),
  method: z.string(),
  statusCode: z.number().int(),
  latencyMs: z.number().int().nullish(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  estimatedCost: z.union([z.string().regex(/^-?\d+(\.\d+)?$/, { message: "Must be a valid decimal string" }), z.number()]).nullish(),
  clientIp: z.string().nullish(),
  userAgent: z.string().nullish(),
  createdAt: z.date(),
});

export type ExternalApiUsageLogType = z.infer<typeof ExternalApiUsageLogSchema>;


// File: KanbanQueue.schema.ts

export const KanbanQueueSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  organizationId: z.string().nullish(),
  createdById: z.string(),
  status: KanbanQueueStatusSchema.default("PENDING"),
  context: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  queuedAt: z.date(),
  pulledAt: z.date().nullish(),
  completedAt: z.date().nullish(),
  branchName: z.string().nullish(),
});

export type KanbanQueueType = z.infer<typeof KanbanQueueSchema>;


// File: CodingRun.schema.ts

export const CodingRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  storyTaskId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  weaveExecutionId: z.string().nullish(),
  executionChannel: CodingRunExecutionChannelSchema.default("BACKGROUND_AGENTS"),
  provider: CodingRunProviderSchema.default("BACKGROUND_AGENTS"),
  providerSessionId: z.string().nullish(),
  providerMetadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  externalUrl: z.string().nullish(),
  externalStatus: z.string().nullish(),
  status: CodingRunStatusSchema.default("QUEUED"),
  repositoryUrl: z.string().nullish(),
  repositoryOwner: z.string().nullish(),
  repositoryName: z.string().nullish(),
  targetBranch: z.string().nullish(),
  workingDirectory: z.string().nullish(),
  pullRequestUrl: z.string().nullish(),
  pullRequestNumber: z.number().int().nullish(),
  pullRequestBranch: z.string().nullish(),
  promptText: z.string().nullish(),
  workflowId: z.string().nullish(),
  lastProviderEventAt: z.date().nullish(),
  startedAt: z.date().nullish(),
  lastError: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type CodingRunType = z.infer<typeof CodingRunSchema>;


// File: CodingRunEvent.schema.ts

export const CodingRunEventSchema = z.object({
  id: z.string(),
  codingRunId: z.string(),
  eventType: z.string(),
  providerEventId: z.string().nullish(),
  payloadJson: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
});

export type CodingRunEventType = z.infer<typeof CodingRunEventSchema>;


// File: Diagram.schema.ts

export const DiagramSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  elements: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  appState: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  checkpointId: z.string().nullish(),
  mcpConfigId: z.string().nullish(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  projectId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DiagramType = z.infer<typeof DiagramSchema>;


// File: ProjectRepositoryIntegration.schema.ts

export const ProjectRepositoryIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: RepositoryProviderSchema,
  authMethod: RepositoryAuthMethodSchema,
  repositoryUrl: z.string(),
  repositoryOwner: z.string(),
  repositoryName: z.string(),
  defaultBranch: z.string().default("main"),
  roleTag: z.string().nullish(),
  qaBranch: z.string().nullish(),
  pinnedBranches: z.array(z.string()),
  encryptedAccessToken: z.string().nullish(),
  encryptedRefreshToken: z.string().nullish(),
  tokenExpiresAt: z.date().nullish(),
  tokenScopes: z.array(z.string()),
  encryptedPat: z.string().nullish(),
  azureOrganization: z.string().nullish(),
  status: RepositoryIntegrationStatusSchema.default("ACTIVE"),
  lastHealthCheck: z.date().nullish(),
  lastError: z.string().nullish(),
  probeFailCount: z.number().int(),
  refreshTokenRejectedAt: z.date().nullish(),
  configuredByUserId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectRepositoryIntegrationType = z.infer<typeof ProjectRepositoryIntegrationSchema>;


// File: ProjectWeaveConfig.schema.ts

export const ProjectWeaveConfigSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  patternConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  shuttleConfig: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  requireReview: z.boolean().default(true),
  requireSecurityReview: z.boolean().default(true),
  autoExecuteSimple: z.boolean(),
  complexityThreshold: z.string().default("medium"),
  enabledSkills: z.array(z.string()),
  enabledMcpTools: z.array(z.string()),
  categoryRouting: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectWeaveConfigType = z.infer<typeof ProjectWeaveConfigSchema>;


// File: WeavePlan.schema.ts

export const WeavePlanSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  projectId: z.string(),
  userStoryId: z.string().nullish(),
  storyTaskId: z.string().nullish(),
  name: z.string(),
  description: z.string().nullish(),
  status: WeavePlanStatusSchema.default("DRAFT"),
  checkboxes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type WeavePlanType = z.infer<typeof WeavePlanSchema>;


// File: WeavePlanTemplate.schema.ts

export const WeavePlanTemplateSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  projectId: z.string().nullish(),
  name: z.string(),
  description: z.string().nullish(),
  category: z.string().nullish(),
  message: z.string().nullish(),
  checkboxes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  useCount: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type WeavePlanTemplateType = z.infer<typeof WeavePlanTemplateSchema>;


// File: WeaveExecution.schema.ts

export const WeaveExecutionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  planId: z.string(),
  projectId: z.string(),
  workflowId: z.string(),
  runId: z.string(),
  sandboxSessionId: z.string().nullish(),
  status: WeaveExecutionStatusSchema.default("PENDING"),
  currentStep: z.number().int(),
  checkboxes: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  artifacts: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  error: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
});

export type WeaveExecutionType = z.infer<typeof WeaveExecutionSchema>;


// File: ChatArtifact.schema.ts

export const ChatArtifactSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  conversationId: z.string().nullish(),
  instanceId: z.string().nullish(),
  projectId: z.string().nullish(),
  type: ChatArtifactTypeSchema,
  title: z.string(),
  description: z.string().nullish(),
  content: z.string().nullish(),
  mimeType: z.string().default("text/markdown"),
  s3Path: z.string().nullish(),
  s3Bucket: z.string().nullish(),
  fileSize: z.number().int().nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  version: z.number().int().default(1),
  parentId: z.string().nullish(),
  indexedAt: z.date().nullish(),
  qdrantId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ChatArtifactModel = z.infer<typeof ChatArtifactSchema>;

// File: Notification.schema.ts

export const NotificationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  type: NotificationTypeSchema,
  category: NotificationCategorySchema,
  title: z.string(),
  snippet: z.string().nullish(),
  link: z.string().nullish(),
  iconKey: z.string().nullish(),
  projectId: z.string().nullish(),
  storyId: z.string().nullish(),
  taskId: z.string().nullish(),
  commentId: z.string().nullish(),
  documentId: z.string().nullish(),
  actorUserId: z.string().nullish(),
  payload: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  readAt: z.date().nullish(),
  archivedAt: z.date().nullish(),
  dedupeKey: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type NotificationModel = z.infer<typeof NotificationSchema>;

// File: NotificationDeliveryPreference.schema.ts

export const NotificationDeliveryPreferenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  emailEnabled: z.boolean(),
  webhookEnabled: z.boolean(),
  encryptedWebhookUrl: z.string().nullish(),
  encryptedWebhookSecret: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type NotificationDeliveryPreferenceType = z.infer<typeof NotificationDeliveryPreferenceSchema>;


// File: Subscription.schema.ts

export const SubscriptionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string().nullish(),
  subjectType: SubscriptionSubjectTypeSchema,
  subjectId: z.string(),
  createdAt: z.date(),
});

export type SubscriptionType = z.infer<typeof SubscriptionSchema>;


// File: PendingPmStateChange.schema.ts

export const PendingPmStateChangeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  entityType: PmStateChangeEntityTypeSchema,
  entityId: z.string(),
  externalId: z.string(),
  previousState: z.string(),
  newState: z.string(),
  proposedAction: PendingPmStateChangeActionSchema,
  status: PendingPmStateChangeStatusSchema.default("PENDING"),
  detectedPmHash: z.string().nullish(),
  expectedExternalMcpServerId: z.string().nullish(),
  createdAt: z.date(),
  reviewedAt: z.date().nullish(),
  reviewedBy: z.string().nullish(),
});

export type PendingPmStateChangeType = z.infer<typeof PendingPmStateChangeSchema>;


// File: PmTicketMissingStreak.schema.ts

export const PmTicketMissingStreakSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  entityType: PmStateChangeEntityTypeSchema,
  entityId: z.string(),
  externalId: z.string(),
  missStreak: z.number().int(),
  firstMissingAt: z.date(),
  lastMissingAt: z.date(),
  lastCountedRunId: z.string().nullish(),
});

export type PmTicketMissingStreakType = z.infer<typeof PmTicketMissingStreakSchema>;


// File: FeatureFlagOverride.schema.ts

export const FeatureFlagOverrideSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  updatedAt: z.date(),
  updatedBy: z.string(),
});

export type FeatureFlagOverrideType = z.infer<typeof FeatureFlagOverrideSchema>;

