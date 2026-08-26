/**
 * Activities for document processing workflow
 * Activities are non-deterministic operations that can fail and be retried
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getRAGProviderConfig } from "@repo/ai";
import { db, tenantWhere } from "@repo/database";
import type { ExtractionResult, TextChunk } from "@repo/rag";
import {
	chunkText,
	extractionFactory,
	generateEmbeddings,
	storeChunk,
} from "@repo/rag";

/**
 * Sanitize text content by removing null bytes and other problematic characters
 * that PostgreSQL cannot store in text fields (UTF8 encoding issues)
 */
function sanitizeTextForStorage(text: string): string {
	// Remove null bytes that cause "invalid byte sequence for encoding UTF8: 0x00"
	// Also remove replacement character and other control characters
	return Array.from(text)
		.filter((char) => {
			const codePoint = char.codePointAt(0);

			if (codePoint === undefined || codePoint === 0x0000) {
				return false;
			}

			if (codePoint === 0xfffd) {
				return false;
			}

			return !(
				(codePoint >= 0x0001 && codePoint <= 0x0008) ||
				codePoint === 0x000b ||
				codePoint === 0x000c ||
				(codePoint >= 0x000e && codePoint <= 0x001f)
			);
		})
		.join("");
}

// Initialize S3 client
const s3Client = new S3Client({
	region: (process.env.S3_REGION as string) || "auto",
	endpoint: process.env.S3_ENDPOINT as string,
	forcePathStyle: true,
	credentials: {
		accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
	},
});

/**
 * Download document from S3
 */
export async function downloadDocument(documentId: string): Promise<{
	buffer: Buffer;
	filename: string;
	mimeType: string;
}> {
	console.log("[Activity] Downloading document:", documentId);

	try {
		// Get document metadata from database
		const document = await db.chatDocument.findUnique({
			where: { id: documentId },
		});

		if (!document) {
			throw new Error(`Document not found: ${documentId}`);
		}

		// Extract bucket name from s3Path (format: bucket/path/to/file)
		const bucketName =
			process.env.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME ||
			"chat-documents";

		// Download from S3
		const command = new GetObjectCommand({
			Bucket: bucketName,
			Key: document.s3Path,
		});

		const response = await s3Client.send(command);

		if (!response.Body) {
			throw new Error("Empty response from S3");
		}

		// Convert stream to buffer
		const buffer = Buffer.from(await response.Body.transformToByteArray());

		console.log(
			`[Activity] Downloaded document: ${document.filename} (${buffer.length} bytes)`,
		);

		return {
			buffer,
			filename: document.filename,
			mimeType: document.mimeType,
		};
	} catch (error) {
		console.error("[Activity] Failed to download document:", error);
		throw new Error(
			`Failed to download document: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Extract text from document using pluggable extractors with database-driven provider selection
 */
export async function extractDocument(
	_documentId: string,
	buffer: Buffer,
	filename: string,
	mimeType: string,
	strategy = "local-only",
	userId?: string,
	organizationId?: string,
): Promise<ExtractionResult> {
	console.log(
		`[Activity] Extracting document: ${filename} (${mimeType}) with strategy: ${strategy}`,
		{ userId, organizationId },
	);

	try {
		const result = await extractionFactory.extract(
			buffer,
			filename,
			mimeType,
			{
				strategy: strategy as any,
				userId,
				organizationId,
			},
		);

		console.log(
			`[Activity] Extracted ${result.text.length} characters using ${result.extractorUsed}`,
		);

		return result;
	} catch (error) {
		console.error("[Activity] Failed to extract document:", error);
		throw new Error(
			`Failed to extract document: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Chunk document text into smaller pieces
 */
export async function chunkDocument(
	_documentId: string,
	text: string,
	filename: string,
): Promise<TextChunk[]> {
	console.log(`[Activity] Chunking document: ${filename}`);

	try {
		const chunks = chunkText(text, filename, {
			chunkSize: 1000,
			chunkOverlap: 200,
		});

		console.log(`[Activity] Created ${chunks.length} chunks`);

		return chunks;
	} catch (error) {
		console.error("[Activity] Failed to chunk document:", error);
		throw new Error(
			`Failed to chunk document: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Generate embeddings for document chunks
 * Uses centralized AI provider configuration
 */
export async function generateChunkEmbeddings(
	_documentId: string,
	userId: string,
	organizationId: string | undefined,
	chunks: TextChunk[],
): Promise<number[][]> {
	console.log(`[Activity] Generating embeddings for ${chunks.length} chunks`);

	try {
		// Get AI provider configuration using centralized function
		const providerConfig = await getRAGProviderConfig({
			userId,
			organizationId,
		});
		console.log("[Activity] Using centralized AI provider config");

		const texts = chunks.map((chunk) => chunk.content);
		const result = await generateEmbeddings(
			texts,
			{
				userId,
				organizationId,
				tags: ["rag-embedding", "document-processing"],
			},
			providerConfig,
		);

		console.log(
			`[Activity] Generated ${result.embeddings.length} embeddings (${result.totalTokens} tokens, $${result.cost.toFixed(4)})`,
		);

		return result.embeddings;
	} catch (error) {
		console.error("[Activity] Failed to generate embeddings:", error);
		throw new Error(
			`Failed to generate embeddings: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Store chunks with embeddings in database
 */
export async function storeDocumentChunks(
	documentId: string,
	chatId: string,
	userId: string,
	organizationId: string | undefined,
	chunks: TextChunk[],
	embeddings: number[][],
	extractionMetadata: Partial<ExtractionResult>,
): Promise<void> {
	console.log("[Activity] ========== STORING CHUNKS ==========");
	console.log("[Activity] documentId:", documentId);
	console.log("[Activity] chatId:", chatId);
	console.log("[Activity] userId:", userId);
	console.log("[Activity] organizationId:", organizationId);
	console.log("[Activity] Number of chunks:", chunks.length);

	try {
		// Store each chunk with its embedding
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const embedding = embeddings[i];

			console.log(`[Activity] Storing chunk ${i + 1}/${chunks.length}`);
			console.log(
				`[Activity] Chunk will be stored with chatId: ${chatId}`,
			);

			await storeChunk({
				documentId,
				chatId,
				userId,
				organizationId,
				content: chunk.content,
				chunkIndex: chunk.index,
				embedding,
				metadata: {
					...chunk.metadata,
					extractorUsed: extractionMetadata.extractorUsed,
				},
			});
		}

		console.log(`[Activity] Stored ${chunks.length} chunks successfully`);
	} catch (error) {
		console.error("[Activity] Failed to store chunks:", error);
		throw new Error(
			`Failed to store chunks: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Combined activity: Download, extract, chunk, embed, and store document
 * This avoids transferring large buffers/arrays through Temporal's gRPC
 * which has a 4MB message size limit. We process everything in one activity
 * and only return small metadata.
 */
export async function processAndStoreChunks(
	documentId: string,
	chatId: string,
	userId: string,
	organizationId: string | undefined,
	extractionStrategy = "local-only",
): Promise<{
	chunkCount: number;
	extractorUsed?: string;
	extractionTime?: number;
	cost?: number;
}> {
	console.log(`[Activity] Processing document end-to-end: ${documentId}`);
	console.log(`[Activity] chatId: ${chatId}`);
	console.log(`[Activity] userId: ${userId}`);
	console.log(`[Activity] organizationId: ${organizationId}`);
	console.log(`[Activity] extractionStrategy: ${extractionStrategy}`);

	try {
		// Tenant-scoped lookup — a forged documentId from another tenant
		// must not resolve here.
		console.log("[Activity] Downloading document from S3");
		const document = await db.chatDocument.findFirst({
			where: {
				id: documentId,
				...tenantWhere(userId, organizationId),
			},
		});

		if (!document) {
			throw new Error(
				`Document not found or not accessible for this tenant: ${documentId}`,
			);
		}

		const bucketName =
			process.env.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME ||
			"chat-documents";

		const command = new GetObjectCommand({
			Bucket: bucketName,
			Key: document.s3Path,
		});

		const response = await s3Client.send(command);

		if (!response.Body) {
			throw new Error("Empty response from S3");
		}

		const buffer = Buffer.from(await response.Body.transformToByteArray());
		console.log(
			`[Activity] Downloaded ${document.filename} (${buffer.length} bytes)`,
		);

		// Step 2: Extract text
		console.log("[Activity] Extracting text from document");
		const extractionResult = await extractDocument(
			documentId,
			buffer,
			document.filename,
			document.mimeType,
			extractionStrategy,
			userId,
			organizationId,
		);
		console.log(
			`[Activity] Extracted ${extractionResult.text.length} characters using ${extractionResult.extractorUsed}`,
		);

		// Step 2.5: Sanitize extracted text to remove null bytes and control characters
		// that PostgreSQL cannot store in UTF-8 encoded text fields
		const sanitizedText = sanitizeTextForStorage(extractionResult.text);
		if (sanitizedText.length !== extractionResult.text.length) {
			console.log(
				`[Activity] Sanitized text: removed ${extractionResult.text.length - sanitizedText.length} problematic characters`,
			);
		}

		// Step 3: Chunk the sanitized text
		console.log("[Activity] Chunking document");
		const chunks = chunkText(sanitizedText, document.filename, {
			chunkSize: 3000, // 3000 chars ≈ 750 tokens (optimal for RAG)
			chunkOverlap: 500, // 500 chars ≈ 125 tokens (~17% overlap)
		});
		console.log(`[Activity] Created ${chunks.length} chunks`);

		// Get AI provider configuration using centralized function
		const providerConfig = await getRAGProviderConfig({
			userId,
			organizationId,
		});
		console.log("[Activity] Using centralized AI provider config");

		// Process chunks in batches to optimize API calls while avoiding memory issues
		// OpenAI allows up to 2048 embeddings per request, but we use 50 for safety
		const BATCH_SIZE = 50; // Process 50 chunks at a time (was 10, now 5x more efficient)
		let totalStored = 0;

		for (
			let batchStart = 0;
			batchStart < chunks.length;
			batchStart += BATCH_SIZE
		) {
			const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
			const batchChunks = chunks.slice(batchStart, batchEnd);

			console.log(
				`[Activity] Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)} (chunks ${batchStart + 1}-${batchEnd})`,
			);

			// Step 4: Generate embeddings for this batch
			const batchTexts = batchChunks.map((chunk) => chunk.content);
			const batchEmbeddingsResult = await generateEmbeddings(
				batchTexts,
				{
					userId,
					organizationId,
					tags: ["rag-embedding", "document-processing"],
				},
				providerConfig,
			);
			console.log(
				`[Activity] Generated ${batchEmbeddingsResult.embeddings.length} embeddings for batch (cost: $${batchEmbeddingsResult.cost.toFixed(4)})`,
			);

			// Step 5: Store chunks with embeddings immediately
			for (let i = 0; i < batchChunks.length; i++) {
				const chunk = batchChunks[i];
				const embedding = batchEmbeddingsResult.embeddings[i];

				await storeChunk({
					documentId,
					chatId,
					userId,
					organizationId,
					content: chunk.content,
					embedding,
					chunkIndex: chunk.index, // Use 'index' property from TextChunk
					metadata: {
						...chunk.metadata,
						filename: document.filename,
						extractorUsed: extractionResult.extractorUsed,
						extractionTime: extractionResult.extractionTime,
						pageCount: extractionResult.pageCount,
					},
				});
				totalStored++;
			}

			console.log(
				`[Activity] Stored batch ${Math.floor(batchStart / BATCH_SIZE) + 1}, total stored: ${totalStored}/${chunks.length}`,
			);

			// Clear batch data from memory explicitly
			// This helps ensure Temporal doesn't try to serialize large objects
			batchChunks.length = 0;
			batchEmbeddingsResult.embeddings.length = 0;
		}

		// Note: Last used timestamp is already updated when we fetch the provider config above

		console.log(
			`[Activity] Successfully processed and stored ${totalStored} chunks`,
		);

		// Return only small metadata, no large objects
		return {
			chunkCount: totalStored,
			extractorUsed: extractionResult.extractorUsed,
			extractionTime: extractionResult.extractionTime,
			cost: extractionResult.cost,
		};
	} catch (error) {
		console.error("[Activity] Failed to process document:", error);
		throw new Error(
			`Failed to process document: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Update document status in database
 *
 * IMPORTANT: This activity now throws errors instead of silently swallowing them.
 * The workflow should handle failures appropriately. Status updates are critical
 * for the UI to know when documents are ready for RAG queries.
 */
export async function updateDocumentStatus(
	documentId: string,
	status: "PENDING" | "PROCESSING" | "READY" | "FAILED",
	workflowStatus:
		| "NONE"
		| "RUNNING"
		| "COMPLETED"
		| "FAILED"
		| "RETRYING"
		| "CANCELLED",
	extractionMetadata?: Partial<ExtractionResult>,
	error?: string,
): Promise<void> {
	console.log(
		`[Activity] Updating document status: ${documentId} -> ${status}`,
	);

	try {
		await db.chatDocument.update({
			where: { id: documentId },
			data: {
				status,
				workflowStatus,
				lastError: error,
				extractorUsed: extractionMetadata?.extractorUsed,
				extractionTime: extractionMetadata?.extractionTime,
				extractionCost: extractionMetadata?.cost,
				pageCount: extractionMetadata?.pageCount,
				hasTables: extractionMetadata?.hasTables,
				hasImages: extractionMetadata?.hasImages,
			},
		});

		console.log("[Activity] Document status updated successfully");
	} catch (err) {
		const errorMessage =
			err instanceof Error ? err.message : "Unknown error";
		console.error(
			`[Activity] Failed to update document status: ${errorMessage}`,
			err,
		);
		// Throw the error so Temporal can retry the activity
		// This is critical - silent failures cause the UI to show "Processing" indefinitely
		throw new Error(
			`Failed to update document ${documentId} status to ${status}: ${errorMessage}`,
		);
	}
}

/**
 * Chunk and store web content extracted via browser automation
 * Used by the browserRagIngestionWorkflow
 */
export async function chunkAndStoreWebContent(input: {
	url: string;
	text: string;
	chatId: string;
	userId: string;
	organizationId?: string;
}): Promise<{ chunkCount: number }> {
	const { url, text, chatId, userId, organizationId } = input;

	console.log(`[Activity] Processing web content from: ${url}`);
	console.log(`[Activity] Content length: ${text.length} characters`);

	// Generate a virtual document ID for the URL
	const documentId = `web-${Buffer.from(url).toString("base64url").slice(0, 32)}`;

	// Sanitize text to remove null bytes and control characters
	const sanitizedText = sanitizeTextForStorage(text);
	if (sanitizedText.length !== text.length) {
		console.log(
			`[Activity] Sanitized web content: removed ${text.length - sanitizedText.length} problematic characters`,
		);
	}

	// Step 1: Chunk the sanitized text
	const chunks = chunkText(sanitizedText, url, {
		chunkSize: 3000,
		chunkOverlap: 500,
	});

	console.log(`[Activity] Created ${chunks.length} chunks`);

	if (chunks.length === 0) {
		return { chunkCount: 0 };
	}

	// Step 2: Generate embeddings using centralized config
	const providerConfig = await getRAGProviderConfig({
		userId,
		organizationId,
	});
	console.log(
		"[Activity] Using centralized AI provider config for embeddings",
	);

	const texts = chunks.map((chunk) => chunk.content);
	const embeddingResult = await generateEmbeddings(
		texts,
		{
			userId,
			organizationId,
			tags: ["rag-embedding", "browser-extraction"],
		},
		providerConfig,
	);

	// Step 3: Store chunks in vector database
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) {
			continue;
		}

		await storeChunk({
			documentId,
			chatId,
			userId,
			organizationId,
			content: chunk.content,
			chunkIndex: chunk.index,
			embedding: embeddingResult.embeddings[i] ?? [],
			metadata: {
				...chunk.metadata,
				sourceType: "browser",
				url,
			},
		});
	}

	console.log(`[Activity] Stored ${chunks.length} chunks for ${url}`);

	return { chunkCount: chunks.length };
}
