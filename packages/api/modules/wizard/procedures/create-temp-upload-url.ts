import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { createWizardTempContext } from "@repo/database";
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
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const VALID_DOCUMENT_TAGS = ProjectDocumentTypeSchema.options;

export const createTempUploadUrlProcedure = tenantProtectedProcedure
	// Evaluated against the organization named in the input, not the
	// session's: wizard temp contexts are stamped with it, and processing one
	// runs extraction and embeddings on that organization's AI provider.
	// `requireOrganization`: temp contexts exist only to become a project's
	// in an organization (ADR-018). Without it a null organization resolves
	// nothing and the role check is skipped — an organization viewer could
	// upload and process files the session role used to refuse them.
	.use(
		requireInputOrgPermission(Permissions.PROJECT_CREATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/wizard/temp-contexts/upload-url",
		tags: ["Wizard", "Temp Contexts"],
		summary: "Create temp context upload URL",
		description:
			"Generate a signed URL for uploading a file to wizard temp context (before project creation)",
	})
	.input(
		z.object({
			sessionId: z.string().min(1, "Session ID is required"),
			organizationId: z.string().nullable().optional(),
			filename: z.string().min(1, "Filename is required"),
			mimeType: z.string().min(1, "MIME type is required"),
			size: z.number().positive("File size must be positive"),
			documentTag: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { sessionId, filename, mimeType, size, documentTag } = input;
		const user = context.user;
		// The organization the gate authorized (it resolves the same way), so
		// an omitted one is the session's here too, never the null arm.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Validate file type. Same message shape as the project-context
		// procedure: name the file, say "unknown" when the browser reported no
		// MIME (#2139), and keep the supported-formats list.
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

		// Generate context ID and S3 path
		const contextId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const s3Path = `wizard-temp/${user.id}/${sessionId}/${contextId}.${fileConfig.extension}`;
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
		const tempContext = await createWizardTempContext({
			sessionId,
			userId: user.id,
			organizationId: organizationId ?? undefined,
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
						}
					: {}),
			},
		});

		return {
			contextId: tempContext.id,
			signedUploadUrl,
			s3Path,
			useServerUpload: !storageProvider.supportsPresignedUrls,
			storageProvider: storageProvider.type,
			// The type the server resolved, so the client PUTs the same
			// Content-Type the presign was minted for.
			contentType: effectiveMimeType,
		};
	});
