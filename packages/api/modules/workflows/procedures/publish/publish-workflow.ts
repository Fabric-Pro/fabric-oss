/**
 * Publish Workflow Procedure
 * Publishes a workflow, creating a new version and making it available for triggers.
 *
 * Pre-flight validation is performed at the API layer to catch issues early:
 * - Graph-level checks (empty graph, missing node types, cycles)
 * - Step-level validation (required fields, configuration)
 * - Risk assessment for high-risk operations
 */

import crypto from "node:crypto";
import { ORPCError } from "@orpc/client";
import { db, hasWorkflowAccess } from "@repo/database";
import { findScheduleCron } from "@repo/temporal";
import { decryptApiKeyMaybe, encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { syncWorkflowSchedule } from "../../lib/sync-workflow-schedule";
import { validateWorkflowBeforeExecution } from "../../lib/workflow-validation";

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
	.handler(async ({ input, context }) => {
		const { workflowId, changelog, enableWebhook, skipValidation } = input;
		const userId = context.user.id;

		// Ownership gate — see the note in `rollback-workflow.ts`. Org
		// membership alone let any colleague publish another member's draft,
		// making an unfinished workflow live (and creating its schedule).
		if (!(await hasWorkflowAccess(workflowId, userId))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		const workflow = await db.workflow.findUnique({
			where: { id: workflowId },
			include: {
				versions: {
					orderBy: { version: "desc" },
					take: 1,
				},
			},
		});

		if (!workflow) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		// =========================================================================
		// PRE-FLIGHT VALIDATION (API Layer)
		// Run graph-level validation before publishing to catch issues early
		// =========================================================================
		const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
		const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

		const validation = validateWorkflowBeforeExecution(nodes, edges);

		// If validation failed and skipValidation is not set, return errors
		if (!validation.valid && !skipValidation) {
			console.log(
				`[Publish] Pre-flight validation failed for workflow ${workflowId}:`,
				validation.errors,
			);
			return {
				success: false,
				validation: {
					valid: false,
					errors: validation.errors,
					warnings: validation.warnings,
					issues: validation.errors.map((e) => ({
						field: "graph",
						message: e,
						severity: "error" as const,
					})),
				},
			};
		}

		// Log warnings even if continuing
		if (validation.warnings.length > 0) {
			console.log(
				`[Publish] Pre-flight validation warnings for workflow ${workflowId}:`,
				validation.warnings,
			);
		}

		// Calculate new version number
		const currentVersion = workflow.versions[0]?.version ?? 0;
		const newVersion = currentVersion + 1;

		// Generate a webhook secret only when enabling webhooks for the first
		// time. `existingSecret` may already be encrypted at rest; only a freshly
		// generated secret is plaintext and must be encrypted on write (SOC 2
		// CC6.1) — re-encrypting an existing value would double-encrypt it.
		const existingSecret = workflow.webhookSecret;
		const newPlaintextSecret =
			enableWebhook && !existingSecret
				? `whsec_${crypto.randomBytes(32).toString("hex")}`
				: null;

		// Create new version
		// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
		const publishedAt = new Date();
		await db.workflowVersion.create({
			data: {
				workflowId,
				version: newVersion,
				nodes: workflow.nodes ?? {},
				edges: workflow.edges ?? {},
				variables: workflow.variables ?? undefined,
				settings: workflow.settings ?? undefined,
				triggerConfig: workflow.triggerConfig ?? undefined,
				changelog,
				isPublished: true,
				publishedAt,
				createdBy: userId,
				userId: workflow.userId,
				organizationId: workflow.organizationId,
			},
		});

		// A workflow whose trigger node carries a cron becomes SCHEDULE-
		// triggered on publish. `enableWebhook` still wins when both are set:
		// an explicit webhook request is a deliberate act, a leftover cron on
		// the trigger node is not.
		const scheduleCron = findScheduleCron(workflow.nodes);

		// Update workflow status and publishing info
		const _updatedWorkflow = await db.workflow.update({
			where: { id: workflowId },
			data: {
				status: "PUBLISHED",
				version: newVersion,
				publishedAt,
				publishedBy: userId,
				publishedVersion: newVersion,
				webhookSecret: enableWebhook
					? newPlaintextSecret
						? encryptApiKey(newPlaintextSecret)
						: existingSecret
					: workflow.webhookSecret,
				triggerType: enableWebhook
					? "WEBHOOK"
					: scheduleCron
						? "SCHEDULE"
						: workflow.triggerType,
			},
		});

		// A Schedule trigger only becomes live on publish. Until this landed,
		// choosing "Schedule" in the builder did nothing at all: no schedule
		// was ever created.
		const scheduleResult = await syncWorkflowSchedule({
			workflowId,
			nodes: workflow.nodes,
			userId: workflow.userId,
			organizationId: workflow.organizationId,
			projectId: workflow.projectId,
			workflowName: workflow.name,
			// Publishing makes it live.
			active: true,
		});

		// Build webhook URL
		const baseUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
		const webhookUrl = enableWebhook
			? `${baseUrl}/api/workflows/trigger/${workflowId}`
			: undefined;

		return {
			success: true as const,
			version: newVersion,
			publishedAt,
			webhookUrl,
			webhookSecret: enableWebhook
				? (newPlaintextSecret ??
					decryptApiKeyMaybe(existingSecret) ??
					undefined)
				: undefined,
			schedule: scheduleResult,
			// Include validation results (with warnings if any)
			validation: {
				valid: true,
				errors: [],
				warnings: validation.warnings,
			},
		};
	});
