/**
 * BatchDocumentGenerationWorkflow
 *
 * Parent workflow for generating multiple documents in parallel.
 * Delegates core document generation to documentGenerationChildWorkflow
 * for each document while handling:
 * - AgentTask creation and tracking (single task for batch)
 * - Per-document status updates via ProjectDocument.status
 * - Parallel execution with independent failure handling
 *
 * Document Evaluation:
 * - Evaluation runs as fire-and-forget child workflows (documentEvalWorkflow)
 * - Parent doesn't wait for evals - each starts and runs independently
 * - Eval results are persisted independently to the database
 *
 * Use cases:
 * - Initial project setup with multiple documents
 * - Bulk document generation
 */

import {
	ApplicationFailure,
	executeChild,
	log,
	ParentClosePolicy,
	patched,
	proxyActivities,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import { documentEvalWorkflow } from "./document-eval";
import { documentGenerationChildWorkflow } from "./document-generation-child";

// Activities for status tracking (document generation is in child workflow)
const {
	createAgentTask,
	updateAgentTaskWorkflow,
	updateAgentTaskStatus,
	updateProjectDocumentStatus,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "1m",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface BatchDocumentGenerationInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	aiToken: string;
	documents: Array<{
		id: string;
		type: string;
		title: string;
		prompt: string;
		promptId?: string;
	}>;
}

export interface BatchDocumentGenerationOutput {
	success: boolean;
	results: Array<{
		documentId: string;
		status: "success" | "failed";
		error?: string;
		evalWorkflowStarted?: boolean; // Indicates if async eval was started
	}>;
}

// Document generation phases — must match DOCUMENT_TIERS in apps/web.
// `phase` runs sequentially (1 before 2 before 3). `order` sequences docs
// WITHIN a phase (lower first). Business Case leads Phase 1 (AC-11).
export const DOCUMENT_PHASES: Record<string, { phase: number; order: number }> =
	{
		BUSINESS_CASE: { phase: 1, order: 0 },
		PROPOSAL: { phase: 1, order: 1 },
		PRD: { phase: 1, order: 2 },
		GENERAL: { phase: 1, order: 3 },
		ARCHITECTURE: { phase: 2, order: 0 },
		TECHNICAL_SPEC: { phase: 2, order: 1 },
		API_SPEC: { phase: 2, order: 2 },
		USER_STORY: { phase: 3, order: 0 },
	};

/** Groups docs by phase and sorts each phase's docs by intra-phase `order`. */
export function orderDocsByPhase<T extends { type: string }>(
	docs: T[],
): Map<number, T[]> {
	const byPhase = new Map<number, T[]>();
	for (const doc of docs) {
		const phase = DOCUMENT_PHASES[doc.type]?.phase ?? 1;
		if (!byPhase.has(phase)) {
			byPhase.set(phase, []);
		}
		byPhase.get(phase)?.push(doc);
	}
	for (const [, list] of byPhase) {
		list.sort(
			(a, b) =>
				(DOCUMENT_PHASES[a.type]?.order ?? 0) -
				(DOCUMENT_PHASES[b.type]?.order ?? 0),
		);
	}
	return byPhase;
}

/**
 * BatchDocumentGenerationWorkflow
 *
 * Generates documents in sequential phases using child workflows.
 * Phase 1 (PRD, Proposal) completes before Phase 2 (Architecture, Technical Spec, API Spec) starts.
 * Phase 2 completes before Phase 3 (Features/USER_STORY) starts.
 * Within each phase, documents are generated in parallel.
 * Each document generation is independent — one failure doesn't affect others.
 *
 * @param input - Batch generation input with array of documents
 * @returns Output with results for each document
 */
export async function batchDocumentGenerationWorkflow(
	input: BatchDocumentGenerationInput,
): Promise<BatchDocumentGenerationOutput> {
	const { workflowId, runId } = workflowInfo();

	log.info("🚀 Starting batch document generation workflow", {
		projectId: input.projectId,
		userId: input.userId,
		documentCount: input.documents.length,
		workflowId,
		runId,
	});

	// Create single AgentTask for the entire batch
	let agentTaskId: string | undefined;
	try {
		const agentTask = await createAgentTask({
			agentId: "project_document_generator",
			userId: input.userId,
			organizationId: input.organizationId,
			status: "PENDING",
			stage: "initializing",
			input: {
				projectId: input.projectId,
				documentCount: input.documents.length,
				documentTypes: input.documents.map((d) => d.type),
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

		log.info("AgentTask created for batch", { agentTaskId });
	} catch (error) {
		log.warn("Failed to create AgentTask, continuing without tracking", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}

	const results: Array<{
		documentId: string;
		status: "success" | "failed";
		error?: string;
		evalWorkflowStarted?: boolean;
	}> = [];

	// Generate a single document: status updates → child workflow →
	// fire-and-forget eval → results.push. Extracted from the former inline
	// `phaseDocs.map(async (doc) => …)` callback WITHOUT altering its internal
	// activity/child-workflow call sequence, so both the legacy parallel branch
	// and the new ordered-sequential branch below record the same per-doc
	// commands. The only difference the `patched()` gate introduces is
	// parallel-vs-sequential structure across docs within a phase.
	async function generatePhaseDocument(
		doc: (typeof input.documents)[number],
	): Promise<void> {
		const childWorkflowId = `${workflowId}-child-${doc.id}`;

		try {
			// Update status to GENERATING
			await updateProjectDocumentStatus({
				documentId: doc.id,
				status: "GENERATING",
				progress: 0,
			});

			log.info("Starting child workflow for document", {
				documentId: doc.id,
				documentType: doc.type,
				childWorkflowId,
			});

			// Execute child workflow for this document
			const childResult = await executeChild(
				documentGenerationChildWorkflow,
				{
					workflowId: childWorkflowId,
					args: [
						{
							projectId: input.projectId,
							documentId: doc.id,
							documentType: doc.type,
							userId: input.userId,
							organizationId: input.organizationId,
							aiToken: input.aiToken,
							prompt: doc.prompt,
							promptId: doc.promptId,
						},
					],
				},
			);

			// If we reach here, child succeeded (child throws on failure)
			// Start document evaluation as fire-and-forget child workflow
			// The parent doesn't wait for evaluation - it runs independently
			let evalWorkflowStarted = false;

			if (childResult.documentContent) {
				try {
					const evalWorkflowId = `${childWorkflowId}-eval`;

					log.info(
						"Starting document evaluation workflow (fire-and-forget)",
						{
							documentId: doc.id,
							documentType: doc.type,
							evalWorkflowId,
						},
					);

					// Fire-and-forget: start eval workflow but don't wait for it
					// ABANDON policy means the child continues even if parent completes
					await startChild(documentEvalWorkflow, {
						workflowId: evalWorkflowId,
						parentClosePolicy:
							ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
						args: [
							{
								projectDocumentId: doc.id,
								documentContent: childResult.documentContent,
								documentVersion: 1,
								documentType:
									doc.type as import("@repo/database").ProjectDocumentType,
								userId: input.userId,
								organizationId: input.organizationId,
								userPrompt: doc.prompt,
								threshold: 70,
							},
						],
					});

					evalWorkflowStarted = true;

					log.info("Document evaluation workflow started (async)", {
						documentId: doc.id,
						evalWorkflowId,
						status: "started_async",
					});
				} catch (evalError) {
					log.warn(
						"Failed to start document evaluation workflow (non-fatal)",
						{
							documentId: doc.id,
							error:
								evalError instanceof Error
									? evalError.message
									: "Unknown error",
						},
					);
					// Evaluation is optional - don't fail the document generation
				}
			}

			// Update status to COMPLETE
			await updateProjectDocumentStatus({
				documentId: doc.id,
				status: "COMPLETE",
				progress: 100,
			});

			log.info("Document generated successfully", {
				documentId: doc.id,
				documentType: doc.type,
				metrics: childResult.metrics,
				evalWorkflowStarted,
			});

			results.push({
				documentId: doc.id,
				status: "success",
				evalWorkflowStarted,
			});
		} catch (error: unknown) {
			// Child workflow threw an exception
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";

			log.error("Child workflow failed with exception", {
				documentId: doc.id,
				documentType: doc.type,
				error: errorMessage,
			});

			await updateProjectDocumentStatus({
				documentId: doc.id,
				status: "FAILED",
				progress: 0,
				error: errorMessage,
			});

			results.push({
				documentId: doc.id,
				status: "failed",
				error: errorMessage,
			});
		}
	}

	// `patched()` gates the execution-shape change. Old in-flight histories
	// (started before this deploy) take the legacy `Promise.all` parallel path
	// UNCHANGED so their recorded command sequence still replays
	// deterministically. New executions take the ordered sequential path so
	// docs within a phase run in intra-phase `order` (AC-11). See
	// `fabric/standards/backend/temporal.md` + sibling workflows for the idiom.
	const useOrdered = patched("batch-doc-intra-phase-ordering-2026-06-12");

	// Group documents by phase so business docs generate before technical docs,
	// and technical docs generate before features (USER_STORY).
	//
	// DETERMINISM: the two branches must group with DIFFERENT within-phase
	// orderings, and the choice is itself gated by the SAME `patched()` marker.
	//   - Legacy branch: preserve INPUT order within a phase — byte-for-byte the
	//     original manual grouping. Reordering here would change the order in
	//     which `Promise.all`'s `.map()` issues each doc's first command
	//     (`updateProjectDocumentStatus`), breaking replay of old histories.
	//   - Ordered branch: `orderDocsByPhase` sorts within a phase by intra-phase
	//     `order` (Business Case leads Phase 1, AC-11). Only new histories — which
	//     carry the patch marker — ever take this path, so the new command order
	//     is only ever replayed against histories recorded under it.
	let docsByPhase: Map<number, typeof input.documents>;
	if (useOrdered) {
		docsByPhase = orderDocsByPhase(input.documents);
	} else {
		docsByPhase = new Map<number, typeof input.documents>();
		for (const doc of input.documents) {
			const phase = DOCUMENT_PHASES[doc.type]?.phase ?? 1;
			if (!docsByPhase.has(phase)) {
				docsByPhase.set(phase, []);
			}
			docsByPhase.get(phase)?.push(doc);
		}
	}
	const sortedPhases = [...docsByPhase.keys()].sort((a, b) => a - b);

	// Execute each phase sequentially. Within a phase: ordered-sequential when
	// patched, otherwise the legacy parallel `Promise.all`.
	for (const phase of sortedPhases) {
		// biome-ignore lint/style/noNonNullAssertion: docsByPhase.get(phase) is non-null since phase came from docsByPhase.keys()
		const phaseDocs = docsByPhase.get(phase)!;

		log.info("Starting document generation phase", {
			phase,
			documentCount: phaseDocs.length,
			documentTypes: phaseDocs.map((d) => d.type),
			ordered: useOrdered,
		});

		if (useOrdered) {
			for (const doc of phaseDocs) {
				await generatePhaseDocument(doc);
			}
		} else {
			await Promise.all(
				phaseDocs.map((doc) => generatePhaseDocument(doc)),
			);
		}

		log.info("Completed document generation phase", {
			phase,
			documentCount: phaseDocs.length,
		});
	}

	const allSuccess = results.every((r) => r.status === "success");
	const successCount = results.filter((r) => r.status === "success").length;
	const failedCount = results.filter((r) => r.status === "failed").length;

	// Update AgentTask status
	if (agentTaskId) {
		try {
			await updateAgentTaskStatus({
				id: agentTaskId,
				status: allSuccess ? "COMPLETED" : "FAILED",
				result: {
					documentCount: results.length,
					successCount,
					failedCount,
					results,
				},
				completedAt: new Date(),
			});
			log.info("AgentTask updated", {
				agentTaskId,
				status: allSuccess ? "COMPLETED" : "FAILED",
			});
		} catch (error) {
			log.warn("Failed to update AgentTask status", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	log.info("🎉 Batch document generation completed", {
		projectId: input.projectId,
		totalDocuments: results.length,
		successCount,
		failedCount,
		allSuccess,
	});

	// If ALL documents failed, throw so Temporal marks the workflow as FAILED
	if (successCount === 0 && results.length > 0) {
		throw ApplicationFailure.nonRetryable(
			`All ${results.length} documents failed to generate`,
			"BATCH_GENERATION_ALL_FAILED",
		);
	}

	return {
		success: allSuccess,
		results,
	};
}
