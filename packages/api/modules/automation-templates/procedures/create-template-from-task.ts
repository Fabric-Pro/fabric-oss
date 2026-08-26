/**
 * Create Template From Task Procedure
 *
 * Creates a new automation template from a completed BrowserTask.
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

interface TemplateStep {
	id: string;
	type: string;
	name: string;
	config: Record<string, unknown>;
	parameterRefs?: string[];
	onError: string;
	maxRetries: number;
}

interface TemplateParameter {
	name: string;
	type: string;
	description: string;
	required: boolean;
	defaultValue?: unknown;
}

export const createTemplateFromTaskProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_TEMPLATE_MANAGE))
	.route({
		method: "POST",
		path: "/automation-templates/from-task",
		tags: ["Automation Templates"],
		summary: "Create template from browser task",
		description:
			"Create a new automation template from a completed browser task",
	})
	.input(
		z.object({
			taskId: z.string(),
			name: z.string().min(1).max(255),
			description: z.string().max(2000).optional(),
			organizationId: z.string().nullable().optional(),
			extractParameters: z.boolean().optional().default(true),
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

		// Find the browser task with strict tenant isolation
		// Organization context: only tasks belonging to the org
		// Personal context: only personal tasks (organizationId is null)
		const tenantFilter = organizationId
			? { organizationId }
			: { userId: user.id, organizationId: null };

		const task = await db.browserTask.findFirst({
			where: {
				id: input.taskId,
				...tenantFilter,
			},
		});

		if (!task) {
			throw new ORPCError("NOT_FOUND", {
				message: "Browser task not found",
			});
		}

		if (task.status !== "COMPLETED") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot create template from ${task.status} task. Only COMPLETED tasks can be saved.`,
			});
		}

		// Extract workflow steps from task
		const workflowSteps: TemplateStep[] = [];
		const parameters: TemplateParameter[] = [];

		// Build navigate step from task URL
		if (task.url) {
			workflowSteps.push({
				id: "step-navigate",
				type: "navigate",
				name: "Navigate to URL",
				config: { url: input.extractParameters ? "{{url}}" : task.url },
				parameterRefs: input.extractParameters ? ["url"] : [],
				onError: "stop",
				maxRetries: 3,
			});

			if (input.extractParameters) {
				parameters.push({
					name: "url",
					type: "url",
					description: "Target URL to navigate to",
					required: true,
					defaultValue: task.url,
				});
			}
		}

		// Add actions if present
		const actions = task.actions as Array<Record<string, unknown>> | null;
		if (actions?.length) {
			for (let i = 0; i < actions.length; i++) {
				const action = actions[i];
				workflowSteps.push({
					id: `step-action-${i}`,
					type: "action",
					name: `Action ${i + 1}: ${action?.type ?? "unknown"}`,
					config: action ?? {},
					onError: "stop",
					maxRetries: 3,
				});
			}
		}

		// Add extractors if present
		const extractors = task.extractors as Array<
			Record<string, unknown>
		> | null;
		if (extractors?.length) {
			workflowSteps.push({
				id: "step-extract",
				type: "extract",
				name: "Extract Content",
				config: { extractors },
				onError: "stop",
				maxRetries: 3,
			});
		}

		// Create the template
		const template = await db.automationTemplate.create({
			data: {
				name: input.name,
				description: input.description,
				workflowSteps:
					workflowSteps as unknown as Prisma.InputJsonValue,
				parameters: parameters as unknown as Prisma.InputJsonValue,
				sourceTaskId: input.taskId,
				userId: user.id,
				organizationId,
				isPublic: false,
				version: 1,
			},
		});

		return { template, parametersExtracted: parameters.length };
	});
