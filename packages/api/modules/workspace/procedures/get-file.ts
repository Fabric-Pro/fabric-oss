/**
 * Get File Procedure
 *
 * Returns a single file with its content.
 */

import { getWorkspaceFileById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
});

export const getFileProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workspace/files/{id}",
		tags: ["Workspace"],
		summary: "Get a file",
		description: "Get a single file with its content",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		try {
			const file = await getWorkspaceFileById(input.id, {
				userId: context.user.id,
				organizationId:
					context.session.activeOrganizationId ?? undefined,
			});

			if (!file) {
				throw new Error("File not found");
			}

			// Verify ownership
			if (file.userId !== context.user.id) {
				throw new Error("Access denied");
			}

			return {
				id: file.id,
				path: file.path,
				name: file.name,
				content: file.content,
				extension: file.extension,
				mimeType: file.mimeType,
				size: file.size,
				fileType: file.fileType,
				status: file.status,
				version: file.version,
				createdAt: file.createdAt.toISOString(),
				updatedAt: file.updatedAt.toISOString(),
			};
		} catch (error) {
			console.error("[getFile] Error:", error);
			throw error;
		}
	});
