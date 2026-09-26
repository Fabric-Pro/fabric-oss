import { createHash } from "node:crypto";
import {
	canReadProjectInstructions,
	claimInstructionSnapshotValidation,
	failInstructionSnapshot,
	getInstructionSnapshotById,
	getPublishedInstructionSnapshot,
	type InstructionDeferredScanOutcome,
	type InstructionRejection,
	listInstructionFiles,
	markInstructionSnapshotReady,
	markInstructionSnapshotRejected,
	publishInstructionSnapshot,
	recordAudit,
	recordInstructionDeferredScanOutcome,
	updateInstructionFileMetadata,
} from "@repo/database";
import {
	buildIgnoreMatcher,
	classifyPath,
	computeSnapshotDigest,
	FABRIC_IGNORE_FILE,
	isSecretFileName,
	isStagingKey,
	parseFabricIgnore,
	parseFrontmatter,
	SNAPSHOT_LIMITS,
	scanTextForSecrets,
	snapshotKey,
	stagingKey,
	stagingPrefix,
} from "@repo/instructions";
import { warmInstructionSnapshotExport } from "@repo/instructions/export";
import { logger } from "@repo/logs";
import {
	getStorageProvider,
	type StorageProviderInterface,
} from "@repo/storage";
import { ApplicationFailure, Context, heartbeat } from "@temporalio/activity";
import { DEFERRED_SCAN_MAX_ATTEMPTS } from "../lib/instruction-deferred-scan-retry";
import {
	assertAllDeleted,
	INSTRUCTIONS_BUCKET as BUCKET,
	pruneProjectInstructionSnapshots,
} from "./lib/instruction-prune";

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
		truncationSentinel(rejections.length - MAX_REJECTIONS),
	];
}

/** The row that stands for `dropped` rejections a capped list left out. */
function truncationSentinel(dropped: number): InstructionRejection {
	return {
		// A recognizable sentinel, not an empty string — this is persisted
		// into the `rejection` JSON column and read back by UI surfaces that
		// render one row per rejection; a blank `path` renders as an empty
		// row instead of a legible summary line.
		path: "(truncated)",
		reason: "truncated",
		detail: `${dropped} more`,
	};
}

/**
 * A rejection (or finding) list bounded WHILE it is built, where
 * `capRejections` bounds one that already exists.
 *
 * The difference matters wherever one input can produce rows without limit:
 * a secret scan yields one hit per matching LINE, so a few megabytes of
 * credential assignments is hundreds of thousands of rows, all of them
 * allocated before a cap applied afterwards could drop them — and a worker
 * scanning several such files can exhaust its memory on every retry, turning
 * a known secret into a scan that could not finish. Here at most
 * `MAX_REJECTIONS` rows are ever held; the rest are only COUNTED, and the
 * truncation sentinel is written from that running count, so the result is
 * exactly what `capRejections` would have produced over the whole list.
 *
 * `room()` is the budget a bounded `scanTextForSecrets` takes as its `limit`,
 * and `countDropped` adds the hits that scan counted but did not keep; the
 * budget therefore carries across files. Deliberately NOT exported: every
 * export from this module becomes a schedulable Temporal activity.
 */
class BoundedRejections {
	private readonly kept: InstructionRejection[] = [];
	private seen = 0;

	/** How many more rows this list will still keep. */
	room(): number {
		return MAX_REJECTIONS - this.kept.length;
	}

	/** Every row pushed or counted, kept or not. */
	count(): number {
		return this.seen;
	}

	push(rejection: InstructionRejection): void {
		this.seen++;
		if (this.kept.length < MAX_REJECTIONS) {
			this.kept.push(rejection);
		}
	}

	/** Rows that exist but were never materialised (a bounded scan's excess). */
	countDropped(dropped: number): void {
		this.seen += dropped;
	}

	/** The kept rows, and the sentinel for the rest when there is any. */
	toList(): InstructionRejection[] {
		const dropped = this.seen - this.kept.length;
		return dropped > 0
			? [...this.kept, truncationSentinel(dropped)]
			: [...this.kept];
	}
}

/**
 * Runs the bounded secret scan over `text` into `into`, one `secret` row per
 * hit it keeps, and returns how many hits the text had in all (0 when clean).
 * The scan is given only the room left in `into`, so a dense file never
 * allocates more hit objects than the list will keep.
 */
function collectSecretHits(
	into: BoundedRejections,
	path: string,
	text: string,
): number {
	const scan = scanTextForSecrets(text, { limit: into.room() });
	for (const hit of scan.hits) {
		into.push({
			path,
			reason: "secret",
			detail: hit.rule,
			line: hit.line,
		});
	}
	into.countDropped(scan.total - scan.hits.length);
	return scan.total;
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
	const snapshot = await loadTenantVerifiedSnapshot(ref);
	const mayRead = await canReadProjectInstructions(ref.projectId, ref.userId);
	if (!mayRead) {
		throw ApplicationFailure.nonRetryable(
			`Instruction snapshot ${ref.snapshotId} is no longer authorized for its submitting user`,
			"INSTRUCTION_SNAPSHOT_PERMISSION_REVOKED",
		);
	}
	return snapshot;
}

/**
 * The TENANT half of `loadVerifiedSnapshot`, on its own: the snapshot exists
 * and is this run's project and organization, nothing about who asked.
 *
 * Used alone by the two activities that run after a publish-first snapshot
 * (Fizzy #2737) is already readable — the deferred scan and the recording of
 * its verdict. Those are safety work on a version the project can already
 * read, not work done on the submitting member's behalf, so they must not
 * stop because that member has since lost access: "the uploader was removed
 * from the project" is no reason to leave a published version unscanned, or
 * its verdict unrecorded. Every other activity keeps the permission check.
 *
 * Deliberately NOT exported, for the same reason as `loadVerifiedSnapshot`.
 */
async function loadTenantVerifiedSnapshot(
	ref: Pick<SnapshotRef, "snapshotId" | "projectId" | "organizationId">,
) {
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
 * Refuse to do PRE-VERDICT work on a snapshot something else has already
 * rejected.
 *
 * The scheduled reaper closes out uploads abandoned in RECEIVING, and it
 * checks Temporal for a live execution before it does. That check and its
 * conditional write are two statements, though, so a `finalize` landing in
 * the gap can start a workflow for a row the reaper rejects milliseconds
 * later. Without this the run would scan and promote a snapshot the database
 * says is REJECTED — writing immutable objects and file metadata for a
 * verdict nobody will ever read, and possibly returning READY for a row that
 * says REJECTED.
 *
 * Non-retryable: REJECTED is terminal, so retrying only re-reads the same
 * answer. The workflow's boundary catch marks FAILED from RECEIVING and
 * VALIDATING only, so failing here leaves the reaper's REJECTED row exactly
 * as it is.
 *
 * Deliberately NOT applied to the post-verdict activities. Publish and prune
 * run after a verdict this workflow itself produced, and a REJECTED snapshot
 * reaching them is the ordinary rejection path, not a race.
 */
function assertNotAlreadyRejected(
	snapshot: { status: string },
	snapshotId: string,
): void {
	if (snapshot.status === "REJECTED") {
		throw ApplicationFailure.nonRetryable(
			`Instruction snapshot ${snapshotId} was already rejected; this run has nothing to validate`,
			"INSTRUCTION_SNAPSHOT_ALREADY_REJECTED",
		);
	}
}

/**
 * This run's CLAIM on the snapshot, written before it touches storage.
 *
 * It closes the last gap between the scheduled reaper and a live upload at
 * the database rather than in a comment. `finalize` starts this workflow
 * BEFORE it writes VALIDATING and tolerates losing that write, so a row this
 * run owns can still read RECEIVING — and RECEIVING past the cutoff is
 * exactly what the reaper's conditional write requires. Its Temporal
 * liveness check narrows that to the sub-second gap between its `describe`
 * and its write, but two statements are two statements.
 *
 * So the claim is a conditional transition, RECEIVING -> VALIDATING. The
 * reaper's CAS and this one are then two conditional writes against the same
 * row and the same from-state, and exactly one of them can win: whichever
 * commits first leaves the other matching zero rows.
 *
 * It is DELIBERATELY narrower than `startInstructionSnapshotValidation`, the
 * RECEIVING/FAILED transition `finalize` uses. An activity attempt must never
 * make the FAILED arm: Temporal delivers AT LEAST ONCE, so an attempt that
 * stalled before its claim can wake up after its retries exhausted, after the
 * workflow's boundary catch wrote FAILED, and after the workflow closed. A
 * claim that accepted FAILED would then write VALIDATING with nothing left
 * alive to reach a verdict — a permanently stuck row, with a zombie attempt
 * possibly still writing storage objects behind it.
 *
 * `observed` is the status this run's own `loadVerifiedSnapshot` read. When it
 * is already VALIDATING there is nothing to claim and no write is made at all:
 * the row is in the target state, and the only writer that could have put it
 * there is `finalize` or this run's own earlier attempt.
 *
 * `changed: false` means the write matched nothing, and the re-read says why.
 * Every status is handled, because proceeding from a state this run does not
 * own is the bug this guard exists to prevent:
 *
 *  - VALIDATING: `finalize` (or an earlier attempt) wrote it in the gap. This
 *    run owns the row; proceed.
 *  - REJECTED: something else reached a verdict, the reaper being the only
 *    thing that can. Non-retryable — REJECTED is terminal, and the workflow's
 *    boundary catch writes FAILED only from RECEIVING/VALIDATING, so the
 *    reaper's row is left exactly as it is.
 *  - READY: a verdict already exists for these bytes. Scanning and promoting
 *    over it would write objects and file rows nobody reads, so it is
 *    non-retryable too.
 *  - FAILED or RECEIVING: this run has no claim on the row. RETRYABLE, and the
 *    retry is the recovery: on a "Try again" run the API's post-start
 *    transition is what moves FAILED -> VALIDATING, so the activity simply
 *    retries until it sees VALIDATING. The consequence, accepted knowingly: a
 *    FAILED-retry whose API status write is lost entirely is NOT recovered
 *    automatically — the activity keeps seeing FAILED and the run ends in the
 *    same FAILED row, leaving the tab's "Try again" as the path back. Fixing
 *    that automatically needs an ownership token on the row (a validation
 *    generation the claim and the failure marker both bind to), because
 *    without one a stale attempt and a freshly started retry are
 *    indistinguishable once both see FAILED.
 *  - a row that has since disappeared: `loadVerifiedSnapshot` fails it
 *    non-retryably, the same as any other tenant mismatch.
 */
async function claimSnapshotForValidation(
	ref: SnapshotRef,
	observed: { status: string },
): Promise<void> {
	if (observed.status === "VALIDATING") {
		return;
	}
	const { changed } = await claimInstructionSnapshotValidation({
		snapshotId: ref.snapshotId,
		projectId: ref.projectId,
		organizationId: ref.organizationId,
	});
	if (changed) {
		return;
	}
	// The status this run raced, not the one it read before the claim.
	const current = await loadVerifiedSnapshot(ref);
	assertNotAlreadyRejected(current, ref.snapshotId);
	if (current.status === "VALIDATING") {
		return;
	}
	if (current.status === "READY") {
		throw ApplicationFailure.nonRetryable(
			`Instruction snapshot ${ref.snapshotId} already reached a verdict; this run has nothing to validate`,
			"INSTRUCTION_SNAPSHOT_ALREADY_VERIFIED",
		);
	}
	throw ApplicationFailure.retryable(
		`Instruction snapshot ${ref.snapshotId} is ${current.status}, not claimed by this run; waiting for the transition that hands it over`,
		"INSTRUCTION_SNAPSHOT_AWAITING_FINALIZE",
	);
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
	// THIS snapshot's staging prefix, not `isStagingKey`'s repo-wide "is a
	// staging key anywhere" test. The listing is already scoped to that
	// prefix, so this changes nothing today; it is here because a derived
	// snapshot's rows can legitimately name another snapshot's objects, and
	// every delete set in this feature now states in one line which snapshot
	// it may touch.
	const ownStagingPrefix = stagingPrefix(ref.projectId, ref.snapshotId);
	const leftover = (await listAllStagingObjects(storage, ref))
		.map((object) => object.key)
		.filter((key) => key.startsWith(ownStagingPrefix) && !known.has(key));
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
 *
 * A DERIVED snapshot adds one more legitimate location, and exactly one: an
 * inherited row sits at the BASE's immutable promoted key until this
 * snapshot's own promotion re-writes it. That key is outside this snapshot's
 * staging prefix, so it is not in the staging listing and its existence and
 * length come from the HEAD the caller makes next rather than from that
 * listing. It is RECONSTRUCTED from `(projectId, baseSnapshotId,
 * inheritedFromFileId)` and compared, never trusted as stored: the row's
 * `storageKey` is a column, and accepting whatever it holds would let any key
 * in the bucket be read — and then promoted into a published snapshot — by a
 * row that claimed to be inherited. Both halves of that triple have to be
 * there; a row claiming inheritance on a snapshot with no base resolves to
 * nothing and is refused.
 */
function resolveReadableKey(
	ref: SnapshotRef,
	file: {
		id: string;
		path: string;
		size: number;
		storageKey: string;
		inheritedFromFileId?: string | null;
	},
	staged: Map<string, number>,
	baseSnapshotId: string | null,
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
	if (
		file.inheritedFromFileId &&
		baseSnapshotId &&
		file.storageKey ===
			snapshotKey(ref.projectId, baseSnapshotId, file.inheritedFromFileId)
	) {
		return { key: file.storageKey };
	}
	return { rejection: { path: file.path, reason: "missing" } };
}

/**
 * Refuses a file row whose `storageKey` is not one of the THREE locations an
 * activity in this module could legitimately have written it to, for
 * promotion's benefit.
 *
 * The gate answers the same question through `resolveReadableKey`, which also
 * has to consult the staging listing; promotion does not, so this is the
 * comparison on its own. Both reconstruct every acceptable key from ids —
 * `(projectId, snapshotId, fileId)` for this snapshot's staging and promoted
 * objects, `(projectId, baseSnapshotId, inheritedFromFileId)` for an inherited
 * row — rather than trusting the column, because promotion writes what it
 * reads into an immutable prefix that may be published seconds later.
 *
 * `missing` rather than a new reason: a key that is not one of those three is
 * not a place this snapshot's bytes are, which is the same thing the caller
 * would report if the object were simply absent.
 *
 * Deliberately NOT exported: every export from this module becomes a
 * schedulable Temporal activity.
 */
function unexpectedSourceKey(
	ref: SnapshotRef,
	file: {
		id: string;
		path: string;
		storageKey: string;
		inheritedFromFileId?: string | null;
	},
	baseSnapshotId: string | null,
): InstructionRejection | null {
	const acceptable = [
		stagingKey(ref.projectId, ref.snapshotId, file.id),
		snapshotKey(ref.projectId, ref.snapshotId, file.id),
		...(file.inheritedFromFileId && baseSnapshotId
			? [
					snapshotKey(
						ref.projectId,
						baseSnapshotId,
						file.inheritedFromFileId,
					),
				]
			: []),
	];
	return acceptable.includes(file.storageKey)
		? null
		: { path: file.path, reason: "missing" };
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
	f: { id: string; path: string; size: number; mode: number | null },
	text: string | null,
	/**
	 * The publish-first promotion (Fizzy #2737) passes the file's own snapshot
	 * key here, right after writing the verified buffer to it, so the row's
	 * metadata and its move off staging are ONE write. Two writes would each
	 * carry the other's columns from a row read before either, and the second
	 * would put back what the first had just changed. The gate never passes it.
	 */
	storageKey?: string,
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
	// text file that starts with `#!` is recorded as 0755.
	// Everything else keeps null. A row that already carries a mode got it
	// from a source that knows (repository sync writes git's mode at ingest,
	// design 2026-09-23 §4.2) and is left alone: inferring over it would turn
	// a 0644 file that happens to start with `#!` into 0755, and every
	// re-sync of an unchanged tree would then look like a mode change.
	const mode =
		(f.mode ?? null) === null && text?.startsWith("#!") ? 0o755 : undefined;
	await updateInstructionFileMetadata(f.id, ref.organizationId, {
		kind,
		name,
		description,
		...(mode === undefined ? {} : { mode }),
		...(storageKey === undefined ? {} : { storageKey }),
	});
}

/**
 * The `{ ignoreGlobs, layer }` pair `begin-snapshot.ts` froze into
 * `ProjectInstructionSnapshot.settingsFrozen`, or null when the column does
 * not hold that shape.
 *
 * `settingsFrozen` is a `Json` column: nothing in the database constrains it,
 * an older row predating a shape change can hold anything, and this runs
 * inside a gate whose job is to REFUSE uploads. An unexpected shape must
 * therefore skip the provenance check and say so, never throw — failing the
 * activity here would turn a column-shape surprise into a retried,
 * ultimately-FAILED upload of files that are perfectly fine.
 */
type FrozenIgnoreSettings = { layer: string; ignoreGlobs: string[] };

function readFrozenIgnoreSettings(
	settingsFrozen: unknown,
): FrozenIgnoreSettings | null {
	if (
		settingsFrozen === null ||
		typeof settingsFrozen !== "object" ||
		Array.isArray(settingsFrozen)
	) {
		return null;
	}
	const { layer, ignoreGlobs } = settingsFrozen as Record<string, unknown>;
	if (typeof layer !== "string") {
		return null;
	}
	if (
		!Array.isArray(ignoreGlobs) ||
		ignoreGlobs.some((glob) => typeof glob !== "string")
	) {
		return null;
	}
	return { layer, ignoreGlobs: ignoreGlobs as string[] };
}

/**
 * Whether the STORED `.fabricignore` still parses to the rules the snapshot
 * was created from — and a rejection when it does not.
 *
 * `projects.instructions.begin` computes the exclusion set from the
 * `fabricIgnoreText` the CLIENT sends in the begin payload, freezes the
 * result into `settingsFrozen`, and then registers `.fabricignore` as an
 * ordinary file the client uploads separately. Nothing tied the two together:
 * a caller could preview (and have frozen) a permissive rule set, then upload
 * a `.fabricignore` whose real contents exclude nothing — or the reverse —
 * and the snapshot would carry, serve and explain exclusions that its own
 * stored file does not state. The tab renders `settingsFrozen.layer` and
 * `ignoreGlobs` as the reason files are missing, so the provenance is
 * user-visible, not merely internal bookkeeping.
 *
 * Both sides come from `parseFabricIgnore`, so the comparison is exact —
 * same length, same order — rather than set-equality: two rule lists that
 * differ only in order are still not the same file, and a parser that is
 * order-preserving on one side and not the other is the bug this would hide.
 *
 * The expectation is `[]` for any layer OTHER than `fabricignore`: the
 * project-glob and default layers are chosen precisely because the upload
 * carried no usable `.fabricignore` (`resolveIgnoreGlobs` falls through when
 * `parseFabricIgnore` returns nothing), so a comment-only or empty file is
 * the matching case and a file with real rules is not.
 *
 * `text === null` means the object did not decode as text at all. That cannot
 * be the file the frozen rules were parsed from, and `parseFabricIgnore("")`
 * is `[]` — the right reading of "no rules are recoverable from these bytes"
 * — so the same comparison covers it.
 *
 * `detail` carries COUNTS only. It is persisted into the `rejection` column
 * and rendered in the tab; the rules themselves are user content that has no
 * business being duplicated there.
 */
function ignoreProvenanceRejection(
	frozen: FrozenIgnoreSettings,
	text: string | null,
): InstructionRejection | null {
	const expected = frozen.layer === "fabricignore" ? frozen.ignoreGlobs : [];
	const actual = parseFabricIgnore(text ?? "");
	if (
		expected.length === actual.length &&
		expected.every((glob, i) => glob === actual[i])
	) {
		return null;
	}
	return {
		path: FABRIC_IGNORE_FILE,
		reason: "ignore_mismatch",
		detail: `${expected.length} rules frozen, ${actual.length} in file`,
	};
}

/**
 * The absent-file half of the same provenance question: whether a snapshot
 * whose frozen layer is `fabricignore` may legitimately store no root
 * `.fabricignore` at all.
 *
 * `ignoreProvenanceRejection` can only compare a file that is THERE, so a
 * caller that sent `fabricIgnoreText` to `begin` and then left
 * `.fabricignore` out of the manifest froze — and had the tab render as the
 * reason files are missing — exclusion rules that no stored byte states. That
 * is the same unexplainable snapshot the present-file check refuses, reached
 * by omission instead of by contradiction.
 *
 * Absence IS legitimate in exactly one case: the frozen rules exclude
 * `.fabricignore` itself, so the upload was never asked for it. That question
 * is put to the matcher the upload's own rules build — `buildIgnoreMatcher`
 * over the frozen globs, with the same `always` layer every other caller
 * applies — rather than to the glob strings, because `**\/.fabricignore`,
 * `.fabricignore` and `*` are all self-excluding and only the compiled
 * matcher knows it. The browser preview
 * (`apps/web/modules/saas/projects/lib/read-folder.ts`) decided what to
 * upload with that very matcher, so this asks the question the way the
 * omission was made.
 *
 * `detail` carries the frozen COUNT only, like the mismatch case: the rules
 * are user content and this string is persisted and rendered.
 */
function missingIgnoreFileRejection(
	frozen: FrozenIgnoreSettings,
): InstructionRejection | null {
	if (frozen.layer !== "fabricignore") {
		return null;
	}
	const excludesItself = buildIgnoreMatcher({
		globs: frozen.ignoreGlobs,
		layer: "fabricignore",
	})(FABRIC_IGNORE_FILE);
	if (excludesItself !== null) {
		return null;
	}
	return {
		path: FABRIC_IGNORE_FILE,
		reason: "ignore_mismatch",
		detail: `${frozen.ignoreGlobs.length} rules frozen, file missing`,
	};
}

/**
 * The present-file provenance check as both verifying passes apply it: to the
 * root `.fabricignore` only (a nested `docs/.fabricignore` is content), and
 * skipped with a warning — never failed — when `settingsFrozen` is not the
 * expected shape (see `readFrozenIgnoreSettings`). Logged at most once per
 * pass, because `.fabricignore` is a single root path.
 *
 * Shared by the gate and the publish-first promotion (Fizzy #2737) so the two
 * cannot drift on which file decides a snapshot's exclusions.
 *
 * Deliberately NOT exported: every export from this module becomes a
 * schedulable Temporal activity.
 */
function fabricIgnoreProvenanceRejection(
	ref: SnapshotRef,
	path: string,
	frozen: FrozenIgnoreSettings | null,
	text: string | null,
): InstructionRejection | null {
	if (path !== FABRIC_IGNORE_FILE) {
		return null;
	}
	if (frozen === null) {
		logger.warn(
			{
				event: "project.instructions.settings_frozen_unreadable",
				snapshotId: ref.snapshotId,
				projectId: ref.projectId,
				organizationId: ref.organizationId,
			},
			"[CodingInstructions] settingsFrozen is not the expected shape; skipping the .fabricignore provenance check",
		);
		return null;
	}
	return ignoreProvenanceRejection(frozen, text);
}

/**
 * Steps 1–4 of the gate for ONE file row: the name gate, the location, both
 * length checks and the hash — ending in the one buffer every later step
 * reads, or the rejection that stops this file.
 *
 * Shared by the gate and the publish-first promotion (Fizzy #2737), which
 * differ only in what they do with a verified buffer: the gate scans it, the
 * promotion writes it to the immutable snapshot key. Everything that decides
 * WHICH bytes are verified lives here, once.
 *
 *  1. `isSecretFileName` on the path — a credential file is refused on its
 *     name alone, without being downloaded at all.
 *  2. the key, reconstructed and compared (`resolveReadableKey`), and the size
 *     against the staging listing — a mismatch needs no download either.
 *  3. the size against a HEAD of the key itself, so an object that grew after
 *     the listing was taken is refused before the worker buffers it.
 *  4. one download, then the buffer's OWN length against the declared size,
 *     then sha256 against the declared hash.
 *
 * `key` is where the verified bytes were read from, so a caller that writes
 * them elsewhere can tell whether they are already there.
 *
 * Deliberately NOT exported: every export from this module becomes a
 * schedulable Temporal activity.
 */
async function readVerifiedFile(
	storage: StorageProviderInterface,
	ref: SnapshotRef,
	f: {
		id: string;
		path: string;
		size: number;
		sha256: string;
		storageKey: string;
		inheritedFromFileId?: string | null;
	},
	staged: Map<string, number>,
	baseSnapshotId: string | null,
): Promise<
	{ rejection: InstructionRejection } | { key: string; data: Buffer }
> {
	const secretName = isSecretFileName(f.path);
	if (secretName) {
		return {
			rejection: {
				path: f.path,
				reason: "secret",
				detail: `filename:${secretName}`,
			},
		};
	}
	const located = resolveReadableKey(ref, f, staged, baseSnapshotId);
	if ("rejection" in located) {
		return located;
	}
	const oversized = await rejectionFromStoredSize(storage, located.key, f);
	if (oversized) {
		return { rejection: oversized };
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
		return { rejection: sizeMismatch(f.path, data.length, f.size) };
	}
	if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
		return { rejection: { path: f.path, reason: "hash_mismatch" } };
	}
	return { key: located.key, data };
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
	const snapshot = await loadVerifiedSnapshot(ref);
	assertNotAlreadyRejected(snapshot, ref.snapshotId);
	// The claim, BEFORE any storage work: it is what makes this run and the
	// reaper's conditional write mutually exclusive.
	await claimSnapshotForValidation(ref, snapshot);
	const frozen = readFrozenIgnoreSettings(snapshot.settingsFrozen);
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
	// Bounded while it fills: a dense secret-bearing file is one hit per line,
	// and none past the cap is ever allocated (`BoundedRejections`).
	const rejections = new BoundedRejections();
	for (const f of files) {
		heartbeat({ path: f.path });
		// Steps 1–4: name, location, both lengths, hash (see `readVerifiedFile`).
		const read = await readVerifiedFile(
			storage,
			ref,
			f,
			staged,
			snapshot.baseSnapshotId,
		);
		if ("rejection" in read) {
			rejections.push(read.rejection);
			continue;
		}
		// A buffer that does not decode is genuinely binary: nothing in it can
		// be a recognizable text credential, and it has no frontmatter, so it
		// passes AS binary and is classified on its path alone.
		const text = decodeUtf8Text(read.data);
		if (text !== null && collectSecretHits(rejections, f.path, text) > 0) {
			// No metadata for a rejected file: `name`/`description` are
			// served over MCP and the API listings, and these bytes are the
			// ones the rule set just refused. Decided on the hit COUNT, so a
			// file whose hits all fell past the cap is refused all the same.
			continue;
		}
		// Provenance for the ONE file whose content decided this snapshot's
		// exclusions. Rejected exactly like a secret hit — the whole snapshot
		// is REJECTED and nothing durable is stored — because a snapshot whose
		// frozen rules do not come from its own stored `.fabricignore` cannot
		// be explained to the person reading the tab. Root path only, and an
		// unreadable `settingsFrozen` skips it: see the helper.
		const mismatch = fabricIgnoreProvenanceRejection(
			ref,
			f.path,
			frozen,
			text,
		);
		if (mismatch) {
			rejections.push(mismatch);
			continue;
		}
		await persistVerifiedFileMetadata(ref, f, text);
	}
	// Provenance for a `.fabricignore` that was never uploaded. The loop
	// above never runs for a file the manifest does not carry, so this is
	// the one place the omission can be refused; an unreadable
	// `settingsFrozen` skips it for the same reason the in-loop check does.
	if (frozen !== null && !files.some((f) => f.path === FABRIC_IGNORE_FILE)) {
		const missing = missingIgnoreFileRejection(frozen);
		if (missing) {
			rejections.push(missing);
		}
	}
	return {
		ok: rejections.count() === 0,
		rejections: rejections.toList(),
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
 *
 * A DERIVED snapshot's inherited row starts at the BASE's immutable promoted
 * key, so for those files this is a re-hash of bytes that were already checked
 * once, written into this snapshot's own prefix. It is not a copy the row can
 * steer: `assertExpectedSourceKey` reconstructs every acceptable source key
 * from ids and refuses anything else, and the base's object is only ever READ
 * — never moved, never deleted. The same full gate ran over it a moment ago,
 * so an inherited file is not trusted because it was trusted before.
 */
export async function finalizeInstructionSnapshot(
	ref: SnapshotRef,
): Promise<GateResult> {
	const snapshot = await loadVerifiedSnapshot(ref);
	assertNotAlreadyRejected(snapshot, ref.snapshotId);
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
		// The source key is RECONSTRUCTED and compared before anything reads
		// it. Promotion writes whatever it reads into the immutable prefix of
		// a snapshot that may publish seconds later, so "read the key the row
		// happens to hold" is the one thing it must not do — and a derived
		// snapshot is the first case where a legitimate source key is outside
		// this snapshot's own prefixes at all.
		const unexpected = unexpectedSourceKey(ref, f, snapshot.baseSnapshotId);
		if (unexpected) {
			rejections.push(unexpected);
			continue;
		}
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
	// `f.mode` is read straight off the `ProjectInstructionFile` row
	// (`listInstructionFiles` selects it), and every source that writes a
	// mode does so before this activity runs: repository sync writes git's
	// mode at ingest, and the gate's `persistVerifiedFileMetadata` infers
	// 0755 from a shebang before this snapshot reaches finalize. That is
	// the SAME column the served manifest reads it from (the REST
	// `GET .../instructions/published` route and the MCP bundle tool both
	// map `f.mode` off the same `listInstructionFiles` rows), so the digest
	// is computed from the value that ends up on the wire.
	const digest = await computeSnapshotDigest(
		files.map((f) => ({ path: f.path, sha256: f.sha256, mode: f.mode })),
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
 * The publish-first promotion (Fizzy #2737): the gate and promotion in ONE
 * pass, minus the content secret scan, ending READY with that scan PENDING.
 *
 * Only for a snapshot whose member acknowledged publishing before the scan —
 * `publishBeforeScan` and `publishOnReady` both on the ROW, re-read here
 * rather than trusted from the workflow input, which only chose this path.
 * Anything else is a caller bug and fails non-retryably.
 *
 * Everything the gate decides BEFORE its content scan still decides here, and
 * a refusal rejects the snapshot exactly as today, before anything publishes:
 * the claim (so this run and the reaper's abandonment write stay mutually
 * exclusive), the secret FILENAME gate, the reconstructed source key, both
 * length checks and the hash (`readVerifiedFile`, shared with the gate), and
 * `.fabricignore` provenance for a present and for a missing file. The
 * content scan is the one step deferred; `scanPublishedInstructionSnapshot`
 * runs it afterwards over the promoted objects, not over staging.
 *
 * ONE download per file, and the buffer that was hashed is the buffer that is
 * written to the immutable snapshot key — never a server-side copy, for the
 * reason on `finalizeInstructionSnapshot`: staged bytes stay mutable while
 * the client's signed PUT lives, and a second read is a second, unhashed
 * answer. Frontmatter metadata comes from that same buffer, and is written
 * together with the row's move to its snapshot key (`persistVerifiedFileMetadata`).
 * Once any file is refused nothing more is written: the pass keeps verifying
 * so the rejection names every bad path, but an object promoted before the
 * refusal stays unreachable until the prune collects it, exactly as a
 * refused `finalizeInstructionSnapshot` leaves it.
 *
 * Before READY, the rows are READ BACK: every one must sit at this snapshot's
 * OWN promoted key — the deferred scan reads only those, reconstructed from
 * ids, so an inherited file still pointing at its base's object would never be
 * scanned — and the digest is computed from those rows, because the shebang
 * inference above can have changed a row's mode and the digest includes it.
 *
 * Idempotent under retry. A row already at its snapshot key is re-verified
 * there and not rewritten; READY is written by `markInstructionSnapshotReady`
 * with `deferredScanStatus: PENDING` in the same conditional statement; and a
 * retry after a lost acknowledgement finds the row READY and returns the same
 * success without touching storage.
 */
export async function promoteUnscannedInstructionSnapshot(
	ref: SnapshotRef,
): Promise<GateResult> {
	const snapshot = await loadVerifiedSnapshot(ref);
	assertNotAlreadyRejected(snapshot, ref.snapshotId);
	if (snapshot.publishBeforeScan !== true || !snapshot.publishOnReady) {
		throw ApplicationFailure.nonRetryable(
			`Instruction snapshot ${ref.snapshotId} did not opt into publishing before its secret scan`,
			"INSTRUCTION_SNAPSHOT_NOT_PUBLISH_BEFORE_SCAN",
		);
	}
	if (snapshot.status === "READY") {
		// Only this run can have promoted it: `finalize` starts a workflow for
		// RECEIVING or FAILED rows only. An earlier attempt committed READY and
		// lost its acknowledgement.
		return { ok: true, rejections: [] };
	}
	// The claim, BEFORE any storage work, exactly as the gate makes it.
	await claimSnapshotForValidation(ref, snapshot);
	const frozen = readFrozenIgnoreSettings(snapshot.settingsFrozen);
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
	// Decided off the manifest alone, so it is known before anything is
	// written; reported last, where the gate reports it.
	const missingIgnore =
		frozen !== null && !files.some((f) => f.path === FABRIC_IGNORE_FILE)
			? missingIgnoreFileRejection(frozen)
			: null;
	const rejections: InstructionRejection[] = [];
	for (const f of files) {
		heartbeat({ path: f.path });
		const read = await readVerifiedFile(
			storage,
			ref,
			f,
			staged,
			snapshot.baseSnapshotId,
		);
		if ("rejection" in read) {
			rejections.push(read.rejection);
			continue;
		}
		// No `scanTextForSecrets` here: that is the step this path defers.
		const text = decodeUtf8Text(read.data);
		const mismatch = fabricIgnoreProvenanceRejection(
			ref,
			f.path,
			frozen,
			text,
		);
		if (mismatch) {
			rejections.push(mismatch);
			continue;
		}
		if (rejections.length > 0 || missingIgnore !== null) {
			continue;
		}
		const dest = snapshotKey(ref.projectId, ref.snapshotId, f.id);
		if (read.key !== dest) {
			await storage.uploadFile(dest, read.data, {
				bucket: BUCKET,
				contentType: f.mimeType,
			});
		}
		await persistVerifiedFileMetadata(ref, f, text, dest);
	}
	if (missingIgnore !== null) {
		rejections.push(missingIgnore);
	}
	if (rejections.length > 0) {
		return { ok: false, rejections: capRejections(rejections) };
	}
	const promoted = await listInstructionFiles(
		ref.snapshotId,
		ref.organizationId,
	);
	const notOwn = promoted.filter(
		(f) =>
			f.storageKey !== snapshotKey(ref.projectId, ref.snapshotId, f.id),
	);
	if (notOwn.length > 0) {
		// Every row passed and was written above, so this is a write that did
		// not land. Retryable: the next attempt re-verifies from wherever each
		// row now is and writes what is missing.
		throw ApplicationFailure.retryable(
			`Instruction snapshot ${ref.snapshotId} has ${notOwn.length} file(s) not yet at its own snapshot key`,
			"INSTRUCTION_SNAPSHOT_PROMOTION_INCOMPLETE",
		);
	}
	const digest = await computeSnapshotDigest(
		promoted.map((f) => ({ path: f.path, sha256: f.sha256, mode: f.mode })),
	);
	// Cleanup before the terminal status, for the reason on
	// `finalizeInstructionSnapshot` (I2): a READY row whose staging delete
	// then failed would be terminal with its staging copies still there.
	await cleanupStagingObjects(
		storage,
		ref,
		promoted.map((f) => f.id),
	);
	await markInstructionSnapshotReady({
		snapshotId: ref.snapshotId,
		projectId: ref.projectId,
		organizationId: ref.organizationId,
		fileCount: promoted.length,
		storedBytes: promoted.reduce((sum, f) => sum + f.size, 0),
		digest,
		readyAt: new Date(),
		deferredScan: true,
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
	// AUTO-publish, so it is a fast-forward: if this snapshot was derived
	// from another, the project's published pointer must still be that base
	// or the write matches nothing. Two edits of the same published version
	// otherwise both publish in turn and the later one, which never saw the
	// earlier edit, reverts it. The base is read from the snapshot row inside
	// the query, so this needs nothing from the workflow.
	//
	// A refused fast-forward leaves the snapshot READY and unpublished, which
	// History shows and "Publish this version" can still override as a
	// deliberate act.
	//
	// AT MOST ONCE, whatever the retry count: the query refuses to reapply an
	// automatic publication once the snapshot's `publishedAt` is set, because
	// this activity is delivered at least once and a lost completion ack could
	// otherwise republish a version a person had deliberately rolled back
	// from. That also means a retry arriving after some other version took the
	// pointer now reports `published: true` with `changed: false`, where it
	// used to report the `older_than_current` refusal: the same "nothing left
	// to do", and the `changed` gate below keeps it out of the audit log
	// either way.
	//
	// A snapshot the publish-first promotion made READY (Fizzy #2737) — its
	// `deferredScanStatus` is set — publishes through the same fast-forward,
	// with three differences. The query itself re-checks that the member who
	// acknowledged the risk (`snapshot.userId`) still holds the publish
	// permission, and refuses with `fast_path_not_authorized` if not. Its
	// audit row is `published_unscanned`, attributed to that member and
	// written INSIDE the publish transaction, so the pointer never moves
	// without the record that it moved unscanned. And the export is NOT
	// warmed here: that re-reads every file and would hold up the scan that
	// follows, so `recordDeferredScanOutcome` warms it instead.
	const unscanned = (snapshot.deferredScanStatus ?? null) !== null;
	const r = await publishInstructionSnapshot({
		snapshotId: ref.snapshotId,
		projectId: ref.projectId,
		organizationId: ref.organizationId,
		requireBaseUnmoved: true,
		...(unscanned
			? {
					audit: {
						action: "project.instructions.published_unscanned",
						category: "project",
						severity: "warning" as const,
						actor: {
							type: "user" as const,
							userId: snapshot.userId,
						},
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
							source: "auto_publish_before_scan",
						},
					},
				}
			: {}),
	});
	if (unscanned) {
		return r.published
			? { published: true }
			: { published: false, reason: r.reason };
	}
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
	if (r.published) {
		// Pre-build the download archive for the version that just became
		// the pointer, so the first `fabric instructions sync` of it does not
		// have to. AWAITED, unlike the oRPC call sites: an activity may run
		// for seconds and there is no serverless response lifetime to extend,
		// so the worker can simply do the work.
		//
		// Safe to await because `warmInstructionSnapshotExport` NEVER throws:
		// the pointer has already moved, and a failure here must not fail the
		// activity and retry a publish that already happened. The try/catch
		// below does not depend on the helper keeping that promise.
		//
		// The workflow is untouched — no new activity, no change to control
		// flow — so no replay validation is needed for this.
		//
		// The workflow's `proxyActivities` sets a 60s `heartbeatTimeout` for
		// this activity, and this await can run longer than that on a large
		// tree or slow storage — the same reason the per-file loops elsewhere
		// in this file heartbeat. Without one here, Temporal would time this
		// activity out and retry it after the publish it is warming already
		// committed. The interval is started just before the await and
		// cleared in `finally` so it never outlives this call.
		const heartbeatInterval = setInterval(() => {
			heartbeat({ phase: "export-warm", snapshotId: ref.snapshotId });
		}, 15_000);
		try {
			await warmInstructionSnapshotExport({
				projectId: ref.projectId,
				organizationId: ref.organizationId,
				snapshotId: ref.snapshotId,
			});
		} catch (error) {
			logger.warn(
				{
					event: "project.instructions.export_warm_failed",
					snapshotId: ref.snapshotId,
					projectId: ref.projectId,
					organizationId: ref.organizationId,
					failure:
						error instanceof Error
							? error.constructor.name
							: "unknown",
				},
				"[CodingInstructions] Could not pre-build the export archive",
			);
		} finally {
			clearInterval(heartbeatInterval);
		}
		return { published: true };
	}
	return { published: false, reason: r.reason };
}

/**
 * The deferred content secret scan of a publish-first snapshot (Fizzy #2737),
 * run after it became readable. Returns a verdict; `recordDeferredScanOutcome`
 * stores it. Nothing here writes, so an attempt that dies is simply retried.
 *
 * It reads this snapshot's OWN promoted objects and nothing else. Each key is
 * RECONSTRUCTED — `snapshotKey(projectId, snapshotId, fileId)` — and compared
 * with the row's `storageKey`: a row that does not name exactly that key is a
 * `missing` finding and is never read, so neither a staging key (still
 * writable by the client's signed PUT) nor a base snapshot's object can
 * stand in for the bytes that were published. The promotion put every file
 * there before READY; a row found anywhere else is a finding, not a pass.
 *
 * Per file, the same statements the gate makes about staged bytes, in the
 * same shapes: the stored length (HEAD, then the buffer's own length) is a
 * `size_mismatch`, a hash that differs from the row is a `hash_mismatch`, an
 * absent object is `missing`, and every rule hit is a `secret` finding with
 * its rule id and line — never the matched text, which this process never
 * holds. Findings are capped like rejections.
 *
 * Tenant check only (`loadTenantVerifiedSnapshot`): the version is already
 * readable by the project, and a scan of it must not stop because the member
 * who submitted it has since lost access.
 *
 * Findings are collected BOUNDED (`BoundedRejections`), with the scan given
 * only the room left, so a dense file cannot allocate more hit objects than
 * the verdict will keep.
 *
 * A storage error reading one file (its HEAD or its download) depends on the
 * attempt. Before the last one (`DEFERRED_SCAN_MAX_ATTEMPTS`, the retry
 * budget the workflow schedules this with) it propagates, and Temporal runs
 * the whole scan again. On the last one there is no retry left to wait for,
 * and throwing would throw away every finding already established — a
 * credential found in the first file would vanish behind a storage error in
 * the tenth. So the error is logged by its class alone, the remaining files
 * are still scanned, and the verdict is INCOMPLETE WITH those findings: what
 * was found is shown, and the version is still reported as not fully
 * checked. The workflow's own INCOMPLETE stays the last resort for an attempt
 * that cannot return at all.
 */
export async function scanPublishedInstructionSnapshot(
	ref: SnapshotRef,
): Promise<{
	outcome: InstructionDeferredScanOutcome;
	findings: InstructionRejection[];
}> {
	const snapshot = await loadTenantVerifiedSnapshot(ref);
	if (
		snapshot.status !== "READY" ||
		(snapshot.deferredScanStatus ?? null) === null
	) {
		throw ApplicationFailure.nonRetryable(
			`Instruction snapshot ${ref.snapshotId} has no deferred scan to run`,
			"INSTRUCTION_SNAPSHOT_NO_DEFERRED_SCAN",
		);
	}
	const storage = getStorageProvider();
	const files = await listInstructionFiles(
		ref.snapshotId,
		ref.organizationId,
	);
	const finalAttempt =
		Context.current().info.attempt >= DEFERRED_SCAN_MAX_ATTEMPTS;
	const findings = new BoundedRejections();
	let unreadable = 0;
	for (const f of files) {
		heartbeat({ phase: "deferred-scan", path: f.path });
		const own = snapshotKey(ref.projectId, ref.snapshotId, f.id);
		if (f.storageKey !== own) {
			findings.push({ path: f.path, reason: "missing" });
			continue;
		}
		let data: Buffer;
		try {
			const stored = await rejectionFromStoredSize(storage, own, f);
			if (stored) {
				findings.push(stored);
				continue;
			}
			({ data } = await storage.downloadFile(own, { bucket: BUCKET }));
		} catch (error) {
			if (!finalAttempt) {
				throw error;
			}
			unreadable++;
			logger.warn(
				{
					event: "project.instructions.deferred_scan_file_unreadable",
					snapshotId: ref.snapshotId,
					projectId: ref.projectId,
					organizationId: ref.organizationId,
					// The error's CLASS, never its message or the path: a
					// storage message can carry the key, and the key and
					// the path both name user content.
					failure:
						error instanceof Error
							? error.constructor.name
							: "unknown",
				},
				"[CodingInstructions] Deferred secret scan could not read a published file on its last attempt",
			);
			continue;
		}
		if (data.length !== f.size) {
			findings.push(sizeMismatch(f.path, data.length, f.size));
			continue;
		}
		if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
			findings.push({ path: f.path, reason: "hash_mismatch" });
			continue;
		}
		// Binary content passes AS binary, as it does in the gate.
		const text = decodeUtf8Text(data);
		if (text === null) {
			continue;
		}
		collectSecretHits(findings, f.path, text);
	}
	return {
		outcome:
			unreadable > 0
				? "INCOMPLETE"
				: findings.count() > 0
					? "ISSUES_FOUND"
					: "PASSED",
		findings: findings.toList(),
	};
}

/**
 * Stores a deferred scan's verdict (Fizzy #2737) and, for a verdict that is
 * not clean, its audit row — in ONE conditional transaction
 * (`recordInstructionDeferredScanOutcome`): only a row that is still READY
 * with its scan PENDING moves, so a retry after a lost acknowledgement, or a
 * verdict the reaper already wrote, makes this a no-op that writes no second
 * row. A clean scan writes no audit row; History shows it.
 *
 * The audit rows name the member who acknowledged publishing before the scan
 * (`snapshot.userId`), whoever finished the upload, and carry counts and rule
 * ids only (`summarizeRejections`) — never a path or matched text.
 * `failure`, when the workflow passes one, is the scan's error CLASS, and is
 * logged, never persisted, for the reason on `markInstructionSnapshotFailed`.
 *
 * Findings are kept for every verdict that has them: ISSUES_FOUND, and an
 * INCOMPLETE scan that established some before a file defeated its last
 * attempt — a credential already found is shown, not dropped because a
 * later file could not be read. A PASSED verdict carries none. The list
 * arrives bounded (`BoundedRejections`); it is re-capped only when it is
 * LONGER than that bound, so a list that already ends in its truncation
 * sentinel is stored as it came and the sentinel keeps its real count.
 *
 * Then, for EVERY verdict (design R5), while the snapshot is still the
 * project's pointer, it pre-builds the download archive the publish step
 * skipped so as not to delay the scan. A version whose scan found something
 * stays published and CLI-syncable until the member replaces it, so without
 * the warm its first `fabric instructions sync` would build the archive on
 * demand inside its own request — the latency the move was meant to avoid.
 * The warm is idempotent, so running it again on a retry whose outcome write
 * already committed repairs a worker that died before the warm finished.
 * Never throws for the warm, for the reason on the publish step's.
 */
export async function recordDeferredScanOutcome(
	input: SnapshotRef & {
		outcome: InstructionDeferredScanOutcome;
		findings: InstructionRejection[];
		failure?: string;
	},
): Promise<{ changed: boolean }> {
	const snapshot = await loadTenantVerifiedSnapshot(input);
	const findings =
		input.outcome === "PASSED"
			? []
			: input.findings.length > MAX_REJECTIONS + 1
				? capRejections(input.findings)
				: input.findings;
	const summary = summarizeRejections(findings);
	const resource = {
		type: "project_instruction_snapshot",
		id: input.snapshotId,
		name: `v${snapshot.version}`,
	};
	const audit =
		input.outcome === "ISSUES_FOUND"
			? {
					action: "project.instructions.deferred_scan_issues_found",
					category: "project",
					severity: "error" as const,
					outcome: "failure" as const,
					actor: {
						type: "user" as const,
						userId: snapshot.userId,
					},
					organizationId: input.organizationId,
					projectId: input.projectId,
					resource,
					metadata: {
						version: snapshot.version,
						findingCount: summary.rejectionCount,
						reasonCounts: summary.reasonCounts,
						rules: summary.rules,
					},
				}
			: input.outcome === "INCOMPLETE"
				? {
						action: "project.instructions.deferred_scan_incomplete",
						category: "project",
						severity: "warning" as const,
						outcome: "failure" as const,
						actor: {
							type: "user" as const,
							userId: snapshot.userId,
						},
						organizationId: input.organizationId,
						projectId: input.projectId,
						resource,
						metadata: {
							version: snapshot.version,
							reason: "scan_failed",
							// What the scan established before it stopped,
							// in the same counts-and-rule-ids shape as
							// the issues-found row; absent when nothing was.
							...(findings.length > 0
								? {
										findingCount: summary.rejectionCount,
										reasonCounts: summary.reasonCounts,
										rules: summary.rules,
									}
								: {}),
						},
					}
				: undefined;
	const { changed } = await recordInstructionDeferredScanOutcome({
		snapshotId: input.snapshotId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		outcome: input.outcome,
		findings,
		...(audit ? { audit } : {}),
	});
	if (changed && input.outcome !== "PASSED") {
		logger.warn(
			{
				event: "project.instructions.deferred_scan_recorded",
				snapshotId: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				outcome: input.outcome,
				findingCount: findings.length,
				...(input.failure ? { failure: input.failure } : {}),
			},
			"[CodingInstructions] Deferred secret scan of a published version did not pass",
		);
	}
	await warmIfStillPublished(input);
	return { changed };
}

/**
 * `warmInstructionSnapshotExport` for a snapshot that is still the project's
 * published pointer, heartbeating while it runs and never throwing — the same
 * contract as the warm in `publishInstructionSnapshotActivity`, whose comments
 * explain both. Deliberately NOT exported.
 */
async function warmIfStillPublished(ref: SnapshotRef): Promise<void> {
	const heartbeatInterval = setInterval(() => {
		heartbeat({ phase: "export-warm", snapshotId: ref.snapshotId });
	}, 15_000);
	try {
		const published = await getPublishedInstructionSnapshot(ref.projectId);
		if (published?.id !== ref.snapshotId) {
			return;
		}
		await warmInstructionSnapshotExport({
			projectId: ref.projectId,
			organizationId: ref.organizationId,
			snapshotId: ref.snapshotId,
		});
	} catch (error) {
		logger.warn(
			{
				event: "project.instructions.export_warm_failed",
				snapshotId: ref.snapshotId,
				projectId: ref.projectId,
				organizationId: ref.organizationId,
				failure:
					error instanceof Error ? error.constructor.name : "unknown",
			},
			"[CodingInstructions] Could not pre-build the export archive",
		);
	} finally {
		clearInterval(heartbeatInterval);
	}
}

/**
 * The workflow's prune step: its tenant gate, then the shared per-project
 * pass.
 *
 * The body moved to `lib/instruction-prune.ts` unchanged so the scheduled
 * reaper can run exactly the same pass off its own candidate query. What
 * stays here is the part that is specific to being called from a snapshot's
 * own workflow: `loadVerifiedSnapshot` proves this run's project and
 * organization are the snapshot's own before anything is deleted.
 */
export async function pruneInstructionSnapshots(
	ref: SnapshotRef,
): Promise<{ deleted: number; storageTruncated: boolean }> {
	await loadVerifiedSnapshot(ref);
	return await pruneProjectInstructionSnapshots(
		getStorageProvider(),
		ref.projectId,
		ref.organizationId,
	);
}
