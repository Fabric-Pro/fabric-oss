/**
 * Create Template Procedure
 *
 * Creates a new automation template directly with provided workflow steps.
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

export const createTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_TEMPLATE_MANAGE))
	.route({
		method: "POST",
		path: "/automation-templates",
		tags: ["Automation Templates"],
		summary: "Create automation template",
		description:
			"Create a new automation template with workflow steps and parameters",
	})
	.input(
		z.object({
			name: z.string().min(1).max(255),
			description: z.string().max(2000).optional(),
			workflowSteps: z.array(TemplateStepSchema),
			parameters: z.array(TemplateParameterSchema).optional(),
			organizationId: z.string().nullable().optional(),
			isPublic: z.boolean().optional().default(false),
			category: z.string().max(100).optional(),
			tags: z.array(z.string().max(50)).max(20).optional(),
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

		// Create template
		const template = await db.automationTemplate.create({
			data: {
				name: input.name,
				description: input.description,
				workflowSteps:
					input.workflowSteps as unknown as Prisma.InputJsonValue,
				parameters: (input.parameters ??
					[]) as unknown as Prisma.InputJsonValue,
				userId: user.id,
				organizationId,
				isPublic: input.isPublic,
				category: input.category,
				tags: input.tags ?? [],
				version: 1,
			},
		});

		return { template };
	});
