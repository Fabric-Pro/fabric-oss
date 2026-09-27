/**
 * An in-memory model of the member proposal branch query layer (Fizzy #2738
 * plan Tasks 3, 7 and 8) for the branch activity tests. Its fences and
 * conditional writes mirror `instruction-proposal-branches.ts`; everything
 * that decides lifecycle is the REAL pure code, passed in from the actual
 * `@repo/database` module: `reduceProposalLifecycle`, `outcomeTransition`
 * (through `planOutcomeFact`), `lifecycleOfRow`/`lifecycleColumns`,
 * `pickRunnableHead`, `acceptsAppends`, `isLegalBranchMove`, the
 * pull-request transition table and its exact-audit rule (with its
 * `established_current_revert` requirement, through
 * `hasEstablishedCurrentRevert`), `planNoOpFinalization` and
 * `withdrawalRefusedLifecycle`. The real
 * statements are pinned against Postgres in packages/database. Every
 * identifier is synthetic.
 */
import type * as Database from "@repo/database";

type Real = typeof Database;
type BranchRow = Database.BranchRow;
type OpOutcome = Database.OpOutcome;
type PullRequestFailure = Database.PullRequestFailure;
type EntryRecord = Database.BranchOperationEntryRecord;

export type FakeBranch = BranchRow;

export type FakeProposal = {
	id: string;
	projectId: string;
	organizationId: string;
	userId: string;
	version: number;
	status: string;
	proposalStatus: string | null;
	proposalDestination: string | null;
	pullRequestOperationId: string | null;
	pullRequestState: Database.BranchProposalRow["pullRequestState"];
	pullRequestAttempt: number;
	pullRequestContext: unknown;
	pullRequestFailure: PullRequestFailure | null;
	pullRequestNextAttemptAt: Date | null;
	proposalBranchId: string | null;
	proposalBranchSequence: number | null;
	proposalAssignment: number;
	proposalIntentOrder: bigint | null;
	withdrawRequestedAt: Date | null;
	withdrawScope: string | null;
	pendingCommand: string | null;
	pendingCommandSeq: number | null;
	baseSnapshotId: string | null;
};

export type FakeOp = {
	id: string;
	organizationId: string;
	branchId: string;
	snapshotId: string;
	kind: "APPEND" | "REVERT";
	executionSeq: number;
	ref: string;
	assignment: number;
	attempt: number;
	parentSha: string | null;
	sha: string;
	entries: EntryRecord[];
	pushIssuedAt: Date | null;
	pushAckedAt: Date | null;
	observedAt: Date | null;
	outcome: OpOutcome;
	membership: string | null;
};

export type FakeFile = {
	path: string;
	sha256: string;
	mode: number | null;
	storageKey: string;
};

export type FakeState = {
	now: Date;
	branches: Map<string, FakeBranch>;
	proposals: Map<string, FakeProposal>;
	ops: FakeOp[];
	reservations: Array<{
		repositoryKey: string;
		ref: string;
		branchId: string;
		status: string;
	}>;
	files: Map<string, FakeFile[]>;
	audits: Array<{ action: string; metadata?: Record<string, unknown> }>;
	/** Ordered trace of fact and lifecycle writes, for order assertions. */
	trace: string[];
	userNames: Map<string, string>;
	projectName: string;
	sync: unknown;
	settings: { sourceOfTruth: string };
	canCreate: boolean;
	canRead: boolean;
	nextOpId: number;
	/** `transferProposal` answers forced by a test, by snapshot id. */
	transferAnswers: Map<string, "not_joinable" | "configuration_changed">;
	/** Sync run receipts the merge-sync reads (`getSyncRunReceiptByRunId`, `findMergeTriggeredRun`). */
	syncRuns: FakeSyncRun[];
	/**
	 * Awaited at the start of every `recordBranchOperation`, before any
	 * check: a test interleaves two overlapping attempts here.
	 */
	beforeIssue: null | (() => Promise<void>);
};

export type FakeSyncRun = {
	id: string;
	runId: string;
	projectId: string;
	syncId: string;
	generation: number;
	trigger: string;
	startedAt: Date;
	status: string | null;
	error: string | null;
};

const clone = <T>(v: T): T => structuredClone(v);

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

const NON_TERMINAL = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"BLOCKED",
];
const TERMINAL_BRANCH = ["MERGED", "CLOSED", "CANCELED"];
const ACCEPTING_BRANCH = ["PENDING", "OPENING", "OPEN", "BLOCKED"];
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
];

export function createFakeDatabase(real: Real) {
	const state: FakeState = {
		now: new Date("2026-09-26T12:00:00.000Z"),
		branches: new Map(),
		proposals: new Map(),
		ops: [],
		reservations: [],
		files: new Map(),
		audits: [],
		trace: [],
		userNames: new Map(),
		projectName: "Example Project",
		sync: null,
		settings: { sourceOfTruth: "REPOSITORY" },
		canCreate: true,
		canRead: true,
		nextOpId: 1,
		transferAnswers: new Map(),
		syncRuns: [],
		beforeIssue: null,
	};

	const branchOf = (id: string, org: string) => {
		const b = state.branches.get(id);
		return b && b.organizationId === org ? b : null;
	};
	const proposalOf = (id: string, org: string) => {
		const p = state.proposals.get(id);
		return p && p.organizationId === org ? p : null;
	};
	const evidence = (op: FakeOp): Database.EvidenceOp => ({
		id: op.id,
		kind: op.kind,
		executionSeq: op.executionSeq,
		assignment: op.assignment,
		branchId: op.branchId,
		outcome: op.outcome,
	});
	const opRow = (op: FakeOp): Database.BranchOperationRow => ({
		id: op.id,
		branchId: op.branchId,
		snapshotId: op.snapshotId,
		kind: op.kind,
		executionSeq: op.executionSeq,
		assignment: op.assignment,
		attempt: op.attempt,
		ref: op.ref,
		parentSha: op.parentSha,
		sha: op.sha,
		entries: clone(op.entries),
		outcome: op.outcome,
		membership: op.membership,
	});

	// -- transitions ---------------------------------------------------------

	function transitionPullRequest(i: {
		snapshotId: string;
		organizationId: string;
		event: Database.PullRequestEvent;
		from: readonly string[];
		expectedAttempt: number | null;
		to: string;
		bumpAttempt: boolean;
		data?: Record<string, unknown>;
		audit?:
			| Database.RecordAuditInput
			| readonly Database.RecordAuditInput[];
		branch?: { id: string; assignment: number };
	}): { ok: true; attempt: number } | { ok: false } {
		const rule = real.PULL_REQUEST_TRANSITIONS[i.event];
		if (i.bumpAttempt !== rule.bump) {
			throw new Error(`${i.event} bump mismatch`);
		}
		const arms = i.from.map((from) => {
			const arm = rule.from.find(
				(r) =>
					r.state === from &&
					(r.to as readonly string[]).includes(i.to),
			);
			if (!arm) {
				throw new Error(
					`Illegal pull-request transition: ${i.event} from ${from} to ${i.to}`,
				);
			}
			return arm;
		});
		const audits = i.audit === undefined ? [] : [i.audit].flat();
		const want = [
			...real.requiredPullRequestAudits(
				i.event,
				i.to as Parameters<Real["requiredPullRequestAudits"]>[1],
			),
		].sort();
		const got = audits.map((a) => a.action).sort();
		if (JSON.stringify(want) !== JSON.stringify(got)) {
			throw new Error(
				`${i.event} to ${i.to} writes exactly ${want.join(", ")}; got ${got.join(", ")}`,
			);
		}
		if (
			i.branch !== undefined &&
			!(real.BRANCH_PULL_REQUEST_EVENTS as readonly string[]).includes(
				i.event,
			)
		) {
			throw new Error(`${i.event} takes no branch fence`);
		}
		const p = proposalOf(i.snapshotId, i.organizationId);
		if (!p || p.pullRequestState === null) {
			return { ok: false };
		}
		const armIndex = i.from.indexOf(p.pullRequestState);
		if (armIndex < 0) {
			return { ok: false };
		}
		const arm = arms[armIndex] as {
			attemptIndependent?: boolean;
			requires?: string;
		};
		if (
			!arm.attemptIndependent &&
			p.pullRequestAttempt !== i.expectedAttempt
		) {
			return { ok: false };
		}
		if (
			arm.requires === "established_current_revert" &&
			!revertCanceled(p)
		) {
			return { ok: false };
		}
		if (
			i.branch !== undefined &&
			(p.proposalBranchId !== i.branch.id ||
				p.proposalAssignment !== i.branch.assignment)
		) {
			return { ok: false };
		}
		for (const [k, v] of Object.entries(i.data ?? {})) {
			(p as Record<string, unknown>)[k] =
				v === undefined ? null : clone(v);
		}
		if (i.to !== "unchanged") {
			p.pullRequestState = i.to as FakeProposal["pullRequestState"];
			p.proposalStatus = real.proposalStatusForPullRequestState(
				i.to as NonNullable<FakeProposal["pullRequestState"]>,
			);
		}
		if (i.bumpAttempt) {
			p.pullRequestAttempt++;
		}
		for (const a of audits) {
			state.audits.push({
				action: a.action,
				metadata: a.metadata as Record<string, unknown>,
			});
		}
		state.trace.push(`proposal:${p.id}:${i.event}:${p.pullRequestState}`);
		return { ok: true, attempt: p.pullRequestAttempt };
	}

	function transitionBranch(i: {
		branchId: string;
		organizationId: string;
		from: string[];
		expectedAttempt: number;
		to: string;
		bumpAttempt: boolean;
		data?: Record<string, unknown>;
	}): { ok: true; attempt: number } | { ok: false } {
		for (const from of i.from) {
			if (
				!real.isLegalBranchMove(
					from as BranchRow["state"],
					i.to as BranchRow["state"],
				)
			) {
				throw new Error(
					`Illegal branch transition: ${from} to ${i.to}`,
				);
			}
		}
		for (const key of Object.keys(i.data ?? {})) {
			if (NOT_TRANSITION_COLUMNS.includes(key)) {
				throw new Error(`A branch transition never writes ${key}`);
			}
		}
		const b = branchOf(i.branchId, i.organizationId);
		if (
			!b ||
			!i.from.includes(b.state) ||
			b.attempt !== i.expectedAttempt ||
			b.untracked
		) {
			return { ok: false };
		}
		for (const [k, v] of Object.entries(i.data ?? {})) {
			(b as Record<string, unknown>)[k] =
				v === undefined ? null : clone(v);
		}
		if (i.to !== "unchanged") {
			b.state = i.to as BranchRow["state"];
		}
		if (i.bumpAttempt) {
			b.attempt++;
		}
		state.trace.push(`branch:${b.id}:${b.state}`);
		return { ok: true, attempt: b.attempt };
	}

	// -- the reducer, as `reconcileProposalFromEvidence` -----------------------

	function reconcile(snapshotId: string, organizationId: string) {
		const p = proposalOf(snapshotId, organizationId);
		if (!p || p.proposalBranchId === null || p.pullRequestState === null) {
			return { changed: false, row: 9 as Database.ReducerRow };
		}
		const branchId = p.proposalBranchId;
		const ops = state.ops.filter(
			(op) => op.branchId === branchId && op.snapshotId === snapshotId,
		);
		const current = real.lifecycleOfRow({
			state: p.pullRequestState,
			failure: p.pullRequestFailure,
			withdrawRequestedAt: p.withdrawRequestedAt,
			withdrawScope: p.withdrawScope,
			pendingCommand: p.pendingCommand,
			pendingCommandSeq: p.pendingCommandSeq,
		});
		const result = real.reduceProposalLifecycle({
			current,
			ops: ops.map(evidence),
			branchId,
			assignment: p.proposalAssignment,
			now: state.now,
		});
		state.trace.push(
			`reconcile:${snapshotId}:row${result.row}:${result.changed}`,
		);
		if (!result.changed) {
			return { changed: false, row: result.row };
		}
		const next = result.next;
		const moved = transitionPullRequest({
			snapshotId,
			organizationId,
			event: "branch_evidence",
			from: [p.pullRequestState],
			expectedAttempt: p.pullRequestAttempt,
			to: next.state === p.pullRequestState ? "unchanged" : next.state,
			bumpAttempt: true,
			branch: { id: branchId, assignment: p.proposalAssignment },
			data: real.lifecycleColumns(next) as Record<string, unknown>,
			audit:
				next.state === "CANCELED"
					? {
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
							metadata: { outcome: "canceled", branchId },
						}
					: undefined,
		});
		return { changed: moved.ok, row: result.row };
	}

	function retire(
		branchId: string,
		organizationId: string,
		reason: "CONFIGURATION_CHANGED" | "BRANCH_MISSING",
	): boolean {
		const b = branchOf(branchId, organizationId);
		if (
			!b ||
			b.retiredAt !== null ||
			b.untracked ||
			!ACCEPTING_BRANCH.includes(b.state)
		) {
			return false;
		}
		b.retiredAt = new Date(state.now);
		b.retiredReason = reason;
		for (const r of state.reservations) {
			if (
				r.branchId === b.id &&
				r.ref === b.ref &&
				r.status === "current"
			) {
				r.status = "retired";
			}
		}
		state.audits.push({
			action: "project.instructions.pull_request_branch_updated",
			metadata: { branchId: b.id, change: "retired", reason },
		});
		return true;
	}

	function releaseClaim(i: {
		branchId: string;
		organizationId: string;
		snapshotId: string;
		proposalAttempt: number;
	}): boolean {
		const p = proposalOf(i.snapshotId, i.organizationId);
		if (
			!p ||
			p.proposalBranchId !== i.branchId ||
			p.pullRequestState !== "OPENING" ||
			p.pullRequestAttempt !== i.proposalAttempt
		) {
			return false;
		}
		return transitionPullRequest({
			snapshotId: p.id,
			organizationId: i.organizationId,
			event: "branch_transfer",
			from: ["OPENING"],
			expectedAttempt: i.proposalAttempt,
			to: "QUEUED",
			bumpAttempt: true,
			branch: { id: i.branchId, assignment: p.proposalAssignment },
			data: { pullRequestFailure: null, pullRequestNextAttemptAt: null },
		}).ok;
	}

	// -- classification, settlement, confirmations, rehome, merge sync ---------
	// (plan Task 9): the real planners decide; these mirror the real
	// writers' fences in `instruction-proposal-branch-settlement.ts`.

	const liveOn = (branchId: string) =>
		[...state.proposals.values()]
			.filter(
				(p) =>
					p.proposalBranchId === branchId &&
					p.pullRequestState !== null &&
					NON_TERMINAL.includes(p.pullRequestState),
			)
			.sort((x, y) => (x.id < y.id ? -1 : 1));

	/**
	 * CANCELED with its current withdrawal an established revert on its
	 * current branch: the real `establishedCurrentRevertSql`.
	 */
	function revertCanceled(p: FakeProposal): boolean {
		return (
			p.pullRequestState === "CANCELED" &&
			p.proposalBranchId !== null &&
			real.hasEstablishedCurrentRevert(
				state.ops.filter((op) => op.snapshotId === p.id),
				{
					branchId: p.proposalBranchId,
					assignment: p.proposalAssignment,
				},
			)
		);
	}

	/** `lockBranchProposals` with `revertCanceled`: the classification lock set. */
	const classifiableOn = (branchId: string) =>
		[...state.proposals.values()]
			.filter(
				(p) =>
					p.proposalBranchId === branchId &&
					p.pullRequestState !== null &&
					(NON_TERMINAL.includes(p.pullRequestState) ||
						revertCanceled(p)),
			)
			.sort((x, y) => (x.id < y.id ? -1 : 1));

	const queueOf = (branchId: string) =>
		liveOn(branchId).map((p) => ({
			snapshotId: p.id,
			sequence: p.proposalBranchSequence,
			state: p.pullRequestState,
			status: p.status,
			proposalStatus: p.proposalStatus,
			withdrawRequestedAt: p.withdrawRequestedAt,
			failure: p.pullRequestFailure,
			nextAttemptAt: p.pullRequestNextAttemptAt,
			assignment: p.proposalAssignment,
			attempt: p.pullRequestAttempt,
		}));

	const opsOn = (branchId: string) =>
		state.ops
			.filter((op) => op.branchId === branchId)
			.map((op) => ({
				...evidence(op),
				snapshotId: op.snapshotId,
				membership: op.membership,
			}));

	const reconciledAudit = (
		p: FakeProposal,
		metadata: Record<string, unknown>,
	): Database.RecordAuditInput => ({
		action: "project.instructions.pull_request_reconciled",
		category: "project",
		actor: { type: "system" },
		organizationId: p.organizationId,
		projectId: p.projectId,
		resource: {
			type: "project_instruction_snapshot",
			id: p.id,
			name: `v${p.version}`,
		},
		metadata,
	});

	function applyMoves(
		b: FakeBranch,
		moves: readonly Database.ClassificationMove[],
	): number {
		let moved = 0;
		for (const move of moves) {
			const p = state.proposals.get(move.snapshotId);
			if (!p || p.pullRequestState === null) {
				continue;
			}
			const r = transitionPullRequest({
				snapshotId: p.id,
				organizationId: b.organizationId,
				event: "branch_settled",
				from: [p.pullRequestState],
				expectedAttempt: p.pullRequestAttempt,
				to: move.to,
				bumpAttempt: true,
				branch: { id: b.id, assignment: p.proposalAssignment },
				data: {
					pullRequestFailure: null,
					pullRequestNextAttemptAt: null,
					pendingCommand: null,
					pendingCommandSeq: null,
				},
				audit: reconciledAudit(p, {
					outcome: move.to.toLowerCase(),
					branchId: b.id,
					reason: move.reason,
				}),
			});
			if (!r.ok) {
				throw new Error("A locked proposal refused its classification");
			}
			moved++;
		}
		return moved;
	}

	const pendingMembership = () => ({
		status: "pending",
		at: state.now.toISOString(),
		attempts: 0,
	});

	const observationJson = (
		b: FakeBranch,
		o: Database.BranchPullRequestObservation,
	) =>
		real.branchObservationJson(
			o,
			real.parseBranchDestination(b.destination)?.targetRef ?? null,
		);

	function mergeSyncEverRequested(b: FakeBranch): boolean {
		return (
			b.mergeSyncRequestedAt !== null ||
			b.mergeSyncDispatchedAt !== null ||
			b.mergeSyncRunId !== null ||
			b.mergeSyncExpected !== null ||
			failureOf(b.failure).phase === "merge_sync"
		);
	}

	const sameTuple = (a: unknown, b: unknown) =>
		JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

	function settlementModule() {
		return {
			membershipStatusOf: real.membershipStatusOf,
			membershipNextAttemptAt: real.membershipNextAttemptAt,
			parseBranchDestination: real.parseBranchDestination,
			planBranchClassification: real.planBranchClassification,
			planBranchCancellation: real.planBranchCancellation,
			decideBranchWork: real.decideBranchWork,
			rehomableProposals: real.rehomableProposals,

			readBranchWork: async (i: {
				branchId: string;
				organizationId: string;
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (!b) {
					return {
						work: { kind: "idle" as const, wakeAt: null },
						branchAttempt: 0,
						databaseNow: new Date(state.now),
					};
				}
				return {
					work: real.decideBranchWork({
						branch: b,
						ops: opsOn(b.id),
						proposals: queueOf(b.id),
						now: new Date(state.now),
					}),
					branchAttempt: b.attempt,
					databaseNow: new Date(state.now),
				};
			},

			setOperationMembership: async (i: {
				operationId: string;
				organizationId: string;
				membership: "included" | "unverified";
			}) => {
				const op = state.ops.find(
					(o) =>
						o.id === i.operationId &&
						o.organizationId === i.organizationId,
				);
				if (
					!op ||
					(op.membership === "included" &&
						i.membership !== "included")
				) {
					return false;
				}
				op.membership = i.membership;
				state.trace.push(`membership:${op.id}:${i.membership}`);
				return true;
			},

			commitBranchClassification: async (i: {
				branchId: string;
				organizationId: string;
				factsRevision: number;
				status: "done" | "unverified";
			}) => {
				const none = { moved: 0, mergeSyncRequested: false };
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					real.membershipStatusOf(b.membership) !== "pending" ||
					(b.state !== "MERGED" && b.state !== "CLOSED")
				) {
					return { kind: "not_pending" as const, ...none };
				}
				if (b.factsRevision !== i.factsRevision) {
					return { kind: "stale_revision" as const, ...none };
				}
				const ops = opsOn(b.id);
				if (ops.some((op) => op.outcome === null)) {
					return { kind: "stale_revision" as const, ...none };
				}
				const moves = real.planBranchClassification({
					branchId: b.id,
					outcome: b.state,
					ops,
					proposals: classifiableOn(b.id).map((p) => ({
						snapshotId: p.id,
						state: p.pullRequestState as NonNullable<
							FakeProposal["pullRequestState"]
						>,
						assignment: p.proposalAssignment,
						withdrawRequestedAt: p.withdrawRequestedAt,
					})),
				});
				const moved = applyMoves(b, moves);
				const targetMismatch =
					(
						b.pullRequestObservation as {
							targetMismatch?: unknown;
						} | null
					)?.targetMismatch === true;
				const mergeSync =
					b.state === "MERGED" &&
					!targetMismatch &&
					!mergeSyncEverRequested(b);
				const previous = (b.membership ?? {}) as { attempts?: unknown };
				b.membership = {
					status: i.status,
					at: state.now.toISOString(),
					attempts:
						typeof previous.attempts === "number"
							? previous.attempts
							: 0,
				};
				if (mergeSync) {
					b.mergeSyncRequestedAt = new Date(state.now);
				}
				state.trace.push(`classified:${b.id}:${i.status}`);
				return {
					kind: "done" as const,
					moved,
					mergeSyncRequested: mergeSync,
				};
			},

			deferBranchClassification: async (i: {
				branchId: string;
				organizationId: string;
				factsRevision: number;
				delayMs: number;
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.factsRevision !== i.factsRevision ||
					real.membershipStatusOf(b.membership) !== "pending"
				) {
					return false;
				}
				const previous = b.membership as {
					at?: unknown;
					attempts?: unknown;
				};
				b.membership = {
					status: "pending",
					at:
						typeof previous.at === "string"
							? previous.at
							: state.now.toISOString(),
					attempts:
						(typeof previous.attempts === "number"
							? previous.attempts
							: 0) + 1,
					nextAttemptAt: new Date(
						state.now.getTime() + i.delayMs,
					).toISOString(),
				};
				return true;
			},

			recordBranchSettlement: async (i: {
				branchId: string;
				organizationId: string;
				expectedAttempt: number;
				outcome: "MERGED" | "CLOSED" | "CANCELED";
				observation?: Database.BranchPullRequestObservation;
			}) => {
				if (
					(i.outcome === "CANCELED") !==
					(i.observation === undefined)
				) {
					throw new Error(
						"A branch settlement records an observation exactly when a pull request was found",
					);
				}
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.state !== "CLOSE_REQUESTED" ||
					b.attempt !== i.expectedAttempt
				) {
					return { ok: false, canceled: 0 };
				}
				const canceled =
					i.outcome === "CANCELED"
						? applyMoves(
								b,
								real.planBranchCancellation({
									proposals: liveOn(b.id).map((p) => ({
										snapshotId: p.id,
										state: p.pullRequestState as NonNullable<
											FakeProposal["pullRequestState"]
										>,
										assignment: p.proposalAssignment,
										withdrawRequestedAt:
											p.withdrawRequestedAt,
									})),
								}),
							)
						: 0;
				const o = i.observation;
				const moved = transitionBranch({
					branchId: b.id,
					organizationId: i.organizationId,
					from: ["CLOSE_REQUESTED"],
					expectedAttempt: i.expectedAttempt,
					to: i.outcome,
					bumpAttempt: true,
					data: {
						settledAt: new Date(state.now),
						confirmations: 0,
						confirmationDueAt: new Date(
							state.now.getTime() + 3_600_000,
						),
						settlementPhase: "recorded",
						failure: null,
						nextAttemptAt: null,
						retryRequestedAt: null,
						...(o
							? {
									pullRequestUrl: o.url,
									pullRequestExternalId: o.externalId,
									pullRequestObservation: observationJson(
										b,
										o,
									),
									lastCheckedAt: new Date(state.now),
									membership: pendingMembership(),
								}
							: {}),
					},
				});
				if (!moved.ok) {
					throw new Error(
						"A locked proposal branch refused its settlement",
					);
				}
				state.audits.push({
					action: "project.instructions.pull_request_reconciled",
					metadata: {
						outcome: i.outcome.toLowerCase(),
						branchId: b.id,
						closeIntent: b.closeIntent,
						externalId: o?.externalId ?? null,
						canceled,
					},
				});
				return { ok: true, canceled };
			},

			refuseBranchStartOver: async (i: {
				branchId: string;
				organizationId: string;
				expectedAttempt: number;
				foreign: boolean;
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.state !== "CLOSE_REQUESTED" ||
					b.closeIntent !== "START_OVER" ||
					b.attempt !== i.expectedAttempt
				) {
					return false;
				}
				transitionBranch({
					branchId: b.id,
					organizationId: i.organizationId,
					from: ["CLOSE_REQUESTED"],
					expectedAttempt: i.expectedAttempt,
					to: "BLOCKED",
					bumpAttempt: true,
					data: {
						closeIntent: null,
						settlementPhase: null,
						failure: {
							phase: "close",
							code: "START_OVER_REFUSED",
							retryable: false,
							at: state.now.toISOString(),
							params: {},
						},
						nextAttemptAt: null,
					},
				});
				if (i.foreign && b.foreignTipAt === null) {
					b.foreignTipAt = new Date(state.now);
				}
				return true;
			},

			recordBranchDeleted: async (i: {
				branchId: string;
				organizationId: string;
				expectedAttempt: number;
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.state !== "CLOSE_REQUESTED" ||
					b.attempt !== i.expectedAttempt ||
					b.deletedAt !== null
				) {
					return false;
				}
				b.deletedAt = new Date(state.now);
				b.settlementPhase = "deleted";
				state.trace.push(`deleted:${b.id}`);
				return true;
			},

			recordBranchConfirmation: async (i: {
				branchId: string;
				organizationId: string;
				confirmations: number;
				found?: {
					observation: Database.BranchPullRequestObservation;
					to: "CLOSED" | "MERGED" | "unchanged";
				};
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.settledAt === null ||
					b.confirmationDueAt === null ||
					b.confirmations !== i.confirmations
				) {
					return false;
				}
				const count = i.confirmations + 1;
				b.confirmations = count;
				b.confirmationDueAt =
					count >= 2
						? null
						: new Date(b.settledAt.getTime() + 24 * 3_600_000);
				if (count >= 2) {
					b.createIssuedAt = null;
				}
				const f = i.found;
				if (
					f &&
					f.to !== "unchanged" &&
					b.state === "CANCELED" &&
					real.isLegalBranchMove(b.state, f.to)
				) {
					b.state = f.to;
					b.attempt++;
					b.pullRequestUrl = f.observation.url;
					b.pullRequestExternalId = f.observation.externalId;
					b.pullRequestObservation = observationJson(
						b,
						f.observation,
					) as FakeBranch["pullRequestObservation"];
					b.lastCheckedAt = new Date(state.now);
					b.membership = pendingMembership();
					state.audits.push({
						action: "project.instructions.pull_request_reconciled",
						metadata: {
							outcome: f.to.toLowerCase(),
							branchId: b.id,
							externalId: f.observation.externalId,
							confirmation: count,
						},
					});
				}
				return true;
			},

			deferBranchConfirmation: async (i: {
				branchId: string;
				organizationId: string;
				confirmations: number;
				delayMs: number;
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.confirmations !== i.confirmations ||
					b.confirmationDueAt === null
				) {
					return false;
				}
				b.confirmationDueAt = new Date(state.now.getTime() + i.delayMs);
				return true;
			},

			blockUnrehomableProposal: async (i: {
				branchId: string;
				organizationId: string;
				snapshotId: string;
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				const p = state.proposals.get(i.snapshotId);
				if (!b || b.untracked || !p || p.pullRequestState === null) {
					return false;
				}
				const still = real.rehomableProposals({
					branch: b,
					ops: opsOn(b.id).filter((op) => op.snapshotId === p.id),
					proposals: queueOf(b.id).filter(
						(q) => q.snapshotId === p.id,
					),
					now: new Date(state.now),
				});
				if (!still.includes(p.id)) {
					return false;
				}
				return transitionPullRequest({
					snapshotId: p.id,
					organizationId: i.organizationId,
					event: "branch_stale_destination",
					from: [p.pullRequestState],
					expectedAttempt: p.pullRequestAttempt,
					to: "BLOCKED",
					bumpAttempt: true,
					branch: { id: b.id, assignment: p.proposalAssignment },
					data: {
						pullRequestFailure: {
							phase: "admission",
							code: "CONFIGURATION_CHANGED",
							retryable: false,
							at: state.now.toISOString(),
							params: {},
						},
						pullRequestNextAttemptAt: null,
					},
				}).ok;
			},

			/**
			 * The transfer's effect (spec §5), simplified: no destination
			 * re-read (a test forces `configuration_changed` or
			 * `not_joinable` through `transferAnswers`); the member's
			 * accepting branch, or a new one with the next number.
			 */
			transferProposal: async (i: {
				snapshotId: string;
				organizationId: string;
				expectedBranchId: string;
				newIntentOrder: boolean;
				naming: Database.ProposalBranchNaming;
			}): Promise<Database.JoinResult> => {
				const forced = state.transferAnswers.get(i.snapshotId);
				if (forced) {
					return { kind: forced };
				}
				const p = proposalOf(i.snapshotId, i.organizationId);
				const old = branchOf(i.expectedBranchId, i.organizationId);
				if (
					!p ||
					!old ||
					p.proposalBranchId !== i.expectedBranchId ||
					p.withdrawRequestedAt !== null ||
					p.pullRequestState === null
				) {
					return { kind: "not_joinable" };
				}
				const terminal = !NON_TERMINAL.includes(p.pullRequestState);
				const transferable = terminal
					? i.newIntentOrder
					: !i.newIntentOrder &&
						["QUEUED", "OPENING", "OPEN", "BLOCKED"].includes(
							p.pullRequestState,
						);
				const releases =
					TERMINAL_BRANCH.includes(old.state) ||
					old.retiredAt !== null ||
					(old.state === "CLOSE_REQUESTED" &&
						old.closeIntent === "START_OVER");
				if (!transferable || !releases) {
					return { kind: "not_joinable" };
				}
				let target = [...state.branches.values()].find(
					(b) =>
						b.id !== old.id &&
						b.projectId === old.projectId &&
						b.userId === old.userId &&
						b.organizationId === old.organizationId &&
						!b.untracked &&
						b.retiredAt === null &&
						ACCEPTING_BRANCH.includes(b.state),
				);
				if (!target) {
					const number =
						Math.max(
							...[...state.branches.values()]
								.filter((b) => b.userId === old.userId)
								.map((b) => b.number),
						) + 1;
					const ref = i.naming.memberBranchRef({
						displayName: state.userNames.get(old.userId) ?? null,
						userId: old.userId,
						n: number,
					});
					target = {
						...clone(old),
						id: `${old.id}_next_${number}`,
						number,
						ref,
						state: "PENDING",
						attempt: 1,
						presentation: null,
						startSha: null,
						headSha: null,
						foreignTipAt: null,
						nextSequence: 1,
						nextExecutionSeq: 1,
						headExecutionSeq: 0,
						factsRevision: 0,
						closeIntent: null,
						createIssuedAt: null,
						pullRequestUrl: null,
						pullRequestExternalId: null,
						pullRequestObservation: null,
						membership: null,
						failure: null,
						lastCheckedAt: null,
						nextAttemptAt: null,
						settledAt: null,
						confirmations: 0,
						confirmationDueAt: null,
						mergeSyncRequestedAt: null,
						mergeSyncDispatchedAt: null,
						mergeSyncRunId: null,
						mergeSyncExpected: null,
						retiredAt: null,
						retiredReason: null,
						retryRequestedAt: null,
						settlementPhase: null,
						deletedAt: null,
					};
					state.branches.set(target.id, target);
					state.reservations.push({
						repositoryKey: target.repositoryKey,
						ref,
						branchId: target.id,
						status: "current",
					});
				}
				const sequence = target.nextSequence;
				const assignment = p.proposalAssignment + 1;
				const moved = transitionPullRequest({
					snapshotId: p.id,
					organizationId: i.organizationId,
					event: "branch_transfer",
					from: [p.pullRequestState],
					expectedAttempt: p.pullRequestAttempt,
					to: "QUEUED",
					bumpAttempt: true,
					data: {
						proposalBranchId: target.id,
						proposalBranchSequence: sequence,
						proposalAssignment: assignment,
						pullRequestFailure: null,
						pullRequestNextAttemptAt: null,
						pendingCommand: null,
						pendingCommandSeq: null,
						...(i.newIntentOrder
							? { proposalIntentOrder: BigInt(1_000 + sequence) }
							: {}),
					},
				});
				if (!moved.ok) {
					throw new Error(
						"Proposal branch_transfer found no transition",
					);
				}
				target.nextSequence++;
				return {
					kind: "joined",
					branchId: target.id,
					sequence,
					assignment,
				};
			},

			// -- the branch's merge sync --------------------------------------

			getSyncRunReceiptByRunId: async (i: {
				projectId: string;
				organizationId: string;
				runId: string;
			}) =>
				clone(
					state.syncRuns.find(
						(r) =>
							r.runId === i.runId && r.projectId === i.projectId,
					) ?? null,
				),
			findMergeTriggeredRun: async (i: {
				projectId: string;
				organizationId: string;
				syncId: string;
				generation: number;
				startedAtOrAfter: Date;
			}) =>
				clone(
					state.syncRuns
						.filter(
							(r) =>
								r.projectId === i.projectId &&
								r.syncId === i.syncId &&
								r.generation === i.generation &&
								r.trigger === "PULL_REQUEST_MERGED" &&
								r.startedAt.getTime() >=
									i.startedAtOrAfter.getTime(),
						)
						.sort(
							(a, b) =>
								b.startedAt.getTime() - a.startedAt.getTime(),
						)[0] ?? null,
				),
			clearBranchMergeSyncRequest: async (
				i:
					| {
							kind: "acknowledged";
							branchId: string;
							organizationId: string;
							expected: Database.MergeSyncTuple;
							audit: Database.RecordAuditInput;
					  }
					| {
							kind: "gave_up";
							branchId: string;
							organizationId: string;
							expected: Database.MergeSyncTuple | null;
							failure: PullRequestFailure;
					  },
			) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.state !== "MERGED" ||
					b.mergeSyncRequestedAt === null ||
					!sameTuple(b.mergeSyncExpected, i.expected)
				) {
					return false;
				}
				b.mergeSyncRequestedAt = null;
				b.mergeSyncDispatchedAt = null;
				if (i.kind === "gave_up") {
					b.mergeSyncRunId = null;
					b.failure = clone(i.failure);
					b.nextAttemptAt = null;
				} else {
					state.audits.push({
						action: i.audit.action,
						metadata: i.audit.metadata as Record<string, unknown>,
					});
				}
				return true;
			},
			markBranchMergeSyncDispatched: async (i: {
				branchId: string;
				organizationId: string;
				lastExpected: Database.MergeSyncTuple | null;
				next: Database.MergeSyncTuple;
				dispatchedAt: Date;
				nextAttemptAt: Date;
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.state !== "MERGED" ||
					b.mergeSyncRequestedAt === null ||
					!sameTuple(b.mergeSyncExpected, i.lastExpected)
				) {
					return false;
				}
				b.mergeSyncDispatchedAt = i.dispatchedAt;
				b.mergeSyncExpected = clone(i.next);
				b.mergeSyncRunId = null;
				b.nextAttemptAt = i.nextAttemptAt;
				return true;
			},
			recordBranchMergeSyncRun: async (i: {
				branchId: string;
				organizationId: string;
				expected: Database.MergeSyncTuple;
				runId: string;
			}) => {
				const b = branchOf(i.branchId, i.organizationId);
				if (
					!b ||
					b.untracked ||
					b.state !== "MERGED" ||
					b.mergeSyncRequestedAt === null ||
					b.mergeSyncDispatchedAt === null ||
					!sameTuple(b.mergeSyncExpected, i.expected)
				) {
					return false;
				}
				b.mergeSyncRunId = i.runId;
				if (failureOf(b.failure).phase === "merge_sync") {
					b.failure = null;
				}
				return true;
			},
		};
	}

	// -- the module ------------------------------------------------------------

	const module = {
		// Real, pure.
		acceptsAppends: real.acceptsAppends,
		currentAppend: real.currentAppend,
		currentWithdrawal: real.currentWithdrawal,
		isEstablished: real.isEstablished,
		isTerminalBranchState: real.isTerminalBranchState,
		isReleasableBranch: real.isReleasableBranch,
		nextRetryDelayMs: real.nextRetryDelayMs,
		parseOperationEntries: real.parseOperationEntries,
		planNoOpFinalization: real.planNoOpFinalization,
		withdrawalRefusedLifecycle: real.withdrawalRefusedLifecycle,
		parseRepoUrl: real.parseRepoUrl,

		getProposalBranch: async (i: {
			branchId: string;
			organizationId: string;
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			return b ? { ...clone(b), databaseNow: new Date(state.now) } : null;
		},
		getBranchProposal: async (i: {
			snapshotId: string;
			organizationId: string;
		}) => {
			const p = proposalOf(i.snapshotId, i.organizationId);
			return p ? { ...clone(p), databaseNow: new Date(state.now) } : null;
		},
		listBranchOperations: async (i: {
			branchId: string;
			organizationId: string;
		}) =>
			state.ops
				.filter(
					(op) =>
						op.branchId === i.branchId &&
						op.organizationId === i.organizationId,
				)
				.sort((a, b) => a.executionSeq - b.executionSeq)
				.map(opRow),
		getBranchOperation: async (i: {
			operationId: string;
			organizationId: string;
		}) => {
			const op = state.ops.find(
				(o) =>
					o.id === i.operationId &&
					o.organizationId === i.organizationId,
			);
			return op ? opRow(op) : null;
		},
		listMemberBranchWrites: async (i: {
			projectId: string;
			userId: string;
			organizationId: string;
			repositoryKey: string;
		}) => {
			const ids = [...state.branches.values()]
				.filter(
					(b) =>
						b.projectId === i.projectId &&
						b.userId === i.userId &&
						b.organizationId === i.organizationId &&
						b.repositoryKey === i.repositoryKey &&
						!b.untracked &&
						!TERMINAL_BRANCH.includes(b.state),
				)
				.map((b) => b.id);
			return state.ops
				.filter(
					(op) =>
						ids.includes(op.branchId) &&
						(op.outcome === "acked" || op.outcome === "observed"),
				)
				.map((op) => ({
					branchId: op.branchId,
					kind: op.kind,
					executionSeq: op.executionSeq,
					snapshotId: op.snapshotId,
					assignment: op.assignment,
					rawPaths: op.entries.map((e) => e.rawPath),
					intentOrder:
						state.proposals.get(op.snapshotId)
							?.proposalIntentOrder ?? null,
				}));
		},
		getBranchPresentationInputs: async (i: {
			branchId: string;
			organizationId: string;
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			return b
				? {
						memberName: state.userNames.get(b.userId) ?? null,
						projectName: state.projectName,
					}
				: null;
		},

		claimBranchAppend: async (i: {
			branchId: string;
			organizationId: string;
			presentation?: { title: string; body: string };
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			if (!b || !real.acceptsAppends(b)) {
				return { kind: "none" as const };
			}
			const queue = [...state.proposals.values()]
				.filter(
					(p) =>
						p.proposalBranchId === b.id &&
						p.pullRequestState !== null &&
						NON_TERMINAL.includes(p.pullRequestState),
				)
				.map((p) => ({
					snapshotId: p.id,
					sequence: p.proposalBranchSequence,
					state: p.pullRequestState,
					status: p.status,
					proposalStatus: p.proposalStatus,
					withdrawRequestedAt: p.withdrawRequestedAt,
					failure: p.pullRequestFailure,
					nextAttemptAt: p.pullRequestNextAttemptAt,
				}));
			const head = real.pickRunnableHead(queue, state.now);
			if (head.kind !== "claim") {
				return { kind: "none" as const };
			}
			const p = state.proposals.get(head.snapshotId) as FakeProposal;
			const moved = transitionPullRequest({
				snapshotId: p.id,
				organizationId: i.organizationId,
				event: "branch_claim",
				from: [p.pullRequestState as string],
				expectedAttempt: p.pullRequestAttempt,
				to: "OPENING",
				bumpAttempt: true,
				branch: { id: b.id, assignment: p.proposalAssignment },
				data: {
					pullRequestFailure: null,
					pullRequestNextAttemptAt: null,
				},
			});
			if (!moved.ok) {
				return { kind: "none" as const };
			}
			b.attempt++;
			if (b.presentation === null && i.presentation) {
				b.presentation = clone(i.presentation);
			}
			return {
				kind: "claimed" as const,
				snapshotId: p.id,
				proposalAttempt: moved.attempt,
				branchAttempt: b.attempt,
			};
		},

		recordBranchOperation: async (i: {
			branchId: string;
			organizationId: string;
			snapshotId: string;
			proposalAttempt: number;
			kind: "APPEND" | "REVERT";
			ref: string;
			parentSha: string | null;
			sha: string;
			entries: EntryRecord[];
		}) => {
			await state.beforeIssue?.();
			const b = branchOf(i.branchId, i.organizationId);
			if (
				!b ||
				b.untracked ||
				TERMINAL_BRANCH.includes(b.state) ||
				b.ref !== i.ref ||
				(i.kind === "APPEND" && !real.acceptsAppends(b)) ||
				(i.kind === "APPEND"
					? (i.parentSha === null) !== (b.headSha === null)
					: i.parentSha === null)
			) {
				return { ok: false as const };
			}
			if (
				state.ops.some(
					(o) =>
						o.branchId === b.id &&
						o.organizationId === i.organizationId &&
						o.outcome === null,
				)
			) {
				// Another operation on the branch is still issued.
				return { ok: false as const, unresolved: true as const };
			}
			const p = proposalOf(i.snapshotId, i.organizationId);
			if (
				!p ||
				p.proposalBranchId !== b.id ||
				p.pullRequestAttempt !== i.proposalAttempt ||
				p.pullRequestState !==
					(i.kind === "APPEND" ? "OPENING" : "CLOSE_REQUESTED")
			) {
				return { ok: false as const };
			}
			const executionSeq = b.nextExecutionSeq++;
			const op: FakeOp = {
				id: `op_${state.nextOpId++}`,
				organizationId: i.organizationId,
				branchId: b.id,
				snapshotId: p.id,
				kind: i.kind,
				executionSeq,
				ref: i.ref,
				assignment: p.proposalAssignment,
				attempt: i.proposalAttempt,
				parentSha: i.parentSha,
				sha: i.sha,
				entries: clone(i.entries),
				pushIssuedAt: new Date(state.now),
				pushAckedAt: null,
				observedAt: null,
				outcome: null,
				membership: null,
			};
			state.ops.push(op);
			state.trace.push(`issue:${op.id}:${op.kind}:${op.ref}`);
			return { ok: true as const, operationId: op.id, executionSeq };
		},

		recordOperationOutcome: async (i: {
			operationId: string;
			organizationId: string;
			outcome: Exclude<OpOutcome, null>;
			foreignTip?: boolean;
			audit?: { actorUserId: string | null; recovered: boolean };
		}) => {
			const notApplied = {
				applied: false,
				reconcile: { changed: false, row: null },
			};
			const op = state.ops.find(
				(o) =>
					o.id === i.operationId &&
					o.organizationId === i.organizationId,
			);
			const b = op ? branchOf(op.branchId, i.organizationId) : null;
			if (!op || !b) {
				return notApplied;
			}
			const p = state.proposals.get(op.snapshotId);
			const baseCommitSha =
				op.kind === "APPEND" &&
				op.parentSha === null &&
				b.startSha === null
					? ((
							p?.pullRequestContext as {
								baseCommitSha?: string;
							} | null
						)?.baseCommitSha ?? null)
					: null;
			const plan = real.planOutcomeFact({
				op: { ...op },
				branch: b,
				outcome: i.outcome,
				foreignTip: i.foreignTip === true,
				baseCommitSha,
				now: state.now,
			});
			state.trace.push(
				`outcome:${op.id}:${i.outcome}:${plan.apply ? "apply" : "skip"}`,
			);
			if (plan.apply) {
				op.outcome = plan.op.outcome ?? op.outcome;
				op.pushAckedAt = plan.op.pushAckedAt ?? op.pushAckedAt;
				op.observedAt = plan.op.observedAt ?? op.observedAt;
			}
			const f = plan.branch;
			if (f.head && b.headExecutionSeq < f.head.executionSeq) {
				b.headSha = f.head.sha;
				b.headExecutionSeq = f.head.executionSeq;
			}
			if (f.startSha !== null && b.startSha === null) {
				b.startSha = f.startSha;
			}
			if (f.pendingToOpening && b.state === "PENDING") {
				b.state = "OPENING";
			}
			if (f.factsRevisionIncrement) {
				b.factsRevision++;
			}
			if (f.membershipToPending) {
				b.membership = {
					status: "pending",
					at: state.now.toISOString(),
					attempts: 0,
				};
			}
			if (f.foreignTip) {
				b.foreignTipAt = new Date(state.now);
			}
			if (plan.established) {
				state.audits.push({
					action: "project.instructions.pull_request_branch_updated",
					metadata: {
						branchId: b.id,
						operationId: op.id,
						snapshotId: op.snapshotId,
						kind: op.kind,
						executionSeq: op.executionSeq,
						sha: op.sha,
						recovered:
							i.audit?.recovered ?? i.outcome === "observed",
						actorUserId: i.audit?.actorUserId ?? null,
					},
				});
			}
			if (!plan.apply) {
				return notApplied;
			}
			if (
				!p ||
				p.proposalBranchId !== op.branchId ||
				p.proposalAssignment !== op.assignment
			) {
				return {
					applied: true,
					reconcile: { changed: false, row: null },
				};
			}
			const r = reconcile(op.snapshotId, i.organizationId);
			return {
				applied: true,
				reconcile: { changed: r.changed, row: r.row },
			};
		},

		refuseCurrentRef: async (i: {
			branchId: string;
			organizationId: string;
			naming: {
				memberBranchRef(i: {
					displayName: string | null | undefined;
					userId: string;
					n: number;
				}): string;
			};
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			if (
				!b ||
				b.headSha !== null ||
				b.untracked ||
				TERMINAL_BRANCH.includes(b.state)
			) {
				return { notProvisional: true as const };
			}
			for (const r of state.reservations) {
				if (
					r.branchId === b.id &&
					r.ref === b.ref &&
					r.status === "current"
				) {
					r.status = "refused";
				}
			}
			const refused = state.reservations.filter(
				(r) => r.branchId === b.id && r.status === "refused",
			).length;
			if (refused >= real.MAX_REFUSED_BRANCH_REFS) {
				return { exhausted: true as const };
			}
			const n0 = Number(b.ref.slice(b.ref.lastIndexOf("/") + 1));
			for (let n = n0 + 1; ; n++) {
				const ref = i.naming.memberBranchRef({
					displayName: state.userNames.get(b.userId) ?? null,
					userId: b.userId,
					n,
				});
				if (
					!state.reservations.some(
						(r) =>
							r.repositoryKey === b.repositoryKey &&
							r.ref === ref,
					)
				) {
					state.reservations.push({
						repositoryKey: b.repositoryKey,
						ref,
						branchId: b.id,
						status: "current",
					});
					b.ref = ref;
					state.trace.push(`ref:${b.id}:${ref}`);
					return { ref };
				}
			}
		},

		markForeignTip: async (i: {
			branchId: string;
			organizationId: string;
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			if (!b || b.foreignTipAt !== null) {
				return false;
			}
			b.foreignTipAt = new Date(state.now);
			return true;
		},

		releaseBranchClaim: async (i: {
			branchId: string;
			organizationId: string;
			snapshotId: string;
			proposalAttempt: number;
			retire?: "BRANCH_MISSING";
		}) => {
			const retired = i.retire
				? retire(i.branchId, i.organizationId, i.retire)
				: false;
			return { released: releaseClaim(i), retired };
		},

		finalizeBranchNoOp: async (i: {
			branchId: string;
			organizationId: string;
			snapshotId: string;
			proposalAttempt: number;
		}) => {
			const r = reconcile(i.snapshotId, i.organizationId);
			if (r.changed) {
				return { kind: "changed" as const };
			}
			const p = proposalOf(i.snapshotId, i.organizationId);
			if (
				!p ||
				p.proposalBranchId !== i.branchId ||
				p.pullRequestState !== "OPENING" ||
				p.pullRequestAttempt !== i.proposalAttempt
			) {
				return { kind: "moved" as const };
			}
			const plan = real.planNoOpFinalization({
				ops: state.ops
					.filter((op) => op.snapshotId === p.id)
					.map(evidence),
				branchId: i.branchId,
				assignment: p.proposalAssignment,
			});
			const failure = (code: string): PullRequestFailure => ({
				phase: "append",
				code: code as PullRequestFailure["code"],
				retryable: false,
				at: state.now.toISOString(),
				params: {},
			});
			if (plan === "unresolved") {
				const moved = transitionPullRequest({
					snapshotId: p.id,
					organizationId: i.organizationId,
					event: "push_unknown",
					from: ["OPENING"],
					expectedAttempt: i.proposalAttempt,
					to: "BLOCKED",
					bumpAttempt: false,
					data: {
						pullRequestFailure: failure("PUSH_OUTCOME_UNKNOWN"),
						pullRequestNextAttemptAt: null,
					},
				});
				return {
					kind: moved.ok ? ("blocked" as const) : ("moved" as const),
				};
			}
			const moved = transitionPullRequest({
				snapshotId: p.id,
				organizationId: i.organizationId,
				event: "branch_evidence",
				from: ["OPENING"],
				expectedAttempt: i.proposalAttempt,
				to: "CANCELED",
				bumpAttempt: true,
				branch: { id: i.branchId, assignment: p.proposalAssignment },
				data: {
					pullRequestFailure: failure("ALREADY_ON_BRANCH"),
					pullRequestNextAttemptAt: null,
					pendingCommand: null,
					pendingCommandSeq: null,
				},
				audit: {
					action: "project.instructions.pull_request_reconciled",
					category: "project",
					actor: { type: "system" },
					organizationId: i.organizationId,
					projectId: p.projectId,
					resource: {
						type: "project_instruction_snapshot",
						id: p.id,
						name: `v${p.version}`,
					},
					metadata: {
						outcome: "canceled",
						code: "ALREADY_ON_BRANCH",
					},
				},
			});
			return {
				kind: moved.ok ? ("canceled" as const) : ("moved" as const),
			};
		},

		refuseBranchWithdrawal: async (i: {
			branchId: string;
			organizationId: string;
			snapshotId: string;
			proposalAttempt: number;
			failure: PullRequestFailure;
			branchFailure?: PullRequestFailure;
		}) => {
			if (i.branchFailure) {
				const b = branchOf(i.branchId, i.organizationId);
				if (b && !b.untracked) {
					b.failure = clone(i.branchFailure);
				}
			}
			const p = proposalOf(i.snapshotId, i.organizationId);
			if (
				!p ||
				p.proposalBranchId !== i.branchId ||
				p.pullRequestState !== "CLOSE_REQUESTED" ||
				p.pullRequestAttempt !== i.proposalAttempt
			) {
				return { ok: false };
			}
			const next = real.withdrawalRefusedLifecycle(
				real.lifecycleOfRow({
					state: p.pullRequestState,
					failure: p.pullRequestFailure,
					withdrawRequestedAt: p.withdrawRequestedAt,
					withdrawScope: p.withdrawScope,
					pendingCommand: p.pendingCommand,
					pendingCommandSeq: p.pendingCommandSeq,
				}),
				i.failure,
			);
			const moved = transitionPullRequest({
				snapshotId: p.id,
				organizationId: i.organizationId,
				event: "branch_evidence",
				from: ["CLOSE_REQUESTED"],
				expectedAttempt: i.proposalAttempt,
				to: "OPEN",
				bumpAttempt: true,
				branch: { id: i.branchId, assignment: p.proposalAssignment },
				data: {
					...(real.lifecycleColumns(next) as Record<string, unknown>),
					pullRequestNextAttemptAt: null,
				},
			});
			return { ok: moved.ok };
		},

		recordBranchFailure: async (i: {
			branchId: string;
			organizationId: string;
			failure: PullRequestFailure;
			nextAttemptAt?: Date | null;
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			if (!b || b.untracked) {
				return false;
			}
			b.failure = clone(i.failure);
			if (i.nextAttemptAt !== undefined) {
				b.nextAttemptAt = i.nextAttemptAt;
			}
			return true;
		},

		recordBranchReceipt: async (i: {
			branchId: string;
			organizationId: string;
			expectedAttempt: number;
			from: BranchRow["state"][];
			observation: Database.BranchPullRequestObservation;
			adopted: boolean;
			endsSettlement?: boolean;
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			const o = i.observation;
			if (
				!b ||
				b.untracked ||
				(b.pullRequestExternalId !== null &&
					b.pullRequestExternalId !== o.externalId)
			) {
				return { kind: "stale" as const };
			}
			const receipt = {
				pullRequestUrl: o.url,
				pullRequestExternalId: o.externalId,
				pullRequestObservation: {
					targetRef: o.targetRef,
					headSha: o.headSha,
				},
				lastCheckedAt: new Date(state.now),
				createIssuedAt: null,
			};
			const terminal = o.state !== "OPEN";
			const opened = {
				action: "project.instructions.pull_request_opened",
				metadata: {
					branchId: b.id,
					externalId: o.externalId,
					adopted: i.adopted,
				},
			};
			if (
				i.from.includes(b.state) &&
				b.attempt === i.expectedAttempt &&
				real.isLegalBranchMove(b.state, o.state)
			) {
				const moved = transitionBranch({
					branchId: b.id,
					organizationId: i.organizationId,
					from: [b.state],
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
									membership: {
										status: "pending",
										at: state.now.toISOString(),
										attempts: 0,
									},
								}
							: {}),
					},
				});
				if (moved.ok) {
					state.audits.push(opened);
					if (terminal) {
						state.audits.push({
							action: "project.instructions.pull_request_reconciled",
							metadata: {
								branchId: b.id,
								externalId: o.externalId,
							},
						});
					}
					return { kind: "moved" as const };
				}
			}
			if (
				TERMINAL_BRANCH.includes(b.state) ||
				b.pullRequestExternalId !== null
			) {
				return { kind: "stale" as const };
			}
			Object.assign(b, clone(receipt));
			state.audits.push(opened);
			return { kind: "facts" as const };
		},

		recordBranchObservation: async (i: {
			branchId: string;
			organizationId: string;
			observation: Database.BranchPullRequestObservation;
			release?: { snapshotId: string; proposalAttempt: number };
			expectedAttempt?: number;
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			const o = i.observation;
			let observed = false;
			if (
				b &&
				(i.expectedAttempt === undefined ||
					b.attempt === i.expectedAttempt) &&
				b.state === "OPEN" &&
				o.state !== "OPEN" &&
				b.pullRequestExternalId === o.externalId
			) {
				const moved = transitionBranch({
					branchId: b.id,
					organizationId: i.organizationId,
					from: ["OPEN"],
					expectedAttempt: b.attempt,
					to: o.state,
					bumpAttempt: true,
					data: {
						pullRequestObservation: {
							targetRef: o.targetRef,
							headSha: o.headSha,
						},
						lastCheckedAt: new Date(state.now),
						membership: {
							status: "pending",
							at: state.now.toISOString(),
							attempts: 0,
						},
					},
				});
				if (moved.ok) {
					observed = true;
					state.audits.push({
						action: "project.instructions.pull_request_reconciled",
						metadata: { branchId: b.id, externalId: o.externalId },
					});
				}
			}
			const released = i.release
				? releaseClaim({
						branchId: i.branchId,
						organizationId: i.organizationId,
						snapshotId: i.release.snapshotId,
						proposalAttempt: i.release.proposalAttempt,
					})
				: false;
			return { observed, released };
		},

		releaseBlockedBranch: async (i: {
			branchId: string;
			organizationId: string;
			expectedAttempt: number;
			refDeleted: boolean;
		}) => {
			const b = branchOf(i.branchId, i.organizationId);
			if (
				!b ||
				b.untracked ||
				b.attempt !== i.expectedAttempt ||
				!real.isReleasableBranch(b)
			) {
				return { ok: false, canceled: 0 };
			}
			const code = failureOf(b.failure).code ?? "CONFIGURATION_CHANGED";
			const live = [...state.proposals.values()]
				.filter(
					(p) =>
						p.proposalBranchId === b.id &&
						p.pullRequestState !== null &&
						NON_TERMINAL.includes(p.pullRequestState),
				)
				.sort((x, y) => (x.id < y.id ? -1 : 1));
			for (const p of live) {
				const moved = transitionPullRequest({
					snapshotId: p.id,
					organizationId: i.organizationId,
					event: "branch_evidence",
					from: [p.pullRequestState as string],
					expectedAttempt: p.pullRequestAttempt,
					to: "CANCELED",
					bumpAttempt: true,
					branch: { id: b.id, assignment: p.proposalAssignment },
					data: {
						pullRequestFailure: {
							phase: "create",
							code,
							retryable: false,
							at: state.now.toISOString(),
							params: {},
						},
						pullRequestNextAttemptAt: null,
						pendingCommand: null,
						pendingCommandSeq: null,
					},
					audit: {
						action: "project.instructions.pull_request_reconciled",
						category: "project",
						actor: { type: "system" },
						organizationId: i.organizationId,
						projectId: p.projectId,
						resource: {
							type: "project_instruction_snapshot",
							id: p.id,
							name: `v${p.version}`,
						},
						metadata: { outcome: "canceled", code },
					},
				});
				if (!moved.ok) {
					throw new Error(
						"A locked proposal refused its branch's release",
					);
				}
			}
			const moved = transitionBranch({
				branchId: b.id,
				organizationId: i.organizationId,
				from: ["BLOCKED"],
				expectedAttempt: i.expectedAttempt,
				to: "CANCELED",
				bumpAttempt: true,
				data: {
					settledAt: new Date(state.now),
					confirmations: 0,
					confirmationDueAt: new Date(
						state.now.getTime() + 3_600_000,
					),
					nextAttemptAt: null,
					...(i.refDeleted ? { deletedAt: new Date(state.now) } : {}),
				},
			});
			if (!moved.ok) {
				throw new Error("A locked proposal branch refused its release");
			}
			return { ok: true, canceled: live.length };
		},

		...settlementModule(),

		transitionBranch: async (i: Parameters<typeof transitionBranch>[0]) =>
			transitionBranch(i),
		transitionPullRequest: async (
			i: Parameters<typeof transitionPullRequest>[0],
		) => transitionPullRequest(i),

		getInstructionRepositorySyncForProposal: async () => clone(state.sync),
		getProjectInstructionSettings: async () => clone(state.settings),
		canCreateProjectInstructions: async () => state.canCreate,
		canReadProjectInstructions: async () => state.canRead,
		listInstructionFiles: async (snapshotId: string) =>
			clone(state.files.get(snapshotId) ?? []),
		getProjectRepoIntegration: async () => null,
	};

	/** Back to an empty database, for the next test. */
	function reset(): void {
		state.now = new Date("2026-09-26T12:00:00.000Z");
		state.branches.clear();
		state.proposals.clear();
		state.ops.length = 0;
		state.reservations.length = 0;
		state.files.clear();
		state.audits.length = 0;
		state.trace.length = 0;
		state.userNames.clear();
		state.projectName = "Example Project";
		state.sync = null;
		state.settings = { sourceOfTruth: "REPOSITORY" };
		state.canCreate = true;
		state.canRead = true;
		state.nextOpId = 1;
		state.transferAnswers.clear();
		state.syncRuns.length = 0;
		state.beforeIssue = null;
	}

	return { state, module, reconcile, reset };
}

export type FakeDatabase = ReturnType<typeof createFakeDatabase>;
