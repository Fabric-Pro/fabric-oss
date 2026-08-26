/**
 * Create Approval Template Procedure
 *
 * Creates a new approval template for auto-approving orchestrator operations.
 */

import {
	type ApprovalTemplateBehavior,
	type ApprovalTemplateCriteria,
	createApprovalTemplate,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
	criteria: z.object({
		agentPattern: z.string().optional(),
		operationPattern: z.string().optional(),
		resourcePattern: z.string().optional(),
		stepDescriptionPattern: z.string().optional(),
		maxRiskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
		executorTypes: z.array(z.string()).optional(),
	}),
	behavior: z.object({
		autoApprove: z.boolean(),
		notifyOnly: z.boolean().optional(),
		requireConfirmation: z.boolean().optional(),
		expiresAfter: z.number().optional(),
		validUntil: z.string().optional(),
	}),
	scope: z.enum(["USER", "ORGANIZATION"]).default("USER"),
	organizationId: z.string().nullable().optional(),
});

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	success: z.boolean(),
});

export const createApprovalTemplateProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.WORKSPACE_CREATE))
	.route({
		method: "POST",
		path: "/approval-templates",
		tags: ["Orchestrator"],
		summary: "Create approval template",
		description:
			"Create a new approval template for auto-approving operations",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Validate scope permissions
		if (input.scope === "ORGANIZATION" && !organizationId) {
			throw new Error(
				"Organization scope requires an organization context",
			);
		}

		const criteria: ApprovalTemplateCriteria = {
			...(input.criteria.agentPattern && {
				agentPattern: input.criteria.agentPattern,
			}),
			...(input.criteria.operationPattern && {
				operationPattern: input.criteria.operationPattern,
			}),
			...(input.criteria.resourcePattern && {
				resourcePattern: input.criteria.resourcePattern,
			}),
			...(input.criteria.stepDescriptionPattern && {
				stepDescriptionPattern: input.criteria.stepDescriptionPattern,
			}),
			...(input.criteria.maxRiskLevel && {
				maxRiskLevel: input.criteria.maxRiskLevel,
			}),
			...(input.criteria.executorTypes && {
				executorTypes: input.criteria.executorTypes,
			}),
		};

		const behavior: ApprovalTemplateBehavior = {
			autoApprove: input.behavior.autoApprove,
			notifyOnly: input.behavior.notifyOnly,
			requireConfirmation: input.behavior.requireConfirmation,
			expiresAfter: input.behavior.expiresAfter,
			validUntil: input.behavior.validUntil,
		};

		const template = await createApprovalTemplate({
			name: input.name,
			description: input.description,
			criteria,
			behavior,
			scope: input.scope,
			userId: input.scope === "USER" ? context.user.id : undefined,
			organizationId:
				input.scope === "ORGANIZATION" ? organizationId : undefined,
		});

		return {
			id: template.id,
			name: template.name,
			success: true,
		};
	});
