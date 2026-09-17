/**
 * Coding Instructions queries.
 *
 * Tenant rule: every top-level accessor filters by `projectId` AND
 * `organizationId` (never OR'd). The few functions below that take only an
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
 * The published snapshot of MANY projects at once, as the summary the MCP
 * project tools advertise on each project they return.
 *
 * UNSCOPED by tenant, for the same reason as `getPublishedInstructionSnapshot`
 * above: the published snapshot is a project-level pointer, and the caller has
 * already access-filtered the ids it passes (the MCP handlers pass only ids
 * that `listProjects`/`getProjectSummaryById` returned for this caller).
 *
 * ONE query for the whole page: the project rows carry the pointer, so the
 * snapshot comes back through the relation rather than through a second round
 * trip per project.
 *
 * A project maps to a summary only when its pointer resolves to a READY
 * snapshot that carries a digest AND whose `organizationId` is the project's
 * own — the integrity check `resolvePublishedInstructionSnapshot` makes on the
 * single-project path, repeated here so the two surfaces cannot disagree.
 * Anything else maps to `null`, which the caller reports as "nothing
 * published" rather than as an error: a caller must not be able to learn from
 * this that a snapshot exists but is mis-tenanted.
 *
 * A project id with no row at all is simply absent from the map.
 */
export type PublishedInstructionSummary = {
	version: number;
	fileCount: number;
	digest: string;
	publishedAt: Date | null;
};

export async function getPublishedInstructionSummariesForProjects(
	projectIds: string[],
): Promise<Map<string, PublishedInstructionSummary | null>> {
	const summaries = new Map<string, PublishedInstructionSummary | null>();
	if (projectIds.length === 0) {
		return summaries;
	}
	const projects = await db.project.findMany({
		where: { id: { in: projectIds } },
		select: {
			id: true,
			organizationId: true,
			publishedInstructionSnapshot: {
				select: {
					organizationId: true,
					status: true,
					version: true,
					fileCount: true,
					digest: true,
					publishedAt: true,
				},
			},
		},
	});
	for (const project of projects) {
		const snapshot = project.publishedInstructionSnapshot;
		summaries.set(
			project.id,
			snapshot &&
				snapshot.status === "READY" &&
				snapshot.digest !== null &&
				snapshot.organizationId === project.organizationId
				? {
						version: snapshot.version,
						fileCount: snapshot.fileCount,
						digest: snapshot.digest,
						publishedAt: snapshot.publishedAt,
					}
				: null,
		);
	}
	return summaries;
}

/** One manifest entry, reduced to what a diff is decided on. */
export type InstructionManifestEntry = { path: string; sha256: string };

/** What changed between two manifests, by path. Each list is sorted. */
export type InstructionManifestChanges = {
	added: string[];
	removed: string[];
	changed: string[];
};

/**
 * The PURE diff of two manifests, by path: added is head-only, removed is
 * base-only, changed is both sides at a different `sha256`.
 *
 * Separated from the queries below so the rule itself is testable without a
 * database, and so both callers — the list tool and the bundle tool — decide
 * "what changed" exactly once.
 *
 * Every list is sorted, so a caller diffing two responses sees a stable order
 * rather than whatever order the rows came back in.
 *
 * MODES are deliberately not part of this diff, and are not part of the
 * snapshot digest either: an upload carries no modes, so a file's `mode` is
 * DERIVED from its content at upload time (a shebang makes it 0755), and a
 * mode change therefore implies a content change that `sha256` already
 * reports. If a future source ever carries real modes — a git import, a
 * tarball — the digest has to include them before this diff can, or two
 * manifests that differ only in mode would share a digest and read as
 * unchanged.
 */
export function diffInstructionManifests(
	base: InstructionManifestEntry[],
	head: InstructionManifestEntry[],
): InstructionManifestChanges {
	const baseByPath = new Map(base.map((f) => [f.path, f.sha256]));
	const headByPath = new Map(head.map((f) => [f.path, f.sha256]));
	const added: string[] = [];
	const changed: string[] = [];
	for (const [path, sha256] of headByPath) {
		const before = baseByPath.get(path);
		if (before === undefined) {
			added.push(path);
		} else if (before !== sha256) {
			changed.push(path);
		}
	}
	const removed = [...baseByPath.keys()].filter(
		(path) => !headByPath.has(path),
	);
	added.sort();
	removed.sort();
	changed.sort();
	return { added, removed, changed };
}

/**
 * What changed between the snapshot a caller last installed — named by its
 * DIGEST, which is the only handle an installed copy keeps — and the snapshot
 * published now.
 *
 * Scoped by `projectId` AND `organizationId`, never OR'd, like every other
 * top-level accessor in this file. The project filter alone already stops a
 * digest belonging to another project from matching; the organization filter
 * is what stops a row that names this project while carrying another tenant's
 * `organizationId` from being read at all. Both are in the WHERE clause rather
 * than checked afterwards, so a mismatch is indistinguishable from an unknown
 * base — the caller is told `null` and takes a full copy, and learns nothing
 * about a snapshot it may not see.
 *
 * The caller passes the hosting organization it has ALREADY verified — on the
 * MCP surface, the organization `resolvePublishedInstructionSnapshot` compared
 * to the caller's project access — never one taken from a request.
 *
 * `null` also covers a base that has been pruned away by the retention sweep.
 * The caller treats every `null` the same way: it cannot say what changed, so
 * it should take a full copy.
 *
 * The base is the NEWEST READY snapshot carrying that digest. Two snapshots
 * with the same digest have, by construction, the same manifest — the digest
 * is computed over the file set — so which of them is chosen cannot change the
 * diff; taking the newest just makes the `base` metadata the most recent
 * publication of that content.
 *
 * Both file reads filter on `projectId` and `organizationId` as well as on the
 * snapshot, for the reason on `listInstructionFiles`: the child's foreign key
 * binds `(snapshotId, projectId)` only, so a row carrying the wrong
 * `organizationId` satisfies the constraint and would otherwise be served off
 * the parent check alone.
 */
export async function getInstructionManifestDiff(input: {
	projectId: string;
	organizationId: string;
	baseDigest: string;
	headSnapshotId: string;
}): Promise<
	| ({
			base: { id: string; version: number; digest: string };
	  } & InstructionManifestChanges)
	| null
> {
	const base = await db.projectInstructionSnapshot.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			digest: input.baseDigest,
			status: "READY",
		},
		orderBy: { version: "desc" },
		select: {
			id: true,
			version: true,
			files: {
				where: {
					projectId: input.projectId,
					organizationId: input.organizationId,
				},
				select: { path: true, sha256: true },
			},
		},
	});
	if (!base) {
		return null;
	}
	const head = await db.projectInstructionFile.findMany({
		where: {
			snapshotId: input.headSnapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
		},
		select: { path: true, sha256: true },
	});
	return {
		// `digest` is not re-read off the row: the WHERE clause above pinned it
		// to exactly this value, so echoing the input is the same answer with
		// one fewer column.
		base: {
			id: base.id,
			version: base.version,
			digest: input.baseDigest,
		},
		...diffInstructionManifests(base.files, head),
	};
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
 * The SAME move, narrowed to RECEIVING, for the Temporal gate activity.
 *
 * Deliberately not `startInstructionSnapshotValidation`: that one also accepts
 * FAILED, which is correct for the API (the tab's "Try again" re-runs the
 * workflow from a FAILED row, and the request that does it is by definition
 * live), and unsafe for an activity attempt, which is not.
 *
 * Temporal delivers an activity AT LEAST ONCE, so a timed-out attempt keeps
 * running while its retries proceed without it. Give such an attempt the
 * FAILED arm and this becomes reachable:
 *
 *  1. an attempt loads the snapshot, then stalls before its claim commits;
 *  2. its retries exhaust, the workflow's boundary catch writes FAILED, and
 *     the workflow closes;
 *  3. the stalled attempt wakes and its claim — which FAILED now satisfies —
 *     writes VALIDATING.
 *
 * Nothing is left to reach a verdict, so the row sits in VALIDATING forever
 * while the zombie attempt may go on writing storage objects behind it. A
 * statement already blocked on the row lock hits the same end: PostgreSQL
 * rechecks the predicate after the FAILED marker commits, and a predicate
 * that admits FAILED still matches.
 *
 * RECEIVING is the only from-state an activity can own on its own evidence,
 * so it is the only one here.
 */
export async function claimInstructionSnapshotValidation(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<{ changed: boolean }> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: "RECEIVING",
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

/**
 * The reaper's FAILED transition for a row stranded in VALIDATING, as a
 * compare-and-set on the version the sweep actually inspected.
 *
 * Round 8, finding 1. The reaper's phase 0 decides a row is dead by asking
 * Temporal whether the snapshot's workflow is still running, and `describe()`
 * and the write that follows are two separate operations. `failInstructionSnapshot`
 * would accept any RECEIVING/VALIDATING row, so anything that happened in
 * between was invisible to it:
 *
 *  1. phase 0 sees the old execution CLOSED; `finalize` then starts a new
 *     execution for the same snapshot and the row goes to VALIDATING again;
 *     the broad write then FAILs a row a live run owns.
 *  2. reaper attempt A sees the old execution closed and stalls. Its retry,
 *     attempt B, writes FAILED; the user presses "Try again"; a new run moves
 *     the row back to VALIDATING; attempt A wakes — Temporal delivers an
 *     activity AT LEAST ONCE — and its write matches the NEWER generation.
 *
 * `updatedAt: observedUpdatedAt` is what closes both. Postgres stamps
 * `updatedAt` on every write to the row (Prisma's `@updatedAt`), so the value
 * the candidate query returned identifies the exact version phase 0 described.
 * Any write since — a newer generation's VALIDATING, an activity claim, a real
 * verdict — moves it, the predicate matches zero rows, and the sweep reports
 * `changed: false` rather than overwriting work it never looked at.
 *
 * `status: "VALIDATING"` rather than the marker's `{ in: ["RECEIVING",
 * "VALIDATING"] }`: this transition heals exactly one population, and a
 * RECEIVING row is phase 1's business, not phase 0's.
 *
 * The written columns mirror `failInstructionSnapshot` exactly — FAILED with
 * `rejection` nulled — because this produces the same row the workflow's own
 * boundary catch would have produced, and the tab's "Try again" reads it the
 * same way.
 */
export async function failStaleValidatingInstructionSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	observedUpdatedAt: Date;
}): Promise<{ changed: boolean }> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: "VALIDATING",
			updatedAt: input.observedUpdatedAt,
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
 * THE RETENTION PREDICATE. Written out once here because TWO queries have to
 * implement exactly it — `listPrunableInstructionSnapshots`, which selects
 * the rows to delete, and `listProjectsWithPrunableInstructionSnapshots`,
 * which counts the same rows to decide which projects the scheduled reaper
 * should even visit. Both doc comments point back at this one; change the
 * rule here and change both.
 *
 * A project KEEPS:
 *
 *  - the newest `keep.ready` UNPUBLISHED READY snapshots, by version; PLUS
 *  - the published snapshot, whatever its version; PLUS
 *  - the newest `keep.rejected` REJECTED/FAILED snapshots, by version.
 *
 * Everything else is prunable.
 *
 * Two windows, because the two kinds of row answer different questions.
 * `keep.ready` is spec §6.3.6's "keep the last 5 READY snapshots plus the
 * published one": history someone may still want to roll back to. A REJECTED
 * or FAILED snapshot never became history — it is a diagnostic for an upload
 * that was refused — so it is kept only long enough to read its rejection
 * list, on its own shorter window. One shared window let five consecutive
 * rejected uploads evict every READY snapshot except the published pointer,
 * which is the opposite of what the retention rule promises.
 *
 * RECEIVING/VALIDATING rows are in neither window: an in-flight snapshot must
 * never be pruned out from under its own workflow.
 *
 * "UNPUBLISHED, then newest five" and not "newest five, then drop the
 * published one" is the part that had to be settled. The second reading makes
 * the published row occupy a retention slot, which is invisible until the
 * published row is the OLDEST of six: the selector skipped the newest five,
 * found only the published row behind them and deleted nothing, while the
 * candidate query counted six and nominated the project again on the next run
 * and every run after it. A hundred such projects filled the reaper's
 * per-run slice with permanent no-ops. Under the predicate above the
 * published row is outside the window entirely, so the two sides agree on
 * every arrangement and the `onDelete: Restrict` foreign key on
 * `Project.publishedInstructionSnapshotId` goes back to being a backstop
 * rather than the mechanism that protects it.
 */
/**
 * The most snapshots ONE call will return per window, so a single project
 * cannot hand the caller an unbounded result set — and, through the nested
 * `files` selection, an unbounded number of storage keys to delete.
 *
 * A project with years of history behind its retention windows is drained
 * across runs rather than in one pass: the scheduled reaper comes back every
 * hour, and a successful upload prunes at the end of its own workflow. Both
 * of those re-query, so whatever this leaves is simply the next call's work.
 */
const PRUNE_WINDOW_TAKE = 50;

/**
 * Snapshots whose rows and objects may be deleted. Implements THE RETENTION
 * PREDICATE above; `listProjectsWithPrunableInstructionSnapshots` counts
 * exactly what this returns.
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
			// `publishedFor: null` goes in the WHERE, ahead of `skip`, so the
			// published row never occupies one of the kept slots and never
			// reaches the result. Excluding it afterwards instead is what let
			// a published-oldest project be nominated forever while this
			// query had nothing to give back.
			where: {
				projectId,
				organizationId,
				status: "READY",
				publishedFor: null,
			},
			orderBy: { version: "desc" },
			skip: keep.ready,
			take: PRUNE_WINDOW_TAKE,
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
			take: PRUNE_WINDOW_TAKE,
			select: { id: true, files },
		}),
	]);
	return [
		...ready,
		// Only a READY snapshot can be the published pointer, so this is a
		// fail-closed backstop on the REJECTED/FAILED window rather than a
		// second retention rule. The READY window needs no post-filter: its
		// own WHERE already excluded the pointer.
		...rejected.filter(
			(r) => r.id !== project?.publishedInstructionSnapshotId,
		),
	].map((r) => ({
		id: r.id,
		storageKeys: r.files.map((f) => f.storageKey),
	}));
}

/**
 * Projects that have prunable instruction snapshots at all, as ONE ordered,
 * deduplicated page of the candidate population plus that population's size,
 * for the scheduled reaper's failure-path sweep.
 *
 * `pruneInstructionSnapshots` only ever runs at the END of a SUCCESSFUL
 * validation workflow, so a project whose uploads keep failing accumulates
 * REJECTED/FAILED rows — and their staged copies — with nothing bounding
 * them. This is the candidate query for running the same prune on a schedule
 * instead: the prune itself is unchanged, so this only has to answer "which
 * projects have anything to prune".
 *
 * Deliberately a SYSTEM-WIDE sweep with no tenant in scope, like the
 * attachment sweeps. It returns each project's own `organizationId` so every
 * write the caller then makes is tenant-bound by values that came out of the
 * row, never out of a request.
 *
 * It implements THE RETENTION PREDICATE documented above
 * `listPrunableInstructionSnapshots`, and has to implement exactly it: this
 * query decides which projects the reaper spends its per-run slice on, and
 * the helper decides what gets deleted once it is there. Either side being
 * looser than the other is a bug — too strict and a prunable snapshot is
 * never visited, too loose and a project is nominated every run for work that
 * cannot happen. The `LEFT JOIN ... WHERE p.id IS NULL` is that predicate's
 * "unpublished" half: on the READY side it is the predicate itself, counting
 * the unpublished rows the helper actually windows by version (counting the
 * published row here as well was the loose direction — six READY rows whose
 * oldest was the published one counted as six forever while the helper had
 * nothing to delete), and on the REJECTED/FAILED side it is a fail-closed
 * no-op, since only a READY snapshot can be the published pointer. `HAVING`
 * counts the rows the `WHERE` already narrowed, so the thresholds are
 * strict: MORE than `keep.ready` unpublished READY rows, or more than
 * `keep.rejected` REJECTED/FAILED rows.
 *
 * RAW SQL, and one statement, because the shape is what makes the rotation
 * honest. Two Prisma `groupBy` calls cannot express this: skipping each
 * window separately rotates two different lists and then interleaves them, so
 * a page is not a window of one canonical order — with twenty-five sticky
 * READY-only projects and twenty-five sticky rejected-only ones, offset 0
 * returned half of each and offset 25 returned nothing at all, forever.
 * `UNION` dedupes (a project over both windows is ONE unit of work, because
 * the prune helper handles both windows in a single pass), `ORDER BY` fixes
 * the one canonical order the offset walks, and `count(*) OVER ()` carries
 * the population size back with the page — so the caller can wrap its offset
 * without a second query, and nothing is materialised in Node beyond the
 * page itself. Every value is BOUND, never interpolated.
 *
 * `offset`/`limit` are the ROTATION and the per-run budget. Without them
 * every run takes the same first page: a hundred projects with deep backlogs,
 * or with a per-project failure that never clears, would be re-nominated
 * every hour and every project behind them would be starved indefinitely. The
 * caller advances the offset per run and wraps it at `total` (see the
 * reaper), so with the population stable every candidate is reached within
 * `ceil(total / limit)` runs.
 *
 * `total` is read off the page, so an offset that ran PAST the end reports
 * zero: the caller learns the real size from its head page, which is the one
 * page that is non-empty whenever the population is.
 */
export async function listProjectsWithPrunableInstructionSnapshots(
	keep: { ready: number; rejected: number },
	limit: number,
	offset: number,
): Promise<{
	candidates: Array<{ projectId: string; organizationId: string }>;
	total: number;
}> {
	const rows = await db.$queryRaw<
		Array<{ projectId: string; organizationId: string; total: bigint }>
	>`
		WITH candidates AS (
			SELECT s."projectId", s."organizationId"
			FROM "project_instruction_snapshot" s
			LEFT JOIN "project" p
				ON p."publishedInstructionSnapshotId" = s."id"
			WHERE s."status" = 'READY' AND p."id" IS NULL
			GROUP BY s."projectId", s."organizationId"
			HAVING count(*) > ${keep.ready}
			UNION
			SELECT s."projectId", s."organizationId"
			FROM "project_instruction_snapshot" s
			LEFT JOIN "project" p
				ON p."publishedInstructionSnapshotId" = s."id"
			WHERE s."status" IN ('REJECTED', 'FAILED') AND p."id" IS NULL
			GROUP BY s."projectId", s."organizationId"
			HAVING count(*) > ${keep.rejected}
		)
		SELECT "projectId", "organizationId", count(*) OVER () AS total
		FROM candidates
		ORDER BY "projectId", "organizationId"
		OFFSET ${offset}
		LIMIT ${limit}
	`;
	return {
		candidates: rows.map((row) => ({
			projectId: row.projectId,
			organizationId: row.organizationId,
		})),
		total: Number(rows[0]?.total ?? 0),
	};
}

/**
 * Snapshots stuck in RECEIVING past the abandonment cutoff, oldest first.
 *
 * A RECEIVING row means `begin` created it and `finalize` was never called —
 * the upload dialog was closed part-way through. Nothing in the feature ever
 * moved such a row: the tab reads it as work in progress and polls it
 * forever, and its staged objects are referenced by a row that will never
 * reach a verdict.
 *
 * SYSTEM-WIDE, with no tenant in scope, for the same reason as
 * `listProjectsWithPrunableInstructionSnapshots`: it is a sweep, and it hands
 * the caller each row's own `projectId`/`organizationId` so that every write
 * that follows is bound to the tenant the ROW names.
 *
 * Oldest first so a backlog larger than one run's budget drains in age order
 * rather than being re-scanned from the same end every hour.
 */
export async function listAbandonedReceivingInstructionSnapshots(
	cutoff: Date,
	limit: number,
): Promise<
	Array<{
		id: string;
		projectId: string;
		organizationId: string;
		createdAt: Date;
	}>
> {
	return db.projectInstructionSnapshot.findMany({
		where: { status: "RECEIVING", createdAt: { lt: cutoff } },
		orderBy: { createdAt: "asc" },
		take: limit,
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			createdAt: true,
		},
	});
}

/**
 * Snapshots stuck in VALIDATING past the staleness cutoff, oldest-touched
 * first.
 *
 * VALIDATING means a validation workflow owns the row, so normally nothing
 * outside that workflow may write a verdict over it. What this selects is the
 * population where that stopped being true: the execution is gone and its
 * failure marker never landed. `finalize` starts the workflow BEFORE it writes
 * VALIDATING, so a status write that lands after the run has already closed
 * leaves exactly this row — VALIDATING, with nothing behind it. A worker that
 * died between the claim and the boundary catch leaves the same shape.
 *
 * The caller decides row by row, by asking Temporal about the snapshot's
 * deterministic workflow id; this query only narrows the population to rows
 * old enough that the question is worth asking at all.
 *
 * `updatedAt`, not `createdAt`, because the claim that moved the row into
 * VALIDATING is itself a write: the age that matters is how long the row has
 * been in this state, not how long ago the upload began.
 *
 * `updatedAt` is also SELECTED, not just filtered on. Every write to this row
 * moves it, so the value read here is the version the caller observed, and
 * `failStaleValidatingInstructionSnapshot` puts it back in the WHERE clause of
 * the write. A row that moved on in between — a newer generation, an activity
 * claim, any other write — no longer matches, so the sweep cannot land a
 * verdict on a row it never actually inspected.
 *
 * SYSTEM-WIDE, with no tenant in scope, like the other sweep queries here, and
 * it hands the caller each row's own `projectId`/`organizationId` so every
 * write that follows is bound to the tenant the ROW names.
 */
export async function listStaleValidatingInstructionSnapshots(
	cutoff: Date,
	limit: number,
): Promise<
	Array<{
		id: string;
		projectId: string;
		organizationId: string;
		updatedAt: Date;
	}>
> {
	return db.projectInstructionSnapshot.findMany({
		where: { status: "VALIDATING", updatedAt: { lt: cutoff } },
		orderBy: { updatedAt: "asc" },
		take: limit,
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			updatedAt: true,
		},
	});
}

/**
 * Closes out an abandoned RECEIVING snapshot, and records the same audit
 * event a refused upload records, in ONE transaction.
 *
 * REJECTED rather than FAILED, deliberately. FAILED is re-attemptable — the
 * tab offers "Try again", which re-runs the validation workflow — and there
 * is nothing to re-attempt here: `finalize` was never called, so no workflow
 * exists and the staged bytes are about to be deleted. REJECTED is terminal,
 * already prunable, already deletable, and already the status the tab knows
 * how to explain, and `failInstructionSnapshot` nulls `rejection`, so it
 * could not carry the reason even if the state were right. The reason travels
 * in the rejection array the tab already renders; there is no failure-reason
 * column and this is not the change that should add one.
 *
 * The predicate is the WRITE's own, not a read above it. A `finalize` racing
 * this call moves the row to VALIDATING, and that row must be left strictly
 * alone: `status: "RECEIVING"` in the WHERE clause is what guarantees it,
 * where a read-then-write would happily reject an upload that had just come
 * back to life. `createdAt: { lt: cutoff }` is in the same clause for the
 * same reason — the candidate list is a moment that has already passed by the
 * time this runs.
 *
 * The audit row goes through `recordAuditTx` inside the transaction and only
 * when the conditional write matched, exactly as `markInstructionSnapshotRejected`
 * does: the reaper is a Temporal activity, Temporal delivers activities AT
 * LEAST ONCE, and a best-effort write after the status write would either
 * duplicate the row on a retry or lose it when the process dies in the gap.
 * The action is the existing `project.instructions.rejected` — the audit
 * taxonomy gains nothing from a second way to say the same thing — and
 * `metadata.source` is what distinguishes the sweep from a refused upload.
 */
export async function rejectAbandonedInstructionSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	cutoff: Date;
}): Promise<{ changed: boolean }> {
	const rejections: InstructionRejection[] = [
		{
			// The whole upload was abandoned, not one file in it; a blank path
			// renders as an empty row, so name the upload the way the
			// "(truncated)" sentinel does.
			path: "(upload)",
			reason: "abandoned",
			// The staging prefix has NOT been swept yet at this point: this
			// statement commits the verdict, and the objects go afterwards.
			// The mark is what phase 1b of the reaper selects on, and what
			// `markAbandonedInstructionSnapshotSwept` clears once the prefix
			// is actually gone.
			detail: ABANDONED_STAGING_PENDING,
		},
	];
	return db.$transaction(async (tx) => {
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: "RECEIVING",
				createdAt: { lt: input.cutoff },
			},
			data: {
				status: "REJECTED",
				rejection: rejections as unknown as Prisma.InputJsonValue,
			},
		});
		if (count === 0) {
			return { changed: false };
		}
		// Read AFTER the write and inside the same transaction, purely to
		// name the actor and the version in the audit row. The verdict is
		// still the one conditional statement above; nothing here decides it.
		const snapshot = await tx.projectInstructionSnapshot.findFirst({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			select: { userId: true, version: true },
		});
		await recordAuditTx(tx, {
			action: "project.instructions.rejected",
			category: "project",
			severity: "warning",
			outcome: "failure",
			// The person whose upload this was, as the refusal path records
			// it. The sweep is what TRIGGERED the row, which `metadata.source`
			// says; it is not the actor whose upload is being closed out.
			actor: { type: "user", userId: snapshot?.userId ?? null },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: input.snapshotId,
				name: snapshot === null ? undefined : `v${snapshot.version}`,
			},
			metadata: {
				rejectionCount: rejections.length,
				reasonCounts: { abandoned: 1 },
				rules: [],
				source: "abandoned_receiving_reaper",
			},
		});
		return { changed: true };
	});
}

/**
 * The two values `detail` carries on an abandonment's single rejection
 * element. Together they are this feature's staging-cleanup state, and the
 * reason it needs no new column and no time window.
 *
 * `rejectAbandonedInstructionSnapshot` writes PENDING along with the verdict,
 * because the objects are deleted AFTER it commits;
 * `markAbandonedInstructionSnapshotSwept` rewrites it to CLEARED once the
 * prefix has actually been swept. Eligibility for the re-sweep is therefore a
 * value ON the row, which nothing but a completed sweep changes, and
 * `updatedAt` is left with exactly one job: ordering the queue.
 *
 * A row whose sweep keeps failing STAYS pending. It is retried on every
 * hourly run and rotated to the back of the queue after each failure, so one
 * undeletable prefix cannot block the rows behind it, and nothing expires it:
 * a prefix that will not delete for days is an operations signal — the
 * `errorCount` in the reaper's result is where it surfaces — not something to
 * time out and forget. Such a row leaves the pending set only when the
 * retention prune deletes it, which takes its whole prefix with it.
 *
 * Neither value reaches a user. The rejected banner
 * (`InstructionsRejectedBanner.tsx`) renders `detail` only for
 * `reason === "secret"` and for the `truncated` sentinel row; every other
 * reason, `abandoned` included, renders its translated `reasonLabels` entry
 * and ignores `detail` entirely.
 */
export const ABANDONED_STAGING_PENDING = "staging pending";
export const ABANDONED_STAGING_CLEARED = "staging cleared";

/**
 * Closed abandonments whose staging prefix has not been swept clean yet,
 * oldest first.
 *
 * `rejectAbandonedInstructionSnapshot` commits the verdict and its audit row
 * first and the objects are deleted second, which is the ordering the feature
 * needs — a row whose staged bytes were deleted while it still said RECEIVING
 * is an upload the tab offers to finish and that cannot be finished. The cost
 * is the gap: an attempt that commits the transition and then dies, or gets a
 * non-empty `deleteObjects.errors`, leaves partially uploaded — possibly
 * secret-bearing — objects behind, and the RECEIVING candidate query cannot
 * see that row any more, because it is REJECTED now.
 *
 * So the sweep rediscovers those rows by the mark they still carry: REJECTED,
 * first rejection reason `abandoned` (the shape
 * `rejectAbandonedInstructionSnapshot` writes, and the only path that writes
 * it), first rejection detail still `ABANDONED_STAGING_PENDING`. There is no
 * time window, deliberately: a window keyed on `updatedAt` cannot coexist
 * with using `updatedAt` as the rotation cursor — every successful sweep
 * would renew the eligibility it was supposed to end, and rows that were
 * finished long ago would circle the queue forever, spending the budget that
 * the genuinely unfinished rows need.
 *
 * `excludeIds` is how the caller drops the rows it has just handled in phase
 * 1 of the same run, IN THE QUERY rather than by skipping them afterwards, so
 * that `take` still returns a full page of real work and a full page still
 * means a real backlog.
 *
 * Deleting under such a row's prefix races nothing: REJECTED is terminal —
 * `startInstructionSnapshotValidation` moves RECEIVING/FAILED only — so no
 * workflow can adopt those bytes afterwards.
 *
 * SYSTEM-WIDE with no tenant in scope, like the other sweep queries, and it
 * returns each row's own `projectId`/`organizationId` so the prefix the
 * caller builds is the one that row names.
 */
export async function listPendingAbandonedInstructionSnapshots(
	limit: number,
	excludeIds: string[],
): Promise<Array<{ id: string; projectId: string; organizationId: string }>> {
	return db.projectInstructionSnapshot.findMany({
		where: {
			status: "REJECTED",
			// The JSON path into the stored rejection array: element 0's
			// `reason`. An ordinary refused upload's first rejection is a
			// `secret`, `hash_mismatch` or `ignore_mismatch`, so it is not
			// selected here and its staged copies are the retention prune's
			// work, not this phase's.
			rejection: { path: ["0", "reason"], equals: "abandoned" },
			// The completion mark, in `AND` because one object literal cannot
			// carry two filters on the same `rejection` field.
			AND: [
				{
					rejection: {
						path: ["0", "detail"],
						equals: ABANDONED_STAGING_PENDING,
					},
				},
			],
			id: { notIn: excludeIds },
		},
		// The rotation, and the ONLY thing `updatedAt` decides here: the row
		// whose sweep failed longest ago is retried first, and each failure
		// re-dates it to the back so it cannot monopolize the budget.
		orderBy: { updatedAt: "asc" },
		take: limit,
		select: { id: true, projectId: true, organizationId: true },
	});
}

/**
 * Records that a closed abandonment's staging prefix has been swept, by
 * rewriting the completion mark on the rejection element the reaper owns.
 *
 * This is what takes a row OUT of
 * `listPendingAbandonedInstructionSnapshots`, and it is deliberately not a
 * timestamp: the previous design reused `updatedAt` as both the eligibility
 * cutoff and the rotation cursor, so every successful sweep renewed the
 * eligibility it meant to end and no clean row ever left the population.
 *
 * ONE conditional, tenant-bound statement, like every other write in this
 * file. The predicate names the tenant columns, `status: "REJECTED"`, the
 * `abandoned` reason AND the still-PENDING mark, so this can only ever
 * rewrite the single-element array the reaper itself wrote — never a refused
 * upload's list of per-file rejections — and only from the one state the
 * rewrite is defined for. No audit row: the verdict was recorded once, by the
 * attempt that made it, and this changes nothing a user or an auditor reads.
 *
 * The PENDING half of that predicate is what makes it a true compare-and-set.
 * Temporal delivers an activity at least once, so two attempts can be
 * sweeping the same prefix at the same time; without it the second one
 * rewrites a mark the first already cleared, which is harmless today and
 * stops being harmless the moment anything reads when the mark was written.
 * The loser now matches nothing and reports `changed: false`.
 *
 * A truncated sweep counts as swept. Its residue is the bucket-lifecycle
 * follow-up's work, and re-listing an already-emptied page budget every hour
 * would starve the rows behind it.
 */
export async function markAbandonedInstructionSnapshotSwept(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<{ changed: boolean }> {
	const rejections: InstructionRejection[] = [
		{
			path: "(upload)",
			reason: "abandoned",
			detail: ABANDONED_STAGING_CLEARED,
		},
	];
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: "REJECTED",
			rejection: { path: ["0", "reason"], equals: "abandoned" },
			// The from-state, in `AND` because one object literal cannot
			// carry two filters on the same `rejection` field.
			AND: [
				{
					rejection: {
						path: ["0", "detail"],
						equals: ABANDONED_STAGING_PENDING,
					},
				},
			],
		},
		data: { rejection: rejections as unknown as Prisma.InputJsonValue },
	});
	return { changed: count > 0 };
}

/**
 * Moves a still-pending abandonment to the BACK of the re-sweep queue by
 * giving it a fresh `updatedAt`, after its staging prefix FAILED to sweep.
 *
 * The queue is ordered oldest-first, so without this one prefix that cannot
 * be deleted — a bucket permission lost, a key that will not go — would sit
 * at the front of every hourly run and the rows behind it would never be
 * reached. Rotating a failure to the back keeps it in the population, where
 * it belongs until someone fixes the storage, without letting it own the
 * budget.
 *
 * ONE conditional, tenant-bound statement naming its full from-state:
 * `status: "REJECTED"`, the `abandoned` reason and the still-PENDING mark,
 * all in the predicate rather than in a read above it. The explicit
 * `updatedAt` is what Prisma writes in place of its own `@updatedAt` value.
 * No other column, and no audit row: the rotation is the sweep's own
 * bookkeeping, and in particular it does NOT touch the completion mark — the
 * row is still pending, which is the point.
 *
 * Status alone was too loose for a queue cursor. Activities are delivered at
 * least once, so a second attempt could re-date a row a first attempt had
 * already swept and CLEARED, pushing a finished row's `updatedAt` forward for
 * no reason; worse, it could re-date an ordinary refused upload that this
 * sweep does not own at all. Both arms now have to still be pending, which is
 * exactly the population `listPendingAbandonedInstructionSnapshots` orders.
 */
export async function rotateAbandonedInstructionSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<{ rotated: boolean }> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: "REJECTED",
			rejection: { path: ["0", "reason"], equals: "abandoned" },
			// In `AND` because one object literal cannot carry two filters on
			// the same `rejection` field.
			AND: [
				{
					rejection: {
						path: ["0", "detail"],
						equals: ABANDONED_STAGING_PENDING,
					},
				},
			],
		},
		data: { updatedAt: new Date() },
	});
	return { rotated: count > 0 };
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
