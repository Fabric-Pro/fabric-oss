/**
 * Activities for project context processing workflow
 *
 * Combined pipeline: Download → Extract → Chunk → Embed → Store
 * Similar pattern to wizard-context-processing.ts but for ProjectContext records
 * (post-creation uploads)
 */

import { getRAGProviderConfig } from "@repo/ai";
import {
	db,
	type ExtractionStatus,
	markContextAsEmbedded,
	updateContextExtractionStatus,
} from "@repo/database";
import {
	chunkProjectContent,
	extractionFactory,
	generateEmbeddings,
	storeProjectContext,
	type TextChunk,
} from "@repo/rag";
import { downloadFile } from "@repo/storage";
import { heartbeat } from "@temporalio/activity";
import {
	JOB_SOURCE,
	JOB_STEPS,
	jobComplete,
	jobEnsure,
	jobFail,
	jobStep,
	seedJobSteps,
} from "./lib/job-progress";

// Chunking thresholds (same as wizard processing)
const CHUNKING_THRESHOLD = 2048;
const DEFAULT_CHUNK_SIZE = 2048;
const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Heartbeat phase → Job Hub step key. The pipeline's phases and the panel's
 * subtask list are the same sequence, so the mapping is 1:1.
 */
const CONTEXT_PHASE_STEPS: Record<string, string> = {
	downloading: "download",
	extracting: "extract",
	chunking: "chunk",
	embedding: "embed",
	storing: "store",
};

/**
 * Mark `step` running and everything before it completed.
 *
 * The pipeline is strictly sequential and only reports the phase it is entering,
 * so reaching a phase is proof the earlier ones finished — without this, every
 * step but the last would still read `pending` when the job completes.
 */
async function advanceContextJobSteps(step: string): Promise<void> {
	const order = JOB_STEPS.contextProcessing as readonly string[];
	const index = order.indexOf(step);
	if (index < 0) {
		return;
	}
	for (const previous of order.slice(0, index)) {
		await jobStep(previous, "completed");
	}
	await jobStep(step, "running");
}

/**
 * Sanitize text content by removing null bytes and other problematic characters
 */
function sanitizeTextForStorage(text: string): string {
	return Array.from(text)
		.filter((char) => {
			const codePoint = char.codePointAt(0);
			if (codePoint === undefined) {
				return false;
			}

			return (
				codePoint !== 0 &&
				codePoint !== 0xfffd &&
				!(codePoint >= 0x01 && codePoint <= 0x08) &&
				codePoint !== 0x0b &&
				codePoint !== 0x0c &&
				!(codePoint >= 0x0e && codePoint <= 0x1f)
			);
		})
		.join("");
}

/**
 * Read the current extractionStatus of a project context.
 *
 * Used by the workflow's outer catch as a defense-in-depth check (bug #1039):
 * if a future code change throws AFTER content has been persisted (status =
 * COMPLETED), we don't want the catch to overwrite that success with FAILED.
 */
export async function getProjectContextStatus(
	contextId: string,
): Promise<ExtractionStatus | null> {
	const row = await db.projectContext.findUnique({
		where: { id: contextId },
		select: { extractionStatus: true },
	});
	return row?.extractionStatus ?? null;
}

/**
 * Update project context status in database
 */
export async function updateProjectContextStatus(
	contextId: string,
	status: ExtractionStatus,
	error?: string,
): Promise<void> {
	console.log(
		`[ProjectContextProcessing] Updating context status: ${contextId} -> ${status}`,
	);

	// Job Hub: both the activity's own failure path and the workflow's
	// defense-in-depth catch route through here, so one hook covers every way a
	// context can end up FAILED. No-op when no job row is open.
	if (status === "FAILED") {
		await jobFail(error ?? "Processing failed", { sourceId: contextId });
	}

	try {
		await updateContextExtractionStatus(contextId, status, {
			...(error && { extractionError: error }),
		});

		console.log(
			"[ProjectContextProcessing] Context status updated successfully",
		);
	} catch (err) {
		const errorMessage =
			err instanceof Error ? err.message : "Unknown error";
		console.error(
			`[ProjectContextProcessing] Failed to update context status: ${errorMessage}`,
		);
		throw new Error(
			`Failed to update project context ${contextId} status to ${status}: ${errorMessage}`,
		);
	}
}

interface ProcessProjectContextResult {
	success: boolean;
	chunkCount: number;
	extractorUsed?: string;
	qdrantIds: string[];
	error?: string;
	documentTag?: string;
	documentTitle?: string;
	/** How the upload is meant to be used, when it came from the create flow. */
	documentUsage?: "AS_IS" | "CONTEXT";
	/** A document row created before the upload, for the workflow to fill in. */
	targetDocumentId?: string;
	extractedContent?: string;
	embedded?: boolean;
	embeddingError?: string;
}

/**
 * Combined activity: Download, extract, chunk, embed, and store project context
 *
 * This runs entirely in the worker, keeping the API server free.
 * Temporal handles retries, timeouts, and failure recovery.
 *
 * Job Hub closure is owned by this wrapper rather than by the pipeline's own
 * return sites. The pipeline has several success-returning early exits — no AI
 * provider configured, nothing to chunk, a partial Qdrant store, a
 * post-extraction glitch after content was persisted — and each one that forgot
 * to close its row left the job RUNNING until the watchdog stamped it "Timed
 * out", reporting a failure for a document the user can actually search.
 * Closing here means a future early return cannot reintroduce that.
 */
export async function processProjectContext(
	contextId: string,
	projectId: string,
	userId: string,
	organizationId: string | undefined,
	extractionStrategy = "local-only",
): Promise<ProcessProjectContextResult> {
	const result = await runProjectContextPipeline(
		contextId,
		projectId,
		userId,
		organizationId,
		extractionStrategy,
	);

	if (result.success) {
		// The failure path is already covered: `updateProjectContextStatus`
		// fails the job whenever the status goes to FAILED.
		await jobStep("store", "completed");
		await jobComplete({
			counts: {
				chunksCreated: result.chunkCount,
				embedded: result.qdrantIds.length,
			},
		});
	}

	return result;
}

async function runProjectContextPipeline(
	contextId: string,
	projectId: string,
	userId: string,
	organizationId: string | undefined,
	extractionStrategy = "local-only",
): Promise<ProcessProjectContextResult> {
	console.log(
		`[ProjectContextProcessing] Processing project context: ${contextId}`,
	);
	console.log(`[ProjectContextProcessing] projectId: ${projectId}`);
	console.log(`[ProjectContextProcessing] userId: ${userId}`);
	console.log(`[ProjectContextProcessing] organizationId: ${organizationId}`);

	// Helper to send heartbeat safely (prevents timeout during long operations).
	// Job Hub subtasks ride along on the same phase boundaries: the panel's step
	// list is exactly this pipeline, so there is one place to keep in sync.
	const safeHeartbeat = (phase: string) => {
		try {
			heartbeat({ phase, contextId });
		} catch {
			// Not in activity context (e.g., testing) - ignore
		}
		const step = CONTEXT_PHASE_STEPS[phase];
		if (step) {
			// Fire-and-forget: the writers swallow their own errors, and a
			// progress update must never delay the pipeline it reports on.
			void advanceContextJobSteps(step);
		}
	};

	// Bug #1039: once we set status to COMPLETED + persist content, downstream
	// failures (chunking / embedding / Qdrant) must NOT flip the row back to FAILED.
	// The user already sees a successful upload (file is downloadable, content
	// indexed in DB); embedding is a best-effort RAG enhancement.
	let extractionPersisted = false;
	let extractedTextForRecovery = "";
	let extractorUsedForRecovery: string | undefined;
	let documentTagForRecovery: string | undefined;
	let documentTitleForRecovery: string | undefined;

	try {
		safeHeartbeat("starting");

		// Step 1: Get context metadata with tenant isolation
		// For org contexts: Access control is verified at the API layer via hasProjectAccess()
		// before starting the workflow, so we don't filter by userId here (any org member
		// with project access can process/retry contexts).
		// For personal contexts: We include userId to ensure only the owner can process.
		const orgFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId };

		const context = await db.projectContext.findFirst({
			where: {
				id: contextId,
				projectId,
				...orgFilter,
			},
		});

		if (!context) {
			throw new Error(`Project context not found: ${contextId}`);
		}

		// Job Hub: the starting procedure pre-creates this row so the panel
		// reflects the upload immediately; this is the safety net for paths that
		// start the workflow without one (ensure adopts an existing open row).
		await jobEnsure({
			kind: "CONTEXT_PROCESSING",
			title:
				context.sourceTitle ||
				context.originalFilename ||
				"Document processing",
			projectId,
			userId,
			organizationId,
			sourceType: JOB_SOURCE.projectContext,
			sourceId: contextId,
			steps: seedJobSteps([...JOB_STEPS.contextProcessing]),
		});

		if (!context.s3Path) {
			throw new Error(`No S3 path for context: ${contextId}`);
		}

		// Extract document tag from metadata (set during wizard upload)
		const contextMetadata = context.metadata as Record<
			string,
			unknown
		> | null;
		const documentTag = contextMetadata?.documentTag as string | undefined;
		// Companions to the tag, written by the Documents-tab create flow. Absent
		// for a Context-tab upload, which is what keeps that path on its old
		// behaviour without a version gate.
		const documentUsage = contextMetadata?.documentUsage as
			| "AS_IS"
			| "CONTEXT"
			| undefined;
		const targetDocumentId = contextMetadata?.targetDocumentId as
			| string
			| undefined;
		const documentTitle =
			(contextMetadata?.documentTitle as string | undefined) ||
			context.sourceTitle ||
			undefined;

		// Step 2: Update status to EXTRACTING
		await updateProjectContextStatus(contextId, "EXTRACTING");

		// Step 3: Download from storage
		safeHeartbeat("downloading");
		console.log("[ProjectContextProcessing] Downloading from storage");
		if (!context.s3Bucket) {
			throw new Error(`No S3 bucket for context: ${contextId}`);
		}
		const downloadResult = await downloadFile(context.s3Path, {
			bucket: context.s3Bucket,
		});
		const buffer = downloadResult.data;
		console.log(
			`[ProjectContextProcessing] Downloaded ${context.originalFilename} (${buffer.length} bytes)`,
		);

		// Step 4: Extract text
		safeHeartbeat("extracting");
		console.log("[ProjectContextProcessing] Extracting text");
		let extractedText: string;
		let extractorUsed: string | undefined;

		try {
			const extractionResult = await extractionFactory.extract(
				buffer,
				context.originalFilename || "unknown",
				context.mimeType || "application/octet-stream",
				{
					strategy: extractionStrategy as
						| "local-only"
						| "external-only"
						| "prefer-external"
						| "cost-optimized"
						| "quality-optimized",
					userId,
					organizationId,
				},
			);
			extractedText = sanitizeTextForStorage(extractionResult.text);
			extractorUsed = extractionResult.extractorUsed;
			console.log(
				`[ProjectContextProcessing] Extracted ${extractedText.length} chars using ${extractorUsed}`,
			);
		} catch (extractionError) {
			// Fallback for plain text
			if (
				context.mimeType === "text/plain" ||
				context.mimeType === "text/markdown"
			) {
				extractedText = sanitizeTextForStorage(
					buffer.toString("utf-8"),
				);
				extractorUsed = "direct-text";
				console.log(
					`[ProjectContextProcessing] Fallback to direct text: ${extractedText.length} chars`,
				);
			} else {
				throw new Error(
					`Failed to extract text: ${extractionError instanceof Error ? extractionError.message : "Unknown error"}`,
				);
			}
		}

		// A document that parsed cleanly but yielded no text is not a healthy
		// context, and must not be recorded as one (#1684). Persisting "" as
		// COMPLETED produces a single empty chunk, the embedding provider
		// rejects [""], and that rejection is swallowed by the
		// `extractionPersisted` branch of the catch below — leaving a green row
		// that can never be retrieved and never signals anything went wrong.
		// Realistic for HTML in particular: an SPA export or a "please enable
		// JavaScript" shell is all <script> and <style>. Fail it here, before
		// anything is persisted, so the user sees why and a retry is possible.
		if (!extractedText.trim()) {
			const emptyExtractionMessage =
				"No readable text could be extracted from this file.";
			console.warn(
				`[ProjectContextProcessing] Extraction yielded no text; skipping chunking (contextId: ${contextId}, mimeType: ${context.mimeType ?? "unknown"})`,
			);
			await updateProjectContextStatus(
				contextId,
				"FAILED",
				emptyExtractionMessage,
			);
			return {
				success: false,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				error: emptyExtractionMessage,
			};
		}

		// Step 5: Update DB with extracted content
		await updateContextExtractionStatus(contextId, "COMPLETED", {
			content: extractedText,
		});

		// From this point on, failures must not flip status back to FAILED (bug #1039).
		extractionPersisted = true;
		extractedTextForRecovery = extractedText;
		extractorUsedForRecovery = extractorUsed;
		documentTagForRecovery = documentTag;
		documentTitleForRecovery = documentTitle;

		// Use As-Is stops here: the extracted text becomes the document body, and
		// the document is what retrieval reads. Embedding the context row too
		// would put the same words in the corpus twice, forever, for every future
		// generation of every type — the duplication the pasted-source path
		// already avoids by not embedding its own row. The row still exists and
		// still holds the original; it is simply not separately retrievable.
		if (documentUsage === "AS_IS") {
			console.log(
				"[ProjectContextProcessing] As-is upload — skipping embedding; the document carries the text",
			);
			return {
				success: true,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				documentTag,
				documentUsage,
				targetDocumentId,
				documentTitle,
				extractedContent: extractedText.slice(0, 500_000),
				embedded: false,
			};
		}

		// Step 6: Check if we should embed (need AI provider)
		let providerConfig: Awaited<ReturnType<typeof getRAGProviderConfig>>;
		try {
			providerConfig = await getRAGProviderConfig({
				userId,
				organizationId,
			});
		} catch (providerError) {
			// Only skip embedding if it's a "not configured" error
			// Re-throw transient DB/decryption errors so Temporal can retry
			const errorMessage =
				providerError instanceof Error
					? providerError.message
					: String(providerError);
			if (
				errorMessage.includes("No AI provider configured") ||
				errorMessage.includes("Please configure") ||
				errorMessage.includes("not configured")
			) {
				console.log(
					"[ProjectContextProcessing] No AI provider configured, skipping embedding",
				);
				return {
					success: true,
					chunkCount: 0,
					extractorUsed,
					qdrantIds: [],
					documentTag,
					documentUsage,
					targetDocumentId,
					documentTitle,
					extractedContent: documentTag
						? extractedText.slice(0, 500_000)
						: undefined,
				};
			}
			// Re-throw other errors (transient DB, decryption, etc.) for retry
			throw providerError;
		}

		// providerConfig.apiKey is already decrypted by getRAGProviderConfig()
		const apiKey = providerConfig.apiKey;

		// Step 7: Chunk the content
		safeHeartbeat("chunking");
		console.log("[ProjectContextProcessing] Chunking content");
		let chunks: TextChunk[];

		const chunkResult = await chunkProjectContent({
			content: extractedText,
			mimeType: context.mimeType || "",
			filename: context.originalFilename || contextId,
			chunkingThreshold: CHUNKING_THRESHOLD,
			chunkSize: DEFAULT_CHUNK_SIZE,
			chunkOverlap: DEFAULT_CHUNK_OVERLAP,
		});

		// A file that declares itself an OpenAPI document and then fails to parse
		// is a failure the user must see. Chunking it as text would "succeed"
		// while quietly indexing a broken document as prose (Fizzy #2236, FR8).
		if (chunkResult.route.kind === "malformed-openapi") {
			const reason = `This file looks like an OpenAPI/Swagger document but could not be read: ${chunkResult.route.reason}`;
			console.warn(`[ProjectContextProcessing] ${reason}`);
			// Routed through `updateProjectContextStatus` rather than a raw
			// `db.update`: that helper is the single hook every FAILED goes
			// through, and it is what fires `jobFail`. Writing the row directly
			// would leave the Job Hub entry open until the watchdog stamped it
			// "Timed out" — the failure the pipeline wrapper documents itself as
			// existing to prevent.
			await updateProjectContextStatus(contextId, "FAILED", reason);
			return {
				success: false,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				error: reason,
			};
		}

		chunks = chunkResult.chunks;
		// A detected spec is stored as API_SPEC so retrieval and the UI can tell
		// it apart from an ordinary uploaded file. The row is NOT stamped yet —
		// see the write after the store loop. Stamping here would leave a row
		// claiming to be endpoint-indexed while a failed embed produced zero
		// chunks, and this pipeline reports that state as a *success* (content is
		// already persisted, so the outer catch deliberately keeps COMPLETED).
		// The type is a claim about the index; only make it once the index exists.
		const resolvedContextType =
			chunkResult.contextTypeOverride ?? context.type;
		console.log(
			`[ProjectContextProcessing] Created ${chunks.length} chunks (route=${chunkResult.route.kind})`,
		);

		if (chunks.length === 0) {
			console.log("[ProjectContextProcessing] No chunks created");
			return {
				success: true,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				documentTag,
				documentUsage,
				targetDocumentId,
				documentTitle,
				extractedContent: documentTag
					? extractedText.slice(0, 500_000)
					: undefined,
			};
		}

		// Step 8: Generate embeddings
		safeHeartbeat("embedding");
		console.log("[ProjectContextProcessing] Generating embeddings");
		const embeddingResult = await generateEmbeddings(
			chunks.map((c) => c.content),
			{
				userId,
				organizationId,
				projectId,
				tags: ["project-context", "rag-embedding"],
			},
			{
				apiKey,
				provider: providerConfig.provider,
				baseUrl: providerConfig.baseUrl,
			},
		);

		// Step 9: Store in Qdrant
		safeHeartbeat("storing");
		console.log("[ProjectContextProcessing] Storing in Qdrant");
		const qdrantIds: string[] = [];
		const totalChunks = chunks.length;
		let failedChunks = 0;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const embedding = embeddingResult.embeddings[i];

			try {
				// Use contextId-chunkIndex as unique ID for each chunk
				// Store original contextId in payload for retrieval (retrieval strips -chunk-N suffix)
				const chunkContextId =
					chunks.length > 1 ? `${contextId}-chunk-${i}` : contextId;

				const qdrantId = await storeProjectContext({
					contextId: chunkContextId,
					projectId,
					userId,
					organizationId,
					content: chunk.content,
					embedding,
					metadata: {
						type: resolvedContextType,
						filename: context.originalFilename || undefined,
						chunkIndex: i,
						totalChunks,
						// Store original contextId for retrieval mapping
						originalContextId: contextId,
						// Endpoint/model identity on spec chunks; empty otherwise.
						...chunkResult.chunkPayloads[i],
					},
				});
				qdrantIds.push(qdrantId);
			} catch (error) {
				failedChunks++;
				console.error(
					`[ProjectContextProcessing] Failed to store chunk ${i}: ${error}`,
				);
			}
		}

		// Now that endpoint chunks actually exist in Qdrant, the row may claim to
		// be one. Deliberately after the store loop rather than before it: this
		// pipeline treats a failed embed as a success (the file is persisted and
		// downloadable), so stamping the type earlier would leave a row that says
		// "indexed by endpoint" with nothing indexed and a green job to match.
		if (chunkResult.contextTypeOverride && qdrantIds.length > 0) {
			await db.projectContext.update({
				where: { id: contextId },
				data: { type: chunkResult.contextTypeOverride },
			});
		}

		// If any chunks failed to store, log a warning but do NOT throw.
		// Content is already persisted (status COMPLETED), so the user sees a
		// successful upload. Partial Qdrant indexing only degrades RAG search
		// quality, which is best-effort.
		if (failedChunks > 0) {
			const partialMsg =
				`Failed to store ${failedChunks}/${totalChunks} chunks in Qdrant. ` +
				`Successfully stored: ${qdrantIds.length}.`;
			console.warn(`[ProjectContextProcessing] ${partialMsg}`);
			return {
				success: true,
				chunkCount: chunks.length,
				extractorUsed,
				qdrantIds,
				documentTag,
				documentUsage,
				targetDocumentId,
				documentTitle,
				extractedContent: documentTag
					? extractedText.slice(0, 500_000)
					: undefined,
				embedded: false,
				embeddingError: partialMsg,
			};
		}

		// Step 10: Update embedding status in DB (only if ALL chunks succeeded)
		if (qdrantIds.length > 0) {
			await markContextAsEmbedded(contextId, qdrantIds[0]);
		}

		console.log(
			`[ProjectContextProcessing] Successfully processed: ${chunks.length} chunks, ${qdrantIds.length} Qdrant points`,
		);

		return {
			success: true,
			chunkCount: chunks.length,
			extractorUsed,
			qdrantIds,
			documentTag,
			documentUsage,
			targetDocumentId,
			documentTitle,
			extractedContent: documentTag
				? extractedText.slice(0, 500_000)
				: undefined,
			embedded: qdrantIds.length > 0,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		// Bug #1039: distinguish "extraction failed" (real failure) from
		// "post-extraction step failed" (best-effort embedding glitch).
		// If content is already persisted, we MUST NOT flip status to FAILED —
		// the user has a working, indexed file; embedding is a separate concern.
		if (extractionPersisted) {
			console.warn(
				`[ProjectContextProcessing] Post-extraction step failed (status remains COMPLETED): ${errorMessage}`,
			);
			return {
				success: true,
				chunkCount: 0,
				extractorUsed: extractorUsedForRecovery,
				qdrantIds: [],
				documentTag: documentTagForRecovery,
				documentTitle: documentTitleForRecovery,
				extractedContent: documentTagForRecovery
					? extractedTextForRecovery.slice(0, 500_000)
					: undefined,
				embedded: false,
				embeddingError: errorMessage,
			};
		}

		console.error(
			`[ProjectContextProcessing] Failed to process context: ${errorMessage}`,
		);

		// Update status to FAILED (best-effort)
		try {
			await updateProjectContextStatus(contextId, "FAILED", errorMessage);
		} catch {
			// Ignore errors when updating status
		}

		// IMPORTANT: Rethrow the error so Temporal can apply retry policy
		// Returning { success: false } would make Temporal treat this as a successful activity
		throw error;
	}
}

/**
 * Retry processing a failed project context
 * Cleans up any partial data and reprocesses
 */
export async function retryProjectContext(
	contextId: string,
	projectId: string,
	userId: string,
	organizationId: string | undefined,
	extractionStrategy = "local-only",
): Promise<{
	success: boolean;
	chunkCount: number;
	extractorUsed?: string;
	qdrantIds: string[];
	error?: string;
	documentTag?: string;
	documentTitle?: string;
	/** How the upload is meant to be used, when it came from the create flow. */
	documentUsage?: "AS_IS" | "CONTEXT";
	/** A document row created before the upload, for the workflow to fill in. */
	targetDocumentId?: string;
	extractedContent?: string;
}> {
	console.log(
		`[ProjectContextProcessing] Retrying project context: ${contextId}`,
	);

	try {
		// Clean up any existing Qdrant data
		try {
			const { deleteProjectContext } = await import("@repo/rag");
			await deleteProjectContext(contextId, organizationId);
		} catch {
			// Ignore - may not have been stored yet
		}

		// Reset status - use db directly for nullable fields
		await db.projectContext.update({
			where: { id: contextId },
			data: {
				extractionStatus: "PENDING",
				extractionError: null,
				content: "",
				extractedAt: null,
				qdrantId: null,
				embeddedAt: null,
			},
		});

		// Reprocess
		return await processProjectContext(
			contextId,
			projectId,
			userId,
			organizationId,
			extractionStrategy,
		);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error(
			`[ProjectContextProcessing] Failed to retry context: ${errorMessage}`,
		);

		// IMPORTANT: Rethrow the error so Temporal can apply retry policy
		// Returning { success: false } would make Temporal treat this as a successful activity
		throw error;
	}
}
