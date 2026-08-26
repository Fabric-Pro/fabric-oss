/**
 * Update File Procedure
 *
 * Updates an existing file in the user's workspace.
 */

import { getWorkspaceFileById, updateWorkspaceFile } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	content: z.string().optional(),
	name: z.string().optional(),
});

export const updateFileProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "PATCH",
		path: "/workspace/files/{id}",
		tags: ["Workspace"],
		summary: "Update a file",
		description: "Update an existing file in the user's workspace",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		// Verify ownership
		const existing = await getWorkspaceFileById(input.id);
		if (!existing) {
			throw new Error("File not found");
		}
		if (existing.userId !== context.user.id) {
			throw new Error("Access denied");
		}

		const file = await updateWorkspaceFile(input.id, {
			content: input.content,
			name: input.name,
		});

		return {
			id: file.id,
			path: file.path,
			name: file.name,
			size: file.size,
			updatedAt: file.updatedAt.toISOString(),
		};
	});
