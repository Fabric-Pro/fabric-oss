import { createHash } from "node:crypto";
import { config } from "@repo/config";
import {
	deleteInstructionSnapshot,
	failInstructionSnapshot,
	getInstructionSnapshotById,
	type InstructionRejection,
	listInstructionFiles,
	listPrunableInstructionSnapshots,
	markInstructionSnapshotReady,
	markInstructionSnapshotRejected,
	publishInstructionSnapshot,
	recordAudit,
	updateInstructionFileMetadata,
} from "@repo/database";
import {
	classifyPath,
	computeSnapshotDigest,
	exportKeyPrefix,
	isSecretFileName,
	isStagingKey,
	parseFrontmatter,
	SNAPSHOT_LIMITS,
	scanTextForSecrets,
	snapshotKey,
	stagingKey,
	stagingPrefix,
} from "@repo/instructions";
import { logger } from "@repo/logs";
import {
	type DeleteObjectsResult,
	getStorageProvider,
	type StorageProviderInterface,
} from "@repo/storage";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";

const BUCKET = config.storage.bucketNames.skills;

/** READY snapshots beyond this many, per project, are prunable (spec §6.3.6). */
const SNAPSHOT_RETENTION = 5;

/**
 * REJECTED/FAILED snapshots beyond this many are prunable. Deliberately much
 * shorter than the READY window: a refused upload is a diagnostic to read
 * once, not history to roll back to, and counting it against the READY
 * window let a run of bad uploads evict every kept version.
 */
const FAILED_SNAPSHOT_RETENTION = 2;

/**
 * Caps a gate's rejection list so a pathological upload (thousands of
 * failing files, or a file with thousands of matching secret-scan lines)
 * cannot produce an unbounded array. That array crosses Temporal's activity
 * payload limits and is persisted verbatim into the `rejection` JSON column,
 * so it must stay bounded regardless of how badly an upload fails.
 */
const MAX_REJECTIONS = 100;

function capRejections(
	rejections: InstructionRejection[],
): InstructionRejection[] {
	if (rejections.length <= MAX_REJECTIONS) {
		return rejections;
	}
	return [
		...rejections.slice(0, MAX_REJECTIONS),
		{
			// A recognizable sentinel, not an empty string — this is persisted
			// into the `rejection` JSON column and read back by UI surfaces that
			// render one row per rejection; a blank `path` renders as an empty
			// row instead of a legible summary line.
			path: "(truncated)",
			reason: "truncated",
			detail: `${rejections.length - MAX_REJECTIONS} more`,
		},
	];
}

export type SnapshotRef = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	userId: string;
};
export type GateResult = { ok: boolean; rejections: InstructionRejection[] };

/**
 * Every activity below loads the snapshot by id and verifies it belongs to
 * the caller's project/organization BEFORE touching storage or running any
 * other query. This is the PRIMARY tenancy check: without it a workflow
 * started (or retried) with a mismatched project/organization would read and
 * mutate another tenant's rows. The `organizationId` every child query in
 * `packages/database/prisma/queries/instructions.ts` now takes is defence in
 * depth behind it, and it is `ref.organizationId` — the value this gate has
 * just proved equals the snapshot's own. A mismatch here is a bug (the caller
 * passed the wrong ids), never a transient condition, so it fails
 * non-retryable rather than retrying into the same wrong answer.
 *
 * Deliberately NOT exported: every export from this module becomes a
 * schedulable Temporal activity (see `activities/index.ts`), and this
 * helper must never be one.
 */
async function loadVerifiedSnapshot(ref: SnapshotRef) {
	const snapshot = await getInstructionSnapshotById(ref.snapshotId);
	if (
		!snapshot ||
		snapshot.projectId !== ref.projectId ||
		snapshot.organizationId !== ref.organizationId
	) {
		throw ApplicationFailure.nonRetryable(
			`Instruction snapshot ${ref.snapshotId} does not belong to project ${ref.projectId} in organization ${ref.organizationId}`,
			"INSTRUCTION_SNAPSHOT_TENANT_MISMATCH",
		);
	}
	return snapshot;
}

/**
 * `deleteObjects` is best-effort: it NEVER throws on a delete failure and
 * reports per-key failures in `errors` (`packages/storage/types.ts`). Every
 * call site in this feature discarded that result, so a snapshot could become
 * terminally REJECTED while the secret-bearing staging object it was rejected
 * for was still in the bucket, and a pruned snapshot could lose its rows while
 * its objects stayed. Failing here makes Temporal retry the activity, which is
 * the behaviour the cleanup always assumed it had.
 *
 * The message carries the COUNT only. A key names a project, a snapshot and a
 * file id, and this string reaches Temporal history and the worker log.
 */
function assertAllDeleted(result: DeleteObjectsResult, phase: string): void {
	if (result.errors.length > 0) {
		throw new Error(
			`Storage delete failed for ${result.errors.length} object(s) during ${phase}`,
		);
	}
}

/**
 * Every object currently under the snapshot's staging prefix, paginated to
 * completion. Used both to verify staged bytes without guessing at a file
 * row's current `storageKey`, and to find leftover staging objects a
 * previous (crashed or partial) attempt left behind.
 */
async function listAllStagingObjects(
	storage: StorageProviderInterface,
	ref: Pick<SnapshotRef, "projectId" | "snapshotId">,
): Promise<Array<{ key: string; size: number }>> {
	const prefix = stagingPrefix(ref.projectId, ref.snapshotId);
	const objects: Array<{ key: string; size: number }> = [];
	let continuationToken: string | undefined;
	do {
		// A snapshot at the file-count ceiling can span several pages; without
		// this, a listing that itself runs long enough (many pages, or a slow
		// upstream) could exceed the shared 60s heartbeatTimeout before the
		// per-file loop that follows ever gets a chance to heartbeat.
		heartbeat({ phase: "list-staging", prefix });
		const page = await storage.listObjects({
			bucket: BUCKET,
			prefix,
			continuationToken,
		});
		for (const object of page.objects) {
			objects.push({ key: object.key, size: object.size });
		}
		continuationToken = page.nextContinuationToken;
	} while (continuationToken);
	return objects;
}

/**
 * Deletes every object under a prefix, paginated to completion. Heartbeats
 * per page so a wide prefix cannot outlast the shared 60s heartbeatTimeout.
 * Already-deleted keys are tolerated, so this is safe on an empty prefix and
 * on a retry; a key that genuinely could not be deleted throws.
 */
async function deleteObjectsUnderPrefix(
	storage: StorageProviderInterface,
	prefix: string,
): Promise<void> {
	let continuationToken: string | undefined;
	do {
		heartbeat({ phase: "delete-prefix", prefix });
		const page = await storage.listObjects({
			bucket: BUCKET,
			prefix,
			continuationToken,
		});
		const keys = page.objects.map((o) => o.key);
		if (keys.length > 0) {
			assertAllDeleted(
				await storage.deleteObjects(keys, { bucket: BUCKET }),
				"prefix sweep",
			);
		}
		continuationToken = page.nextContinuationToken;
	} while (continuationToken);
}

/**
 * Deletes every staging object for a snapshot: the DETERMINISTIC key for
 * every file row — `stagingKey(projectId, snapshotId, fileId)`, present
 * regardless of whatever key the row's `storageKey` column holds right now
 * — plus one paginated sweep of the staging prefix for anything left over.
 *
 * Building the delete set from file rows alone is not enough: once
 * `finalizeInstructionSnapshot` rewrites a row's `storageKey` to its
 * snapshot-prefix key (mid-loop, on a first attempt), a RETRY of finalize
 * can no longer recover that file's original staging key from the row, and
 * would silently leak the object forever. The deterministic key formula
 * does not depend on the row's current state, so every retry computes the
 * same staging key a first attempt would have. The trailing `listObjects`
 * sweep catches anything the deterministic set misses for any other reason.
 * `deleteObjects` is best-effort and tolerates already-deleted keys
 * (`packages/storage/types.ts:130-139`), so calling this unconditionally,
 * on every attempt, is always safe.
 */
async function cleanupStagingObjects(
	storage: StorageProviderInterface,
	ref: SnapshotRef,
	fileIds: string[],
): Promise<void> {
	const deterministicKeys = fileIds.map((id) =>
		stagingKey(ref.projectId, ref.snapshotId, id),
	);
	if (deterministicKeys.length > 0) {
		heartbeat({ phase: "delete-staging", count: deterministicKeys.length });
		assertAllDeleted(
			await storage.deleteObjects(deterministicKeys, { bucket: BUCKET }),
			"staging cleanup",
		);
	}
	const known = new Set(deterministicKeys);
	const leftover = (await listAllStagingObjects(storage, ref))
		.map((object) => object.key)
		.filter((key) => isStagingKey(key) && !known.has(key));
	if (leftover.length > 0) {
		heartbeat({ phase: "delete-staging-leftover", count: leftover.length });
		assertAllDeleted(
			await storage.deleteObjects(leftover, { bucket: BUCKET }),
			"staging sweep",
		);
	}
}

/**
 * Decodes a staged object as strict UTF-8, or reports that it is binary.
 *
 * `Buffer.toString("utf8")` never fails — it substitutes U+FFFD for every
 * invalid sequence — so it cannot answer "is this text?", and a JPEG decoded
 * that way produces a long string of replacement characters that the rule set
 * then happily scans and passes. `TextDecoder` in fatal mode throws instead,
 * which is the answer we need. The NUL check is the second half: a UTF-16LE
 * or UTF-32 payload, and plenty of container formats, decode as valid UTF-8
 * while being unambiguously not text, and a NUL byte is the cheapest reliable
 * marker of that.
 */
function decodeUtf8Text(data: Buffer): string | null {
	if (data.includes(0)) {
		return null;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		// NUL-free but not valid UTF-8: a Latin-1 or mixed-encoding text file.
		// It is still text and must still be scanned (unsupported content is a
		// failure, never a pass), so decode byte-for-byte; every rule pattern
		// is ASCII, which latin1 preserves exactly.
		return data.toString("latin1");
	}
}

/**
 * Resolves the key a snapshot's file is currently readable at, or says why it
 * is not readable at all.
 *
 * A row is at its deterministic staging key on the ordinary path, and at its
 * deterministic SNAPSHOT key when a previous, partial `finalizeInstructionSnapshot`
 * already promoted it (that activity rewrites `storageKey` file by file, so a
 * crash mid-loop leaves some rows on each side). A fresh workflow run is the
 * advertised recovery route for a stuck VALIDATING row, so it must not report
 * an already-promoted file as "missing" purely because it has left the
 * staging prefix. Anywhere else is not a location any activity in this module
 * ever wrote it to.
 */
function resolveReadableKey(
	ref: SnapshotRef,
	file: { id: string; path: string; size: number; storageKey: string },
	staged: Map<string, number>,
): { key: string } | { rejection: InstructionRejection } {
	if (isStagingKey(file.storageKey)) {
		const size = staged.get(file.storageKey);
		if (size === undefined) {
			return { rejection: { path: file.path, reason: "missing" } };
		}
		if (size !== file.size) {
			return {
				rejection: {
					path: file.path,
					reason: "size_mismatch",
					detail: `${size} != ${file.size}`,
				},
			};
		}
		return { key: file.storageKey };
	}
	if (
		file.storageKey === snapshotKey(ref.projectId, ref.snapshotId, file.id)
	) {
		return { key: file.storageKey };
	}
	return { rejection: { path: file.path, reason: "missing" } };
}

/**
 * A `size_mismatch` rejection in the one shape every caller here produces.
 * `actual != declared`, counts only — a path is carried in `path`, and the
 * numbers are the snapshot's own accounting, never file content.
 */
function sizeMismatch(path: string, actual: number, declared: number) {
	return {
		path,
		reason: "size_mismatch",
		detail: `${actual} != ${declared}`,
	} satisfies InstructionRejection;
}

/**
 * HEAD the object and refuse it when the stored length is not the length the
 * client registered — BEFORE a byte of it is downloaded.
 *
 * The declared size was previously only ever compared against the staging
 * LISTING, which is a snapshot of the prefix taken once at the top of the
 * gate. A client can register a small size together with the hash of a much
 * larger payload, upload the small object so the listing agrees, then overwrite
 * it before its turn in the download loop: the listing size passed, the hash of
 * the downloaded buffer passed, and nothing else looked at length, so the
 * per-file and 50 MB total limits were bypassed and the worker buffered (and
 * promoted) whatever was actually there.
 *
 * The signed PUT cannot carry the length: `getSignedUploadUrl` in
 * `packages/storage/provider/s3/index.ts` signs only Bucket/Key/ContentType and
 * ignores `contentLength` entirely, so the upload itself is unbounded. The
 * server-side checks are therefore the whole enforcement, and there are two:
 * this HEAD, so an oversized object is never fetched, and a comparison of the
 * downloaded buffer's own length at each call site, because a HEAD is a
 * statement about a moment that has passed by the time the GET runs.
 *
 * A null result means the object genuinely is not there (the S3 provider maps
 * only `NotFound` to null and throws every other error), which is the gate's
 * existing `missing` verdict rather than an infrastructure failure.
 *
 * Deliberately NOT exported: every export from this module becomes a
 * schedulable Temporal activity.
 */
async function rejectionFromStoredSize(
	storage: StorageProviderInterface,
	key: string,
	f: { path: string; size: number },
): Promise<InstructionRejection | null> {
	const head = await storage.getFileMetadata(key, { bucket: BUCKET });
	if (!head) {
		return { path: f.path, reason: "missing" };
	}
	if (head.size !== f.size) {
		return sizeMismatch(f.path, head.size, f.size);
	}
	return null;
}

/**
 * Records a file's classification and, for the kinds that carry one, the
 * `name`/`description` from its frontmatter — parsed from the buffer the
 * caller has ALREADY verified (length and sha256) and scanned.
 *
 * This used to be `classifyInstructionFiles`, a standalone activity that ran
 * between the gate and promotion and did its own `downloadFile` of the same
 * mutable staging key. That was a third read of bytes nobody had re-checked:
 * a caller could let the gate accept benign bytes, overwrite the object with
 * secret-bearing frontmatter while classification was working through the
 * list, and have `name`/`description` derived from the replacement persisted
 * onto the file row — then restore the benign bytes so promotion passed and
 * the snapshot published. MCP and the API listings serve those two columns.
 *
 * So the parse happens here, inside the gate's own loop, over the buffer whose
 * hash the gate has just confirmed. A file that is rejected for ANY reason
 * never reaches this function, so a rejected row carries no metadata derived
 * from unverified bytes.
 *
 * `f.isText` is deliberately not consulted, for the reason spelled out on the
 * gate below: it is an extension-allowlist rendering hint, not a fact about
 * the bytes. `text` is the gate's own decode of this buffer and is null only
 * for genuinely binary content, which has no frontmatter to read.
 *
 * Deliberately NOT exported: every export from this module becomes a
 * schedulable Temporal activity.
 */
async function persistVerifiedFileMetadata(
	ref: SnapshotRef,
	f: { id: string; path: string; size: number },
	text: string | null,
): Promise<void> {
	const kind = classifyPath(f.path);
	let name: string | null = null;
	let description: string | null = null;
	if (
		text !== null &&
		(kind === "SKILL" || kind === "AGENT" || kind === "RULE") &&
		f.size <= SNAPSHOT_LIMITS.maxInlineTextBytes
	) {
		const fm = parseFrontmatter(text);
		name = fm.name;
		description = fm.description;
	}
	// A browser folder upload cannot read Unix modes (the File API has none),
	// so every row arrives with `mode: null` and the ZIP export and MCP bundle
	// would install every script non-executable — a hook that invokes
	// `scripts/run.sh` bare then fails with "permission denied" on the first
	// session. The one signal the bytes themselves carry is a shebang, so a
	// text file that starts with `#!` is recorded as 0755. Everything else
	// keeps null; a source that supplies real modes (repository sync) will set
	// them at ingest instead of coming through here.
	const mode = text?.startsWith("#!") ? 0o755 : undefined;
	await updateInstructionFileMetadata(f.id, ref.organizationId, {
		kind,
		name,
		description,
		...(mode === undefined ? {} : { mode }),
	});
}

/**
 * The gate: integrity, secrets AND classification, in ONE download per staged
 * object.
 *
 * These were two activities, and splitting them was the hole. The client
 * holds a reusable signed PUT for the exact staging key, so the bytes at that
 * key are mutable for as long as the URL lives. With a standalone verify pass
 * followed by a separate scan pass, a caller could upload benign bytes
 * matching the declared hash, let verify accept them, overwrite an
 * early-sorting file while later files were still being scanned, and have the
 * replacement — secret-bearing content included — promoted into the immutable
 * snapshot. The stored digest was computed from the DECLARED hashes, so it
 * agreed.
 *
 * Hashing and scanning the SAME buffer removes the window inside this pass:
 * what the rule set reads is what produced the digest comparison, byte for
 * byte. `finalizeInstructionSnapshot` closes the remaining window by
 * re-hashing at promotion time and writing the bytes it hashed.
 *
 * Order, in cost order:
 *  1. `isSecretFileName` on the path — a credential file is refused on its
 *     name alone, without being downloaded at all.
 *  2. size against the staging listing — a mismatch needs no download either.
 *  3. size against a HEAD of the key itself, so an object that grew after the
 *     listing was taken is refused before the worker buffers it.
 *  4. one download, then the buffer's OWN length against the declared size,
 *     then sha256 against the declared hash, then a strict UTF-8 decode and
 *     the rule set over that same buffer.
 *  5. only if all of that passed: classify the path and parse the frontmatter
 *     out of that same verified buffer (`persistVerifiedFileMetadata`).
 *
 * Step 5 is here rather than in an activity of its own because the metadata
 * must come from bytes somebody checked. The standalone classify pass this
 * replaces re-downloaded the same mutable key without re-hashing it, which
 * let frontmatter from a post-gate swap be persisted onto the file row.
 *
 * `isText` is deliberately not consulted. It is a RENDERING hint assigned
 * from an extension allowlist at registration time, and consulting it was a
 * previous hole: `extensionOf(".env")` is `"env"`, absent from that
 * allowlist, so a root `.env` was registered `isText: false`, skipped by the
 * scan, promoted, published and served — the exact outcome the feature's own
 * rejection banner promises is impossible. Spec §6.3 step 2 is explicit that
 * unsupported content is a failure, not a pass. A buffer that does not decode
 * is genuinely binary and passes AS binary (nothing in it can be a
 * recognizable text credential); the name gate covers binary credential
 * stores.
 */
export async function verifyAndScanInstructionFiles(
	ref: SnapshotRef,
): Promise<GateResult> {
	await loadVerifiedSnapshot(ref);
	const storage = getStorageProvider();
	const files = await listInstructionFiles(
		ref.snapshotId,
		ref.organizationId,
	);
	const staged = new Map(
		(await listAllStagingObjects(storage, ref)).map((object) => [
			object.key,
			object.size,
		]),
	);
	const rejections: InstructionRejection[] = [];
	for (const f of files) {
		heartbeat({ path: f.path });
		const secretName = isSecretFileName(f.path);
		if (secretName) {
			rejections.push({
				path: f.path,
				reason: "secret",
				detail: `filename:${secretName}`,
			});
			continue;
		}
		const located = resolveReadableKey(ref, f, staged);
		if ("rejection" in located) {
			rejections.push(located.rejection);
			continue;
		}
		const oversized = await rejectionFromStoredSize(
			storage,
			located.key,
			f,
		);
		if (oversized) {
			rejections.push(oversized);
			continue;
		}
		// A download failure (network blip, credential hiccup, transient 5xx)
		// is an infrastructure problem, not proof the upload is bad — it
		// propagates so Temporal's retry policy can do its job, rather than
		// being reported as a user-facing rejection that permanently destroys
		// a valid upload, and never as a silent pass.
		const { data } = await storage.downloadFile(located.key, {
			bucket: BUCKET,
		});
		// The bytes in hand, not the listing and not the HEAD: both of those
		// describe a moment that has already passed for a key the client can
		// still write to. This is the only length statement bound to the
		// buffer that gets hashed, scanned and promoted.
		if (data.length !== f.size) {
			rejections.push(sizeMismatch(f.path, data.length, f.size));
			continue;
		}
		if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
			rejections.push({ path: f.path, reason: "hash_mismatch" });
			continue;
		}
		// A buffer that does not decode is genuinely binary: nothing in it can
		// be a recognizable text credential, and it has no frontmatter, so it
		// passes AS binary and is classified on its path alone.
		const text = decodeUtf8Text(data);
		if (text !== null) {
			const hits = scanTextForSecrets(text);
			if (hits.length > 0) {
				for (const hit of hits) {
					rejections.push({
						path: f.path,
						reason: "secret",
						detail: hit.rule,
						line: hit.line,
					});
				}
				// No metadata for a rejected file: `name`/`description` are
				// served over MCP and the API listings, and these bytes are the
				// ones the rule set just refused.
				continue;
			}
		}
		await persistVerifiedFileMetadata(ref, f, text);
	}
	return {
		ok: rejections.length === 0,
		rejections: capRejections(rejections),
	};
}

/**
 * Promotion: re-hash every staged object and write THOSE bytes to the
 * immutable snapshot key.
 *
 * The bytes at a staging key stay mutable while the client's signed PUT
 * lives, so "the gate accepted this object" is a statement about a moment
 * that has passed by the time promotion runs. A server-side `copyFile` copies
 * whatever is at the key NOW, with no hash of its own — which is how
 * secret-bearing content could be swapped in after the gate and land in the
 * immutable prefix under a digest computed from the declared hashes.
 *
 * So this downloads each object, recomputes sha256, and PUTS the buffer it
 * hashed. Never a server-side copy: the copy and the hash would be reading
 * the key twice, and the window is exactly the gap between those two reads.
 * A mismatch rejects the WHOLE snapshot with the same `hash_mismatch` shape
 * the gate produces, so the caller sees one consistent verdict rather than a
 * half-promoted version.
 *
 * Idempotent under retry: a re-run re-downloads, re-hashes and re-puts the
 * same bytes onto the same destination key. A row already at its snapshot key
 * (a previous attempt promoted it) is re-hashed from there, which is also
 * what proves a retry is not promoting something that changed underneath it.
 *
 * `storedBytes` and the digest are both derived from the rows, and the digest
 * from the per-file hashes this pass has just re-confirmed against the actual
 * bytes at the destination.
 */
export async function finalizeInstructionSnapshot(
	ref: SnapshotRef,
): Promise<GateResult> {
	await loadVerifiedSnapshot(ref);
	const storage = getStorageProvider();
	const files = await listInstructionFiles(
		ref.snapshotId,
		ref.organizationId,
	);
	const rejections: InstructionRejection[] = [];
	let storedBytes = 0;
	for (const f of files) {
		heartbeat({ path: f.path });
		const dest = snapshotKey(ref.projectId, ref.snapshotId, f.id);
		// Same two length checks as the gate, for the same reason: the key is
		// still writable, so promotion must not be the step that buffers and
		// stores an object larger than the client registered.
		const oversized = await rejectionFromStoredSize(
			storage,
			f.storageKey,
			f,
		);
		if (oversized) {
			rejections.push(oversized);
			continue;
		}
		// Download failures propagate for the same reason they do in the
		// gate: an infrastructure error must retry, never reject a valid
		// upload and never pass an unverified one.
		const { data } = await storage.downloadFile(f.storageKey, {
			bucket: BUCKET,
		});
		if (data.length !== f.size) {
			rejections.push(sizeMismatch(f.path, data.length, f.size));
			continue;
		}
		if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
			// Keep going rather than returning here, so the rejection list
			// names every bad path instead of only the first. Nothing more is
			// written for this file, and the snapshot never reaches READY.
			rejections.push({ path: f.path, reason: "hash_mismatch" });
			continue;
		}
		if (f.storageKey !== dest) {
			await storage.uploadFile(dest, data, {
				bucket: BUCKET,
				contentType: f.mimeType,
			});
			await updateInstructionFileMetadata(f.id, ref.organizationId, {
				kind: f.kind,
				name: f.name,
				description: f.description,
				storageKey: dest,
			});
		}
		storedBytes += f.size;
	}
	if (rejections.length > 0) {
		// The caller rejects the snapshot, which deletes its staging objects.
		// Objects already written under the snapshot prefix for the files
		// that DID match stay until the snapshot ages out of the prune window
		// (their rows still carry those keys) or the bucket lifecycle rule
		// collects them; they are unreachable in the meantime, because
		// nothing serves bytes from a snapshot that is not READY.
		return { ok: false, rejections: capRejections(rejections) };
	}
	const digest = await computeSnapshotDigest(
		files.map((f) => ({ path: f.path, sha256: f.sha256 })),
	);
	// Cleanup BEFORE the terminal status, not after (I2). `cleanupStagingObjects`
	// throws on any per-key delete failure, and READY is terminal:
	// `markInstructionSnapshotFailed` refuses to move a READY row, so writing
	// READY first and then failing the delete three times left a terminal
	// snapshot with its staging copies still in the bucket and no state the UI
	// could retry from. Failing here leaves the row VALIDATING, the boundary
	// catch marks it FAILED, and "Try again" re-runs the whole workflow.
	//
	// Deterministic-key delete for every file row, not just the ones this
	// attempt promoted, plus a paginated sweep of the staging prefix — see
	// `cleanupStagingObjects` for why a retry cannot rely on the rows' current
	// `storageKey` values. A retry whose previous attempt already emptied the
	// prefix deletes nothing and succeeds, which is what makes moving it ahead
	// of the status write safe: the bytes a re-run needs to re-hash are the
	// promoted ones at the snapshot key, and the rows point there already.
	await cleanupStagingObjects(
		storage,
		ref,
		files.map((f) => f.id),
	);
	// Conditional, and `changed` is deliberately ignored (I1 round 3). Temporal
	// delivers an activity AT LEAST ONCE: an attempt that commits this write and
	// then loses its completion — the worker dies before the acknowledgement —
	// is retried from the top, and an unconditional write re-stamped `readyAt`
	// on a snapshot that had been READY since the first attempt. The ZIP builder
	// dates its entries from that value, so two downloads of the same
	// digest-keyed archive could disagree. `markInstructionSnapshotReady` matches
	// only a row that has not already reached a verdict, so the retry writes
	// nothing and returns the same success the first attempt returned — which is
	// what the workflow needs, since the publish and prune steps that follow are
	// themselves idempotent.
	await markInstructionSnapshotReady({
		snapshotId: ref.snapshotId,
		projectId: ref.projectId,
		organizationId: ref.organizationId,
		fileCount: files.length,
		storedBytes,
		digest,
		// Read once per attempt, here: the only clock read on this path.
		readyAt: new Date(),
	});
	return { ok: true, rejections: [] };
}

/**
 * Summarises a rejection list for the audit row: how many of each reason,
 * and which rules fired.
 *
 * Deliberately narrow. `path` is user content and never leaves the
 * `rejection` column; `detail` is carried ONLY for `reason: "secret"`, where
 * it is a rule id (`aws-access-key`) or `filename:` plus a
 * `SECRET_FILE_PATTERNS` entry — both fixed strings from
 * `@repo/instructions`, never anything read out of the file, and neither is
 * ever the path itself. The matched text has never existed in
 * this process (`scanTextForSecrets` returns a rule id and a line number, not
 * the match), so there is nothing here that could carry a credential into the
 * audit log.
 */
function summarizeRejections(rejections: InstructionRejection[]): {
	rejectionCount: number;
	reasonCounts: Record<string, number>;
	rules: string[];
} {
	const reasonCounts: Record<string, number> = {};
	const rules = new Set<string>();
	for (const r of rejections) {
		reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
		if (r.reason === "secret" && r.detail) {
			rules.add(r.detail);
		}
	}
	return {
		rejectionCount: rejections.length,
		reasonCounts,
		rules: [...rules].sort(),
	};
}

export async function rejectInstructionSnapshot(
	input: SnapshotRef & { rejections: InstructionRejection[] },
): Promise<void> {
	const snapshot = await loadVerifiedSnapshot(input);
	const storage = getStorageProvider();
	const files = await listInstructionFiles(
		input.snapshotId,
		input.organizationId,
	);
	// Cleanup FIRST, then the verdict (I2). A terminal REJECTED has to mean the
	// staging objects are gone: this activity's whole reason for existing is
	// that the upload carried something that must not stay in the bucket, and
	// `markInstructionSnapshotFailed` deliberately refuses to move a terminal
	// row, so writing REJECTED first and then failing the delete on all three
	// attempts left the secret-bearing object durable with no state the UI
	// could retry from. Failing here leaves the row VALIDATING, the workflow's
	// boundary catch marks it FAILED, and "Try again" re-runs the gate against
	// the staging objects that are still there.
	//
	// No per-file loop before it: the genuinely long part of this activity is
	// the cleanup sweep, which heartbeats on its own (once per listing page and
	// once per delete call). Same deterministic-keys-plus-sweep approach as
	// finalize: a rejected snapshot's files never reach the snapshot prefix,
	// but cleaning up by the same reliable method (rather than trusting each
	// row's current `storageKey`) keeps both paths consistent and correct under
	// retry, and an already-empty prefix is a success.
	await cleanupStagingObjects(
		storage,
		input,
		files.map((f) => f.id),
	);
	// The verdict and its audit row are ONE conditional transaction (I1 round
	// 3). `project.instructions.rejected` had no writer anywhere in the feature
	// before this: an upload refused for containing credentials left no trace at
	// all, for the one event on this surface an operator is most likely to be
	// asked about. It must therefore be written exactly once — and a
	// fire-and-forget write after an unconditional status write was not: an
	// attempt that commits both and then loses its completion (Temporal
	// delivers activities AT LEAST ONCE) is retried from the top, and the
	// second attempt re-wrote REJECTED and emitted a SECOND row for the same
	// rejection. `markInstructionSnapshotRejected` writes the row only when its
	// conditional transition actually matched, so the retry is a no-op and
	// returns the same result the first attempt did.
	//
	// Still after the cleanup, and for the same reason the status write is: an
	// attempt that dies on the delete commits nothing, so the verdict is
	// recorded by the attempt that actually finished the job, however many
	// retries that took.
	await markInstructionSnapshotRejected({
		snapshotId: input.snapshotId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		rejections: input.rejections,
		audit: {
			action: "project.instructions.rejected",
			category: "project",
			severity: "warning",
			outcome: "failure",
			actor: { type: "user", userId: input.userId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: input.snapshotId,
				name: `v${snapshot.version}`,
			},
			metadata: summarizeRejections(input.rejections),
		},
	});
}

/**
 * The workflow's terminal-failure marker: moves a snapshot that is still
 * being processed to FAILED so it stops looking like work in progress.
 *
 * Without it nothing in the feature ever wrote FAILED. An activity that
 * exhausted its three attempts — a rotated storage credential mid-validation
 * is the ordinary way — failed the workflow and left the row VALIDATING
 * forever, which the tab reads as "still checking" and re-polls every three
 * seconds, for every user who opens that tab, indefinitely.
 *
 * Only moves a NON-terminal row. A workflow can also fail AFTER
 * `finalizeInstructionSnapshot` wrote READY (a publish or prune error), and
 * that snapshot is genuinely ready: its bytes are in the immutable prefix and
 * it may already be the project's published pointer. Overwriting that with
 * FAILED would destroy a good version to report a problem with a later step.
 * The same guard makes the activity idempotent under retry.
 *
 * That guard is the WRITE's own predicate, not a read above it
 * (`failInstructionSnapshot`). It was a read-then-write, and the gap between
 * the two is reachable: Temporal delivers activities at least once, so a
 * timed-out attempt runs on while its retries fail, and this marker could read
 * VALIDATING, watch the original attempt commit READY, and then stamp FAILED
 * over that verdict — leaving a published pointer aimed at a snapshot the read
 * APIs refuse to serve. The conditional update also replaces
 * `loadVerifiedSnapshot` here: its WHERE clause already names the snapshot,
 * project and organization, so a row belonging to another tenant matches
 * nothing. Answering `marked: false` is the right outcome for the failure
 * path anyway — a marker that itself threw because the row was gone would
 * only bury the failure it was called to record.
 *
 * Deliberately does NOT clean up staging. FAILED is a re-attemptable state —
 * `finalize` accepts it and starts a fresh workflow run, whose gate
 * re-reads the staged bytes — so deleting them here would turn a recoverable
 * failure into a mandatory re-upload. The prune sweep collects a FAILED
 * snapshot's objects once it ages out of the retention window.
 *
 * `failure` carries the error's CLASS NAME only and is logged, never
 * persisted: there is no column for it, and an error message can quote a
 * storage URL, a key, or the file content that caused the failure.
 */
export async function markInstructionSnapshotFailed(
	input: SnapshotRef & { failure: string },
): Promise<{ marked: boolean }> {
	const { changed } = await failInstructionSnapshot({
		snapshotId: input.snapshotId,
		projectId: input.projectId,
		organizationId: input.organizationId,
	});
	if (!changed) {
		return { marked: false };
	}
	logger.warn(
		{
			event: "project.instructions.snapshot_failed",
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			failure: input.failure,
		},
		"[CodingInstructions] Snapshot validation failed; marked FAILED",
	);
	return { marked: true };
}

export async function publishInstructionSnapshotActivity(
	ref: SnapshotRef,
): Promise<{ published: boolean; reason?: string }> {
	const snapshot = await loadVerifiedSnapshot(ref);
	if (!snapshot.publishOnReady) {
		return { published: false, reason: "manual" };
	}
	const r = await publishInstructionSnapshot({
		snapshotId: ref.snapshotId,
		projectId: ref.projectId,
		organizationId: ref.organizationId,
	});
	// `publishOnReady` defaults to true, so THIS is the ordinary publish —
	// the manual oRPC `publish` procedure audits, this path did not, and the
	// common upload therefore left an audit trail that stopped at
	// "upload_started". What every coding agent on the project now reads is a
	// security-relevant mutation and needs a record of who published what.
	//
	// Gated on `changed`, not on `published`: the query reports `published:
	// true` for the idempotent case too (this snapshot is ALREADY the
	// pointer), which is exactly what a Temporal retry of this activity
	// produces. Auditing on `published` would write a fresh row per retry for
	// a publication that happened once. Fire-and-forget for the same reason
	// as the rejection row above.
	if (r.changed) {
		recordAudit({
			action: "project.instructions.published",
			category: "project",
			actor: { type: "user", userId: ref.userId },
			organizationId: ref.organizationId,
			projectId: ref.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: ref.snapshotId,
				name: `v${snapshot.version}`,
			},
			metadata: {
				version: snapshot.version,
				fileCount: snapshot.fileCount,
				source: "auto_publish_on_ready",
			},
		});
	}
	return r.published
		? { published: true }
		: { published: false, reason: r.reason };
}

export async function pruneInstructionSnapshots(
	ref: SnapshotRef,
): Promise<{ deleted: number }> {
	await loadVerifiedSnapshot(ref);
	const storage = getStorageProvider();
	const prunable = await listPrunableInstructionSnapshots(
		ref.projectId,
		ref.organizationId,
		{ ready: SNAPSHOT_RETENTION, rejected: FAILED_SNAPSHOT_RETENTION },
	);
	let deleted = 0;
	for (const s of prunable) {
		heartbeat({ snapshotId: s.id, phase: "row-delete" });
		// Rows FIRST, then the objects they name. The old order deleted the
		// objects and only then the rows, so a publish that landed on a
		// candidate between its selection and its deletion left the project
		// pointing at a snapshot whose bytes were already gone.
		//
		// `listPrunableInstructionSnapshots` already excludes the published
		// pointer, so this is the race, not the ordinary case: the
		// `onDelete: Restrict` foreign key refuses the delete and the
		// candidate is skipped with its objects untouched. It will be a
		// candidate again the next time it is no longer published.
		const removal = await deleteInstructionSnapshot(
			s.id,
			ref.projectId,
			ref.organizationId,
		);
		if (!removal.deleted) {
			continue;
		}
		deleted++;
		if (s.storageKeys.length > 0) {
			assertAllDeleted(
				await storage.deleteObjects(s.storageKeys, { bucket: BUCKET }),
				"prune",
			);
		}
		// The export zips built from this snapshot. Nothing records which
		// ones exist — the file rows only know their own keys — so they are
		// found by prefix, which also collects objects an earlier
		// wall-clock-stamped build wrote.
		await deleteObjectsUnderPrefix(
			storage,
			exportKeyPrefix(ref.projectId, s.id),
		);
	}
	return { deleted };
}
