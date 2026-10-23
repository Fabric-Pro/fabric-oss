import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getOrganizationById } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { BRAND_ASSET_MAX_BYTES } from "@repo/utils/brand-assets";
import z from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireOrgMembership } from "../lib/membership";

/**
 * Issue a signed PUT for the organization logo, which client-document
 * Proposals print as the proposer's mark on their covers (Fizzy #2946).
 *
 * The PUT is signed for `image/png` and the exact declared size, capped at
 * the logo's limit, so storage refuses any other body; the export re-encodes
 * the bytes it prints.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization (not the
 * session's), then admin or owner membership of it.
 */
export const createLogoUploadUrl = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/logo-upload-url",
		tags: ["Organizations"],
		summary: "Create logo upload URL",
		description:
			"Create a signed upload URL to upload an logo image to the storage bucket",
	})
	.input(
		z.object({
			organizationId: z.string(),
			/** The PNG's exact size in bytes; the PUT is signed for it. */
			contentLength: z
				.number()
				.int()
				.positive()
				.max(BRAND_ASSET_MAX_BYTES.logo),
		}),
	)
	.handler(
		async ({
			context: { user },
			input: { organizationId, contentLength },
		}) => {
			const organization = await getOrganizationById(organizationId);

			if (!organization) {
				throw new ORPCError("BAD_REQUEST");
			}

			const membership = await requireOrgMembership(
				user.id,
				organizationId,
				["admin", "owner"],
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"You must be an admin or owner of this organization",
				});
			}

			const path = `${organizationId}.png`;
			const storageProvider = getStorageProvider();

			let signedUploadUrl: string | null = null;

			if (
				storageProvider.supportsPresignedUrls &&
				storageProvider.getSignedUploadUrl
			) {
				// Content-Length is a signed header, so a body of any other
				// size is refused by storage, not by us.
				signedUploadUrl = await storageProvider.getSignedUploadUrl(
					path,
					{
						bucket: config.storage.bucketNames.avatars,
						contentType: "image/png",
						contentLength,
					},
				);
			}

			return {
				signedUploadUrl,
				path,
				useServerUpload: !storageProvider.supportsPresignedUrls,
				storageProvider: storageProvider.type,
			};
		},
	);
