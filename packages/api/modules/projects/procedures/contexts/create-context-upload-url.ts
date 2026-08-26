import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { createFileContext, db, hasProjectAccess } from "@repo/database";
import { ProjectDocumentTypeSchema } from "@repo/database/prisma/zod";
import { getStorageProvider } from "@repo/storage";
import {
	CONTEXT_UPLOAD_FORMAT_LABELS,
	contextUploadConfigFor,
	formatSizeLimit,
	resolveContextUploadMime,
	UPLOAD_SIZE_LIMITS,
} from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const VALID_DOCUMENT_TAGS = ProjectDocumentTypeSchema.options;

export const createContextUploadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/upload-url",
		tags: ["Projects", "Contexts"],
		summary: "Create context upload URL",
		description:
			"Generate a signed URL for uploading a file to a project context",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			filename: z.string(),
			mimeType: z.string(),
			size: z.number(),
			documentTag: z.string().optional(),
			/**
			 * How the uploaded file is meant to be used, when it was supplied
			 * through the Documents-tab create flow rather than the Context tab.
			 *
			 * Only meaningful alongside `documentTag`: the tag says which
			 * document type the upload becomes, this says whether the extracted
			 * text becomes that document verbatim or feeds a generation run.
			 * Absent for an ordinary Context-tab upload, which is neither.
			 */
			documentUsage: z.enum(["AS_IS", "CONTEXT"]).optional(),
			/**
			 * A document row created before the upload, which the extraction
			 * workflow fills in rather than creating its own.
			 *
			 * Exists so the document is visible from the moment the dialog
			 * closes: it is written GENERATING, so the list renders it as
			 * in-progress, and an extraction that fails or comes back empty can
			 * mark that same row FAILED. Without it a failed extraction is
			 * silent — nothing was ever created to carry the error.
			 */
			targetDocumentId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const {
			projectId,
			organizationId: inputOrgId,
			filename,
			mimeType,
			size,
			documentTag,
			documentUsage,
			targetDocumentId,
		} = input;
		const user = context.user;
		const organizationId = resolveOrganizationId(
			inputOrgId,
			context.session,
		);

		// Check project access
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Validate file type. The message names the file and says "unknown"
		// rather than trailing off after a colon, because the browser MIME is
		// routinely empty for the very files this refuses (#2139) — and keeps
		// the supported-formats list this surface has always shipped.
		const effectiveMimeType = resolveContextUploadMime(mimeType, filename);
		const fileConfig = contextUploadConfigFor(effectiveMimeType);
		if (!fileConfig) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported file type for "${filename}": ${mimeType || "unknown"}. Supported types: ${CONTEXT_UPLOAD_FORMAT_LABELS.join(", ")}`,
			});
		}

		// Validate file size
		const maxSize = UPLOAD_SIZE_LIMITS[fileConfig.type];
		if (size > maxSize) {
			throw new ORPCError("BAD_REQUEST", {
				message: `File ${filename} is too large. ${formatSizeLimit(maxSize)}.`,
			});
		}

		// Validate documentTag against ProjectDocumentType enum
		if (documentTag && !VALID_DOCUMENT_TAGS.includes(documentTag as any)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Invalid document tag: ${documentTag}. Valid tags: ${VALID_DOCUMENT_TAGS.join(", ")}`,
			});
		}

		// An uploaded file is used as it is, and only that.
		//
		// Using one as generation input would mean starting a run once
		// extraction finishes — at which point this request is long gone, and
		// the only service holding the AI signing key with it. The worker
		// cannot issue a token, so the run could never start: accepting CONTEXT
		// here produced a document that stayed on "generating" forever with
		// nothing to explain it. Refused at the door instead, so a client bug
		// cannot recreate that state.
		if (documentUsage === "CONTEXT") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"An attached file is used as the document itself. To generate from source material, paste the text instead.",
			});
		}

		// Both new fields describe what happens to a *document*, so neither
		// means anything without the tag that says which document. Refused
		// rather than ignored: a caller that sent a usage and got no document
		// behaviour would have no way to tell that the field was dropped.
		if ((documentUsage || targetDocumentId) && !documentTag) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"documentUsage and targetDocumentId require documentTag — they describe what the upload becomes as a document.",
			});
		}

		// The pre-created row must belong to this project. Without the check a
		// caller could point an upload at a document in someone else's project
		// and have the extraction workflow write its contents there.
		if (targetDocumentId) {
			const target = await db.projectDocument.findUnique({
				where: { id: targetDocumentId },
				select: { projectId: true, type: true },
			});
			if (!target || target.projectId !== projectId) {
				throw new ORPCError("NOT_FOUND", {
					message: "Document not found",
				});
			}
			// A tag that disagrees with the row would have the workflow write a
			// PRD's text into a document typed as something else.
			if (target.type !== documentTag) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"documentTag must match the target document's type.",
				});
			}
		}

		// UUID so storage paths are not enumerable from a leaked neighbor.
		const contextId = `ctx_${randomUUID()}`;
		const s3Path = `projects/${projectId}/${contextId}.${fileConfig.extension}`;
		const bucket = config.storage.bucketNames.projectContexts;

		// Get storage provider to determine upload method
		const storageProvider = getStorageProvider();
		let signedUploadUrl: string | null = null;

		if (
			storageProvider.supportsPresignedUrls &&
			storageProvider.getSignedUploadUrl
		) {
			signedUploadUrl = await storageProvider.getSignedUploadUrl(s3Path, {
				bucket,
				contentType: effectiveMimeType,
			});
		}

		// Create database record with pending extraction status
		// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
		const projectContext = await createFileContext({
			projectId,
			type: fileConfig.type,
			s3Path,
			s3Bucket: bucket,
			originalFilename: filename,
			mimeType: effectiveMimeType,
			fileSize: size,
			metadata: {
				title: filename,
				uploadedBy: user.id,
				uploadedAt: new Date().toISOString(),
				...(documentTag
					? {
							documentTag,
							documentTitle: filename.replace(/\.[^/.]+$/, ""),
							...(documentUsage ? { documentUsage } : {}),
							...(targetDocumentId ? { targetDocumentId } : {}),
						}
					: {}),
			},
			userId: user.id,
			organizationId,
		});

		return {
			contextId: projectContext.id,
			signedUploadUrl,
			s3Path,
			useServerUpload: !storageProvider.supportsPresignedUrls,
			storageProvider: storageProvider.type,
			// The type the server resolved, so a client PUTting to the signed URL
			// sends the same Content-Type the presign was minted for rather than
			// the empty/octet-stream value the browser reported.
			contentType: effectiveMimeType,
		};
	});
