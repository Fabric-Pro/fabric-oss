/**
 * Activities for wizard context processing workflow
 *
 * Combined pipeline: Download → Extract → Chunk → Embed → Store
 * Similar pattern to workspace-document-activities.ts for durability and offloading
 */

import { getRAGProviderConfig } from "@repo/ai";
import {
	db,
	type ExtractionStatus,
	updateWizardTempContextEmbedding,
	updateWizardTempContextExtraction,
} from "@repo/database";
import {
	chunkProjectContent,
	extractionFactory,
	generateEmbeddings,
	storeWizardContext,
	type TextChunk,
} from "@repo/rag";
import { downloadFile } from "@repo/storage";

// Chunking thresholds
const CHUNKING_THRESHOLD = 2048;
const DEFAULT_CHUNK_SIZE = 2048;
const DEFAULT_CHUNK_OVERLAP = 200;

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
 * Update wizard temp context status in database
 */
export async function updateWizardContextStatus(
	contextId: string,
	status: ExtractionStatus,
	error?: string,
): Promise<void> {
	console.log(
		`[WizardProcessing] Updating context status: ${contextId} -> ${status}`,
	);

	try {
		await updateWizardTempContextExtraction(contextId, {
			extractionStatus: status,
			...(error && { extractionError: error }),
		});

		console.log("[WizardProcessing] Context status updated successfully");
	} catch (err) {
		const errorMessage =
			err instanceof Error ? err.message : "Unknown error";
		console.error(
			`[WizardProcessing] Failed to update context status: ${errorMessage}`,
		);
		throw new Error(
			`Failed to update wizard context ${contextId} status to ${status}: ${errorMessage}`,
		);
	}
}

/**
 * Combined activity: Download, extract, chunk, embed, and store wizard context
 *
 * This runs entirely in the worker, keeping the API server free.
 * Temporal handles retries, timeouts, and failure recovery.
 */
export async function processWizardTempContext(
	contextId: string,
	sessionId: string,
	userId: string,
	organizationId: string | undefined,
	extractionStrategy = "local-only",
): Promise<{
	success: boolean;
	chunkCount: number;
	extractorUsed?: string;
	qdrantIds: string[];
	error?: string;
}> {
	console.log(`[WizardProcessing] Processing wizard context: ${contextId}`);
	console.log(`[WizardProcessing] sessionId: ${sessionId}`);
	console.log(`[WizardProcessing] userId: ${userId}`);
	console.log(`[WizardProcessing] organizationId: ${organizationId}`);

	try {
		// Step 1: Get context metadata
		const orgFilter = organizationId
			? { organizationId }
			: { organizationId: null };

		const context = await db.wizardTempContext.findFirst({
			where: {
				id: contextId,
				sessionId,
				userId,
				...orgFilter,
			},
		});

		if (!context) {
			throw new Error(`Wizard context not found: ${contextId}`);
		}

		if (!context.s3Path) {
			throw new Error(`No S3 path for context: ${contextId}`);
		}

		// Step 2: Update status to EXTRACTING
		await updateWizardContextStatus(contextId, "EXTRACTING");

		// Step 3: Download from storage
		console.log("[WizardProcessing] Downloading from storage");
		const bucket = context.s3Bucket;
		const downloadResult = await downloadFile(context.s3Path, { bucket });
		const buffer = downloadResult.data;
		console.log(
			`[WizardProcessing] Downloaded ${context.originalFilename} (${buffer.length} bytes)`,
		);

		// Step 4: Extract text
		console.log("[WizardProcessing] Extracting text");
		let extractedText: string;
		let extractorUsed: string | undefined;

		try {
			const extractionResult = await extractionFactory.extract(
				buffer,
				context.originalFilename,
				context.mimeType,
				{
					strategy: extractionStrategy as any,
					userId,
					organizationId,
				},
			);
			extractedText = sanitizeTextForStorage(extractionResult.text);
			extractorUsed = extractionResult.extractorUsed;
			console.log(
				`[WizardProcessing] Extracted ${extractedText.length} chars using ${extractorUsed}`,
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
					`[WizardProcessing] Fallback to direct text: ${extractedText.length} chars`,
				);
			} else {
				throw new Error(
					`Failed to extract text: ${extractionError instanceof Error ? extractionError.message : "Unknown error"}`,
				);
			}
		}

		// Same empty-extraction hole as the project-context twin (#1684): if the
		// file parsed cleanly but yielded nothing, persisting "" as COMPLETED
		// gives a green row that can never be retrieved. This path does not have
		// the project-context `extractionPersisted` flag, so a rejected [""]
		// embedding would at least reach the catch below — but only when a
		// provider is configured and only with a raw provider message. With no
		// provider the activity returns success right after the write and the
		// empty row stands. Fail it here instead, before anything is persisted.
		if (!extractedText.trim()) {
			const emptyExtractionMessage =
				"No readable text could be extracted from this file.";
			console.warn(
				`[WizardProcessing] Extraction yielded no text; skipping chunking (contextId: ${contextId}, mimeType: ${context.mimeType})`,
			);
			await updateWizardContextStatus(
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
		await updateWizardTempContextExtraction(contextId, {
			extractionStatus: "COMPLETED",
			content: extractedText,
			extractedAt: new Date(),
		});

		// Step 6: Check if we should embed (need AI provider)
		let providerConfig: Awaited<ReturnType<typeof getRAGProviderConfig>>;
		try {
			providerConfig = await getRAGProviderConfig({
				userId,
				organizationId,
			});
		} catch {
			console.log(
				"[WizardProcessing] No AI provider configured, skipping embedding",
			);
			return {
				success: true,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
			};
		}

		// providerConfig.apiKey is already decrypted by getRAGProviderConfig()
		const apiKey = providerConfig.apiKey;

		// Step 7: Chunk the content
		console.log("[WizardProcessing] Chunking content");
		let chunks: TextChunk[];

		// Same routing as the post-creation upload path. A spec dropped into the
		// project-creation wizard has to be chunked by endpoint too — this used to
		// be a second copy of the MIME strategy, so the same file indexed one way
		// here and another way there, with no error either time (Fizzy #2236).
		const chunkResult = await chunkProjectContent({
			content: extractedText,
			mimeType: context.mimeType,
			filename: context.originalFilename,
			chunkingThreshold: CHUNKING_THRESHOLD,
			chunkSize: DEFAULT_CHUNK_SIZE,
			chunkOverlap: DEFAULT_CHUNK_OVERLAP,
		});

		if (chunkResult.route.kind === "malformed-openapi") {
			const reason = `This file looks like an OpenAPI/Swagger document but could not be read: ${chunkResult.route.reason}`;
			console.warn(`[WizardProcessing] ${reason}`);
			return {
				success: false,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				error: reason,
			};
		}

		chunks = chunkResult.chunks;
		console.log(
			`[WizardProcessing] Created ${chunks.length} chunks (route=${chunkResult.route.kind})`,
		);

		if (chunks.length === 0) {
			console.log("[WizardProcessing] No chunks created");
			return {
				success: true,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
			};
		}

		// Step 8: Generate embeddings
		console.log("[WizardProcessing] Generating embeddings");
		const embeddingResult = await generateEmbeddings(
			chunks.map((c) => c.content),
			{
				userId,
				organizationId,
				tags: ["wizard-context", "rag-embedding"],
			},
			{
				apiKey,
				provider: providerConfig.provider,
				baseUrl: providerConfig.baseUrl,
			},
		);

		// Step 9: Store in Qdrant
		console.log("[WizardProcessing] Storing in Qdrant");
		const qdrantIds: string[] = [];
		const totalChunks = chunks.length;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const embedding = embeddingResult.embeddings[i];

			try {
				const qdrantId = await storeWizardContext({
					contextId,
					sessionId,
					userId,
					organizationId,
					content: chunk.content,
					embedding,
					chunkIndex: i,
					totalChunks,
					metadata: {
						type: chunkResult.contextTypeOverride ?? context.type,
						filename: context.originalFilename,
						mimeType: context.mimeType,
						// Endpoint/model identity on spec chunks; empty otherwise.
						...chunkResult.chunkPayloads[i],
					},
				});
				qdrantIds.push(qdrantId);
			} catch (error) {
				console.error(
					`[WizardProcessing] Failed to store chunk ${i}: ${error}`,
				);
			}
		}

		// Step 10: Update embedding status in DB
		if (qdrantIds.length > 0) {
			await updateWizardTempContextEmbedding(contextId, {
				qdrantId: qdrantIds[0],
				embeddedAt: new Date(),
			});
		}

		console.log(
			`[WizardProcessing] Successfully processed: ${chunks.length} chunks, ${qdrantIds.length} Qdrant points`,
		);

		return {
			success: true,
			chunkCount: chunks.length,
			extractorUsed,
			qdrantIds,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error(
			`[WizardProcessing] Failed to process context: ${errorMessage}`,
		);

		// Update status to FAILED
		try {
			await updateWizardContextStatus(contextId, "FAILED", errorMessage);
		} catch {
			// Ignore errors when updating status
		}

		return {
			success: false,
			chunkCount: 0,
			qdrantIds: [],
			error: errorMessage,
		};
	}
}

/**
 * Retry processing a failed wizard context
 * Cleans up any partial data and reprocesses
 */
export async function retryWizardTempContext(
	contextId: string,
	sessionId: string,
	userId: string,
	organizationId: string | undefined,
	extractionStrategy = "local-only",
): Promise<{
	success: boolean;
	chunkCount: number;
	extractorUsed?: string;
	qdrantIds: string[];
	error?: string;
}> {
	console.log(`[WizardProcessing] Retrying wizard context: ${contextId}`);

	try {
		// Clean up any existing Qdrant data
		try {
			const { deleteWizardContext } = await import("@repo/rag");
			await deleteWizardContext({
				sessionId,
				contextId,
				organizationId,
			});
		} catch {
			// Ignore - may not have been stored yet
		}

		// Reset status - use db directly for nullable fields
		await db.wizardTempContext.update({
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
		return await processWizardTempContext(
			contextId,
			sessionId,
			userId,
			organizationId,
			extractionStrategy,
		);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error(
			`[WizardProcessing] Failed to retry context: ${errorMessage}`,
		);

		return {
			success: false,
			chunkCount: 0,
			qdrantIds: [],
			error: errorMessage,
		};
	}
}
