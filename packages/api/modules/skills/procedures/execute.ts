import { ORPCError } from "@orpc/client";
import { getSkillById, incrementSkillUseCount } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const executeInputSchema = z.object({
	id: z.string().min(1),
	organizationId: z.string().nullable().optional(),
});

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure with XOR pattern.
 * Verifies skill is accessible to user (SYSTEM, ORG with membership, or USER owned)
 * before returning content and incrementing useCount.
 */
export const executeSkillProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.SKILL_READ))
	.route({
		method: "POST",
		path: "/skills/{id}/execute",
		tags: ["Skills"],
		summary: "Load skill content for execution",
	})
	.input(executeInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Fetch skill with tenant isolation
		const skill = await getSkillById(input.id, {
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
		});

		if (!skill) {
			throw new ORPCError("NOT_FOUND", { message: "Skill not found" });
		}

		// Verify access for ORGANIZATION-scoped skills
		if (skill.scope === "ORGANIZATION" && skill.organizationId) {
			const membership = await verifyOrganizationMembership(
				skill.organizationId,
				context.user.id,
			);
			if (!membership) {
				throw new ORPCError("NOT_FOUND", {
					message: "Skill not found",
				});
			}
		}

		// Verify access for USER-scoped skills
		if (skill.scope === "USER" && skill.userId !== context.user.id) {
			throw new ORPCError("NOT_FOUND", { message: "Skill not found" });
		}

		// Increment use count
		await incrementSkillUseCount(skill.id);

		return {
			id: skill.id,
			name: skill.name,
			slug: skill.slug,
			description: skill.description,
			content: skill.content,
		};
	});
