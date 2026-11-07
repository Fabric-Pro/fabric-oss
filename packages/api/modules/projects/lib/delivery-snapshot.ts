import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { hasPermission, Permissions } from "@repo/permissions";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";
import { publicCodingRuns } from "../../coding-runs/lib/public-run";

export const projectDeliveryInput = z.strictObject({
	projectId: z.string().trim().min(1).max(200),
});
export interface ProjectDeliveryActor {
	userId: string;
	organizationId: string;
}

/** Current facts only. No external requests, inferred deployment, provider logs or copied context bodies. */
export async function getProjectDeliverySnapshot(
	actor: ProjectDeliveryActor,
	raw: unknown,
) {
	const { projectId } = projectDeliveryInput.parse(raw);
	const access = await resolveEffectiveProjectPermissions(
		projectId,
		actor.userId,
	);
	if (
		!actor.organizationId ||
		!access ||
		access.organizationId !== actor.organizationId ||
		!(await hasProjectAccess(projectId, actor.userId, actor.organizationId))
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Project not found or access denied.",
		});
	}
	if (!hasPermission(access.permissions, Permissions.PROJECT_READ)) {
		throw new ORPCError("FORBIDDEN", {
			message: "Your current role cannot read project delivery.",
		});
	}
	const canReadWork = hasPermission(
		access.permissions,
		Permissions.STORY_READ,
	);
	const canReadContext = hasPermission(
		access.permissions,
		Permissions.CONTEXT_READ,
	);
	const canReadRuns = hasPermission(
		access.permissions,
		Permissions.AGENT_READ,
	);
	const canReadDecisions = hasPermission(
		access.permissions,
		Permissions.ARCHITECTURE_DECISION_READ,
	);
	const canReadDocuments = hasPermission(
		access.permissions,
		Permissions.DOCUMENT_READ,
	);
	const [stories, contexts, decisions, documents] = await Promise.all([
		canReadWork
			? db.userStory.findMany({
					where: { projectId },
					orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
					take: 21,
					select: {
						id: true,
						identifier: true,
						title: true,
						draftingStage: true,
						sourceRef: true,
						dependsOnRefs: true,
						updatedAt: true,
						tasks: {
							orderBy: { order: "asc" },
							take: 10,
							select: {
								id: true,
								identifier: true,
								title: true,
								isCompleted: true,
								agentStatus: true,
								artifactType: true,
							},
						},
						...(canReadRuns
							? {
									codingRuns: {
										orderBy: { createdAt: "desc" as const },
										take: 3,
										select: {
											id: true,
											projectId: true,
											providerMetadata: true,
											storyTaskId: true,
											status: true,
											kind: true,
											createdAt: true,
											startedAt: true,
											mergedAt: true,
											pullRequestNumber: true,
										},
									},
								}
							: {}),
					},
				})
			: [],
		canReadContext
			? db.projectContext.findMany({
					where: { projectId, organizationId: actor.organizationId },
					orderBy: { updatedAt: "desc" },
					take: 101,
					select: {
						id: true,
						type: true,
						sourceTitle: true,
						originalFilename: true,
						extractionStatus: true,
						embeddedAt: true,
						indexingExcluded: true,
						extractionError: true,
						urlLastSyncedAt: true,
						updatedAt: true,
					},
				})
			: [],
		canReadDecisions
			? db.architectureDecision.findMany({
					where: {
						projectId,
						organizationId: actor.organizationId,
						deletedAt: null,
					},
					orderBy: { updatedAt: "desc" },
					take: 5,
					select: {
						id: true,
						identifier: true,
						title: true,
						status: true,
						currentVersion: true,
						updatedAt: true,
					},
				})
			: [],
		hasPermission(access.permissions, Permissions.DOCUMENT_READ)
			? db.projectDocument.findMany({
					where: { projectId },
					orderBy: { updatedAt: "desc" },
					take: 5,
					select: {
						id: true,
						title: true,
						type: true,
						status: true,
						updatedAt: true,
					},
				})
			: [],
	]);
	const sources = contexts.slice(0, 100).map((row) => ({
		id: row.id,
		title: (row.sourceTitle || row.originalFilename || row.type).slice(
			0,
			240,
		),
		type: row.type,
		state: row.indexingExcluded
			? ("EXCLUDED" as const)
			: row.extractionStatus === "COMPLETED" && !row.extractionError
				? row.embeddedAt
					? ("INDEXED" as const)
					: ("STORED" as const)
				: row.extractionStatus === "FAILED" || row.extractionError
					? ("NEEDS_ATTENTION" as const)
					: ("PROCESSING" as const),
		updatedAt: row.updatedAt.toISOString(),
		lastSyncedAt: row.urlLastSyncedAt?.toISOString() ?? null,
	}));
	const projectedRuns = await publicCodingRuns(
		stories.flatMap((story) =>
			"codingRuns" in story && Array.isArray(story.codingRuns)
				? story.codingRuns
				: [],
		),
		actor.userId,
	);
	const runsById = new Map(projectedRuns.map((run) => [run.id, run]));
	const work = stories.slice(0, 20).map((story) => ({
		id: story.id,
		identifier: story.identifier,
		title: story.title,
		stage: story.draftingStage,
		sourceRef: story.sourceRef,
		dependsOnRefs: story.dependsOnRefs,
		updatedAt: story.updatedAt.toISOString(),
		tasks: story.tasks.map((task) => ({ ...task })),
		runs: ("codingRuns" in story && Array.isArray(story.codingRuns)
			? story.codingRuns
			: []
		)
			.map((entry) => runsById.get(entry.id))
			.filter((run): run is NonNullable<typeof run> => !!run)
			.map((run) => ({
				id: run.id,
				storyTaskId: run.storyTaskId,
				status: run.status,
				kind: run.kind,
				pullRequestNumber: run.pullRequestNumber,
				createdAt: run.createdAt.toISOString(),
				startedAt: run.startedAt?.toISOString() ?? null,
				mergedAt: run.mergedAt?.toISOString() ?? null,
				deliveryEvidence: run.mergedAt
					? ("PR_MERGED" as const)
					: run.pullRequestNumber
						? ("PR_OPENED" as const)
						: ("NO_MERGE_EVIDENCE" as const),
				deployment: "UNKNOWN" as const,
			})),
	}));
	const attention = sources.filter(
		(source) => source.state === "NEEDS_ATTENTION",
	).length;
	return {
		version: 1 as const,
		projectId,
		observedAt: new Date().toISOString(),
		work: {
			available: canReadWork,
			runsAvailable: canReadWork && canReadRuns,
			hasMore: stories.length > 20,
			items: work,
		},
		context: {
			available: canReadContext,
			hasMore: contexts.length > 100,
			inspected: sources.length,
			indexed: sources.filter((source) => source.state === "INDEXED")
				.length,
			attention,
			excluded: sources.filter((source) => source.state === "EXCLUDED")
				.length,
			sources: sources.slice(0, 8),
		},
		decisions: {
			available: canReadDecisions,
			items: decisions.map((row) => ({
				...row,
				updatedAt: row.updatedAt.toISOString(),
			})),
		},
		documents: {
			available: canReadDocuments,
			items: documents.map((row) => ({
				...row,
				updatedAt: row.updatedAt.toISOString(),
			})),
		},
		nextAction: attention
			? {
					kind: "REVIEW_CONTEXT" as const,
					label: "Review sources that need attention",
				}
			: canReadContext && canReadDocuments && !documents.length
				? {
						kind: "ADD_CONTEXT" as const,
						label: "Add the project brief or planning documents",
					}
				: {
						kind: "REVIEW_WORK" as const,
						label: "Review work and its latest results",
					},
		limitations: {
			deploymentEvidence: "NOT_COLLECTED" as const,
			externalAgentCost: "NOT_REPORTED" as const,
			leadTime: "NOT_COMPUTED" as const,
			relationships: "EXPLICIT_REFERENCES_ONLY" as const,
		},
	};
}
