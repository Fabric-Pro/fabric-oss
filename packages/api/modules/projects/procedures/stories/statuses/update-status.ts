import { ORPCError } from "@orpc/client";
import { db, updateStoryStatus } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can update status
 */
export const updateStoryStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/stories/statuses/{statusId}",
		tags: ["Projects", "Stories"],
		summary: "Update story status",
		description: "Update a story status (Kanban column) - labels only",
	})
	.input(
		z.object({
			projectId: z.string(),
			statusId: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(50),
		}),
	)
	.handler(async ({ input }) => {
		// Verify status exists and belongs to project
		const currentStatus = await db.projectStoryStatus.findUnique({
			where: { id: input.statusId, projectId: input.projectId },
		});
		if (!currentStatus) {
			throw new ORPCError("NOT_FOUND", {
				message: "Column not found",
			});
		}

		// Check unique constraint: another column with same name would violate @@unique([projectId, name])
		const trimmedName = input.name.trim();
		if (trimmedName !== currentStatus.name) {
			const existing = await db.projectStoryStatus.findFirst({
				where: {
					projectId: input.projectId,
					name: trimmedName,
					id: { not: input.statusId },
				},
			});
			if (existing) {
				throw new ORPCError("BAD_REQUEST", {
					message: "A column with this name already exists",
				});
			}
		}

		const status = await updateStoryStatus(
			input.statusId,
			input.projectId,
			{ name: trimmedName },
		);

		return { status };
	});
