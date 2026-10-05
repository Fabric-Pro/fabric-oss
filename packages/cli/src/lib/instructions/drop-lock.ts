/**
 * Retiring an upload-era ledger in a checkout git now keeps current.
 *
 * `.fabric/instructions.lock` records what an earlier `sync` wrote. A project
 * that has since moved to a repository, in a checkout of that repository, has
 * no use for it: nothing is copied there any more, and a stale ledger would
 * only describe files git owns. So `init` removes it, once, and says so.
 *
 * Only a lock this project wrote, that parses, and that is still exactly what
 * was read is removed, through the same guarded deletion `sync` uses. The
 * files the ledger names are never touched: git tracks them.
 */
import { createHash } from "node:crypto";
import { rmdir } from "node:fs/promises";
import path from "node:path";
import { LOCK_DIRECTORY, LOCK_FILENAME, parseLock } from "./lock.js";
import { deleteFileSafely, readFileSafely } from "./safe-write.js";

const LOCK_RELATIVE = `${LOCK_DIRECTORY}/${LOCK_FILENAME}`;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;

/**
 * Whether the lock was removed. `false` for no lock, another project's lock,
 * one that does not parse, one that changed while this ran, or any refusal of
 * the guarded reader: each is left exactly as it was.
 */
export async function dropOwnLock(
	root: string,
	projectId: string,
): Promise<boolean> {
	try {
		const read = await readFileSafely(root, LOCK_RELATIVE, {
			maxBytes: MAX_LOCK_BYTES,
		});
		if (read === null) {
			return false;
		}
		const lock = parseLock(Buffer.from(read.bytes).toString("utf8"));
		if (lock.projectId !== projectId) {
			return false;
		}
		const sha256 = createHash("sha256").update(read.bytes).digest("hex");
		const outcome = await deleteFileSafely(root, LOCK_RELATIVE, sha256);
		if (outcome !== "deleted") {
			return false;
		}
		await rmdir(path.join(root, LOCK_DIRECTORY)).catch(() => undefined);
		return true;
	} catch {
		return false;
	}
}
