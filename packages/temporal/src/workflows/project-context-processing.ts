/**
 * ProjectContextProcessingWorkflow
 *
 * Durable workflow for processing uploaded project contexts (post-creation uploads):
 * Download → Extract → Chunk → Embed → Store
 *
 * Features:
 * - Automatic retry on transient failures
 * - Exponential backoff
 * - Long-running operation support (10-minute timeout)
 * - Complete execution history for debugging
 * - Multi-tenancy support with user/organization isolation
 *
 * Similar pattern to wizardContextProcessingWorkflow for consistency.
 */

import {
	ApplicationFailure,
	executeChild,
	log,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities";

// Configure activity retry policies
const { updateProjectContextStatus, getProjectContextStatus } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "30s",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

const { processProjectContext, retryProjectContext } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10m", // Long timeout for entire pipeline
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// Activities for document import (called after extraction when context is tagged)
const {
	cleanupImportedContent,
	createImportedDocument,
	failTargetDocument,
	fillTargetDocument,
	issueGenerationToken,
	embedProjectDocumentActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "3m", // Cleanup uses AI, may take longer
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// ============================================================================
// Types
// ============================================================================

export interface ProjectContextProcessingInput {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	extractionStrategy?: string;
	isRetry?: boolean;
}

export interface ProjectContextProcessingOutput {
	success: boolean;
	contextId: string;
	chunkCount?: number;
	extractorUsed?: string;
	qdrantIds?: string[];
	error?: string;
}

type ProjectContextProcessingResult = Awaited<
	ReturnType<typeof processProjectContext>
>;

// ============================================================================
// Workflow
// ============================================================================

/**
 * ProjectContextProcessingWorkflow
 *
 * Processes an uploaded project context through the RAG pipeline:
 * 1. Download from S3
 * 2. Extract text using pluggable extractors
 * 3. Chunk text (2048 char chunks, 200 overlap)
 * 4. Generate embeddings
 * 5. Store in Qdrant with project-based isolation
 *
 * @param input - Workflow input containing context and project details
 * @returns Workflow output with success status and metadata
 */
export async function projectContextProcessingWorkflow(
	input: ProjectContextProcessingInput,
): Promise<ProjectContextProcessingOutput> {
	const {
		contextId,
		projectId,
		userId,
		organizationId,
		extractionStrategy = "local-only",
		isRetry = false,
	} = input;

	log.info("Starting project context processing workflow", {
		contextId,
		projectId,
		userId,
		organizationId,
		extractionStrategy,
		isRetry,
	});

	try {
		// Run the combined processing activity
		const result: ProjectContextProcessingResult = isRetry
			? await retryProjectContext(
					contextId,
					projectId,
					userId,
					organizationId,
					extractionStrategy,
				)
			: await processProjectContext(
					contextId,
					projectId,
					userId,
					organizationId,
					extractionStrategy,
				);

		if (!result.success) {
			log.error("Project context processing failed", {
				error: result.error,
			});

			// Update status to FAILED so UI reflects the failure — but only if
			// extraction didn't already mark it COMPLETED (bug #1039 guard).
			try {
				const currentStatus = await getProjectContextStatus(contextId);
				if (currentStatus !== "COMPLETED") {
					await updateProjectContextStatus(
						contextId,
						"FAILED",
						result.error,
					);
				}
			} catch {
				// Ignore errors when updating status
			}

			throw ApplicationFailure.nonRetryable(
				result.error || "Project context processing failed",
				"PROJECT_CONTEXT_PROCESSING_FAILED",
			);
		}

		log.info("Project context processing workflow completed successfully", {
			chunkCount: result.chunkCount,
			extractorUsed: result.extractorUsed,
			qdrantPointCount: result.qdrantIds.length,
		});

		// Check if this context was tagged as a document type during upload
		// If so, clean up the content and create a ProjectDocument
		if (result.documentTag) {
			log.info(
				"Context tagged as document type, creating imported document",
				{
					documentTag: result.documentTag,
					contextId,
				},
			);

			try {
				// Step 1: Try to clean up extracted text into proper markdown
				// If cleanup fails (e.g., no AI provider), fall back to raw content
				const rawContent = result.extractedContent || "";
				let documentContent = rawContent;

				// Use As-Is means what it says: the supplied content becomes the
				// document without AI modification. This pass adds markdown
				// structure, which is a rewrite — welcome for an ordinary import
				// of an unformatted PDF, and a contract violation here.
				//
				// Gated on the usage the create flow wrote rather than applied
				// globally: an upload from the Context tab or project onboarding
				// carries no usage, so it keeps the formatting it has always had.
				const skipCleanup = result.documentUsage === "AS_IS";

				if (!skipCleanup) {
					try {
						const cleanedContent = await cleanupImportedContent({
							rawContent,
							documentType: result.documentTag,
							documentTitle: result.documentTitle,
							userId,
							organizationId,
							projectId,
						});

						log.info("Content cleanup complete", {
							rawLength: rawContent.length,
							cleanedLength: cleanedContent.length,
						});
						documentContent = cleanedContent;
					} catch (cleanupError) {
						// Cleanup is optional — use raw content if it fails
						const cleanupMsg =
							cleanupError instanceof Error
								? cleanupError.message
								: "Unknown error";
						log.warn(
							"Content cleanup failed, using raw extracted content",
							{
								error: cleanupMsg,
								contextId,
								documentTag: result.documentTag,
							},
						);
					}
				}

				// Kept, though no new upload can reach it: the upload procedure
				// now refuses `documentUsage: "CONTEXT"`, because the run it
				// implies cannot start — the worker holds no AI signing key, and
				// by the time extraction finishes the request that could issue a
				// token is gone.
				//
				// It stays for two reasons. Recorded histories replay through
				// it, and removing a branch a history took is a nondeterminism
				// error, not a cleanup. And a context row written before that
				// refusal shipped still arrives here, where the failure path
				// below marks its document failed instead of leaving it to sit
				// on "generating" — which is exactly what this whole episode
				// was.
				//
				// Use as Context does not write the text anywhere near the
				// document — it hands it to a generation run and lets the model
				// produce the body. The run could not be started when the user
				// submitted, because the file had not been read yet; this is the
				// first moment its text exists.
				//
				// The context row is embedded normally on this path (unlike
				// as-is), because there the source and the finished document are
				// genuinely different texts. It is excluded from *this* run's
				// retrieval, since its content is already being delivered
				// directly — the same rule the pasted-source path follows.
				if (
					result.documentUsage === "CONTEXT" &&
					result.targetDocumentId
				) {
					if (documentContent.trim().length === 0) {
						await failTargetDocument({
							documentId: result.targetDocumentId,
							reason: "The file could not be read, or contained no text. Try creating the document again with a different file.",
						});
						log.warn(
							"No content extracted; target document failed",
							{
								contextId,
								documentId: result.targetDocumentId,
							},
						);
						return {
							success: true,
							contextId,
							chunkCount: result.chunkCount,
							extractorUsed: result.extractorUsed,
							qdrantIds: result.qdrantIds,
						};
					}

					const { aiToken } = await issueGenerationToken({
						userId,
						organizationId,
					});

					// Same queue the API dispatches generation on. A child
					// inherits its parent's queue by default, which would put a
					// long model run on the queue sized for RAG extraction —
					// competing for slots with the very work that feeds it, and
					// diverging from where every other generation runs.
					//
					// Wrapped, because the branch below this one treats a
					// failure as best-effort and swallows it. That is right for
					// an import nobody is waiting on, and wrong here: the
					// document already exists, the user is looking at it, and a
					// swallowed failure leaves it generating with no error and
					// no end. The stale-generation sweep would clear it half an
					// hour later; saying so immediately is better.
					try {
						await executeChild(
							"projectDocumentGenerationWorkflow",
							{
								taskQueue: "project-documents",
								args: [
									{
										projectId,
										documentId: result.targetDocumentId,
										documentType: result.documentTag,
										userId,
										organizationId,
										aiToken,
										prompt: "",
										suppliedContext: documentContent,
										suppliedContextId: contextId,
									},
								],
								workflowId: `document-generation-${result.targetDocumentId}-${contextId}`,
							},
						);

						log.info("Generation completed from extracted file", {
							contextId,
							documentId: result.targetDocumentId,
						});
					} catch (generationError) {
						const msg =
							generationError instanceof Error
								? generationError.message
								: "Unknown error";
						log.error("Generation from extracted file failed", {
							contextId,
							documentId: result.targetDocumentId,
							error: msg,
						});
						await failTargetDocument({
							documentId: result.targetDocumentId,
							reason: "The file was read, but generating the document from it did not finish. You can try creating it again.",
						});
					}

					return {
						success: true,
						contextId,
						chunkCount: result.chunkCount,
						extractorUsed: result.extractorUsed,
						qdrantIds: result.qdrantIds,
					};
				}

				// Step 2: Write the document (proceed even if cleanup failed).
				//
				// Two shapes. When the create flow made a row up front, fill it:
				// its id is already in the URL the dialog navigated to, so a
				// second row would strand the user on an empty one. Otherwise
				// create, exactly as an ordinary tagged import always has.
				if (documentContent.trim().length > 0) {
					let documentId: string;

					if (result.targetDocumentId) {
						const { applied } = await fillTargetDocument({
							documentId: result.targetDocumentId,
							contextId,
							content: documentContent,
							userId,
							organizationId,
						});
						documentId = result.targetDocumentId;
						if (!applied) {
							// The row left GENERATING while we were extracting —
							// edited by hand, or finished by another attempt.
							// Whatever is there now is newer than this, so it
							// stands. Nothing further to do, not even embedding.
							log.info(
								"Target document is no longer generating; leaving it as it stands",
								{ documentId, contextId },
							);
							return {
								success: true,
								contextId,
								chunkCount: result.chunkCount,
								extractorUsed: result.extractorUsed,
								qdrantIds: result.qdrantIds,
							};
						}
					} else {
						({ documentId } = await createImportedDocument({
							projectId,
							contextId,
							documentType: result.documentTag,
							title: result.documentTitle,
							content: documentContent,
							userId,
							organizationId,
						}));
					}

					// Embed the imported document for RAG (best-effort)
					try {
						await embedProjectDocumentActivity({
							documentId,
							userId,
							organizationId,
						});
					} catch (embedError) {
						const embedMsg =
							embedError instanceof Error
								? embedError.message
								: "Unknown error";
						log.warn("Document embedding failed (non-fatal)", {
							error: embedMsg,
							documentId,
						});
					}

					log.info("Imported document created", {
						documentId,
						documentType: result.documentTag,
						usedCleanedContent: documentContent !== rawContent,
					});
				} else if (result.targetDocumentId) {
					// Extraction produced nothing usable — a scan with no OCR, a
					// corrupt or unsupported file. Before the row was created up
					// front this was silent: no document appeared and nothing
					// said why. Now the row the user is already looking at says
					// it, which is what the requirement to warn on an unreadable
					// source actually needs.
					await failTargetDocument({
						documentId: result.targetDocumentId,
						reason: "The file could not be read, or contained no text. Try creating the document again with a different file.",
					});
					log.warn("No content extracted; target document failed", {
						contextId,
						documentId: result.targetDocumentId,
						documentTag: result.documentTag,
					});
				} else {
					log.warn("No content available for document creation", {
						contextId,
						documentTag: result.documentTag,
					});
				}
			} catch (importError) {
				// Document import is best-effort — don't fail the whole workflow
				const errMsg =
					importError instanceof Error
						? importError.message
						: "Unknown error";
				log.warn("Failed to create imported document (non-fatal)", {
					error: errMsg,
					contextId,
					documentTag: result.documentTag,
				});
			}
		}

		return {
			success: true,
			contextId,
			chunkCount: result.chunkCount,
			extractorUsed: result.extractorUsed,
			qdrantIds: result.qdrantIds,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Project context processing workflow failed", {
			error: errorMessage,
		});

		// Defense-in-depth (bug #1039): only flip status to FAILED if it isn't
		// already COMPLETED. The activity is supposed to never throw after
		// content is persisted, but if some future code path does, we won't
		// regress the user-visible status.
		try {
			const currentStatus = await getProjectContextStatus(contextId);
			if (currentStatus !== "COMPLETED") {
				await updateProjectContextStatus(
					contextId,
					"FAILED",
					errorMessage,
				);
			} else {
				log.warn(
					"Workflow caught error after content was persisted; preserving COMPLETED status",
					{ contextId, error: errorMessage },
				);
			}
		} catch {
			// Ignore errors when reading/updating status
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"PROJECT_CONTEXT_PROCESSING_FAILED",
		);
	}
}
