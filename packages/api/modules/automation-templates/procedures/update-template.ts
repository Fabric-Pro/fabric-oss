/**
 * Update Template Procedure
 *
 * Updates an automation template with ownership verification.
 */

import { ORPCError } from "@orpc/client";
import { db, type Prisma } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

// JSON-compatible schema for workflow data
const JsonValueSchema = z.any();

const TemplateParameterSchema = z.object({
	name: z.string().min(1),
	type: z.enum(["string", "number", "boolean", "url", "selector", "json"]),
	description: z.string().optional(),
	required: z.boolean().default(true),
	defaultValue: z.unknown().optional(),
	validation: z
		.object({
			pattern: z.string().optional(),
			min: z.number().optional(),
			max: z.number().optional(),
			enum: z.array(z.string()).optional(),
		})
		.optional(),
});

const TemplateStepSchema = z.object({
	id: z.string(),
	type: z.enum([
		"navigate",
		"action",
		"extract",
		"screenshot",
		"api-call",
		"hybrid",
		"wait",
		"condition",
	]),
	name: z.string().optional(),
	config: JsonValueSchema,
	parameterRefs: z.array(z.string()).optional(),
	condition: z.string().optional(),
	onError: z.enum(["stop", "skip", "retry"]).default("stop"),
	maxRetries: z.number().min(0).max(10).default(3),
});

export const updateTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_TEMPLATE_MANAGE))
	.route({
		method: "PUT",
		path: "/automation-templates/{id}",
		tags: ["Automation Templates"],
		summary: "Update automation template",
		description: "Update an existing automation template",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(255).optional(),
			description: z.string().max(2000).optional(),
			workflowSteps: z.array(TemplateStepSchema).optional(),
			parameters: z.array(TemplateParameterSchema).optional(),
			isPublic: z.boolean().optional(),
			category: z.string().max(100).optional(),
			tags: z.array(z.string().max(50)).max(20).optional(),
			incrementVersion: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Verify ownership with strict tenant isolation
		// Organization context: only update org templates
		// Personal context: only update personal templates (organizationId is null)
		const tenantFilter = organizationId
			? { organizationId }
			: { userId: user.id, organizationId: null };

		const existing = await db.automationTemplate.findFirst({
			where: {
				id: input.id,
				...tenantFilter,
			},
		});

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template not found or access denied",
			});
		}

		// Build update data
		const updateData: Prisma.AutomationTemplateUpdateInput = {};

		if (input.name !== undefined) {
			updateData.name = input.name;
		}
		if (input.description !== undefined) {
			updateData.description = input.description;
		}
		if (input.workflowSteps !== undefined) {
			updateData.workflowSteps =
				input.workflowSteps as unknown as Prisma.InputJsonValue;
		}
		if (input.parameters !== undefined) {
			updateData.parameters =
				input.parameters as unknown as Prisma.InputJsonValue;
		}
		if (input.isPublic !== undefined) {
			updateData.isPublic = input.isPublic;
		}
		if (input.category !== undefined) {
			updateData.category = input.category;
		}
		if (input.tags !== undefined) {
			updateData.tags = input.tags;
		}
		if (input.incrementVersion) {
			updateData.version = { increment: 1 };
		}

		// Update template
		const template = await db.automationTemplate.update({
			where: { id: input.id },
			data: updateData,
		});

		return { template };
	});
