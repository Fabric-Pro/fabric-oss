import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import {
	companyContextStoragePrefix,
	createCompanyFileSource,
} from "@repo/database";
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
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertCompanyContextEditor } from "./lib/access";

/**
 * Reserve a company context file source and hand back a signed URL to PUT its
 * bytes to (Fizzy #2719). `processFile` starts extraction once the upload
 * lands.
 *
 * The formats and size limits are the project Context tab's, read from the
 * same allowlist. The object key is `{organizationId}/company-context/{uuid}`
 * in the project-contexts bucket — random, so keys are not
 * enumerable, and under the prefix organization deletion sweeps.
 *
 * Storage that cannot presign is refused before any row is written: the
 * browser has nowhere else to send a company file.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate.
 */
export const createCompanyContextUploadUrlProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/company-context/upload-url",
		tags: ["Organizations", "Company context"],
		summary: "Create a company context upload URL",
		description:
			"Reserve a file source in the organization's company context and return a signed URL to upload its bytes to.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			filename: z.string().trim().min(1).max(255),
			mimeType: z.string().max(255),
			size: z.number().int().nonnegative(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId, filename, mimeType, size } = input;
		await assertCompanyContextEditor(organizationId, user.id);

		// The same checks and messages as the project Context tab's upload.
		const effectiveMimeType = resolveContextUploadMime(mimeType, filename);
		const fileConfig = contextUploadConfigFor(effectiveMimeType);
		if (!fileConfig) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported file type for "${filename}": ${mimeType || "unknown"}. Supported types: ${CONTEXT_UPLOAD_FORMAT_LABELS.join(", ")}`,
			});
		}
		const maxSize = UPLOAD_SIZE_LIMITS[fileConfig.type];
		if (size > maxSize) {
			throw new ORPCError("BAD_REQUEST", {
				message: `File ${filename} is too large. ${formatSizeLimit(maxSize)}.`,
			});
		}

		const storageProvider = getStorageProvider();
		if (
			!storageProvider.supportsPresignedUrls ||
			!storageProvider.getSignedUploadUrl
		) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"File uploads to company context need storage that supports signed upload URLs.",
			});
		}

		const s3Path = `${companyContextStoragePrefix(organizationId)}${randomUUID()}.${fileConfig.extension}`;
		const bucket = config.storage.bucketNames.projectContexts;
		const signedUploadUrl = await storageProvider.getSignedUploadUrl(
			s3Path,
			{ bucket, contentType: effectiveMimeType },
		);

		// Always FILE: company context accepts FILE, TEXT and LINK sources, and
		// the file's own kind is carried by its MIME type.
		const source = await createCompanyFileSource({
			organizationId,
			createdByUserId: user.id,
			s3Path,
			s3Bucket: bucket,
			originalFilename: filename,
			mimeType: effectiveMimeType,
			fileSize: size,
			metadata: {
				title: filename,
				uploadedBy: user.id,
				uploadedAt: new Date().toISOString(),
			},
		});

		return {
			sourceId: source.id,
			signedUploadUrl,
			// The type the server resolved, so the PUT sends the Content-Type
			// the signature was minted for.
			contentType: effectiveMimeType,
		};
	});
