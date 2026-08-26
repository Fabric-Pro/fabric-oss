/**
 * Execute Template Procedure
 *
 * Executes an automation template with provided parameter values.
 * Triggers a Temporal workflow for the actual execution.
 */

import { ORPCError } from "@orpc/client";
import { db, type Prisma } from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

interface TemplateParameter {
	name: string;
	type: string;
	required?: boolean;
	defaultValue?: unknown;
}

function parseTemplateParameters(params: unknown): TemplateParameter[] {
	if (!params || !Array.isArray(params)) {
		return [];
	}
	return params as TemplateParameter[];
}

export const executeTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_TEMPLATE_MANAGE))
	.route({
		method: "POST",
		path: "/automation-templates/{id}/execute",
		tags: ["Automation Templates"],
		summary: "Execute automation template",
		description:
			"Execute an automation template with provided parameter values",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			parameterValues: z.record(z.string(), z.unknown()),
			takeScreenshots: z.boolean().optional().default(false),
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

		// Get template with strict tenant isolation
		// Organization context: only execute org templates
		// Personal context: only execute personal templates (organizationId is null)
		const tenantFilter = organizationId
			? { organizationId }
			: { userId: user.id, organizationId: null };

		const template = await db.automationTemplate.findFirst({
			where: {
				id: input.id,
				...tenantFilter,
			},
		});

		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template not found",
			});
		}

		// Validate required parameters
		const parameters = parseTemplateParameters(template.parameters);
		const missingParams: string[] = [];

		for (const param of parameters) {
			if (
				param.required !== false &&
				input.parameterValues[param.name] === undefined
			) {
				// Check if there's a default value
				if (param.defaultValue === undefined) {
					missingParams.push(param.name);
				}
			}
		}

		if (missingParams.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Missing required parameters: ${missingParams.join(", ")}`,
			});
		}

		// Create browser task for tracking
		const browserTask = await db.browserTask.create({
			data: {
				url: "", // Will be filled during execution
				actions: [] as unknown as Prisma.InputJsonValue,
				extractors: [] as unknown as Prisma.InputJsonValue,
				status: "PENDING",
				userId: user.id,
				organizationId: input.organizationId,
			},
		});

		// Check if Temporal is available
		const temporalAvailable = await isTemporalAvailable();

		if (temporalAvailable) {
			try {
				const client = await getTemporalClient();

				// Start the template execution workflow
				const handle = await client.workflow.start(
					"templateExecutionWorkflow",
					withCorrelationMemo({
						taskQueue: "workflow-builder",
						workflowId: `template-execution-${browserTask.id}`,
						args: [
							{
								templateId: template.id,
								taskId: browserTask.id,
								userId: user.id,
								organizationId: input.organizationId,
								parameterValues: input.parameterValues,
								takeScreenshots: input.takeScreenshots,
							},
						],
					}),
				);

				// Update template usage count
				await db.automationTemplate.update({
					where: { id: template.id },
					data: {
						useCount: { increment: 1 },
						lastUsedAt: new Date(),
					},
				});

				return {
					taskId: browserTask.id,
					templateId: template.id,
					temporalWorkflowId: handle.workflowId,
					status: "started",
				};
			} catch (error) {
				console.error(
					"Failed to start template execution workflow:",
					error,
				);
				// Update task status on failure
				await db.browserTask.update({
					where: { id: browserTask.id },
					data: {
						status: "FAILED",
						error: "Failed to start workflow",
					},
				});

				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to start template execution",
				});
			}
		}

		// If Temporal is not available
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Temporal workflow service not available",
		});
	});
