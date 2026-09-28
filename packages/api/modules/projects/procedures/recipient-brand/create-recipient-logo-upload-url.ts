import { ORPCError } from "@orpc/server";
import { LOGO_MAX_INPUT_BYTES } from "@repo/integrations/website-brand";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadRecipientBrandProject,
	newRecipientLogoToken,
	RECIPIENT_LOGO_UPLOAD_CONTENT_TYPES,
	RECIPIENT_LOGO_UPLOAD_URL_TTL_SECONDS,
	recipientBrandBucket,
	recipientLogoPendingKey,
} from "../../lib/recipient-brand";
import { requireGlossyEnabled } from "../../lib/glossy-feature";

/**
 * Issue a signed PUT for a manually uploaded recipient logo (Fizzy #2589,
 * R33, KTD23).
 *
 * Each call writes to a NEW pending object under a server-generated token,
 * which is all the caller gets back to name it with: the key is built from
 * the gated project and that token, never from input. The PUT is signed for
 * the declared image type and exact size, capped at `LOGO_MAX_INPUT_BYTES`,
 * so storage refuses any other body. The bytes are still untrusted —
 * confirmation re-checks and re-encodes them before anything references them.
 *
 * Recorded by the activity-capture middleware (the name is not a read), so
 * issuance needs no curated audit action of its own.
 *
 * AUTHORIZATION: `requireGlossyEnabled` first (gate off → NOT_FOUND for every
 * caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared
 * recipient brand gate including `canEditProject`.
 */
export const createRecipientLogoUploadUrlProcedure = tenantProtectedProcedure
	.use(requireGlossyEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/recipient-brand/logo-upload-url",
		tags: ["Projects", "Glossy"],
		summary: "Create a recipient logo upload URL",
		description:
			"A short-lived signed upload for a recipient logo image, and the token that names it on confirmation.",
	})
	.input(
		z.object({
			projectId: z.string(),
			contentType: z.enum(RECIPIENT_LOGO_UPLOAD_CONTENT_TYPES),
			size: z.number().int().positive().max(LOGO_MAX_INPUT_BYTES),
		}),
	)
	.output(
		z.object({
			token: z.string(),
			signedUploadUrl: z.string(),
			contentType: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		await loadRecipientBrandProject({
			projectId: input.projectId,
			userId: context.user.id,
			write: true,
		});

		const storageProvider = getStorageProvider();
		if (
			!storageProvider.supportsPresignedUrls ||
			!storageProvider.getSignedUploadUrl
		) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Uploads are temporarily unavailable",
			});
		}

		const token = newRecipientLogoToken();
		// Content-Length is a signed header, so a body of any other size is
		// refused by storage, not by us.
		const signedUploadUrl = await storageProvider.getSignedUploadUrl(
			recipientLogoPendingKey(input.projectId, token),
			{
				bucket: recipientBrandBucket(),
				contentType: input.contentType,
				contentLength: input.size,
				expiresIn: RECIPIENT_LOGO_UPLOAD_URL_TTL_SECONDS,
			},
		);

		return { token, signedUploadUrl, contentType: input.contentType };
	});
