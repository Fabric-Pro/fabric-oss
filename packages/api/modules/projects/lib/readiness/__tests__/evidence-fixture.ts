/**
 * Shared evidence fixture for the readiness tests (Fizzy #2165).
 *
 * Lives outside the test files so both the registry and level suites can build
 * on the same baseline — a project where nothing at all has been set up.
 */

import type { ReadinessEvidence } from "../types";

/** Evidence for a project where every rule should detect incomplete. */
export function emptyEvidence(): ReadinessEvidence {
	return {
		phase: "DEVELOPMENT_EXECUTION",
		expectedDevelopmentStartDate: null,
		descriptionLength: 0,
		featureCount: 0,
		techStackCount: 0,
		indexedContext: {
			total: 0,
			meetingTranscripts: 0,
			knowledgeBaseLinks: 0,
			notionSources: 0,
		},
		chat: {
			slackConnected: false,
			teamsConnected: false,
			slackChannelMonitorEnabled: false,
			teamsChannelMonitorEnabled: false,
			teamsChatMonitorEnabled: false,
			transcriptAutoAnalyzeEnabled: false,
		},
		pm: {
			connected: false,
			autoPushEnabled: false,
			readOnlyMode: false,
			autoCloseEnabled: false,
			terminalStatusCount: 0,
		},
		code: {
			repositoryConnected: false,
			analysisCompleted: false,
			atlasAnalysisExists: false,
		},
		completeDocumentTypes: new Set<string>(),
		acceptedMemberCount: 0,
		roadmapItemCount: 0,
		successfulScanExists: false,
		newsletterEnabled: false,
	};
}

/**
 * Evidence for a project whose codebase is attached through the CURRENT
 * `ProjectRepositoryIntegration` path rather than the legacy `repositoryUrl`
 * column — the shape that was mis-detected as "not connected".
 */
export function evidenceWithRepositoryIntegration(): ReadinessEvidence {
	return {
		...emptyEvidence(),
		code: {
			repositoryConnected: true,
			analysisCompleted: true,
			atlasAnalysisExists: false,
		},
	};
}
