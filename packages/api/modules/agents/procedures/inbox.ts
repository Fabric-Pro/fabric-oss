import { ORPCError } from "@orpc/client";
import { db, type Prisma } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const inboxStatusSchema = z.enum([
	"all",
	"running",
	"needs_review",
	"failed",
	"completed",
	"agent_replies",
]);

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	limit: z.number().min(1).max(100).default(50),
	status: inboxStatusSchema.default("all"),
});

type InboxItemStatus = "running" | "needs_review" | "failed" | "completed";

type InboxItem = {
	id: string;
	type:
		| "agent_reply"
		| "coding_run"
		| "agent_task"
		| "deployment_execution"
		| "project_update_draft";
	status: InboxItemStatus;
	title: string;
	description?: string | null;
	createdAt: Date;
	updatedAt?: Date;
	project?: { id: string; name: string | null };
	target?: {
		storyId?: string;
		storyIdentifier?: string;
		storyTitle?: string;
		taskId?: string;
		taskIdentifier?: string;
		taskTitle?: string;
	};
	href?: string;
	metadata?: Record<string, unknown>;
};

function truncate(value: string | null | undefined, max = 180) {
	if (!value) {
		return value;
	}
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function mapCodingRunStatus(status: string): InboxItemStatus {
	if (["FAILED", "CANCELLED", "TERMINATED_STALE"].includes(status)) {
		return "failed";
	}
	if (["COMPLETED", "MERGED", "CLOSED"].includes(status)) {
		return "completed";
	}
	return "running";
}

function getMetadataStatus(metadata: unknown) {
	return typeof metadata === "object" &&
		metadata !== null &&
		!Array.isArray(metadata)
		? (metadata as Record<string, unknown>).status
		: undefined;
}

export function mapAgentReplyStatus(metadata: unknown): InboxItemStatus {
	return getMetadataStatus(metadata) === "failed" ? "failed" : "completed";
}

function mapGenericStatus(status: string): InboxItemStatus {
	const normalized = status.toLowerCase();
	if (["failed", "error", "cancelled", "canceled"].includes(normalized)) {
		return "failed";
	}
	if (
		["completed", "complete", "success", "succeeded"].includes(normalized)
	) {
		return "completed";
	}
	if (
		["awaiting_approval", "needs_review", "pending_approval"].includes(
			normalized,
		)
	) {
		return "needs_review";
	}
	return "running";
}

function shouldInclude(
	item: InboxItem,
	status: z.infer<typeof inboxStatusSchema>,
) {
	if (status === "all") {
		return true;
	}
	if (status === "agent_replies") {
		return item.type === "agent_reply";
	}
	return item.status === status;
}

export const listAgentInbox = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/inbox",
		tags: ["Agents", "Inbox"],
		summary: "List workspace agent inbox items",
		description:
			"Returns a workspace-wide activity inbox across Fabric Agent replies, coding runs, deployment executions, agent tasks, and project update drafts.",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				context.user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const tenantWhere = organizationId
			? { organizationId }
			: { organizationId: null, userId: context.user.id };
		// Fabric AGENT replies are persisted with authorId = FABRIC_SYSTEM_USER_ID,
		// not the summoner's id. In personal context, scope by the parent
		// story/task ownership instead of comment.authorId.
		const storyCommentTenantWhere: Prisma.UserStoryCommentWhereInput =
			organizationId
				? { organizationId }
				: {
						organizationId: null,
						story: { project: { userId: context.user.id } },
					};
		const taskCommentTenantWhere: Prisma.StoryTaskCommentWhereInput =
			organizationId
				? { organizationId }
				: {
						organizationId: null,
						task: {
							story: { project: { userId: context.user.id } },
						},
					};

		const [
			storyAgentComments,
			taskAgentComments,
			codingRuns,
			agentTasks,
			deploymentExecutions,
			projectUpdateDrafts,
		] = await Promise.all([
			db.userStoryComment.findMany({
				where: {
					authorType: "AGENT",
					deletedAt: null,
					...storyCommentTenantWhere,
				},
				orderBy: { createdAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					content: true,
					createdAt: true,
					updatedAt: true,
					sourceCommentId: true,
					workflowId: true,
					metadata: true,
					story: {
						select: {
							id: true,
							identifier: true,
							title: true,
							project: { select: { id: true, name: true } },
						},
					},
				},
			}),
			db.storyTaskComment.findMany({
				where: {
					authorType: "AGENT",
					deletedAt: null,
					...taskCommentTenantWhere,
				},
				orderBy: { createdAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					content: true,
					createdAt: true,
					updatedAt: true,
					sourceCommentId: true,
					workflowId: true,
					metadata: true,
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
									project: {
										select: { id: true, name: true },
									},
								},
							},
						},
					},
				},
			}),
			db.codingRun.findMany({
				where: tenantWhere,
				orderBy: { updatedAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					status: true,
					provider: true,
					executionChannel: true,
					externalUrl: true,
					pullRequestUrl: true,
					createdAt: true,
					updatedAt: true,
					project: { select: { id: true, name: true } },
					story: {
						select: { id: true, identifier: true, title: true },
					},
					storyTask: {
						select: { id: true, identifier: true, title: true },
					},
				},
			}),
			db.agentTask.findMany({
				where: tenantWhere,
				orderBy: { updatedAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					agentId: true,
					status: true,
					stage: true,
					error: true,
					workflowId: true,
					createdAt: true,
					updatedAt: true,
					completedAt: true,
					approvals: {
						where: { status: "pending" },
						select: { id: true },
						take: 1,
					},
				},
			}),
			db.agentDeploymentExecution.findMany({
				where: tenantWhere,
				orderBy: { updatedAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					executionId: true,
					triggerType: true,
					status: true,
					error: true,
					workflowId: true,
					createdAt: true,
					updatedAt: true,
					queuedAt: true,
					startedAt: true,
					completedAt: true,
					deployment: { select: { id: true, name: true } },
				},
			}),
			db.chatArtifact.findMany({
				where: {
					...tenantWhere,
					type: "SUMMARY",
				},
				orderBy: { createdAt: "desc" },
				take: input.limit,
				select: {
					id: true,
					title: true,
					description: true,
					metadata: true,
					projectId: true,
					createdAt: true,
					updatedAt: true,
					project: { select: { id: true, name: true } },
				},
			}),
		]);

		const items: InboxItem[] = [
			...storyAgentComments.map((comment) => ({
				id: `story-comment-${comment.id}`,
				type: "agent_reply" as const,
				status: mapAgentReplyStatus(comment.metadata),
				title: `Fabric Agent replied on ${comment.story.identifier}`,
				description: truncate(comment.content),
				createdAt: comment.createdAt,
				updatedAt: comment.updatedAt,
				project: comment.story.project,
				target: {
					storyId: comment.story.id,
					storyIdentifier: comment.story.identifier,
					storyTitle: comment.story.title,
				},
				metadata: {
					commentId: comment.id,
					sourceCommentId: comment.sourceCommentId,
					workflowId: comment.workflowId,
				},
			})),
			...taskAgentComments.map((comment) => ({
				id: `task-comment-${comment.id}`,
				type: "agent_reply" as const,
				status: mapAgentReplyStatus(comment.metadata),
				title: `Fabric Agent replied on ${comment.task.identifier}`,
				description: truncate(comment.content),
				createdAt: comment.createdAt,
				updatedAt: comment.updatedAt,
				project: comment.task.story.project,
				target: {
					storyId: comment.task.story.id,
					storyIdentifier: comment.task.story.identifier,
					storyTitle: comment.task.story.title,
					taskId: comment.task.id,
					taskIdentifier: comment.task.identifier,
					taskTitle: comment.task.title,
				},
				metadata: {
					commentId: comment.id,
					sourceCommentId: comment.sourceCommentId,
					workflowId: comment.workflowId,
				},
			})),
			...codingRuns.map((run) => ({
				id: `coding-run-${run.id}`,
				type: "coding_run" as const,
				status: mapCodingRunStatus(run.status),
				title: run.storyTask
					? `Implementation session for ${run.storyTask.identifier}`
					: `Implementation session for ${run.story.identifier}`,
				description: `${run.provider} · ${run.status}`,
				createdAt: run.createdAt,
				updatedAt: run.updatedAt,
				project: run.project,
				target: {
					storyId: run.story.id,
					storyIdentifier: run.story.identifier,
					storyTitle: run.story.title,
					taskId: run.storyTask?.id,
					taskIdentifier: run.storyTask?.identifier,
					taskTitle: run.storyTask?.title,
				},
				metadata: {
					codingRunId: run.id,
					externalUrl: run.externalUrl,
					pullRequestUrl: run.pullRequestUrl,
					executionChannel: run.executionChannel,
				},
			})),
			...agentTasks.map((task) => ({
				id: `agent-task-${task.id}`,
				type: "agent_task" as const,
				status:
					task.approvals.length > 0
						? ("needs_review" as const)
						: mapGenericStatus(task.status),
				title: `Agent task: ${task.agentId}`,
				description: task.error ?? task.stage,
				createdAt: task.createdAt,
				updatedAt: task.updatedAt,
				metadata: {
					agentTaskId: task.id,
					agentId: task.agentId,
					workflowId: task.workflowId,
					stage: task.stage,
				},
			})),
			...deploymentExecutions.map((execution) => ({
				id: `deployment-execution-${execution.id}`,
				type: "deployment_execution" as const,
				status: mapGenericStatus(execution.status),
				title: `Deployment run: ${execution.deployment.name}`,
				description:
					execution.error ?? `Triggered by ${execution.triggerType}`,
				createdAt: execution.createdAt,
				updatedAt: execution.updatedAt,
				metadata: {
					executionId: execution.executionId,
					deploymentId: execution.deployment.id,
					workflowId: execution.workflowId,
					triggerType: execution.triggerType,
				},
			})),
			...projectUpdateDrafts
				.filter((artifact) => {
					const metadata = artifact.metadata;
					return (
						typeof metadata === "object" &&
						metadata !== null &&
						!Array.isArray(metadata) &&
						metadata.kind === "project_update_draft"
					);
				})
				.map((artifact) => ({
					id: `project-update-draft-${artifact.id}`,
					type: "project_update_draft" as const,
					status: "completed" as const,
					title: `Project update draft: ${artifact.title}`,
					description: artifact.description,
					createdAt: artifact.createdAt,
					updatedAt: artifact.updatedAt,
					project: artifact.project ?? undefined,
					metadata: { artifactId: artifact.id },
				})),
		]
			.filter((item) => shouldInclude(item, input.status))
			.sort(
				(a, b) =>
					(b.updatedAt ?? b.createdAt).getTime() -
					(a.updatedAt ?? a.createdAt).getTime(),
			)
			.slice(0, input.limit);

		const counts = items.reduce(
			(acc, item) => {
				acc[item.status] += 1;
				if (item.type === "agent_reply") {
					acc.agent_replies += 1;
				}
				return acc;
			},
			{
				running: 0,
				needs_review: 0,
				failed: 0,
				completed: 0,
				agent_replies: 0,
			},
		);

		return { items, counts };
	});
