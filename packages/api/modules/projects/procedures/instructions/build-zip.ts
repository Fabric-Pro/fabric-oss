import { PassThrough } from "node:stream";
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { getInstructionSnapshot } from "@repo/database";
import { exportKey } from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import archiver from "archiver";

const BUCKET = config.storage.bucketNames.skills;

type SnapshotForZip = {
	id: string;
	version: number;
	/** sha256 over the snapshot's sorted path+hash lines; set when READY. */
	digest: string | null;
	readyAt: Date | null;
	createdAt: Date;
};

type FileForZip = {
	path: string;
	storageKey: string;
	mode: number | null;
};

/**
 * Zips a snapshot's approved (READY) file set from its immutable
 * `snapshots/` prefix — never the `staging/` upload — and uploads the
 * archive to an `exports/` key, returning a signed GET URL.
 *
 * Shared by the oRPC download procedure (`create-download-url.ts`) and the
 * MCP `fabric_get_project_instruction_bundle` tool so the two surfaces can
 * never build the export differently. Callers are responsible for the
 * tenant/access check and for confirming the snapshot is READY; this
 * function only builds the archive from what it is given.
 *
 * The key is derived from the snapshot's DIGEST, and an object that is
 * already there is reused rather than rebuilt. A snapshot is immutable, so
 * its archive is too: rebuilding it produces the same bytes at a cost of one
 * download per file. The stamp used to be `Date.now()`, which made every
 * Download and every bundle call write a brand-new full copy of the tree into
 * a bucket nothing ever swept — and the bundle tool's own description tells
 * agents to poll it and compare digests, so a team of agents accumulated one
 * copy per session each, indefinitely.
 *
 * Buffers the whole archive in memory rather than streaming it, because
 * `SNAPSHOT_LIMITS.maxTotalBytes` already bounds a coding-instructions
 * upload to a size safe to hold in memory once.
 *
 * `organizationId` is the PROJECT's hosting organization, resolved by the
 * caller, and it is used for one thing: re-reading the snapshot after the
 * upload. A delete running concurrently sweeps this snapshot's export prefix
 * and would otherwise miss an archive written a moment later, resurrecting a
 * full copy of a version somebody deleted precisely because of what was in it.
 */
export async function buildInstructionSnapshotZip(input: {
	projectId: string;
	organizationId: string;
	snapshot: SnapshotForZip;
	files: FileForZip[];
}): Promise<{ url: string; key: string }> {
	const storage = getStorageProvider();
	// `digest` is set when a snapshot reaches READY and only a READY snapshot
	// is downloadable, so the fallback is unreachable in practice — but it
	// has to be deterministic too, or one missing digest would reintroduce
	// the unbounded accumulation this key shape exists to stop.
	const stamp = input.snapshot.digest ?? `v${input.snapshot.version}`;
	const key = exportKey(input.projectId, input.snapshot.id, stamp);

	const sign = () =>
		storage.getSignedUrl(key, {
			bucket: BUCKET,
			expiresIn: 600,
			responseContentDisposition: `attachment; filename="coding-instructions-v${input.snapshot.version}.zip"`,
		});

	const existing = await storage.getFileMetadata(key, { bucket: BUCKET });
	if (existing) {
		return { url: await sign(), key };
	}

	const archive = archiver("zip", { zlib: { level: 6 } });
	const sink = new PassThrough();
	const chunks: Buffer[] = [];
	sink.on("data", (c: Buffer) => chunks.push(c));
	const done = new Promise<void>((resolve, reject) => {
		sink.on("end", () => resolve());
		archive.on("error", reject);
	});
	archive.pipe(sink);
	for (const f of input.files) {
		const { data } = await storage.downloadFile(f.storageKey, {
			bucket: BUCKET,
		});
		archive.append(data, {
			name: f.path,
			mode: f.mode ?? undefined,
			date: input.snapshot.readyAt ?? input.snapshot.createdAt,
		});
	}
	await archive.finalize();
	await done;

	await storage.uploadFile(key, Buffer.concat(chunks), {
		bucket: BUCKET,
		contentType: "application/zip",
	});

	// The snapshot can have been deleted while this archive was being built,
	// and a delete sweeps the export prefix BEFORE an upload that finishes
	// after it. Re-read, and if the snapshot is gone, remove what was just
	// written rather than leaving a copy of a deleted version behind. The
	// reuse path above needs no such check: an object that already existed is
	// one the delete's own sweep will collect.
	const stillThere = await getInstructionSnapshot(
		input.snapshot.id,
		input.projectId,
		input.organizationId,
	);
	if (!stillThere) {
		// `deleteObjects` is best-effort: it NEVER throws on a delete failure
		// and reports per-key failures in `errors` (`packages/storage/types.ts`).
		// Discarding that result here meant the one case this re-read exists
		// for — the archive of a deleted snapshot — could fail to clean up and
		// still report only NOT_FOUND, leaving a full copy of a version
		// somebody deleted precisely because of what it held, with nothing
		// saying so. The cleanup failure is the more serious outcome, so it is
		// reported instead of the NOT_FOUND.
		//
		// Count only, like the twins in `delete-snapshot.ts` and the Temporal
		// activities: a key names a project, a snapshot and a file id, and this
		// string is returned to the client.
		const cleanup = await storage.deleteObjects([key], { bucket: BUCKET });
		if (cleanup.errors.length > 0) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Could not delete ${cleanup.errors.length} stored object(s)`,
			});
		}
		throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
	}
	return { url: await sign(), key };
}
