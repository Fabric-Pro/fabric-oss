/**
 * Activities for workspace document processing workflow
 * Activities are non-deterministic operations that can fail and be retried
 */

import { getSystemRAGProviderConfig } from "@repo/ai";
import {
	createDocumentChunks,
	db,
	getOrCreateRagSettings,
	tenantWhere,
	updateWorkspaceDocument,
	type WorkspaceDocumentStatus,
} from "@repo/database";
import {
	chunkText,
	enrichChunksWithTenantContext,
	extractionFactory,
	generateEmbeddings,
	storeWorkspaceChunksBatch,
	type WorkspaceChunkStoreOptions,
} from "@repo/rag";
import { downloadFile } from "@repo/storage";
import { ApplicationFailure } from "@temporalio/activity";

/**
 * Update workspace document status in database
 *
 * IMPORTANT: This activity throws errors instead of silently swallowing them.
 * Status updates are critical for the UI to know when documents are ready for RAG queries.
 */
export async function updateWorkspaceDocumentStatus(
	documentId: string,
	status: WorkspaceDocumentStatus,
	error?: string,
	metadata?: {
		extractorUsed?: string;
		pageCount?: number;
		wordCount?: number;
		chunkCount?: number;
		qdrantPointIds?: string[];
	},
): Promise<void> {
	console.log(
		`[Activity] Updating workspace document status: ${documentId} -> ${status}`,
	);

	try {
		await updateWorkspaceDocument(documentId, {
			status,
			...(error && { processingError: error }),
			...(metadata?.extractorUsed && {
				extractorUsed: metadata.extractorUsed,
			}),
			...(metadata?.pageCount !== undefined && {
				pageCount: metadata.pageCount,
			}),
			...(metadata?.wordCount !== undefined && {
				wordCount: metadata.wordCount,
			}),
			...(metadata?.chunkCount !== undefined && {
				chunkCount: metadata.chunkCount,
			}),
			...(metadata?.qdrantPointIds && {
				qdrantPointIds: metadata.qdrantPointIds,
			}),
			...(status === "READY" && { embeddedAt: new Date() }),
		});

		console.log(
			"[Activity] Workspace document status updated successfully",
		);
	} catch (err) {
		const errorMessage =
			err instanceof Error ? err.message : "Unknown error";
		console.error(
			`[Activity] Failed to update workspace document status: ${errorMessage}`,
			err,
		);
		// Throw the error so Temporal can retry the activity
		// This is critical - silent failures cause the UI to show "Processing" indefinitely
		throw new Error(
			`Failed to update workspace document ${documentId} status to ${status}: ${errorMessage}`,
		);
	}
}

/**
 * Combined activity: Download, extract, chunk, embed, and store workspace document
 * This avoids transferring large buffers/arrays through Temporal's gRPC
 * which has a 4MB message size limit.
 */
export async function processWorkspaceDocument(
	documentId: string,
	workspaceId: string,
	userId: string,
	organizationId: string | undefined,
	extractionStrategy = "local-only",
): Promise<{
	chunkCount: number;
	extractorUsed?: string;
	extractionTime?: number;
	pageCount?: number;
	wordCount?: number;
	qdrantPointIds: string[];
}> {
	console.log(`[Activity] Processing workspace document: ${documentId}`);
	console.log(`[Activity] workspaceId: ${workspaceId}`);
	console.log(`[Activity] userId: ${userId}`);
	console.log(`[Activity] organizationId: ${organizationId}`);
	console.log(`[Activity] extractionStrategy: ${extractionStrategy}`);

	try {
		// Tenant columns live on `workspace`, not `workspaceDocument` — scope
		// the lookup through the parent row.
		const document = await db.workspaceDocument.findFirst({
			where: {
				id: documentId,
				workspace: {
					id: workspaceId,
					...tenantWhere(userId, organizationId),
				},
			},
		});

		if (!document) {
			throw ApplicationFailure.nonRetryable(
				`Workspace document not found or not accessible for this tenant: ${documentId}`,
				"DOCUMENT_NOT_FOUND",
			);
		}

		// Step 2: Get workspace RAG settings
		const ragSettings = await getOrCreateRagSettings(workspaceId);

		// Step 3: Update status to EXTRACTING
		await updateWorkspaceDocument(documentId, { status: "EXTRACTING" });

		// Step 4: Download document from storage (supports S3, MinIO, and Vercel Blob)
		console.log("[Activity] Downloading document from storage");
		const downloadResult = await downloadFile(document.s3Path, {
			bucket: document.s3Bucket,
		});

		const buffer = downloadResult.data;
		console.log(
			`[Activity] Downloaded ${document.originalFilename} (${buffer.length} bytes)`,
		);

		// Step 5: Extract text
		console.log("[Activity] Extracting text from document");
		const extractionResult = await extractionFactory.extract(
			buffer,
			document.originalFilename,
			document.mimeType,
			{
				strategy: extractionStrategy as any,
				userId,
				organizationId,
			},
		);
		console.log(
			`[Activity] Extracted ${extractionResult.text.length} characters using ${extractionResult.extractorUsed}`,
		);

		// Non-retryable: no text could be extracted from the document
		if (
			!extractionResult.text ||
			extractionResult.text.trim().length === 0
		) {
			throw ApplicationFailure.nonRetryable(
				`No text could be extracted from document: ${document.originalFilename}`,
				"EMPTY_EXTRACTION",
			);
		}

		// Calculate word count
		const wordCount = extractionResult.text
			.split(/\s+/)
			.filter((word) => word.length > 0).length;

		// Step 6: Update status to CHUNKING
		await updateWorkspaceDocument(documentId, {
			status: "CHUNKING",
			extractedText: extractionResult.text,
			extractorUsed: extractionResult.extractorUsed,
			pageCount: extractionResult.pageCount,
			wordCount,
		});

		// Step 7: Chunk the text using workspace RAG settings
		console.log("[Activity] Chunking document");
		const chunks = chunkText(
			extractionResult.text,
			document.originalFilename,
			{
				chunkSize: ragSettings.chunkSize,
				chunkOverlap: ragSettings.chunkOverlap,
			},
		);
		console.log(`[Activity] Created ${chunks.length} chunks`);

		const chunksForEmbedding = await enrichChunksWithTenantContext(chunks, {
			documentContent: extractionResult.text,
			documentTitle: document.originalFilename,
			userId,
			organizationId,
		});
		console.log(
			`[Activity] Contextually enriched ${chunksForEmbedding.length} chunks`,
		);

		if (chunks.length === 0) {
			console.log("[Activity] No chunks created - document may be empty");
			return {
				chunkCount: 0,
				extractorUsed: extractionResult.extractorUsed,
				extractionTime: extractionResult.extractionTime,
				pageCount: extractionResult.pageCount,
				wordCount,
				qdrantPointIds: [],
			};
		}

		// Step 8: Update status to EMBEDDING
		await updateWorkspaceDocument(documentId, { status: "EMBEDDING" });

		// Step 9: Generate embeddings and store chunks using centralized config
		const providerConfig = await getSystemRAGProviderConfig({
			userId,
			organizationId,
		});
		console.log("[Activity] Using centralized AI provider config");

		// Process chunks in batches
		const BATCH_SIZE = 50;
		const allQdrantPointIds: string[] = [];
		const chunksToStore: Array<{
			chunkIndex: number;
			content: string;
			startOffset?: number;
			endOffset?: number;
			pageNumber?: number;
			headings?: string[];
		}> = [];

		for (
			let batchStart = 0;
			batchStart < chunks.length;
			batchStart += BATCH_SIZE
		) {
			const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
			const batchChunks = chunksForEmbedding.slice(batchStart, batchEnd);

			console.log(
				`[Activity] Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}`,
			);

			// Generate embeddings for this batch
			const batchTexts = batchChunks.map(
				(chunk) => chunk.enrichedContent,
			);
			const embeddingResult = await generateEmbeddings(
				batchTexts,
				{
					userId,
					organizationId,
					tags: ["workspace-document", "rag-embedding"],
				},
				providerConfig,
			);

			// Prepare chunks for Qdrant storage
			const qdrantChunks: WorkspaceChunkStoreOptions[] = batchChunks.map(
				(chunk, i) => ({
					chunkId: `${documentId}-${chunk.index}`, // Temporary ID, will be updated after DB insert
					documentId,
					workspaceId,
					userId,
					organizationId,
					content: chunk.originalContent,
					chunkIndex: chunk.index,
					embedding: embeddingResult.embeddings[i],
					filename: document.originalFilename,
					headings: chunk.metadata?.headings || [],
				}),
			);

			// Store in Qdrant
			await updateWorkspaceDocument(documentId, { status: "STORING" });
			const pointIds = await storeWorkspaceChunksBatch({
				chunks: qdrantChunks,
				wait: true,
			});
			allQdrantPointIds.push(...pointIds);

			// Prepare PostgreSQL chunk records
			for (const chunk of batchChunks) {
				chunksToStore.push({
					chunkIndex: chunk.index,
					content: chunk.originalContent,
					headings: chunk.metadata?.headings || [],
				});
			}

			console.log(
				`[Activity] Stored batch ${Math.floor(batchStart / BATCH_SIZE) + 1}, total points: ${allQdrantPointIds.length}`,
			);
		}

		// Step 10: Store chunk records in PostgreSQL
		await createDocumentChunks(documentId, chunksToStore);

		// Note: Last used timestamp is already updated when we fetch the provider config above

		console.log(
			`[Activity] Successfully processed workspace document: ${chunks.length} chunks, ${allQdrantPointIds.length} Qdrant points`,
		);

		return {
			chunkCount: chunks.length,
			extractorUsed: extractionResult.extractorUsed,
			extractionTime: extractionResult.extractionTime,
			pageCount: extractionResult.pageCount,
			wordCount,
			qdrantPointIds: allQdrantPointIds,
		};
	} catch (error) {
		console.error(
			"[Activity] Failed to process workspace document:",
			error,
		);
		// Preserve ApplicationFailure (non-retryable errors) - don't re-wrap them
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		// Transient errors (S3, DB, embedding API) remain retryable
		throw new Error(
			`Failed to process workspace document: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Delete workspace document chunks from Qdrant
 */
export async function deleteWorkspaceDocumentFromQdrant(
	documentId: string,
	workspaceId: string,
): Promise<void> {
	console.log(
		`[Activity] Deleting workspace document from Qdrant: ${documentId}`,
	);

	try {
		const { deleteWorkspaceDocumentChunks } = await import("@repo/rag");
		await deleteWorkspaceDocumentChunks(documentId, workspaceId);
		console.log("[Activity] Successfully deleted document from Qdrant");
	} catch (error) {
		console.error(
			"[Activity] Failed to delete document from Qdrant:",
			error,
		);
		throw new Error(
			`Failed to delete document from Qdrant: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Reprocess a failed workspace document
 * Cleans up any partial data and reprocesses
 */
export async function reprocessWorkspaceDocument(
	documentId: string,
	workspaceId: string,
	userId: string,
	organizationId: string | undefined,
	extractionStrategy = "local-only",
): Promise<{
	chunkCount: number;
	extractorUsed?: string;
	extractionTime?: number;
	pageCount?: number;
	wordCount?: number;
	qdrantPointIds: string[];
}> {
	console.log(`[Activity] Reprocessing workspace document: ${documentId}`);

	try {
		// Clean up any existing Qdrant data
		try {
			await deleteWorkspaceDocumentFromQdrant(documentId, workspaceId);
		} catch {
			// Ignore errors - document may not have been stored yet
		}

		// Clean up PostgreSQL chunks
		await db.workspaceDocumentChunk.deleteMany({
			where: { documentId },
		});

		// Reset document status - use db directly to set null values
		await db.workspaceDocument.update({
			where: { id: documentId },
			data: {
				status: "UPLOADED",
				processingError: null,
				extractedText: null,
				extractorUsed: null,
				pageCount: null,
				wordCount: null,
				qdrantPointIds: [],
				embeddedAt: null,
				chunkCount: 0,
				workflowId: null,
			},
		});

		// Reprocess
		return await processWorkspaceDocument(
			documentId,
			workspaceId,
			userId,
			organizationId,
			extractionStrategy,
		);
	} catch (error) {
		console.error(
			"[Activity] Failed to reprocess workspace document:",
			error,
		);
		// Preserve ApplicationFailure (non-retryable errors) - don't re-wrap them
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		throw new Error(
			`Failed to reprocess workspace document: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
