import { ORPCError } from "@orpc/client";
import { db } from "@repo/database/prisma/client";
import { listDecisionLogThreads } from "@repo/database/prisma/queries/feature-maturation";
import { countArchitectureDecisionsByStatus } from "@repo/database/prisma/queries/projects/architecture-decisions";
import { hasProjectAccess } from "@repo/database/prisma/queries/projects/projects";
import { getLatestProjectScan } from "@repo/database/prisma/queries/projects/scan";
import { rankStoryIdsBySemanticActivity } from "@repo/database/prisma/queries/projects/story-activity-ranking";
import { storySemanticActivityAt } from "@repo/database/prisma/queries/projects/story-semantic-activity";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const agentContextInput = z.object({
	projectId: z.string(),
	storyId: z.string().optional(),
	taskId: z.string().optional(),
	organizationId: z.string().nullable().optional(),
});

const STALE_DAYS = 14;
const RECENT_LIMIT = 8;
const STORY_LIMIT = 50;
const DOCUMENT_LIMIT = 8;
const CODING_RUN_LIMIT = 8;

function truncateText(value: string | null | undefined, maxLength = 500) {
	if (!value) {
		return null;
	}

	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}

	return `${normalized.slice(0, maxLength - 1)}…`;
}

function daysBetween(date: Date, now = new Date()) {
	return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

async function assertProjectAccess({
	projectId,
	userId,
	organizationId,
}: {
	projectId: string;
	userId: string;
	organizationId?: string;
}) {
	const hasAccess = await hasProjectAccess(projectId, userId, organizationId);

	if (!hasAccess) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
}

async function loadRecentStories(projectId: string) {
	const orderedIds = await rankStoryIdsBySemanticActivity(
		{ projectId },
		STORY_LIMIT,
	);
	if (orderedIds.length === 0) {
		return [];
	}

	const stories = await db.userStory.findMany({
		where: { projectId, id: { in: orderedIds } },
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			acceptanceCriteria: true,
			priority: true,
			size: true,
			storyPoints: true,
			labels: true,
			draftingStage: true,
			assigneeId: true,
			externalUrl: true,
			createdAt: true,
			lastEditedAt: true,
			status: {
				select: {
					id: true,
					name: true,
					isFinal: true,
					requiresApproval: true,
				},
			},
			tasks: {
				orderBy: { order: "asc" },
				select: {
					id: true,
					identifier: true,
					title: true,
					isCompleted: true,
					agentStatus: true,
					agentError: true,
					artifactUrl: true,
					repositoryUrl: true,
					updatedAt: true,
				},
			},
		},
	});
	const byId = new Map(stories.map((story) => [story.id, story]));
	return orderedIds.flatMap((id) => {
		const story = byId.get(id);
		return story ? [story] : [];
	});
}

async function loadAgentContext(
	input: z.infer<typeof agentContextInput> & { userId: string },
) {
	const now = new Date();
	const staleBefore = new Date(
		now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000,
	);

	const [
		project,
		statuses,
		stories,
		documents,
		codingRuns,
		decisionCounts,
		featureDecisionThreads,
		securityFindingSummary,
	] = await Promise.all([
		db.project.findFirst({
			where: { id: input.projectId },
			select: {
				id: true,
				name: true,
				description: true,
				goals: true,
				status: true,
				tags: true,
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
				defaultBranch: true,
				updatedAt: true,
				createdAt: true,
				organizationId: true,
			},
		}),
		db.projectStoryStatus.findMany({
			where: { projectId: input.projectId },
			orderBy: { order: "asc" },
			select: {
				id: true,
				name: true,
				isDefault: true,
				isFinal: true,
				requiresApproval: true,
				order: true,
			},
		}),
		loadRecentStories(input.projectId),
		db.projectDocument.findMany({
			where: {
				projectId: input.projectId,
				isActive: true,
			},
			orderBy: { updatedAt: "desc" },
			take: DOCUMENT_LIMIT,
			select: {
				id: true,
				type: true,
				title: true,
				status: true,
				wordCount: true,
				updatedAt: true,
			},
		}),
		db.codingRun.findMany({
			where: { projectId: input.projectId },
			orderBy: { updatedAt: "desc" },
			take: CODING_RUN_LIMIT,
			select: {
				id: true,
				storyId: true,
				storyTaskId: true,
				executionChannel: true,
				provider: true,
				status: true,
				externalStatus: true,
				externalUrl: true,
				pullRequestUrl: true,
				lastProviderEventAt: true,
				createdAt: true,
				updatedAt: true,
				story: {
					select: {
						identifier: true,
						title: true,
					},
				},
				storyTask: {
					select: {
						identifier: true,
						title: true,
					},
				},
			},
		}),
		input.taskId
			? Promise.resolve(null)
			: countArchitectureDecisionsByStatus(input.projectId),
		input.storyId
			? listDecisionLogThreads({
					tenantFilter: {
						userId: input.userId,
						organizationId: input.organizationId ?? null,
					},
					userStoryId: input.storyId,
				})
			: Promise.resolve([]),
		input.taskId
			? Promise.resolve(null)
			: getLatestProjectScan(input.projectId, {
					status: "COMPLETED",
				}).then(async (latestScan) => {
					if (!latestScan) {
						return null;
					}

					const openHighSeverityCount = await db.scanFinding.count({
						where: {
							scanId: latestScan.id,
							projectId: input.projectId,
							project: {
								organizationId: input.organizationId ?? null,
							},
							category: "SECURITY",
							status: "OPEN",
							severity: { in: ["CRITICAL", "HIGH"] },
						},
					});

					return { latestScan, openHighSeverityCount };
				}),
	]);

	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}

	const targetStory = input.storyId
		? (stories.find((story) => story.id === input.storyId) ??
			(await db.userStory.findFirst({
				where: { id: input.storyId, projectId: input.projectId },
				select: {
					id: true,
					identifier: true,
					title: true,
					description: true,
					acceptanceCriteria: true,
					priority: true,
					size: true,
					storyPoints: true,
					draftingStage: true,
					assigneeId: true,
					externalUrl: true,
					createdAt: true,
					lastEditedAt: true,
					status: {
						select: {
							id: true,
							name: true,
							isFinal: true,
							requiresApproval: true,
						},
					},
					tasks: {
						orderBy: { order: "asc" },
						select: {
							id: true,
							identifier: true,
							title: true,
							isCompleted: true,
							agentStatus: true,
							agentError: true,
							artifactUrl: true,
							repositoryUrl: true,
							updatedAt: true,
						},
					},
				},
			})))
		: null;

	if (input.storyId && !targetStory) {
		throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
	}

	const targetTask = input.taskId
		? (targetStory?.tasks.find((task) => task.id === input.taskId) ??
			(await db.storyTask.findFirst({
				where: {
					id: input.taskId,
					story: { projectId: input.projectId },
				},
				select: {
					id: true,
					identifier: true,
					title: true,
					description: true,
					isCompleted: true,
					agentStatus: true,
					agentError: true,
					artifactUrl: true,
					repositoryUrl: true,
					updatedAt: true,
					storyId: true,
				},
			})))
		: null;

	if (input.taskId && !targetTask) {
		throw new ORPCError("NOT_FOUND", { message: "Task not found" });
	}

	const statusCounts = statuses.map((status) => ({
		id: status.id,
		name: status.name,
		isFinal: status.isFinal,
		requiresApproval: status.requiresApproval,
		count: stories.filter((story) => story.status.id === status.id).length,
	}));

	const riskSignals = [
		...stories
			.filter(
				(story) =>
					!story.status.isFinal &&
					storySemanticActivityAt(story) < staleBefore,
			)
			.slice(0, RECENT_LIMIT)
			.map((story) => ({
				type: "stale_feature" as const,
				severity:
					daysBetween(storySemanticActivityAt(story), now) > 30
						? "high"
						: "medium",
				sourceId: story.id,
				sourceLabel: `${story.identifier} ${story.title}`,
				message: `No feature edits for ${daysBetween(storySemanticActivityAt(story), now)} days.`,
			})),
		...stories
			.flatMap((story) =>
				story.tasks
					.filter(
						(task) =>
							task.agentStatus === "failed" || task.agentError,
					)
					.map((task) => ({
						type: "failed_agent_task" as const,
						severity: "high",
						sourceId: task.id,
						sourceLabel: `${task.identifier} ${task.title}`,
						message: task.agentError
							? (truncateText(task.agentError, 180) ??
								"Agent task failed.")
							: "Agent task failed.",
					})),
			)
			.slice(0, RECENT_LIMIT),
		...codingRuns
			.filter((run) =>
				["FAILED", "CANCELLED", "TERMINATED_STALE"].includes(
					run.status,
				),
			)
			.slice(0, RECENT_LIMIT)
			.map((run) => ({
				type: "implementation_session_attention" as const,
				severity: run.status === "FAILED" ? "high" : "medium",
				sourceId: run.id,
				sourceLabel: run.storyTask
					? `${run.storyTask.identifier} ${run.storyTask.title}`
					: `${run.story.identifier} ${run.story.title}`,
				message: `Implementation session is ${run.status.toLowerCase()}.`,
			})),
		...(decisionCounts && decisionCounts.total > 0
			? [
					{
						type: "architecture_decisions" as const,
						severity: "medium",
						sourceId: "decisions-tab",
						sourceLabel: "Decisions tab",
						message: `${decisionCounts.total} architecture decision(s) recorded. ${decisionCounts.proposed > 0 ? `${decisionCounts.proposed} are PROPOSED (awaiting review). ` : ""}Use fabric_list_architecture_decisions to read them.`,
					},
				]
			: []),
		...(input.storyId && featureDecisionThreads.length > 0
			? [
					{
						type: "feature_decisions" as const,
						severity: "medium",
						sourceId: input.storyId,
						sourceLabel: targetStory
							? `${targetStory.identifier} Decisions tab`
							: "Feature Decisions tab",
						message: `${featureDecisionThreads.length} feature decision thread(s) recorded. ${featureDecisionThreads.filter((thread) => thread.root.status === "OPEN" || thread.root.status === "POSSIBLY_RESOLVED").length > 0 ? `${featureDecisionThreads.filter((thread) => thread.root.status === "OPEN" || thread.root.status === "POSSIBLY_RESOLVED").length} remain unresolved. ` : ""}Use fabric_list_feature_decisions with storyId to read them.`,
					},
				]
			: []),
		...(securityFindingSummary &&
		securityFindingSummary.openHighSeverityCount > 0
			? [
					{
						type: "security_findings" as const,
						severity: "high",
						sourceId: securityFindingSummary.latestScan.id,
						sourceLabel: "Security tab",
						message: `${securityFindingSummary.openHighSeverityCount} open high-severity security finding${securityFindingSummary.openHighSeverityCount === 1 ? "" : "s"} from the latest scan. Use fabric_list_security_findings to read them.`,
					},
				]
			: []),
	];

	const recentChanges = [
		...stories.slice(0, RECENT_LIMIT).map((story) => ({
			type: "feature" as const,
			id: story.id,
			label: `${story.identifier} ${story.title}`,
			status: story.status.name,
			updatedAt: storySemanticActivityAt(story),
		})),
		...documents.slice(0, 4).map((document) => ({
			type: "document" as const,
			id: document.id,
			label: document.title,
			status: document.status,
			updatedAt: document.updatedAt,
		})),
		...codingRuns.slice(0, 4).map((run) => ({
			type: "implementation_session" as const,
			id: run.id,
			label: run.storyTask
				? `${run.storyTask.identifier} ${run.storyTask.title}`
				: `${run.story.identifier} ${run.story.title}`,
			status: run.status,
			updatedAt: run.updatedAt,
		})),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, RECENT_LIMIT);

	return {
		project: {
			...project,
			description: truncateText(project.description, 700),
			goals: truncateText(project.goals, 700),
		},
		statusCounts,
		stories: stories.map((story) => ({
			id: story.id,
			identifier: story.identifier,
			title: story.title,
			description: truncateText(story.description),
			acceptanceCriteria: truncateText(story.acceptanceCriteria),
			priority: story.priority,
			size: story.size,
			storyPoints: story.storyPoints,
			draftingStage: story.draftingStage,
			assigneeId: story.assigneeId,
			externalUrl: story.externalUrl,
			status: story.status,
			taskSummary: {
				total: story.tasks.length,
				completed: story.tasks.filter((task) => task.isCompleted)
					.length,
				agentActive: story.tasks.filter((task) =>
					["pending", "working", "awaiting_approval"].includes(
						task.agentStatus ?? "",
					),
				).length,
				agentFailed: story.tasks.filter(
					(task) => task.agentStatus === "failed" || task.agentError,
				).length,
			},
			updatedAt: storySemanticActivityAt(story),
		})),
		targetStory: targetStory
			? {
					...targetStory,
					updatedAt: storySemanticActivityAt(targetStory),
					description: truncateText(targetStory.description, 1200),
					acceptanceCriteria: truncateText(
						targetStory.acceptanceCriteria,
						1200,
					),
				}
			: null,
		targetTask,
		documents,
		codingRuns,
		recentChanges,
		riskSignals,
		sources: [
			...stories.map((story) => ({
				type: "feature" as const,
				id: story.id,
				label: `${story.identifier} ${story.title}`,
			})),
			...documents.map((document) => ({
				type: "document" as const,
				id: document.id,
				label: document.title,
			})),
			...codingRuns.map((run) => ({
				type: "implementation_session" as const,
				id: run.id,
				label: run.storyTask
					? `${run.storyTask.identifier} ${run.storyTask.title}`
					: `${run.story.identifier} ${run.story.title}`,
			})),
		],
		limits: {
			stories: STORY_LIMIT,
			documents: DOCUMENT_LIMIT,
			codingRuns: CODING_RUN_LIMIT,
			staleDays: STALE_DAYS,
		},
	};
}

export const getAgentProjectContext = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/agents/context/project/{projectId}",
		tags: ["Agents", "Context"],
		summary: "Get project context for Fabric Agent",
		description:
			"Loads a bounded, source-attributed project context pack for Fabric Agent synthesis actions.",
	})
	.input(agentContextInput.omit({ storyId: true, taskId: true }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
		});

		return await loadAgentContext({
			...input,
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
		});
	});

export const getAgentFeatureContext = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.STORY_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/agents/context/project/{projectId}/feature/{storyId}",
		tags: ["Agents", "Context"],
		summary: "Get feature context for Fabric Agent",
		description:
			"Loads bounded project and feature context for Fabric Agent synthesis actions.",
	})
	.input(agentContextInput.omit({ taskId: true }).required({ storyId: true }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
		});

		return await loadAgentContext({
			...input,
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
		});
	});

export const getAgentTaskContext = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.STORY_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/agents/context/project/{projectId}/feature/{storyId}/task/{taskId}",
		tags: ["Agents", "Context"],
		summary: "Get task context for Fabric Agent",
		description:
			"Loads bounded project, feature, and task context for Fabric Agent synthesis actions.",
	})
	.input(agentContextInput.required({ storyId: true, taskId: true }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
		});

		return await loadAgentContext({
			...input,
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
		});
	});
