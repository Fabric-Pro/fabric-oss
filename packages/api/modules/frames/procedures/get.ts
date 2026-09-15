import { ORPCError } from "@orpc/client";
import {
	getFrameById,
	getProjectFrameById,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * Project-scoped frames (plan Slice 3: spike demos) are readable by any
 * member of their project, not only the creator. Access is decided by
 * `hasProjectAccess` (owner or accepted, non-expired project member; org
 * membership for org projects). A frame without a projectId is never
 * returned here.
 */
async function getAccessibleProjectFrame(frameId: string, userId: string) {
	const frame = await getProjectFrameById({ id: frameId });
	if (!frame?.projectId) {
		return null;
	}
	const allowed = await hasProjectAccess(frame.projectId, userId);
	return allowed ? frame : null;
}

export const getFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/frames/{id}",
		tags: ["Frames"],
		summary: "Get a frame",
		description: "Get a first-class Fabric Frame by ID",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const frame =
			(await getFrameById({
				id: input.id,
				userId: context.user.id,
				organizationId,
			})) ?? (await getAccessibleProjectFrame(input.id, context.user.id));

		if (!frame) {
			throw new ORPCError("NOT_FOUND", { message: "Frame not found" });
		}

		return {
			...frame,
			createdAt: frame.createdAt.toISOString(),
			updatedAt: frame.updatedAt.toISOString(),
		};
	});
