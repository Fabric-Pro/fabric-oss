import { getSkillById, updateSkill } from "@repo/database";
import { logDataEvent } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const updateInputSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1).max(200).optional(),
	description: z.string().min(1).optional(),
	content: z.string().min(1).optional(),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
	isPublished: z.boolean().optional(),
	organizationId: z.string().nullable().optional(),
});

export const updateSkillProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.SKILL_UPDATE))
	.input(updateInputSchema)
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

		// Only the owner or SYSTEM skills can be updated
		if (existing.scope === "SYSTEM") {
			throw new Error("Cannot update system skills");
		}

		if (existing.userId && existing.userId !== context.user.id) {
			throw new Error("You can only update your own skills");
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

		const { id, ...updateData } = input;
		const skill = await updateSkill(id, updateData);

		// AUDIT-LOG-V1 SCOPE: This event stays on the stdout/webhook path
		// (@repo/logs/audit-logger.ts) for v1. Per D5 of
		// docs/audit-log/README.md, AI/MCP/
		// workflow events are deferred to Phase 2. Do NOT migrate to recordAudit
		// without coordination — dual-writing is acceptable but a unilateral migration
		// loses the stdout/webhook delivery the operator currently relies on.
		await logDataEvent("UPDATE", "skill", id, context.user.id, {
			organizationId,
			updatedFields: Object.keys(updateData),
			tags: updateData.tags,
			source: updateData.tags ? "skill_tags_update" : "skills_update",
		}).catch((error) => {
			console.warn("[AuditLog] Failed to log skill update:", error);
		});

		return { skill };
	});
