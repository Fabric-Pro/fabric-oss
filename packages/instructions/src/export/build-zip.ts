import { PassThrough } from "node:stream";
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { getInstructionSnapshot, listInstructionFiles } from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import archiver from "archiver";
import { exportKey } from "../storage-keys";

const BUCKET = config.storage.bucketNames.skills;

/**
 * How many file downloads may be in flight at once while an archive is being
 * built.
 *
 * A snapshot is a whole tree of small files — 448 of them on one real
 * project — and one round trip each, serialized, is what made the first
 * download of a new version take a minute and a half. The pool is fixed
 * rather than unbounded because the object store is shared with every other
 * request the process is serving, and `SNAPSHOT_LIMITS.maxTotalBytes` bounds
 * the total bytes, not the number of simultaneous connections.
 */
const DOWNLOAD_CONCURRENCY = 16;

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
 * The export object's key for a snapshot: derived from its digest, falling
 * back to its version when there is none.
 *
 * `digest` is set when a snapshot reaches READY and only a READY snapshot is
 * downloadable, so the fallback is unreachable in practice — but it has to be
 * deterministic too, or one missing digest would reintroduce the unbounded
 * accumulation this key shape exists to stop.
 *
 * Shared by the builder's own probe (an existing archive skips the
 * download/zip/upload below) and `warmInstructionSnapshotExport`'s probe (an
 * existing archive skips listing the snapshot's files at all), so the two can
 * never derive different keys for the same snapshot.
 */
function resolveExportKey(
	projectId: string,
	snapshot: Pick<SnapshotForZip, "id" | "version" | "digest">,
): string {
	const stamp = snapshot.digest ?? `v${snapshot.version}`;
	return exportKey(projectId, snapshot.id, stamp);
}

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
 * It lives in `@repo/instructions` rather than in `@repo/api` because
 * `warmInstructionSnapshotExport` below is called from a Temporal activity
 * as well, and a Temporal worker cannot import `@repo/api`.
 *
 * The key is derived from the snapshot's DIGEST, and an object that is
 * already there is reused rather than rebuilt. A snapshot is immutable, so
 * its archive is too: rebuilding it downloads every file again, with up to
 * `DOWNLOAD_CONCURRENCY` of those downloads in flight at a time, and
 * publishing a snapshot pre-builds the archive
 * (`warmInstructionSnapshotExport`) so that cost normally falls on nobody
 * waiting. The stamp used to be `Date.now()`, which made every Download and
 * every bundle call write a brand-new full copy of the tree into a bucket
 * nothing ever swept — and the bundle tool's own description tells agents to
 * poll it and compare digests, so a team of agents accumulated one copy per
 * session each, indefinitely.
 *
 * Buffers the whole archive in memory rather than streaming it, because
 * `SNAPSHOT_LIMITS.maxTotalBytes` already bounds a coding-instructions
 * upload to a size safe to hold in memory once. The concurrent downloads are
 * bounded by the same number: every file's bytes were already going to be
 * held at once by the archive buffer.
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
	const key = resolveExportKey(input.projectId, input.snapshot);

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

	// Downloads run concurrently; the ARCHIVE is still written in input
	// order. A zip's entry order is part of what it is — the manifest, the
	// CLI's ledger and the tests all read the tree in the order the file rows
	// came in — so the pool fills a slot-indexed array and nothing is
	// appended until every slot holds its bytes. `Promise.all` over
	// `files.map(...)` would have opened one connection per file, which is
	// the failure mode the cap exists to avoid on a 448-file tree.
	//
	// A worker never lets its promise reject: one that catches a download
	// error records it as `firstError` (only the first one — later workers
	// leave it alone) and flips `stopped`, then returns instead of claiming
	// another index. Every other worker checks `stopped` before claiming its
	// next index, so the pool stops growing the instant one download fails,
	// but `Promise.all` still waits for every download already in flight to
	// settle rather than racing ahead of them — those bytes are written into
	// `bytes` (unused, since the caller below throws) but never left as
	// dangling, untracked fetches the way an unguarded `Promise.all` over a
	// rejecting worker would. Once every worker has returned, the same error
	// object is thrown — never wrapped — so the caller's error classes
	// (ORPCError, a storage provider's own class) are unchanged.
	const bytes: Buffer[] = new Array(input.files.length);
	let cursor = 0;
	let stopped = false;
	// `failed` is its own flag rather than `firstError !== undefined`: a
	// promise can reject with `undefined`, and that rejection is still a
	// failed download whose slot must never reach the archive.
	let failed = false;
	let firstError: unknown;
	const worker = async () => {
		while (!stopped) {
			const index = cursor++;
			const file = input.files[index];
			if (!file) {
				return;
			}
			try {
				const { data } = await storage.downloadFile(file.storageKey, {
					bucket: BUCKET,
				});
				bytes[index] = data;
			} catch (error) {
				if (!failed) {
					failed = true;
					firstError = error;
				}
				stopped = true;
				return;
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(DOWNLOAD_CONCURRENCY, input.files.length) },
			worker,
		),
	);
	if (failed) {
		throw firstError;
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
	for (const [index, f] of input.files.entries()) {
		archive.append(bytes[index], {
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

/**
 * Builds the export archive for a snapshot that has just become the
 * project's published pointer, so the first person to download it does not
 * have to wait for it.
 *
 * The archive is keyed on the snapshot's digest and reused once written, so
 * only the FIRST download of a version ever paid the build — and it paid all
 * of it, inside a request the CLI gives a short budget. On a 448-file tree
 * that meant `fabric instructions sync` timed out, retried, and started a
 * second and third concurrent build of the same archive.
 *
 * NEVER THROWS, and every caller relies on that. The pointer has already
 * moved by the time this runs: a publish that reported success must not be
 * turned into a failure (or, from a Temporal activity, into a retry of a
 * publish that already happened) because an object store was briefly
 * unavailable. The lazy build in `createDownloadUrl` and in the MCP bundle
 * tool is still there, so the whole cost of a warm that failed is that the
 * first downloader waits the way they used to.
 *
 * A snapshot that is missing or not READY is not an error either: only a
 * READY snapshot is downloadable, so there is nothing to pre-build.
 *
 * Probes for an existing archive itself, with the same `resolveExportKey`
 * the builder uses, before loading a single file row. An idempotent republish
 * — a Temporal retry of the publish activity, or two calls racing to warm the
 * same version — would otherwise list every file in the snapshot only to have
 * the builder's OWN probe discover the archive was already there; on a
 * 448-file tree that is 448 database rows read for nothing.
 */
export async function warmInstructionSnapshotExport(input: {
	projectId: string;
	organizationId: string;
	snapshotId: string;
}): Promise<void> {
	try {
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			input.organizationId,
		);
		if (!snapshot || snapshot.status !== "READY") {
			return;
		}
		const storage = getStorageProvider();
		const key = resolveExportKey(input.projectId, snapshot);
		const existing = await storage.getFileMetadata(key, { bucket: BUCKET });
		if (existing) {
			return;
		}
		const files = await listInstructionFiles(
			snapshot.id,
			input.organizationId,
		);
		await buildInstructionSnapshotZip({
			projectId: input.projectId,
			organizationId: input.organizationId,
			snapshot,
			files,
		});
	} catch (error) {
		// IDS ONLY. A file path is user data and an error message from the
		// object store can quote a key or the bytes that failed, so the error
		// is reduced to its class name — the same rule the validation
		// activities follow when they log a failure.
		logger.warn(
			{
				event: "project.instructions.export_warm_failed",
				snapshotId: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				failure:
					error instanceof Error ? error.constructor.name : "unknown",
			},
			"[CodingInstructions] Could not pre-build the export archive",
		);
	}
}
