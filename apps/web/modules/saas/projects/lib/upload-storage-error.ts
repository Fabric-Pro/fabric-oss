/**
 * A browser PUT of a file to object storage that gave up after its retries,
 * whether storage answered with a failing status or could not be reached.
 *
 * It is its own type because it is the one upload failure whose snapshot is
 * worth discarding: the snapshot was begun and none of the checks have run, so
 * it sits RECEIVING with nothing that will ever move it. A refusal of `begin`,
 * `createUploadUrls` or `finalize` is a different failure with a code of its
 * own, and a snapshot `finalize` may already have claimed is not discarded.
 * Kept out of `upload-snapshot.ts` so a test that replaces that module can
 * still use the class.
 */
export class StorageUploadError extends Error {
	readonly path: string;

	constructor(path: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			reason.includes(path)
				? reason
				: `Upload failed for ${path}: ${reason}`,
		);
		this.name = "StorageUploadError";
		this.path = path;
		this.cause = cause;
	}
}
