/**
 * Coding Instructions queries.
 *
 * Tenant rule: every top-level accessor filters by `projectId` AND
 * `organizationId` (never OR'd). The two functions below that only take an
 * `id`/`projectId` are UNSCOPED by design and say so in their own comment;
 * every other exported function here filters by the tenant columns it is
 * given.
 */

import { db, Prisma } from "../client";
import type {
	ProjectInstructionFileKind,
	ProjectInstructionSnapshotStatus,
	ProjectInstructionSource,
} from "../generated/client";
import { type RecordAuditInput, recordAuditTx } from "./audit-log";

export type InstructionSnapshotStatus = ProjectInstructionSnapshotStatus;
export type InstructionSource = ProjectInstructionSource;
export type InstructionFileKind = ProjectInstructionFileKind;

/** Shape of `ProjectInstructionSnapshot.rejection`. Set only when status is REJECTED. */
export type InstructionRejection = {
	path: string;
	reason: string;
	detail?: string;
	line?: number;
};

const summarySelect = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	version: true,
	source: true,
	status: true,
	rejection: true,
	settingsFrozen: true,
	publishOnReady: true,
	fileCount: true,
	storedBytes: true,
	excludedCount: true,
	digest: true,
	sourceRef: true,
	sourceCommitSha: true,
	createdAt: true,
	readyAt: true,
	publishedAt: true,
	user: { select: { id: true, name: true } },
} satisfies Prisma.ProjectInstructionSnapshotSelect;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

type CreateInstructionSnapshotInput = {
	projectId: string;
	organizationId: string;
	userId: string;
	source: InstructionSource;
	settingsFrozen: unknown;
	publishOnReady: boolean;
	excludedCount: number;
	files: Array<{
		path: string;
		size: number;
		sha256: string;
		mimeType: string;
		isText: boolean;
		kind: InstructionFileKind;
		storageKey: string;
	}>;
};

/**
 * How many times to re-read the highest version and retry the insert.
 *
 * The version is allocated read-then-write inside the transaction, which
 * Postgres' default READ COMMITTED isolation does not serialize: two uploads
 * beginning on the same project at the same moment both read version N and
 * both try to insert N + 1, and `@@unique([projectId, version])` fails the
 * loser with P2002. Retrying re-reads the now-committed winner, so the second
 * upload takes N + 2 instead of surfacing a raw Prisma error as a 500 at
 * `begin-snapshot.ts`. Three attempts covers the realistic contention (two or
 * three people uploading together); beyond that the collision is not a race
 * and the error is worth seeing.
 */
const VERSION_ALLOCATION_ATTEMPTS = 3;

/** True only for a unique-constraint violation — every other error rethrows. */
function isVersionCollision(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2002"
	);
}

export async function createInstructionSnapshot(
	input: CreateInstructionSnapshotInput,
) {
	let lastError: unknown;
	for (let attempt = 0; attempt < VERSION_ALLOCATION_ATTEMPTS; attempt++) {
		try {
			return await allocateAndCreateSnapshot(input);
		} catch (error) {
			if (!isVersionCollision(error)) {
				throw error;
			}
			lastError = error;
		}
	}
	throw lastError;
}

function allocateAndCreateSnapshot(input: CreateInstructionSnapshotInput) {
	return db.$transaction(async (tx) => {
		const latest = await tx.projectInstructionSnapshot.findFirst({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			orderBy: { version: "desc" },
			select: { version: true },
		});
		const snapshot = await tx.projectInstructionSnapshot.create({
			data: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				version: (latest?.version ?? 0) + 1,
				source: input.source,
				status: "RECEIVING",
				settingsFrozen: input.settingsFrozen as Prisma.InputJsonValue,
				publishOnReady: input.publishOnReady,
				excludedCount: input.excludedCount,
				fileCount: input.files.length,
			},
			select: { id: true, version: true },
		});
		await tx.projectInstructionFile.createMany({
			data: input.files.map((f) => ({
				snapshotId: snapshot.id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				path: f.path,
				kind: f.kind,
				storageKey: f.storageKey,
				sha256: f.sha256,
				size: f.size,
				mimeType: f.mimeType,
				isText: f.isText,
			})),
		});
		const files = await tx.projectInstructionFile.findMany({
			where: {
				snapshotId: snapshot.id,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			select: { id: true, path: true, storageKey: true },
		});
		return { id: snapshot.id, version: snapshot.version, files };
	});
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * UNSCOPED. Callers outside oRPC (MCP, workflow activities) must call
 * `hasProjectAccess` against the returned row's `projectId` before using it.
 */
export function getInstructionSnapshotById(id: string) {
	return db.projectInstructionSnapshot.findUnique({
		where: { id },
		select: summarySelect,
	});
}

export function getInstructionSnapshot(
	id: string,
	projectId: string,
	organizationId: string,
) {
	return db.projectInstructionSnapshot.findFirst({
		where: { id, projectId, organizationId },
		select: summarySelect,
	});
}

export function listInstructionSnapshots(
	projectId: string,
	organizationId: string,
) {
	return db.projectInstructionSnapshot.findMany({
		where: { projectId, organizationId },
		orderBy: { version: "desc" },
		select: summarySelect,
	});
}

/** UNSCOPED by design: the project's published snapshot is a project-level pointer. */
export async function getPublishedInstructionSnapshot(projectId: string) {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { publishedInstructionSnapshot: { select: summarySelect } },
	});
	return project?.publishedInstructionSnapshot ?? null;
}

/**
 * A snapshot's file rows, scoped by organization as well as by snapshot.
 *
 * The `organizationId` filter is defence in depth, not the primary check —
 * callers verify the PARENT snapshot's tenancy first. It is here because the
 * child's own foreign key binds `(snapshotId, projectId)` only
 * (`schema.prisma`, `project_instruction_file_snapshotId_projectId_fkey`), so
 * a row carrying the wrong `organizationId` satisfies the constraint and
 * would be served off a parent check alone. Every child read and write in
 * this file filters on the column for that reason; the value comes from the
 * already-loaded snapshot in the activities and from the project's hosting
 * organization in the procedures.
 */
export function listInstructionFiles(
	snapshotId: string,
	organizationId: string,
	filter?: { kind?: InstructionFileKind; query?: string },
) {
	const q = filter?.query?.trim();
	return db.projectInstructionFile.findMany({
		where: {
			snapshotId,
			organizationId,
			...(filter?.kind ? { kind: filter.kind } : {}),
			...(q
				? {
						OR: [
							{ path: { contains: q, mode: "insensitive" } },
							{ name: { contains: q, mode: "insensitive" } },
							{
								description: {
									contains: q,
									mode: "insensitive",
								},
							},
						],
					}
				: {}),
		},
		orderBy: { path: "asc" },
		select: {
			id: true,
			path: true,
			kind: true,
			name: true,
			description: true,
			size: true,
			mimeType: true,
			isText: true,
			sha256: true,
			storageKey: true,
			mode: true,
		},
	});
}

/** Organization-scoped for the reason on `listInstructionFiles`. */
export function getInstructionFileByPath(
	snapshotId: string,
	organizationId: string,
	path: string,
) {
	return db.projectInstructionFile.findFirst({
		where: { snapshotId, path, organizationId },
		select: {
			id: true,
			path: true,
			kind: true,
			name: true,
			description: true,
			size: true,
			mimeType: true,
			isText: true,
			sha256: true,
			storageKey: true,
			mode: true,
			projectId: true,
		},
	});
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Immutable rows: only metadata (classification, display name, description,
 * Unix mode) can change after a file is written. Content fields (`path`,
 * `storageKey`, `sha256`, `size`, `mimeType`, `isText`) are never touched here.
 *
 * `updateMany` rather than `update`, because the tenant filter belongs in the
 * WHERE clause and `update` accepts only a unique selector. A wrong
 * `organizationId` therefore writes nothing instead of writing across a
 * tenant boundary.
 */
export async function updateInstructionFileMetadata(
	fileId: string,
	organizationId: string,
	data: {
		kind: InstructionFileKind;
		name: string | null;
		description: string | null;
		mode?: number | null;
		/** Location only: staging → snapshot key moves; never content fields. */
		storageKey?: string;
	},
) {
	await db.projectInstructionFile.updateMany({
		where: { id: fileId, organizationId },
		data,
	});
}

/**
 * Moves ONE file row onto its deterministic staging key, as a compare-and-set.
 *
 * `createUploadUrls` rewrites each row's provisional `begin`-time key
 * (`stagingKey(projectId, "pending", <index>)`) to the real
 * `(projectId, snapshotId, fileId)` key before signing a PUT for it, because
 * the file id only exists once `createInstructionSnapshot` has returned. That
 * rewrite used to be an unconditional metadata write constrained by file id
 * and organization alone, and the procedure's `RECEIVING` check was a separate
 * read minutes earlier — so a request that had already read the snapshot as
 * RECEIVING could, after finalization promoted a file to its IMMUTABLE
 * snapshot key, point that row back at writable staging and hand out a signed
 * PUT for it. The published snapshot then served whatever bytes were put
 * there, under a digest that described the content the gate had actually
 * scanned.
 *
 * So the location change is one-way and atomic:
 *
 * - `storageKey: from` is the compare half. The caller passes the key it just
 *   read, so a promotion that moved the row in between matches nothing.
 * - `snapshot: { status: "RECEIVING" }` is a relation filter, which Prisma
 *   compiles into the same statement — the parent's state is therefore checked
 *   at the moment of the write, not read minutes before it.
 * - `snapshotId`/`projectId`/`organizationId` keep the write inside the tenant
 *   and the snapshot the caller named.
 *
 * `moved` is false for every one of those reasons at once, deliberately: the
 * caller cannot tell a promoted row from a finished snapshot from a wrong
 * tenant, and refuses the URL either way.
 */
export async function claimInstructionFileStagingKey(input: {
	fileId: string;
	snapshotId: string;
	projectId: string;
	organizationId: string;
	/** The key the caller read; this write replaces it, or leaves `to` in place. */
	from: string;
	/** The deterministic staging key for this (project, snapshot, file). */
	to: string;
}): Promise<{ moved: boolean }> {
	const { count } = await db.projectInstructionFile.updateMany({
		where: {
			id: input.fileId,
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			// `from` is the compare half; `to` is accepted as well so that two
			// requests that both read the provisional key — a retry of a lost
			// response, or two tabs — both succeed: the second finds the row
			// already where it wants it and its write is a no-op. An immutable
			// snapshot key is neither, so it still matches nothing.
			storageKey: { in: [input.from, input.to] },
			snapshot: { status: "RECEIVING" },
		},
		data: { storageKey: input.to },
	});
	return { moved: count > 0 };
}

/**
 * The two states that are a VERDICT: the workflow has answered for this
 * snapshot, and that answer is what the product serves. Every transition into
 * one of them is conditional on the row not already holding one, which is what
 * makes the terminal activities idempotent under Temporal's at-least-once
 * delivery (see `markInstructionSnapshotReady`).
 *
 * FAILED is deliberately NOT here. It is re-attemptable — the tab's "Try
 * again" re-runs the workflow from it — and the run started by that retry has
 * to be able to write its verdict over it.
 */
const VERDICT_STATUSES: InstructionSnapshotStatus[] = ["READY", "REJECTED"];

/**
 * The READY transition, as a single conditional write.
 *
 * `finalizeInstructionSnapshot` is a Temporal activity, and Temporal delivers
 * activities AT LEAST ONCE: a worker that commits this write and then dies
 * before its completion is acknowledged is retried, and the whole activity
 * runs again. Every other step it performs is idempotent (promotion re-hashes
 * and re-puts the same bytes; the staging sweep tolerates an empty prefix),
 * but an unconditional status write is not — the retry stamped a FRESH
 * `readyAt` onto a snapshot that had been READY since the first attempt.
 * That timestamp is not decoration: the ZIP builder uses it for entry dates,
 * so one download could build the digest-keyed archive with the original
 * value while a later one used the replacement.
 *
 * So the write only matches a row that has NOT already reached a verdict, and
 * `changed` reports whether THIS call made the transition. A retry that finds
 * the snapshot already READY matches nothing, writes nothing, and its caller
 * returns the same success the first attempt did.
 *
 * `status: { notIn: [...] }` rather than `status: "VALIDATING"`: the finalize
 * handler starts the workflow BEFORE writing VALIDATING (deliberately — see
 * `startInstructionSnapshotValidation`), so a fast upload can reach this
 * write while the row is still RECEIVING, and a "Try again" run can reach it
 * while the row is still FAILED. Matching only VALIDATING would drop the
 * verdict in exactly those races and strand the snapshot.
 */
export async function markInstructionSnapshotReady(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	fileCount: number;
	storedBytes: number;
	digest: string;
	readyAt: Date;
}): Promise<{ changed: boolean }> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: { notIn: VERDICT_STATUSES },
		},
		data: {
			status: "READY",
			fileCount: input.fileCount,
			storedBytes: input.storedBytes,
			digest: input.digest,
			readyAt: input.readyAt,
			rejection: Prisma.JsonNull,
		},
	});
	return { changed: count > 0 };
}

/**
 * The REJECTED transition and its audit row, as ONE idempotent unit.
 *
 * Same at-least-once problem as `markInstructionSnapshotReady`, with a worse
 * consequence: the rejection audit is the only record that an upload was
 * refused for carrying credentials, and a retried activity wrote the status
 * again AND emitted a second row for the same rejection. The conditional write
 * is what makes the retry a no-op, and `recordAuditTx` inside the same
 * transaction is what keeps the row and the verdict from being separable —
 * they commit together or neither does.
 *
 * Transactional rather than the fire-and-forget `recordAudit` used elsewhere
 * in this feature, because gating a best-effort write on `changed` still loses
 * the row when the process dies in the gap between the two: the retry
 * correctly declines to re-write the verdict, and with it declines to write
 * the audit that never landed. The cost is that an audit-insert failure rolls
 * the verdict back and fails the activity — which is safe precisely because
 * the retry is now idempotent, and is what the root `AGENTS.md` asks for when
 * the audit row and the business mutation must commit atomically.
 */
export async function markInstructionSnapshotRejected(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	rejections: InstructionRejection[];
	audit: RecordAuditInput;
}): Promise<{ changed: boolean }> {
	return db.$transaction(async (tx) => {
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: { notIn: VERDICT_STATUSES },
			},
			data: {
				status: "REJECTED",
				rejection: input.rejections as unknown as Prisma.InputJsonValue,
			},
		});
		if (count === 0) {
			return { changed: false };
		}
		await recordAuditTx(tx, input.audit);
		return { changed: true };
	});
}

/**
 * Moves a snapshot into VALIDATING, and only from a state that is actually
 * waiting for validation.
 *
 * `finalize` starts the workflow BEFORE writing this status, deliberately: a
 * failed start must leave the row where a retried finalize can repair it. But
 * the workflow then races the write. A small upload can reach READY (or
 * REJECTED) in the time between, and an unconditional write to VALIDATING
 * overwrote that terminal verdict — which for the READY case also made the
 * publish activity refuse the snapshot as `not_ready`, leaving it polling for
 * a validation that had already finished and could never publish.
 *
 * So the transition is conditional, and `changed` reports whether THIS call
 * made it. `count === 0` means the workflow won: the caller re-reads and
 * returns the real status rather than asserting one.
 *
 * RECEIVING is the first finalize; FAILED is the tab's "Try again", which
 * re-runs the workflow under the same deterministic id. VALIDATING is
 * deliberately NOT in the set — it is already the target state, so matching
 * zero rows and re-reading gives the same answer with one fewer write.
 */
export async function startInstructionSnapshotValidation(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<{ changed: boolean }> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: { in: ["RECEIVING", "FAILED"] },
		},
		data: { status: "VALIDATING" },
	});
	return { changed: count > 0 };
}

/**
 * The FAILED transition, as a single conditional write.
 *
 * The workflow's boundary catch calls this to stop a snapshot whose run died
 * from looking like work in progress. It used to be a read of the status
 * followed by an unconditional write, and the gap between the two is real:
 * Temporal delivers activities AT LEAST ONCE, so a timed-out attempt keeps
 * running while its retries fail. That attempt could read VALIDATING, the
 * original attempt could then commit READY (or REJECTED), and the marker would
 * finally stamp FAILED over a verdict that had already been reached — over
 * bytes already promoted to the immutable prefix, and possibly over the
 * snapshot the project's published pointer names, which the read APIs then
 * refuse to serve.
 *
 * `status: { in: ["RECEIVING", "VALIDATING"] }` is the same predicate the read
 * enforced, moved into the WHERE clause so nothing can commit between the
 * check and the write. `marked` comes from the affected-row count, so a retry
 * of the marker itself — or a marker racing a real verdict — is a no-op that
 * reports it did nothing.
 *
 * FAILED is the only transition here that is deliberately re-writable: the
 * tab's "Try again" re-runs the workflow from it, and that run must be able to
 * write its own verdict over it (see `VERDICT_STATUSES`). FAILED is therefore
 * NOT in the matched set — re-marking an already-FAILED snapshot writes
 * nothing and answers false.
 */
export async function failInstructionSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<{ changed: boolean }> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: { in: ["RECEIVING", "VALIDATING"] },
		},
		data: { status: "FAILED", rejection: Prisma.JsonNull },
	});
	return { changed: count > 0 };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Atomic and safe under concurrent retries. Refuses a snapshot that is not
 * READY. Moves the pointer with a single conditional `updateMany` — never a
 * read-then-write — so two concurrent publishes (e.g. a retried Temporal
 * activity racing a newer publish) cannot regress the pointer: the write
 * only matches when the project has no published snapshot yet or its
 * current published version is strictly lower than this one. A retried
 * publish of the snapshot that is *already* the published pointer is
 * idempotent and returns `{ published: true, changed: false }` without
 * writing anything.
 *
 * `changed` reports whether THIS call moved the pointer, and it is derived
 * from the conditional write's own row count rather than from a read before
 * and after — a read-then-compare would answer a question about a moment
 * that has already passed, and two concurrent publishes would both see the
 * pointer move and both claim it. `count === 1` is true for exactly one
 * caller, which is what lets the publish activity emit one audit row per
 * real publication and none for an idempotent Temporal retry.
 */
export async function publishInstructionSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}) {
	return db.$transaction(async (tx) => {
		const snapshot = await tx.projectInstructionSnapshot.findFirst({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			select: { id: true, status: true, version: true },
		});
		if (!snapshot) {
			return {
				published: false as const,
				changed: false as const,
				reason: "not_found" as const,
			};
		}
		if (snapshot.status !== "READY") {
			return {
				published: false as const,
				changed: false as const,
				reason: "not_ready" as const,
			};
		}
		const { count } = await tx.project.updateMany({
			where: {
				id: input.projectId,
				organizationId: input.organizationId,
				OR: [
					{ publishedInstructionSnapshotId: null },
					{
						publishedInstructionSnapshot: {
							version: { lt: snapshot.version },
						},
					},
				],
			},
			data: { publishedInstructionSnapshotId: snapshot.id },
		});
		if (count === 1) {
			await tx.projectInstructionSnapshot.update({
				where: { id: snapshot.id },
				data: { publishedAt: new Date() },
			});
			return { published: true as const, changed: true as const };
		}
		// The conditional write matched nothing: either this snapshot is
		// already the published pointer (idempotent retry — not an error), or
		// a newer snapshot has since taken the pointer (a real conflict).
		const project = await tx.project.findUnique({
			where: {
				id: input.projectId,
				organizationId: input.organizationId,
			},
			select: { publishedInstructionSnapshotId: true },
		});
		if (project?.publishedInstructionSnapshotId === snapshot.id) {
			return { published: true as const, changed: false as const };
		}
		return {
			published: false as const,
			changed: false as const,
			reason: "older_than_current" as const,
		};
	});
}

// ---------------------------------------------------------------------------
// Prune / delete
// ---------------------------------------------------------------------------

/**
 * Snapshots whose rows and objects may be deleted, never the published one.
 *
 * Two windows, because the two kinds of row answer different questions.
 * `keep.ready` is spec §6.3.6's "keep the last 5 READY snapshots plus the
 * published one": history someone may still want to roll back to. A REJECTED
 * or FAILED snapshot never became history — it is a diagnostic for an upload
 * that was refused — so it is kept only long enough to read its rejection
 * list, on its own shorter window.
 *
 * One shared window let five consecutive rejected uploads evict every READY
 * snapshot except the published pointer, which is the opposite of what the
 * retention rule promises.
 *
 * RECEIVING/VALIDATING rows are in neither window: an in-flight snapshot must
 * never be pruned out from under its own workflow.
 */
export async function listPrunableInstructionSnapshots(
	projectId: string,
	organizationId: string,
	keep: { ready: number; rejected: number },
) {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { publishedInstructionSnapshotId: true },
	});
	// The nested `files` selection carries the SAME `organizationId` filter as
	// the parent, for the reason on `listInstructionFiles`: the child's foreign
	// key binds `(snapshotId, projectId)` only, so a row whose own
	// `organizationId` says another tenant still satisfies the constraint and
	// still comes back through the relation. These two selections feed a
	// STORAGE DELETE — the caller removes every key they return — so an
	// unscoped relation here is how pruning one organization's snapshot could
	// delete a mis-tagged row's object belonging to another. Filtering fails
	// closed: such a row's key is left alone rather than swept.
	const files = {
		where: { organizationId },
		select: { storageKey: true },
	} satisfies Prisma.ProjectInstructionSnapshot$filesArgs;
	const [ready, rejected] = await Promise.all([
		db.projectInstructionSnapshot.findMany({
			where: { projectId, organizationId, status: "READY" },
			orderBy: { version: "desc" },
			skip: keep.ready,
			select: { id: true, files },
		}),
		db.projectInstructionSnapshot.findMany({
			where: {
				projectId,
				organizationId,
				status: { in: ["REJECTED", "FAILED"] },
			},
			orderBy: { version: "desc" },
			skip: keep.rejected,
			select: { id: true, files },
		}),
	]);
	return [...ready, ...rejected]
		.filter((r) => r.id !== project?.publishedInstructionSnapshotId)
		.map((r) => ({
			id: r.id,
			storageKeys: r.files.map((f) => f.storageKey),
		}));
}

/**
 * The statuses a snapshot can be deleted in: its workflow has finished, so
 * nothing is still reading its rows or writing its objects.
 *
 * RECEIVING and VALIDATING are excluded because deleting one of those removes
 * the row the NEXT activity reads: `loadVerifiedSnapshot`
 * (`packages/temporal/src/activities/project-instructions.ts`) finds nothing
 * and raises a non-retryable `INSTRUCTION_SNAPSHOT_TENANT_MISMATCH` — a
 * tenancy-shaped failure for what was really a self-inflicted delete — and a
 * promotion already in flight can go on writing immutable objects after this
 * transaction collected the keys it meant to remove. The tab has always hidden
 * the button for those statuses (`InstructionsHistory.tsx`), but a caller
 * reaching the oRPC procedure directly was not hidden from anything.
 *
 * FAILED IS deletable: it is terminal, its workflow has stopped, and someone
 * who does not want to retry a broken upload must be able to remove it.
 */
const DELETABLE_STATUSES: InstructionSnapshotStatus[] = [
	"READY",
	"REJECTED",
	"FAILED",
];

/**
 * Thrown inside `deleteInstructionSnapshot`'s transaction to ROLL BACK the
 * file deletion when the snapshot row itself turns out not to be deletable.
 *
 * Returning normally there would commit the file delete of a snapshot that
 * survived, which is worse than either outcome it is reporting.
 */
class InstructionSnapshotNotDeleted extends Error {
	constructor(readonly snapshotReason?: "active") {
		super("instruction snapshot not deleted");
	}
}

/** True for a Prisma foreign-key violation (P2003), duck-typed on `code`. */
function isForeignKeyViolation(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2003"
	);
}

/**
 * Deletes a snapshot's rows — its files and the snapshot itself — in one
 * transaction, and reports whether the delete was REFUSED because the snapshot
 * is the project's published pointer.
 *
 * The refusal comes from the database. `Project.publishedInstructionSnapshot`
 * is `onDelete: Restrict`, so deleting the published snapshot raises P2003
 * here rather than succeeding. Both callers used to guard it with a
 * read-then-delete check instead, which a concurrent publish wins: it moves
 * the pointer onto a snapshot that was selected for deletion moments earlier,
 * and the old `SetNull` FK then silently cleared the pointer, leaving the
 * project with no published instructions at all. The read check survives at
 * the procedure as the fast, friendly path; this is the authority.
 *
 * Rows go BEFORE storage at every call site, so a storage failure leaves
 * unreferenced objects (collected by the bucket lifecycle rule) rather than
 * rows pointing at bytes that are already gone.
 *
 * The file rows are deleted explicitly rather than left to the cascade so the
 * whole removal is one transaction under one tenant filter.
 *
 * It also refuses a snapshot whose workflow is still running, and for the same
 * reason it refuses the published one: the predicate is in the DELETE itself
 * (`status: { in: DELETABLE_STATUSES }`), not in a read above it, so a run that
 * starts between a caller's check and this statement cannot be deleted out from
 * under its own activities.
 */
export async function deleteInstructionSnapshot(
	id: string,
	projectId: string,
	organizationId: string,
): Promise<{ deleted: boolean; reason?: "published" | "active" }> {
	try {
		return await db.$transaction(async (tx) => {
			await tx.projectInstructionFile.deleteMany({
				where: { snapshotId: id, projectId, organizationId },
			});
			const { count } = await tx.projectInstructionSnapshot.deleteMany({
				where: {
					id,
					projectId,
					organizationId,
					status: { in: DELETABLE_STATUSES },
				},
			});
			if (count === 0) {
				// Two different answers hide behind zero rows — no such
				// snapshot in this tenant, or one whose workflow is still
				// running — and only a read can tell them apart. Throw either
				// way: the file deletion above must not commit for a snapshot
				// row that is still there.
				const surviving = await tx.projectInstructionSnapshot.findFirst(
					{
						where: { id, projectId, organizationId },
						select: { id: true },
					},
				);
				throw new InstructionSnapshotNotDeleted(
					surviving ? "active" : undefined,
				);
			}
			return { deleted: true };
		});
	} catch (error) {
		if (error instanceof InstructionSnapshotNotDeleted) {
			return error.snapshotReason
				? { deleted: false, reason: error.snapshotReason }
				: { deleted: false };
		}
		if (isForeignKeyViolation(error)) {
			return { deleted: false, reason: "published" as const };
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Project instruction settings
// ---------------------------------------------------------------------------

type InstructionSettings = {
	ignoreGlobs?: string[] | null;
	sourceOfTruth?: InstructionSource | null;
};

export async function getProjectInstructionSettings(
	projectId: string,
	organizationId: string,
) {
	const project = await db.project.findFirst({
		where: { id: projectId, organizationId },
		select: { instructionSettings: true },
	});
	const s = (project?.instructionSettings ?? {}) as InstructionSettings;
	return {
		ignoreGlobs: s.ignoreGlobs ?? null,
		sourceOfTruth: s.sourceOfTruth ?? null,
	};
}

export async function updateProjectInstructionSettings(
	projectId: string,
	organizationId: string,
	settings: { ignoreGlobs?: string[] | null },
) {
	const current = await getProjectInstructionSettings(
		projectId,
		organizationId,
	);
	await db.project.update({
		where: { id: projectId, organizationId },
		data: {
			instructionSettings: {
				...current,
				...settings,
			} as unknown as Prisma.InputJsonValue,
		},
	});
}
