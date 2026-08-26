import { db } from "../client";

/**
 * Get chat document by ID — INTERNAL USE ONLY (no tenant filtering).
 * Use getChatDocumentByIdForOwner from user-facing paths so another
 * org member cannot read/download a peer's document by id.
 */
export async function getChatDocumentById(id: string) {
	return await db.chatDocument.findUnique({
		where: { id },
	});
}

/**
 * Return the chat document only if `userId` owns it. Chat documents
 * inherit the per-user-in-org scope of their parent AiChat.
 */
export async function getChatDocumentByIdForOwner(id: string, userId: string) {
	return await db.chatDocument.findFirst({
		where: { id, userId },
	});
}

/**
 * Get chat documents by chat ID — INTERNAL USE ONLY (no tenant filter).
 * Use getChatDocumentsByChatIdForOwner from user-facing paths.
 */
export async function getChatDocumentsByChatId(chatId: string) {
	return await db.chatDocument.findMany({
		where: { chatId },
		orderBy: { createdAt: "desc" },
	});
}

/**
 * List chat documents for a given (chatId, userId) pair. Returns an
 * empty array when the chat is not owned by `userId`, so another org
 * member cannot enumerate a peer's uploads.
 */
export async function getChatDocumentsByChatIdForOwner(
	chatId: string,
	userId: string,
) {
	return await db.chatDocument.findMany({
		where: { chatId, userId },
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Create a new chat document
 */
export async function createChatDocument(data: {
	id: string;
	chatId: string;
	userId: string;
	organizationId?: string | null;
	filename: string;
	mimeType: string;
	size: number;
	s3Path: string;
	status?: "PENDING" | "PROCESSING" | "READY" | "FAILED";
}) {
	return await db.chatDocument.create({
		data: {
			id: data.id,
			chatId: data.chatId,
			userId: data.userId,
			organizationId: data.organizationId || null,
			filename: data.filename,
			mimeType: data.mimeType,
			size: data.size,
			s3Path: data.s3Path,
			status: data.status || "PENDING",
		},
	});
}

/**
 * Update document status
 */
export async function updateDocumentStatus(data: {
	documentId: string;
	status?: "PENDING" | "PROCESSING" | "READY" | "FAILED";
	workflowStatus?:
		| "NONE"
		| "RUNNING"
		| "COMPLETED"
		| "FAILED"
		| "RETRYING"
		| "CANCELLED";
	workflowId?: string | null;
	workflowRunId?: string | null;
	lastError?: string | null;
	errorMessage?: string | null;
	extractorUsed?: string | null;
	extractionTime?: number | null;
	extractionCost?: number | null;
	pageCount?: number | null;
	hasTables?: boolean;
	hasImages?: boolean;
	retryCount?: number;
	lastRetryAt?: Date | null;
}) {
	const updateData: Record<string, unknown> = {};

	if (data.status !== undefined) {
		updateData.status = data.status;
	}
	if (data.workflowStatus !== undefined) {
		updateData.workflowStatus = data.workflowStatus;
	}
	if (data.workflowId !== undefined) {
		updateData.workflowId = data.workflowId;
	}
	if (data.workflowRunId !== undefined) {
		updateData.workflowRunId = data.workflowRunId;
	}
	if (data.lastError !== undefined) {
		updateData.lastError = data.lastError;
	}
	if (data.errorMessage !== undefined) {
		updateData.errorMessage = data.errorMessage;
	}
	if (data.extractorUsed !== undefined) {
		updateData.extractorUsed = data.extractorUsed;
	}
	if (data.extractionTime !== undefined) {
		updateData.extractionTime = data.extractionTime;
	}
	if (data.extractionCost !== undefined) {
		updateData.extractionCost = data.extractionCost;
	}
	if (data.pageCount !== undefined) {
		updateData.pageCount = data.pageCount;
	}
	if (data.hasTables !== undefined) {
		updateData.hasTables = data.hasTables;
	}
	if (data.hasImages !== undefined) {
		updateData.hasImages = data.hasImages;
	}
	if (data.retryCount !== undefined) {
		updateData.retryCount = data.retryCount;
	}
	if (data.lastRetryAt !== undefined) {
		updateData.lastRetryAt = data.lastRetryAt;
	}

	return await db.chatDocument.update({
		where: { id: data.documentId },
		data: updateData,
	});
}

/**
 * Delete a chat document
 */
export async function deleteChatDocument(id: string) {
	return await db.chatDocument.delete({
		where: { id },
	});
}

/**
 * Get extracted text chunks for a document — INTERNAL USE ONLY.
 * User-facing paths should go through getDocumentChunksForOwner so a
 * peer cannot read another member's extracted content by document id.
 */
export async function getDocumentChunksByDocumentId(documentId: string) {
	return await db.documentChunk.findMany({
		where: { documentId },
		orderBy: { chunkIndex: "asc" },
		select: { content: true, chunkIndex: true },
	});
}

/**
 * Return chunks only for documents owned by `userId`. Empty array
 * when the document belongs to another user.
 */
export async function getDocumentChunksForOwner(
	documentId: string,
	userId: string,
) {
	return await db.documentChunk.findMany({
		where: { documentId, userId },
		orderBy: { chunkIndex: "asc" },
		select: { content: true, chunkIndex: true },
	});
}

/**
 * Check if a chat has any documents in READY status
 */
export async function hasReadyDocuments(chatId: string): Promise<boolean> {
	const count = await db.chatDocument.count({
		where: {
			chatId,
			status: "READY",
		},
	});
	return count > 0;
}

/**
 * Check if a chat has any documents currently being processed
 */
export async function hasPendingDocuments(chatId: string): Promise<boolean> {
	const count = await db.chatDocument.count({
		where: {
			chatId,
			status: {
				in: ["PENDING", "PROCESSING"],
			},
		},
	});
	return count > 0;
}

/**
 * Wait for all documents in a chat to be ready
 * Polls the database until all documents reach READY or FAILED status
 * @param chatId - Chat ID to check
 * @param maxWaitMs - Maximum time to wait in milliseconds (default: 60000 = 1 minute)
 * @param pollIntervalMs - Interval between checks in milliseconds (default: 1000 = 1 second)
 * @returns true if all documents are ready, false if timeout or any failed
 */
export async function waitForDocumentsReady(
	chatId: string,
	maxWaitMs = 60000,
	pollIntervalMs = 1000,
): Promise<boolean> {
	const startTime = Date.now();

	while (Date.now() - startTime < maxWaitMs) {
		const hasPending = await hasPendingDocuments(chatId);

		if (!hasPending) {
			// No pending documents, check if any failed
			const failedCount = await db.chatDocument.count({
				where: {
					chatId,
					status: "FAILED",
				},
			});

			// Return true only if no documents failed
			return failedCount === 0;
		}

		// Wait before next check
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	// Timeout reached
	return false;
}
