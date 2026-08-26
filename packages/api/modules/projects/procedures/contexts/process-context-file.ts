import { ORPCError } from "@orpc/server";
import {
	createBackgroundJob,
	getContextById,
	hasProjectAccess,
	seedSteps,
	updateContextExtractionStatus,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const processContextFileProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/:contextId/process",
		tags: ["Projects", "Contexts"],
		summary: "Process uploaded context file",
		description:
			"Trigger text extraction and embedding for an uploaded context file via Temporal workflow",
	})
	.input(
		z.object({
			projectId: z.string(),
			contextId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, contextId } = input;
		const user = context.user;

		// Get context first to determine organization
		const projectContext = await getContextById(contextId);
		if (!projectContext) {
			throw new ORPCError("NOT_FOUND", {
				message: "Context not found",
			});
		}

		// Use organizationId from the context record (not from input)
		// This ensures org contexts are processed correctly even if caller doesn't pass org ID
		const organizationId = projectContext.organizationId || undefined;

		// Check project access
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		if (projectContext.projectId !== projectId) {
			throw new ORPCError("FORBIDDEN", {
				message: "Context does not belong to this project",
			});
		}

		// Check if context is in pending state
		if (projectContext.extractionStatus !== "PENDING") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot process context with status: ${projectContext.extractionStatus}`,
			});
		}

		// Update status to extracting (will be updated by workflow)
		await updateContextExtractionStatus(contextId, "EXTRACTING");

		try {
			// Start Temporal workflow for file processing
			const temporalClient = await getTemporalClient();

			// Use deterministic workflow ID for idempotency - same contextId always uses same workflow
			// This prevents duplicate/parallel workflows for the same context
			await temporalClient.workflow.start(
				"projectContextProcessingWorkflow",
				withCorrelationMemo({
					taskQueue: "project-documents",
					workflowId: `project-context-processing-${contextId}`,
					args: [
						{
							contextId,
							projectId,
							userId: user.id,
							organizationId,
							extractionStrategy: "local-only",
						},
					],
				}),
			);

			// Job Hub row is created after the start, not before: the workflow
			// id is deterministic, so a re-invoke while the first run is still
			// going throws WorkflowExecutionAlreadyStartedError below — and
			// creating first would have superseded that live run's row, showing
			// a spurious failure for work that is still progressing fine. A
			// failed start also leaves no row to clean up.
			await createBackgroundJob({
				kind: "CONTEXT_PROCESSING",
				title:
					projectContext.sourceTitle ||
					projectContext.originalFilename ||
					"Document processing",
				projectId,
				userId: user.id,
				organizationId: organizationId ?? null,
				workflowId: `project-context-processing-${contextId}`,
				sourceType: "projectContext",
				sourceId: contextId,
				steps: seedSteps([
					"download",
					"extract",
					"chunk",
					"embed",
					"store",
				]),
			});

			logger.info(
				`[ProcessContextFile] Started processing workflow for context ${contextId}`,
			);

			return {
				success: true,
				contextId,
				status: "EXTRACTING",
				message: "File processing started",
			};
		} catch (error) {
			// Handle WorkflowExecutionAlreadyStartedError - workflow is already running
			// This is expected when using deterministic workflowId for idempotency
			const isAlreadyStarted =
				error instanceof Error &&
				(error.name === "WorkflowExecutionAlreadyStartedError" ||
					error.message?.includes("already started") ||
					error.message?.includes("already exists"));

			if (isAlreadyStarted) {
				logger.info(
					`[ProcessContextFile] Workflow already running for context ${contextId}, returning existing status`,
				);

				// Workflow is already processing - don't revert status, just return current state
				return {
					success: true,
					contextId,
					status: "EXTRACTING",
					message: "File processing already in progress",
				};
			}

			// For other errors, revert status to PENDING. No job row exists to
			// clean up — it is only created once the start succeeds.
			await updateContextExtractionStatus(contextId, "PENDING");

			logger.error(
				`[ProcessContextFile] Failed to start workflow for context ${contextId}: ${error}`,
			);

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start file processing",
			});
		}
	});
