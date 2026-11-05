import { ORPCError } from "@orpc/server";
import { SkillError, skillGetSchema } from "@repo/ai/skill-contracts";
import { incrementSkillUseCount } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolvedOrganizationId } from "../../agents/procedures/conversations/resolved-organization";
import { getSkillCommand } from "../lib/skill-commands";
/** Compatibility operation: loading content is not a shell/script execution. */
export const executeSkillProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.SKILL_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/skills/{id}/execute",
		tags: ["Skills"],
		summary: "Load an authorized skill for explicit use",
	})
	.input(
		skillGetSchema.safeExtend({
			organizationId: z.string().min(1).nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			const { skill } = await getSkillCommand(
				{
					userId: context.user.id,
					organizationId: resolvedOrganizationId(
						input,
						context.session,
					),
				},
				{ id: input.id },
			);
			if (skill.archivedAt) {
				throw new SkillError(
					"NOT_FOUND",
					"Skill not found or access denied.",
				);
			}
			await incrementSkillUseCount(skill.id);
			return {
				id: skill.id,
				name: skill.name,
				slug: skill.slug,
				description: skill.description,
				content: skill.content,
			};
		} catch (error) {
			if (error instanceof SkillError) {
				throw new ORPCError(error.code, { message: error.message });
			}
			throw error;
		}
	});
