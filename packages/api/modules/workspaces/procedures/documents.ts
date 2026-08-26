import { ORPCError } from "@orpc/server";
import {
	canEditWorkspace,
	createWorkspaceDocument,
	deleteWorkspaceDocument as deleteDocumentQuery,
	getDocumentStats,
	getWorkspaceDocumentById,
	hasDocumentCapacity,
	hasWorkspaceAccess,
	listWorkspaceDocuments,
	retryFailedDocument,
	updateWorkspaceDocument,
} from "@repo/database";
import { getStorageProvider, uploadFile } from "@repo/storage";
import { getTemporalClient } from "@repo/temporal";
import { resolveWorkspaceDocumentMime } from "@repo/utils";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const WORKSPACE_DOCUMENTS_BUCKET =
	process.env.WORKSPACE_DOCUMENTS_BUCKET_NAME || "workspace-documents";

/**
 * List documents in a workspace
 */
export const listDocumentsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/document-workspaces/{workspaceId}/documents",
		tags: ["Document Workspaces"],
		summary: "List workspace documents",
		description: "List all documents in a workspace",
	})
	.input(
		z.object({
			workspaceId: z.string(),
			status: z
				.enum([
					"PENDING",
					"UPLOADING",
					"UPLOADED",
					"EXTRACTING",
					"CHUNKING",
					"EMBEDDING",
					"STORING",
					"READY",
					"FAILED",
				])
				.optional(),
			limit: z.number().min(1).max(100).optional(),
			offset: z.number().min(0).optional(),
			search: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const hasAccess = await hasWorkspaceAccess(input.workspaceId, user.id);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this workspace",
			});
		}

		const result = await listWorkspaceDocuments({
			workspaceId: input.workspaceId,
			status: input.status,
			limit: input.limit,
			offset: input.offset,
			search: input.search,
		});

		return {
			documents: result.documents.map((d) => ({
				...d,
				createdAt: d.createdAt.toISOString(),
				updatedAt: d.updatedAt.toISOString(),
			})),
			total: result.total,
			hasMore: result.hasMore,
			nextOffset: result.nextOffset,
		};
	});

/**
 * Get document details
 */
export const getDocumentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/document-workspaces/documents/{documentId}",
		tags: ["Document Workspaces"],
		summary: "Get document details",
		description: "Get details of a specific document",
	})
	.input(
		z.object({
			documentId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const document = await getWorkspaceDocumentById(input.documentId);

		if (!document) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		const hasAccess = await hasWorkspaceAccess(
			document.workspaceId,
			user.id,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this document",
			});
		}

		return {
			...document,
			createdAt: document.createdAt.toISOString(),
			updatedAt: document.updatedAt.toISOString(),
		};
	});

/**
 * Get document statistics for a workspace
 */
export const getDocumentStatsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/document-workspaces/{workspaceId}/documents/stats",
		tags: ["Document Workspaces"],
		summary: "Get document statistics",
		description: "Get document statistics for a workspace",
	})
	.input(
		z.object({
			workspaceId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const hasAccess = await hasWorkspaceAccess(input.workspaceId, user.id);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this workspace",
			});
		}

		return await getDocumentStats(input.workspaceId);
	});

/**
 * Create upload URL for a new document
 */
export const createUploadUrlProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/document-workspaces/{workspaceId}/documents/upload-url",
		tags: ["Document Workspaces"],
		summary: "Create upload URL",
		description: "Create a presigned URL for uploading a document",
	})
	.input(
		z.object({
			workspaceId: z.string(),
			filename: z.string(),
			mimeType: z.string(),
			size: z
				.number()
				.min(1)
				.max(50 * 1024 * 1024), // Max 50MB
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		// Check edit permission
		const canEdit = await canEditWorkspace(input.workspaceId, user.id);
		if (!canEdit) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to upload documents",
			});
		}

		// Check capacity
		const hasCapacity = await hasDocumentCapacity(input.workspaceId);
		if (!hasCapacity) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "Workspace has reached its document limit",
			});
		}

		// Generate unique filename
		const timestamp = Date.now();
		const sanitizedFilename = input.filename.replace(
			/[^a-zA-Z0-9.-]/g,
			"_",
		);
		const s3Path = `${input.workspaceId}/${timestamp}-${sanitizedFilename}`;

		// Get storage provider to determine upload method
		const storageProvider = getStorageProvider();
		let uploadUrl: string | null = null;

		if (
			storageProvider.supportsPresignedUrls &&
			storageProvider.getSignedDocumentUploadUrl
		) {
			uploadUrl = await storageProvider.getSignedDocumentUploadUrl(
				s3Path,
				{
					bucket: WORKSPACE_DOCUMENTS_BUCKET,
					contentType: input.mimeType,
					contentLength: input.size,
					expiresIn: 3600, // 1 hour
				},
			);
		}

		return {
			uploadUrl,
			s3Bucket: WORKSPACE_DOCUMENTS_BUCKET,
			s3Path,
			expiresIn: 3600,
			useServerUpload: !storageProvider.supportsPresignedUrls,
			storageProvider: storageProvider.type,
		};
	});

/**
 * Confirm document upload and start processing
 */
export const confirmUploadProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/document-workspaces/{workspaceId}/documents/confirm",
		tags: ["Document Workspaces"],
		summary: "Confirm document upload",
		description: "Confirm a document upload and start processing",
	})
	.input(
		z.object({
			workspaceId: z.string(),
			filename: z.string(),
			originalFilename: z.string(),
			mimeType: z.string(),
			size: z.number(),
			s3Bucket: z.string(),
			s3Path: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Re-check edit permission: a role revoked between upload-url and
		// confirmUpload must not slip through on the initial middleware pass.
		const canEdit = await canEditWorkspace(input.workspaceId, user.id);
		if (!canEdit) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to upload documents",
			});
		}

		// Client-supplied s3Bucket/s3Path must match the shape the upload-url
		// step generates; any other value would register a row pointed at a
		// foreign prefix.
		if (input.s3Bucket !== WORKSPACE_DOCUMENTS_BUCKET) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid s3Bucket for workspace documents",
			});
		}
		if (!input.s3Path.startsWith(`${input.workspaceId}/`)) {
			throw new ORPCError("BAD_REQUEST", {
				message: "s3Path does not belong to the specified workspace",
			});
		}

		// Create document record. The original filename carries the extension
		// the user picked; the storage filename is a generated derivative.
		const document = await createWorkspaceDocument({
			workspaceId: input.workspaceId,
			filename: input.filename,
			originalFilename: input.originalFilename,
			// Normalize, never gate: these procedures have only ever validated
			// size, so refusing an unresolvable type here would reject uploads
			// that succeed today. This repairs the empty type a REST caller
			// bypassing the picker sends, which would otherwise reach extraction
			// as "no extractor found" and leave a failed row occupying a
			// workspace slot — capacity counts rows regardless of status. #2139.
			mimeType: resolveWorkspaceDocumentMime(
				input.originalFilename,
				input.mimeType,
			),
			size: input.size,
			s3Bucket: WORKSPACE_DOCUMENTS_BUCKET,
			s3Path: input.s3Path,
			uploadedBy: user.id,
		});

		// Start Temporal workflow for processing
		try {
			const client = await getTemporalClient();

			const workflowId = `workspace-doc-${document.id}-${Date.now()}`;

			const handle = await client.workflow.start(
				"workspaceDocumentProcessingWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId,
					args: [
						{
							documentId: document.id,
							workspaceId: input.workspaceId,
							userId: user.id,
							organizationId,
							extractionStrategy: "local-only",
						},
					],
				}),
			);

			// Update document with workflow ID (handle.workflowId is the same as workflowId we passed)
			await updateWorkspaceDocument(document.id, {
				workflowId: handle.workflowId,
			});
		} catch (error) {
			console.error(
				"Failed to start document processing workflow:",
				error,
			);
			// Don't fail the upload - document can be retried later
		}

		return {
			id: document.id,
			filename: document.filename,
			originalFilename: document.originalFilename,
			status: document.status,
			createdAt: document.createdAt.toISOString(),
		};
	});

/**
 * Delete a document
 */
export const deleteDocumentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "DELETE",
		path: "/document-workspaces/documents/{documentId}",
		tags: ["Document Workspaces"],
		summary: "Delete a document",
		description: "Delete a document from a workspace",
	})
	.input(
		z.object({
			documentId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const result = await deleteDocumentQuery(input.documentId, user.id);

		// If there are Qdrant points to clean up, start deletion workflow
		if (result.qdrantPointIds.length > 0) {
			try {
				const client = await getTemporalClient();

				await client.workflow.start(
					"workspaceDocumentDeletionWorkflow",
					withCorrelationMemo({
						taskQueue: "fabric-worker",
						workflowId: `workspace-doc-delete-${input.documentId}-${Date.now()}`,
						args: [
							{
								documentId: input.documentId,
								workspaceId: "", // Not needed for deletion
							},
						],
					}),
				);
			} catch (error) {
				console.error(
					"Failed to start document deletion workflow:",
					error,
				);
				// Don't fail - document is already deleted from DB
			}
		}

		return { success: true };
	});

/**
 * Retry processing a failed document
 */
export const retryDocumentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/document-workspaces/documents/{documentId}/retry",
		tags: ["Document Workspaces"],
		summary: "Retry document processing",
		description: "Retry processing a failed document",
	})
	.input(
		z.object({
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const document = await retryFailedDocument(input.documentId, user.id);

		// Start Temporal workflow for reprocessing
		try {
			const client = await getTemporalClient();

			const workflowId = `workspace-doc-retry-${document.id}-${Date.now()}`;

			const handle = await client.workflow.start(
				"workspaceDocumentProcessingWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId,
					args: [
						{
							documentId: document.id,
							workspaceId: document.workspaceId,
							userId: user.id,
							organizationId,
							extractionStrategy: "local-only",
							isRetry: true,
						},
					],
				}),
			);

			// Update document with new workflow ID
			await updateWorkspaceDocument(document.id, {
				workflowId: handle.workflowId,
			});
		} catch (error) {
			console.error("Failed to start document retry workflow:", error);
		}

		return {
			id: document.id,
			status: document.status,
		};
	});

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Server-side file upload for workspace documents
 *
 * Used when the storage provider doesn't support presigned URLs (e.g., Vercel Blob).
 * The client sends the file data to this endpoint, and we upload it to storage.
 */
export const serverUploadProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/document-workspaces/{workspaceId}/documents/server-upload",
		tags: ["Document Workspaces"],
		summary: "Server-side document upload",
		description:
			"Upload a document through the server (for storage providers that don't support presigned URLs)",
	})
	.input(
		z.object({
			workspaceId: z.string(),
			filename: z.string(),
			mimeType: z.string(),
			size: z.number().min(1).max(MAX_FILE_SIZE),
			// File data as base64 encoded string
			fileData: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Check edit permission
		const canEdit = await canEditWorkspace(input.workspaceId, user.id);
		if (!canEdit) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to upload documents",
			});
		}

		// Check capacity
		const hasCapacity = await hasDocumentCapacity(input.workspaceId);
		if (!hasCapacity) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "Workspace has reached its document limit",
			});
		}

		// Decode base64 file data
		const buffer = Buffer.from(input.fileData, "base64");

		// Validate actual file size matches declared size
		if (Math.abs(buffer.length - input.size) > 1024) {
			// Allow 1KB tolerance for encoding differences
			throw new ORPCError("BAD_REQUEST", {
				message: "File size mismatch",
			});
		}

		// Generate unique filename
		const timestamp = Date.now();
		const sanitizedFilename = input.filename.replace(
			/[^a-zA-Z0-9.-]/g,
			"_",
		);
		const s3Path = `${input.workspaceId}/${timestamp}-${sanitizedFilename}`;

		// Resolve once so the stored object's Content-Type and the row the
		// extractor reads cannot disagree. Normalization only — see the
		// equivalent call in confirmUpload.
		const mimeType = resolveWorkspaceDocumentMime(
			input.filename,
			input.mimeType,
		);

		try {
			// Upload to storage
			const result = await uploadFile(s3Path, buffer, {
				bucket: WORKSPACE_DOCUMENTS_BUCKET,
				contentType: mimeType,
				access: "public",
			});

			// Create document record
			const document = await createWorkspaceDocument({
				workspaceId: input.workspaceId,
				filename: sanitizedFilename,
				originalFilename: input.filename,
				mimeType,
				size: buffer.length,
				s3Bucket: WORKSPACE_DOCUMENTS_BUCKET,
				s3Path,
				uploadedBy: user.id,
			});

			// Start Temporal workflow for processing
			try {
				const client = await getTemporalClient();
				const workflowId = `workspace-doc-${document.id}-${Date.now()}`;

				const handle = await client.workflow.start(
					"workspaceDocumentProcessingWorkflow",
					withCorrelationMemo({
						taskQueue: "fabric-worker",
						workflowId,
						args: [
							{
								documentId: document.id,
								workspaceId: input.workspaceId,
								userId: user.id,
								organizationId,
								extractionStrategy: "local-only",
							},
						],
					}),
				);

				await updateWorkspaceDocument(document.id, {
					workflowId: handle.workflowId,
				});
			} catch (error) {
				console.error(
					"Failed to start document processing workflow:",
					error,
				);
				// Don't fail the upload - document can be retried later
			}

			return {
				id: document.id,
				filename: document.filename,
				originalFilename: document.originalFilename,
				status: document.status,
				s3Path,
				url: result.url,
			};
		} catch (error) {
			console.error("Server upload failed:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to upload document to storage",
			});
		}
	});
