import { deleteSkill, getSkillById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const deleteInputSchema = z.object({
	id: z.string().min(1),
	organizationId: z.string().nullable().optional(),
});

export const deleteSkillProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.SKILL_DELETE))
	.input(deleteInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const existing = await getSkillById(input.id, {
			userId: context.user.id,
			organizationId,
		});

		if (!existing) {
			throw new Error("Skill not found");
		}

		if (existing.scope === "SYSTEM") {
			throw new Error("Cannot delete system skills");
		}

		if (existing.userId && existing.userId !== context.user.id) {
			throw new Error("You can only delete your own skills");
		}

		// ORG-scope skills with no owning user (userId=null) slip past the
		// per-user check above; verify the caller belongs to the skill's org
		// before mutating (SOC 2 CC6.1 cross-tenant boundary).
		if (existing.scope === "ORGANIZATION" && existing.organizationId) {
			await requireOrganizationMembership(
				existing.organizationId,
				context.user.id,
			);
		}

		await deleteSkill(input.id);

		return { success: true };
	});
