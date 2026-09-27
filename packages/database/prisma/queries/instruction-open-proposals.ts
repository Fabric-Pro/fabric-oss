/**
 * The member's open proposals as `GET /api/v1/projects/:projectId/instructions/proposals/open`
 * answers them (Fizzy #2738 spec §14.2, for the CLI's skip of already
 * proposed identical paths, Fizzy #2739).
 *
 * Rows: the caller's own PENDING proposals in the project and organization,
 * never another member's, whatever the caller may review. Each row carries
 * the hashes of its effective delta against its own base (`put` with the
 * proposed file's sha256, `delete` with `sha256: null`), never bytes.
 *
 * Latest intent only, current destination only. For a member proposal branch
 * row (v2), a path is listed only on the proposal holding the member's
 * NEWEST intent for it (highest `intentOrder` across the whole intent set,
 * every branch, OPENING included) and only while that proposal positively
 * carries it toward review. Otherwise the path is omitted entirely; it never
 * falls back to an older intent. So each path appears on at most one v2 row,
 * and a B -> C -> B re-send is never suppressed, including across a retired
 * branch. A v2 proposal whose frozen destination is not the current one is
 * never listed.
 *
 * `selectOpenProposals` is the pure decision; `listOpenInstructionProposals`
 * loads its inputs in a fixed number of tenant-scoped queries.
 */
import { db } from "../client";
import type {
	ProjectInstructionPullRequestState,
	ProjectInstructionSnapshotStatus,
} from "../generated/client";
import {
	acceptsAppends,
	currentAppend,
	currentWithdrawal,
	type EvidenceOp,
	isEstablished,
	type OpOutcome,
} from "./instruction-proposal-branch-evidence";
import {
	type BranchDestinationRecord,
	type BranchRow,
	currentDestination,
	membershipStatusOf,
	type ProposalBranchNaming,
	parseOperationEntries,
	proposalDestination,
	sameBranchDestination,
} from "./instruction-proposal-branches";

/** The route's row limit (spec §14.2). */
export const OPEN_PROPOSAL_LIMIT = 20;

/**
 * The `status` union the CLI accepts (spec §14.2 "Enum strictness"): it
 * rejects the whole answer on any other value.
 */
export const OPEN_PROPOSAL_STATUSES = [
	"RECEIVING",
	"VALIDATING",
	"READY",
	"REJECTED",
	"FAILED",
] as const satisfies readonly ProjectInstructionSnapshotStatus[];

/** The `pullRequest.state` union the CLI accepts (`ProposalPullRequestState`). */
export const OPEN_PROPOSAL_PULL_REQUEST_STATES = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"BLOCKED",
	"MERGED",
	"CLOSED",
	"CANCELED",
] as const satisfies readonly ProjectInstructionPullRequestState[];

export type OpenProposalStatus = (typeof OPEN_PROPOSAL_STATUSES)[number];
export type OpenProposalPullRequestState =
	(typeof OPEN_PROPOSAL_PULL_REQUEST_STATES)[number];

export type OpenProposalChange = {
	path: string;
	op: "put" | "delete";
	sha256: string | null;
};

/** One of the member's PENDING proposals, as the selection reads it. */
export type OpenProposalCandidate = {
	snapshotId: string;
	version: number;
	baseSnapshotId: string | null;
	status: string;
	pullRequestState: ProjectInstructionPullRequestState | null;
	pullRequestUrl: string | null;
	/** `pullRequestContext.v`, or null for a proposal Fabric reviews itself. */
	contextVersion: number | null;
	/** The destination a v2 context froze, or null. */
	frozenDestination: BranchDestinationRecord | null;
	branchId: string | null;
	assignment: number;
	intentOrder: bigint | null;
	withdrawRequestedAt: Date | null;
	/** The effective delta against the proposal's own base. */
	changes: OpenProposalChange[];
};

/** What the selection reads of a branch. */
export type OpenProposalBranch = Pick<
	BranchRow,
	| "id"
	| "state"
	| "retiredAt"
	| "untracked"
	| "failure"
	| "membership"
	| "pullRequestUrl"
>;

/** One journal operation on a branch, with the paths it wrote. */
export type OpenProposalOp = EvidenceOp & {
	snapshotId: string;
	paths: readonly string[];
};

export type OpenProposalSelection<B extends OpenProposalBranch> = {
	candidate: OpenProposalCandidate;
	status: OpenProposalStatus;
	pullRequest: {
		state: OpenProposalPullRequestState;
		url: string | null;
	} | null;
	changes: OpenProposalChange[];
	branch: B | null;
};

const INTENT_SET_STATES: readonly ProjectInstructionPullRequestState[] = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"BLOCKED",
];

/** #2563 rows (v1) still heading to their own pull request's review. */
const V1_TOWARD_REVIEW: readonly ProjectInstructionPullRequestState[] = [
	"QUEUED",
	"OPENING",
	"OPEN",
];

function isOpenStatus(value: string): value is OpenProposalStatus {
	return (OPEN_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

function isOpenPullRequestState(
	value: string,
): value is OpenProposalPullRequestState {
	return (OPEN_PROPOSAL_PULL_REQUEST_STATES as readonly string[]).includes(
		value,
	);
}

function hasNonRetryableFailure(failure: unknown): boolean {
	return (
		failure !== null &&
		typeof failure === "object" &&
		(failure as { retryable?: unknown }).retryable === false
	);
}

/** A member branch proposal (v2) that is not stated against the current destination. */
function isStale(
	c: OpenProposalCandidate,
	current: BranchDestinationRecord | null,
): boolean {
	return (
		c.contextVersion === 2 &&
		(current === null ||
			c.frozenDestination === null ||
			!sameBranchDestination(c.frozenDestination, current))
	);
}

/**
 * The member's intent set (spec §4.1) among the candidates: v2, no
 * `withdrawRequestedAt`, QUEUED, OPENING, OPEN or BLOCKED, on any branch.
 * A stale one stays in it: its newer intent still means an older proposal's
 * content is not what the member would send now, so it suppresses the older
 * one's paths while never being listed itself.
 */
function inIntentSet(c: OpenProposalCandidate): boolean {
	return (
		c.contextVersion === 2 &&
		c.withdrawRequestedAt === null &&
		c.pullRequestState !== null &&
		INTENT_SET_STATES.includes(c.pullRequestState)
	);
}

function newer(a: OpenProposalCandidate, b: OpenProposalCandidate): boolean {
	const x = a.intentOrder ?? BigInt(-1);
	const y = b.intentOrder ?? BigInt(-1);
	return x !== y ? x > y : a.version > b.version;
}

/**
 * Whether a v2 proposal positively carries its paths toward review (spec
 * §14.2): no current append `unknown`, no current withdrawal at all (issued,
 * `unknown` or established); QUEUED or OPENING on a branch that accepts
 * appends, or OPEN on a branch that is OPENING or OPEN; in both cases no
 * non-retryable branch failure, not retired, not untracked, no membership
 * pending. A proposal not joined to a branch yet carries nothing.
 */
export function carriesTowardReview(
	c: OpenProposalCandidate,
	branch: OpenProposalBranch | undefined,
	ops: readonly OpenProposalOp[],
): boolean {
	if (
		c.withdrawRequestedAt !== null ||
		c.branchId === null ||
		!branch ||
		branch.id !== c.branchId
	) {
		return false;
	}
	const own = ops.filter((op) => op.snapshotId === c.snapshotId);
	const submission = { branchId: c.branchId, assignment: c.assignment };
	const append = currentAppend(own, submission);
	if (append?.outcome === "unknown") {
		return false;
	}
	if (currentWithdrawal(own, submission) !== null) {
		return false;
	}
	if (
		branch.retiredAt !== null ||
		branch.untracked ||
		membershipStatusOf(branch.membership) === "pending" ||
		hasNonRetryableFailure(branch.failure)
	) {
		return false;
	}
	if (c.pullRequestState === "QUEUED" || c.pullRequestState === "OPENING") {
		return acceptsAppends(branch);
	}
	if (c.pullRequestState === "OPEN") {
		return branch.state === "OPENING" || branch.state === "OPEN";
	}
	return false;
}

/**
 * Whether a later established operation on the proposal's branch wrote
 * `path` after the proposal's own established current append (spec §14.2
 * "a path is also dropped when a later established revert or operation
 * wrote it").
 */
function writtenLater(
	c: OpenProposalCandidate,
	ops: readonly OpenProposalOp[],
	path: string,
): boolean {
	if (c.branchId === null) {
		return false;
	}
	const append = currentAppend(
		ops.filter((op) => op.snapshotId === c.snapshotId),
		{ branchId: c.branchId, assignment: c.assignment },
	);
	if (append === null || !isEstablished(append)) {
		return false;
	}
	return ops.some(
		(op) =>
			op.branchId === c.branchId &&
			op.executionSeq > append.executionSeq &&
			isEstablished(op) &&
			op.paths.includes(path),
	);
}

/**
 * The route's answer from its inputs, pure (spec §14.2). Supersession runs
 * over every candidate before the row limit; rows then keep only the paths
 * they list, rows listing none are left out, and the rest are returned
 * `version desc`, at most `limit`. A row with a null base, a status or
 * pull-request state outside the CLI's unions, or a stale destination is
 * never returned.
 *
 * Rows that are not member branch proposals keep their whole delta: a
 * proposal Fabric reviews itself, and a #2563 (v1) proposal still QUEUED,
 * OPENING or OPEN, which has a pull request of its own.
 */
export function selectOpenProposals<B extends OpenProposalBranch>(i: {
	candidates: readonly OpenProposalCandidate[];
	branches: ReadonlyMap<string, B>;
	/** Every journal operation on the candidates' branches. */
	ops: readonly OpenProposalOp[];
	current: BranchDestinationRecord | null;
	limit?: number;
}): OpenProposalSelection<B>[] {
	const newest = new Map<string, OpenProposalCandidate>();
	for (const c of i.candidates) {
		if (!inIntentSet(c) || c.baseSnapshotId === null) {
			continue;
		}
		for (const change of c.changes) {
			const held = newest.get(change.path);
			if (!held || newer(c, held)) {
				newest.set(change.path, c);
			}
		}
	}

	const out: OpenProposalSelection<B>[] = [];
	for (const c of i.candidates) {
		if (c.baseSnapshotId === null || !isOpenStatus(c.status)) {
			continue;
		}
		if (
			c.pullRequestState !== null &&
			!isOpenPullRequestState(c.pullRequestState)
		) {
			continue;
		}
		const branch =
			c.branchId === null ? undefined : i.branches.get(c.branchId);
		let changes: OpenProposalChange[];
		if (c.contextVersion === 2) {
			if (isStale(c, i.current) || !inIntentSet(c)) {
				continue;
			}
			const carries = carriesTowardReview(c, branch, i.ops);
			changes = carries
				? c.changes.filter(
						(change) =>
							newest.get(change.path)?.snapshotId ===
								c.snapshotId &&
							!writtenLater(c, i.ops, change.path),
					)
				: [];
		} else if (c.pullRequestState === null) {
			changes = c.changes;
		} else {
			changes = V1_TOWARD_REVIEW.includes(c.pullRequestState)
				? c.changes
				: [];
		}
		if (changes.length === 0) {
			continue;
		}
		const state = c.pullRequestState;
		out.push({
			candidate: c,
			status: c.status as OpenProposalStatus,
			pullRequest:
				state === null
					? null
					: {
							state: state as OpenProposalPullRequestState,
							url:
								c.contextVersion === 2
									? (branch?.pullRequestUrl ?? null)
									: c.pullRequestUrl,
						},
			changes,
			branch: branch ?? null,
		});
	}
	return out
		.sort((a, b) => b.candidate.version - a.candidate.version)
		.slice(0, i.limit ?? OPEN_PROPOSAL_LIMIT);
}

/** The effective delta of `files` against `base`, by sha256, path order. */
export function effectiveDelta(
	base: ReadonlyMap<string, string>,
	files: ReadonlyMap<string, string>,
): OpenProposalChange[] {
	const out: OpenProposalChange[] = [];
	for (const [path, sha256] of files) {
		if (base.get(path) !== sha256) {
			out.push({ path, op: "put", sha256 });
		}
	}
	for (const path of base.keys()) {
		if (!files.has(path)) {
			out.push({ path, op: "delete", sha256: null });
		}
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function contextVersionOf(context: unknown): number | null {
	if (context === null || typeof context !== "object") {
		return null;
	}
	const v = (context as { v?: unknown }).v;
	return typeof v === "number" ? v : null;
}

/**
 * Loads the member's PENDING proposals in the project with everything
 * `selectOpenProposals` reads, and returns its answer. Every query is scoped
 * to the project and the organization the route resolved; the proposals to
 * `userId`, the API key's creator. `naming` is the canonical repository
 * identity port (`ProposalBranchNaming`), which this package cannot import.
 */
export async function listOpenInstructionProposals(i: {
	projectId: string;
	organizationId: string;
	userId: string;
	naming: Pick<ProposalBranchNaming, "repositoryIdentity" | "repositoryKey">;
	limit?: number;
}): Promise<OpenProposalSelection<BranchRow>[]> {
	const [rows, project, sync] = await Promise.all([
		db.projectInstructionSnapshot.findMany({
			where: {
				projectId: i.projectId,
				organizationId: i.organizationId,
				userId: i.userId,
				proposalStatus: "PENDING",
			},
			orderBy: { version: "desc" },
			select: {
				id: true,
				version: true,
				baseSnapshotId: true,
				status: true,
				pullRequestState: true,
				pullRequestUrl: true,
				pullRequestContext: true,
				proposalBranchId: true,
				proposalAssignment: true,
				proposalIntentOrder: true,
				withdrawRequestedAt: true,
			},
		}),
		db.project.findFirst({
			where: { id: i.projectId, organizationId: i.organizationId },
			select: { instructionSettings: true },
		}),
		db.projectInstructionRepositorySync.findFirst({
			where: { projectId: i.projectId, organizationId: i.organizationId },
			select: {
				id: true,
				repositoryIntegrationId: true,
				ref: true,
				rootPath: true,
				repositoryIntegration: {
					select: {
						projectId: true,
						provider: true,
						repositoryUrl: true,
					},
				},
			},
		}),
	]);
	if (!project) {
		return [];
	}
	const settings = project.instructionSettings;
	const current = currentDestination(
		{
			projectId: i.projectId,
			sourceOfTruth:
				settings !== null && typeof settings === "object"
					? (settings as { sourceOfTruth?: unknown }).sourceOfTruth
					: null,
			sync: sync
				? {
						id: sync.id,
						repositoryIntegrationId: sync.repositoryIntegrationId,
						ref: sync.ref,
						rootPath: sync.rootPath,
					}
				: null,
			integration: sync?.repositoryIntegration
				? {
						projectId: sync.repositoryIntegration.projectId,
						provider: sync.repositoryIntegration.provider,
						repositoryUrl: sync.repositoryIntegration.repositoryUrl,
					}
				: null,
		},
		i.naming,
	);

	const withBase = rows.filter((r) => r.baseSnapshotId !== null);
	const snapshotIds = [
		...new Set([
			...withBase.map((r) => r.id),
			...withBase.map((r) => r.baseSnapshotId as string),
		]),
	];
	const branchIds = [
		...new Set(
			withBase.flatMap((r) =>
				r.proposalBranchId === null ? [] : [r.proposalBranchId],
			),
		),
	];
	const [files, branches, ops] = await Promise.all([
		snapshotIds.length === 0
			? Promise.resolve([])
			: db.projectInstructionFile.findMany({
					where: {
						snapshotId: { in: snapshotIds },
						projectId: i.projectId,
						organizationId: i.organizationId,
					},
					select: { snapshotId: true, path: true, sha256: true },
				}),
		branchIds.length === 0
			? Promise.resolve([])
			: db.projectInstructionProposalBranch.findMany({
					where: {
						id: { in: branchIds },
						projectId: i.projectId,
						organizationId: i.organizationId,
						userId: i.userId,
					},
				}),
		branchIds.length === 0
			? Promise.resolve([])
			: db.projectInstructionProposalBranchOperation.findMany({
					where: {
						branchId: { in: branchIds },
						organizationId: i.organizationId,
					},
					select: {
						id: true,
						snapshotId: true,
						kind: true,
						executionSeq: true,
						assignment: true,
						branchId: true,
						outcome: true,
						entries: true,
					},
				}),
	]);

	// One map per snapshot, bases read once however many rows share one.
	const bySnapshot = new Map<string, Map<string, string>>();
	for (const f of files) {
		let map = bySnapshot.get(f.snapshotId);
		if (!map) {
			map = new Map();
			bySnapshot.set(f.snapshotId, map);
		}
		map.set(f.path, f.sha256);
	}
	const empty = new Map<string, string>();
	const candidates: OpenProposalCandidate[] = rows.map((r) => ({
		snapshotId: r.id,
		version: r.version,
		baseSnapshotId: r.baseSnapshotId,
		status: r.status,
		pullRequestState: r.pullRequestState,
		pullRequestUrl: r.pullRequestUrl,
		contextVersion: contextVersionOf(r.pullRequestContext),
		frozenDestination: proposalDestination(r.pullRequestContext, i.naming),
		branchId: r.proposalBranchId,
		assignment: r.proposalAssignment,
		intentOrder: r.proposalIntentOrder,
		withdrawRequestedAt: r.withdrawRequestedAt,
		changes:
			r.baseSnapshotId === null
				? []
				: effectiveDelta(
						bySnapshot.get(r.baseSnapshotId) ?? empty,
						bySnapshot.get(r.id) ?? empty,
					),
	}));
	return selectOpenProposals({
		candidates,
		branches: new Map(branches.map((b) => [b.id, b])),
		ops: ops.map((op) => ({
			id: op.id,
			snapshotId: op.snapshotId,
			kind: op.kind,
			executionSeq: op.executionSeq,
			assignment: op.assignment,
			branchId: op.branchId,
			outcome: op.outcome as OpOutcome,
			paths: parseOperationEntries(op.entries).map((e) => e.path),
		})),
		current,
		limit: i.limit,
	});
}
