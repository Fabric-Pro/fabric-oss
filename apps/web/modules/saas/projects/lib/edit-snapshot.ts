import { sha256Hex } from "@repo/instructions";
import { orpcClient } from "@shared/lib/orpc-client"; // the raw client createTanstackQueryUtils wraps (see orpc-query-utils.ts:4)
import { putWithRetry } from "./upload-snapshot";

/**
 * One change to the published tree, as the tab's Edit / Delete file / Add file
 * actions express it.
 *
 * `body` is a `Blob` for both cases the tab produces: a textarea's text
 * wrapped in one, and a picked `File` (which is a Blob). Nothing here reads
 * the bytes except to hash and send them.
 */
export type InstructionEdit =
	| { op: "put"; path: string; body: Blob }
	| { op: "delete"; path: string };

export type EditInstructionSnapshotResult = {
	snapshotId: string;
	version: number;
};

/**
 * Turns a small set of per-path changes into a new version, on exactly the
 * transport an upload uses.
 *
 * `derive` registers the snapshot server-side: the changed paths become
 * staged rows, every other path is inherited from the base without a byte
 * crossing the network. What comes back is the list of rows that still need
 * bytes — and ONLY those. The inherited rows must never be sent to
 * `createUploadUrls`: their keys are the base's immutable objects, and that
 * procedure refuses to point a non-staging key back at writable storage, so
 * asking would fail the whole save.
 *
 * `finalize` then starts the same validation workflow an upload starts, which
 * is the point of the whole design: the secret gate reads every file
 * (inherited ones included), the digest is recomputed, and the tab's existing
 * polling shows the new version being checked, published, or rejected with the
 * banner it already has.
 *
 * Hashes are computed here, client-side, from the same bytes that are sent.
 * The server re-hashes what actually arrives (twice — at the gate and again at
 * promotion), so a wrong hash is a rejected version, never a published one.
 */
export async function editInstructionSnapshot(input: {
	projectId: string;
	baseSnapshotId: string;
	publishOnReady: boolean;
	/** Submit the derived snapshot for editor review instead of direct publication. */
	proposal?: boolean;
	edits: InstructionEdit[];
}): Promise<EditInstructionSnapshotResult> {
	const puts = new Map<string, Blob>();
	const changes: Array<
		| { op: "put"; path: string; size: number; sha256: string }
		| { op: "delete"; path: string }
	> = [];
	for (const edit of input.edits) {
		if (edit.op === "delete") {
			changes.push({ op: "delete", path: edit.path });
			continue;
		}
		const bytes = new Uint8Array(await edit.body.arrayBuffer());
		puts.set(edit.path, edit.body);
		changes.push({
			op: "put",
			path: edit.path,
			size: bytes.byteLength,
			sha256: await sha256Hex(bytes),
		});
	}

	const derived = await orpcClient.projects.instructions.derive({
		projectId: input.projectId,
		baseSnapshotId: input.baseSnapshotId,
		// Proposals always wait for an editor's approval. The API repeats this
		// invariant, but keeping it true at the transport boundary prevents a
		// future proposal caller from accidentally requesting auto-publish.
		publishOnReady: input.proposal ? false : input.publishOnReady,
		proposal: input.proposal ?? false,
		changes,
	});

	if (derived.staged.length > 0) {
		const { uploads } =
			await orpcClient.projects.instructions.createUploadUrls({
				projectId: input.projectId,
				snapshotId: derived.snapshotId,
				fileIds: derived.staged.map((f) => f.fileId),
			});
		// Sequential: a change set is capped at 50 paths and the tab sends
		// one, so the bounded-concurrency queue the folder upload needs would
		// be machinery with nothing to do.
		for (const upload of uploads) {
			const body = puts.get(upload.path);
			if (!body) {
				// The server listed a path this call never sent. A stale or
				// foreign snapshot id, or a corrupted response — a real
				// anomaly, not a settings race, so it fails loudly rather
				// than finalizing a version with a file missing.
				throw new Error(
					`Server listed an unknown path: ${upload.path}`,
				);
			}
			await putWithRetry(
				upload.path,
				upload.url,
				body,
				upload.contentType,
			);
		}
	}

	await orpcClient.projects.instructions.finalize({
		projectId: input.projectId,
		snapshotId: derived.snapshotId,
	});
	return { snapshotId: derived.snapshotId, version: derived.version };
}
