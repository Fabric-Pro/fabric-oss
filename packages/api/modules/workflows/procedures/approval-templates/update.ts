/**
 * Update Approval Template Procedure
 *
 * Updates an existing approval template.
 */

import { updateApprovalTemplate } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	name: z.string().min(1).max(100).optional(),
	description: z.string().max(500).optional(),
	criteria: z
		.object({
			agentPattern: z.string().optional(),
			operationPattern: z.string().optional(),
			resourcePattern: z.string().optional(),
			stepDescriptionPattern: z.string().optional(),
			maxRiskLevel: z
				.enum(["low", "medium", "high", "critical"])
				.optional(),
			executorTypes: z.array(z.string()).optional(),
		})
		.optional(),
	behavior: z
		.object({
			autoApprove: z.boolean(),
			notifyOnly: z.boolean().optional(),
			requireConfirmation: z.boolean().optional(),
			expiresAfter: z.number().optional(),
			validUntil: z.string().optional(),
		})
		.optional(),
	isActive: z.boolean().optional(),
	organizationId: z.string().nullable().optional(),
});

const outputSchema = z.object({
	success: z.boolean(),
	error: z.string().optional(),
});

export const updateApprovalTemplateProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "PATCH",
		path: "/approval-templates/{id}",
		tags: ["Orchestrator"],
		summary: "Update approval template",
		description: "Update an existing approval template",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const template = await updateApprovalTemplate(
			input.id,
			{
				...(input.name && { name: input.name }),
				...(input.description !== undefined && {
					description: input.description,
				}),
				...(input.criteria && { criteria: input.criteria as any }),
				...(input.behavior && { behavior: input.behavior as any }),
				...(input.isActive !== undefined && {
					isActive: input.isActive,
				}),
			},
			{
				userId: context.user.id,
				organizationId: organizationId ?? undefined,
			},
		);

		if (!template) {
			return {
				success: false,
				error: "Template not found or you don't have permission to update it",
			};
		}

		return {
			success: true,
		};
	});
