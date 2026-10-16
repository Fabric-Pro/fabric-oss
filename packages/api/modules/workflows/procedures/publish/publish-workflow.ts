/**
 * Publish Workflow Procedure
 * Publishes a workflow, creating a new version and making it available for triggers.
 *
 * Pre-flight validation is performed by the shared publish command to catch
 * issues early:
 * - Graph-level checks (empty graph, missing node types, cycles)
 * - Step-level validation (required fields, configuration)
 * - Risk assessment for high-risk operations
 */

import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { publishWorkflowCommand } from "../../lib/workflow-commands";
import { workflowActor, workflowCommandErrors } from "../workflow-actor";

const publishWorkflowInput = z.object({
	workflowId: z.string(),
	changelog: z.string().optional(),
	enableWebhook: z.boolean().optional().default(false),
	enableSchedule: z.boolean().optional().default(false),
	/** Skip validation (not recommended) */
	skipValidation: z.boolean().optional().default(false),
});

const validationIssueSchema = z.object({
	field: z.string(),
	message: z.string(),
	severity: z.enum(["error", "warning"]),
});

const validationResultSchema = z.object({
	valid: z.boolean(),
	errors: z.array(z.string()),
	warnings: z.array(z.string()),
	issues: z.array(validationIssueSchema).optional(),
});

/**
 * Two outcomes, and the type says which.
 *
 * A refused publish resolves rather than throws — validation errors are an
 * answer, not an exception. When every field was optional on one flat object,
 * nothing stopped a caller reading `version` off a refusal and rendering
 * "published": the dialog did exactly that, announcing "Version 1 is now live"
 * over a workflow that was still a draft, with no webhook URL to copy. A
 * discriminated union makes that unwriteable.
 */
const publishWorkflowOutput = z.discriminatedUnion("success", [
	z.object({
		success: z.literal(true),
		version: z.number(),
		publishedAt: z.date(),
		webhookUrl: z.string().optional(),
		webhookSecret: z.string().optional(),
		/** Outcome of syncing the Temporal Schedule, when the workflow has one */
		schedule: z
			.object({
				outcome: z.enum([
					"created",
					"updated",
					"deleted",
					"none",
					"failed",
				]),
				cron: z.string().optional(),
				reason: z.string().optional(),
			})
			.optional(),
		validation: validationResultSchema,
	}),
	z.object({
		success: z.literal(false),
		validation: validationResultSchema,
	}),
]);

export const publishWorkflow = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/{workflowId}/publish",
		tags: ["Workflows"],
		summary: "Publish a workflow",
		description:
			"Publish a workflow, creating a new version and making it available for triggers",
	})
	.input(publishWorkflowInput)
	.output(publishWorkflowOutput)
	.handler(async ({ input, context }) =>
		publishWorkflowCommand(
			workflowActor(
				context.user.id,
				resolveOrganizationId(undefined, context.session),
			),
			input,
		),
	);
