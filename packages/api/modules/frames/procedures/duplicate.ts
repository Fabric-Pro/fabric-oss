import { createFrame, type FrameBlock, getFrameById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	id: z.string(),
});

export const duplicateFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/frames/{id}/duplicate",
		tags: ["Frames"],
		summary: "Duplicate a frame",
		description: "Create a copy of an existing frame",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get the original frame
		const original = await getFrameById({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!original) {
			throw new Error("Frame not found");
		}

		// Clone blocks with new IDs
		const clonedBlocks: FrameBlock[] = original.document.blocks.map(
			(block) => ({
				...block,
				id: `block-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			}),
		);

		// Create new frame with copied content
		const newFrame = await createFrame({
			userId: context.user.id,
			organizationId,
			conversationId: original.conversationId ?? undefined,
			title: `${original.title} (Copy)`,
			description: original.description ?? undefined,
			kind: original.kind,
			blocks: clonedBlocks,
			theme: original.document.theme,
			sourceRunType: original.sourceRunType ?? undefined,
			sourceRunId: original.sourceRunId ?? undefined,
			authoritySessionId: original.authoritySessionId ?? undefined,
			providerKeys: original.providerKeys ?? [],
			isPublic: false, // Duplicated frames are private by default
		});

		return {
			id: newFrame.id,
			title: newFrame.title,
			description: newFrame.description,
			kind: newFrame.kind,
			contentType: newFrame.contentType,
			isPublic: newFrame.isPublic,
			shareToken: newFrame.shareToken,
			createdAt: newFrame.createdAt.toISOString(),
			updatedAt: newFrame.updatedAt.toISOString(),
		};
	});
