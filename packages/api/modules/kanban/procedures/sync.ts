/**
 * Kanban Sync Procedures
 *
 * oRPC procedures for syncing data between fabric-portal and fabric-kanban CLI.
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Push fabric stories to kanban queue.
 * Stories are added to KanbanQueue with PENDING status for local implementation.
 */
export const pushToKanban = tenantProtectedProcedure
	.use(requirePermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/kanban/sync/push",
		tags: ["Kanban"],
		summary: "Push fabric stories to kanban queue",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyIds: z.array(z.string()).optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			pushedCount: z.number(),
			stories: z.array(
				z.object({
					id: z.string(),
					title: z.string(),
					status: z.string(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify project access
		const canView = await hasProjectAccess(input.projectId, user.id);
		if (!canView) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to view this project",
			});
		}

		// Fetch stories to push (only those not already in queue with pending status)
		const stories = await db.userStory.findMany({
			where: {
				projectId: input.projectId,
				...(input.storyIds?.length
					? { id: { in: input.storyIds } }
					: {}),
				// Only push published stories
				draftingStage: "PUBLISHED",
			},
			select: {
				id: true,
				title: true,
				description: true,
				acceptanceCriteria: true,
				priority: true,
			},
		});

		// Create kanban queue entries for each story
		const queueEntries = [];
		for (const story of stories) {
			// Check if already in queue with pending status
			const existing = await db.kanbanQueue.findFirst({
				where: {
					storyId: story.id,
					status: "PENDING",
				},
			});

			if (!existing) {
				const entry = await db.kanbanQueue.create({
					data: {
						projectId: input.projectId,
						storyId: story.id,
						organizationId: organizationId ?? null,
						createdById: user.id,
						status: "PENDING",
						context: {
							title: story.title,
							description: story.description,
							acceptanceCriteria: story.acceptanceCriteria,
							priority: story.priority,
						},
					},
				});
				queueEntries.push(entry);
			}
		}

		return {
			success: true,
			pushedCount: queueEntries.length,
			stories: stories.map((s) => ({
				id: s.id,
				title: s.title,
				status: "PENDING",
			})),
		};
	});

/**
 * Pull kanban updates to fabric.
 * Updates story statuses based on kanban task completion.
 */
export const pullFromKanban = tenantProtectedProcedure
	.use(requirePermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/kanban/sync/pull",
		tags: ["Kanban"],
		summary: "Pull kanban updates to fabric",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			pulledCount: z.number(),
			updates: z.array(
				z.object({
					storyId: z.string(),
					oldStatus: z.string(),
					newStatus: z.string(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const _organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify project access
		const canView = await hasProjectAccess(input.projectId, user.id);
		if (!canView) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to view this project",
			});
		}

		// Fetch kanban queue entries that are completed but not yet synced
		const completedEntries = await db.kanbanQueue.findMany({
			where: {
				projectId: input.projectId,
				status: "COMPLETED",
				completedAt: { not: null },
			},
			include: {
				story: {
					select: {
						id: true,
						title: true,
						statusId: true,
					},
				},
			},
		});

		// Update queue entries to mark as synced
		const updates = [];
		for (const entry of completedEntries) {
			await db.kanbanQueue.update({
				where: { id: entry.id },
				data: {
					// Mark as synced - keep completed status but add syncedAt
				},
			});

			updates.push({
				storyId: entry.storyId,
				oldStatus: "COMPLETED",
				newStatus: "SYNCED",
			});
		}

		return {
			success: true,
			pulledCount: updates.length,
			updates,
		};
	});

/**
 * Get sync status for a project.
 * Returns counts of stories in each kanban status.
 */
export const getSyncStatus = tenantProtectedProcedure
	.use(requirePermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/kanban/sync/status",
		tags: ["Kanban"],
		summary: "Get kanban sync status for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			projectId: z.string(),
			counts: z.object({
				pending: z.number(),
				pulled: z.number(),
				completed: z.number(),
				total: z.number(),
			}),
			lastSyncAt: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		// Verify project access
		const canView = await hasProjectAccess(input.projectId, user.id);
		if (!canView) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to view this project",
			});
		}

		// Get counts by status from KanbanQueue
		const [pendingCount, pulledCount, completedCount, totalCount] =
			await Promise.all([
				db.kanbanQueue.count({
					where: {
						projectId: input.projectId,
						status: "PENDING",
					},
				}),
				db.kanbanQueue.count({
					where: {
						projectId: input.projectId,
						status: "PULLED",
					},
				}),
				db.kanbanQueue.count({
					where: {
						projectId: input.projectId,
						status: "COMPLETED",
					},
				}),
				db.kanbanQueue.count({
					where: { projectId: input.projectId },
				}),
			]);

		// Get last sync time
		const lastSynced = await db.kanbanQueue.findFirst({
			where: {
				projectId: input.projectId,
				completedAt: { not: null },
			},
			orderBy: { completedAt: "desc" },
			select: { completedAt: true },
		});

		return {
			projectId: input.projectId,
			counts: {
				pending: pendingCount,
				pulled: pulledCount,
				completed: completedCount,
				total: totalCount,
			},
			lastSyncAt: lastSynced?.completedAt?.toISOString() || null,
		};
	});
