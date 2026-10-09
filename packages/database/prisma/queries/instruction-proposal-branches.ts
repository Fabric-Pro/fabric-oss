/**
 * Member proposal branches: naming, join and transfer, claims, the journal's
 * fact writers, branch transitions, the workflow's next-work read, stop
 * tracking and the branch projection (Fizzy #2738 spec Decisions 1-3, 8, 15,
 * 19; §4.1 facts; §4.3/§4.4 on the database side; §4.7; §5; §6 loop; §6.1;
 * §10 projection).
 *
 * Lock order (spec §4.7). A transaction that writes more than one of these
 * rows locks the project's sync row (`FOR SHARE`), then branch rows by id,
 * then proposal rows by id, and retries a serialization or deadlock failure
 * up to three times. `transitionPullRequest`, which locks its proposal row
 * itself, runs only after the branch lock is held.
 *
 * Naming and repository identity come from the caller (`ProposalBranchNaming`):
 * this package does not depend on `@repo/instructions` (see the note at
 * `DerivedInstructionChange` in `instructions.ts`), and `@repo/integrations`
 * depends on this package, so neither `memberBranchRef` nor
 * `repositoryIdentity`/`repositoryKey` can be imported here. Callers pass the
 * canonical functions themselves; nothing here re-implements them.
 */
import { createId } from "@paralleldrive/cuid2";
import { db, Prisma } from "../client";
import type {
	ProjectInstructionProposalBranch,
	ProjectInstructionProposalBranchState,
	ProjectInstructionPullRequestState,
} from "../generated/client";
import { type RecordAuditInput, recordAuditTx } from "./audit-log";
import { migrationOfSettings } from "./instruction-migration-pointer";
import {
	acceptsAppends,
	type EvidenceOp,
	isEstablished,
	isLiveProposal,
	isTerminalPullRequestState,
	lifecycleColumns,
	lifecycleOfRow,
	type OpOutcome,
	outcomeTransition,
	type ProposalLifecycle,
	type ReducerRow,
	reconcileProposalFromEvidence,
} from "./instruction-proposal-branch-evidence";
import {
	type PullRequestFailure,
	transitionPullRequest,
} from "./instruction-proposal-pull-requests";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

type BranchState = ProjectInstructionProposalBranchState;
type ProposalState = ProjectInstructionPullRequestState;

/** A branch row, every column. */
export type BranchRow = ProjectInstructionProposalBranch;

/**
 * A repository's canonical identity: structurally `RepositoryIdentity` from
 * `@repo/integrations/instruction-pull-requests`, which is what admission
 * froze into the v2 context (`pullRequestContextSchemaV2.repository`).
 */
export type ProposalRepositoryIdentity =
	| { provider: "GITHUB"; owner: string; repo: string }
	| { provider: "GITLAB"; projectPath: string }
	| {
			provider: "AZURE_DEVOPS";
			apiOrigin: string;
			organization: string;
			project: string;
			repository: string;
	  };

/**
 * The canonical naming and identity functions, supplied by the caller:
 *
 * ```ts
 * import { memberBranchRef } from "@repo/instructions/proposal-branch-ref";
 * import { repositoryIdentity, repositoryKey } from "@repo/integrations/instruction-pull-requests";
 * const naming = { memberBranchRef, repositoryIdentity, repositoryKey } satisfies ProposalBranchNaming;
 * ```
 */
export type ProposalBranchNaming = {
	/** `fabric/instructions/members/<slug>-<id4>/<n>` (spec Decision 3). */
	memberBranchRef(input: {
		displayName: string | null | undefined;
		userId: string;
		n: number;
	}): string;
	/** The identity an integration's stored URL names, or null. */
	repositoryIdentity(
		provider: string,
		storedUrl: string,
	): ProposalRepositoryIdentity | null;
	/** Equal exactly when the two identities name one repository. */
	repositoryKey(identity: ProposalRepositoryIdentity): string;
};

/** `branchDestinationSchema` (spec Decision 15): frozen at creation. */
export type BranchDestinationRecord = {
	integrationId: string;
	syncId: string;
	repositoryKey: string;
	provider: ProposalRepositoryIdentity["provider"];
	repository: ProposalRepositoryIdentity;
	targetRef: string;
	rootPath: string;
};

/** `TreeEntry` of `@repo/instructions`: the raw tree entry under the root. */
export type BranchTreeEntry = {
	type: "blob" | "symlink" | "gitlink";
	mode: string;
	oid: string;
};

/**
 * One path an operation changed: `branchOperationEntrySchema` of
 * `@repo/instructions`, which the issuing activity validates against.
 *
 * An APPEND records its own write: `before` is the tip's entry it replaced
 * (`beforeSource` the proposal holding those bytes, when Fabric knows one)
 * and `after` the entry it wrote (`afterSource` its own proposal). A REVERT
 * records the entries of the append it reverts, unchanged: the revert
 * restores `before` (null = delete), from `beforeSource` when Fabric holds
 * those bytes (spec §10 "the beforeSource of a revert"). `projectEntries`
 * reads them so.
 */
export type BranchOperationEntryRecord = {
	path: string;
	rawPath: string;
	before: BranchTreeEntry | null;
	after: BranchTreeEntry | null;
	afterSha256: string | null;
	afterSource: string | null;
	beforeSource: string | null;
};

const TERMINAL_BRANCH_STATES: readonly BranchState[] = [
	"MERGED",
	"CLOSED",
	"CANCELED",
];

/** The accepting-index predicate's states (spec Decision 2). */
const ACCEPTING_BRANCH_STATES: readonly BranchState[] = [
	"PENDING",
	"OPENING",
	"OPEN",
	"BLOCKED",
];

const NON_TERMINAL_PROPOSAL_STATES: readonly ProposalState[] = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"BLOCKED",
];

export function isTerminalBranchState(state: BranchState): boolean {
	return TERMINAL_BRANCH_STATES.includes(state);
}

/**
 * A branch's `membership` JSON: `{ status, at, attempts }`, and while a
 * pending classification backs off (spec §6.6, Decision 14: the history
 * could not be fetched) the time of its next attempt.
 */
export type BranchMembership = {
	status: "pending" | "done" | "unverified";
	at: string;
	attempts: number;
	nextAttemptAt?: string;
};

/** A pending classification's backoff (`nextAttemptAt`), or null when it is due now. */
export function membershipNextAttemptAt(value: unknown): Date | null {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const at = (value as { nextAttemptAt?: unknown }).nextAttemptAt;
	if (typeof at !== "string") {
		return null;
	}
	const parsed = new Date(at);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function membershipStatusOf(
	value: unknown,
): BranchMembership["status"] | null {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const status = (value as { status?: unknown }).status;
	return status === "pending" || status === "done" || status === "unverified"
		? status
		: null;
}

function failureOf(value: unknown): {
	code: string | null;
	retryable: boolean | null;
	phase: string | null;
} {
	if (value === null || typeof value !== "object") {
		return { code: null, retryable: null, phase: null };
	}
	const f = value as { code?: unknown; retryable?: unknown; phase?: unknown };
	return {
		code: typeof f.code === "string" ? f.code : null,
		retryable: typeof f.retryable === "boolean" ? f.retryable : null,
		phase: typeof f.phase === "string" ? f.phase : null,
	};
}

const nonEmptyString = (v: unknown): v is string =>
	typeof v === "string" && v.length > 0;

// ---------------------------------------------------------------------------
// Destinations (spec Decision 15, §5 steps 2-3)
// ---------------------------------------------------------------------------

/** A stored identity, as `pullRequestRepositorySchema` shapes it; null otherwise. */
export function parseRepositoryIdentity(
	value: unknown,
): ProposalRepositoryIdentity | null {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const v = value as Record<string, unknown>;
	switch (v.provider) {
		case "GITHUB":
			return nonEmptyString(v.owner) && nonEmptyString(v.repo)
				? { provider: "GITHUB", owner: v.owner, repo: v.repo }
				: null;
		case "GITLAB":
			return nonEmptyString(v.projectPath)
				? { provider: "GITLAB", projectPath: v.projectPath }
				: null;
		case "AZURE_DEVOPS":
			return nonEmptyString(v.apiOrigin) &&
				nonEmptyString(v.organization) &&
				nonEmptyString(v.project) &&
				nonEmptyString(v.repository)
				? {
						provider: "AZURE_DEVOPS",
						apiOrigin: v.apiOrigin,
						organization: v.organization,
						project: v.project,
						repository: v.repository,
					}
				: null;
		default:
			return null;
	}
}

/**
 * The destination a v2 proposal froze at admission (its `pullRequestContext`),
 * or null when the context is not a readable v2 one.
 */
export function proposalDestination(
	context: unknown,
	naming: Pick<ProposalBranchNaming, "repositoryKey">,
): BranchDestinationRecord | null {
	if (context === null || typeof context !== "object") {
		return null;
	}
	const c = context as Record<string, unknown>;
	const repository = parseRepositoryIdentity(c.repository);
	if (
		c.v !== 2 ||
		repository === null ||
		c.provider !== repository.provider ||
		!nonEmptyString(c.integrationId) ||
		!nonEmptyString(c.syncId) ||
		!nonEmptyString(c.targetRef) ||
		typeof c.rootPath !== "string"
	) {
		return null;
	}
	return {
		integrationId: c.integrationId,
		syncId: c.syncId,
		repositoryKey: naming.repositoryKey(repository),
		provider: repository.provider,
		repository,
		targetRef: c.targetRef,
		rootPath: c.rootPath,
	};
}

/** A branch's frozen `destination` column, or null when unreadable. */
export function parseBranchDestination(
	value: unknown,
): BranchDestinationRecord | null {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const d = value as Record<string, unknown>;
	const repository = parseRepositoryIdentity(d.repository);
	if (
		repository === null ||
		d.provider !== repository.provider ||
		!nonEmptyString(d.integrationId) ||
		!nonEmptyString(d.syncId) ||
		!nonEmptyString(d.repositoryKey) ||
		!nonEmptyString(d.targetRef) ||
		typeof d.rootPath !== "string"
	) {
		return null;
	}
	return {
		integrationId: d.integrationId,
		syncId: d.syncId,
		repositoryKey: d.repositoryKey,
		provider: repository.provider,
		repository,
		targetRef: d.targetRef,
		rootPath: d.rootPath,
	};
}

/**
 * The project's current destination, read under the sync row lock: the sync
 * row, its integration and the canonical identity the integration's live URL
 * names. Null when the project is not repository-backed any more, the
 * integration belongs to another project, or the URL names no repository.
 */
export function currentDestination(
	i: {
		projectId: string;
		sourceOfTruth: unknown;
		sync: {
			id: string;
			repositoryIntegrationId: string;
			ref: string;
			rootPath: string;
		} | null;
		integration: {
			projectId: string;
			provider: string;
			repositoryUrl: string;
		} | null;
	},
	naming: Pick<ProposalBranchNaming, "repositoryIdentity" | "repositoryKey">,
): BranchDestinationRecord | null {
	if (
		i.sourceOfTruth !== "REPOSITORY" ||
		i.sync === null ||
		i.integration === null ||
		i.integration.projectId !== i.projectId
	) {
		return null;
	}
	const repository = naming.repositoryIdentity(
		i.integration.provider,
		i.integration.repositoryUrl,
	);
	if (repository === null) {
		return null;
	}
	return {
		integrationId: i.sync.repositoryIntegrationId,
		syncId: i.sync.id,
		repositoryKey: naming.repositoryKey(repository),
		provider: repository.provider,
		repository,
		targetRef: i.sync.ref,
		rootPath: i.sync.rootPath,
	};
}

/**
 * Destination equality (spec Decision 15): integration, sync row, canonical
 * repository identity, target ref and root, never the generation.
 */
export function sameBranchDestination(
	a: BranchDestinationRecord,
	b: BranchDestinationRecord,
): boolean {
	return (
		a.integrationId === b.integrationId &&
		a.syncId === b.syncId &&
		a.repositoryKey === b.repositoryKey &&
		a.targetRef === b.targetRef &&
		a.rootPath === b.rootPath
	);
}

// ---------------------------------------------------------------------------
// Branch states (spec §4.4)
// ---------------------------------------------------------------------------

/**
 * The §4.4 table as legal (from, to) moves; `unchanged` is a failure-only or
 * column-only write. `transitionBranch` refuses anything else loudly, because
 * it is a programming error rather than a race.
 *
 * - PENDING -> OPENING: first established push (a fact; `recordOperationOutcome`).
 * - OPENING/BLOCKED -> OPEN/MERGED/CLOSED: receipt or adoption.
 * - OPENING -> BLOCKED: create failure. PENDING -> BLOCKED: attribution refusal.
 * - BLOCKED -> OPENING: Retry opening.
 * - OPEN -> MERGED/CLOSED: observation.
 * - PENDING/OPENING/OPEN/BLOCKED -> CLOSE_REQUESTED: close, start over, last-change withdrawal.
 * - CLOSE_REQUESTED -> CLOSED/CANCELED/MERGED: settled; -> OPEN: START_OVER adoption;
 *   -> BLOCKED: START_OVER_REFUSED.
 * - BLOCKED -> CANCELED: release.
 * - CANCELED -> CLOSED/MERGED: a settlement confirmation found a late pull request.
 * - any -> CLOSED: stop tracking (with REPOSITORY_CHANGED).
 */
export const BRANCH_STATE_MOVES: Readonly<
	Record<BranchState, readonly (BranchState | "unchanged")[]>
> = {
	PENDING: ["OPENING", "BLOCKED", "CLOSE_REQUESTED", "CLOSED", "unchanged"],
	OPENING: [
		"OPEN",
		"MERGED",
		"CLOSED",
		"BLOCKED",
		"CLOSE_REQUESTED",
		"unchanged",
	],
	OPEN: ["MERGED", "CLOSED", "CLOSE_REQUESTED", "unchanged"],
	BLOCKED: [
		"OPEN",
		"MERGED",
		"CLOSED",
		"OPENING",
		"CLOSE_REQUESTED",
		"CANCELED",
		"unchanged",
	],
	CLOSE_REQUESTED: [
		"CLOSED",
		"CANCELED",
		"MERGED",
		"OPEN",
		"BLOCKED",
		"unchanged",
	],
	MERGED: ["CLOSED", "unchanged"],
	CLOSED: ["unchanged"],
	CANCELED: ["CLOSED", "MERGED", "unchanged"],
};

export function isLegalBranchMove(
	from: BranchState,
	to: BranchState | "unchanged",
): boolean {
	return BRANCH_STATE_MOVES[from].includes(to);
}

// ---------------------------------------------------------------------------
// The queue head (spec §6.1)
// ---------------------------------------------------------------------------

/** What the claim reads of one proposal on the branch. */
export type BranchQueueEntry = {
	snapshotId: string;
	sequence: number | null;
	state: ProposalState | null;
	/** The snapshot's own status (RECEIVING, VALIDATING, READY, ...). */
	status: string;
	proposalStatus: string | null;
	withdrawRequestedAt: Date | null;
	failure: unknown;
	nextAttemptAt: Date | null;
};

export type HeadPick =
	| { kind: "claim"; snapshotId: string }
	| { kind: "wait"; snapshotId: string }
	| { kind: "none" };

function isDue(at: Date | null, now: Date): boolean {
	return at === null || at.getTime() <= now.getTime();
}

function isReadyPending(e: BranchQueueEntry): boolean {
	return e.status === "READY" && e.proposalStatus === "PENDING";
}

/**
 * A retryable, due BLOCKED proposal in phase append or validation whose
 * submission intent holds and whose snapshot is READY and PENDING.
 */
function isClaimableBlocked(e: BranchQueueEntry, now: Date): boolean {
	const f = failureOf(e.failure);
	return (
		e.state === "BLOCKED" &&
		f.retryable === true &&
		(f.phase === "append" || f.phase === "validation") &&
		e.withdrawRequestedAt === null &&
		isDue(e.nextAttemptAt, now) &&
		isReadyPending(e)
	);
}

/**
 * The head of the branch's queue (spec §6.1): the lowest sequence that is
 * QUEUED, OPENING or a retryable due BLOCKED (phase append or validation)
 * with intent, provided no lower sequence is QUEUED, OPENING or
 * CLOSE_REQUESTED. The claimed one's snapshot must be READY and PENDING; a
 * QUEUED head still validating is `wait`. A BLOCKED proposal never holds the
 * queue.
 */
export function pickRunnableHead(
	entries: readonly BranchQueueEntry[],
	now: Date,
): HeadPick {
	const ordered = [...entries]
		.filter((e) => e.sequence !== null)
		.sort((a, b) => (a.sequence as number) - (b.sequence as number));
	for (const e of ordered) {
		if (e.state === "CLOSE_REQUESTED") {
			return { kind: "none" };
		}
		if (e.state === "QUEUED" || e.state === "OPENING") {
			if (e.withdrawRequestedAt !== null) {
				return { kind: "none" };
			}
			if (isReadyPending(e)) {
				return { kind: "claim", snapshotId: e.snapshotId };
			}
			if (e.status === "RECEIVING" || e.status === "VALIDATING") {
				return { kind: "wait", snapshotId: e.snapshotId };
			}
			return { kind: "none" };
		}
		if (isClaimableBlocked(e, now)) {
			return { kind: "claim", snapshotId: e.snapshotId };
		}
	}
	return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Facts (spec §4.1 "Facts versus lifecycle")
// ---------------------------------------------------------------------------

/** What one outcome report writes, decided on the rows read under the branch lock. */
export type OutcomeFactPlan = {
	/** The operation's outcome changes. */
	apply: boolean;
	/** The report would downgrade evidence (`outcomeTransition` refused it). */
	refused: boolean;
	/** The operation becomes established by this report. */
	established: boolean;
	op: {
		outcome?: Exclude<OpOutcome, null>;
		pushAckedAt?: Date;
		observedAt?: Date;
	};
	branch: {
		factsRevisionIncrement: boolean;
		/** Written only by compare-and-set on `headExecutionSeq`. */
		head: { sha: string; executionSeq: number } | null;
		startSha: string | null;
		pendingToOpening: boolean;
		membershipToPending: boolean;
		foreignTip: boolean;
	};
};

/**
 * The fact rules for one reported outcome: monotonic evidence; on a new
 * establishment `factsRevision` + 1, `headSha` by compare-and-set on
 * `headExecutionSeq` (a late fact about an older operation never regresses
 * it), the first append's `startSha` (`parentSha`, or the proposal's base
 * commit for the create-only push), PENDING -> OPENING, and a terminal
 * branch's settled membership back to `pending`. `foreignTipAt` is
 * monotonic: set once, never cleared.
 */
export function planOutcomeFact(i: {
	op: {
		kind: "APPEND" | "REVERT";
		executionSeq: number;
		sha: string;
		parentSha: string | null;
		outcome: OpOutcome;
	};
	branch: {
		state: BranchState;
		headExecutionSeq: number;
		startSha: string | null;
		membership: unknown;
		foreignTipAt: Date | null;
	};
	outcome: Exclude<OpOutcome, null>;
	foreignTip: boolean;
	baseCommitSha: string | null;
	now: Date;
}): OutcomeFactPlan {
	const move = outcomeTransition(i.op.outcome, i.outcome);
	const apply = move === "apply";
	const established =
		apply && !isEstablished(i.op) && isEstablished({ outcome: i.outcome });
	const status = membershipStatusOf(i.branch.membership);
	return {
		apply,
		refused: move === "refuse",
		established,
		op: apply
			? {
					outcome: i.outcome,
					...(i.outcome === "acked" ? { pushAckedAt: i.now } : {}),
					...(i.outcome === "observed" ? { observedAt: i.now } : {}),
				}
			: {},
		branch: {
			factsRevisionIncrement: established,
			head:
				established && i.op.executionSeq > i.branch.headExecutionSeq
					? { sha: i.op.sha, executionSeq: i.op.executionSeq }
					: null,
			startSha:
				established &&
				i.op.kind === "APPEND" &&
				i.branch.startSha === null
					? (i.op.parentSha ?? i.baseCommitSha)
					: null,
			pendingToOpening:
				established &&
				i.op.kind === "APPEND" &&
				i.branch.state === "PENDING",
			membershipToPending:
				established &&
				isTerminalBranchState(i.branch.state) &&
				(status === "done" || status === "unverified"),
			foreignTip: i.foreignTip && i.branch.foreignTipAt === null,
		},
	};
}

// ---------------------------------------------------------------------------
// The branch projection (spec §10 "Editor")
// ---------------------------------------------------------------------------

export type BranchProjectionEntry = {
	path: string;
	state: "written" | "deleted" | "restored_unavailable";
	sha256: string | null;
	snapshotId: string | null;
};

export type ProjectionOp = {
	kind: "APPEND" | "REVERT";
	executionSeq: number;
	outcome: OpOutcome;
	entries: readonly BranchOperationEntryRecord[];
};

/**
 * What the member's branch holds per path, from established operations only,
 * in `executionSeq` order (spec §10). An append's `after` is `written` from
 * its `afterSource` (`deleted` when null). A revert restores `before`:
 * `deleted` when null, `written` from `beforeSource` when Fabric holds those
 * bytes, `restored_unavailable` when it does not (a start version Fabric
 * never stored). A restored write's hash is the one Fabric recorded when it
 * wrote that same object, when it did. Issued, `unknown` and `not_pushed`
 * operations are not on the branch as far as Fabric can prove.
 */
export function projectEntries(
	ops: readonly ProjectionOp[],
): BranchProjectionEntry[] {
	const byPath = new Map<string, BranchProjectionEntry>();
	/** sha256 by object id, from every established write that recorded one. */
	const hashes = new Map<string, string>();
	const established = ops
		.filter((op) => isEstablished(op))
		.sort((a, b) => a.executionSeq - b.executionSeq);
	for (const op of established) {
		for (const e of op.entries) {
			const [entry, source] =
				op.kind === "APPEND"
					? [e.after, e.afterSource]
					: [e.before, e.beforeSource];
			if (op.kind === "APPEND" && e.after !== null && e.afterSha256) {
				hashes.set(e.after.oid, e.afterSha256);
			}
			if (entry === null) {
				byPath.set(e.path, {
					path: e.path,
					state: "deleted",
					sha256: null,
					snapshotId: null,
				});
			} else if (source === null) {
				byPath.set(e.path, {
					path: e.path,
					state: "restored_unavailable",
					sha256: null,
					snapshotId: null,
				});
			} else {
				byPath.set(e.path, {
					path: e.path,
					state: "written",
					sha256:
						op.kind === "APPEND"
							? e.afterSha256
							: (hashes.get(entry.oid) ?? null),
					snapshotId: source,
				});
			}
		}
	}
	return [...byPath.values()].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

function parseTreeEntry(value: unknown): BranchTreeEntry | null | undefined {
	if (value === null) {
		return null;
	}
	if (typeof value !== "object") {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	if (
		(v.type === "blob" || v.type === "symlink" || v.type === "gitlink") &&
		nonEmptyString(v.mode) &&
		nonEmptyString(v.oid)
	) {
		return { type: v.type, mode: v.mode, oid: v.oid };
	}
	return undefined;
}

const nullableString = (v: unknown): string | null | undefined =>
	v === null ? null : typeof v === "string" ? v : undefined;

/** A stored `entries` column, keeping only well-formed entries. */
export function parseOperationEntries(
	value: unknown,
): BranchOperationEntryRecord[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: BranchOperationEntryRecord[] = [];
	for (const raw of value) {
		if (raw === null || typeof raw !== "object") {
			continue;
		}
		const r = raw as Record<string, unknown>;
		const before = parseTreeEntry(r.before);
		const after = parseTreeEntry(r.after);
		const afterSha256 = nullableString(r.afterSha256);
		const afterSource = nullableString(r.afterSource);
		const beforeSource = nullableString(r.beforeSource);
		if (
			!nonEmptyString(r.path) ||
			!nonEmptyString(r.rawPath) ||
			before === undefined ||
			after === undefined ||
			afterSha256 === undefined ||
			afterSource === undefined ||
			beforeSource === undefined
		) {
			continue;
		}
		out.push({
			path: r.path,
			rawPath: r.rawPath,
			before,
			after,
			afterSha256,
			afterSource,
			beforeSource,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// The loop's next item (spec §6)
// ---------------------------------------------------------------------------

export type BranchWork =
	| { kind: "recover"; operationId: string }
	| { kind: "confirm" }
	| { kind: "close" }
	| { kind: "release" }
	| { kind: "classify"; factsRevision: number }
	| { kind: "rehome"; snapshotIds: string[] }
	/** The proposal's attempt, which the revert fences on (spec §6 "Activities"). */
	| { kind: "revert"; snapshotId: string; proposalAttempt: number }
	| { kind: "retry" }
	| { kind: "lookup" }
	| { kind: "create" }
	| { kind: "append" }
	| { kind: "wait"; snapshotId: string }
	| { kind: "idle"; wakeAt: Date | null };

/**
 * The non-retryable pre-create refusals `release` answers (spec §4.4
 * "Release", §6.5): the creation checks' own verdicts. `REPOSITORY_CHANGED`
 * is not among them: Fabric can no longer reach that repository, so the
 * member's Stop tracking is its only way out (spec Decision 19).
 */
const PRE_CREATE_REFUSALS = new Set([
	"PERMISSION_REVOKED",
	"CONFIGURATION_CHANGED",
]);

/** What `decideBranchWork` reads. */
export type BranchWorkInput = {
	branch: Pick<
		BranchRow,
		| "id"
		| "state"
		| "untracked"
		| "retiredAt"
		| "failure"
		| "closeIntent"
		| "createIssuedAt"
		| "pullRequestExternalId"
		| "headSha"
		| "membership"
		| "confirmationDueAt"
		| "nextAttemptAt"
		| "retryRequestedAt"
		| "settledAt"
		| "deletedAt"
		| "factsRevision"
	>;
	/** Every journal operation on the branch. */
	ops: ReadonlyArray<EvidenceOp & { snapshotId: string }>;
	/** Every non-terminal proposal on the branch, with its assignment and attempt. */
	proposals: ReadonlyArray<
		BranchQueueEntry & { assignment: number; attempt: number }
	>;
	now: Date;
};

/** §4.4 "Release": BLOCKED on a pre-create refusal with a head, no receipt, no marker. */
export function isReleasableBranch(b: BranchWorkInput["branch"]): boolean {
	const f = failureOf(b.failure);
	return (
		b.state === "BLOCKED" &&
		f.retryable === false &&
		f.code !== null &&
		PRE_CREATE_REFUSALS.has(f.code) &&
		b.headSha !== null &&
		b.pullRequestExternalId === null &&
		b.createIssuedAt === null
	);
}

/**
 * §4.3 "Rehome", in sequence order: QUEUED or BLOCKED in phase append, on a
 * terminal or retired branch, with intent, whose issued operations on this
 * branch are all `not_pushed` (or none); and any live proposal of a branch
 * whose START_OVER settlement deleted its ref.
 *
 * Two states the §4.3 row does not name are taken too, because nothing else
 * would ever move them once the branch stops accepting appends: an OPENING
 * claim whose append stopped before it issued anything (the append answers
 * `stopped` when the branch no longer accepts appends), and a retryable
 * BLOCKED proposal in phase validation (the 6 h VALIDATION_TIMEOUT), which
 * only a claim on an accepting branch takes.
 */
export function rehomableProposals(input: BranchWorkInput): string[] {
	const b = input.branch;
	const settled = isTerminalBranchState(b.state) || b.retiredAt !== null;
	const startedOver = b.closeIntent === "START_OVER" && b.deletedAt !== null;
	if (!settled && !startedOver) {
		return [];
	}
	return [...input.proposals]
		.filter((p) => p.sequence !== null)
		.sort((a, c) => (a.sequence as number) - (c.sequence as number))
		.filter((p) => {
			if (p.withdrawRequestedAt !== null) {
				return false;
			}
			const own = input.ops.filter(
				(op) => op.snapshotId === p.snapshotId,
			);
			const f = failureOf(p.failure);
			const rehomableHere =
				settled &&
				(p.state === "QUEUED" ||
					p.state === "OPENING" ||
					(p.state === "BLOCKED" &&
						(f.phase === "append" ||
							(f.phase === "validation" &&
								f.retryable === true)))) &&
				own.every((op) => op.outcome === "not_pushed");
			return (
				rehomableHere ||
				(startedOver &&
					isLiveProposal({
						state: p.state,
						failure: p.failure,
						withdrawRequestedAt: p.withdrawRequestedAt,
						ops: own,
						branchId: b.id,
						assignment: p.assignment,
					}))
			);
		})
		.map((p) => p.snapshotId);
}

function earliest(dates: ReadonlyArray<Date | null>): Date | null {
	let best: Date | null = null;
	for (const d of dates) {
		if (d !== null && (best === null || d.getTime() < best.getTime())) {
			best = d;
		}
	}
	return best;
}

/**
 * The first applicable loop item, in the spec's fixed precedence (§6):
 * recover, confirm, close, release, classify, rehome, revert, retry, lookup,
 * create, append, wait, idle. Pure: `nextBranchWork` reads the rows.
 *
 * `create` also takes a due, retryable create-phase BLOCKED branch (and waits
 * for a not-yet-due OPENING one): nothing else in the loop re-attempts a
 * create whose failure was retryable.
 *
 * Due-ness. An item whose own activity answered with a backoff waits for it,
 * so a failure never turns the loop into a hot loop: close and release wait
 * for the branch's `nextAttemptAt` (settlement and release failures are
 * failure-only with a backoff), and hold every later item meanwhile, because
 * the branch is settling; classify waits for its membership's own
 * `nextAttemptAt` (the history could not be fetched); a revert waits for its
 * proposal's `nextAttemptAt` (a retryable revert failure). `retry` needs no
 * clock: every answer to a Retry opening consumes `retryRequestedAt`. The
 * idle timer is the earliest of every such time.
 */
export function decideBranchWork(input: BranchWorkInput): BranchWork {
	const { branch: b, now } = input;
	if (b.untracked) {
		return { kind: "idle", wakeAt: null };
	}
	const terminal = isTerminalBranchState(b.state);
	// 1. An issued operation with no outcome: dependent work never runs on
	// an uncertain push.
	const issued = input.ops
		.filter((op) => op.outcome === null)
		.sort((a, c) => a.executionSeq - c.executionSeq)[0];
	if (issued) {
		return { kind: "recover", operationId: issued.id };
	}
	// 2. Due settlement confirmations are never starved.
	if (b.confirmationDueAt !== null && isDue(b.confirmationDueAt, now)) {
		return { kind: "confirm" };
	}
	// 3. Close. Settlement does its own lookup, so a create marker never
	// delays it; only its own backoff does.
	if (b.state === "CLOSE_REQUESTED") {
		return isDue(b.nextAttemptAt, now)
			? { kind: "close" }
			: {
					kind: "idle",
					wakeAt: earliest([b.nextAttemptAt, b.confirmationDueAt]),
				};
	}
	// 4. Release, after its own backoff.
	if (isReleasableBranch(b)) {
		return isDue(b.nextAttemptAt, now)
			? { kind: "release" }
			: {
					kind: "idle",
					wakeAt: earliest([b.nextAttemptAt, b.confirmationDueAt]),
				};
	}
	// 5. Classify: membership pending (no operation lacks an outcome, by 1),
	// once its backoff is due.
	const classifyAt =
		membershipStatusOf(b.membership) === "pending"
			? membershipNextAttemptAt(b.membership)
			: null;
	if (
		membershipStatusOf(b.membership) === "pending" &&
		isDue(classifyAt, now)
	) {
		return { kind: "classify", factsRevision: b.factsRevision };
	}
	// 6. Rehome.
	const rehome = rehomableProposals(input);
	if (rehome.length > 0) {
		return { kind: "rehome", snapshotIds: rehome };
	}
	// 7. Revert: the lowest CLOSE_REQUESTED proposal, once its backoff is due.
	const revert = terminal
		? undefined
		: [...input.proposals]
				.filter(
					(p) => p.state === "CLOSE_REQUESTED" && p.sequence !== null,
				)
				.sort(
					(a, c) => (a.sequence as number) - (c.sequence as number),
				)[0];
	if (revert && isDue(revert.nextAttemptAt, now)) {
		return {
			kind: "revert",
			snapshotId: revert.snapshotId,
			proposalAttempt: revert.attempt,
		};
	}
	const failure = failureOf(b.failure);
	// 8. Retry opening, persisted, on a PR_CREATION_REFUSED branch.
	if (
		b.retryRequestedAt !== null &&
		b.state === "BLOCKED" &&
		failure.code === "PR_CREATION_REFUSED"
	) {
		return { kind: "retry" };
	}
	// 9. Lookup: a create marker without a receipt, due by its backoff.
	const markerOutstanding =
		!terminal &&
		b.createIssuedAt !== null &&
		b.pullRequestExternalId === null &&
		b.settledAt === null;
	if (markerOutstanding && isDue(b.nextAttemptAt, now)) {
		return { kind: "lookup" };
	}
	// 10. Create: an established head, no receipt and no marker.
	const createPending =
		b.headSha !== null &&
		b.pullRequestExternalId === null &&
		b.createIssuedAt === null &&
		(b.state === "OPENING" ||
			(b.state === "BLOCKED" &&
				failure.retryable === true &&
				failure.phase === "create"));
	if (createPending && isDue(b.nextAttemptAt, now)) {
		return { kind: "create" };
	}
	// 11-12. Append the runnable head, or wait for it to validate.
	if (acceptsAppends(b)) {
		const head = pickRunnableHead(input.proposals, now);
		if (head.kind === "claim") {
			return { kind: "append" };
		}
		if (head.kind === "wait") {
			return { kind: "wait", snapshotId: head.snapshotId };
		}
	}
	// 13. Idle, or a timer until the earliest due lookup, confirmation,
	// pending create, classification or revert.
	return {
		kind: "idle",
		wakeAt: earliest([
			b.confirmationDueAt,
			markerOutstanding ? b.nextAttemptAt : null,
			createPending ? b.nextAttemptAt : null,
			classifyAt,
			revert ? revert.nextAttemptAt : null,
		]),
	};
}

// ---------------------------------------------------------------------------
// Transactions, locks and retries (spec §4.7)
// ---------------------------------------------------------------------------

const TRANSACTION_RETRIES = 3;

function errorCodes(error: unknown): string[] {
	const codes: string[] = [];
	let current: unknown = error;
	for (
		let depth = 0;
		depth < 6 && current && typeof current === "object";
		depth++
	) {
		const e = current as {
			code?: unknown;
			originalCode?: unknown;
			meta?: { code?: unknown; driverAdapterError?: unknown };
			cause?: unknown;
		};
		for (const c of [e.code, e.originalCode, e.meta?.code]) {
			if (typeof c === "string") {
				codes.push(c);
			}
		}
		current = e.cause ?? e.meta?.driverAdapterError;
	}
	return codes;
}

/**
 * A serialization failure or a deadlock, however the driver adapter surfaces
 * it: Postgres `40001`/`40P01`, Prisma's `P2034` write conflict, or the
 * message when the code was lost.
 */
export function isRetryableTransactionError(error: unknown): boolean {
	if (
		errorCodes(error).some((c) =>
			["40001", "40P01", "P2034", "TransactionWriteConflict"].includes(c),
		)
	) {
		return true;
	}
	const message = error instanceof Error ? error.message : "";
	return (
		message.includes("deadlock detected") ||
		message.includes("could not serialize access")
	);
}

async function withTransactionRetry<T>(
	run: () => Promise<T>,
	retryable: (error: unknown) => boolean = isRetryableTransactionError,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt < TRANSACTION_RETRIES && retryable(error)) {
				continue;
			}
			throw error;
		}
	}
}

/**
 * Runs `fn` in one transaction after taking the §4.7 locks in order: the
 * sync row `FOR SHARE`, the branches by id, the proposals by id. A
 * serialization or deadlock failure retries the whole transaction up to
 * three times, so `fn` must be safe to re-run.
 */
export async function withBranchLockOrder<T>(
	i: {
		organizationId: string;
		syncId?: string;
		branchIds: string[];
		snapshotIds: string[];
	},
	fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	const branchIds = [...new Set(i.branchIds)].sort();
	const snapshotIds = [...new Set(i.snapshotIds)].sort();
	return withTransactionRetry(() =>
		db.$transaction(async (tx) => {
			if (i.syncId !== undefined) {
				await tx.$queryRaw`
					SELECT "id" FROM "project_instruction_repository_sync"
					WHERE "id" = ${i.syncId} AND "organizationId" = ${i.organizationId}
					FOR SHARE`;
			}
			if (branchIds.length > 0) {
				await tx.$queryRaw`
					SELECT "id" FROM "project_instruction_proposal_branch"
					WHERE "id" = ANY(${branchIds}::text[]) AND "organizationId" = ${i.organizationId}
					ORDER BY "id" FOR UPDATE`;
			}
			if (snapshotIds.length > 0) {
				await tx.$queryRaw`
					SELECT "id" FROM "project_instruction_snapshot"
					WHERE "id" = ANY(${snapshotIds}::text[]) AND "organizationId" = ${i.organizationId}
					ORDER BY "id" FOR UPDATE`;
			}
			return fn(tx);
		}),
	);
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
	const [row] = await tx.$queryRaw<
		Array<{ now: Date }>
	>`SELECT (now() AT TIME ZONE 'UTC') AS "now"`;
	return row?.now ?? new Date();
}

async function lockBranch(
	tx: Prisma.TransactionClient,
	branchId: string,
	organizationId: string,
): Promise<BranchRow | null> {
	const locked = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "project_instruction_proposal_branch"
		WHERE "id" = ${branchId} AND "organizationId" = ${organizationId}
		FOR UPDATE`;
	if (locked.length === 0) {
		return null;
	}
	return tx.projectInstructionProposalBranch.findFirst({
		where: { id: branchId, organizationId },
	});
}

const PROPOSAL_SELECT = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	version: true,
	status: true,
	proposalStatus: true,
	proposalDestination: true,
	pullRequestOperationId: true,
	pullRequestState: true,
	pullRequestAttempt: true,
	pullRequestContext: true,
	pullRequestFailure: true,
	pullRequestNextAttemptAt: true,
	proposalBranchId: true,
	proposalBranchSequence: true,
	proposalAssignment: true,
	proposalIntentOrder: true,
	withdrawRequestedAt: true,
	withdrawScope: true,
	pendingCommand: true,
	pendingCommandSeq: true,
} satisfies Prisma.ProjectInstructionSnapshotSelect;

type ProposalRow = Prisma.ProjectInstructionSnapshotGetPayload<{
	select: typeof PROPOSAL_SELECT;
}>;

function readProposal(
	client: Prisma.TransactionClient,
	snapshotId: string,
	organizationId: string,
): Promise<ProposalRow | null> {
	return client.projectInstructionSnapshot.findFirst({
		where: { id: snapshotId, organizationId },
		select: PROPOSAL_SELECT,
	});
}

async function lockProposal(
	tx: Prisma.TransactionClient,
	snapshotId: string,
	organizationId: string,
): Promise<ProposalRow | null> {
	const locked = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "project_instruction_snapshot"
		WHERE "id" = ${snapshotId} AND "organizationId" = ${organizationId}
		FOR UPDATE`;
	return locked.length === 0
		? null
		: readProposal(tx, snapshotId, organizationId);
}

function isV2Context(context: unknown): boolean {
	return (
		context !== null &&
		typeof context === "object" &&
		(context as { v?: unknown }).v === 2
	);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const BRANCH_UPDATED = "project.instructions.pull_request_branch_updated";

/**
 * `pull_request_branch_updated` (spec Decision 20): every established push,
 * and a branch retired or no longer tracked. Branch id, operation id and
 * codes only; never a URL, and the resource name is the branch number, not
 * its ref, which carries the member's name.
 */
function branchUpdatedAudit(
	branch: Pick<BranchRow, "id" | "projectId" | "number">,
	organizationId: string,
	actorUserId: string | null,
	metadata: Record<string, unknown>,
): RecordAuditInput {
	return {
		action: BRANCH_UPDATED,
		category: "project",
		actor:
			actorUserId === null
				? { type: "system" }
				: { type: "user", userId: actorUserId },
		organizationId,
		projectId: branch.projectId,
		resource: {
			type: "project_instruction_proposal_branch",
			id: branch.id,
			name: `#${branch.number}`,
		},
		metadata: { branchId: branch.id, ...metadata },
	};
}

// ---------------------------------------------------------------------------
// Ref reservation (spec Decision 3)
// ---------------------------------------------------------------------------

/** How many consecutive numbers one reservation probes before giving up. */
const MAX_REF_PROBES = 1000;
/** The fifth refused create-only push is BRANCH_NAME_UNAVAILABLE (spec §6.4 step 9). */
export const MAX_REFUSED_BRANCH_REFS = 5;
const MEMBER_REF_PREFIX = "fabric/instructions/members/";

/**
 * Reserves the first free candidate ref from `startN` on: a permanent
 * `(repositoryKey, ref)` row, never deleted and never reused, so two
 * lifecycles in any project or of any member never share a physical ref. A
 * reservation conflict takes the next number. `ON CONFLICT DO NOTHING`, so a
 * taken number never aborts the caller's transaction.
 */
export async function reserveNextRef(
	tx: Prisma.TransactionClient,
	i: {
		branchId: string;
		organizationId: string;
		repositoryKey: string;
		displayName: string | null;
		userId: string;
		startN: number;
		naming: Pick<ProposalBranchNaming, "memberBranchRef">;
	},
): Promise<{ ref: string; n: number }> {
	const start = Math.max(1, Math.trunc(i.startN));
	for (let n = start; n < start + MAX_REF_PROBES; n++) {
		const ref = i.naming.memberBranchRef({
			displayName: i.displayName,
			userId: i.userId,
			n,
		});
		if (!ref.startsWith(MEMBER_REF_PREFIX)) {
			throw new Error(
				"A member branch ref must be under the members/ prefix",
			);
		}
		const rows = await tx.$queryRaw<Array<{ id: string }>>`
			INSERT INTO "project_instruction_proposal_ref_reservation"
				("id", "organizationId", "repositoryKey", "ref", "branchId", "status", "createdAt")
			VALUES (${createId()}, ${i.organizationId}, ${i.repositoryKey}, ${ref}, ${i.branchId}, 'current', (now() AT TIME ZONE 'UTC'))
			ON CONFLICT ("repositoryKey", "ref") DO NOTHING
			RETURNING "id"`;
		if (rows.length === 1) {
			return { ref, n };
		}
	}
	throw new Error(
		`No free member branch ref after ${MAX_REF_PROBES} candidates`,
	);
}

/** The `<n>` of a member branch ref. */
function refNumber(ref: string): number {
	const n = Number(ref.slice(ref.lastIndexOf("/") + 1));
	return Number.isInteger(n) && n > 0 ? n : 0;
}

async function displayNameOf(
	tx: Prisma.TransactionClient,
	userId: string,
): Promise<string | null> {
	const user = await tx.user.findFirst({
		where: { id: userId },
		select: { name: true },
	});
	return user?.name ?? null;
}

/**
 * A create-only push to the branch's provisional ref was refused because the
 * ref exists (spec Decision 3, §6.4 step 9): its reservation is marked
 * `refused` (kept forever), and the branch takes the next free number. Only
 * while the branch has no established head. `exhausted` once
 * `MAX_REFUSED_BRANCH_REFS` numbers were refused; the caller writes
 * BRANCH_NAME_UNAVAILABLE.
 */
export async function refuseCurrentRef(i: {
	branchId: string;
	organizationId: string;
	naming: Pick<ProposalBranchNaming, "memberBranchRef">;
}): Promise<{ ref: string } | { exhausted: true } | { notProvisional: true }> {
	return withTransactionRetry(() =>
		db.$transaction(async (tx) => {
			const branch = await lockBranch(tx, i.branchId, i.organizationId);
			if (
				!branch ||
				branch.headSha !== null ||
				branch.untracked ||
				isTerminalBranchState(branch.state)
			) {
				return { notProvisional: true as const };
			}
			await tx.projectInstructionProposalRefReservation.updateMany({
				where: {
					organizationId: i.organizationId,
					repositoryKey: branch.repositoryKey,
					ref: branch.ref,
					branchId: branch.id,
					status: "current",
				},
				data: { status: "refused" },
			});
			const refused =
				await tx.projectInstructionProposalRefReservation.count({
					where: {
						organizationId: i.organizationId,
						branchId: branch.id,
						status: "refused",
					},
				});
			if (refused >= MAX_REFUSED_BRANCH_REFS) {
				return { exhausted: true as const };
			}
			const { ref } = await reserveNextRef(tx, {
				branchId: branch.id,
				organizationId: i.organizationId,
				repositoryKey: branch.repositoryKey,
				displayName: await displayNameOf(tx, branch.userId),
				userId: branch.userId,
				startN: refNumber(branch.ref) + 1,
				naming: i.naming,
			});
			await tx.projectInstructionProposalBranch.updateMany({
				where: {
					id: branch.id,
					organizationId: i.organizationId,
					headSha: null,
				},
				data: { ref },
			});
			return { ref };
		}),
	);
}

// ---------------------------------------------------------------------------
// Join and transfer (spec §5)
// ---------------------------------------------------------------------------

export type JoinResult =
	| { kind: "joined"; branchId: string; sequence: number; assignment: number }
	| {
			kind: "already";
			branchId: string;
			sequence: number;
			assignment: number;
	  }
	| { kind: "not_joinable" }
	| { kind: "configuration_changed" };

/** Rolls the transaction back and answers `result`. */
class JoinAnswer extends Error {
	constructor(readonly result: JoinResult) {
		super("join answered");
	}
}

/** The whole join races another (the accepting index, a branch number): retry it. */
class JoinRace extends Error {
	constructor() {
		super("join raced another join");
	}
}

const joinRetryable = (error: unknown) =>
	error instanceof JoinRace || isRetryableTransactionError(error);

async function runJoin(
	body: (tx: Prisma.TransactionClient) => Promise<JoinResult>,
): Promise<JoinResult> {
	try {
		return await withTransactionRetry(
			() => db.$transaction((tx) => body(tx)),
			joinRetryable,
		);
	} catch (error) {
		if (error instanceof JoinAnswer) {
			return error.result;
		}
		throw error;
	}
}

type SyncDestinationRow = {
	id: string;
	repositoryIntegrationId: string;
	ref: string;
	rootPath: string;
	integrationProjectId: string | null;
	provider: string | null;
	repositoryUrl: string | null;
	sourceOfTruth: string | null;
};

/**
 * The project's current destination, with its sync row locked `FOR SHARE`
 * (§4.7 step 1). While a move from uploads into the repository is
 * `PROPOSING` (Fizzy #2878 §9) its sync row is the destination although
 * `sourceOfTruth` is still UPLOAD: the move's pull request is a member
 * branch proposal like any other. The pointer must name this very row, so a
 * stale pointer never lends a destination to another one.
 */
async function lockCurrentDestination(
	tx: Prisma.TransactionClient,
	i: { projectId: string; organizationId: string },
	naming: ProposalBranchNaming,
): Promise<BranchDestinationRecord | null> {
	const [sync] = await tx.$queryRaw<SyncDestinationRow[]>`
		SELECT s."id", s."repositoryIntegrationId", s."ref", s."rootPath",
			ri."projectId" AS "integrationProjectId", ri."provider"::text AS "provider",
			ri."repositoryUrl",
			CASE
				WHEN p."instructionSettings"->'migration'->>'state' = 'PROPOSING'
					AND p."instructionSettings"->'migration'->>'syncId' = s."id"
				THEN 'REPOSITORY'
				ELSE p."instructionSettings"->>'sourceOfTruth'
			END AS "sourceOfTruth"
		FROM "project_instruction_repository_sync" s
		JOIN "project" p ON p."id" = s."projectId"
		LEFT JOIN "project_repository_integration" ri ON ri."id" = s."repositoryIntegrationId"
		WHERE s."projectId" = ${i.projectId} AND s."organizationId" = ${i.organizationId}
		FOR SHARE OF s`;
	if (!sync) {
		return null;
	}
	return currentDestination(
		{
			projectId: i.projectId,
			sourceOfTruth: sync.sourceOfTruth,
			sync: {
				id: sync.id,
				repositoryIntegrationId: sync.repositoryIntegrationId,
				ref: sync.ref,
				rootPath: sync.rootPath,
			},
			integration:
				sync.integrationProjectId !== null &&
				sync.provider !== null &&
				sync.repositoryUrl !== null
					? {
							projectId: sync.integrationProjectId,
							provider: sync.provider,
							repositoryUrl: sync.repositoryUrl,
						}
					: null,
		},
		naming,
	);
}

function acceptingWhere(i: {
	projectId: string;
	userId: string;
	organizationId: string;
}): Prisma.ProjectInstructionProposalBranchWhereInput {
	return {
		projectId: i.projectId,
		userId: i.userId,
		organizationId: i.organizationId,
		retiredAt: null,
		untracked: false,
		state: { in: [...ACCEPTING_BRANCH_STATES] },
	};
}

/** The accepting branch's id, read without a lock. */
async function acceptingBranchId(
	tx: Prisma.TransactionClient,
	member: { projectId: string; userId: string; organizationId: string },
): Promise<string | null> {
	const row = await tx.projectInstructionProposalBranch.findFirst({
		where: acceptingWhere(member),
		select: { id: true },
	});
	return row?.id ?? null;
}

/** The accepting branch, locked by the partial index's own predicate. */
async function lockAcceptingBranch(
	tx: Prisma.TransactionClient,
	member: { projectId: string; userId: string; organizationId: string },
): Promise<BranchRow | null> {
	const [row] = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "project_instruction_proposal_branch"
		WHERE "projectId" = ${member.projectId} AND "userId" = ${member.userId}
			AND "organizationId" = ${member.organizationId}
			AND "retiredAt" IS NULL AND NOT "untracked"
			AND "state" IN ('PENDING', 'OPENING', 'OPEN', 'BLOCKED')
		FOR UPDATE`;
	if (!row) {
		return null;
	}
	return tx.projectInstructionProposalBranch.findFirst({
		where: { id: row.id, organizationId: member.organizationId },
	});
}

/**
 * Creates the member's next branch with a freshly reserved ref and the
 * frozen destination. A unique violation on the accepting index or on the
 * member's branch number means another join won: `JoinRace` rolls this
 * transaction back and the whole join is retried.
 */
async function createBranch(
	tx: Prisma.TransactionClient,
	i: {
		projectId: string;
		userId: string;
		organizationId: string;
		destination: BranchDestinationRecord;
		naming: ProposalBranchNaming;
	},
): Promise<BranchRow> {
	const [numbered] = await tx.$queryRaw<Array<{ next: number }>>`
		SELECT (COALESCE(MAX("number"), 0) + 1)::int AS "next"
		FROM "project_instruction_proposal_branch"
		WHERE "projectId" = ${i.projectId} AND "userId" = ${i.userId}`;
	const number = Number(numbered?.next ?? 1);
	const id = createId();
	const { ref } = await reserveNextRef(tx, {
		branchId: id,
		organizationId: i.organizationId,
		repositoryKey: i.destination.repositoryKey,
		displayName: await displayNameOf(tx, i.userId),
		userId: i.userId,
		startN: number,
		naming: i.naming,
	});
	const inserted = await tx.$queryRaw<Array<{ id: string }>>`
		INSERT INTO "project_instruction_proposal_branch"
			("id", "organizationId", "projectId", "userId", "repositoryKey", "number", "ref",
			 "destination", "createdAt", "updatedAt")
		VALUES (${id}, ${i.organizationId}, ${i.projectId}, ${i.userId}, ${i.destination.repositoryKey},
			${number}, ${ref}, ${JSON.stringify(i.destination)}::jsonb,
			(now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
		ON CONFLICT DO NOTHING
		RETURNING "id"`;
	if (inserted.length !== 1) {
		throw new JoinRace();
	}
	const row = await tx.projectInstructionProposalBranch.findFirst({
		where: { id, organizationId: i.organizationId },
	});
	if (!row) {
		throw new Error(
			"A proposal branch vanished inside its own transaction",
		);
	}
	return row;
}

/**
 * Retires a branch (spec §4.4 "Retire"): it keeps its state and pull
 * request, which is still observed, but stops accepting proposals. Only in a
 * join transaction holding the sync row lock that has just read a different
 * current destination (`CONFIGURATION_CHANGED`), or by the append that found
 * a recorded head's ref absent (`BRANCH_MISSING`). Its reservation becomes
 * `retired`. True when this call retired it.
 */
export async function retireBranch(
	tx: Prisma.TransactionClient,
	i: {
		branchId: string;
		organizationId: string;
		reason: "CONFIGURATION_CHANGED" | "BRANCH_MISSING";
	},
): Promise<boolean> {
	const now = await databaseNow(tx);
	const { count } = await tx.projectInstructionProposalBranch.updateMany({
		where: {
			id: i.branchId,
			organizationId: i.organizationId,
			retiredAt: null,
			untracked: false,
			state: { in: [...ACCEPTING_BRANCH_STATES] },
		},
		data: { retiredAt: now, retiredReason: i.reason },
	});
	if (count !== 1) {
		return false;
	}
	const branch = await tx.projectInstructionProposalBranch.findFirst({
		where: { id: i.branchId, organizationId: i.organizationId },
		select: {
			id: true,
			projectId: true,
			number: true,
			repositoryKey: true,
			ref: true,
		},
	});
	if (branch) {
		await tx.projectInstructionProposalRefReservation.updateMany({
			where: {
				organizationId: i.organizationId,
				repositoryKey: branch.repositoryKey,
				ref: branch.ref,
				branchId: branch.id,
				status: "current",
			},
			data: { status: "retired" },
		});
		await recordAuditTx(
			tx,
			branchUpdatedAudit(branch, i.organizationId, null, {
				change: "retired",
				reason: i.reason,
			}),
		);
	}
	return true;
}

/**
 * The branch a joining proposal goes to (§5 steps 3-4), under the accepting
 * branch's lock: the accepting branch when its destination is the current
 * one, otherwise that branch retired and the next one created; a new one
 * when there is none.
 */
async function targetBranch(
	tx: Prisma.TransactionClient,
	accepting: BranchRow | null,
	i: {
		projectId: string;
		userId: string;
		organizationId: string;
		destination: BranchDestinationRecord;
		naming: ProposalBranchNaming;
	},
): Promise<BranchRow> {
	if (accepting) {
		const frozen = parseBranchDestination(accepting.destination);
		if (frozen && sameBranchDestination(frozen, i.destination)) {
			return accepting;
		}
		// The sync row lock this transaction holds makes the comparison
		// current (spec Decision 15).
		await retireBranch(tx, {
			branchId: accepting.id,
			organizationId: i.organizationId,
			reason: "CONFIGURATION_CHANGED",
		});
	}
	return createBranch(tx, i);
}

function configurationChangedFailure(now: Date): PullRequestFailure {
	return {
		phase: "admission",
		code: "CONFIGURATION_CHANGED",
		retryable: false,
		at: now.toISOString(),
		params: {},
	};
}

/**
 * Takes the next sequence on `target` for `proposal` (§5 step 5) with the
 * given event: `branch_join` keeps QUEUED, `branch_transfer` makes it QUEUED
 * with its failure and pending command cleared (the command's sequence
 * belongs to the old branch). `proposalAssignment` + 1; `proposalIntentOrder`
 * only when `intentOrder` is given (Propose again).
 */
async function assignToBranch(
	tx: Prisma.TransactionClient,
	proposal: ProposalRow & { pullRequestState: ProposalState },
	target: BranchRow,
	o: {
		organizationId: string;
		event: "branch_join" | "branch_transfer";
		intentOrder?: bigint;
	},
): Promise<JoinResult> {
	const sequence = target.nextSequence;
	const assignment = proposal.proposalAssignment + 1;
	const moved = await transitionPullRequest(
		{
			snapshotId: proposal.id,
			organizationId: o.organizationId,
			event: o.event,
			from: [proposal.pullRequestState],
			expectedAttempt: proposal.pullRequestAttempt,
			to: o.event === "branch_join" ? "unchanged" : "QUEUED",
			bumpAttempt: o.event === "branch_transfer",
			data: {
				proposalBranchId: target.id,
				proposalBranchSequence: sequence,
				proposalAssignment: assignment,
				...(o.event === "branch_transfer"
					? {
							pullRequestFailure: null,
							pullRequestNextAttemptAt: null,
							pendingCommand: null,
							pendingCommandSeq: null,
						}
					: {}),
				...(o.intentOrder !== undefined
					? { proposalIntentOrder: o.intentOrder }
					: {}),
			},
		},
		tx,
	);
	if (!moved.ok) {
		// Under the proposal lock and re-check this cannot lose a race.
		throw new Error(`Proposal ${o.event} found no transition`);
	}
	await tx.projectInstructionProposalBranch.updateMany({
		where: { id: target.id, organizationId: o.organizationId },
		data: { nextSequence: { increment: 1 } },
	});
	return { kind: "joined", branchId: target.id, sequence, assignment };
}

/**
 * `joinProposalBranch` (spec §5): idempotent, used by admission's start and
 * by the sweeper's Attach. Lock order §4.7.
 *
 * 1. A proposal that has a branch returns that assignment; one that is not
 *    QUEUED with a v2 context is `not_joinable`.
 * 2. Under the sync row lock, a proposal whose frozen destination is not the
 *    current one becomes BLOCKED CONFIGURATION_CHANGED. It never retires
 *    anything.
 * 3. The member's accepting branch (locked): used when its destination is
 *    the proposal's; otherwise retired, and the next one created.
 * 4. A new branch reserves its ref; a unique violation on the accepting
 *    index rolls back and the whole join is retried.
 * 5. The proposal is locked and re-checked, then takes the branch, the next
 *    sequence and a new assignment. `proposalIntentOrder` is never touched.
 */
export async function joinProposalBranch(i: {
	snapshotId: string;
	organizationId: string;
	naming: ProposalBranchNaming;
}): Promise<JoinResult> {
	return runJoin(async (tx) => {
		const proposal = await readProposal(tx, i.snapshotId, i.organizationId);
		if (!proposal) {
			return { kind: "not_joinable" };
		}
		if (proposal.proposalBranchId !== null) {
			return alreadyOf(proposal);
		}
		if (!joinable(proposal)) {
			return { kind: "not_joinable" };
		}
		const frozen = proposalDestination(
			proposal.pullRequestContext,
			i.naming,
		);
		if (!frozen) {
			return { kind: "not_joinable" };
		}
		const current = await lockCurrentDestination(tx, proposal, i.naming);
		if (current === null || !sameBranchDestination(current, frozen)) {
			return blockStaleDestination(
				tx,
				proposal,
				i.organizationId,
				"join",
			);
		}
		const accepting = await lockAcceptingBranch(tx, proposal);
		const target = await targetBranch(tx, accepting, {
			projectId: proposal.projectId,
			userId: proposal.userId,
			organizationId: i.organizationId,
			destination: current,
			naming: i.naming,
		});
		const locked = await lockProposal(tx, i.snapshotId, i.organizationId);
		if (!locked) {
			throw new JoinAnswer({ kind: "not_joinable" });
		}
		if (locked.proposalBranchId !== null) {
			throw new JoinAnswer(alreadyOf(locked));
		}
		if (!joinable(locked)) {
			throw new JoinAnswer({ kind: "not_joinable" });
		}
		return assignToBranch(
			tx,
			{ ...locked, pullRequestState: "QUEUED" },
			target,
			{ organizationId: i.organizationId, event: "branch_join" },
		);
	});
}

function joinable(p: ProposalRow): boolean {
	return (
		p.proposalDestination === "REPOSITORY" &&
		p.pullRequestState === "QUEUED" &&
		isV2Context(p.pullRequestContext)
	);
}

function alreadyOf(p: ProposalRow): JoinResult {
	return {
		kind: "already",
		branchId: p.proposalBranchId as string,
		sequence: p.proposalBranchSequence ?? 0,
		assignment: p.proposalAssignment,
	};
}

/**
 * §5 step 2: the proposal's frozen destination is not the current one. A
 * non-terminal proposal becomes BLOCKED CONFIGURATION_CHANGED (phase
 * admission, so rehome never takes it) where it stands; a terminal one
 * (Propose again) is left alone. Nothing is retired.
 */
async function blockStaleDestination(
	tx: Prisma.TransactionClient,
	proposal: ProposalRow,
	organizationId: string,
	mode: "join" | { expectedBranchId: string },
): Promise<JoinResult> {
	const locked = await lockProposal(tx, proposal.id, organizationId);
	if (!locked || locked.pullRequestState === null) {
		return { kind: "not_joinable" };
	}
	if (mode === "join") {
		if (locked.proposalBranchId !== null) {
			return alreadyOf(locked);
		}
		if (!joinable(locked)) {
			return { kind: "not_joinable" };
		}
	} else if (locked.proposalBranchId !== mode.expectedBranchId) {
		return { kind: "not_joinable" };
	}
	if (isTerminalPullRequestState(locked.pullRequestState)) {
		return { kind: "configuration_changed" };
	}
	if (
		locked.pullRequestState === "CLOSE_REQUESTED" ||
		(locked.pullRequestState === "BLOCKED" &&
			failureOf(locked.pullRequestFailure).code ===
				"CONFIGURATION_CHANGED")
	) {
		return { kind: "configuration_changed" };
	}
	const moved = await transitionPullRequest(
		{
			snapshotId: locked.id,
			organizationId,
			event: "branch_stale_destination",
			from: [locked.pullRequestState],
			expectedAttempt: locked.pullRequestAttempt,
			to: "BLOCKED",
			bumpAttempt: true,
			data: {
				pullRequestFailure: configurationChangedFailure(
					await databaseNow(tx),
				) as unknown as Prisma.InputJsonValue,
				pullRequestNextAttemptAt: null,
			},
		},
		tx,
	);
	return moved.ok
		? { kind: "configuration_changed" }
		: { kind: "not_joinable" };
}

/** One of the proposal's operations on the branch it is leaving. */
export type TransferSourceOp = EvidenceOp & {
	sha: string;
	membership: string | null;
};

/**
 * What `transferProposal`'s `admit` decides on, read with every lock of the
 * transfer held: the proposal (locked), the branch it is leaving (locked),
 * and the proposal's operations on that branch, any assignment (locked after
 * the branches and before the proposal, the order `recordOperationOutcome`
 * takes them in, so neither an outcome nor a membership can change until
 * the transfer commits).
 */
export type TransferAdmission = {
	proposal: Pick<
		ProposalRow,
		| "id"
		| "version"
		| "pullRequestOperationId"
		| "pullRequestState"
		| "pullRequestFailure"
		| "proposalAssignment"
	>;
	branch: BranchRow;
	ops: TransferSourceOp[];
};

/**
 * `transferProposal` (spec §5): the join's steps for a proposal leaving
 * `expectedBranchId`, which must be terminal or retired, or settling with
 * START_OVER. Used by rehome and start over (`newIntentOrder: false`, a live
 * proposal keeping its `intentOrder`) and by Propose again
 * (`newIntentOrder: true`, a terminal proposal drawing a new one). Submission
 * intent must hold. The proposal becomes QUEUED on the member's accepting
 * branch with a new assignment; its journal stays with the old branch.
 *
 * `admit` (Propose again) is the command's own eligibility, re-decided under
 * every lock (`TransferAdmission`): false answers `not_joinable` and rolls
 * the whole transfer back. `onTransferred` writes in the same transaction
 * after the transfer (Propose again's audit row), so a failure there rolls
 * the transfer back too.
 */
export async function transferProposal(i: {
	snapshotId: string;
	organizationId: string;
	expectedBranchId: string;
	newIntentOrder: boolean;
	naming: ProposalBranchNaming;
	admit?: (a: TransferAdmission) => boolean;
	onTransferred?: (
		tx: Prisma.TransactionClient,
		t: {
			proposal: TransferAdmission["proposal"];
			result: JoinResult;
		},
	) => Promise<void>;
}): Promise<JoinResult> {
	return runJoin(async (tx) => {
		const proposal = await readProposal(tx, i.snapshotId, i.organizationId);
		if (!proposal || !transferable(proposal, i)) {
			return { kind: "not_joinable" };
		}
		const old = await tx.projectInstructionProposalBranch.findFirst({
			where: { id: i.expectedBranchId, organizationId: i.organizationId },
		});
		if (!old || !releasesProposals(old)) {
			return { kind: "not_joinable" };
		}
		const frozen = proposalDestination(
			proposal.pullRequestContext,
			i.naming,
		);
		if (!frozen) {
			return { kind: "not_joinable" };
		}
		const current = await lockCurrentDestination(tx, proposal, i.naming);
		if (current === null || !sameBranchDestination(current, frozen)) {
			return blockStaleDestination(tx, proposal, i.organizationId, {
				expectedBranchId: i.expectedBranchId,
			});
		}
		// Both branches, by id (§4.7 step 2): the accepting one is read
		// first, then locked with the old one, then re-checked.
		const acceptingId = await acceptingBranchId(tx, proposal);
		const ids = [
			i.expectedBranchId,
			...(acceptingId ? [acceptingId] : []),
		].sort();
		await tx.$queryRaw`
			SELECT "id" FROM "project_instruction_proposal_branch"
			WHERE "id" = ANY(${ids}::text[]) AND "organizationId" = ${i.organizationId}
			ORDER BY "id" FOR UPDATE`;
		const oldLocked = await tx.projectInstructionProposalBranch.findFirst({
			where: { id: i.expectedBranchId, organizationId: i.organizationId },
		});
		if (!oldLocked || !releasesProposals(oldLocked)) {
			throw new JoinAnswer({ kind: "not_joinable" });
		}
		const accepting = await lockAcceptingBranch(tx, proposal);
		if ((accepting?.id ?? null) !== acceptingId) {
			throw new JoinRace();
		}
		const target = await targetBranch(tx, accepting, {
			projectId: proposal.projectId,
			userId: proposal.userId,
			organizationId: i.organizationId,
			destination: current,
			naming: i.naming,
		});
		if (i.admit) {
			await tx.$queryRaw`
				SELECT "id" FROM "project_instruction_proposal_branch_operation"
				WHERE "snapshotId" = ${i.snapshotId} AND "branchId" = ${i.expectedBranchId}
					AND "organizationId" = ${i.organizationId}
				ORDER BY "id" FOR UPDATE`;
		}
		const locked = await lockProposal(tx, i.snapshotId, i.organizationId);
		if (
			!locked ||
			!transferable(locked, i) ||
			locked.pullRequestState === null
		) {
			throw new JoinAnswer({ kind: "not_joinable" });
		}
		if (i.admit) {
			const ops =
				await tx.projectInstructionProposalBranchOperation.findMany({
					where: {
						organizationId: i.organizationId,
						snapshotId: i.snapshotId,
						branchId: i.expectedBranchId,
					},
					select: {
						id: true,
						kind: true,
						executionSeq: true,
						assignment: true,
						branchId: true,
						outcome: true,
						sha: true,
						membership: true,
					},
				});
			const admitted = i.admit({
				proposal: locked,
				branch: oldLocked,
				ops: ops.map((op) => ({
					...op,
					outcome: op.outcome as OpOutcome,
				})),
			});
			if (!admitted) {
				throw new JoinAnswer({ kind: "not_joinable" });
			}
		}
		let intentOrder: bigint | undefined;
		if (i.newIntentOrder) {
			const [row] = await tx.$queryRaw<Array<{ v: bigint }>>`
				SELECT nextval('project_instruction_proposal_intent_seq') AS "v"`;
			intentOrder = BigInt(row?.v ?? 0);
		}
		const result = await assignToBranch(
			tx,
			{ ...locked, pullRequestState: locked.pullRequestState },
			target,
			{
				organizationId: i.organizationId,
				event: "branch_transfer",
				...(intentOrder !== undefined ? { intentOrder } : {}),
			},
		);
		await i.onTransferred?.(tx, { proposal: locked, result });
		return result;
	});
}

/**
 * A proposal `transferProposal` may move: v2, on the expected branch,
 * submission intent holding; a terminal one only for Propose again (a new
 * intent order), a live one (QUEUED, OPENING, OPEN, BLOCKED) only for rehome
 * and start over (its intent order kept).
 */
function transferable(
	p: ProposalRow,
	i: { expectedBranchId: string; newIntentOrder: boolean },
): boolean {
	if (
		p.proposalDestination !== "REPOSITORY" ||
		!isV2Context(p.pullRequestContext) ||
		p.proposalBranchId !== i.expectedBranchId ||
		p.withdrawRequestedAt !== null ||
		p.pullRequestState === null
	) {
		return false;
	}
	if (isTerminalPullRequestState(p.pullRequestState)) {
		return i.newIntentOrder;
	}
	return (
		!i.newIntentOrder &&
		(p.pullRequestState === "QUEUED" ||
			p.pullRequestState === "OPENING" ||
			p.pullRequestState === "OPEN" ||
			p.pullRequestState === "BLOCKED")
	);
}

/** A branch whose proposals may be transferred away: terminal, retired, or settling with START_OVER. */
function releasesProposals(b: BranchRow): boolean {
	return (
		isTerminalBranchState(b.state) ||
		b.retiredAt !== null ||
		(b.state === "CLOSE_REQUESTED" && b.closeIntent === "START_OVER")
	);
}

// ---------------------------------------------------------------------------
// Claim (spec §6.1)
// ---------------------------------------------------------------------------

export type BranchClaim =
	| {
			kind: "claimed";
			snapshotId: string;
			proposalAttempt: number;
			branchAttempt: number;
	  }
	| { kind: "none" };

const QUEUE_SELECT = {
	id: true,
	proposalBranchSequence: true,
	proposalAssignment: true,
	pullRequestAttempt: true,
	pullRequestState: true,
	status: true,
	proposalStatus: true,
	withdrawRequestedAt: true,
	pullRequestFailure: true,
	pullRequestNextAttemptAt: true,
} satisfies Prisma.ProjectInstructionSnapshotSelect;

type QueueRow = Prisma.ProjectInstructionSnapshotGetPayload<{
	select: typeof QUEUE_SELECT;
}>;

function queueEntryOf(
	r: QueueRow,
): BranchQueueEntry & { assignment: number; attempt: number } {
	return {
		snapshotId: r.id,
		sequence: r.proposalBranchSequence,
		state: r.pullRequestState,
		status: r.status,
		proposalStatus: r.proposalStatus,
		withdrawRequestedAt: r.withdrawRequestedAt,
		failure: r.pullRequestFailure,
		nextAttemptAt: r.pullRequestNextAttemptAt,
		assignment: r.proposalAssignment,
		attempt: r.pullRequestAttempt,
	};
}

function readQueue(
	client: Prisma.TransactionClient,
	branchId: string,
	organizationId: string,
): Promise<QueueRow[]> {
	return client.projectInstructionSnapshot.findMany({
		where: {
			organizationId,
			proposalBranchId: branchId,
			pullRequestState: { in: [...NON_TERMINAL_PROPOSAL_STATES] },
		},
		select: QUEUE_SELECT,
		orderBy: { proposalBranchSequence: "asc" },
	});
}

/**
 * `claimBranchAppend` (spec §6.1): the head of the queue (`pickRunnableHead`)
 * on a branch that accepts appends becomes OPENING at a new attempt, and the
 * branch's attempt is bumped too. Branch, then proposal (§4.7). A claimed
 * BLOCKED proposal's failure and backoff are cleared: the new attempt
 * replaces the one that failed. The branch's first claim stores the
 * `presentation` the caller rendered, when it passes one.
 */
export async function claimBranchAppend(i: {
	branchId: string;
	organizationId: string;
	presentation?: { title: string; body: string };
}): Promise<BranchClaim> {
	return withTransactionRetry(() =>
		db.$transaction(async (tx): Promise<BranchClaim> => {
			const branch = await lockBranch(tx, i.branchId, i.organizationId);
			if (!branch || !acceptsAppends(branch)) {
				return { kind: "none" };
			}
			const now = await databaseNow(tx);
			const queue = await readQueue(tx, branch.id, i.organizationId);
			const head = pickRunnableHead(queue.map(queueEntryOf), now);
			if (head.kind !== "claim") {
				return { kind: "none" };
			}
			const proposal = await lockProposal(
				tx,
				head.snapshotId,
				i.organizationId,
			);
			if (
				!proposal ||
				proposal.proposalBranchId !== branch.id ||
				proposal.pullRequestState === null
			) {
				return { kind: "none" };
			}
			// Re-checked under the proposal lock: a verdict or a cancel that
			// does not take the branch lock may have moved it.
			const recheck = pickRunnableHead(
				[
					{
						snapshotId: proposal.id,
						sequence: proposal.proposalBranchSequence,
						state: proposal.pullRequestState,
						status: proposal.status,
						proposalStatus: proposal.proposalStatus,
						withdrawRequestedAt: proposal.withdrawRequestedAt,
						failure: proposal.pullRequestFailure,
						nextAttemptAt: proposal.pullRequestNextAttemptAt,
					},
				],
				now,
			);
			if (recheck.kind !== "claim") {
				return { kind: "none" };
			}
			const moved = await transitionPullRequest(
				{
					snapshotId: proposal.id,
					organizationId: i.organizationId,
					event: "branch_claim",
					from: [proposal.pullRequestState],
					expectedAttempt: proposal.pullRequestAttempt,
					to: "OPENING",
					bumpAttempt: true,
					branch: {
						id: branch.id,
						assignment: proposal.proposalAssignment,
					},
					data: {
						pullRequestFailure: null,
						pullRequestNextAttemptAt: null,
					},
				},
				tx,
			);
			if (!moved.ok) {
				return { kind: "none" };
			}
			const { count } =
				await tx.projectInstructionProposalBranch.updateMany({
					where: {
						id: branch.id,
						organizationId: i.organizationId,
						attempt: branch.attempt,
					},
					data: {
						attempt: { increment: 1 },
						...(branch.presentation === null && i.presentation
							? {
									presentation: {
										title: i.presentation.title,
										body: i.presentation.body,
									},
								}
							: {}),
					},
				});
			if (count !== 1) {
				throw new Error(
					"A locked proposal branch moved inside its claim",
				);
			}
			return {
				kind: "claimed",
				snapshotId: proposal.id,
				proposalAttempt: moved.attempt,
				branchAttempt: branch.attempt + 1,
			};
		}),
	);
}

// ---------------------------------------------------------------------------
// The journal: issue and facts (spec §4.1, §6.4 step 8)
// ---------------------------------------------------------------------------

/**
 * Records a push Fabric is about to issue (spec §6.4 step 8): the operation
 * with `executionSeq = nextExecutionSeq` (incremented under the branch lock),
 * the proposal's current assignment and the claimed attempt, and
 * `pushIssuedAt`. Conditional on the proposal still being this branch's at
 * `proposalAttempt` (OPENING for an append, CLOSE_REQUESTED for a revert), on
 * `ref` being the branch's current ref, and, for an append, on the branch
 * still accepting appends. `parentSha` is null exactly for the create-only
 * push of a branch that has no head.
 *
 * Never while another operation on the branch is still issued (no outcome):
 * spec §6 loop item 1, dependent work never runs on an uncertain push. Two
 * overlapping attempts of one claim (a heartbeat-timeout retry beside a
 * still-running original) both pass their activity's own check; this one,
 * under the branch lock every issuer and outcome writer takes, lets only
 * the first issue. The other answers `unresolved`, and the loop recovers the
 * issued operation before anything else: without this, a retry's
 * create-only push refused by the original's own successful push would move
 * the branch to the next ref and strand that push outside tracking.
 */
export async function recordBranchOperation(i: {
	branchId: string;
	organizationId: string;
	snapshotId: string;
	proposalAttempt: number;
	kind: "APPEND" | "REVERT";
	ref: string;
	parentSha: string | null;
	sha: string;
	entries: BranchOperationEntryRecord[];
}): Promise<
	| { ok: true; operationId: string; executionSeq: number }
	| { ok: false; unresolved?: true }
> {
	return withTransactionRetry(() =>
		db.$transaction(async (tx) => {
			const branch = await lockBranch(tx, i.branchId, i.organizationId);
			if (
				!branch ||
				branch.untracked ||
				isTerminalBranchState(branch.state) ||
				branch.ref !== i.ref ||
				(i.kind === "APPEND" && !acceptsAppends(branch)) ||
				(i.kind === "APPEND"
					? (i.parentSha === null) !== (branch.headSha === null)
					: i.parentSha === null)
			) {
				return { ok: false as const };
			}
			const issued =
				await tx.projectInstructionProposalBranchOperation.findFirst({
					where: {
						organizationId: i.organizationId,
						branchId: branch.id,
						outcome: null,
					},
					select: { id: true },
				});
			if (issued) {
				return { ok: false as const, unresolved: true as const };
			}
			const proposal = await lockProposal(
				tx,
				i.snapshotId,
				i.organizationId,
			);
			if (
				!proposal ||
				proposal.proposalBranchId !== branch.id ||
				proposal.pullRequestAttempt !== i.proposalAttempt ||
				proposal.pullRequestState !==
					(i.kind === "APPEND" ? "OPENING" : "CLOSE_REQUESTED")
			) {
				return { ok: false as const };
			}
			const [seq] = await tx.$queryRaw<Array<{ executionSeq: number }>>`
				UPDATE "project_instruction_proposal_branch"
				SET "nextExecutionSeq" = "nextExecutionSeq" + 1,
					"updatedAt" = (now() AT TIME ZONE 'UTC')
				WHERE "id" = ${branch.id} AND "organizationId" = ${i.organizationId}
				RETURNING ("nextExecutionSeq" - 1)::int AS "executionSeq"`;
			if (!seq) {
				return { ok: false as const };
			}
			const executionSeq = Number(seq.executionSeq);
			const op =
				await tx.projectInstructionProposalBranchOperation.create({
					data: {
						organizationId: i.organizationId,
						branchId: branch.id,
						snapshotId: proposal.id,
						kind: i.kind,
						executionSeq,
						ref: i.ref,
						assignment: proposal.proposalAssignment,
						attempt: i.proposalAttempt,
						parentSha: i.parentSha,
						sha: i.sha,
						entries: i.entries as unknown as Prisma.InputJsonValue,
						pushIssuedAt: await databaseNow(tx),
					},
					select: { id: true },
				});
			return { ok: true as const, operationId: op.id, executionSeq };
		}),
	);
}

function baseCommitShaOf(context: unknown): string | null {
	if (context === null || typeof context !== "object") {
		return null;
	}
	const sha = (context as { baseCommitSha?: unknown }).baseCommitSha;
	return typeof sha === "string" && sha.length > 0 ? sha : null;
}

/**
 * Records an operation's outcome (spec §4.1 facts; §6.2; §6.4 step 10),
 * conditional only on the operation's identity and the monotonic evidence
 * rule (`outcomeTransition`), whatever the branch or proposal state. Branch,
 * then operation, then proposal (§4.7).
 *
 * On a new establishment: `factsRevision` + 1; `headSha` by compare-and-set
 * on `headExecutionSeq`; the first append's `startSha` and PENDING ->
 * OPENING; a terminal branch's settled membership back to `pending`; and one
 * `pull_request_branch_updated` row, `recovered` for an observation.
 * `foreignTip` sets `foreignTipAt` once.
 *
 * Then, in the same transaction, `reconcileProposalFromEvidence` for the
 * operation's proposal, but only while the proposal's `proposalBranchId` and
 * `proposalAssignment` are still the operation's (`reconcile.row` null
 * otherwise: the fact is history on this branch only).
 */
export async function recordOperationOutcome(i: {
	operationId: string;
	organizationId: string;
	outcome: "acked" | "observed" | "not_pushed" | "unknown";
	foreignTip?: boolean;
	audit?: { actorUserId: string | null; recovered: boolean };
}): Promise<{
	applied: boolean;
	reconcile: { changed: boolean; row: ReducerRow | null };
}> {
	const notApplied = {
		applied: false,
		reconcile: { changed: false, row: null },
	} as const;
	return withTransactionRetry(() =>
		db.$transaction(async (tx) => {
			const first =
				await tx.projectInstructionProposalBranchOperation.findFirst({
					where: {
						id: i.operationId,
						organizationId: i.organizationId,
					},
					select: { branchId: true },
				});
			if (!first) {
				return notApplied;
			}
			const branch = await lockBranch(
				tx,
				first.branchId,
				i.organizationId,
			);
			if (!branch) {
				return notApplied;
			}
			const op =
				await tx.projectInstructionProposalBranchOperation.findFirst({
					where: {
						id: i.operationId,
						organizationId: i.organizationId,
					},
				});
			if (!op) {
				return notApplied;
			}
			const now = await databaseNow(tx);
			const needsBase =
				op.kind === "APPEND" &&
				op.parentSha === null &&
				branch.startSha === null;
			const baseCommitSha = needsBase
				? baseCommitShaOf(
						(
							await tx.projectInstructionSnapshot.findFirst({
								where: {
									id: op.snapshotId,
									organizationId: i.organizationId,
								},
								select: { pullRequestContext: true },
							})
						)?.pullRequestContext,
					)
				: null;
			const plan = planOutcomeFact({
				op: { ...op, outcome: op.outcome as OpOutcome },
				branch,
				outcome: i.outcome,
				foreignTip: i.foreignTip === true,
				baseCommitSha,
				now,
			});
			if (plan.apply) {
				const { count } =
					await tx.projectInstructionProposalBranchOperation.updateMany(
						{
							where: {
								id: op.id,
								organizationId: i.organizationId,
								outcome: op.outcome,
							},
							data: plan.op,
						},
					);
				if (count !== 1) {
					// Unreachable under the branch lock every outcome writer takes.
					throw new Error(
						"A journal operation moved under its branch lock",
					);
				}
			}
			await applyBranchFacts(tx, branch, plan, i.organizationId, now);
			if (plan.established) {
				await recordAuditTx(
					tx,
					branchUpdatedAudit(
						branch,
						i.organizationId,
						i.audit?.actorUserId ?? null,
						{
							operationId: op.id,
							snapshotId: op.snapshotId,
							kind: op.kind,
							executionSeq: op.executionSeq,
							sha: op.sha,
							recovered:
								i.audit?.recovered ?? i.outcome === "observed",
						},
					),
				);
			}
			if (!plan.apply) {
				return notApplied;
			}
			const [owner] = await tx.$queryRaw<
				Array<{
					proposalBranchId: string | null;
					proposalAssignment: number;
				}>
			>`
				SELECT "proposalBranchId", "proposalAssignment"
				FROM "project_instruction_snapshot"
				WHERE "id" = ${op.snapshotId} AND "organizationId" = ${i.organizationId}
				FOR UPDATE`;
			if (
				!owner ||
				owner.proposalBranchId !== op.branchId ||
				Number(owner.proposalAssignment) !== op.assignment
			) {
				return {
					applied: true,
					reconcile: { changed: false, row: null },
				};
			}
			const reconciled = await reconcileProposalFromEvidence(tx, {
				snapshotId: op.snapshotId,
				organizationId: i.organizationId,
			});
			return {
				applied: true,
				reconcile: { changed: reconciled.changed, row: reconciled.row },
			};
		}),
	);
}

async function applyBranchFacts(
	tx: Prisma.TransactionClient,
	branch: BranchRow,
	plan: OutcomeFactPlan,
	organizationId: string,
	now: Date,
): Promise<void> {
	const f = plan.branch;
	if (f.head) {
		await tx.projectInstructionProposalBranch.updateMany({
			where: {
				id: branch.id,
				organizationId,
				headExecutionSeq: { lt: f.head.executionSeq },
			},
			data: {
				headSha: f.head.sha,
				headExecutionSeq: f.head.executionSeq,
			},
		});
	}
	if (f.startSha !== null) {
		await tx.projectInstructionProposalBranch.updateMany({
			where: { id: branch.id, organizationId, startSha: null },
			data: { startSha: f.startSha },
		});
	}
	if (f.pendingToOpening) {
		await tx.projectInstructionProposalBranch.updateMany({
			where: { id: branch.id, organizationId, state: "PENDING" },
			data: { state: "OPENING" },
		});
	}
	const data: Prisma.ProjectInstructionProposalBranchUncheckedUpdateManyInput =
		{};
	if (f.factsRevisionIncrement) {
		data.factsRevision = { increment: 1 };
	}
	if (f.membershipToPending) {
		data.membership = {
			status: "pending",
			at: now.toISOString(),
			attempts: 0,
		} satisfies BranchMembership;
	}
	if (f.foreignTip) {
		data.foreignTipAt = now;
	}
	if (Object.keys(data).length > 0) {
		await tx.projectInstructionProposalBranch.updateMany({
			where: { id: branch.id, organizationId },
			data,
		});
	}
}

/**
 * `foreignTipAt` once (spec Decision 7): a check found commits Fabric did
 * not push, outside any outcome write (start over's step 0). Never cleared.
 */
export async function markForeignTip(i: {
	branchId: string;
	organizationId: string;
}): Promise<boolean> {
	const count = await db.$executeRaw`
		UPDATE "project_instruction_proposal_branch"
		SET "foreignTipAt" = (now() AT TIME ZONE 'UTC')
		WHERE "id" = ${i.branchId} AND "organizationId" = ${i.organizationId}
			AND "foreignTipAt" IS NULL`;
	return count === 1;
}

/**
 * Operations' classification (spec Decision 14): `included` when
 * `isAncestor(sha, headSha)` held, otherwise `unverified`. Only inclusion is
 * ever proved, so `included` is never overwritten by `unverified`. Facts:
 * conditional only on each operation's identity, written by one statement so
 * a classification lands whole or not at all. Answers how many rows were
 * written.
 */
export async function setOperationMembershipMany(i: {
	organizationId: string;
	entries: readonly {
		operationId: string;
		membership: "included" | "unverified";
	}[];
}): Promise<number> {
	if (i.entries.length === 0) {
		return 0;
	}
	const ids = i.entries.map((e) => e.operationId);
	const memberships = i.entries.map((e) => e.membership);
	return db.$executeRaw`
		UPDATE "project_instruction_proposal_branch_operation" AS op
		SET "membership" = v."membership"
		FROM unnest(${ids}::text[], ${memberships}::text[]) AS v("id", "membership")
		WHERE op."id" = v."id" AND op."organizationId" = ${i.organizationId}
			AND (op."membership" IS DISTINCT FROM 'included' OR v."membership" = 'included')`;
}

// ---------------------------------------------------------------------------
// Branch transitions (spec §4.4)
// ---------------------------------------------------------------------------

/**
 * The facts `recordOperationOutcome` alone writes (spec §4.1), and the
 * identity columns nothing rewrites after creation. `ref` changes only
 * through `refuseCurrentRef`.
 */
const NOT_TRANSITION_COLUMNS = [
	"id",
	"organizationId",
	"projectId",
	"userId",
	"repositoryKey",
	"number",
	"ref",
	"destination",
	"headSha",
	"headExecutionSeq",
	"startSha",
	"factsRevision",
	"foreignTipAt",
	"nextSequence",
	"nextExecutionSeq",
	"attempt",
	"state",
	"untracked",
] as const;

type BranchJsonColumn =
	| "presentation"
	| "pullRequestObservation"
	| "membership"
	| "failure"
	| "mergeSyncExpected";

/** What a branch transition may write besides the state and the attempt. */
export type BranchColumns = Omit<
	Prisma.ProjectInstructionProposalBranchUncheckedUpdateManyInput,
	(typeof NOT_TRANSITION_COLUMNS)[number] | BranchJsonColumn | "updatedAt"
> & {
	[K in BranchJsonColumn]?:
		| Prisma.ProjectInstructionProposalBranchUncheckedUpdateManyInput[K]
		| null;
};

function branchColumnsForPrisma(
	data: BranchColumns | undefined,
): Prisma.ProjectInstructionProposalBranchUncheckedUpdateManyInput {
	const out: Record<string, unknown> = { ...data };
	for (const key of NOT_TRANSITION_COLUMNS) {
		if (key in out) {
			throw new Error(`A branch transition never writes ${key}`);
		}
	}
	for (const key of [
		"presentation",
		"pullRequestObservation",
		"membership",
		"failure",
		"mergeSyncExpected",
	] as const) {
		if (out[key] === null) {
			out[key] = Prisma.DbNull;
		}
	}
	return out as Prisma.ProjectInstructionProposalBranchUncheckedUpdateManyInput;
}

/**
 * One fenced branch transition (spec §4.4): `UPDATE ... WHERE id AND
 * organizationId AND state IN (from) AND attempt = expectedAttempt AND NOT
 * untracked`, optionally also fencing `nextAttemptAt`. Zero rows means
 * another actor moved first. An illegal (from, to) throws. The journal facts
 * (`headSha`, `startSha`, `factsRevision`, `foreignTipAt`) are never written
 * here.
 */
export async function transitionBranch(
	i: {
		branchId: string;
		organizationId: string;
		from: BranchState[];
		expectedAttempt: number;
		/** Optional compare-and-set guard for a newer provider backoff. */
		expectedNextAttemptAt?: Date | null;
		to: BranchState | "unchanged";
		bumpAttempt: boolean;
		data?: BranchColumns;
	},
	tx?: Prisma.TransactionClient,
): Promise<{ ok: true; attempt: number } | { ok: false }> {
	if (i.from.length === 0) {
		throw new Error("A branch transition names no source state");
	}
	for (const from of i.from) {
		if (!isLegalBranchMove(from, i.to)) {
			throw new Error(`Illegal branch transition: ${from} to ${i.to}`);
		}
	}
	const data = {
		...branchColumnsForPrisma(i.data),
		...(i.to === "unchanged" ? {} : { state: i.to }),
		...(i.bumpAttempt ? { attempt: { increment: 1 } } : {}),
	};
	const client = tx ?? db;
	const { count } = await client.projectInstructionProposalBranch.updateMany({
		where: {
			id: i.branchId,
			organizationId: i.organizationId,
			state: { in: i.from },
			attempt: i.expectedAttempt,
			untracked: false,
			...(i.expectedNextAttemptAt !== undefined
				? { nextAttemptAt: i.expectedNextAttemptAt }
				: {}),
		},
		data,
	});
	return count === 1
		? { ok: true, attempt: i.expectedAttempt + (i.bumpAttempt ? 1 : 0) }
		: { ok: false };
}

// ---------------------------------------------------------------------------
// The loop's read (spec §6)
// ---------------------------------------------------------------------------

/** What the loop's read answers: the item, the branch attempt and the clock it was decided on. */
export type BranchWorkRead = {
	work: BranchWork;
	/** The branch's attempt in the same snapshot; the branch-level items fence on it. */
	branchAttempt: number;
	databaseNow: Date;
};

/**
 * `readBranchWork`: read-only, one consistent snapshot of the branch, its
 * journal and its non-terminal proposals, decided by `decideBranchWork`,
 * with the branch attempt and the database clock of that snapshot.
 */
export async function readBranchWork(i: {
	branchId: string;
	organizationId: string;
}): Promise<BranchWorkRead> {
	return db.$transaction(
		async (tx): Promise<BranchWorkRead> => {
			const now = await databaseNow(tx);
			const branch = await tx.projectInstructionProposalBranch.findFirst({
				where: { id: i.branchId, organizationId: i.organizationId },
			});
			if (!branch) {
				return {
					work: { kind: "idle", wakeAt: null },
					branchAttempt: 0,
					databaseNow: now,
				};
			}
			// Sequential: one interactive transaction runs on one connection.
			const ops =
				await tx.projectInstructionProposalBranchOperation.findMany({
					where: {
						organizationId: i.organizationId,
						branchId: branch.id,
					},
					select: {
						id: true,
						snapshotId: true,
						kind: true,
						executionSeq: true,
						assignment: true,
						branchId: true,
						outcome: true,
					},
				});
			const queue = await readQueue(tx, branch.id, i.organizationId);
			return {
				work: decideBranchWork({
					branch,
					ops: ops.map((op) => ({
						...op,
						outcome: op.outcome as OpOutcome,
					})),
					proposals: queue.map(queueEntryOf),
					now,
				}),
				branchAttempt: branch.attempt,
				databaseNow: now,
			};
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
	);
}

/** `nextBranchWork`: the item `readBranchWork` decides, alone. */
export async function nextBranchWork(i: {
	branchId: string;
	organizationId: string;
}): Promise<BranchWork> {
	return (await readBranchWork(i)).work;
}

// ---------------------------------------------------------------------------
// Stop tracking (spec Decision 19)
// ---------------------------------------------------------------------------

/**
 * Stop tracking a branch Fabric can no longer reach (its failure is
 * REPOSITORY_CHANGED), in one transaction: the branch becomes CLOSED and
 * `untracked`; every non-terminal proposal on it CANCELED REPOSITORY_CHANGED
 * with its pending command cleared; the branch's confirmation, merge-sync,
 * retry and backoff obligations cleared. Nothing is done in the repository,
 * and the ref reservation stays. Refused unless the branch failure is
 * REPOSITORY_CHANGED. The caller has authorized `actorUserId`.
 */
export async function stopTrackingBranch(i: {
	branchId: string;
	organizationId: string;
	actorUserId: string;
}): Promise<{ ok: boolean }> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await tx.projectInstructionProposalBranch.findFirst({
				where: { id: i.branchId, organizationId: i.organizationId },
			});
			if (
				!branch ||
				branch.untracked ||
				failureOf(branch.failure).code !== "REPOSITORY_CHANGED"
			) {
				return { ok: false };
			}
			const now = await databaseNow(tx);
			// Proposals after the branch, by id (§4.7 step 3).
			const proposals = await tx.$queryRaw<
				Array<{
					id: string;
					version: number;
					state: ProposalState;
					attempt: number;
					assignment: number;
					operationId: string | null;
				}>
			>`
				SELECT "id", "version", "pullRequestState"::text AS "state",
					"pullRequestAttempt" AS "attempt", "proposalAssignment" AS "assignment",
					"pullRequestOperationId" AS "operationId"
				FROM "project_instruction_snapshot"
				WHERE "proposalBranchId" = ${branch.id} AND "organizationId" = ${i.organizationId}
					AND "pullRequestState" IN ('QUEUED', 'OPENING', 'OPEN', 'CLOSE_REQUESTED', 'BLOCKED')
				ORDER BY "id" FOR UPDATE`;
			const failure: PullRequestFailure = {
				phase: "close",
				code: "REPOSITORY_CHANGED",
				retryable: false,
				at: now.toISOString(),
				params: {},
			};
			for (const p of proposals) {
				const moved = await transitionPullRequest(
					{
						snapshotId: p.id,
						organizationId: i.organizationId,
						event: "branch_stop_tracking",
						from: [p.state],
						expectedAttempt: Number(p.attempt),
						to: "CANCELED",
						bumpAttempt: true,
						branch: {
							id: branch.id,
							assignment: Number(p.assignment),
						},
						data: {
							pullRequestFailure:
								failure as unknown as Prisma.InputJsonValue,
							pullRequestNextAttemptAt: null,
							pendingCommand: null,
							pendingCommandSeq: null,
						},
						audit: {
							action: "project.instructions.pull_request_reconciled",
							category: "project",
							actor: { type: "user", userId: i.actorUserId },
							organizationId: i.organizationId,
							projectId: branch.projectId,
							resource: {
								type: "project_instruction_snapshot",
								id: p.id,
								name: `v${p.version}`,
							},
							metadata: {
								outcome: "canceled",
								operationId: p.operationId,
								code: "REPOSITORY_CHANGED",
								branchId: branch.id,
								targetMismatch: false,
							},
						},
					},
					tx,
				);
				if (!moved.ok) {
					throw new Error("A locked proposal refused stop tracking");
				}
			}
			const { count } =
				await tx.projectInstructionProposalBranch.updateMany({
					where: {
						id: branch.id,
						organizationId: i.organizationId,
						untracked: false,
					},
					data: {
						state: "CLOSED",
						untracked: true,
						attempt: { increment: 1 },
						confirmationDueAt: null,
						mergeSyncRequestedAt: null,
						mergeSyncDispatchedAt: null,
						retryRequestedAt: null,
						nextAttemptAt: null,
					},
				});
			if (count !== 1) {
				throw new Error(
					"A locked proposal branch refused stop tracking",
				);
			}
			await recordAuditTx(
				tx,
				branchUpdatedAudit(branch, i.organizationId, i.actorUserId, {
					change: "untracked",
					stateBefore: branch.state,
					canceled: proposals.length,
				}),
			);
			return { ok: true };
		},
	);
}

// ---------------------------------------------------------------------------
// Reads (spec §10)
// ---------------------------------------------------------------------------

/** The member's branch as Fabric can prove it (spec §10 `proposals.myBranch`). */
export async function projectMemberBranch(i: {
	branchId: string;
	organizationId: string;
}): Promise<BranchProjectionEntry[]> {
	const ops = await db.projectInstructionProposalBranchOperation.findMany({
		where: {
			organizationId: i.organizationId,
			branchId: i.branchId,
			outcome: { in: ["acked", "observed"] },
		},
		select: {
			kind: true,
			executionSeq: true,
			outcome: true,
			entries: true,
		},
		orderBy: { executionSeq: "asc" },
	});
	return projectEntries(
		ops.map((op) => ({
			kind: op.kind,
			executionSeq: op.executionSeq,
			outcome: op.outcome as OpOutcome,
			entries: parseOperationEntries(op.entries),
		})),
	);
}

/** The member's accepting branch in the project (the partial index's predicate), or null. */
export function getAcceptingBranchForMember(i: {
	projectId: string;
	userId: string;
	organizationId: string;
}): Promise<BranchRow | null> {
	return db.projectInstructionProposalBranch.findFirst({
		where: acceptingWhere(i),
	});
}

/**
 * The set of branches the §10 panel and the reviewer aggregate read draw
 * from: every tracked branch that is not terminal, or whose membership is
 * still pending — i.e. not simply MERGED/CLOSED/CANCELED and forgotten.
 * `userId` narrows to one member; omitted, every member's.
 */
function trackedBranchWhere(i: {
	projectId: string;
	organizationId: string;
	userId?: string;
}): Prisma.ProjectInstructionProposalBranchWhereInput {
	return {
		projectId: i.projectId,
		organizationId: i.organizationId,
		...(i.userId !== undefined ? { userId: i.userId } : {}),
		untracked: false,
		OR: [
			{
				state: {
					in: [
						"PENDING",
						"OPENING",
						"OPEN",
						"CLOSE_REQUESTED",
						"BLOCKED",
					],
				},
			},
			{ membership: { path: ["status"], equals: "pending" } },
		],
	};
}

/**
 * The branches the §10 panel shows, newest first: the accepting one plus any
 * retired, closing, classifying or BLOCKED one, i.e. every tracked branch
 * that is not terminal or whose membership is still pending. `userId` null
 * is the reviewer view: every member's — but see `listProposalBranchOwnerIds`
 * for the BOUNDED form of that view, which reads only one page of owners
 * rather than every tracked branch in the project.
 */
export function listMemberBranches(i: {
	projectId: string;
	userId: string | null;
	organizationId: string;
}): Promise<BranchRow[]> {
	return db.projectInstructionProposalBranch.findMany({
		where: trackedBranchWhere({
			projectId: i.projectId,
			organizationId: i.organizationId,
			...(i.userId === null ? {} : { userId: i.userId }),
		}),
		orderBy: [{ createdAt: "desc" }, { id: "asc" }],
	});
}

/** One page of `listProposalBranchOwnerIds` (Fizzy #2738 spec §10 reviewer aggregate read). */
export type ProposalBranchOwnersPage = {
	ownerIds: string[];
	nextCursor: string | null;
};

/**
 * Distinct members with a tracked branch in the project, one page at a time,
 * bounded and cursor-paged IN THE DATABASE (round-3 review finding: loading
 * every tracked branch and capping the owner list in memory silently drops
 * the rest past the cap on a large project). Ordered by `userId` ascending,
 * a stable key a cursor can resume from; `excludeUserId` leaves out the
 * caller's own branch, which `readMyProposalBranch`'s ownerless read already
 * covers. `groupBy` runs as SQL `GROUP BY ... LIMIT`, so the page itself,
 * not just the branches within it, is exactly `limit` owners (or fewer on the
 * last page). Prisma's `findMany({ distinct })` would not do: it deduplicates
 * in memory after reading every matching row.
 */
export async function listProposalBranchOwnerIds(i: {
	projectId: string;
	organizationId: string;
	excludeUserId: string;
	cursor?: string;
	limit: number;
}): Promise<ProposalBranchOwnersPage> {
	const rows = await db.projectInstructionProposalBranch.groupBy({
		by: ["userId"],
		where: {
			...trackedBranchWhere({
				projectId: i.projectId,
				organizationId: i.organizationId,
			}),
			userId: {
				not: i.excludeUserId,
				...(i.cursor !== undefined ? { gt: i.cursor } : {}),
			},
		},
		orderBy: { userId: "asc" },
		take: i.limit + 1,
	});
	const hasMore = rows.length > i.limit;
	const page = hasMore ? rows.slice(0, i.limit) : rows;
	return {
		ownerIds: page.map((row) => row.userId),
		nextCursor: hasMore ? (page.at(-1)?.userId ?? null) : null,
	};
}

// ---------------------------------------------------------------------------
// The branch activities' reads and writes (Fizzy #2738 plan Tasks 7 and 8:
// append, recovery, revert, create, lookup, release and retry opening)
//
// The proposal transition table (#2563 §4.4 plus the Task 3 branch rows) has
// no event of its own for an append's terminal no-op, a released claim, a
// refused withdrawal or a released branch's proposals. Each writer below
// names the existing event whose (from, to) arm and fence it needs, here
// and nowhere else:
// - `push_unknown` (#2563's own OPENING -> BLOCKED for an unresolved push);
// - `branch_evidence`, an evidence-derived move carrying the branch and
//   assignment fence (the no-op cancel runs inside the reducer's own
//   transaction; a refused withdrawal is the §4.3 revert-failure row);
// - `branch_transfer`, the only arm that reaches QUEUED from OPENING.
// ---------------------------------------------------------------------------

async function clockOf(): Promise<Date> {
	const [row] = await db.$queryRaw<
		Array<{ now: Date }>
	>`SELECT (now() AT TIME ZONE 'UTC') AS "now"`;
	return row?.now ?? new Date();
}

/** A branch row with the database clock read beside it. */
export type BranchWithClock = BranchRow & { databaseNow: Date };

/** One branch by id, scoped to its organization, with the database clock. */
export async function getProposalBranch(i: {
	branchId: string;
	organizationId: string;
}): Promise<BranchWithClock | null> {
	const [row, now] = await Promise.all([
		db.projectInstructionProposalBranch.findFirst({
			where: { id: i.branchId, organizationId: i.organizationId },
		}),
		clockOf(),
	]);
	return row ? { ...row, databaseNow: now } : null;
}

const BRANCH_PROPOSAL_SELECT = {
	...PROPOSAL_SELECT,
	contentKind: true,
	baseSnapshotId: true,
} satisfies Prisma.ProjectInstructionSnapshotSelect;

/** A proposal as the branch activities read it, with the database clock. */
export type BranchProposalRow = Prisma.ProjectInstructionSnapshotGetPayload<{
	select: typeof BRANCH_PROPOSAL_SELECT;
}> & { databaseNow: Date };

/** One proposal by id, scoped to its organization, with the database clock. */
export async function getBranchProposal(i: {
	snapshotId: string;
	organizationId: string;
}): Promise<BranchProposalRow | null> {
	const [row, now] = await Promise.all([
		db.projectInstructionSnapshot.findFirst({
			where: { id: i.snapshotId, organizationId: i.organizationId },
			select: BRANCH_PROPOSAL_SELECT,
		}),
		clockOf(),
	]);
	return row ? { ...row, databaseNow: now } : null;
}

/** One journal operation as the branch activities read it. */
export type BranchOperationRow = {
	id: string;
	branchId: string;
	snapshotId: string;
	kind: "APPEND" | "REVERT";
	executionSeq: number;
	assignment: number;
	attempt: number;
	ref: string;
	parentSha: string | null;
	sha: string;
	entries: BranchOperationEntryRecord[];
	outcome: OpOutcome;
	membership: string | null;
};

const OPERATION_SELECT = {
	id: true,
	branchId: true,
	snapshotId: true,
	kind: true,
	executionSeq: true,
	assignment: true,
	attempt: true,
	ref: true,
	parentSha: true,
	sha: true,
	entries: true,
	outcome: true,
	membership: true,
} satisfies Prisma.ProjectInstructionProposalBranchOperationSelect;

function operationRowOf(
	r: Prisma.ProjectInstructionProposalBranchOperationGetPayload<{
		select: typeof OPERATION_SELECT;
	}>,
): BranchOperationRow {
	return {
		...r,
		entries: parseOperationEntries(r.entries),
		outcome: r.outcome as OpOutcome,
	};
}

/** Every journal operation on the branch, in `executionSeq` order. */
export async function listBranchOperations(i: {
	branchId: string;
	organizationId: string;
}): Promise<BranchOperationRow[]> {
	const rows = await db.projectInstructionProposalBranchOperation.findMany({
		where: { branchId: i.branchId, organizationId: i.organizationId },
		select: OPERATION_SELECT,
		orderBy: { executionSeq: "asc" },
	});
	return rows.map(operationRowOf);
}

/** One journal operation by id. */
export async function getBranchOperation(i: {
	operationId: string;
	organizationId: string;
}): Promise<BranchOperationRow | null> {
	const row = await db.projectInstructionProposalBranchOperation.findFirst({
		where: { id: i.operationId, organizationId: i.organizationId },
		select: OPERATION_SELECT,
	});
	return row ? operationRowOf(row) : null;
}

/** One established write on one of the member's open branches (spec §6.4 step 5). */
export type MemberBranchWrite = {
	branchId: string;
	kind: "APPEND" | "REVERT";
	executionSeq: number;
	snapshotId: string;
	/** The writing proposal's assignment when the operation was issued. */
	assignment: number;
	rawPaths: string[];
	/** The writing proposal's `proposalIntentOrder` now. */
	intentOrder: bigint | null;
};

/**
 * The established journal writes on every branch of the member that is not
 * terminal (spec §6.4 step 5 "on this or any earlier branch still open for
 * the member"), in the one repository `repositoryKey` names, with each
 * writer's intent order. Untracked branches are CLOSED, so never included.
 */
export async function listMemberBranchWrites(i: {
	projectId: string;
	userId: string;
	organizationId: string;
	repositoryKey: string;
}): Promise<MemberBranchWrite[]> {
	const branches = await db.projectInstructionProposalBranch.findMany({
		where: {
			projectId: i.projectId,
			userId: i.userId,
			organizationId: i.organizationId,
			repositoryKey: i.repositoryKey,
			untracked: false,
			state: { notIn: [...TERMINAL_BRANCH_STATES] },
		},
		select: { id: true },
	});
	if (branches.length === 0) {
		return [];
	}
	const ops = await db.projectInstructionProposalBranchOperation.findMany({
		where: {
			organizationId: i.organizationId,
			branchId: { in: branches.map((b) => b.id) },
			outcome: { in: ["acked", "observed"] },
		},
		select: {
			branchId: true,
			kind: true,
			executionSeq: true,
			snapshotId: true,
			assignment: true,
			entries: true,
		},
	});
	const snapshotIds = [...new Set(ops.map((op) => op.snapshotId))];
	const orders = await db.projectInstructionSnapshot.findMany({
		where: { organizationId: i.organizationId, id: { in: snapshotIds } },
		select: { id: true, proposalIntentOrder: true },
	});
	const orderOf = new Map(orders.map((o) => [o.id, o.proposalIntentOrder]));
	return ops.map((op) => ({
		branchId: op.branchId,
		kind: op.kind,
		executionSeq: op.executionSeq,
		snapshotId: op.snapshotId,
		assignment: op.assignment,
		rawPaths: parseOperationEntries(op.entries).map((e) => e.rawPath),
		intentOrder: orderOf.get(op.snapshotId) ?? null,
	}));
}

/**
 * The names the branch's presentation is rendered from (spec §6.1, Decision
 * 13), and whether the branch carries a move from uploads into the repository
 * (Fizzy #2878 §9): the project's open move names a proposal that is on this
 * branch, so its pull request says what it is for.
 */
export async function getBranchPresentationInputs(i: {
	branchId: string;
	organizationId: string;
}): Promise<{
	memberName: string | null;
	projectName: string | null;
	migration: boolean;
} | null> {
	const branch = await db.projectInstructionProposalBranch.findFirst({
		where: { id: i.branchId, organizationId: i.organizationId },
		select: { userId: true, projectId: true },
	});
	if (!branch) {
		return null;
	}
	const [user, project] = await Promise.all([
		db.user.findFirst({
			where: { id: branch.userId },
			select: { name: true },
		}),
		db.project.findFirst({
			where: { id: branch.projectId, organizationId: i.organizationId },
			select: { name: true, instructionSettings: true },
		}),
	]);
	const pointer = migrationOfSettings(project?.instructionSettings);
	const migration =
		pointer !== null &&
		pointer.snapshotId !== null &&
		(await db.projectInstructionSnapshot.count({
			where: {
				id: pointer.snapshotId,
				projectId: branch.projectId,
				organizationId: i.organizationId,
				proposalBranchId: i.branchId,
			},
		})) > 0;
	return {
		memberName: user?.name ?? null,
		projectName: project?.name ?? null,
		migration,
	};
}

/** A failure JSON a branch writer records itself, stamped on the database clock. */
function failureAt(
	phase: PullRequestFailure["phase"],
	code: PullRequestFailure["code"],
	now: Date,
	params: PullRequestFailure["params"] = {},
): PullRequestFailure {
	return { phase, code, retryable: false, at: now.toISOString(), params };
}

const asInputJson = (value: unknown) =>
	value as unknown as Prisma.InputJsonValue;

type ProposalAuditFields = Pick<
	ProposalRow,
	"id" | "version" | "projectId" | "pullRequestOperationId"
>;

/** `pull_request_reconciled` for a proposal a branch writer made terminal. */
function proposalReconciledAudit(
	p: ProposalAuditFields,
	organizationId: string,
	branchId: string,
	code: string,
): RecordAuditInput {
	return {
		action: "project.instructions.pull_request_reconciled",
		category: "project",
		actor: { type: "system" },
		organizationId,
		projectId: p.projectId,
		resource: {
			type: "project_instruction_snapshot",
			id: p.id,
			name: `v${p.version}`,
		},
		metadata: {
			outcome: "canceled",
			operationId: p.pullRequestOperationId,
			code,
			branchId,
			targetMismatch: false,
		},
	};
}

/**
 * The all-no-op finalization's verdict (spec §6.4 step 5 "No-op guard"),
 * after the reducer ran in the same transaction and changed nothing: any
 * append of the current submission still `unknown` or issued keeps the
 * proposal's own push unresolved, so it is BLOCKED PUSH_OUTCOME_UNKNOWN and
 * never terminal; with none left it is CANCELED ALREADY_ON_BRANCH.
 */
export function planNoOpFinalization(i: {
	ops: readonly EvidenceOp[];
	branchId: string;
	assignment: number;
}): "cancel" | "unresolved" {
	const unresolved = i.ops.some(
		(op) =>
			op.kind === "APPEND" &&
			op.branchId === i.branchId &&
			op.assignment === i.assignment &&
			(op.outcome === null || op.outcome === "unknown"),
	);
	return unresolved ? "unresolved" : "cancel";
}

/**
 * The all-no-op finalization (spec §4.3 "All no-op" rows, §6.4 step 5), one
 * transaction under §4.7: `reconcileProposalFromEvidence` first; a lifecycle
 * change stops the claim (`changed`). Otherwise, at the claimed attempt,
 * `planNoOpFinalization` decides BLOCKED PUSH_OUTCOME_UNKNOWN
 * (`push_unknown`, the pending command kept) or CANCELED ALREADY_ON_BRANCH
 * (`branch_evidence`, the command cleared, one `pull_request_reconciled`).
 */
export async function finalizeBranchNoOp(i: {
	branchId: string;
	organizationId: string;
	snapshotId: string;
	proposalAttempt: number;
}): Promise<{ kind: "changed" | "canceled" | "blocked" | "moved" }> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [i.snapshotId],
		},
		async (tx) => {
			const reconciled = await reconcileProposalFromEvidence(tx, {
				snapshotId: i.snapshotId,
				organizationId: i.organizationId,
			});
			if (reconciled.changed) {
				return { kind: "changed" as const };
			}
			const p = await readProposal(tx, i.snapshotId, i.organizationId);
			if (
				!p ||
				p.proposalBranchId !== i.branchId ||
				p.pullRequestState !== "OPENING" ||
				p.pullRequestAttempt !== i.proposalAttempt
			) {
				return { kind: "moved" as const };
			}
			const ops =
				await tx.projectInstructionProposalBranchOperation.findMany({
					where: {
						organizationId: i.organizationId,
						branchId: i.branchId,
						snapshotId: i.snapshotId,
					},
					select: {
						id: true,
						kind: true,
						executionSeq: true,
						assignment: true,
						branchId: true,
						outcome: true,
					},
				});
			const plan = planNoOpFinalization({
				ops: ops.map((op) => ({
					...op,
					outcome: op.outcome as OpOutcome,
				})),
				branchId: i.branchId,
				assignment: p.proposalAssignment,
			});
			const now = await databaseNow(tx);
			if (plan === "unresolved") {
				const moved = await transitionPullRequest(
					{
						snapshotId: p.id,
						organizationId: i.organizationId,
						event: "push_unknown",
						from: ["OPENING"],
						expectedAttempt: i.proposalAttempt,
						to: "BLOCKED",
						bumpAttempt: false,
						data: {
							pullRequestFailure: asInputJson(
								failureAt(
									"append",
									"PUSH_OUTCOME_UNKNOWN",
									now,
								),
							),
							pullRequestNextAttemptAt: null,
						},
					},
					tx,
				);
				return {
					kind: moved.ok ? ("blocked" as const) : ("moved" as const),
				};
			}
			const moved = await transitionPullRequest(
				{
					snapshotId: p.id,
					organizationId: i.organizationId,
					event: "branch_evidence",
					from: ["OPENING"],
					expectedAttempt: i.proposalAttempt,
					to: "CANCELED",
					bumpAttempt: true,
					branch: {
						id: i.branchId,
						assignment: p.proposalAssignment,
					},
					data: {
						pullRequestFailure: asInputJson(
							failureAt("append", "ALREADY_ON_BRANCH", now),
						),
						pullRequestNextAttemptAt: null,
						pendingCommand: null,
						pendingCommandSeq: null,
					},
					audit: proposalReconciledAudit(
						p,
						i.organizationId,
						i.branchId,
						"ALREADY_ON_BRANCH",
					),
				},
				tx,
			);
			return {
				kind: moved.ok ? ("canceled" as const) : ("moved" as const),
			};
		},
	);
}

/** OPENING at the claimed attempt back to QUEUED on the same branch (`branch_transfer`). */
async function releaseClaimTx(
	tx: Prisma.TransactionClient,
	i: {
		branchId: string;
		organizationId: string;
		snapshotId: string;
		proposalAttempt: number;
	},
): Promise<boolean> {
	const p = await readProposal(tx, i.snapshotId, i.organizationId);
	if (
		!p ||
		p.proposalBranchId !== i.branchId ||
		p.pullRequestState !== "OPENING" ||
		p.pullRequestAttempt !== i.proposalAttempt
	) {
		return false;
	}
	const moved = await transitionPullRequest(
		{
			snapshotId: p.id,
			organizationId: i.organizationId,
			event: "branch_transfer",
			from: ["OPENING"],
			expectedAttempt: i.proposalAttempt,
			to: "QUEUED",
			bumpAttempt: true,
			branch: { id: i.branchId, assignment: p.proposalAssignment },
			data: { pullRequestFailure: null, pullRequestNextAttemptAt: null },
		},
		tx,
	);
	return moved.ok;
}

/**
 * Releases a claim back to QUEUED (spec §6.3 receipt check, §6.4 step 1),
 * optionally retiring the branch first in the same transaction: a recorded
 * head whose ref is absent is `BRANCH_MISSING` (spec §4.4 "Retire"), and the
 * released proposal is then rehomable. The retirement is a fact and stands
 * even when the proposal moved first.
 */
export async function releaseBranchClaim(i: {
	branchId: string;
	organizationId: string;
	snapshotId: string;
	proposalAttempt: number;
	retire?: "BRANCH_MISSING";
}): Promise<{ released: boolean; retired: boolean }> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [i.snapshotId],
		},
		async (tx) => {
			const retired = i.retire
				? await retireBranch(tx, {
						branchId: i.branchId,
						organizationId: i.organizationId,
						reason: i.retire,
					})
				: false;
			const released = await releaseClaimTx(tx, i);
			return { released, retired };
		},
	);
}

/**
 * The §4.3 revert-failure row's lifecycle: OPEN with the failure, the
 * pending command cleared, and the intent pair cleared only while its scope
 * is `change` (a `branch` intent set by a later Close is newer and kept).
 */
export function withdrawalRefusedLifecycle(
	current: ProposalLifecycle,
	failure: PullRequestFailure,
): ProposalLifecycle {
	return {
		state: "OPEN",
		failure,
		command: null,
		intent: current.intent?.scope === "branch" ? current.intent : null,
	};
}

/**
 * A withdrawal refused at revert time (spec §4.3 "Revert refused", §6.8
 * step 2): CLOSE_REQUESTED at the attempt the revert read goes back to OPEN
 * per `withdrawalRefusedLifecycle`, decided under the proposal's row lock so
 * a Close that changed the intent first is honoured. `branchFailure` also
 * records a failure-only fact on the branch (REPOSITORY_CHANGED).
 */
export async function refuseBranchWithdrawal(i: {
	branchId: string;
	organizationId: string;
	snapshotId: string;
	proposalAttempt: number;
	failure: PullRequestFailure;
	branchFailure?: PullRequestFailure;
}): Promise<{ ok: boolean }> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [i.snapshotId],
		},
		async (tx) => {
			if (i.branchFailure) {
				await tx.projectInstructionProposalBranch.updateMany({
					where: {
						id: i.branchId,
						organizationId: i.organizationId,
						untracked: false,
					},
					data: { failure: asInputJson(i.branchFailure) },
				});
			}
			const p = await readProposal(tx, i.snapshotId, i.organizationId);
			if (
				!p ||
				p.proposalBranchId !== i.branchId ||
				p.pullRequestState !== "CLOSE_REQUESTED" ||
				p.pullRequestAttempt !== i.proposalAttempt
			) {
				return { ok: false };
			}
			const next = withdrawalRefusedLifecycle(
				lifecycleOfRow({
					state: p.pullRequestState,
					failure: p.pullRequestFailure,
					withdrawRequestedAt: p.withdrawRequestedAt,
					withdrawScope: p.withdrawScope,
					pendingCommand: p.pendingCommand,
					pendingCommandSeq: p.pendingCommandSeq,
				}),
				i.failure,
			);
			const moved = await transitionPullRequest(
				{
					snapshotId: p.id,
					organizationId: i.organizationId,
					event: "branch_evidence",
					from: ["CLOSE_REQUESTED"],
					expectedAttempt: i.proposalAttempt,
					to: "OPEN",
					bumpAttempt: true,
					branch: {
						id: i.branchId,
						assignment: p.proposalAssignment,
					},
					data: {
						...lifecycleColumns(next),
						pullRequestNextAttemptAt: null,
					},
				},
				tx,
			);
			return { ok: moved.ok };
		},
	);
}

/** A failure-only fact on the branch (REPOSITORY_CHANGED, a create failure kept on its state). */
export async function recordBranchFailure(i: {
	branchId: string;
	organizationId: string;
	failure: PullRequestFailure;
	nextAttemptAt?: Date | null;
}): Promise<boolean> {
	const { count } = await db.projectInstructionProposalBranch.updateMany({
		where: {
			id: i.branchId,
			organizationId: i.organizationId,
			untracked: false,
		},
		data: {
			failure: asInputJson(i.failure),
			...(i.nextAttemptAt !== undefined
				? { nextAttemptAt: i.nextAttemptAt }
				: {}),
		},
	});
	return count === 1;
}

/** What a branch receipt or observation records of a pull request. */
export type BranchPullRequestObservation = {
	externalId: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	targetRef: string;
	headSha: string;
	mergedAt?: string;
	closedAt?: string;
	mergeCommitSha?: string;
};

/** The branch's `pullRequestObservation` JSON (as #2563's, per branch). */
export function branchObservationJson(
	o: BranchPullRequestObservation,
	frozenTargetRef: string | null,
): Record<string, unknown> {
	return {
		targetRef: o.targetRef,
		headSha: o.headSha,
		mergedAt: o.mergedAt ?? null,
		closedAt: o.closedAt ?? null,
		mergeCommitSha: o.mergeCommitSha ?? null,
		targetMismatch:
			frozenTargetRef !== null && o.targetRef !== frozenTargetRef,
	};
}

function branchResource(branch: Pick<BranchRow, "id" | "number">) {
	return {
		type: "project_instruction_proposal_branch",
		id: branch.id,
		name: `#${branch.number}`,
	};
}

function pendingMembership(now: Date): BranchMembership {
	return { status: "pending", at: now.toISOString(), attempts: 0 };
}

/**
 * The branch create's receipt or an adoption (spec §6.5, §4.4 "Receipt or
 * adoption"): at the attempt the caller read, a branch in `from` moves to
 * the pull request's state with its receipt, the create marker, failure and
 * backoff cleared, and `pull_request_opened` (plus `pull_request_reconciled`
 * when already terminal, with membership `pending`). A branch that moved
 * first (a Close landed) still records the receipt facts, unfenced, and
 * keeps its state (`facts`), as #2563 records one on CLOSE_REQUESTED.
 */
export async function recordBranchReceipt(i: {
	branchId: string;
	organizationId: string;
	expectedAttempt: number;
	from: BranchState[];
	observation: BranchPullRequestObservation;
	adopted: boolean;
	/**
	 * Start over's adoption (spec §6.7 step 1): the move out of
	 * CLOSE_REQUESTED also clears `closeIntent` and the settlement
	 * checkpoint, so settlement ends there.
	 */
	endsSettlement?: boolean;
}): Promise<{ kind: "moved" | "facts" | "stale" }> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await tx.projectInstructionProposalBranch.findFirst({
				where: { id: i.branchId, organizationId: i.organizationId },
			});
			const o = i.observation;
			if (
				!branch ||
				branch.untracked ||
				(branch.pullRequestExternalId !== null &&
					branch.pullRequestExternalId !== o.externalId)
			) {
				return { kind: "stale" as const };
			}
			const now = await databaseNow(tx);
			const destination = parseBranchDestination(branch.destination);
			const terminal = o.state !== "OPEN";
			const receipt: BranchColumns = {
				pullRequestUrl: o.url,
				pullRequestExternalId: o.externalId,
				pullRequestObservation: asInputJson(
					branchObservationJson(o, destination?.targetRef ?? null),
				),
				lastCheckedAt: now,
				createIssuedAt: null,
			};
			const opened: RecordAuditInput = {
				action: "project.instructions.pull_request_opened",
				category: "project",
				actor: { type: "user", userId: branch.userId },
				organizationId: i.organizationId,
				projectId: branch.projectId,
				resource: branchResource(branch),
				metadata: {
					provider: destination?.provider ?? null,
					branchId: branch.id,
					externalId: o.externalId,
					adopted: i.adopted,
				},
			};
			if (
				i.from.includes(branch.state) &&
				branch.attempt === i.expectedAttempt &&
				isLegalBranchMove(branch.state, o.state)
			) {
				const moved = await transitionBranch(
					{
						branchId: branch.id,
						organizationId: i.organizationId,
						from: [branch.state],
						expectedAttempt: i.expectedAttempt,
						to: o.state,
						bumpAttempt: true,
						data: {
							...receipt,
							failure: null,
							nextAttemptAt: null,
							retryRequestedAt: null,
							...(i.endsSettlement
								? { closeIntent: null, settlementPhase: null }
								: {}),
							...(terminal
								? {
										membership: asInputJson(
											pendingMembership(now),
										),
									}
								: {}),
						},
					},
					tx,
				);
				if (moved.ok) {
					await recordAuditTx(tx, opened);
					if (terminal) {
						await recordAuditTx(tx, {
							action: "project.instructions.pull_request_reconciled",
							category: "project",
							actor: { type: "system" },
							organizationId: i.organizationId,
							projectId: branch.projectId,
							resource: branchResource(branch),
							metadata: {
								outcome:
									o.state === "MERGED" ? "merged" : "closed",
								branchId: branch.id,
								externalId: o.externalId,
								targetMismatch:
									destination !== null &&
									o.targetRef !== destination.targetRef,
							},
						});
					}
					return { kind: "moved" as const };
				}
			}
			if (
				isTerminalBranchState(branch.state) ||
				branch.pullRequestExternalId !== null
			) {
				return { kind: "stale" as const };
			}
			const facts = await transitionBranch(
				{
					branchId: branch.id,
					organizationId: i.organizationId,
					from: [branch.state],
					expectedAttempt: branch.attempt,
					to: "unchanged",
					bumpAttempt: false,
					data: receipt,
				},
				tx,
			);
			if (!facts.ok) {
				return { kind: "stale" as const };
			}
			await recordAuditTx(tx, opened);
			return { kind: "facts" as const };
		},
	);
}

/**
 * The append's receipt check (spec §6.3): a pull request that is no longer
 * open is observed (an OPEN branch becomes MERGED or CLOSED with the
 * observation, membership `pending`, one `pull_request_reconciled`), and the
 * claim, when given, is released back to QUEUED, in one transaction.
 */
export async function recordBranchObservation(i: {
	branchId: string;
	organizationId: string;
	observation: BranchPullRequestObservation;
	release?: { snapshotId: string; proposalAttempt: number };
	/**
	 * The sweeper's reconcile (spec §6.6 "Observation"): the branch attempt
	 * the caller read before it asked the provider. A branch that moved
	 * since is left alone.
	 */
	expectedAttempt?: number;
}): Promise<{ observed: boolean; released: boolean }> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: i.release ? [i.release.snapshotId] : [],
		},
		async (tx) => {
			const branch = await tx.projectInstructionProposalBranch.findFirst({
				where: { id: i.branchId, organizationId: i.organizationId },
			});
			const o = i.observation;
			let observed = false;
			if (
				branch &&
				branch.state === "OPEN" &&
				o.state !== "OPEN" &&
				branch.pullRequestExternalId === o.externalId &&
				(i.expectedAttempt === undefined ||
					branch.attempt === i.expectedAttempt)
			) {
				const now = await databaseNow(tx);
				const destination = parseBranchDestination(branch.destination);
				const moved = await transitionBranch(
					{
						branchId: branch.id,
						organizationId: i.organizationId,
						from: ["OPEN"],
						expectedAttempt: branch.attempt,
						to: o.state,
						bumpAttempt: true,
						data: {
							pullRequestObservation: asInputJson(
								branchObservationJson(
									o,
									destination?.targetRef ?? null,
								),
							),
							lastCheckedAt: now,
							membership: asInputJson(pendingMembership(now)),
						},
					},
					tx,
				);
				if (moved.ok) {
					observed = true;
					await recordAuditTx(tx, {
						action: "project.instructions.pull_request_reconciled",
						category: "project",
						actor: { type: "system" },
						organizationId: i.organizationId,
						projectId: branch.projectId,
						resource: branchResource(branch),
						metadata: {
							outcome: o.state === "MERGED" ? "merged" : "closed",
							branchId: branch.id,
							externalId: o.externalId,
							targetMismatch:
								destination !== null &&
								o.targetRef !== destination.targetRef,
						},
					});
				}
			}
			const released = i.release
				? await releaseClaimTx(tx, {
						branchId: i.branchId,
						organizationId: i.organizationId,
						snapshotId: i.release.snapshotId,
						proposalAttempt: i.release.proposalAttempt,
					})
				: false;
			return { observed, released };
		},
	);
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The §4.4 "Release" row (spec §6.5, #2563 `releaseAbandonedPush` on the
 * branch), one transaction under §4.7: a releasable BLOCKED branch at the
 * attempt the caller read becomes CANCELED and settled (`settledAt`, the 1 h
 * confirmation due; `deletedAt` only when the caller's leased delete itself
 * succeeded), and every non-terminal proposal on it becomes CANCELED with
 * the branch's refusal code, its pending command cleared.
 */
export async function releaseBlockedBranch(i: {
	branchId: string;
	organizationId: string;
	expectedAttempt: number;
	refDeleted: boolean;
}): Promise<{ ok: boolean; canceled: number }> {
	return withBranchLockOrder(
		{
			organizationId: i.organizationId,
			branchIds: [i.branchId],
			snapshotIds: [],
		},
		async (tx) => {
			const branch = await tx.projectInstructionProposalBranch.findFirst({
				where: { id: i.branchId, organizationId: i.organizationId },
			});
			if (
				!branch ||
				branch.untracked ||
				branch.attempt !== i.expectedAttempt ||
				!isReleasableBranch(branch)
			) {
				return { ok: false, canceled: 0 };
			}
			const now = await databaseNow(tx);
			const code = (failureOf(branch.failure).code ??
				"CONFIGURATION_CHANGED") as PullRequestFailure["code"];
			// Proposals after the branch, by id (§4.7 step 3).
			const proposals = await tx.$queryRaw<
				Array<{
					id: string;
					version: number;
					projectId: string;
					state: ProposalState;
					attempt: number;
					assignment: number;
					pullRequestOperationId: string | null;
				}>
			>`
				SELECT "id", "version", "projectId", "pullRequestState"::text AS "state",
					"pullRequestAttempt" AS "attempt", "proposalAssignment" AS "assignment",
					"pullRequestOperationId"
				FROM "project_instruction_snapshot"
				WHERE "proposalBranchId" = ${branch.id} AND "organizationId" = ${i.organizationId}
					AND "pullRequestState" IN ('QUEUED', 'OPENING', 'OPEN', 'CLOSE_REQUESTED', 'BLOCKED')
				ORDER BY "id" FOR UPDATE`;
			for (const p of proposals) {
				const moved = await transitionPullRequest(
					{
						snapshotId: p.id,
						organizationId: i.organizationId,
						event: "branch_evidence",
						from: [p.state],
						expectedAttempt: Number(p.attempt),
						to: "CANCELED",
						bumpAttempt: true,
						branch: {
							id: branch.id,
							assignment: Number(p.assignment),
						},
						data: {
							pullRequestFailure: asInputJson(
								failureAt("create", code, now),
							),
							pullRequestNextAttemptAt: null,
							pendingCommand: null,
							pendingCommandSeq: null,
						},
						audit: proposalReconciledAudit(
							p,
							i.organizationId,
							branch.id,
							code,
						),
					},
					tx,
				);
				if (!moved.ok) {
					throw new Error(
						"A locked proposal refused its branch's release",
					);
				}
			}
			const moved = await transitionBranch(
				{
					branchId: branch.id,
					organizationId: i.organizationId,
					from: ["BLOCKED"],
					expectedAttempt: i.expectedAttempt,
					to: "CANCELED",
					bumpAttempt: true,
					data: {
						settledAt: now,
						confirmations: 0,
						confirmationDueAt: new Date(now.getTime() + HOUR_MS),
						nextAttemptAt: null,
						...(i.refDeleted ? { deletedAt: now } : {}),
					},
				},
				tx,
			);
			if (!moved.ok) {
				throw new Error("A locked proposal branch refused its release");
			}
			return { ok: true, canceled: proposals.length };
		},
	);
}
