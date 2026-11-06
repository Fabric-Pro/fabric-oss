/**
 * Deletes the storage objects of a coding-instructions snapshot whose rows
 * are already gone: the single-version delete (`delete-snapshot.ts`) and the
 * removal of every version (`remove-all.ts`).
 *
 * Both run AFTER the row delete commits, and the row delete leaves a
 * storage-cleanup receipt for each snapshot in the same transaction, so a
 * failure here is retried by the storage reaper rather than lost.
 */
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { snapshotOwnedPrefixes } from "@repo/instructions";
import {
	type DeleteObjectsResult,
	getStorageProvider,
	type StorageProviderInterface,
} from "@repo/storage";

const BUCKET = config.storage.bucketNames.skills;

/**
 * `deleteObjects` is best-effort: it NEVER throws on a delete failure and
 * reports per-key failures in `errors` (`packages/storage/types.ts`).
 * Discarding that result reported a delete as complete while the objects were
 * still in the bucket — for someone deleting a version precisely because of
 * what it held. The Temporal twin of this check lives in
 * `activities/project-instructions.ts`; there a throw means a retry, here it
 * means the caller is told the delete did not finish.
 *
 * The message carries the COUNT only: a key names a project, a snapshot and a
 * file id, and this string is returned to the client.
 */
function assertAllDeleted(result: DeleteObjectsResult): void {
	if (result.errors.length > 0) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: `Could not delete ${result.errors.length} stored object(s)`,
		});
	}
}

/**
 * Deletes every object under a prefix, paginated to completion. Keys that are
 * already gone are tolerated, so this is safe when the prefix is empty or the
 * delete is a retry; a key that genuinely could not be deleted throws.
 */
async function deleteObjectsUnderPrefix(
	storage: StorageProviderInterface,
	prefix: string,
): Promise<void> {
	let continuationToken: string | undefined;
	do {
		const page = await storage.listObjects({
			bucket: BUCKET,
			prefix,
			continuationToken,
		});
		const keys = page.objects.map((o) => o.key);
		if (keys.length > 0) {
			assertAllDeleted(
				await storage.deleteObjects(keys, { bucket: BUCKET }),
			);
		}
		continuationToken = page.nextContinuationToken;
	} while (continuationToken);
}

/**
 * Deletes `keys` (the snapshot's own objects its file rows named, already
 * filtered through `isKeyOwnedBySnapshot`), then everything under the
 * snapshot's own prefixes, which the rows do not know about: the export zips
 * built from it, and any staged or promoted object no row names. Throws when
 * an object could not be deleted.
 */
export async function deleteSnapshotObjects(input: {
	projectId: string;
	snapshotId: string;
	keys: readonly string[];
}): Promise<void> {
	const storage = getStorageProvider();
	if (input.keys.length > 0) {
		assertAllDeleted(
			await storage.deleteObjects([...input.keys], { bucket: BUCKET }),
		);
	}
	for (const prefix of snapshotOwnedPrefixes(
		input.projectId,
		input.snapshotId,
	)) {
		await deleteObjectsUnderPrefix(storage, prefix);
	}
}
