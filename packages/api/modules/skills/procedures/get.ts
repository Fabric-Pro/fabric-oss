import { getOrganizationMembership, getSkill } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const getInputSchema = z.object({
	id: z.string().min(1),
});

export const getSkillProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.SKILL_READ))
	.input(getInputSchema)
	.handler(async ({ input, context }) => {
		const skill = await getSkill(input.id);

		if (!skill) {
			throw new Error("Skill not found");
		}

		// Enforce tenant visibility: SYSTEM skills are public,
		// ORG/USER skills require verified membership/ownership
		if (skill.scope === "ORGANIZATION" && skill.organizationId) {
			const membership = await getOrganizationMembership(
				skill.organizationId,
				context.user.id,
			);
			if (!membership) {
				throw new Error("Skill not found");
			}
		} else if (skill.scope === "USER") {
			if (skill.userId !== context.user.id) {
				throw new Error("Skill not found");
			}
		}

		return { skill };
	});
