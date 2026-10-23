import { ORPCError } from "@orpc/server";
import { getStorageProvider } from "@repo/storage";
import {
	BRAND_ASSET_MAX_BYTES,
	isBrandAssetContentType,
} from "@repo/utils/brand-assets";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertGlossyOrProposalArtifactEnabledForOrganization } from "../../../projects/lib/proposal-artifact-feature";
import {
	BRAND_KIT_ASSET_KINDS,
	BRAND_KIT_UPLOAD_URL_TTL_SECONDS,
	brandKitAssetVocabulary,
	brandKitBucket,
	brandKitPendingKey,
	newBrandKitAssetToken,
} from "../../lib/brand-kit-assets";
import { requireOrgMembership } from "../../lib/membership";

/**
 * Issue a signed PUT for a Brand kit hero or font file (Fizzy #2946).
 *
 * Each call writes to a NEW pending object under a server-generated token,
 * which is all the caller gets back to name it with: the key is built from
 * the verified organization and that token, never from input. The PUT is
 * signed for the kind's content type and the exact declared size, capped by
 * the kind, so storage refuses any other body. The bytes are still untrusted
 * — the Brand kit save re-checks them before anything references them.
 *
 * A type or size outside the kind's vocabulary is refused as BAD_REQUEST
 * with the code the browser's pre-check answers for the same file.
 *
 * Recorded by the activity-capture middleware (the name is not a read), so
 * issuance needs no curated audit action of its own.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, then admin
 * or owner membership of it, then the Brand kit gate (GLOSSY_EDITION or
 * PROPOSAL_ARTIFACT for that organization).
 */
export const createBrandAssetUploadUrlProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/brand-kit/asset-upload-url",
		tags: ["Organizations", "Glossy"],
		summary: "Create a Brand kit file upload URL",
		description:
			"A short-lived signed upload for the Brand kit hero image or a font file, and the token that names it when the Brand kit is saved.",
	})
	.input(
		z.object({
			organizationId: z.string(),
			kind: z.enum(BRAND_KIT_ASSET_KINDS),
			contentType: z.string().max(100),
			contentLength: z.number().int().positive(),
		}),
	)
	.output(z.object({ token: z.string(), signedUploadUrl: z.string() }))
	.handler(async ({ context, input }) => {
		const { organizationId } = input;

		const membership = await requireOrgMembership(
			context.user.id,
			organizationId,
			["admin", "owner"],
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be an admin or owner of this organization",
			});
		}
		await assertGlossyOrProposalArtifactEnabledForOrganization(
			organizationId,
		);

		// Size first, then type: the order the save checks a stored upload in.
		const vocabulary = brandKitAssetVocabulary(input.kind);
		if (input.contentLength > BRAND_ASSET_MAX_BYTES[vocabulary]) {
			throw new ORPCError("BAD_REQUEST", {
				message: "The file is too large",
				data: { code: "too_large" },
			});
		}
		if (!isBrandAssetContentType(vocabulary, input.contentType)) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This file type is not supported",
				data: { code: "unsupported" },
			});
		}

		const storageProvider = getStorageProvider();
		if (
			!storageProvider.supportsPresignedUrls ||
			!storageProvider.getSignedUploadUrl
		) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Uploads are temporarily unavailable",
			});
		}

		const token = newBrandKitAssetToken();
		// Content-Length is a signed header, so a body of any other size is
		// refused by storage, not by us.
		const signedUploadUrl = await storageProvider.getSignedUploadUrl(
			brandKitPendingKey(organizationId, token),
			{
				bucket: brandKitBucket(),
				contentType: input.contentType,
				contentLength: input.contentLength,
				expiresIn: BRAND_KIT_UPLOAD_URL_TTL_SECONDS,
			},
		);

		return { token, signedUploadUrl };
	});
