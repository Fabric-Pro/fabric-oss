/**
 * Coding Instructions queries.
 *
 * Tenant rule: every top-level accessor filters by `projectId` AND
 * `organizationId` (never OR'd). The few functions below that take only an
 * `id`/`projectId` are UNSCOPED by design and say so in their own comment;
 * every other exported function here filters by the tenant columns it is
 * given.
 */

import { createHash } from "node:crypto";
import { db, Prisma } from "../client";
import type {
	ProjectInstructionFileKind,
	ProjectInstructionProposalStatus,
	ProjectInstructionSnapshotStatus,
	ProjectInstructionSource,
} from "../generated/client";
import { type RecordAuditInput, recordAuditTx } from "./audit-log";

export type InstructionSnapshotStatus = ProjectInstructionSnapshotStatus;
export type InstructionProposalStatus = ProjectInstructionProposalStatus;
export type InstructionSource = ProjectInstructionSource;
export type InstructionFileKind = ProjectInstructionFileKind;

/** Admission bounds for reader-submitted proposals that have not been decided. */
export const MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER = 5;
export const MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROJECT = 25;

/** Shape of `ProjectInstructionSnapshot.rejection`. Set only when status is REJECTED. */
export type InstructionRejection = {
	path: string;
	reason: string;
	detail?: string;
	line?: number;
};

export const ABANDONED_STAGING_PENDING = "staging pending";
export const ABANDONED_STAGING_CLEARED = "staging cleared";
export const PROPOSAL_STAGING_CLEANUP_PATH = "(proposal staging)";

const abandonedStagingPendingRejection = {
	path: "(upload)",
	reason: "abandoned",
	detail: ABANDONED_STAGING_PENDING,
} satisfies InstructionRejection;

const proposalStagingPendingRejection = {
	path: PROPOSAL_STAGING_CLEANUP_PATH,
	reason: "abandoned",
	detail: ABANDONED_STAGING_PENDING,
} satisfies InstructionRejection;

function cleanupMarkerFilter(marker: InstructionRejection) {
	return {
		rejection: {
			array_contains: [marker] as unknown as Prisma.InputJsonValue,
		},
	};
}

function pendingCleanupFilter() {
	return {
		OR: [
			cleanupMarkerFilter(abandonedStagingPendingRejection),
			cleanupMarkerFilter(proposalStagingPendingRejection),
		],
	};
}

function activeProposalFilter() {
	return {
		OR: [
			{ proposalStatus: "PENDING" as const },
			{
				proposalStatus: { not: null },
				...pendingCleanupFilter(),
			},
		],
	};
}

function rejectionsWithProposalCleanupMarker(value: unknown) {
	const existing = Array.isArray(value)
		? (value as InstructionRejection[])
		: [];
	if (
		existing.some(
			(item) =>
				item.path === proposalStagingPendingRejection.path &&
				item.reason === proposalStagingPendingRejection.reason &&
				item.detail === proposalStagingPendingRejection.detail,
		)
	) {
		return existing;
	}
	return [...existing, proposalStagingPendingRejection];
}

const summarySelect = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	version: true,
	source: true,
	status: true,
	proposalStatus: true,
	reviewerUserId: true,
	reviewedAt: true,
	rejection: true,
	settingsFrozen: true,
	publishOnReady: true,
	fileCount: true,
	storedBytes: true,
	excludedCount: true,
	digest: true,
	sourceRef: true,
	sourceCommitSha: true,
	// The snapshot this one was derived from (a single-file edit, add or
	// delete in the tab). Read by the validation gate, which needs it to
	// rebuild an inherited row's key in the BASE's immutable prefix, and by
	// the publish fast-forward, which requires it to still be the published
	// pointer.
	baseSnapshotId: true,
	// The base's version number, kept after `SetNull` has cleared the id
	// above. It is what says a row is derived at all, and what the history
	// list renders as "Edited from version N".
	baseVersion: true,
	createdAt: true,
	readyAt: true,
	publishedAt: true,
	user: { select: { id: true, name: true } },
	reviewer: { select: { id: true, name: true } },
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
// Create (derived)
// ---------------------------------------------------------------------------

/**
 * One change a derived snapshot applies to its base.
 *
 * A `put` carries everything `createInstructionSnapshot` needs for a file row
 * — including the server-generated provisional `storageKey` and the
 * classification — because those are computed by the same code in the same
 * place for both paths (`begin-snapshot.ts` / `derive-snapshot.ts`) and this
 * package deliberately does not depend on `@repo/instructions`.
 */
export type DerivedInstructionChange =
	| {
			op: "put";
			path: string;
			size: number;
			sha256: string;
			mimeType: string;
			isText: boolean;
			kind: InstructionFileKind;
			/** Server-generated. The client never supplies a storage key. */
			storageKey: string;
	  }
	| { op: "delete"; path: string };

/**
 * Why a derived snapshot was refused. Every one of these is a statement about
 * the BASE and the resulting file set — the checks that need the base's rows
 * loaded inside the same transaction that writes the new snapshot.
 *
 * The payload-shaped refusals (an invalid relative path, a path the frozen
 * ignore rules exclude, a secret-shaped filename, a single file over the
 * per-file cap, a change touching `.fabricignore`, a duplicated path inside
 * the change set) are the PROCEDURE's, because they need
 * `@repo/instructions` and none of them needs the base's rows. See
 * `derive-snapshot.ts`.
 */
/**
 * The key two paths share when a filesystem would treat them as ONE file:
 * NFC-normalised and lowercased.
 *
 * A COPY of `collisionKey` in `packages/instructions/src/paths.ts`, which is
 * the canonical one. This package does not depend on that one — the same
 * reason `SNAPSHOT_LIMITS` is passed into the input below rather than
 * imported — and the comparison has to happen HERE, inside the transaction
 * that can see the base's rows. Four lines duplicated beats a dependency
 * edge, but they must not drift: `derived-instruction-snapshot.test.ts`
 * asserts the NFC/NFD pair is caught here, and
 * `packages/instructions/__tests__/portable-names-agree-with-cli.test.ts`
 * pins the canonical definition.
 */
function instructionCollisionKey(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

export type DerivedInstructionRefusal =
	| "base_not_found"
	| "base_not_ready"
	/**
	 * The base is no longer the project's published snapshot, decided under
	 * the project row lock inside the create transaction. Both callers also
	 * pre-read the pointer and refuse early with the same user-facing message;
	 * this is the arm that catches a publish landing in the window between
	 * that read and this write.
	 */
	| "base_not_published"
	| "base_key_unexpected"
	| "delete_path_missing"
	| "path_collision"
	| "empty_result"
	| "too_many_files"
	| "too_large"
	| "proposal_proposer_limit"
	| "proposal_project_limit";

/**
 * The active proposal an identical change set already opened.
 *
 * Deliberately NOT a `DerivedInstructionRefusal`: the two callers answer it
 * differently — the inline entry point finishes or reports the row, the tab
 * refuses and names it — so it carries the row rather than a message, and
 * `derivedSnapshotRefusal` (which maps a refusal to one fixed error) is the
 * wrong shape for it.
 */
export type DuplicateInstructionProposal = {
	id: string;
	version: number;
	status: InstructionSnapshotStatus;
	proposalStatus: InstructionProposalStatus | null;
	fileCount: number;
	inheritedCount: number;
	staged: Array<{ id: string; path: string }>;
};

export type CreateDerivedInstructionSnapshotResult =
	| {
			ok: true;
			id: string;
			version: number;
			fileCount: number;
			inheritedCount: number;
			/**
			 * The rows the client still has to PUT — the `put` changes only.
			 * An inherited row must NEVER be handed to `createUploadUrls`:
			 * its key is the base's immutable object, and that procedure
			 * refuses to point a non-staging key back at writable storage.
			 */
			staged: Array<{ id: string; path: string }>;
	  }
	/**
	 * This exact change set is ALREADY an active proposal of this proposer's
	 * against this base, so nothing was written (Fizzy #2605).
	 *
	 * Separated from the refusals above on purpose, and the separation is
	 * load-bearing: it has no `detail`, so every existing
	 * `derivedSnapshotRefusal(created.reason, created.detail)` caller stops
	 * compiling until it decides what a replay means for its surface. A
	 * duplicate silently handled as a fresh create would hand one request the
	 * staged file ids of another request's snapshot.
	 */
	| {
			ok: false;
			reason: "duplicate_proposal";
			existing: DuplicateInstructionProposal;
	  }
	| { ok: false; reason: DerivedInstructionRefusal; detail?: string };

/**
 * The IDENTITY of a change set: sha256 over its sorted
 * `${op}\0${path}\0${sha256 ?? ""}\n` lines.
 *
 * Computed HERE rather than by the callers so the tab's presigned flow and
 * the inline entry point share one formula by construction instead of by two
 * copies agreeing. The paths are the STORED spellings — both callers have
 * already run `validateInstructionChanges`, which normalises them — so two
 * clients spelling the same path differently still produce one digest.
 *
 * Sorted, because a change set is a set: the order a client happened to send
 * its files in is not part of what it is asking for. `op` is in the line so a
 * delete and a rewrite of one path can never collide, and a delete's empty
 * hash field keeps the line shape uniform.
 */
function changeSetDigest(changes: readonly DerivedInstructionChange[]): string {
	const lines = changes
		.map(
			(change) =>
				`${change.op}\0${change.path}\0${
					change.op === "put" ? change.sha256 : ""
				}\n`,
		)
		.sort();
	return createHash("sha256").update(lines.join("")).digest("hex");
}

type CreateDerivedInstructionSnapshotInput = {
	projectId: string;
	organizationId: string;
	userId: string;
	baseSnapshotId: string;
	publishOnReady: boolean;
	proposal: boolean;
	changes: DerivedInstructionChange[];
	/**
	 * `SNAPSHOT_LIMITS.maxFiles` / `maxTotalBytes`, passed in rather than
	 * imported: the caps live in `@repo/instructions`, which this package does
	 * not depend on, and they are frozen per snapshot anyway.
	 */
	limits: { maxFiles: number; maxTotalBytes: number };
	/**
	 * `snapshotPrefix(projectId, baseSnapshotId)`. Every inherited row's key
	 * has to start with it, and a base row that does not refuses the whole
	 * derivation: an inherited row is a pointer into another snapshot's
	 * storage, and the ONE thing that makes that safe is that the pointer can
	 * only ever name the base's own immutable prefix.
	 */
	baseKeyPrefix: string;
};

/**
 * Creates a snapshot SEEDED from a READY one: the changed paths become
 * ordinary RECEIVING rows the client uploads, and every other path is
 * inherited from the base — same bytes, same hash, same promoted object — with
 * nothing crossing the network.
 *
 * The whole point is that what comes out is indistinguishable, to every step
 * downstream, from a full upload: the same verify → scan → finalize → publish
 * workflow runs, the same secret gate reads every file (inherited ones
 * included — the rule set may have tightened since the base was scanned), the
 * same digest is computed, and the same history and retention rules apply.
 * Nothing here is a shortcut past a check; it is a shortcut past the TRANSFER.
 *
 * ONE transaction, and the base is read inside it. Every refusal below is a
 * statement about the base's own file set, so answering it from a read taken
 * before the transaction would be answering about a moment that has passed.
 *
 * `settingsFrozen` is copied from the base VERBATIM: the inherited files were
 * admitted under those ignore rules and those caps, so re-resolving the
 * project's live settings here would produce a snapshot whose stored
 * `.fabricignore` no longer matches its frozen rules — which the validation
 * gate's provenance check refuses, correctly. `excludedCount` is copied for
 * the same reason: it counts what that upload left out, and this derivation
 * left out nothing further.
 *
 * Version allocation is the same read-then-write inside the transaction as
 * `createInstructionSnapshot`, with the same P2002 retry around it.
 */
export async function createDerivedInstructionSnapshot(
	input: CreateDerivedInstructionSnapshotInput,
): Promise<CreateDerivedInstructionSnapshotResult> {
	let lastError: unknown;
	for (let attempt = 0; attempt < VERSION_ALLOCATION_ATTEMPTS; attempt++) {
		try {
			return await allocateAndCreateDerivedSnapshot(input);
		} catch (error) {
			if (!isVersionCollision(error)) {
				throw error;
			}
			lastError = error;
		}
	}
	throw lastError;
}

function allocateAndCreateDerivedSnapshot(
	input: CreateDerivedInstructionSnapshotInput,
): Promise<CreateDerivedInstructionSnapshotResult> {
	return db.$transaction(
		async (tx): Promise<CreateDerivedInstructionSnapshotResult> => {
			// A snapshot that intends to reach the published pointer — a
			// proposal, or a derivation that auto-publishes — is a
			// FAST-FORWARD claim on it (spec §6.12), so the base has to still
			// BE the published version at the moment the row is written.
			//
			// Both callers pre-read the pointer and compare
			// (`derive-snapshot.ts`, `submit-change.ts`), and that read is a
			// fast fail, not the guarantee: between it and this transaction
			// another publish can move the pointer, and nothing below would
			// notice — the base is still a row, and it is still READY. Two
			// editors saving against version 7 would then both produce a
			// version derived from 7, and whichever published second would
			// silently revert the other.
			//
			// So the pointer is compared HERE, under the project row lock,
			// which the proposal path already takes for its admission counts.
			// Taking it for the publish path too costs one extra lock on a
			// path that writes a snapshot anyway, and it is the only way the
			// comparison can mean anything: the publish activity's own
			// conditional write is the second half of the same rule, and this
			// is the half that stops the second snapshot being created at all.
			const claimsPublishedPointer =
				input.proposal || input.publishOnReady;
			if (claimsPublishedPointer) {
				// Serialize on the project row. For a proposal this also
				// serializes admission: counting without the lock lets
				// concurrent reader requests all observe spare capacity and
				// then exceed both bounds together.
				const locked = await tx.$queryRaw<
					Array<{ publishedInstructionSnapshotId: string | null }>
				>`
					SELECT p."publishedInstructionSnapshotId"
					FROM "project" p
					WHERE p."id" = ${input.projectId}
						AND p."organizationId" = ${input.organizationId}
					FOR UPDATE OF p
				`;
				if (locked.length === 0) {
					return { ok: false, reason: "base_not_found" };
				}
				if (
					locked[0]?.publishedInstructionSnapshotId !==
					input.baseSnapshotId
				) {
					return { ok: false, reason: "base_not_published" };
				}
			}
			const digest = changeSetDigest(input.changes);
			if (input.proposal) {
				// A retried proposal is the SAME proposal (Fizzy #2605).
				//
				// Every surface that opens one — the v1 change route, the MCP
				// tool, the CLI push — can lose its response after this
				// transaction committed, and the client has no way to tell
				// that from a request that never arrived. Without this, the
				// retry wrote a second PENDING row holding a second admission
				// slot, and five of those locked the proposer out of the
				// feature with nothing in the tab that looks wrong.
				//
				// BEFORE the two counts, deliberately. A proposer whose
				// earlier attempt filled their last slot would otherwise be
				// told to cancel a proposal to make room — and the one they
				// would cancel is the one they are retrying.
				//
				// PENDING only, which is NARROWER than the
				// `activeProposalFilter` the counts below use, and
				// deliberately so.
				//
				// That filter's second arm matches a TERMINAL proposal whose
				// staging prefix has not been swept yet — including the one
				// `submit-change.ts` writes when its own upload fails, which
				// closes the row out as REJECTED on purpose so the proposer
				// can push again. Matching it here would hand that retry the
				// closed-out row instead of a new proposal, and the proposer
				// could not open one for that edit until the hourly sweep
				// cleared the mark.
				//
				// So a slot held by a terminal row is still a slot — the
				// counts below refuse the retry with the cap message, which
				// is the true answer — and only a proposal genuinely awaiting
				// a decision is answered with itself.
				//
				// `status` is returned rather than assumed because PENDING
				// says nothing about how far the upload got: the caller
				// decides what to do from the snapshot's own status.
				const existing = await tx.projectInstructionSnapshot.findFirst({
					where: {
						projectId: input.projectId,
						organizationId: input.organizationId,
						// The PROPOSER's own. Two people sending the same
						// edit are two proposals; the reviewer decides.
						userId: input.userId,
						baseSnapshotId: input.baseSnapshotId,
						changeSetDigest: digest,
						proposalStatus: "PENDING",
					},
					// Newest first: if an older release left more than one
					// identical row behind, the one to finish or report is
					// the last one written.
					orderBy: { version: "desc" },
					select: {
						id: true,
						version: true,
						status: true,
						proposalStatus: true,
						fileCount: true,
					},
				});
				if (existing) {
					// The same `inheritedFromFileId: null` discriminator the
					// create path returns, so a caller resuming an unfinished
					// upload gets exactly the rows that still need bytes.
					const staged = await tx.projectInstructionFile.findMany({
						where: {
							snapshotId: existing.id,
							projectId: input.projectId,
							organizationId: input.organizationId,
							inheritedFromFileId: null,
						},
						select: { id: true, path: true },
					});
					return {
						ok: false,
						reason: "duplicate_proposal",
						existing: {
							id: existing.id,
							version: existing.version,
							status: existing.status,
							proposalStatus: existing.proposalStatus,
							fileCount: existing.fileCount,
							inheritedCount: existing.fileCount - staged.length,
							staged,
						},
					};
				}
				const proposerCount = await tx.projectInstructionSnapshot.count(
					{
						where: {
							projectId: input.projectId,
							organizationId: input.organizationId,
							userId: input.userId,
							...activeProposalFilter(),
						},
					},
				);
				if (
					proposerCount >=
					MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER
				) {
					return { ok: false, reason: "proposal_proposer_limit" };
				}
				const projectCount = await tx.projectInstructionSnapshot.count({
					where: {
						projectId: input.projectId,
						organizationId: input.organizationId,
						...activeProposalFilter(),
					},
				});
				if (
					projectCount >= MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROJECT
				) {
					return { ok: false, reason: "proposal_project_limit" };
				}
			}
			// Tenant-scoped on BOTH columns, like every other read here: the
			// caller has already resolved the project's hosting organization,
			// and a base row naming this project while carrying another
			// tenant must not be readable through it.
			const base = await tx.projectInstructionSnapshot.findFirst({
				where: {
					id: input.baseSnapshotId,
					projectId: input.projectId,
					organizationId: input.organizationId,
				},
				select: {
					id: true,
					status: true,
					source: true,
					version: true,
					settingsFrozen: true,
					excludedCount: true,
				},
			});
			if (!base) {
				return { ok: false, reason: "base_not_found" };
			}
			// Only a READY snapshot has promoted, hashed, scanned objects to
			// inherit. Anything else is either still in flight (its bytes are
			// in mutable staging) or a verdict against its contents.
			if (base.status !== "READY") {
				return { ok: false, reason: "base_not_ready" };
			}

			const baseFiles = await tx.projectInstructionFile.findMany({
				where: {
					snapshotId: base.id,
					projectId: input.projectId,
					organizationId: input.organizationId,
				},
				select: {
					id: true,
					path: true,
					kind: true,
					name: true,
					description: true,
					storageKey: true,
					sha256: true,
					size: true,
					mimeType: true,
					isText: true,
					mode: true,
				},
			});

			const puts = new Map<string, DerivedInstructionChange>();
			const deletions = new Set<string>();
			for (const change of input.changes) {
				if (change.op === "delete") {
					deletions.add(change.path);
				} else {
					puts.set(change.path, change);
				}
			}

			// A delete names a path that has to BE there. Silently accepting
			// one that is not would publish a version whose only change is a
			// version number, which is exactly how a stale editor's "delete"
			// would look after a teammate already removed the file.
			const basePaths = new Set(baseFiles.map((f) => f.path));
			for (const path of deletions) {
				if (!basePaths.has(path)) {
					return {
						ok: false,
						reason: "delete_path_missing",
						detail: path,
					};
				}
			}

			const inherited = baseFiles.filter(
				(f) => !puts.has(f.path) && !deletions.has(f.path),
			);
			// The pointer-safety invariant, checked rather than assumed: an
			// inherited row keeps the BASE's key until promotion rewrites it,
			// so a base row sitting anywhere other than the base's own
			// immutable prefix would make this snapshot point at storage no
			// activity in this feature ever wrote.
			const stray = inherited.find(
				(f) => !f.storageKey.startsWith(input.baseKeyPrefix),
			);
			if (stray) {
				return {
					ok: false,
					reason: "base_key_unexpected",
					detail: stray.path,
				};
			}

			const putList = [...puts.values()].filter(
				(c): c is Extract<DerivedInstructionChange, { op: "put" }> =>
					c.op === "put",
			);
			if (inherited.length + putList.length === 0) {
				return { ok: false, reason: "empty_result" };
			}
			// Across the RESULT, not across the change set: adding `Claude.md`
			// to a base that already stores `CLAUDE.md` produces two rows that
			// are one file on a case-insensitive filesystem, and whichever
			// lands second wins on the developer's machine.
			//
			// Two things make this more than a lowercase comparison.
			//
			// The KEY folds Unicode normalisation as well as case. `café.md`
			// stored as NFC and the same name written as NFD are one file on
			// macOS; the change set's own check sees one path and passes, and
			// only here — where the base's rows meet the new ones — is the
			// pair visible at all.
			//
			// The INHERITED rows are exempt from colliding with EACH OTHER. A
			// base admitted before these rules existed may already hold such a
			// pair, and refusing the derivation would mean no version of that
			// project could ever be edited again — including the edit that
			// removes one of them. So an inherited pair is carried forward as
			// it stands, and only a NEW put is refused: against an inherited
			// row, or against another put.
			const seen = new Map<string, string>();
			for (const file of inherited) {
				const key = instructionCollisionKey(file.path);
				// `set`, not a collision check: the first spelling wins as the
				// one a put is compared against, and a second inherited row
				// carrying the same key is carried forward untouched.
				if (!seen.has(key)) {
					seen.set(key, file.path);
				}
			}
			for (const change of putList) {
				const key = instructionCollisionKey(change.path);
				const previous = seen.get(key);
				if (previous !== undefined) {
					return {
						ok: false,
						reason: "path_collision",
						detail: `${previous} / ${change.path}`,
					};
				}
				seen.set(key, change.path);
			}

			const fileCount = inherited.length + putList.length;
			if (fileCount > input.limits.maxFiles) {
				return {
					ok: false,
					reason: "too_many_files",
					detail: String(fileCount),
				};
			}
			const totalBytes =
				inherited.reduce((sum, f) => sum + f.size, 0) +
				putList.reduce((sum, c) => sum + c.size, 0);
			if (totalBytes > input.limits.maxTotalBytes) {
				return {
					ok: false,
					reason: "too_large",
					detail: String(totalBytes),
				};
			}

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
					// The bytes that DID move came through the browser, as
					// they do for an upload. The provenance of the rest is
					// `baseSnapshotId`, not the source enum.
					source: "UPLOAD",
					status: "RECEIVING",
					baseSnapshotId: base.id,
					// The DURABLE half of the provenance. `baseSnapshotId` is
					// `SetNull`, so it is gone the moment the base is deleted
					// or pruned — and "was this derived?" still has to be
					// answerable then, both for the publish fast-forward and
					// for the history line. Written once here and never
					// updated.
					baseVersion: base.version,
					// Written for every derived snapshot, read only for
					// proposals. Storing it on a non-proposal derivation too
					// costs nothing and keeps one rule — "a derived snapshot
					// records which change set made it" — rather than a
					// column whose presence depends on a flag.
					changeSetDigest: digest,
					settingsFrozen:
						base.settingsFrozen as Prisma.InputJsonValue,
					// Proposal publication is review-only. Persist both halves of
					// that invariant so a caller cannot create a PENDING proposal
					// whose validation workflow automatically publishes it.
					publishOnReady: input.proposal
						? false
						: input.publishOnReady,
					proposalStatus: input.proposal ? "PENDING" : null,
					excludedCount: base.excludedCount,
					fileCount,
				},
				select: { id: true, version: true },
			});
			await tx.projectInstructionFile.createMany({
				data: [
					...inherited.map((f) => ({
						snapshotId: snapshot.id,
						projectId: input.projectId,
						organizationId: input.organizationId,
						// The EDITOR, not the base's uploader: this row is
						// this snapshot's, and `userId` is a tenant column
						// every row in a snapshot shares.
						userId: input.userId,
						path: f.path,
						kind: f.kind,
						name: f.name,
						description: f.description,
						// The base's immutable promoted object. Promotion
						// rewrites this to THIS snapshot's own key once it has
						// re-hashed and re-written the bytes.
						storageKey: f.storageKey,
						sha256: f.sha256,
						size: f.size,
						mimeType: f.mimeType,
						isText: f.isText,
						mode: f.mode,
						inheritedFromFileId: f.id,
					})),
					...putList.map((c) => ({
						snapshotId: snapshot.id,
						projectId: input.projectId,
						organizationId: input.organizationId,
						userId: input.userId,
						path: c.path,
						kind: c.kind,
						storageKey: c.storageKey,
						sha256: c.sha256,
						size: c.size,
						mimeType: c.mimeType,
						isText: c.isText,
						inheritedFromFileId: null,
					})),
				],
			});
			// Only the rows that still need bytes. `inheritedFromFileId:
			// null` is the discriminator, and it is the same one the gate
			// uses — there is no second definition of "this row was uploaded".
			const staged = await tx.projectInstructionFile.findMany({
				where: {
					snapshotId: snapshot.id,
					projectId: input.projectId,
					organizationId: input.organizationId,
					inheritedFromFileId: null,
				},
				select: { id: true, path: true },
			});
			return {
				ok: true,
				id: snapshot.id,
				version: snapshot.version,
				fileCount,
				inheritedCount: inherited.length,
				staged,
			};
		},
	);
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
	visibility: { viewerUserId: string; canReviewProposals: boolean },
) {
	return db.projectInstructionSnapshot.findMany({
		where: {
			projectId,
			organizationId,
			...(visibility.canReviewProposals
				? {}
				: {
						OR: [
							{ proposalStatus: null },
							{ proposalStatus: "APPROVED" as const },
							{
								userId: visibility.viewerUserId,
								proposalStatus: {
									in: ["PENDING", "REJECTED"] as const,
								},
							},
						],
					}),
		},
		orderBy: { version: "desc" },
		select: summarySelect,
	});
}

/**
 * Lists proposal metadata only. File rows and storage keys are deliberately
 * absent: proposal bytes stay behind the reviewer-only get procedure, which
 * will not load them until validation has reached READY.
 */
export async function listInstructionProposals(
	projectId: string,
	organizationId: string,
	options: { limit: number; cursor?: string; proposerUserId?: string },
) {
	const [project, proposals] = await Promise.all([
		db.project.findFirst({
			where: { id: projectId, organizationId },
			select: { publishedInstructionSnapshotId: true },
		}),
		db.projectInstructionSnapshot.findMany({
			where: {
				projectId,
				organizationId,
				proposalStatus: { not: null },
				...(options.proposerUserId
					? { userId: options.proposerUserId }
					: {}),
			},
			orderBy: { version: "desc" },
			cursor: options.cursor ? { id: options.cursor } : undefined,
			skip: options.cursor ? 1 : undefined,
			take: options.limit + 1,
			select: summarySelect,
		}),
	]);
	if (!project) {
		return { items: [], nextCursor: null };
	}
	const hasMore = proposals.length > options.limit;
	const page = hasMore ? proposals.slice(0, options.limit) : proposals;
	const items = page.map((proposal) => ({
		...proposal,
		isStale:
			proposal.proposalStatus === "PENDING" &&
			proposal.baseSnapshotId !== project.publishedInstructionSnapshotId,
	}));
	return {
		items,
		nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
	};
}

/** Tenant-scoped proposal lookup. Returns metadata only, never file bytes. */
export async function getInstructionProposal(
	id: string,
	projectId: string,
	organizationId: string,
) {
	const [project, proposal] = await Promise.all([
		db.project.findFirst({
			where: { id: projectId, organizationId },
			select: { publishedInstructionSnapshotId: true },
		}),
		db.projectInstructionSnapshot.findFirst({
			where: {
				id,
				projectId,
				organizationId,
				proposalStatus: { not: null },
			},
			select: summarySelect,
		}),
	]);
	if (!project || !proposal) {
		return null;
	}
	return {
		...proposal,
		isStale:
			proposal.proposalStatus === "PENDING" &&
			proposal.baseSnapshotId !== project.publishedInstructionSnapshotId,
	};
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
			// Set only on a derived snapshot's inherited rows. The validation
			// gate needs it to rebuild the key such a row legitimately sits
			// at — `snapshotKey(projectId, baseSnapshotId, inheritedFromFileId)`
			// — which cannot be recovered by parsing `storageKey`.
			inheritedFromFileId: true,
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
	const snapshot = await db.projectInstructionSnapshot.findFirst({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: { notIn: VERDICT_STATUSES },
		},
		select: { proposalStatus: true },
	});
	if (!snapshot) {
		return { changed: false };
	}
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
			rejection:
				snapshot.proposalStatus === null
					? Prisma.JsonNull
					: ([
							proposalStagingPendingRejection,
						] as unknown as Prisma.InputJsonValue),
		},
	});
	return { changed: count > 0 };
}

/**
 * Final, row-locked authorization immediately before proposal upload URLs are
 * returned to a caller. A concurrent cancellation/rejection either wins the
 * row lock first and makes this fail, or runs afterwards and must preserve the
 * cleanup marker that reserves capacity through the URL's absolute expiry.
 */
export async function authorizeInstructionProposalUploadUrls(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	createdAfter: Date;
}): Promise<{ authorized: boolean }> {
	return db.$transaction(async (tx) => {
		const rows = await tx.$queryRaw<Array<{ id: string }>>`
			SELECT s."id"
			FROM "project_instruction_snapshot" s
			WHERE s."id" = ${input.snapshotId}
				AND s."projectId" = ${input.projectId}
				AND s."organizationId" = ${input.organizationId}
				AND s."status" = 'RECEIVING'
				AND s."proposalStatus" = 'PENDING'::"ProjectInstructionProposalStatus"
				AND s."createdAt" > ${input.createdAfter}
			FOR UPDATE OF s
		`;
		return { authorized: rows.length === 1 };
	});
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
		const snapshot = await tx.projectInstructionSnapshot.findFirst({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: { notIn: VERDICT_STATUSES },
			},
			select: { proposalStatus: true },
		});
		if (!snapshot) {
			return { changed: false };
		}
		const rejections =
			snapshot.proposalStatus === null
				? input.rejections
				: rejectionsWithProposalCleanupMarker(input.rejections);
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: { notIn: VERDICT_STATUSES },
			},
			data: {
				status: "REJECTED",
				rejection: rejections as unknown as Prisma.InputJsonValue,
			},
		});
		if (count === 0) {
			return { changed: false };
		}
		// A proposal rejected by the integrity/secret gate never becomes
		// reviewable. Close its proposal state in the same transaction as the
		// validation verdict and audit row so it releases its base and cannot
		// sit in the review queue forever.
		await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				proposalStatus: "PENDING",
			},
			data: { proposalStatus: "REJECTED" },
		});
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

export type InstructionProposalDecisionResult =
	| { ok: true; changed: boolean; version: number }
	| {
			ok: false;
			reason:
				| "not_found"
				| "not_ready"
				| "in_progress"
				| "stale"
				| "already_decided";
	  };

/**
 * Approves and publishes one validated proposal in the same transaction.
 *
 * The project row is locked before either decision or pointer mutation. The
 * exact base id is then required in the pointer predicate, so version
 * allocation order is irrelevant: an older-numbered proposal can publish if
 * and only if its exact base is still current, while two proposals from the
 * same base cannot both publish. The decision CAS happens before the pointer
 * write, and any unexpected pointer miss throws so the transaction rolls the
 * APPROVED marker back rather than committing an approved-but-unpublished
 * proposal.
 */
export async function approveInstructionProposal(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	reviewerUserId: string;
	audit: RecordAuditInput;
}): Promise<InstructionProposalDecisionResult> {
	return db.$transaction(async (tx) => {
		const locked = await tx.$queryRaw<Array<{ pointerId: string | null }>>`
			SELECT p."publishedInstructionSnapshotId" AS "pointerId"
			FROM "project" p
			WHERE p."id" = ${input.projectId}
				AND p."organizationId" = ${input.organizationId}
			FOR UPDATE OF p
		`;
		const pointer = locked[0];
		if (!pointer) {
			return { ok: false as const, reason: "not_found" as const };
		}
		const proposal = await tx.projectInstructionSnapshot.findFirst({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				proposalStatus: { not: null },
			},
			select: {
				id: true,
				version: true,
				status: true,
				proposalStatus: true,
				rejection: true,
				baseSnapshotId: true,
			},
		});
		if (!proposal) {
			return { ok: false as const, reason: "not_found" as const };
		}
		if (proposal.proposalStatus === "APPROVED") {
			return {
				ok: true as const,
				changed: false,
				version: proposal.version,
			};
		}
		if (proposal.proposalStatus !== "PENDING") {
			return { ok: false as const, reason: "already_decided" as const };
		}
		if (proposal.status !== "READY") {
			return { ok: false as const, reason: "not_ready" as const };
		}
		if (
			proposal.baseSnapshotId === null ||
			pointer.pointerId !== proposal.baseSnapshotId
		) {
			return { ok: false as const, reason: "stale" as const };
		}

		const reviewedAt = new Date();
		const decided = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: proposal.id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: "READY",
				proposalStatus: "PENDING",
			},
			data: {
				proposalStatus: "APPROVED",
				reviewerUserId: input.reviewerUserId,
				reviewedAt,
				publishedAt: reviewedAt,
			},
		});
		if (decided.count === 0) {
			const current = await tx.projectInstructionSnapshot.findFirst({
				where: {
					id: proposal.id,
					projectId: input.projectId,
					organizationId: input.organizationId,
				},
				select: { proposalStatus: true, status: true },
			});
			if (current?.proposalStatus === "APPROVED") {
				return {
					ok: true as const,
					changed: false,
					version: proposal.version,
				};
			}
			if (
				current?.proposalStatus === "PENDING" &&
				!REJECTABLE_PROPOSAL_STATUSES.includes(current.status)
			) {
				return { ok: false as const, reason: "in_progress" as const };
			}
			return { ok: false as const, reason: "already_decided" as const };
		}

		const moved = await tx.project.updateMany({
			where: {
				id: input.projectId,
				organizationId: input.organizationId,
				publishedInstructionSnapshotId: proposal.baseSnapshotId,
			},
			data: { publishedInstructionSnapshotId: proposal.id },
		});
		if (moved.count !== 1) {
			// The locked pointer made this unreachable unless a database
			// invariant changed. Throwing is load-bearing: returning would commit
			// the APPROVED marker without its publication.
			throw new Error("Instruction proposal publication lost its base");
		}
		await recordAuditTx(tx, input.audit);
		return {
			ok: true as const,
			changed: true,
			version: proposal.version,
		};
	});
}

const REJECTABLE_PROPOSAL_STATUSES: InstructionSnapshotStatus[] = [
	"RECEIVING",
	"FAILED",
	"READY",
];

/**
 * Rejects a stable proposal without touching the published pointer.
 * VALIDATING is intentionally excluded: its activity may still be reading
 * inherited objects, so deciding it would release the base/capacity pin too
 * early. RECEIVING and FAILED become terminal snapshot rows so finalize and
 * retry cannot revive them; validated READY bytes remain READY for history.
 */
export async function rejectInstructionProposal(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	reviewerUserId: string;
	audit: RecordAuditInput;
}): Promise<InstructionProposalDecisionResult> {
	return db.$transaction(async (tx) => {
		const proposal = await tx.projectInstructionSnapshot.findFirst({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				proposalStatus: { not: null },
			},
			select: {
				id: true,
				version: true,
				status: true,
				proposalStatus: true,
				rejection: true,
			},
		});
		if (!proposal) {
			return { ok: false as const, reason: "not_found" as const };
		}
		if (proposal.proposalStatus === "REJECTED") {
			return {
				ok: true as const,
				changed: false,
				version: proposal.version,
			};
		}
		if (proposal.proposalStatus !== "PENDING") {
			return { ok: false as const, reason: "already_decided" as const };
		}
		if (!REJECTABLE_PROPOSAL_STATUSES.includes(proposal.status)) {
			return { ok: false as const, reason: "in_progress" as const };
		}
		const decided = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: proposal.id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: proposal.status,
				proposalStatus: "PENDING",
			},
			data: {
				status: proposal.status === "READY" ? "READY" : "REJECTED",
				proposalStatus: "REJECTED",
				...(proposal.status === "READY"
					? {}
					: {
							rejection: rejectionsWithProposalCleanupMarker(
								proposal.rejection,
							) as unknown as Prisma.InputJsonValue,
						}),
				reviewerUserId: input.reviewerUserId,
				reviewedAt: new Date(),
			},
		});
		if (decided.count === 0) {
			const current = await tx.projectInstructionSnapshot.findFirst({
				where: {
					id: proposal.id,
					projectId: input.projectId,
					organizationId: input.organizationId,
				},
				select: { proposalStatus: true, status: true },
			});
			if (current?.proposalStatus === "REJECTED") {
				return {
					ok: true as const,
					changed: false,
					version: proposal.version,
				};
			}
			if (
				current?.proposalStatus === "PENDING" &&
				!REJECTABLE_PROPOSAL_STATUSES.includes(current.status)
			) {
				return { ok: false as const, reason: "in_progress" as const };
			}
			return { ok: false as const, reason: "already_decided" as const };
		}
		await recordAuditTx(tx, input.audit);
		return {
			ok: true as const,
			changed: true,
			version: proposal.version,
		};
	});
}

/** Owner-only withdrawal with the same stable-state interlock as rejection. */
export async function cancelInstructionProposal(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	proposerUserId: string;
	audit: RecordAuditInput;
}): Promise<InstructionProposalDecisionResult> {
	return db.$transaction(async (tx) => {
		const proposal = await tx.projectInstructionSnapshot.findFirst({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.proposerUserId,
				proposalStatus: { not: null },
			},
			select: {
				id: true,
				version: true,
				status: true,
				proposalStatus: true,
				rejection: true,
			},
		});
		if (!proposal) {
			return { ok: false as const, reason: "not_found" as const };
		}
		if (proposal.proposalStatus === "REJECTED") {
			return {
				ok: true as const,
				changed: false,
				version: proposal.version,
			};
		}
		if (proposal.proposalStatus !== "PENDING") {
			return { ok: false as const, reason: "already_decided" as const };
		}
		if (!REJECTABLE_PROPOSAL_STATUSES.includes(proposal.status)) {
			return { ok: false as const, reason: "in_progress" as const };
		}
		const decided = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: proposal.id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.proposerUserId,
				status: proposal.status,
				proposalStatus: "PENDING",
			},
			data: {
				status: proposal.status === "READY" ? "READY" : "REJECTED",
				proposalStatus: "REJECTED",
				...(proposal.status === "READY"
					? {}
					: {
							rejection: rejectionsWithProposalCleanupMarker(
								proposal.rejection,
							) as unknown as Prisma.InputJsonValue,
						}),
				reviewedAt: new Date(),
			},
		});
		if (decided.count === 0) {
			const current = await tx.projectInstructionSnapshot.findFirst({
				where: {
					id: proposal.id,
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.proposerUserId,
				},
				select: { proposalStatus: true, status: true },
			});
			if (current?.proposalStatus === "REJECTED") {
				return {
					ok: true as const,
					changed: false,
					version: proposal.version,
				};
			}
			if (
				current?.proposalStatus === "PENDING" &&
				!REJECTABLE_PROPOSAL_STATUSES.includes(current.status)
			) {
				return { ok: false as const, reason: "in_progress" as const };
			}
			return { ok: false as const, reason: "already_decided" as const };
		}
		await recordAuditTx(tx, input.audit);
		return {
			ok: true as const,
			changed: true,
			version: proposal.version,
		};
	});
}

type PublishInstructionSnapshotResult =
	| {
			published: true;
			changed: boolean;
			/** Manual publishes only — see `allowRollback` below. */
			version?: number;
			previousVersion?: number | null;
	  }
	| {
			published: false;
			changed: false;
			reason:
				| "not_found"
				| "not_ready"
				| "proposal_not_approved"
				| "older_than_current"
				| "base_moved";
	  };

/**
 * Atomic and safe under concurrent retries. Refuses a snapshot that is not
 * READY. Moves the pointer with a single conditional `updateMany` — never a
 * read-then-write. On the automatic (default) path two concurrent publishes
 * (e.g. a retried Temporal activity racing a newer publish) cannot regress
 * the pointer: the write only matches when the project has no published
 * snapshot yet or its current published version is strictly lower than this
 * one. With `allowRollback` (History's manual publish) the pointer MAY move
 * to an older version on purpose; the automatic path then refuses to re-apply
 * a snapshot that has already published once, so a retry cannot undo the
 * rollback. A retried publish of the snapshot that is *already* the
 * published pointer is idempotent and returns
 * `{ published: true, changed: false }` without writing anything.
 *
 * Every path opens by taking the PROJECT ROW's write lock (`SELECT … FOR
 * UPDATE OF p`) and reads the current pointer from that locked state. The
 * conditional write locks the same row regardless; acquiring it first is what
 * makes the reads around the write — the already-published marker, the
 * previous version reported to the audit log, the idempotency answer — refer
 * to the same moment as the write itself, rather than to a `READ COMMITTED`
 * snapshot taken before anyone else's commit.
 *
 * `changed` reports whether THIS call moved the pointer, and it is derived
 * from the conditional write's own row count rather than from a read before
 * and after — a read-then-compare would answer a question about a moment
 * that has already passed, and two concurrent publishes would both see the
 * pointer move and both claim it. `count === 1` is true for exactly one
 * caller, which is what lets the publish activity emit one audit row per
 * real publication and none for an idempotent Temporal retry.
 *
 * `requireBaseUnmoved` makes the write a FAST-FORWARD for a derived
 * snapshot: the project's published pointer must still be the exact snapshot
 * this one was edited from. The version rule alone is not enough for an
 * edit, because an edit is not a whole tree — it is a base plus a change
 * set, and its unchanged files are the base's. Two people editing the same
 * published v7 get v8 and v9; under the version rule both publish in turn
 * and v9, which never saw the first edit, silently reverts it. Requiring the
 * base in the same UPDATE makes the second publication match nothing.
 *
 * Both halves are read from the SNAPSHOT ROW, not from the caller, so a
 * Temporal retry cannot hand in a different base and the publish activity
 * needs no new workflow input.
 *
 * WHETHER a row is derived is decided by `baseVersion`, never by
 * `baseSnapshotId`. That column is `ON DELETE SET NULL`, and a READY derived
 * snapshot does not pin its base (it no longer reads the base's objects), so
 * the base can be deleted or pruned in the window between READY and the
 * publish activity. Keying on the id there meant a derived snapshot whose
 * base had just been removed read itself as a full upload and published on
 * the version rule — reverting the edit that had taken the pointer in the
 * meantime, with nothing in the tab to say so. `baseVersion` is written once
 * at derive time and no lifecycle clears it.
 *
 * So a derived snapshot whose `baseSnapshotId` is null cannot publish
 * automatically at all: the base is gone, so it certainly is not the
 * published pointer, and there is no predicate that could make the write
 * safe. It stays READY and unpublished like any other refused fast-forward —
 * intact, still in History, where "Publish this version" is the deliberate
 * act that overrides this rule by design.
 *
 * Non-derived snapshots keep the version rule under this flag: a full upload
 * IS the whole tree, so replacing a newer pointer loses nothing that was not
 * being replaced anyway.
 *
 * An AUTOMATIC publication is applied AT MOST ONCE per snapshot, whichever
 * predicate it would use. `publishedAt` is the marker: nothing clears it, so a
 * non-null value says this snapshot has held the pointer already, and the
 * automatic path then returns `{ published: true, changed: false }` and writes
 * nothing. Otherwise an ordinary lost-ack retry undid a deliberate rollback —
 * v9 publishes automatically, someone rolls back to v7, the retry sees 7 < 9
 * (or, when derived, sees its exact base published again) and republishes v9,
 * with a second automatic audit row for one publication. A retry that lands
 * after some OTHER version was published automatically now takes the same
 * idempotent arm instead of the `older_than_current` refusal it used to get:
 * both mean "this activity has nothing left to do", and the activity audits on
 * `changed` either way.
 *
 * `allowRollback` is the opposite instruction, and the one the History
 * button sends: the write matches any project whose pointer is not already
 * this snapshot, so an OLDER version can take the pointer back. The version
 * rule it replaces is a RACE GUARD, not a policy — it exists so that a slow
 * automatic publish-on-ready cannot silently regress the pointer behind
 * someone's back — and it was refusing the one act it was never meant to
 * refuse: a person opening History, seeing what is published, and choosing an
 * earlier version deliberately. The automatic path is untouched: it passes
 * `requireBaseUnmoved` or nothing, and `older_than_current` remains its
 * refusal.
 *
 * Two concurrent MANUAL publishes of different versions are last-write-wins
 * — neither predicate excludes the other — which is the right answer for an
 * explicit human act: both people chose a version knowing what was published,
 * and History still holds every version either of them could want back. What
 * the guard protects against is an automatic write nobody asked for, and that
 * write never carries this flag. They are serialized by the row lock, so each
 * reports the pointer it actually replaced rather than the one it first saw;
 * two such publishes are two real transitions, not one counted twice. The
 * marker above is also ignored here, because republishing a version that was
 * published before is precisely what History is for.
 *
 * `allowRollback` and `requireBaseUnmoved` are mutually exclusive by
 * construction — the Temporal activity passes one, the oRPC procedure the
 * other — and passing both throws rather than silently letting one win.
 *
 * Under `allowRollback` only, the published result also carries `version` and
 * `previousVersion` (null when nothing was published before), taken from the
 * locked pointer read, so the procedure's audit row names the transition that
 * actually happened. Those values are for REPORTING alone and never enter a
 * predicate.
 */
export async function publishInstructionSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	requireBaseUnmoved?: boolean;
	allowRollback?: boolean;
}): Promise<PublishInstructionSnapshotResult> {
	if (input.requireBaseUnmoved === true && input.allowRollback === true) {
		// A programming error, not a runtime condition: one asks the write to
		// refuse anything but a fast-forward and the other asks it to accept
		// anything at all. Failing here beats picking a winner, which would
		// make an automatic publish silently able to roll the pointer back.
		throw new Error(
			"publishInstructionSnapshot: requireBaseUnmoved and allowRollback are mutually exclusive",
		);
	}
	return db.$transaction(async (tx) => {
		// FIRST, and on every path: take the project row's write lock, and
		// read the pointer from the locked state. Everything below — the
		// already-published marker, the previous version the audit row
		// reports, the idempotency answer — is a statement about the pointer,
		// and under `READ COMMITTED` a read taken BEFORE the lock describes a
		// moment that may already be gone. The conditional `updateMany` locks
		// this same row anyway; acquiring it here only moves the acquisition
		// earlier, so the whole transition is serialized rather than just its
		// write.
		//
		// `FOR UPDATE OF p`, not a bare `FOR UPDATE`: Postgres refuses to lock
		// the nullable side of an outer join, and the join is what turns the
		// pointer id into the version number in one round trip.
		const locked = await tx.$queryRaw<
			Array<{ pointerId: string | null; pointerVersion: number | null }>
		>`
			SELECT p."publishedInstructionSnapshotId" AS "pointerId",
				s."version" AS "pointerVersion"
			FROM "project" p
			LEFT JOIN "project_instruction_snapshot" s
				ON s."id" = p."publishedInstructionSnapshotId"
			WHERE p."id" = ${input.projectId}
				AND p."organizationId" = ${input.organizationId}
			FOR UPDATE OF p
		`;
		const pointer = locked[0];
		if (pointer === undefined) {
			// No project row for this id in this organization. Reported as
			// `not_found` like a missing snapshot: from the caller's side the
			// thing it named is not there, and saying more would describe a
			// row it is not entitled to see.
			return {
				published: false as const,
				changed: false as const,
				reason: "not_found" as const,
			};
		}
		const snapshot = await tx.projectInstructionSnapshot.findFirst({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			select: {
				id: true,
				status: true,
				proposalStatus: true,
				version: true,
				baseSnapshotId: true,
				baseVersion: true,
				publishedAt: true,
			},
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
		// A proposal has exactly one publication entrance: the approval
		// transaction above. Pending proposals must never auto-publish, and a
		// reviewer rejection must never be bypassed from History. An approved
		// proposal remains a legitimate historical snapshot and may be chosen
		// again by the manual rollback path.
		if (
			snapshot.proposalStatus === "PENDING" ||
			snapshot.proposalStatus === "REJECTED"
		) {
			return {
				published: false as const,
				changed: false as const,
				reason: "proposal_not_approved" as const,
			};
		}
		// An AUTOMATIC publication is applied AT MOST ONCE per snapshot, and
		// `publishedAt` is the durable record that it already was. Nothing in
		// the lifecycle ever clears that column — the only write to it is the
		// stamp below — so a non-null value means this snapshot has held the
		// pointer at some point, and whatever holds it now took it afterwards.
		//
		// Without this, an ordinary at-least-once retry silently undid a
		// rollback: the automatic publication of v9 commits, its completion
		// ack is lost, someone rolls the project back to v7, and the retry
		// finds 7 < 9 and republishes v9 — or, for a derived v9, finds its
		// exact base published again and fast-forwards onto it. The rollback
		// looked like it worked and then evaporated, with a second automatic
		// audit row to show for it.
		//
		// Answered as the idempotent case rather than as a refusal, because
		// that is what it is: this activity's publication happened. The manual
		// path ignores the marker entirely — republishing a version that was
		// published before is the whole point of History.
		if (input.allowRollback !== true && snapshot.publishedAt !== null) {
			return { published: true as const, changed: false as const };
		}
		// One predicate or the other, never both, and always inside the
		// single conditional write. The pointer read above informs the
		// REPORTING; it never becomes the decision, which stays in the
		// UPDATE's own WHERE clause where the row count can prove it.
		//
		// `baseVersion` decides this, not `baseSnapshotId`: see the doc
		// comment. A derived row whose base has since been deleted or pruned
		// takes the third arm, which writes nothing at all rather than
		// falling back to a version rule that does not hold for an edit.
		const derived =
			input.requireBaseUnmoved === true &&
			typeof snapshot.baseVersion === "number";
		const base =
			typeof snapshot.baseSnapshotId === "string"
				? snapshot.baseSnapshotId
				: null;
		const fastForward = derived && base !== null;
		const baseGone = derived && base === null;
		const rollback = input.allowRollback === true;
		// The version this publication replaces, for the audit row the manual
		// procedure writes. Taken from the LOCKED pointer read above, so it
		// names the transition that is actually about to happen: an unlocked
		// pre-read let two concurrent manual publishes both report the version
		// they saw first, which mislabelled the loser's move (from v7, targets
		// v9 and v8 both reported `previousVersion: 7`, so the v8 row claimed
		// `7 → 8, rollback: false` when its real move was `9 → 8`). The value
		// exists to be authoritative in the audit log, so an approximation is
		// worse than useless there.
		const previousVersion = rollback
			? (pointer.pointerVersion ?? null)
			: null;
		const moved = rollback
			? { version: snapshot.version, previousVersion }
			: {};
		// The version arm is the automatic path's race guard. The rollback arm
		// replaces it with the only condition a deliberate publish actually
		// needs — that this snapshot is not already the pointer — so the write
		// stays a single conditional UPDATE and an idempotent repeat still
		// matches nothing and still reports `changed: false`. The null arm is
		// load-bearing in both: `{ not: id }` does not match a NULL column.
		const openPredicate = rollback
			? {
					OR: [
						{ publishedInstructionSnapshotId: null },
						{
							publishedInstructionSnapshotId: {
								not: snapshot.id,
							},
						},
					],
				}
			: {
					OR: [
						{ publishedInstructionSnapshotId: null },
						{
							publishedInstructionSnapshot: {
								version: { lt: snapshot.version },
							},
						},
					],
				};
		const { count } = baseGone
			? { count: 0 }
			: await tx.project.updateMany({
					where: {
						id: input.projectId,
						organizationId: input.organizationId,
						...(fastForward
							? { publishedInstructionSnapshotId: base }
							: openPredicate),
					},
					data: { publishedInstructionSnapshotId: snapshot.id },
				});
		if (count === 1) {
			await tx.projectInstructionSnapshot.update({
				where: { id: snapshot.id },
				data: { publishedAt: new Date() },
			});
			return {
				published: true as const,
				changed: true as const,
				...moved,
			};
		}
		// The conditional write matched nothing — or was never made, for a
		// derived row whose base is gone. Either this snapshot is already the
		// published pointer (idempotent retry — not an error), or something
		// else has the pointer (a real conflict). The idempotent arm is
		// checked first and is what keeps a retried Temporal activity quiet
		// under every predicate: once this snapshot is the pointer, the
		// fast-forward's own condition is necessarily false, and the
		// base-is-gone arm has to answer the same way a completed publish
		// does rather than reporting a conflict against itself.
		//
		// Answered from the LOCKED pointer rather than a second read: the row
		// has been write-locked since the top of this transaction, so the
		// value read there is still the value now, and a re-read could only
		// reintroduce a window that no longer exists.
		if (pointer.pointerId === snapshot.id) {
			return {
				published: true as const,
				changed: false as const,
				...moved,
			};
		}
		return {
			published: false as const,
			changed: false as const,
			// Distinguishable on purpose: `base_moved` means the edit is
			// intact but was written against a version that is no longer
			// published — whether someone else's version took the pointer or
			// the base is gone entirely — which is a different thing to tell
			// someone than a stale full upload losing a pointer race.
			//
			// Under `allowRollback` this is unreachable, and reported as the
			// version rule's refusal because that is the fail-closed answer
			// rather than because it can happen: the project row is locked and
			// matched (or the lock read returned `not_found` above), the only
			// pointer the predicate excludes is this snapshot itself, and that
			// case returned `changed: false` just above. The manual procedure
			// still maps it, to a message that does not claim a newer version
			// won.
			reason: derived
				? ("base_moved" as const)
				: ("older_than_current" as const),
		};
	});
}

// ---------------------------------------------------------------------------
// Prune / delete
// ---------------------------------------------------------------------------

/**
 * The statuses in which a DERIVED snapshot still reads its base's objects.
 *
 * A derived snapshot inherits unchanged files by pointing its rows at the
 * base's immutable promoted keys, and those pointers only stop mattering when
 * `finalizeInstructionSnapshot` has re-hashed and re-written every one of them
 * under the derived snapshot's own prefix. Until then, deleting or pruning the
 * base removes the bytes an in-flight validation is about to read — the gate
 * would report every inherited path as `missing` and reject an edit that was
 * perfectly good.
 *
 * FAILED belongs here even though it is a terminal-looking status, because it
 * is the one terminal status that is RETRYABLE: `finalizeInstructionSnapshot`
 * moves FAILED back to VALIDATING for another attempt, and that attempt reads
 * exactly the same inherited keys. If the base were released the moment a
 * derived child failed, "Try again" would come back with every inherited path
 * reported as `missing` — the failure would be permanent and unexplainable. A
 * FAILED child releases its base by being deleted or pruned itself, which is
 * the same act that gives up on the retry.
 *
 * READY and REJECTED are absent on purpose. READY no longer depends on the
 * base at all — promotion rewrote every inherited row under its own prefix —
 * and REJECTED is the one terminal status the pipeline never reopens.
 */
const DERIVING_STATUSES: InstructionSnapshotStatus[] = [
	"RECEIVING",
	"VALIDATING",
	"FAILED",
];

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
 *  - the newest `keep.rejected` REJECTED/FAILED snapshots, by version; PLUS
 *  - any snapshot an in-flight DERIVED snapshot is still reading.
 *
 * Everything else is prunable.
 *
 * The fourth clause is the derived-snapshot interlock (`DERIVING_STATUSES`).
 * An edit made in the tab creates a snapshot whose unchanged files are
 * inherited by POINTING at this one's promoted objects, so pruning it while
 * that edit is still RECEIVING or VALIDATING deletes the bytes the gate is
 * about to read — and the edit is rejected for files that were never wrong.
 * It is a short exclusion, not a permanent one: the derived snapshot owns its
 * own copies the moment it is READY, and `pruneInstructionSnapshots` runs
 * again at the end of every successful validation.
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
				// The derived-snapshot interlock, in the WHERE alongside
				// `publishedFor: null` and ahead of `skip` for the same
				// reason: a base that must be kept has to be outside the
				// window entirely, not filtered out of its result, or it
				// occupies a retention slot and the candidate query below
				// nominates the project for work this one cannot do.
				derivedSnapshots: {
					none: { status: { in: DERIVING_STATUSES } },
				},
				AND: [
					{
						OR: [
							{ proposalStatus: null },
							{
								proposalStatus: {
									in: ["APPROVED", "REJECTED"],
								},
							},
						],
					},
					{
						derivedSnapshots: {
							none: { proposalStatus: "PENDING" },
						},
					},
					{ NOT: pendingCleanupFilter() },
					{
						derivedSnapshots: {
							none: pendingCleanupFilter(),
						},
					},
				],
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
				AND: [
					{
						OR: [
							{ proposalStatus: null },
							{
								proposalStatus: {
									in: ["APPROVED", "REJECTED"],
								},
							},
						],
					},
					{
						derivedSnapshots: {
							none: { proposalStatus: "PENDING" },
						},
					},
					{ NOT: pendingCleanupFilter() },
					{
						derivedSnapshots: {
							none: pendingCleanupFilter(),
						},
					},
				],
				// Fail-closed on this window too. A REJECTED/FAILED snapshot
				// is never a legitimate base — `createDerivedInstructionSnapshot`
				// refuses anything but READY — so this matches everything
				// today; it is here so the two windows cannot drift apart if
				// that ever changes.
				derivedSnapshots: {
					none: { status: { in: DERIVING_STATUSES } },
				},
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
				AND s."proposalStatus" IS DISTINCT FROM 'PENDING'::"ProjectInstructionProposalStatus"
				AND NOT COALESCE(s."rejection" @> '[{"path":"(proposal staging)","reason":"abandoned","detail":"staging pending"}]'::jsonb, FALSE)
				AND NOT EXISTS (
					SELECT 1 FROM "project_instruction_snapshot" d
					WHERE d."baseSnapshotId" = s."id"
						AND d."status" IN ('RECEIVING', 'VALIDATING', 'FAILED')
				)
				AND NOT EXISTS (
					SELECT 1 FROM "project_instruction_snapshot" d
					WHERE d."baseSnapshotId" = s."id"
						AND d."proposalStatus" = 'PENDING'::"ProjectInstructionProposalStatus"
				)
				AND NOT EXISTS (
					SELECT 1 FROM "project_instruction_snapshot" d
					WHERE d."baseSnapshotId" = s."id"
						AND d."rejection" @> '[{"path":"(proposal staging)","reason":"abandoned","detail":"staging pending"}]'::jsonb
				)
			GROUP BY s."projectId", s."organizationId"
			HAVING count(*) > ${keep.ready}
			UNION
			SELECT s."projectId", s."organizationId"
			FROM "project_instruction_snapshot" s
			LEFT JOIN "project" p
				ON p."publishedInstructionSnapshotId" = s."id"
			WHERE s."status" IN ('REJECTED', 'FAILED') AND p."id" IS NULL
				AND s."proposalStatus" IS DISTINCT FROM 'PENDING'::"ProjectInstructionProposalStatus"
				AND NOT COALESCE(s."rejection" @> '[{"path":"(proposal staging)","reason":"abandoned","detail":"staging pending"}]'::jsonb, FALSE)
				AND NOT EXISTS (
					SELECT 1 FROM "project_instruction_snapshot" d
					WHERE d."baseSnapshotId" = s."id"
						AND d."status" IN ('RECEIVING', 'VALIDATING', 'FAILED')
				)
				AND NOT EXISTS (
					SELECT 1 FROM "project_instruction_snapshot" d
					WHERE d."baseSnapshotId" = s."id"
						AND d."proposalStatus" = 'PENDING'::"ProjectInstructionProposalStatus"
				)
				AND NOT EXISTS (
					SELECT 1 FROM "project_instruction_snapshot" d
					WHERE d."baseSnapshotId" = s."id"
						AND d."rejection" @> '[{"path":"(proposal staging)","reason":"abandoned","detail":"staging pending"}]'::jsonb
				)
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
	/**
	 * Reject only a row created before this moment. The REAPER passes it
	 * because its candidate list is a read that has already gone stale: a row
	 * that became RECEIVING after that read must not be closed out by a sweep
	 * that never looked at it.
	 *
	 * A caller compensating for a row it created itself, in the same request,
	 * OMITS it. Age is not the question there — the row is seconds old by
	 * construction — and any cutoff it could pass would be a lie in one
	 * direction or the other. `status: "RECEIVING"` is the whole guard that
	 * path needs, and it is the same guard: a `finalize` that has already
	 * moved the row on still wins.
	 */
	cutoff?: Date;
	/**
	 * `metadata.source` on the audit row — what TRIGGERED the close-out, not
	 * whose upload it was. Defaults to the reaper, which is what wrote every
	 * one of these rows before inline submission existed.
	 */
	source?: string;
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
				...(input.cutoff ? { createdAt: { lt: input.cutoff } } : {}),
			},
			data: {
				status: "REJECTED",
				rejection: rejections as unknown as Prisma.InputJsonValue,
			},
		});
		if (count === 0) {
			return { changed: false };
		}
		await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				proposalStatus: "PENDING",
			},
			data: { proposalStatus: "REJECTED" },
		});
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
				source: input.source ?? "abandoned_receiving_reaper",
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
/**
 * Terminal proposal/abandonment rows whose staging prefix has not been swept
 * clean yet, oldest first. READY proposals are included because their old
 * signed PUTs remain usable until the immutable signing lease expires even
 * after approval, rejection, or cancellation.
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
 * Deleting under such a row's prefix races nothing: rows are selected only
 * after the absolute signing lease, and READY/REJECTED cannot move back to a
 * state that consumes staging bytes.
 *
 * SYSTEM-WIDE with no tenant in scope, like the other sweep queries, and it
 * returns each row's own `projectId`/`organizationId` so the prefix the
 * caller builds is the one that row names.
 */
export async function listPendingAbandonedInstructionSnapshots(
	limit: number,
	excludeIds: string[],
	createdBefore: Date,
): Promise<Array<{ id: string; projectId: string; organizationId: string }>> {
	return db.projectInstructionSnapshot.findMany({
		where: {
			status: { in: ["READY", "REJECTED"] },
			createdAt: { lt: createdBefore },
			...pendingCleanupFilter(),
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
	return db.$transaction(async (tx) => {
		const snapshot = await tx.projectInstructionSnapshot.findFirst({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: { in: ["READY", "REJECTED"] },
				...pendingCleanupFilter(),
			},
			select: { rejection: true },
		});
		if (!snapshot || !Array.isArray(snapshot.rejection)) {
			return { changed: false };
		}
		const rejections = (
			snapshot.rejection as unknown as InstructionRejection[]
		).map((rejection) =>
			rejection.reason === "abandoned" &&
			rejection.detail === ABANDONED_STAGING_PENDING
				? { ...rejection, detail: ABANDONED_STAGING_CLEARED }
				: rejection,
		);
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: { in: ["READY", "REJECTED"] },
				rejection: {
					equals: snapshot.rejection as Prisma.InputJsonValue,
				},
			},
			data: {
				rejection: rejections as unknown as Prisma.InputJsonValue,
			},
		});
		return { changed: count > 0 };
	});
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
			status: { in: ["READY", "REJECTED"] },
			...pendingCleanupFilter(),
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
 * How many snapshots are currently DERIVING from this one — the friendly
 * pre-check for the delete procedure, which wants to say "an edit of this
 * version is still being checked" rather than the generic conflict.
 *
 * Tenant-scoped on both columns. It is a read, so it is a read-then-delete
 * check like the published-pointer one beside it; the authority is the
 * predicate inside `deleteInstructionSnapshot`'s own DELETE.
 */
export async function countInFlightDerivedSnapshots(
	baseSnapshotId: string,
	projectId: string,
	organizationId: string,
): Promise<number> {
	return db.projectInstructionSnapshot.count({
		where: {
			baseSnapshotId,
			projectId,
			organizationId,
			OR: [
				{ status: { in: DERIVING_STATUSES } },
				{ proposalStatus: "PENDING" },
				pendingCleanupFilter(),
			],
		},
	});
}

/**
 * Thrown inside `deleteInstructionSnapshot`'s transaction to ROLL BACK the
 * file deletion when the snapshot row itself turns out not to be deletable.
 *
 * Returning normally there would commit the file delete of a snapshot that
 * survived, which is worse than either outcome it is reporting.
 */
class InstructionSnapshotNotDeleted extends Error {
	constructor(readonly snapshotReason?: "active" | "base_in_flight") {
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
): Promise<{
	deleted: boolean;
	reason?: "published" | "active" | "base_in_flight";
}> {
	try {
		return await db.$transaction(async (tx) => {
			// LOCK ORDER: project, then snapshot — the same order
			// `allocateAndCreateDerivedSnapshot` takes, and the reason this
			// statement is here rather than a line of the prune activity.
			//
			// Without it the two paths lock in opposite orders. A derivation
			// that claims the published pointer locks the project row and
			// then inserts a child row, which takes a key-share lock on the
			// base snapshot. This transaction did the reverse: it deleted the
			// snapshot row first, and `Project.publishedInstructionSnapshot`
			// being `onDelete: Restrict` then made PostgreSQL check — and
			// lock — the project row to decide whether the delete is allowed.
			// If a snapshot selected for pruning becomes the published one in
			// between, the two transactions can wait on each other, and the
			// derive's retry loop only understands version collisions, so the
			// deadlock surfaces as a failed save rather than a retry.
			//
			// Taking the lock here costs one statement on a path that is
			// already writing, and it makes the ordering the same everywhere:
			// project first, always.
			await tx.$queryRaw`
				SELECT p."id"
				FROM "project" p
				WHERE p."id" = ${projectId}
					AND p."organizationId" = ${organizationId}
				FOR UPDATE OF p
			`;
			await tx.projectInstructionFile.deleteMany({
				where: { snapshotId: id, projectId, organizationId },
			});
			const { count } = await tx.projectInstructionSnapshot.deleteMany({
				where: {
					id,
					projectId,
					organizationId,
					status: { in: DELETABLE_STATUSES },
					// A snapshot that something is still DERIVING from cannot
					// go: the derived snapshot's inherited rows point at THIS
					// snapshot's promoted objects until its own promotion
					// rewrites them, and the storage delete that follows this
					// transaction would take those objects with it. In the
					// DELETE's own predicate, not in a read above it, for the
					// same reason the status check is: a derivation that
					// starts between a caller's check and this statement must
					// still be refused.
					derivedSnapshots: {
						none: { status: { in: DERIVING_STATUSES } },
					},
					AND: [
						{
							OR: [
								{ proposalStatus: null },
								{
									proposalStatus: {
										in: ["APPROVED", "REJECTED"],
									},
								},
							],
						},
						{
							derivedSnapshots: {
								none: { proposalStatus: "PENDING" },
							},
						},
						{ NOT: pendingCleanupFilter() },
						{
							derivedSnapshots: {
								none: pendingCleanupFilter(),
							},
						},
					],
				},
			});
			if (count === 0) {
				// Three different answers hide behind zero rows — no such
				// snapshot in this tenant, one whose workflow is still
				// running, or one an in-flight edit is deriving from — and
				// only a read can tell them apart. Throw in every case: the
				// file deletion above must not commit for a snapshot row that
				// is still there.
				const surviving = await tx.projectInstructionSnapshot.findFirst(
					{
						where: { id, projectId, organizationId },
						select: { id: true, status: true },
					},
				);
				if (!surviving) {
					throw new InstructionSnapshotNotDeleted();
				}
				const deriving = DELETABLE_STATUSES.includes(surviving.status)
					? await tx.projectInstructionSnapshot.count({
							where: {
								baseSnapshotId: id,
								projectId,
								organizationId,
								OR: [
									{ status: { in: DERIVING_STATUSES } },
									{ proposalStatus: "PENDING" },
									pendingCleanupFilter(),
								],
							},
						})
					: 0;
				throw new InstructionSnapshotNotDeleted(
					deriving > 0 ? "base_in_flight" : "active",
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
