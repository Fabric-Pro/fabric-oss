import { ORPCError } from "@orpc/server";
import { getWizardTempContextById } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
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
	.use(requirePermission(Permissions.PROJECT_UPDATE))
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
		const { contextId, organizationId, extractionStrategy } = input;
		const user = context.user;

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
