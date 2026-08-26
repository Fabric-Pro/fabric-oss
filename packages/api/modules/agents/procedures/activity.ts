import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	limit: z.number().min(1).max(100).default(50),
});

type AgentActivityItem = {
	id: string;
	type:
		| "task_created"
		| "project_update_draft_saved"
		| "implementation_session_started"
		| "skill_saved"
		| "automation_trigger_saved"
		| "agent_comment_replied";
	title: string;
	description?: string | null;
	createdAt: Date;
	metadata?: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const listAgentActivity = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/agents/activity/project/{projectId}",
		tags: ["Agents", "Activity"],
		summary: "List Fabric Agent activity for a project",
		description:
			"Returns a merged activity feed for Fabric Agent approved actions such as task creation, update drafts, implementation sessions, Skills, and automation triggers.",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: context.user.id };

		const [
			tasks,
			artifacts,
			codingRuns,
			skills,
			storyAgentComments,
			taskAgentComments,
		] = await Promise.all([
			db.storyTask.findMany({
				where: {
					story: { projectId: input.projectId },
				},
				orderBy: { createdAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					identifier: true,
					title: true,
					createdAt: true,
					story: {
						select: {
							id: true,
							identifier: true,
							title: true,
						},
					},
				},
			}),
			db.chatArtifact.findMany({
				where: {
					projectId: input.projectId,
					type: "SUMMARY",
					...tenantFilter,
				},
				orderBy: { createdAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					title: true,
					description: true,
					metadata: true,
					createdAt: true,
				},
			}),
			db.codingRun.findMany({
				where: {
					projectId: input.projectId,
					...tenantFilter,
				},
				orderBy: { createdAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					status: true,
					provider: true,
					executionChannel: true,
					externalUrl: true,
					pullRequestUrl: true,
					createdAt: true,
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
			db.skill.findMany({
				where: {
					isPublished: true,
					OR: [
						{ scope: "USER", userId: context.user.id },
						...(organizationId
							? [
									{
										scope: "ORGANIZATION" as const,
										organizationId,
									},
								]
							: []),
					],
					tags: { hasSome: ["project-workflow", "fabric-agent"] },
				},
				orderBy: { updatedAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					name: true,
					description: true,
					tags: true,
					createdAt: true,
					updatedAt: true,
				},
			}),
			db.userStoryComment.findMany({
				where: {
					authorType: "AGENT",
					deletedAt: null,
					organizationId: organizationId ?? null,
					// No authorId filter: Fabric replies are stored with the
					// canonical fabric-system author, not the summoner. Project
					// ownership is enforced upstream via hasProjectAccess().
					story: { projectId: input.projectId },
				},
				orderBy: { createdAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					content: true,
					createdAt: true,
					sourceCommentId: true,
					workflowId: true,
					story: {
						select: {
							id: true,
							identifier: true,
							title: true,
						},
					},
				},
			}),
			db.storyTaskComment.findMany({
				where: {
					authorType: "AGENT",
					deletedAt: null,
					organizationId: organizationId ?? null,
					// See userStoryComment block above.
					task: { story: { projectId: input.projectId } },
				},
				orderBy: { createdAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					content: true,
					createdAt: true,
					sourceCommentId: true,
					workflowId: true,
					task: {
						select: {
							id: true,
							identifier: true,
							title: true,
							story: {
								select: {
									id: true,
									identifier: true,
									title: true,
								},
							},
						},
					},
				},
			}),
		]);

		const activity: AgentActivityItem[] = [
			...storyAgentComments.map((comment) => ({
				id: `story-agent-comment-${comment.id}`,
				type: "agent_comment_replied" as const,
				title: `Fabric Agent replied on ${comment.story.identifier} ${comment.story.title}`,
				description: comment.content,
				createdAt: comment.createdAt,
				metadata: {
					commentId: comment.id,
					storyId: comment.story.id,
					sourceCommentId: comment.sourceCommentId,
					workflowId: comment.workflowId,
				},
			})),
			...taskAgentComments.map((comment) => ({
				id: `task-agent-comment-${comment.id}`,
				type: "agent_comment_replied" as const,
				title: `Fabric Agent replied on ${comment.task.identifier} ${comment.task.title}`,
				description: `Feature: ${comment.task.story.identifier} ${comment.task.story.title}`,
				createdAt: comment.createdAt,
				metadata: {
					commentId: comment.id,
					taskId: comment.task.id,
					storyId: comment.task.story.id,
					sourceCommentId: comment.sourceCommentId,
					workflowId: comment.workflowId,
				},
			})),
			...tasks.map((task) => ({
				id: `task-${task.id}`,
				type: "task_created" as const,
				title: `Task created: ${task.identifier} ${task.title}`,
				description: `Feature: ${task.story.identifier} ${task.story.title}`,
				createdAt: task.createdAt,
				metadata: { taskId: task.id, storyId: task.story.id },
			})),
			...artifacts
				.filter((artifact) => {
					const metadata = artifact.metadata;
					return (
						isObject(metadata) &&
						metadata.kind === "project_update_draft"
					);
				})
				.map((artifact) => ({
					id: `artifact-${artifact.id}`,
					type: "project_update_draft_saved" as const,
					title: `Project update draft saved: ${artifact.title}`,
					description: artifact.description,
					createdAt: artifact.createdAt,
					metadata: { artifactId: artifact.id },
				})),
			...codingRuns.map((run) => {
				const target = run.storyTask
					? `${run.storyTask.identifier} ${run.storyTask.title}`
					: `${run.story.identifier} ${run.story.title}`;
				return {
					id: `coding-run-${run.id}`,
					type: "implementation_session_started" as const,
					title: `Implementation session started for ${target}`,
					description: `${run.provider} · ${run.status}`,
					createdAt: run.createdAt,
					metadata: {
						codingRunId: run.id,
						status: run.status,
						provider: run.provider,
						externalUrl: run.externalUrl,
						pullRequestUrl: run.pullRequestUrl,
					},
				};
			}),
			...skills.flatMap((skill) => {
				const items: AgentActivityItem[] = [
					{
						id: `skill-${skill.id}`,
						type: "skill_saved",
						title: `Skill saved: ${skill.name}`,
						description: skill.description,
						createdAt: skill.createdAt,
						metadata: { skillId: skill.id, tags: skill.tags },
					},
				];
				const automationTags = skill.tags.filter(
					(tag) =>
						!new Set(["fabric-agent", "project-workflow"]).has(tag),
				);
				if (automationTags.length > 0) {
					items.push({
						id: `skill-automation-${skill.id}`,
						type: "automation_trigger_saved",
						title: `Automation trigger saved for ${skill.name}`,
						description: `Column tags: ${automationTags.join(", ")}`,
						createdAt: skill.updatedAt,
						metadata: { skillId: skill.id, tags: automationTags },
					});
				}
				return items;
			}),
		]
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.slice(0, input.limit);

		return { activity };
	});
