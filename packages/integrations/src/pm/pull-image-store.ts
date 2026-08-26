/**
 * Real `PulledImageStore` backed by Fabric's S3-compatible storage.
 *
 * Isolated from `pull-image-ingest.ts` so the pure ingester stays free of
 * `@repo/storage` / `@repo/config` (and unit-testable with a fake store).
 * Images land in the `project-contexts` bucket under the same `story-media/`
 * keyspace as pasted story images, so the existing StoryWorkspace reload
 * refresher resolves them to signed URLs with no extra wiring.
 */

import { config } from "@repo/config";
import { getStorageProvider } from "@repo/storage";
import type { PulledImageStore } from "./pull-image-ingest";

/** AWS caps presigned URLs at 7 days; mirror the push pipeline's TTL. */
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createStoryMediaPullStore(): PulledImageStore {
	const provider = getStorageProvider();
	const bucket = config.storage.bucketNames.projectContexts;

	return {
		async exists(key) {
			const meta = await provider.getFileMetadata(key, { bucket });
			return meta != null;
		},
		async put(key, data, contentType) {
			await provider.uploadFile(key, data, { bucket, contentType });
		},
		async signedUrl(key) {
			return provider.getSignedUrl(key, {
				bucket,
				expiresIn: SIGNED_URL_TTL_SECONDS,
			});
		},
	};
}
