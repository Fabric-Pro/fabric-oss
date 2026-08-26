/**
 * Get File Tree Procedure
 *
 * Returns the file tree structure for the user's workspace.
 */

import { getWorkspaceFileTree } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	conversationId: z.string().optional(),
});

export const getFileTreeProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workspace/files",
		tags: ["Workspace"],
		summary: "Get file tree",
		description: "Get the file tree structure for the user's workspace",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const { organizationId, conversationId } = input;

		try {
			const fileTree = await getWorkspaceFileTree(
				userId,
				organizationId ?? undefined,
				conversationId,
			);
			return fileTree;
		} catch (error) {
			// Log error but return empty array to avoid breaking the UI
			console.error(
				"[getFileTree] Error fetching workspace files:",
				error,
			);
			return [];
		}
	});
