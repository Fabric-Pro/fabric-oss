/**
 * The bytes of a Living Memory write sit in object storage between the request
 * and the commit (ADR-022), never in a request body past a small bound and
 * never in a workflow payload. A file is staged under
 * `memory-writes/<projectId>/<uuid>`, in the bucket the Coding Instructions
 * uploads use, by one of two routes:
 *
 * - the caller uploads it straight to a signed URL (`createUploadUrls`), and
 *   names the key, its size and its SHA-256 in the write;
 * - the server stages inline text itself, under a key no URL was ever signed
 *   for, so those bytes cannot change afterwards.
 *
 * Either way the server reads the object back and checks the size and the hash
 * before it admits the write (`readStagedBytes`), and the workflow checks them
 * again before it commits, because a signed URL stays usable until it expires:
 * what is hashed into the commit is exactly what admission scanned.
 *
 * Imported by the API and by the write activities. Not by the workflow bundle.
 */
import { createHash, randomUUID } from "node:crypto";
import { config } from "@repo/config";
import { getStorageProvider } from "@repo/storage";
import { MAX_CONTEXT_FILE_BYTES } from "../../activities/lib/context-sync-rules";

/** The bucket staged bytes live in: the Coding Instructions bucket. */
export const MEMORY_WRITE_STAGING_BUCKET = config.storage.bucketNames.skills;

/** One staged file may be as large as one synced file. */
export const MAX_STAGED_FILE_BYTES = MAX_CONTEXT_FILE_BYTES;

/** What a staged file is stored as; the sync reads text only. */
export const STAGED_CONTENT_TYPE = "text/plain; charset=utf-8";

const STAGING_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The staging key for a new file of `projectId`'s. */
export function newMemoryWriteStagingKey(projectId: string): string {
	return `memory-writes/${projectId}/${randomUUID()}`;
}

/**
 * Whether `key` is a staging key of THIS project: exactly
 * `memory-writes/<projectId>/<uuid>`, so a write can never name another
 * project's staged bytes, or any other object in the bucket.
 */
export function isMemoryWriteStagingKeyOf(
	projectId: string,
	key: string,
): boolean {
	const prefix = `memory-writes/${projectId}/`;
	return key.startsWith(prefix) && STAGING_ID.test(key.slice(prefix.length));
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export type StagedRead =
	| { ok: true; bytes: Buffer }
	| { ok: false; reason: "missing" | "too-large" | "size" | "sha256" };

/**
 * The bytes at `key`, if they are the file the write named: present, within
 * the file bound, and exactly `bytes` long with exactly `sha256`. The size is
 * read from the object's metadata before any byte is downloaded, so an object
 * larger than the bound is never read. A storage fault is thrown, not read as
 * a mismatch: it can pass.
 */
export async function readStagedBytes(input: {
	key: string;
	bytes: number;
	sha256: string;
}): Promise<StagedRead> {
	const storage = getStorageProvider();
	const meta = await storage.getFileMetadata(input.key, {
		bucket: MEMORY_WRITE_STAGING_BUCKET,
	});
	if (meta === null) {
		return { ok: false, reason: "missing" };
	}
	if (meta.size > MAX_STAGED_FILE_BYTES) {
		return { ok: false, reason: "too-large" };
	}
	if (meta.size !== input.bytes) {
		return { ok: false, reason: "size" };
	}
	const { data } = await storage.downloadFile(input.key, {
		bucket: MEMORY_WRITE_STAGING_BUCKET,
	});
	const bytes = Buffer.from(data);
	if (bytes.length !== input.bytes) {
		return { ok: false, reason: "size" };
	}
	if (sha256Hex(bytes) !== input.sha256) {
		return { ok: false, reason: "sha256" };
	}
	return { ok: true, bytes };
}

/** Stages inline text under a key of the project's own, and describes what was stored. */
export async function stageInlineBytes(input: {
	projectId: string;
	bytes: Buffer;
}): Promise<{ stagedKey: string; bytes: number; sha256: string }> {
	const stagedKey = newMemoryWriteStagingKey(input.projectId);
	await getStorageProvider().uploadFile(stagedKey, input.bytes, {
		bucket: MEMORY_WRITE_STAGING_BUCKET,
		contentType: STAGED_CONTENT_TYPE,
	});
	return {
		stagedKey,
		bytes: input.bytes.length,
		sha256: sha256Hex(input.bytes),
	};
}

/**
 * Removes staged objects, best effort: a key that cannot be removed is left
 * for the bucket's own lifecycle. Returns how many keys it could not remove.
 */
export async function deleteStagedBytes(
	keys: readonly string[],
): Promise<number> {
	if (keys.length === 0) {
		return 0;
	}
	const { errors } = await getStorageProvider().deleteObjects([...keys], {
		bucket: MEMORY_WRITE_STAGING_BUCKET,
	});
	return errors.length;
}
