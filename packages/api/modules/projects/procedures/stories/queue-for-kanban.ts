/**
 * Queue for Fabric Kanban Procedure
 *
 * AUTHORIZATION: Uses canEditProject() - verifies org membership + editor role
 *
 * Queues a story for local implementation via Fabric Kanban.
 * The fabric-kanban CLI pulls PENDING items using the project's Git remote URL.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const queueForKanbanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/queue-for-kanban",
		tags: ["Projects", "Stories", "Kanban"],
		summary: "Queue a feature for local implementation via Fabric Kanban",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			queueId: z.string(),
			status: z.literal("PENDING"),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Fetch story with tasks and project context
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			include: {
				tasks: {
					where: { isCompleted: false },
					orderBy: { order: "asc" },
					select: {
						id: true,
						identifier: true,
						title: true,
						description: true,
					},
				},
				project: {
					select: {
						name: true,
						repositoryUrl: true,
						repositoryOwner: true,
						repositoryName: true,
						defaultBranch: true,
					},
				},
			},
		});

		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		// Cancel any existing PENDING queue item for this story to avoid duplicates
		await db.kanbanQueue.updateMany({
			where: {
				storyId: input.storyId,
				status: "PENDING",
			},
			data: { status: "CANCELLED" },
		});

		// Build the context snapshot
		const context_snapshot = {
			story: {
				identifier: story.identifier,
				title: story.title,
				description: story.description ?? null,
				acceptanceCriteria: story.acceptanceCriteria ?? null,
				tasks: story.tasks.map((t) => ({
					identifier: t.identifier,
					title: t.title,
					description: t.description ?? null,
				})),
			},
			project: {
				name: story.project.name,
				repositoryUrl: story.project.repositoryUrl ?? null,
				repositoryOwner: story.project.repositoryOwner ?? null,
				repositoryName: story.project.repositoryName ?? null,
				defaultBranch: story.project.defaultBranch ?? "main",
			},
		};

		const queued = await db.kanbanQueue.create({
			data: {
				projectId: input.projectId,
				storyId: input.storyId,
				organizationId: organizationId ?? null,
				createdById: user.id,
				context: context_snapshot,
				status: "PENDING",
			},
		});

		return { queueId: queued.id, status: "PENDING" };
	});
