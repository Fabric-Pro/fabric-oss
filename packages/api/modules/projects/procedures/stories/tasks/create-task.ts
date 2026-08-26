import { ORPCError } from "@orpc/client";
import { createTask, getStoryById } from "@repo/database";
import { logDataEvent } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { dispatchLifecycleEvent } from "../../../../agent-deployments/lib/lifecycle-dispatcher";

export const createTaskProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/tasks",
		tags: ["Projects", "Stories", "Tasks"],
		summary: "Create task",
		description: "Create a new task for a user story",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(500),
			description: z.string().optional(),
			estimatedHours: z.number().min(0).max(1000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Verify story exists in project
		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Story not found",
			});
		}

		const task = await createTask({
			storyId: input.storyId,
			title: input.title,
			description: input.description,
			estimatedHours: input.estimatedHours,
		});

		// AUDIT-LOG-V1 SCOPE: This event stays on the stdout/webhook path
		// (@repo/logs/audit-logger.ts) for v1. Per D5 of
		// docs/audit-log/README.md, AI/MCP/
		// workflow events are deferred to Phase 2. Do NOT migrate to recordAudit
		// without coordination — dual-writing is acceptable but a unilateral migration
		// loses the stdout/webhook delivery the operator currently relies on.
		await logDataEvent("CREATE", "story_task", task.id, context.user.id, {
			projectId: input.projectId,
			storyId: input.storyId,
			organizationId: input.organizationId ?? undefined,
			source: "project_task_create",
		}).catch((error) => {
			console.warn("[AuditLog] Failed to log task creation:", error);
		});

		dispatchLifecycleEvent({
			resource: "task",
			event: "created",
			projectId: input.projectId,
			entityId: task.id,
			userId: context.user.id,
			organizationId: input.organizationId ?? null,
			data: { storyId: input.storyId, title: input.title },
		}).catch((error) => {
			console.warn(
				"[LifecycleDispatcher] Task created dispatch failed:",
				error,
			);
		});

		return { task };
	});
