import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { getInstructionSnapshot, listInstructionFiles } from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { exportKey } from "../storage-keys";
import { type FileForZip, streamInstructionZip } from "./stream-zip";

const BUCKET = config.storage.bucketNames.skills;

type SnapshotForZip = {
	id: string;
	version: number;
	/** sha256 over the snapshot's sorted path+hash lines; set when READY. */
	digest: string | null;
	readyAt: Date | null;
	createdAt: Date;
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
 * its archive is too: rebuilding it streams files through a bounded window and
 * publishing a snapshot pre-builds the archive
 * (`warmInstructionSnapshotExport`) so that cost normally falls on nobody
 * waiting. The stamp used to be `Date.now()`, which made every Download and
 * every bundle call write a brand-new full copy of the tree into a bucket
 * nothing ever swept — and the bundle tool's own description tells agents to
 * poll it and compare digests, so a team of agents accumulated one copy per
 * session each, indefinitely.
 *
 * Archive output is streamed to multipart storage. Source streams are opened
 * through a bounded window and consumed in input order, without retaining the
 * entire tree or ZIP in memory.
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

	await streamInstructionZip({
		key,
		bucket: BUCKET,
		date: input.snapshot.readyAt ?? input.snapshot.createdAt,
		files: input.files,
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
