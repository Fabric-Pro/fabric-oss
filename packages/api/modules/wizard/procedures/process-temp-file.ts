import { ORPCError } from "@orpc/server";
import { getWizardTempContextById } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Process temp context file
 *
 * Triggers a Temporal workflow to handle the entire processing pipeline:
 * Download → Extract → Chunk → Embed → Store
 *
 * This endpoint returns immediately after starting the workflow.
 * The client should poll for status updates.
 *
 * Similar pattern to workspace document processing for durability and offloading.
 */
export const processTempFileProcedure = tenantProtectedProcedure
	// Evaluated against the organization named in the input, not the
	// session's: wizard temp contexts are stamped with it, and processing one
	// runs extraction and embeddings on that organization's AI provider.
	// `requireOrganization`: temp contexts exist only to become a project's
	// in an organization (ADR-018). Without it a null organization resolves
	// nothing and the role check is skipped — an organization viewer could
	// upload and process files the session role used to refuse them.
	.use(
		requireInputOrgPermission(Permissions.PROJECT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/wizard/temp-contexts/:contextId/process",
		tags: ["Wizard", "Temp Contexts"],
		summary: "Process temp context file",
		description:
			"Trigger processing workflow for an uploaded temp context file (extraction, chunking, embedding)",
	})
	.input(
		z.object({
			contextId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** Extraction strategy: 'local-only', 'prefer-external', 'external-only', 'cost-optimized', 'quality-optimized' */
			extractionStrategy: z
				.enum([
					"local-only",
					"prefer-external",
					"external-only",
					"cost-optimized",
					"quality-optimized",
				])
				.optional()
				.default("local-only"),
		}),
	)
	.handler(async ({ input, context }) => {
		const { contextId, extractionStrategy } = input;
		const user = context.user;
		// The organization the gate authorized (it resolves the same way), so
		// an omitted one is the session's here too, never the null arm.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get temp context to verify it exists and get session info
		const tempContext = await getWizardTempContextById(
			contextId,
			user.id,
			organizationId ?? undefined,
		);

		if (!tempContext) {
			throw new ORPCError("NOT_FOUND", {
				message: "Temp context not found",
			});
		}

		// Check if already processed
		if (
			tempContext.extractionStatus === "COMPLETED" &&
			tempContext.embeddedAt
		) {
			return {
				contextId: tempContext.id,
				status: "already_processed",
				workflowId: null,
			};
		}

		// Check if already processing
		if (tempContext.extractionStatus === "EXTRACTING") {
			return {
				contextId: tempContext.id,
				status: "processing",
				workflowId: null,
			};
		}

		// Start the processing workflow
		try {
			const temporalClient = await getTemporalClient();
			const workflowId = `wizard-context-processing-${tempContext.sessionId}-${contextId}-${Date.now()}`;

			await temporalClient.workflow.start(
				"wizardContextProcessingWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId,
					args: [
						{
							contextId,
							sessionId: tempContext.sessionId,
							userId: user.id,
							organizationId: organizationId ?? undefined,
							extractionStrategy,
							isRetry: tempContext.extractionStatus === "FAILED",
						},
					],
				}),
			);

			console.log(
				`[ProcessTempFile] Started processing workflow: ${workflowId}`,
			);

			return {
				contextId: tempContext.id,
				status: "processing",
				workflowId,
			};
		} catch (error) {
			console.error(
				`[ProcessTempFile] Failed to start processing workflow: ${error}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start processing: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
