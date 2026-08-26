import { createSkill } from "@repo/database";
import { logDataEvent } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireOrgMembership } from "../../organizations/lib/membership";

const createInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-z0-9-]+$/),
	name: z.string().min(1).max(200),
	description: z.string().min(1),
	content: z.string().min(1),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
	scope: z.enum(["ORGANIZATION", "USER"]).default("USER"),
	isPublished: z.boolean().default(true),
});

export const createSkillProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.SKILL_CREATE))
	.input(createInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const effectiveScope =
			organizationId && input.scope === "USER"
				? ("ORGANIZATION" as const)
				: input.scope;

		if (effectiveScope === "ORGANIZATION") {
			if (!organizationId) {
				throw new Error(
					"Organization ID is required for organization-scoped skills",
				);
			}
			const membership = await requireOrgMembership(
				context.user.id,
				organizationId,
				["owner", "admin", "member"],
			);
			if (!membership) {
				throw new Error(
					"You must be a member of this organization to create organization skills",
				);
			}
		}

		const skill = await createSkill({
			slug: input.slug,
			name: input.name,
			description: input.description,
			content: input.content,
			category: input.category,
			tags: input.tags,
			scope: effectiveScope,
			userId: context.user.id,
			organizationId:
				effectiveScope === "ORGANIZATION"
					? (organizationId ?? undefined)
					: undefined,
			isPublished: input.isPublished,
		});

		// AUDIT-LOG-V1 SCOPE: This event stays on the stdout/webhook path
		// (@repo/logs/audit-logger.ts) for v1. Per D5 of
		// docs/audit-log/README.md, AI/MCP/
		// workflow events are deferred to Phase 2. Do NOT migrate to recordAudit
		// without coordination — dual-writing is acceptable but a unilateral migration
		// loses the stdout/webhook delivery the operator currently relies on.
		await logDataEvent("CREATE", "skill", skill.id, context.user.id, {
			organizationId,
			scope: effectiveScope,
			slug: input.slug,
			tags: input.tags ?? [],
			source: "skills_create",
		}).catch((error) => {
			console.warn("[AuditLog] Failed to log skill creation:", error);
		});

		return { skill };
	});
