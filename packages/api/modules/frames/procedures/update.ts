import { ORPCError } from "@orpc/client";
import { updateFrame } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { frameContentEditSchema } from "../lib/frame-edit-contract";
import { frameEditErrors } from "../lib/frame-edit-errors";
import { frameReadDto } from "../lib/frame-read-dto";

const inputSchema = frameContentEditSchema.extend({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const updateFrameProcedure = tenantProtectedProcedure
	.use(frameEditErrors)
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/frames/{id}",
		tags: ["Frames"],
		summary: "Update a frame",
		description: "Update a first-class Fabric Frame",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const frame = await updateFrame({
			id: input.id,
			title: input.title,
			description: input.description,
			blocks: input.blocks,
			presentation: input.presentation,
			theme: input.theme,
			expectedUpdatedAt: input.expectedUpdatedAt
				? new Date(input.expectedUpdatedAt)
				: undefined,
			userId: context.user.id,
			organizationId,
		});
		if (!frame) {
			throw new ORPCError("NOT_FOUND", { message: "Frame not found" });
		}
		return {
			...frameReadDto(frame),
			createdAt: frame.createdAt.toISOString(),
			updatedAt: frame.updatedAt.toISOString(),
		};
	});
