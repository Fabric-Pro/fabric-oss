/**
 * ProjectDocumentGenerationWorkflow
 *
 * Parent workflow for single document generation/regeneration.
 * Delegates core document generation to documentGenerationChildWorkflow
 * while handling:
 * - AgentTask creation and tracking
 * - ProjectWorkflowStatus updates
 * - Detailed logging and metrics
 *
 * Document Evaluation:
 * - Evaluation runs as a fire-and-forget child workflow (documentEvalWorkflow)
 * - Parent doesn't wait for eval - it starts eval and completes immediately
 * - Eval results are persisted independently to the database
 *
 * Use cases:
 * - Regenerating an existing document
 * - Generating a single document with custom prompt
 */

import {
	ApplicationFailure,
	executeChild,
	log,
	ParentClosePolicy,
	proxyActivities,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	ProjectDocumentGenerationInput,
	ProjectDocumentGenerationOutput,
} from "../types";
import { documentEvalWorkflow } from "./document-eval";
import { documentGenerationChildWorkflow } from "./document-generation-child";

// Activities for status tracking (not document generation - that's in child workflow)
const {
	createAgentTask,
	updateAgentTaskWorkflow,
	updateAgentTaskStatus,
	updateProjectWorkflowStatus,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "1m",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * ProjectDocumentGenerationWorkflow
 *
 * Generates a project document using RAG contexts and LangGraph agent.
 * This is the parent workflow that handles tracking and status updates.
 *
 * @param input - Workflow input containing project and document details
 * @returns Workflow output with generated document
 */
export async function projectDocumentGenerationWorkflow(
	input: ProjectDocumentGenerationInput,
): Promise<ProjectDocumentGenerationOutput> {
	const {
		projectId,
		documentId,
		documentType,
		userId,
		organizationId,
		aiToken,
		prompt,
		promptId,
		promptVersionId,
		currentDocument,
		suppliedContext,
		excludeContextId,
	} = input;
	const { workflowId, runId } = workflowInfo();
	const startTime = Date.now();

	log.info("🚀 WORKFLOW STARTED: Project Document Generation", {
		projectId,
		documentId,
		documentType,
		userId,
		organizationId,
		workflowId,
		runId,
		hasCustomPrompt: !!promptId,
		hasCurrentDocument: !!currentDocument,
		isRegeneration: !!currentDocument,
		hasSuppliedContext: !!suppliedContext,
		status: "started",
		timestamp: new Date().toISOString(),
	});

	let agentTaskId: string | undefined;

	try {
		// Create AgentTask record for tracking
		try {
			const agentTask = await createAgentTask({
				agentId: "project_document_generator",
				userId,
				organizationId,
				status: "PENDING",
				stage: "initializing",
				input: {
					projectId,
					documentId,
					documentType,
					prompt,
				},
				framework: "langgraph",
			});
			agentTaskId = agentTask.id;

			await updateAgentTaskWorkflow({
				id: agentTaskId,
				workflowId,
				runId,
			});

			await updateAgentTaskStatus({
				id: agentTaskId,
				status: "RUNNING",
			});

			log.info("AgentTask created", { agentTaskId });
		} catch (taskError) {
			log.warn(
				"Failed to create AgentTask, continuing without tracking",
				{
					error:
						taskError instanceof Error
							? taskError.message
							: "Unknown error",
				},
			);
		}

		// Update workflow status to RUNNING
		log.info("Updating workflow status to RUNNING");
		await updateProjectWorkflowStatus(
			projectId,
			workflowId,
			runId,
			"RUNNING",
		);

		// Execute child workflow for document generation
		log.info("Executing document generation child workflow", {
			documentId,
			documentType,
		});

		const childResult = await executeChild(
			documentGenerationChildWorkflow,
			{
				workflowId: `${workflowId}-child-${documentId}`,
				args: [
					{
						projectId,
						documentId,
						documentType,
						userId,
						organizationId,
						aiToken,
						prompt,
						promptId,
						promptVersionId,
						currentDocument,
						// Both of these are enumerated deliberately. This args
						// object is NOT a spread of `input` — every field the
						// child needs has to be named here, and the API starts
						// this workflow by string name with untyped args, so a
						// field added to the child's input and forgotten here
						// raises no type error anywhere. It simply never
						// arrives, and the feature dies quietly with every unit
						// test green. `supplied-context-wiring.test.ts` pins
						// this call for exactly that reason.
						suppliedContext, // joined into the child's context array, never over it
						excludeContextId, // filtered out of this run's retrieval
					},
				],
			},
		);

		// If we reach here, child succeeded (child throws on failure)
		// Step 5: Start document evaluation as fire-and-forget child workflow
		// The parent doesn't wait for evaluation - it runs independently
		if (childResult.documentContent) {
			try {
				log.info(
					"📊 STEP 5: Starting document evaluation workflow (fire-and-forget)",
					{
						documentId,
						documentType,
						step: "document_evaluation",
					},
				);

				// Fire-and-forget: start eval workflow but don't wait for it
				// ABANDON policy means the child continues even if parent completes
				await startChild(documentEvalWorkflow, {
					workflowId: `${workflowId}-eval-${documentId}`,
					parentClosePolicy:
						ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
					args: [
						{
							projectDocumentId: documentId,
							documentContent: childResult.documentContent,
							documentVersion: 1,
							documentType:
								documentType as import("@repo/database").ProjectDocumentType,
							userId,
							organizationId,
							userPrompt: prompt,
							threshold: 70,
						},
					],
				});

				log.info(
					"✅ STEP 5 COMPLETE: Document evaluation workflow started (async)",
					{
						step: "document_evaluation",
						evalWorkflowId: `${workflowId}-eval-${documentId}`,
						status: "started_async",
					},
				);
			} catch (evalError) {
				log.warn(
					"Failed to start document evaluation workflow (non-fatal)",
					{
						error:
							evalError instanceof Error
								? evalError.message
								: "Unknown error",
					},
				);
				// Non-fatal - evaluation is optional
			}
		}

		// Update workflow status to COMPLETED
		log.info("Updating workflow status to COMPLETED");
		await updateProjectWorkflowStatus(
			projectId,
			workflowId,
			runId,
			"COMPLETED",
		);

		// Update AgentTask status to COMPLETED
		if (agentTaskId) {
			try {
				await updateAgentTaskStatus({
					id: agentTaskId,
					status: "COMPLETED",
					result: {
						documentId,
						documentType,
						contentLength: childResult.metrics.documentLength,
						wordCount: childResult.metrics.wordCount,
						contextCount: childResult.metrics.contextCount,
						episodeCount: childResult.metrics.episodeCount,
					},
					completedAt: new Date(),
				});
				log.info("AgentTask completed", { agentTaskId });
			} catch (taskError) {
				log.warn("Failed to update AgentTask status", {
					error:
						taskError instanceof Error
							? taskError.message
							: "Unknown error",
				});
			}
		}

		const totalDuration = Date.now() - startTime;
		log.info("🎉 WORKFLOW COMPLETED SUCCESSFULLY", {
			projectId,
			documentId,
			documentType,
			documentLength: childResult.metrics.documentLength,
			wordCount: childResult.metrics.wordCount,
			totalDurationMs: totalDuration,
			totalDurationSeconds: (totalDuration / 1000).toFixed(2),
			status: "completed",
			metrics: childResult.metrics,
			evaluationStarted: !!childResult.documentContent,
			note: "Evaluation runs asynchronously as a separate workflow",
		});

		return {
			success: true,
			documentId,
			documentContent: childResult.documentContent,
			// Note: evaluation is no longer returned here - it runs asynchronously
			// Check DocumentEval table for results
		};
	} catch (err) {
		const totalDuration = Date.now() - startTime;
		const error = err instanceof Error ? err.message : "Unknown error";

		log.error("❌ WORKFLOW FAILED", {
			error,
			projectId,
			documentId,
			documentType,
			totalDurationMs: totalDuration,
			totalDurationSeconds: (totalDuration / 1000).toFixed(2),
			status: "failed",
			...(err instanceof Error && {
				stack: err.stack,
				errorName: err.name,
			}),
		});

		// Update workflow status to FAILED
		try {
			await updateProjectWorkflowStatus(
				projectId,
				workflowId,
				runId,
				"FAILED",
			);
		} catch (statusError) {
			log.error("Failed to update workflow status", {
				error:
					statusError instanceof Error
						? statusError.message
						: "Unknown error",
			});
		}

		// Update AgentTask status to FAILED
		if (agentTaskId) {
			try {
				await updateAgentTaskStatus({
					id: agentTaskId,
					status: "FAILED",
					error,
					completedAt: new Date(),
				});
				log.info("AgentTask failed", { agentTaskId });
			} catch (taskError) {
				log.warn("Failed to update AgentTask status", {
					error:
						taskError instanceof Error
							? taskError.message
							: "Unknown error",
				});
			}
		}

		throw ApplicationFailure.nonRetryable(
			error,
			"DOCUMENT_GENERATION_FAILED",
		);
	}
}
