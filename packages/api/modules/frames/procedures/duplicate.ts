import { ORPCError } from "@orpc/client";
import {
	duplicateFrame,
	FramePlacementRefusedError,
	getFrameById,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * No `runtimeTools`: a copy declares no tools, so duplicating a page never
 * carries its capabilities along. Giving a copy tools is `fabric_duplicate_frame`
 * with `runtimeTools`, which checks every name against the platform table, asks
 * the person, and checks connected reads against their own servers; this
 * procedure would accept any string.
 */
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
		description:
			"Create a copy of an existing frame. The copy stays where the original is shown (its Workspace or project) and declares no tools.",
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
			throw new ORPCError("NOT_FOUND", { message: "Frame not found" });
		}

		// The caller's own copy of their page: it says it came from the same run
		// the original did. `duplicateFrame` holds the copy to the project it goes
		// into (the caller must be able to edit it now, not only to have created
		// the original once), the same check the agent's fork gets.
		const newFrame = await duplicateFrame({
			original,
			userId: context.user.id,
			organizationId,
			conversationId: original.conversationId ?? undefined,
			sourceRunType: original.sourceRunType ?? undefined,
			sourceRunId: original.sourceRunId ?? undefined,
			authoritySessionId: original.authoritySessionId ?? undefined,
			providerKeys: original.providerKeys ?? [],
		}).catch((error: unknown) => {
			if (error instanceof FramePlacementRefusedError) {
				throw new ORPCError("NOT_FOUND", {
					message: "Frame not found",
				});
			}
			throw error;
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
