/**
 * Gathers everything the readiness rules are allowed to read (Fizzy #2165).
 *
 * The rules never query. They receive this bundle and nothing else, which keeps
 * the cost of 26 rules at zero extra round trips and makes each rule testable
 * against a plain object rather than a database.
 *
 * Six aggregate reads, not twenty-six: roughly half the rules resolve from
 * columns already on the project row, and the rest are grouped counts.
 */

import { db } from "@repo/database";
import type { ReadinessEvidence } from "./types";

/** Document statuses that mean the document is actually usable. */
const USABLE_DOCUMENT_STATUSES = ["COMPLETE", "REVIEW"] as const;

/**
 * Context sources only count once extraction has finished successfully — a
 * source that failed to extract has given the project nothing.
 */
const INDEXED = "COMPLETED" as const;

/**
 * The project's tenant columns, carried alongside the evidence so rows written
 * by the readiness procedures mirror their parent project's tenancy. Kept off
 * {@link ReadinessEvidence} deliberately — a detection rule has no business
 * seeing who owns the project.
 */
interface ProjectTenant {
	userId: string | null;
	organizationId: string | null;
}

export interface ReadinessEvidenceResult {
	evidence: ReadinessEvidence;
	tenant: ProjectTenant;
}

export async function gatherReadinessEvidence(
	projectId: string,
): Promise<ReadinessEvidenceResult | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			userId: true,
			organizationId: true,
			projectPhase: true,
			description: true,
			expectedDevelopmentStartDate: true,
			features: true,
			techStack: true,
			projectManagementMcpServerId: true,
			autoPushPmSync: true,
			readOnlyMode: true,
			pmAutoCloseEnabled: true,
			pmTerminalStatuses: true,
			teamsChannelMonitorEnabled: true,
			teamsChatMonitorEnabled: true,
			slackChannelMonitorEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: true,
			repositoryUrl: true,
			codeAnalysisStatus: true,
		},
	});
	if (!project) {
		return null;
	}

	const [
		contextGroups,
		knowledgeBaseLinkCount,
		documentGroups,
		acceptedMemberCount,
		roadmapItemCount,
		successfulScan,
		newsletter,
		atlasAnalysis,
		activeRepositoryIntegrations,
		completedCodeIndex,
	] = await Promise.all([
		// Indexed context sources, grouped by kind so one read serves four rules.
		db.projectContext.groupBy({
			by: ["type"],
			where: { projectId, extractionStatus: INDEXED },
			_count: { _all: true },
		}),
		// The Knowledge Base rule needs the category, not just the kind.
		db.projectContext.count({
			where: {
				projectId,
				type: "LINK",
				extractionStatus: INDEXED,
				knowledgeBaseSourceCategory: "KNOWLEDGE_BASE_WIKI",
			},
		}),
		// Only documents that are active AND usable. A row in GENERATING or
		// FAILED exists but has given the project nothing.
		db.projectDocument.groupBy({
			by: ["type"],
			where: {
				projectId,
				isActive: true,
				status: { in: [...USABLE_DOCUMENT_STATUSES] },
			},
			_count: { _all: true },
		}),
		// Pending invitations are not teammates yet.
		db.projectMember.count({
			where: { projectId, acceptedAt: { not: null } },
		}),
		db.userStory.count({ where: { projectId } }),
		db.projectScan.findFirst({
			where: { projectId, status: "COMPLETED" },
			select: { id: true },
		}),
		db.newsletterSettings.findUnique({
			where: { projectId },
			select: { enabled: true },
		}),
		db.atlasAnalysis.findFirst({
			where: { projectId },
			select: { id: true },
		}),
		// The CURRENT way a repository is attached. `Project.repositoryUrl` is the
		// legacy column and is null on projects connected through this path, so
		// reading only that reported "codebase not connected" on projects that
		// plainly had one — and silently hid Atlas, security and release notes,
		// which all depend on it.
		//
		// Only ACTIVE counts: a TOKEN_EXPIRED / ERROR / DISCONNECTED integration
		// is a codebase Fabric cannot currently read, which is what the item is
		// really asking about.
		db.projectRepositoryIntegration.count({
			where: { projectId, status: "ACTIVE" },
		}),
		// Whether the codebase has ever been indexed end to end.
		//
		// `Project.codeAnalysisStatus` is the legacy signal and is null on
		// projects indexed through this path — the same shape of mistake as the
		// legacy repository column beside it, and it was still reporting
		// "codebase not connected" after that one was fixed.
		//
		// Keyed on `lastFullIndexAt` rather than `status` deliberately: status
		// flips to INDEXING during every refresh, so a status check would make a
		// long-satisfied item blink back to incomplete each time the repository
		// re-indexes. A full index having completed once is the durable fact the
		// checklist is actually asking about.
		db.projectCodeIndex.findFirst({
			where: { projectId, lastFullIndexAt: { not: null } },
			select: { id: true },
		}),
	]);

	const contextCountByType = new Map<string, number>(
		contextGroups.map((row) => [row.type as string, row._count._all]),
	);
	const countOf = (type: string): number => contextCountByType.get(type) ?? 0;

	// "At least one context source" spans several kinds — an uploaded file, plain
	// text, a meeting transcript, or a connected integration all qualify.
	const totalContext =
		countOf("FILE") +
		countOf("TEXT") +
		countOf("LINK") +
		countOf("DOCUMENT") +
		countOf("SPREADSHEET") +
		countOf("IMAGE") +
		countOf("INTEGRATION") +
		countOf("MEETING_TRANSCRIPT") +
		countOf("API_SPEC");

	const evidence: ReadinessEvidence = {
		phase: project.projectPhase,
		expectedDevelopmentStartDate: project.expectedDevelopmentStartDate,
		descriptionLength: project.description?.trim().length ?? 0,

		featureCount: project.features.length,
		techStackCount: project.techStack.length,

		indexedContext: {
			total: totalContext,
			meetingTranscripts: countOf("MEETING_TRANSCRIPT"),
			knowledgeBaseLinks: knowledgeBaseLinkCount,
			// Notion only for v1 — see the wiki rule in the registry for why
			// Confluence cannot satisfy an "indexed successfully" clause today.
			notionSources: countOf("INTEGRATION"),
		},

		chat: {
			// A monitor can only be configured against a connected workspace, so
			// an enabled monitor is the signal that the app is connected.
			slackConnected: project.slackChannelMonitorEnabled,
			teamsConnected:
				project.teamsChannelMonitorEnabled ||
				project.teamsChatMonitorEnabled,
			slackChannelMonitorEnabled: project.slackChannelMonitorEnabled,
			teamsChannelMonitorEnabled: project.teamsChannelMonitorEnabled,
			teamsChatMonitorEnabled: project.teamsChatMonitorEnabled,
			transcriptAutoAnalyzeEnabled:
				project.meetingTranscriptAutoAnalyzeEnabled,
		},

		pm: {
			connected: project.projectManagementMcpServerId !== null,
			autoPushEnabled: project.autoPushPmSync,
			readOnlyMode: project.readOnlyMode,
			autoCloseEnabled: project.pmAutoCloseEnabled,
			terminalStatusCount: project.pmTerminalStatuses.length,
		},

		code: {
			// Either path counts. The legacy column stays in the check so older
			// projects that were connected before integrations existed do not
			// regress to "not connected".
			repositoryConnected:
				activeRepositoryIntegrations > 0 ||
				Boolean(project.repositoryUrl),
			// Either signal counts, for the same reason the connection check
			// accepts both paths: older projects carry the legacy status column.
			analysisCompleted:
				completedCodeIndex !== null ||
				project.codeAnalysisStatus === "COMPLETED",
			atlasAnalysisExists: atlasAnalysis !== null,
		},

		completeDocumentTypes: new Set(documentGroups.map((row) => row.type)),

		acceptedMemberCount,
		roadmapItemCount,
		successfulScanExists: successfulScan !== null,
		newsletterEnabled: newsletter?.enabled ?? false,
	};

	return {
		evidence,
		tenant: {
			userId: project.userId,
			organizationId: project.organizationId,
		},
	};
}
