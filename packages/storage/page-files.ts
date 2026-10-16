import { getStorageProvider } from "./provider";
import { buildFramePageFilesPrefix } from "./tenant-paths";

/**
 * The count only: a key names an organization, a page and a file, and this
 * message reaches the client.
 */
export class PageFilesNotDeletedError extends Error {
	readonly failed: number;
	constructor(failed: number) {
		super(`Could not delete ${failed} stored file(s) of the page`);
		this.name = "PageFilesNotDeletedError";
		this.failed = failed;
	}
}

/**
 * Deletes every file stored for a page, paged to completion. Files already
 * gone are tolerated, so it is safe on a page with none and on a retry; a file
 * that could not be deleted throws, after the rest were tried.
 *
 * `bucket` is the Workspace documents bucket. It is passed in because this
 * package does not read configuration, and uploads must use the same bucket or
 * a deleted page leaves its files behind.
 */
export async function deleteFramePageFiles(
	page: {
		organizationId: string | null | undefined;
		userId: string;
		frameId: string;
	},
	options: { bucket: string },
): Promise<{ deleted: number }> {
	const storage = getStorageProvider();
	const prefix = buildFramePageFilesPrefix(page);
	let deleted = 0;
	let failed = 0;
	let continuationToken: string | undefined;
	do {
		const listing = await storage.listObjects({
			bucket: options.bucket,
			prefix,
			continuationToken,
		});
		const keys = listing.objects.map((object) => object.key);
		if (keys.length > 0) {
			const result = await storage.deleteObjects(keys, {
				bucket: options.bucket,
			});
			deleted += result.deleted;
			failed += result.errors.length;
		}
		continuationToken = listing.nextContinuationToken;
	} while (continuationToken);
	if (failed > 0) {
		throw new PageFilesNotDeletedError(failed);
	}
	return { deleted };
}
