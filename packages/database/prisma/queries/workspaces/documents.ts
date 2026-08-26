/**
 * Database queries for Workspace Documents
 *
 * Handles document CRUD operations, status tracking, and chunk management
 * for workspace documents with proper authorization checks.
 */

import { db, type Prisma, type WorkspaceDocumentStatus } from "../../client";
import {
	canDeleteInWorkspace,
	canEditWorkspace,
	hasDocumentCapacity,
} from "./workspaces";

// ============================================================================
// Types
// ============================================================================

export interface CreateWorkspaceDocumentInput {
	workspaceId: string;
	filename: string;
	originalFilename: string;
	mimeType: string;
	size: number;
	s3Bucket: string;
	s3Path: string;
	uploadedBy: string;
	metadata?: Record<string, unknown>;
}

export interface UpdateWorkspaceDocumentInput {
	status?: WorkspaceDocumentStatus;
	processingError?: string | null;
	extractedText?: string;
	extractorUsed?: string;
	pageCount?: number;
	wordCount?: number;
	qdrantPointIds?: string[];
	embeddedAt?: Date;
	chunkCount?: number;
	workflowId?: string;
	metadata?: Record<string, unknown>;
}

export interface CreateDocumentChunkInput {
	documentId: string;
	chunkIndex: number;
	content: string;
	startOffset?: number;
	endOffset?: number;
	pageNumber?: number;
	headings?: string[];
	qdrantId?: string;
}

export interface ListDocumentsOptions {
	workspaceId: string;
	status?: WorkspaceDocumentStatus;
	limit?: number;
	offset?: number;
	search?: string;
}

// ============================================================================
// Create
// ============================================================================

/**
 * Create a new workspace document record
 * Call this after uploading the file to S3
 */
export async function createWorkspaceDocument(
	input: CreateWorkspaceDocumentInput,
) {
	const {
		workspaceId,
		filename,
		originalFilename,
		mimeType,
		size,
		s3Bucket,
		s3Path,
		uploadedBy,
		metadata,
	} = input;

	// Check workspace capacity
	const hasCapacity = await hasDocumentCapacity(workspaceId);
	if (!hasCapacity) {
		throw new Error("Workspace has reached its document limit");
	}

	// Check user can edit workspace
	const canEdit = await canEditWorkspace(workspaceId, uploadedBy);
	if (!canEdit) {
		throw new Error(
			"You do not have permission to upload documents to this workspace",
		);
	}

	return await db.workspaceDocument.create({
		data: {
			workspaceId,
			filename,
			originalFilename,
			mimeType,
			size,
			s3Bucket,
			s3Path,
			uploadedBy,
			status: "UPLOADED",
			metadata: metadata as Prisma.InputJsonValue,
		},
	});
}

/**
 * Create document chunks after text extraction
 */
export async function createDocumentChunks(
	documentId: string,
	chunks: Omit<CreateDocumentChunkInput, "documentId">[],
) {
	return await db.$transaction(async (tx) => {
		// Create all chunks
		const createdChunks = await tx.workspaceDocumentChunk.createMany({
			data: chunks.map((chunk) => ({
				documentId,
				chunkIndex: chunk.chunkIndex,
				content: chunk.content,
				startOffset: chunk.startOffset,
				endOffset: chunk.endOffset,
				pageNumber: chunk.pageNumber,
				headings: chunk.headings || [],
				qdrantId: chunk.qdrantId,
			})),
		});

		// Update document chunk count
		await tx.workspaceDocument.update({
			where: { id: documentId },
			data: { chunkCount: chunks.length },
		});

		return createdChunks;
	});
}

// ============================================================================
// Read
// ============================================================================

/**
 * Get document by ID
 */
export async function getWorkspaceDocumentById(documentId: string) {
	return await db.workspaceDocument.findUnique({
		where: { id: documentId },
		include: {
			workspace: {
				select: {
					id: true,
					name: true,
					userId: true,
					organizationId: true,
				},
			},
			uploader: {
				select: {
					id: true,
					name: true,
					image: true,
				},
			},
		},
	});
}

/**
 * Get document with chunks
 */
export async function getWorkspaceDocumentWithChunks(documentId: string) {
	return await db.workspaceDocument.findUnique({
		where: { id: documentId },
		include: {
			chunks: {
				orderBy: { chunkIndex: "asc" },
			},
			workspace: {
				select: {
					id: true,
					name: true,
				},
			},
		},
	});
}

/**
 * List documents in a workspace
 */
export async function listWorkspaceDocuments(options: ListDocumentsOptions) {
	const { workspaceId, status, limit = 50, offset = 0, search } = options;

	const where: Prisma.WorkspaceDocumentWhereInput = {
		workspaceId,
		...(status ? { status } : {}),
		...(search
			? {
					OR: [
						{
							originalFilename: {
								contains: search,
								mode: "insensitive",
							},
						},
						{ filename: { contains: search, mode: "insensitive" } },
					],
				}
			: {}),
	};

	const [documents, total] = await Promise.all([
		db.workspaceDocument.findMany({
			where,
			select: {
				id: true,
				filename: true,
				originalFilename: true,
				mimeType: true,
				size: true,
				status: true,
				processingError: true,
				pageCount: true,
				wordCount: true,
				chunkCount: true,
				embeddedAt: true,
				createdAt: true,
				updatedAt: true,
				uploader: {
					select: {
						id: true,
						name: true,
						image: true,
					},
				},
			},
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.workspaceDocument.count({ where }),
	]);

	return {
		documents,
		total,
		hasMore: offset + limit < total,
		nextOffset: offset + limit < total ? offset + limit : undefined,
	};
}

/**
 * Get documents by IDs (for filtering in conversation context)
 */
export async function getDocumentsByIds(documentIds: string[]) {
	return await db.workspaceDocument.findMany({
		where: {
			id: { in: documentIds },
			status: "READY",
		},
		select: {
			id: true,
			filename: true,
			originalFilename: true,
			mimeType: true,
			size: true,
			pageCount: true,
			wordCount: true,
			chunkCount: true,
			workspaceId: true,
		},
	});
}

/**
 * Get ready documents for a workspace (for RAG queries)
 */
export async function getReadyDocuments(workspaceId: string) {
	return await db.workspaceDocument.findMany({
		where: {
			workspaceId,
			status: "READY",
		},
		select: {
			id: true,
			filename: true,
			originalFilename: true,
			qdrantPointIds: true,
			chunkCount: true,
		},
	});
}

/**
 * Get document chunks for RAG context
 */
export async function getDocumentChunks(documentId: string) {
	return await db.workspaceDocumentChunk.findMany({
		where: { documentId },
		orderBy: { chunkIndex: "asc" },
		select: {
			id: true,
			chunkIndex: true,
			content: true,
			startOffset: true,
			endOffset: true,
			pageNumber: true,
			headings: true,
			qdrantId: true,
		},
	});
}

/**
 * Get document processing statistics for a workspace
 */
export async function getDocumentStats(workspaceId: string) {
	const [total, ready, processing, failed] = await Promise.all([
		db.workspaceDocument.count({ where: { workspaceId } }),
		db.workspaceDocument.count({ where: { workspaceId, status: "READY" } }),
		db.workspaceDocument.count({
			where: {
				workspaceId,
				status: {
					in: [
						"PENDING",
						"UPLOADING",
						"UPLOADED",
						"EXTRACTING",
						"CHUNKING",
						"EMBEDDING",
						"STORING",
					],
				},
			},
		}),
		db.workspaceDocument.count({
			where: { workspaceId, status: "FAILED" },
		}),
	]);

	const workspace = await db.workspace.findUnique({
		where: { id: workspaceId },
		select: { documentLimit: true },
	});

	return {
		total,
		ready,
		processing,
		failed,
		limit: workspace?.documentLimit ?? 20,
		remaining: (workspace?.documentLimit ?? 20) - total,
	};
}

// ============================================================================
// Update
// ============================================================================

/**
 * Update document status and metadata
 * Used primarily by Temporal workflows during processing
 */
export async function updateWorkspaceDocument(
	documentId: string,
	data: UpdateWorkspaceDocumentInput,
) {
	return await db.workspaceDocument.update({
		where: { id: documentId },
		data: {
			...(data.status !== undefined && { status: data.status }),
			...(data.processingError !== undefined && {
				processingError: data.processingError,
			}),
			...(data.extractedText !== undefined && {
				extractedText: data.extractedText,
			}),
			...(data.extractorUsed !== undefined && {
				extractorUsed: data.extractorUsed,
			}),
			...(data.pageCount !== undefined && { pageCount: data.pageCount }),
			...(data.wordCount !== undefined && { wordCount: data.wordCount }),
			...(data.qdrantPointIds !== undefined && {
				qdrantPointIds: data.qdrantPointIds,
			}),
			...(data.embeddedAt !== undefined && {
				embeddedAt: data.embeddedAt,
			}),
			...(data.chunkCount !== undefined && {
				chunkCount: data.chunkCount,
			}),
			...(data.workflowId !== undefined && {
				workflowId: data.workflowId,
			}),
			...(data.metadata !== undefined && {
				metadata: data.metadata as Prisma.InputJsonValue,
			}),
		},
	});
}

/**
 * Update document to failed status with error message
 */
export async function markDocumentFailed(documentId: string, error: string) {
	return await updateWorkspaceDocument(documentId, {
		status: "FAILED",
		processingError: error,
	});
}

/**
 * Update document to ready status after successful processing
 */
export async function markDocumentReady(
	documentId: string,
	data: {
		extractedText?: string;
		extractorUsed: string;
		pageCount?: number;
		wordCount: number;
		qdrantPointIds: string[];
		chunkCount: number;
	},
) {
	return await updateWorkspaceDocument(documentId, {
		status: "READY",
		processingError: null,
		extractedText: data.extractedText,
		extractorUsed: data.extractorUsed,
		pageCount: data.pageCount,
		wordCount: data.wordCount,
		qdrantPointIds: data.qdrantPointIds,
		chunkCount: data.chunkCount,
		embeddedAt: new Date(),
	});
}

/**
 * Update chunk with Qdrant ID after embedding
 */
export async function updateChunkQdrantId(chunkId: string, qdrantId: string) {
	return await db.workspaceDocumentChunk.update({
		where: { id: chunkId },
		data: { qdrantId },
	});
}

// ============================================================================
// Delete
// ============================================================================

/**
 * Delete a document and all its chunks
 * Only administrators and owners can delete documents
 */
export async function deleteWorkspaceDocument(
	documentId: string,
	userId: string,
) {
	// Get document with workspace
	const document = await db.workspaceDocument.findUnique({
		where: { id: documentId },
		select: {
			id: true,
			workspaceId: true,
			qdrantPointIds: true,
		},
	});

	if (!document) {
		throw new Error("Document not found");
	}

	// Check delete permission
	const canDelete = await canDeleteInWorkspace(document.workspaceId, userId);
	if (!canDelete) {
		throw new Error("You do not have permission to delete this document");
	}

	// Delete document (chunks cascade)
	await db.workspaceDocument.delete({
		where: { id: documentId },
	});

	// Return qdrant point IDs for cleanup
	return {
		deleted: true,
		qdrantPointIds: document.qdrantPointIds,
	};
}

/**
 * Delete all documents in a workspace
 * Used when deleting a workspace
 */
export async function deleteAllWorkspaceDocuments(workspaceId: string) {
	// Get all point IDs for Qdrant cleanup
	const documents = await db.workspaceDocument.findMany({
		where: { workspaceId },
		select: { qdrantPointIds: true },
	});

	const allPointIds = documents.flatMap((d) => d.qdrantPointIds);

	// Delete all documents (chunks cascade)
	await db.workspaceDocument.deleteMany({
		where: { workspaceId },
	});

	return {
		deleted: documents.length,
		qdrantPointIds: allPointIds,
	};
}

// ============================================================================
// Processing Queue
// ============================================================================

/**
 * Get documents pending processing
 * Used by Temporal workflow starters
 */
export async function getPendingDocuments(limit = 10) {
	return await db.workspaceDocument.findMany({
		where: {
			status: "UPLOADED",
			workflowId: null,
		},
		select: {
			id: true,
			workspaceId: true,
			filename: true,
			originalFilename: true,
			mimeType: true,
			s3Bucket: true,
			s3Path: true,
		},
		orderBy: { createdAt: "asc" },
		take: limit,
	});
}

/**
 * Get documents currently being processed (for monitoring)
 */
export async function getProcessingDocuments(workspaceId?: string) {
	return await db.workspaceDocument.findMany({
		where: {
			...(workspaceId ? { workspaceId } : {}),
			status: {
				in: [
					"PENDING",
					"UPLOADING",
					"UPLOADED",
					"EXTRACTING",
					"CHUNKING",
					"EMBEDDING",
					"STORING",
				],
			},
		},
		select: {
			id: true,
			workspaceId: true,
			originalFilename: true,
			status: true,
			workflowId: true,
			createdAt: true,
			updatedAt: true,
		},
		orderBy: { createdAt: "asc" },
	});
}

/**
 * Retry a failed document by resetting its status
 */
export async function retryFailedDocument(documentId: string, userId: string) {
	const document = await db.workspaceDocument.findUnique({
		where: { id: documentId },
		select: { workspaceId: true, status: true },
	});

	if (!document) {
		throw new Error("Document not found");
	}

	if (document.status !== "FAILED") {
		throw new Error("Only failed documents can be retried");
	}

	const canEdit = await canEditWorkspace(document.workspaceId, userId);
	if (!canEdit) {
		throw new Error("You do not have permission to retry this document");
	}

	// Clear chunks if any
	await db.workspaceDocumentChunk.deleteMany({
		where: { documentId },
	});

	return await db.workspaceDocument.update({
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
}
