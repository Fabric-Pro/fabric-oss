/**
 * The member proposal branch append (Fizzy #2738 spec §6.3, §6.4 steps
 * 1-10, the no-op guard, Decisions 5-8 and 12): one claimed proposal becomes
 * one commit on its member's branch, or a definitive no-op, or a BLOCKED
 * proposal naming why.
 *
 * Order of evidence. Every outcome write goes through `recordOperationOutcome`
 * (the reducer runs in the same transaction), so a restart after a lease
 * refusal and the all-no-op finalization always read reconciled lifecycle.
 * The per-file rule is history-based: a file a commit outside Fabric's
 * established journal touched since the branch's start is never overwritten,
 * whatever its content (Review Focus 2).
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { createHash } from "node:crypto";
import {
	acceptsAppends,
	type BranchOperationEntryRecord,
	type BranchOperationRow,
	type BranchProposalRow,
	type BranchWithClock,
	finalizeBranchNoOp,
	getBranchProposal,
	getProposalBranch,
	listBranchOperations,
	listInstructionFiles,
	listMemberBranchWrites,
	type MemberBranchWrite,
	markForeignTip,
	recordBranchObservation,
	recordBranchOperation,
	recordOperationOutcome,
	refuseCurrentRef,
	releaseBranchClaim,
} from "@repo/database";
import {
	type BranchDestination,
	branchOperationEntrySchema,
	type PullRequestContextV2,
	type TreeEntry,
	validateRelativePath,
} from "@repo/instructions";
import { memberBranchRef } from "@repo/instructions/proposal-branch-ref";
import { getStorageProvider } from "@repo/storage";
import { safeHeartbeat } from "./activity-liveness";
import {
	type BranchCredential,
	destinationOf,
	withBranchRepoCredential,
} from "./instruction-branch-credential";
import {
	fetchBranchHead,
	initBranchWorkspace,
	isAncestor,
	pushFastForward,
	readTreeEntries,
} from "./instruction-branch-git";
import { reobserveAgainstTip } from "./instruction-branch-recovery";
import {
	assertBranchCreationAllowed,
	contextOf,
	ensureCommit,
	establishedShas,
	hashBlob,
	observationOf,
	pathParams,
	pathUntouchedSince,
	provenanceOf,
	sameEntry,
} from "./instruction-branch-support";
import type { AppendOutcome } from "./instruction-branch-types";
import {
	assertMayContinue,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import {
	buildBranchCommit,
	computeEffectiveDelta,
	type EffectiveDelta,
	type FileRow,
	findTreeConflicts,
} from "./instruction-proposal-commit";
import { gitCall, providerCall } from "./instruction-proposal-operation";
import { INSTRUCTIONS_BUCKET } from "./instruction-prune";
import {
	listTreeRaw,
	MAX_INVENTORY_ENTRIES,
	pushCreateOnly,
	type RawTreeEntry,
} from "./instruction-sync-git";

/** Spec §6.4 step 9: a stale lease restarts at step 1 up to 3 times, then BRANCH_MOVED. */
const MAX_LEASE_REFUSALS = 3;
/**
 * Every restart is bounded: 3 lease refusals, 5 refused names
 * (`refuseCurrentRef` answers `exhausted` itself) and a re-observation that
 * established a head. Past this the append records UNEXPECTED rather than
 * loop.
 */
const MAX_PASSES = 16;

/** The naming `refuseCurrentRef` reserves the next candidate with. */
const NAMING = { memberBranchRef };

const APPEND = "append" as const;

const fail = (
	code: ProposalStepFailure["code"],
	retryable: boolean,
	params?: Record<string, string | number | boolean>,
) => new ProposalStepFailure({ code, phase: APPEND, retryable, params });

const sha256Hex = (bytes: Buffer): string =>
	createHash("sha256").update(bytes).digest("hex");

/** The key a Fabric path and a repository path share (as `computeEffectiveDelta`'s). */
function pathKey(relative: string): string {
	const v = validateRelativePath(relative);
	return (v.ok ? v.path : relative).normalize("NFC");
}

function relativeTo(rootPath: string, repoPath: string): string | null {
	if (rootPath === "") {
		return repoPath;
	}
	return repoPath.startsWith(`${rootPath}/`)
		? repoPath.slice(rootPath.length + 1)
		: null;
}

const joinRoot = (rootPath: string, rel: string) =>
	rootPath === "" ? rel : `${rootPath}/${rel}`;

/** A new path is `100755` only when its row recorded 0755 (spec §6.4 step 2). */
function addedMode(row: FileRow): "100644" | "100755" {
	return row.mode != null && (row.mode & 0o7777) === 0o755
		? "100755"
		: "100644";
}

const isRegularBlob = (e: TreeEntry | null | undefined): e is TreeEntry =>
	!!e && e.type === "blob" && (e.mode === "100644" || e.mode === "100755");

/**
 * One intent path (spec §6.4 step 2): the proposal's own entry, or null for a
 * deletion. Exported with `intentsOf` and `hashIntentBlobs` for the direct
 * commit (Fizzy #2878 §10), which turns a snapshot's rows into the same
 * entries against the synced branch's tip.
 */
export type Intent = {
	/** Relative to the root, as the proposal stores it. */
	path: string;
	/** The repository path. */
	rawPath: string;
	row: FileRow;
	kind: "added" | "modified" | "deleted";
	after: TreeEntry | null;
	afterSha256: string | null;
};

export type Blob = { oid: string; sha256: string };

/** The claim this append runs under. */
export type AppendInput = {
	branchId: string;
	organizationId: string;
	snapshotId: string;
	proposalAttempt: number;
	branchAttempt: number;
	signal: AbortSignal;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `appendBranchProposal`'s body (spec §6.4). Throws `ProposalStepFailure`
 * for the activity to record as the proposal's BLOCKED failure at the
 * claimed attempt; returns every other outcome itself.
 */
export async function runBranchAppend(i: AppendInput): Promise<AppendOutcome> {
	const ids = { branchId: i.branchId, organizationId: i.organizationId };
	const [branch, proposal, ops] = await Promise.all([
		getProposalBranch(ids),
		getBranchProposal({
			snapshotId: i.snapshotId,
			organizationId: i.organizationId,
		}),
		listBranchOperations(ids),
	]);
	if (
		!branch ||
		!proposal ||
		!claimHolds(proposal, i) ||
		branch.attempt !== i.branchAttempt ||
		!acceptsAppends(branch)
	) {
		return "stopped";
	}
	// Spec §6 loop item 1: dependent work never runs on an uncertain push.
	if (ops.some((op) => op.outcome === null)) {
		return "retry_later";
	}
	const context = contextOf(proposal.pullRequestContext, APPEND);
	const destination = destinationOf(branch, APPEND);
	assertProposalReady(proposal);
	await assertBranchCreationAllowed({ branch, destination, phase: APPEND });
	return withBranchRepoCredential(
		{ branch, phase: APPEND, signal: i.signal },
		(credential) =>
			appendUnder(i, credential, {
				branch,
				proposal,
				context,
				destination,
			}),
	);
}

function claimHolds(
	p: Pick<
		BranchProposalRow,
		"proposalBranchId" | "pullRequestState" | "pullRequestAttempt"
	>,
	i: Pick<AppendInput, "branchId" | "proposalAttempt">,
): boolean {
	return (
		p.proposalBranchId === i.branchId &&
		p.pullRequestState === "OPENING" &&
		p.pullRequestAttempt === i.proposalAttempt
	);
}

/** The proposal side of #2563 §6.1 step 4: still a READY, PENDING repository proposal. */
function assertProposalReady(p: BranchProposalRow): void {
	if (
		p.proposalDestination !== "REPOSITORY" ||
		p.status !== "READY" ||
		p.proposalStatus !== "PENDING"
	) {
		throw fail("CONFIGURATION_CHANGED", false);
	}
}

type Loaded = {
	branch: BranchWithClock;
	proposal: BranchProposalRow;
	context: PullRequestContextV2;
	destination: BranchDestination;
};

async function appendUnder(
	i: AppendInput,
	credential: BranchCredential,
	loaded: Loaded,
): Promise<AppendOutcome> {
	const { proposal, context, destination } = loaded;
	const { env, signal } = credential;
	const dir = credential.workDir;
	const ids = { branchId: i.branchId, organizationId: i.organizationId };

	await gitCall(APPEND, credential, () =>
		initBranchWorkspace({
			url: credential.url,
			targetRef: destination.targetRef,
			dir,
			env,
			signal,
		}),
	);
	safeHeartbeat();

	// Spec §6.3 receipt check: a pull request that is no longer open is
	// observed, and the claim is released back to QUEUED.
	const receipt = loaded.branch.pullRequestExternalId;
	if (receipt !== null) {
		const pr = await providerCall(APPEND, credential, () =>
			credential.adapter.get({
				...credential.target,
				externalId: receipt,
			}),
		);
		if (pr.state !== "OPEN") {
			const r = await recordBranchObservation({
				...ids,
				observation: observationOf(pr),
				release: {
					snapshotId: i.snapshotId,
					proposalAttempt: i.proposalAttempt,
				},
			});
			return r.released ? "released" : "stopped";
		}
	}

	// Spec §6.4 step 2: the intent, computed once; its blobs hashed from the
	// stored bytes, the sha256 re-checked.
	const [baseRows, proposalRows] = await Promise.all([
		proposal.baseSnapshotId
			? listInstructionFiles(proposal.baseSnapshotId, i.organizationId)
			: Promise.resolve([]),
		listInstructionFiles(proposal.id, i.organizationId),
	]);
	const delta = computeEffectiveDelta(
		baseRows.map(toFileRow),
		proposalRows.map(toFileRow),
	);
	const blobs = await hashIntentBlobs(credential, delta);
	await gitCall(APPEND, credential, () =>
		ensureCommit({ dir, sha: context.baseCommitSha, env, signal }),
	);

	let leaseRefusals = 0;
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		safeHeartbeat();
		assertMayContinue(signal);
		const pass_ = await appendPass(i, credential, loaded, delta, blobs);
		if (pass_ === "restart") {
			continue;
		}
		if (pass_ === "lease") {
			leaseRefusals++;
			if (leaseRefusals >= MAX_LEASE_REFUSALS) {
				throw fail("BRANCH_MOVED", true);
			}
			continue;
		}
		return pass_;
	}
	throw new Error("Branch append exceeded its restarts");
}

// ---------------------------------------------------------------------------
// One pass: spec §6.4 steps 1-10
// ---------------------------------------------------------------------------

type PassResult = AppendOutcome | "restart" | "lease";

async function appendPass(
	i: AppendInput,
	credential: BranchCredential,
	loaded: Loaded,
	delta: EffectiveDelta,
	blobs: Map<FileRow, Blob>,
): Promise<PassResult> {
	const { proposal, context, destination } = loaded;
	const { env, signal } = credential;
	const dir = credential.workDir;
	const ids = { branchId: i.branchId, organizationId: i.organizationId };
	const git = { dir, env, signal };

	const [branch, ops, current] = await Promise.all([
		getProposalBranch(ids),
		listBranchOperations(ids),
		getBranchProposal({
			snapshotId: i.snapshotId,
			organizationId: i.organizationId,
		}),
	]);
	if (
		!branch ||
		!current ||
		!claimHolds(current, i) ||
		!acceptsAppends(branch)
	) {
		return "stopped";
	}
	// Spec §6 loop item 1, on every pass: an operation issued since the
	// entry check (an overlapping attempt of this claim) is recovered by the
	// loop before this attempt builds on the branch.
	if (ops.some((op) => op.outcome === null)) {
		return "retry_later";
	}

	// Step 1: fetch. T is the tip, or the base commit when the branch has no
	// head. A recorded head whose ref is gone retires the branch.
	const fetched = await gitCall(APPEND, credential, () =>
		fetchBranchHead({ ...git, branch: branch.ref }),
	);
	safeHeartbeat();
	if (branch.headSha !== null && fetched.kind === "absent") {
		const r = await releaseBranchClaim({
			...ids,
			snapshotId: i.snapshotId,
			proposalAttempt: i.proposalAttempt,
			retire: "BRANCH_MISSING",
		});
		return r.released ? "released" : "stopped";
	}
	const tip = fetched.kind === "present" ? fetched.sha : null;

	// §6.2 step 5, before any new issuance: every `unknown` operation that
	// pushed to this ref is resolved once more against the fetched tip.
	// Proven ancestry is a fact (observed); the reducer runs with it. A
	// change to this proposal's lifecycle stops the claim, and any newly
	// established push restarts the pass on the new facts.
	if (tip !== null) {
		const unresolved = ops.filter(
			(op) => op.ref === branch.ref && op.outcome === "unknown",
		);
		if (unresolved.length > 0) {
			const results = await gitCall(APPEND, credential, () =>
				reobserveAgainstTip({
					...git,
					tip,
					known: establishedShas(ops),
					organizationId: i.organizationId,
					ops: unresolved,
				}),
			);
			if (
				results.some((r) => r.snapshotId === i.snapshotId && r.changed)
			) {
				return "stopped";
			}
			if (results.some((r) => r.observed)) {
				return "restart";
			}
		}
	}

	const hasHead = branch.headSha !== null;
	const T = hasHead ? (tip as string) : context.baseCommitSha;
	const known = establishedShas(ops);

	const listed = await gitCall(APPEND, credential, () =>
		listTreeRaw({
			...git,
			sha: T,
			rootPath: destination.rootPath,
			maxEntries: MAX_INVENTORY_ENTRIES,
		}),
	);
	if (!listed.ok) {
		throw fail("LIMITS_EXCEEDED", false);
	}
	const intents = await intentsOf({
		credential,
		delta,
		blobs,
		entries: listed.entries,
		rootPath: destination.rootPath,
		tipSha: T,
		baseCommitSha: context.baseCommitSha,
		ops,
	});

	// Step 3: T's entries for the intent paths.
	const tipEntries = await gitCall(APPEND, credential, () =>
		readTreeEntries({
			...git,
			sha: T,
			rawPaths: intents.map((x) => x.rawPath),
		}),
	);

	// Step 4: provenance (only once the branch has a head).
	let ancestry: "true" | "false" | "error" = "true";
	let foreign = false;
	const startSha = branch.startSha;
	if (hasHead) {
		if (startSha === null) {
			throw new Error("A branch with a head has no start commit");
		}
		const p = await gitCall(APPEND, credential, () =>
			provenanceOf({ ...git, from: startSha, tip: T, known }),
		);
		ancestry = p.ancestry;
		foreign = p.foreign;
	}
	safeHeartbeat();

	// Step 5: the per-file rule, in order (d), superseded, (w), conflict.
	const superseding = latestIntentOrders(
		await listMemberBranchWrites({
			projectId: branch.projectId,
			userId: branch.userId,
			organizationId: i.organizationId,
			repositoryKey: branch.repositoryKey,
		}),
		i.snapshotId,
	);
	const writes: Intent[] = [];
	const superseded: string[] = [];
	const conflicts: string[] = [];
	for (const intent of intents) {
		const tipEntry = tipEntries.get(intent.rawPath) ?? null;
		if (sameEntry(tipEntry, intent.after)) {
			continue; // (d)
		}
		const newer = superseding.get(intent.rawPath);
		if (
			newer !== undefined &&
			proposal.proposalIntentOrder !== null &&
			newer > proposal.proposalIntentOrder
		) {
			superseded.push(intent.path);
			continue;
		}
		if (
			!hasHead ||
			(await gitCall(APPEND, credential, () =>
				pathUntouchedSince({
					...git,
					from: startSha as string,
					tip: T,
					known,
					rawPath: intent.rawPath,
					ancestry,
				}),
			))
		) {
			writes.push(intent); // (w)
			continue;
		}
		conflicts.push(intent.path);
	}
	if (foreign) {
		await markForeignTip(ids);
	}
	if (conflicts.length > 0) {
		throw fail("BRANCH_CONFLICT", false, pathParams(conflicts));
	}
	if (superseded.length > 0) {
		throw fail("SUPERSEDED_BY_LATER_CHANGE", false, pathParams(superseded));
	}
	if (writes.length === 0) {
		return finalizeNoOp(i, credential, current, ops, tip, T, foreign);
	}

	// Step 6: the write plan relative to T, its collisions checked against
	// T's tree, each entry's before and after recorded with their sources.
	const deltaT: EffectiveDelta = { added: [], modified: [], deleted: [] };
	for (const w of writes) {
		const before = tipEntries.get(w.rawPath) ?? null;
		const bucket =
			w.after === null
				? "deleted"
				: before === null
					? "added"
					: "modified";
		deltaT[bucket].push(w.row);
	}
	if (findTreeConflicts(listed.entries, deltaT, destination.rootPath)) {
		throw fail("TREE_CONFLICT", false);
	}
	const entries: BranchOperationEntryRecord[] = writes.map((w) => {
		const before = tipEntries.get(w.rawPath) ?? null;
		return branchOperationEntrySchema.parse({
			path: w.path,
			rawPath: w.rawPath,
			before,
			after: w.after,
			afterSha256: w.after === null ? null : w.afterSha256,
			afterSource: w.after === null ? null : proposal.id,
			beforeSource: beforeSourceOf(ops, w.rawPath, before),
		});
	});

	// Step 7: build on T, the diff verified to be exactly the plan.
	const built = await gitCall(APPEND, credential, () =>
		buildBranchCommit({
			...git,
			parent: T,
			plan: entries.map((e) => ({ rawPath: e.rawPath, after: e.after })),
			author: context.author,
			committer: context.committer,
			message: `${context.message}\n\nFabric-Change: ${proposal.pullRequestOperationId ?? proposal.id}`,
			date: context.committedAt,
		}),
	);
	if (!built.ok) {
		throw fail("GIT_FAILED", false);
	}
	safeHeartbeat();

	// The creation checks again, immediately before the push is committed to.
	await assertBranchCreationAllowed({ branch, destination, phase: APPEND });
	assertMayContinue(signal);

	// Step 8: record intent, fenced on the claim and refused while another
	// operation on the branch is still issued (the loop recovers it first).
	const recorded = await recordBranchOperation({
		...ids,
		snapshotId: i.snapshotId,
		proposalAttempt: i.proposalAttempt,
		kind: "APPEND",
		ref: branch.ref,
		parentSha: hasHead ? T : null,
		sha: built.sha,
		entries,
	});
	if (!recorded.ok) {
		return recorded.unresolved ? "retry_later" : "stopped";
	}
	const notPushed = () =>
		recordOperationOutcome({
			operationId: recorded.operationId,
			organizationId: i.organizationId,
			outcome: "not_pushed",
		});

	// Step 9: push. A definitive refusal is `not_pushed` at once, with the
	// reducer in the same transaction; anything else leaves the operation
	// issued for recovery.
	if (!hasHead) {
		const pushed = await gitCall(APPEND, credential, () =>
			pushCreateOnly({
				...git,
				sha: built.sha,
				branch: branch.ref,
			}),
		);
		if (pushed.kind === "exists") {
			const r = await notPushed();
			if (r.reconcile.changed) {
				return "stopped";
			}
			const next = await refuseCurrentRef({ ...ids, naming: NAMING });
			if ("exhausted" in next) {
				throw fail("BRANCH_NAME_UNAVAILABLE", false);
			}
			return "restart";
		}
		if (pushed.kind === "refused") {
			await notPushed();
			throw fail("BRANCH_WRITE_REFUSED", true);
		}
	} else {
		const pushed = await gitCall(APPEND, credential, () =>
			pushFastForward({
				...git,
				parentSha: T,
				sha: built.sha,
				branch: branch.ref,
			}),
		);
		if (pushed.kind === "stale") {
			const r = await notPushed();
			return r.reconcile.changed ? "stopped" : "lease";
		}
		if (pushed.kind === "refused") {
			await notPushed();
			throw fail("BRANCH_WRITE_REFUSED", true);
		}
	}
	safeHeartbeat();

	// Step 10: acknowledge. The reducer makes the proposal OPEN; the branch
	// takes the head (and its start and OPENING on the first push).
	await recordOperationOutcome({
		operationId: recorded.operationId,
		organizationId: i.organizationId,
		outcome: "acked",
		foreignTip: foreign,
		audit: { actorUserId: proposal.userId, recovered: false },
	});
	return "appended";
}

// ---------------------------------------------------------------------------
// Step 2 helpers
// ---------------------------------------------------------------------------

export const toFileRow = (r: {
	path: string;
	sha256: string;
	mode: number | null;
	storageKey: string;
}): FileRow => ({
	path: r.path,
	sha256: r.sha256,
	mode: r.mode,
	storageKey: r.storageKey,
});

/** The bytes each added or modified row writes, re-hashed from storage and stored as blobs. */
export async function hashIntentBlobs(
	credential: BranchCredential,
	delta: EffectiveDelta,
): Promise<Map<FileRow, Blob>> {
	const storage = getStorageProvider();
	const blobs = new Map<FileRow, Blob>();
	for (const row of [...delta.added, ...delta.modified]) {
		assertMayContinue(credential.signal);
		let bytes: Buffer;
		try {
			bytes = Buffer.from(
				(
					await storage.downloadFile(row.storageKey, {
						bucket: INSTRUCTIONS_BUCKET,
					})
				).data,
			);
		} catch (error) {
			if (credential.signal.aborted) {
				throw error;
			}
			throw fail("STORAGE_FAILED", true);
		}
		if (sha256Hex(bytes) !== row.sha256) {
			throw fail("STORAGE_FAILED", true);
		}
		const oid = await gitCall(APPEND, credential, () =>
			hashBlob({
				dir: credential.workDir,
				bytes,
				env: credential.env,
				signal: credential.signal,
			}),
		);
		blobs.set(row, { oid, sha256: row.sha256 });
	}
	return blobs;
}

/**
 * Spec §6.4 step 2 as entries: each delta row's repository path (T's own
 * spelling of it when T has one, else the journal's, else the root joined
 * with Fabric's path) and the entry the proposal wants there. A modified
 * row keeps T's regular-blob mode, else the base commit's, else the row's
 * recorded one; a new path is `100644`, or `100755` when recorded 0755.
 */
export async function intentsOf(i: {
	credential: BranchCredential;
	delta: EffectiveDelta;
	blobs: Map<FileRow, Blob>;
	entries: readonly RawTreeEntry[];
	rootPath: string;
	tipSha: string;
	baseCommitSha: string;
	ops: readonly BranchOperationRow[];
}): Promise<Intent[]> {
	const byKey = new Map<string, string>();
	for (const e of i.entries) {
		if (e.path === null) {
			continue;
		}
		const rel = relativeTo(i.rootPath, e.path);
		if (rel !== null && rel !== "") {
			byKey.set(pathKey(rel), e.path);
		}
	}
	const journal = new Map<string, string>();
	for (const op of [...i.ops].sort(
		(a, b) => a.executionSeq - b.executionSeq,
	)) {
		for (const e of op.entries) {
			journal.set(pathKey(e.path), e.rawPath);
		}
	}
	const rawPathOf = (row: FileRow) => {
		const key = pathKey(row.path);
		return (
			byKey.get(key) ?? journal.get(key) ?? joinRoot(i.rootPath, row.path)
		);
	};
	const rows = [
		...i.delta.added.map((row) => ({ row, kind: "added" as const })),
		...i.delta.modified.map((row) => ({ row, kind: "modified" as const })),
		...i.delta.deleted.map((row) => ({ row, kind: "deleted" as const })),
	];
	const rawPaths = rows.map(({ row }) => rawPathOf(row));
	const { dir, env, signal } = {
		dir: i.credential.workDir,
		env: i.credential.env,
		signal: i.credential.signal,
	};
	const modified = rows
		.map((r, n) => ({ ...r, rawPath: rawPaths[n] as string }))
		.filter((r) => r.kind === "modified");
	const readModes = (sha: string) =>
		gitCall(APPEND, i.credential, () =>
			readTreeEntries({
				dir,
				env,
				signal,
				sha,
				rawPaths: modified.map((r) => r.rawPath),
			}),
		);
	const none = new Map<string, TreeEntry | null>();
	const tipModes = modified.length === 0 ? none : await readModes(i.tipSha);
	const baseModes =
		modified.length === 0 ? none : await readModes(i.baseCommitSha);
	return rows.map(({ row, kind }, n) => {
		const rawPath = rawPaths[n] as string;
		if (kind === "deleted") {
			return {
				path: row.path,
				rawPath,
				row,
				kind,
				after: null,
				afterSha256: null,
			};
		}
		const blob = i.blobs.get(row) as Blob;
		const tip = tipModes.get(rawPath);
		const base = baseModes.get(rawPath);
		const mode =
			kind === "modified" && isRegularBlob(tip)
				? tip.mode
				: kind === "modified" && isRegularBlob(base)
					? base.mode
					: addedMode(row);
		return {
			path: row.path,
			rawPath,
			row,
			kind,
			after: { type: "blob", mode, oid: blob.oid },
			afterSha256: blob.sha256,
		};
	});
}

/**
 * Spec §6.4 step 5 "superseded": per repository path, the intent order of
 * the latest established append (by `executionSeq`, per branch) on each of
 * the member's open branches, the highest across them. An append whose
 * change was withdrawn (an established revert of the same submission after
 * it) no longer carries intent, and a revert is never itself a newer
 * intent. The proposal's own writes are left out.
 */
function latestIntentOrders(
	writes: readonly MemberBranchWrite[],
	snapshotId: string,
): Map<string, bigint> {
	const withdrawn = (w: MemberBranchWrite) =>
		writes.some(
			(r) =>
				r.kind === "REVERT" &&
				r.branchId === w.branchId &&
				r.snapshotId === w.snapshotId &&
				r.assignment === w.assignment &&
				r.executionSeq > w.executionSeq,
		);
	const latest = new Map<string, MemberBranchWrite>();
	for (const w of writes) {
		if (w.kind !== "APPEND" || withdrawn(w)) {
			continue;
		}
		for (const rawPath of w.rawPaths) {
			const key = `${w.branchId}\0${rawPath}`;
			const seen = latest.get(key);
			if (!seen || w.executionSeq > seen.executionSeq) {
				latest.set(key, w);
			}
		}
	}
	const orders = new Map<string, bigint>();
	for (const [key, w] of latest) {
		const rawPath = key.slice(key.indexOf("\0") + 1);
		if (w.snapshotId === snapshotId || w.intentOrder === null) {
			continue;
		}
		const seen = orders.get(rawPath);
		if (seen === undefined || w.intentOrder > seen) {
			orders.set(rawPath, w.intentOrder);
		}
	}
	return orders;
}

/**
 * The proposal whose stored bytes are T's entry at `rawPath`, when Fabric
 * wrote that entry: the latest established operation that left exactly
 * `before` there (an append's `after`, a revert's restored `before`).
 */
function beforeSourceOf(
	ops: readonly BranchOperationRow[],
	rawPath: string,
	before: TreeEntry | null,
): string | null {
	if (before === null) {
		return null;
	}
	const established = ops
		.filter((op) => op.outcome === "acked" || op.outcome === "observed")
		.sort((a, b) => b.executionSeq - a.executionSeq);
	for (const op of established) {
		const e = op.entries.find((x) => x.rawPath === rawPath);
		if (!e) {
			continue;
		}
		const left = op.kind === "APPEND" ? e.after : e.before;
		if (sameEntry(left, before)) {
			return op.kind === "APPEND" ? e.afterSource : e.beforeSource;
		}
		return null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The no-op guard and finalization (spec §6.4 step 5, Decision 12)
// ---------------------------------------------------------------------------

/**
 * Every path is a no-op. Before a terminal no-op is recorded, every append
 * of the current submission that is `unknown` or still issued is resolved
 * against the same history T: proven ancestry records `observed` with the
 * reducer, and the claim stops only when that changed the lifecycle. Then
 * `finalizeBranchNoOp` decides, in one transaction with the reducer:
 * CANCELED ALREADY_ON_BRANCH, or BLOCKED PUSH_OUTCOME_UNKNOWN while an
 * append of the current submission is still unresolved.
 */
async function finalizeNoOp(
	i: AppendInput,
	credential: BranchCredential,
	proposal: BranchProposalRow,
	ops: readonly BranchOperationRow[],
	tip: string | null,
	T: string,
	foreign: boolean,
): Promise<AppendOutcome> {
	const candidates = ops.filter(
		(op) =>
			op.kind === "APPEND" &&
			op.snapshotId === i.snapshotId &&
			op.branchId === i.branchId &&
			op.assignment === proposal.proposalAssignment &&
			(op.outcome === null || op.outcome === "unknown"),
	);
	if (tip !== null && candidates.length > 0) {
		for (const op of candidates) {
			safeHeartbeat();
			const ancestry = await gitCall(APPEND, credential, () =>
				isAncestor({
					dir: credential.workDir,
					ancestor: op.sha,
					descendant: T,
					env: credential.env,
					signal: credential.signal,
				}),
			);
			if (ancestry !== "true") {
				continue; // stays unknown
			}
			const r = await recordOperationOutcome({
				operationId: op.id,
				organizationId: i.organizationId,
				outcome: "observed",
				foreignTip: foreign,
				audit: { actorUserId: null, recovered: true },
			});
			if (r.reconcile.changed) {
				return "stopped";
			}
		}
	}
	const done = await finalizeBranchNoOp({
		branchId: i.branchId,
		organizationId: i.organizationId,
		snapshotId: i.snapshotId,
		proposalAttempt: i.proposalAttempt,
	});
	switch (done.kind) {
		case "canceled":
			return "already_on_branch";
		case "blocked":
			return "blocked";
		default:
			return "stopped";
	}
}
