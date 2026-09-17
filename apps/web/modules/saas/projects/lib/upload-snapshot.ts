import { orpcClient } from "@shared/lib/orpc-client"; // the raw client createTanstackQueryUtils wraps (see orpc-query-utils.ts:4)
import type { FolderEntry } from "./read-folder";

const UPLOAD_URL_PAGE_SIZE = 200;
const UPLOAD_CONCURRENCY = 6;
const UPLOAD_RETRIES = 3;
const UPLOAD_RETRY_BASE_DELAY_MS = 500;

/**
 * PUTs one file to its signed URL, retrying a handful of times with backoff.
 *
 * Exported for `edit-snapshot.ts`, which drives the same
 * derive → createUploadUrls → PUT → finalize transport for a single-file
 * change: a second copy of the retry-and-name-the-path rule would eventually
 * report failures differently for an edit than for an upload.
 *
 * `body` is a `Blob` rather than a `File` because an in-tab edit has no File
 * to send — the bytes come out of a textarea.
 */
export async function putWithRetry(
	path: string,
	url: string,
	body: Blob,
	contentType: string,
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < UPLOAD_RETRIES; attempt++) {
		try {
			const res = await fetch(url, {
				method: "PUT",
				body,
				headers: { "Content-Type": contentType },
			});
			if (res.ok) {
				return;
			}
			lastError = new Error(
				`Upload failed with ${res.status} for ${path}`,
			);
		} catch (error) {
			lastError = error;
		}
		await new Promise((r) =>
			setTimeout(r, UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt),
		);
	}
	// A caught-error retry loop (fetch throwing, e.g. a network failure) never
	// names the path in the thrown error itself, so wrap it here too — every
	// exit from this function on failure must identify which file failed.
	if (lastError instanceof Error && !lastError.message.includes(path)) {
		throw new Error(`Upload failed for ${path}: ${lastError.message}`);
	}
	throw lastError;
}

export type UploadSnapshotInput = {
	projectId: string;
	entries: FolderEntry[];
	fabricIgnoreText: string | null;
	publishOnReady: boolean;
	onProgress?: (done: number, total: number) => void;
	/**
	 * Fired as soon as the upload's snapshot id is known (right after
	 * `begin`, or immediately for a resumed upload) so a caller can retry a
	 * partial failure against the SAME snapshot instead of starting a new
	 * one. `finalize` is safely re-invocable server-side
	 * (`finalize-snapshot.ts`), and re-signing + re-PUTting an already
	 * uploaded file is a harmless overwrite, so resuming is always safe.
	 */
	onSnapshotStarted?: (snapshotId: string) => void;
	/**
	 * Resume an upload a previous call already `begin`-registered instead of
	 * registering a new one. Set this to the snapshot id from a failed
	 * attempt's `onSnapshotStarted` callback to retry without leaving behind
	 * an abandoned RECEIVING snapshot for every failed attempt.
	 */
	resumeSnapshotId?: string;
};

export type UploadSnapshotResult = {
	snapshotId: string;
	/**
	 * Paths the caller's exclusion preview counted as kept, but that the
	 * server's authoritative `begin`-time ignore evaluation left out of the
	 * snapshot (only `listFiles` after `begin` reflects the server's live
	 * settings — see the doc comment on the `byPath` fallback below for why
	 * this can legitimately happen). These were never uploaded; the caller
	 * should fold them into whatever exclusion count it shows the user
	 * rather than treating the upload as having silently dropped files.
	 */
	serverExcludedPaths: string[];
};

/**
 * Uploads a previewed folder: registers the snapshot (or resumes one from a
 * prior failed attempt), pages through `createUploadUrls` in batches of
 * `UPLOAD_URL_PAGE_SIZE`, PUTs each kept file to its signed URL with bounded
 * concurrency and per-file retry, then finalizes.
 */
export async function uploadSnapshot(
	input: UploadSnapshotInput,
): Promise<UploadSnapshotResult> {
	const kept = input.entries.filter((e) => !e.excluded);

	const snapshotId =
		input.resumeSnapshotId ??
		(
			await orpcClient.projects.instructions.begin({
				projectId: input.projectId,
				publishOnReady: input.publishOnReady,
				fabricIgnoreText: input.fabricIgnoreText,
				files: input.entries.map((e) => ({
					path: e.path,
					size: e.size,
					sha256: e.sha256,
				})),
			})
		).snapshotId;
	input.onSnapshotStarted?.(snapshotId);

	// Keyed from EVERY entry the client read, not just the ones its own
	// (possibly stale — see `CodingInstructionsTab`'s `settingsReady` gate)
	// exclusion preview kept. The client's preview and the server's `begin`
	// handler can legitimately disagree about which paths are excluded (the
	// client previews against whatever `projectGlobs` it was handed; `begin`
	// always re-resolves the project's LIVE settings). Building the map from
	// the full entry list means a path the server decided to keep, that the
	// client's preview had marked excluded, is still found here and uploaded
	// correctly — the server's decision wins, not the client's stale preview.
	const byPath = new Map(input.entries.map((e) => [e.path, e]));
	// The server decides ids; fetch them via listFiles is not available before
	// READY, so begin returns nothing per-file — createUploadUrls takes
	// fileIds, so first list them:
	const files = await orpcClient.projects.instructions.listFiles({
		projectId: input.projectId,
		snapshotId,
		includeReceiving: true,
	});

	// The reverse mismatch: a path the client's preview KEPT, that the
	// server's live settings excluded, never gets a file row at all — it
	// simply won't appear in `files`. Report it rather than letting it
	// silently vanish from the caller's exclusion accounting.
	const serverFilePaths = new Set(files.map((f) => f.path));
	const serverExcludedPaths = kept
		.map((e) => e.path)
		.filter((path) => !serverFilePaths.has(path));

	let done = 0;
	for (let i = 0; i < files.length; i += UPLOAD_URL_PAGE_SIZE) {
		const page = files.slice(i, i + UPLOAD_URL_PAGE_SIZE);
		const { uploads } =
			await orpcClient.projects.instructions.createUploadUrls({
				projectId: input.projectId,
				snapshotId,
				fileIds: page.map((f) => f.id),
			});
		const queue = [...uploads];
		await Promise.all(
			Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
				for (let u = queue.shift(); u; u = queue.shift()) {
					const entry = byPath.get(u.path);
					if (!entry) {
						// A path neither kept NOR excluded by the client — the
						// client never had this path at all. That is a real
						// anomaly (a stale/foreign snapshot id, a corrupted
						// response), not a settings race, so this still fails
						// loudly.
						throw new Error(
							`Server listed an unknown path: ${u.path}`,
						);
					}
					await putWithRetry(
						u.path,
						u.url,
						entry.file,
						u.contentType,
					);
					input.onProgress?.(++done, files.length);
				}
			}),
		);
	}
	await orpcClient.projects.instructions.finalize({
		projectId: input.projectId,
		snapshotId,
	});
	return { snapshotId, serverExcludedPaths };
}
