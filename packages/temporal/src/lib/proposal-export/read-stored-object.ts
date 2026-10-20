/**
 * A stored object read for a Proposal export (Fizzy #2946), never larger
 * than the export accepts. An upload's signed URL does not bind the size of
 * what is put under its key, and a still-valid one can replace the object at
 * any moment, so no size reported beforehand can be trusted: the object is
 * streamed, its bytes counted as they arrive, and the read is abandoned the
 * moment it passes the cap. At most the cap and one chunk are ever held.
 */

import { getObjectStream } from "@repo/storage";

/** Where a stored object lives. */
export interface StoredObjectLocation {
	bucket: string;
	key: string;
}

/**
 * The object's bytes, or a rejection when it is missing, unreadable or
 * larger than `maxBytes`. Callers drop the asset on any rejection.
 */
export async function readStoredObjectWithin(
	location: StoredObjectLocation,
	maxBytes: number,
): Promise<Buffer> {
	const stream = await getObjectStream(location.key, {
		bucket: location.bucket,
	});
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of stream) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += bytes.length;
			if (total > maxBytes) {
				throw new Error("Stored object is larger than an export reads");
			}
			chunks.push(bytes);
		}
	} finally {
		// Releases the connection whether the read finished or was abandoned.
		stream.destroy();
	}
	return Buffer.concat(chunks, total);
}
