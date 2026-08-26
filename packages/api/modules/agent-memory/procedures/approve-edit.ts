import { ORPCError } from "@orpc/server";
import { approveMemoryEdit, getMemoryEdit } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const approveEditInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	editId: z.string(),
});

export const approveEditProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_MANAGE))
	.route({
		method: "POST",
		path: "/agent-memory/edits/approve",
		tags: ["Agent Memory"],
		summary: "Approve a pending memory edit",
	})
	.input(approveEditInputSchema)
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
				message: "You don't have permission to approve this edit",
			});
		}

		if (edit.status !== "PENDING") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Edit is not pending (status: ${edit.status})`,
			});
		}

		const { edit: approvedEdit, file } = await approveMemoryEdit(
			input.editId,
			context.user.id,
		);

		return { edit: approvedEdit, file };
	});
