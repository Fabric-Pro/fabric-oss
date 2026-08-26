import { config } from "@repo/config";
import { getStorageProvider } from "@repo/storage";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const createAvatarUploadUrl = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/avatar-upload-url",
		tags: ["Users"],
		summary: "Create avatar upload URL",
		description:
			"Create a signed upload URL to upload an avatar image to the storage bucket",
	})
	.handler(async ({ context: { user } }) => {
		const path = `${user.id}.png`;
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
