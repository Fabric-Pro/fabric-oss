import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getOrganizationById } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import z from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../lib/membership";

export const createLogoUploadUrl = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
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
		}),
	)
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		const organization = await getOrganizationById(organizationId);

		if (!organization) {
			throw new ORPCError("BAD_REQUEST");
		}

		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN");
		}

		const path = `${organizationId}.png`;
		const storageProvider = getStorageProvider();

		let signedUploadUrl: string | null = null;

		if (
			storageProvider.supportsPresignedUrls &&
			storageProvider.getSignedUploadUrl
		) {
			signedUploadUrl = await storageProvider.getSignedUploadUrl(path, {
				bucket: config.storage.bucketNames.avatars,
				contentType: "image/png",
			});
		}

		return {
			signedUploadUrl,
			path,
			useServerUpload: !storageProvider.supportsPresignedUrls,
			storageProvider: storageProvider.type,
		};
	});
