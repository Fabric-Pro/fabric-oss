/**
 * Create File Procedure
 *
 * Creates a new file in the user's workspace.
 */

import { createWorkspaceFile } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	conversationId: z.string().optional(),
	path: z.string(),
	name: z.string(),
	content: z.string(),
	fileType: z
		.enum([
			"DOCUMENT",
			"CODE",
			"DATA",
			"CONFIG",
			"OUTPUT",
			"ARTIFACT",
			"FRAME",
			"SLIDESHOW",
		])
		.optional(),
});

export const createFileProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_CREATE))
	.route({
		method: "POST",
		path: "/workspace/files",
		tags: ["Workspace"],
		summary: "Create a file",
		description: "Create a new file in the user's workspace",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const file = await createWorkspaceFile({
			userId,
			organizationId,
			conversationId: input.conversationId,
			path: input.path,
			name: input.name,
			content: input.content,
			fileType: input.fileType,
		});

		return {
			id: file.id,
			path: file.path,
			name: file.name,
			size: file.size,
			createdAt: file.createdAt.toISOString(),
		};
	});
