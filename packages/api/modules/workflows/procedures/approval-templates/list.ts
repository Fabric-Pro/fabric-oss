/**
 * List Approval Templates Procedure
 *
 * Returns all approval templates for the current user/organization context.
 */

import {
	type ApprovalTemplateBehavior,
	type ApprovalTemplateCriteria,
	listApprovalTemplates,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	scope: z.enum(["USER", "ORGANIZATION", "SYSTEM"]).optional(),
	isActive: z.boolean().optional(),
	organizationId: z.string().nullable().optional(),
});

const outputSchema = z.object({
	templates: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			description: z.string().nullable(),
			criteria: z.record(z.string(), z.any()),
			behavior: z.record(z.string(), z.any()),
			scope: z.string(),
			usageCount: z.number(),
			lastUsed: z.string().nullable(),
			isActive: z.boolean(),
			createdAt: z.string(),
		}),
	),
});

export const listApprovalTemplatesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/approval-templates",
		tags: ["Orchestrator"],
		summary: "List approval templates",
		description: "Get all approval templates for auto-approving operations",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const templates = await listApprovalTemplates({
			userId: context.user.id,
			organizationId: organizationId || undefined,
			scope: input.scope,
			isActive: input.isActive,
		});

		return {
			templates: templates.map((t) => ({
				id: t.id,
				name: t.name,
				description: t.description,
				criteria: t.criteria as unknown as ApprovalTemplateCriteria,
				behavior: t.behavior as unknown as ApprovalTemplateBehavior,
				scope: t.scope,
				usageCount: t.usageCount,
				lastUsed: t.lastUsed?.toISOString() ?? null,
				isActive: t.isActive,
				createdAt: t.createdAt.toISOString(),
			})),
		};
	});
