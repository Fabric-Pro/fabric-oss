import { ORPCError } from "@orpc/server";
import { getMemoryEdit, rejectMemoryEdit } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const rejectEditInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	editId: z.string(),
	reason: z.string().optional(),
});

export const rejectEditProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_MANAGE))
	.route({
		method: "POST",
		path: "/agent-memory/edits/reject",
		tags: ["Agent Memory"],
		summary: "Reject a pending memory edit",
	})
	.input(rejectEditInputSchema)
	.handler(async ({ input, context }) => {
		const _organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify the edit exists and belongs to this user/org
		const edit = await getMemoryEdit(input.editId);
		if (!edit) {
			throw new ORPCError("NOT_FOUND", {
				message: "Edit not found",
			});
		}

		// Verify ownership
		if (edit.userId !== context.user.id) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to reject this edit",
			});
		}

		if (edit.status !== "PENDING") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Edit is not pending (status: ${edit.status})`,
			});
		}

		const rejectedEdit = await rejectMemoryEdit(
			input.editId,
			context.user.id,
			input.reason,
		);

		return { edit: rejectedEdit };
	});
