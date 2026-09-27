/**
 * Proposal pull requests: the state mapping, the attempt-record summary and
 * one test per spec §4.4 transition row still written (Fizzy #2563). The
 * rows only #2563's per-proposal path wrote, and its record writer, claim,
 * selection and merge-sync writers, were retired with that path (Fizzy
 * #2748).
 *
 * The transition cases run against an in-memory snapshot row whose
 * `updateMany` evaluates the Prisma `where` the module builds (the subset it
 * uses: equality, `in`, `not`, `AND`/`OR`, and JSON `path`/`equals` with
 * SQL-NULL semantics for a missing path), so "refused from every other
 * state" is the row not matching, exactly as zero rows from Postgres. The
 * real-Postgres file beside this one pins the concurrency and the JSON path
 * filters against the database itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string; organizationId: string };

const store = vi.hoisted(() => ({
	rows: new Map<string, Record<string, unknown>>(),
	queries: [] as string[],
	txClients: [] as unknown[],
	runFindFirst: vi.fn(),
	runFindMany: vi.fn(),
	/** Snapshot ids with a member-branch journal operation (Fizzy #2738). */
	journaled: new Set<string>(),
	/**
	 * Snapshot ids whose current withdrawal is an established revert on
	 * their current branch (Fizzy #2738 Decision 14).
	 */
	revertEstablished: new Set<string>(),
}));

const auditMocks = vi.hoisted(() => ({ recordAuditTx: vi.fn() }));

vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: auditMocks.recordAuditTx,
}));

vi.mock("../prisma/client", async () => {
	const JSON_NULL = Symbol.for("test.DbNull");
	const ANY_NULL = Symbol.for("test.AnyNull");
	// The real tagged-template builders, so composed SQL reaches the fake
	// exactly as Postgres would get it.
	const { empty, join, raw, sqltag } = await vi.importActual<
		typeof import("@prisma/client/runtime/client")
	>("@prisma/client/runtime/client");

	function getPath(value: unknown, path: readonly string[]): unknown {
		let current = value;
		for (const key of path) {
			if (current === null || typeof current !== "object") {
				return undefined;
			}
			current = (current as Record<string, unknown>)[key];
		}
		return current;
	}

	function fieldMatches(value: unknown, filter: unknown): boolean {
		if (filter === null) {
			return value === null || value === undefined;
		}
		if (filter instanceof Date) {
			return (
				value instanceof Date && value.getTime() === filter.getTime()
			);
		}
		if (typeof filter !== "object") {
			return value === filter;
		}
		const f = filter as Record<string, unknown>;
		if ("path" in f) {
			const at = getPath(value, f.path as string[]);
			// SQL: a missing path is NULL, and NULL = x is not true.
			if (at === undefined || at === null) {
				return false;
			}
			return JSON.stringify(at) === JSON.stringify(f.equals);
		}
		if ("in" in f) {
			return (f.in as unknown[]).includes(value);
		}
		if ("not" in f) {
			if (f.not === null) {
				return value !== null && value !== undefined;
			}
			return value !== null && value !== undefined && value !== f.not;
		}
		if ("equals" in f) {
			if (f.equals === ANY_NULL) {
				return value === null || value === undefined;
			}
			return JSON.stringify(value) === JSON.stringify(f.equals);
		}
		throw new Error(`fake where: unsupported filter ${JSON.stringify(f)}`);
	}

	function matches(row: Record<string, unknown>, where: unknown): boolean {
		for (const [key, filter] of Object.entries(
			(where ?? {}) as Record<string, unknown>,
		)) {
			if (key === "AND") {
				if (!(filter as unknown[]).every((w) => matches(row, w))) {
					return false;
				}
			} else if (key === "OR") {
				if (!(filter as unknown[]).some((w) => matches(row, w))) {
					return false;
				}
			} else if (key === "NOT") {
				throw new Error("fake where: NOT is not used by the module");
			} else if (!fieldMatches(row[key], filter)) {
				return false;
			}
		}
		return true;
	}

	function apply(
		row: Record<string, unknown>,
		data: Record<string, unknown>,
	) {
		for (const [key, value] of Object.entries(data)) {
			if (
				value !== null &&
				typeof value === "object" &&
				!(value instanceof Date) &&
				!Array.isArray(value) &&
				"increment" in value
			) {
				row[key] =
					(row[key] as number) +
					(value as { increment: number }).increment;
			} else if (value === JSON_NULL) {
				row[key] = null;
			} else {
				row[key] = structuredClone(value);
			}
		}
	}

	const snapshot = {
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: unknown;
				data: Record<string, unknown>;
			}) => {
				let count = 0;
				for (const row of store.rows.values()) {
					if (matches(row, where)) {
						apply(row, data);
						count += 1;
					}
				}
				return { count };
			},
		),
		findFirst: vi.fn(
			async ({
				where,
				select,
			}: {
				where: unknown;
				select?: Record<string, boolean>;
			}) => {
				for (const row of store.rows.values()) {
					if (matches(row, where)) {
						const copy = structuredClone(row);
						return select
							? Object.fromEntries(
									Object.keys(select).map((k) => [
										k,
										copy[k],
									]),
								)
							: copy;
					}
				}
				return null;
			},
		),
	};

	async function queryRaw(
		strings:
			| TemplateStringsArray
			| { strings: string[]; values: unknown[] },
		...values: unknown[]
	) {
		// `$queryRaw(sql)` with a composed statement, or a tagged template.
		if (!Array.isArray(strings)) {
			const composed = strings as {
				strings: string[];
				values: unknown[];
			};
			return queryRaw(
				composed.strings as unknown as TemplateStringsArray,
				...composed.values,
			);
		}
		const flat = sqltag(strings as TemplateStringsArray, ...values);
		const sql = strings.join("?");
		store.queries.push(sql);
		if (sql.includes('AS "revertEstablished"')) {
			// The revert check composes its EXISTS fragment first, so its
			// bound values are the flattened statement's.
			const [rid, rorg] = flat.values as [string, string];
			const found = store.rows.get(rid);
			return found && found.organizationId === rorg
				? [
						{
							state: found.pullRequestState,
							revertEstablished: store.revertEstablished.has(rid),
						},
					]
				: [];
		}
		const [id, organizationId] = values as [string, string];
		if (sql.includes('"project_instruction_proposal_branch_operation"')) {
			return [{ journaled: store.journaled.has(id) }];
		}
		const row = store.rows.get(id);
		if (!row || row.organizationId !== organizationId) {
			return [];
		}
		return [{ id }];
	}

	const client = {
		projectInstructionSnapshot: snapshot,
		projectInstructionRepositorySyncRun: {
			findFirst: (...a: unknown[]) => store.runFindFirst(...a),
			findMany: (...a: unknown[]) => store.runFindMany(...a),
		},
		$queryRaw: queryRaw,
	};

	return {
		Prisma: {
			DbNull: JSON_NULL,
			JsonNull: JSON_NULL,
			AnyNull: ANY_NULL,
			TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" },
			empty,
			join,
			raw,
			sql: sqltag,
		},
		db: {
			...client,
			// Interactive transaction with rollback: a throw restores the rows.
			$transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
				const saved = new Map(
					[...store.rows].map(([k, v]) => [k, structuredClone(v)]),
				);
				const tx = { ...client };
				store.txClients.push(tx);
				try {
					return await cb(tx);
				} catch (error) {
					store.rows = saved;
					throw error;
				}
			},
		},
	};
});

import type { Prisma } from "../prisma/client";
import {
	BRANCH_PULL_REQUEST_EVENTS,
	findMergeTriggeredRun,
	getSyncRunReceiptByRunId,
	getSyncRunReceiptsByRunIds,
	hasOutstandingObligation,
	INSTRUCTION_PULL_REQUEST_FAILURE_CODES,
	nextRetryDelayMs,
	PRE_CREATE_CANCEL_EVENTS,
	PULL_REQUEST_TRANSITIONS,
	type PullRequestAttemptRecord,
	type PullRequestEvent,
	proposalStatusForPullRequestState,
	pullRequestTransitionWhere,
	requiredPullRequestAudits,
	summarizeAttempts,
	transitionPullRequest,
} from "../prisma/queries/instruction-proposal-pull-requests";

const STATES = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"MERGED",
	"CLOSED",
	"BLOCKED",
	"CANCELED",
] as const;
type State = (typeof STATES)[number];

const ORG = "org_1";
const ID = "snap_1";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function failure(
	code: string,
	phase: string,
	retryable: boolean,
): Record<string, unknown> {
	return {
		code,
		phase,
		retryable,
		at: "2026-09-24T11:00:00.000Z",
		params: {},
	};
}

function seed(state: State | null, overrides: Partial<Row> = {}): Row {
	const row: Row = {
		id: ID,
		organizationId: ORG,
		pullRequestState: state,
		proposalStatus: state
			? proposalStatusForPullRequestState(state)
			: "PENDING",
		pullRequestAttempt: 3,
		pullRequestHeadSha: null,
		pullRequestObligationOpen: false,
		pullRequestConfirmationDueAt: null,
		pullRequestFailure: null,
		pullRequestNextAttemptAt: null,
		pullRequestAttempts: [],
		pullRequestRef: null,
		...overrides,
	};
	store.rows.set(ID, structuredClone(row));
	return row;
}

function current(): Row {
	return structuredClone(store.rows.get(ID)) as Row;
}

function audit(action: string) {
	return {
		action,
		actor: { type: "system" as const },
		organizationId: ORG,
		resource: { type: "project_instruction_snapshot", id: ID },
		metadata: { operationId: "op_1" },
	};
}

beforeEach(() => {
	store.rows = new Map();
	store.queries = [];
	store.txClients = [];
	store.runFindFirst.mockReset();
	store.runFindMany.mockReset();
	store.journaled = new Set();
	store.revertEstablished = new Set();
	auditMocks.recordAuditTx.mockReset();
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe("proposalStatusForPullRequestState (spec §4.2)", () => {
	it.each([
		["QUEUED", "PENDING"],
		["OPENING", "PENDING"],
		["OPEN", "PENDING"],
		["CLOSE_REQUESTED", "PENDING"],
		["BLOCKED", "PENDING"],
		["MERGED", "MERGED"],
		["CLOSED", "CLOSED"],
		["CANCELED", "REJECTED"],
	] as const)("maps %s to %s", (state, status) => {
		expect(proposalStatusForPullRequestState(state)).toBe(status);
	});
});

describe("hasOutstandingObligation (spec §4.1)", () => {
	const base: PullRequestAttemptRecord = {
		attempt: 1,
		ref: "fabric/instructions/op",
		sha: "a".repeat(40),
		pushIssuedAt: "2026-09-24T10:00:00.000Z",
		pushAckedAt: "2026-09-24T10:00:01.000Z",
		confirmations: 0,
	};

	it.each([
		[
			"an issued create",
			{ createIssuedAt: "2026-09-24T10:00:02.000Z" },
			true,
		],
		[
			"a settlement with no confirmation",
			{ settledAt: "2026-09-24T11:00:00.000Z", confirmations: 0 },
			true,
		],
		[
			"a settlement with one confirmation",
			{ settledAt: "2026-09-24T11:00:00.000Z", confirmations: 1 },
			true,
		],
		[
			"a settlement with both confirmations",
			{ settledAt: "2026-09-24T11:00:00.000Z", confirmations: 2 },
			false,
		],
		[
			"a push issued with no acknowledgment or outcome",
			{ pushAckedAt: undefined },
			true,
		],
		[
			"a push issued with no acknowledgment but an outcome",
			{ pushAckedAt: undefined, outcome: "push_unknown_absent" },
			false,
		],
		["an acknowledged push", {}, false],
		[
			"a record appended before its push",
			{ pushIssuedAt: undefined, pushAckedAt: undefined },
			false,
		],
	] as const)("is %s -> %s", (_, change, expected) => {
		expect(
			hasOutstandingObligation({
				...base,
				...change,
			} as PullRequestAttemptRecord),
		).toBe(expected);
	});
});

describe("summarizeAttempts (plan Decision 1)", () => {
	const record = (
		settledAt: string | undefined,
		confirmations: number,
		extra: Partial<PullRequestAttemptRecord> = {},
	): PullRequestAttemptRecord => ({
		attempt: 1,
		ref: "fabric/instructions/op",
		sha: "a".repeat(40),
		pushIssuedAt: "2026-09-24T09:00:00.000Z",
		pushAckedAt: "2026-09-24T09:00:01.000Z",
		settledAt,
		confirmations,
		...extra,
	});

	it("is due 1 h after settlement with no confirmation", () => {
		expect(
			summarizeAttempts([record("2026-09-24T10:00:00.000Z", 0)]),
		).toEqual({
			obligationOpen: true,
			confirmationDueAt: new Date("2026-09-24T11:00:00.000Z"),
		});
	});

	it("is due 24 h after settlement with one confirmation", () => {
		expect(
			summarizeAttempts([record("2026-09-24T10:00:00.000Z", 1)])
				.confirmationDueAt,
		).toEqual(new Date("2026-09-25T10:00:00.000Z"));
	});

	it("takes the earliest due time across records", () => {
		expect(
			summarizeAttempts([
				record("2026-09-24T10:00:00.000Z", 1),
				record("2026-09-24T20:00:00.000Z", 0, {
					attempt: 2,
					ref: "fabric/instructions/op-2",
				}),
			]).confirmationDueAt,
		).toEqual(new Date("2026-09-24T21:00:00.000Z"));
	});

	it("has nothing due, and no obligation, after both confirmations", () => {
		expect(
			summarizeAttempts([record("2026-09-24T10:00:00.000Z", 2)]),
		).toEqual({
			obligationOpen: false,
			confirmationDueAt: null,
		});
	});

	it("reports an open obligation for an unsettled create marker", () => {
		expect(
			summarizeAttempts([
				record(undefined, 0, {
					createIssuedAt: "2026-09-24T09:00:02.000Z",
				}),
			]),
		).toEqual({ obligationOpen: true, confirmationDueAt: null });
	});

	it("is empty for no records", () => {
		expect(summarizeAttempts([])).toEqual({
			obligationOpen: false,
			confirmationDueAt: null,
		});
	});
});

describe("nextRetryDelayMs (spec §11, Global Constraints)", () => {
	it("honours retryAfterSeconds for a rate limit, else waits 15 min", () => {
		expect(
			nextRetryDelayMs("PROVIDER_RATE_LIMITED", {
				retryAfterSeconds: 90,
			}),
		).toBe(90_000);
		expect(nextRetryDelayMs("PROVIDER_RATE_LIMITED", {})).toBe(15 * MIN);
		expect(
			nextRetryDelayMs("PROVIDER_RATE_LIMITED", { retryAfterSeconds: 0 }),
		).toBe(15 * MIN);
	});

	it.each([
		"PROVIDER_TEMPORARY",
		"UNEXPECTED",
		"LOOKUP_INCONCLUSIVE",
		"GIT_FAILED",
		"STORAGE_FAILED",
	] as const)("waits 15 min after %s", (code) => {
		expect(nextRetryDelayMs(code, {})).toBe(15 * MIN);
	});

	it.each([
		"AUTHENTICATION_FAILED",
		"CLOSE_CREDENTIALS_UNAVAILABLE",
		"BRANCH_WRITE_REFUSED",
		"CLOSE_REFUSED",
		"REMOTE_REF_CONFLICT",
	] as const)(
		"waits 6 h after %s (authentication, credentials, refusals)",
		(code) => {
			expect(nextRetryDelayMs(code, {})).toBe(6 * HOUR);
		},
	);

	it("waits 1 h after VALIDATION_TIMEOUT", () => {
		expect(nextRetryDelayMs("VALIDATION_TIMEOUT", {})).toBe(HOUR);
	});

	it("walks 1, 5, 15, 60 min then hourly for CREATE_OUTCOME_UNKNOWN", () => {
		const delays = [0, 1, 2, 3, 4, 9].map((recoveries) =>
			nextRetryDelayMs("CREATE_OUTCOME_UNKNOWN", {
				recoveries,
				markerAgeMs: 2 * HOUR,
			}),
		);
		expect(delays).toEqual([
			1 * MIN,
			5 * MIN,
			15 * MIN,
			60 * MIN,
			60 * MIN,
			60 * MIN,
		]);
	});

	it("stops retrying CREATE_OUTCOME_UNKNOWN 24 h after the marker", () => {
		expect(
			nextRetryDelayMs("CREATE_OUTCOME_UNKNOWN", {
				markerAgeMs: 24 * HOUR - 1,
			}),
		).toBe(1 * MIN);
		expect(
			nextRetryDelayMs("CREATE_OUTCOME_UNKNOWN", {
				markerAgeMs: 24 * HOUR,
			}),
		).toBeNull();
	});

	it("backs a merge-sync start off 5, 15, then 60 min", () => {
		expect(
			[0, 1, 2, 5].map((recoveries) =>
				nextRetryDelayMs("SYNC_START_FAILED", { recoveries }),
			),
		).toEqual([5 * MIN, 15 * MIN, 60 * MIN, 60 * MIN]);
	});

	it.each([
		"VALIDATION_REJECTED",
		"ATTRIBUTION_REJECTED",
		"PERMISSION_REVOKED",
		"CONFIGURATION_CHANGED",
		"TARGET_BRANCH_MISSING",
		"BASE_COMMIT_UNAVAILABLE",
		"TREE_CONFLICT",
		"PR_CREATION_REFUSED",
		"MERGE_SYNC_FAILED",
	] as const)("never retries %s automatically", (code) => {
		expect(nextRetryDelayMs(code, {})).toBeNull();
	});

	it("retries BRANCH_MOVED after 15 min (member branches, spec §9)", () => {
		expect(nextRetryDelayMs("BRANCH_MOVED", {})).toBe(15 * MIN);
	});

	it.each([
		"BRANCH_CONFLICT",
		"SUPERSEDED_BY_LATER_CHANGE",
		"BRANCH_NAME_UNAVAILABLE",
		"WITHDRAW_CONFLICT",
		"WITHDRAW_BLOCKED_BY_LATER_CHANGE",
		"REPOSITORY_CHANGED",
		"ALREADY_ON_BRANCH",
		"PUSH_OUTCOME_UNKNOWN",
		"WITHDRAW_OUTCOME_UNKNOWN",
		"START_OVER_REFUSED",
		"BRANCH_MISSING",
	] as const)(
		"never retries the member-branch code %s automatically",
		(code) => {
			expect(nextRetryDelayMs(code, {})).toBeNull();
		},
	);

	it("answers every failure code", () => {
		for (const code of INSTRUCTION_PULL_REQUEST_FAILURE_CODES) {
			expect(() => nextRetryDelayMs(code, {})).not.toThrow();
		}
	});
});

// ---------------------------------------------------------------------------
// Transitions: one case per spec §4.4 row
// ---------------------------------------------------------------------------

type Seed = { state: State; with?: Partial<Row> };
type RowCase = {
	row: string;
	event: PullRequestEvent;
	to: State | "unchanged";
	/** Every seed the row admits; their states form the `from` list. */
	allowed: readonly Seed[];
	/** Seeds in an allowed state that a guard must still refuse. */
	guarded?: readonly Seed[];
	audit: readonly string[];
};

const RECONCILED = "project.instructions.pull_request_reconciled";
const CLOSE_REQ = "project.instructions.pull_request_close_requested";

const V_FAILED = failure("VALIDATION_FAILED", "validation", true);
const V_TIMEOUT = failure("VALIDATION_TIMEOUT", "validation", true);
const ADMISSION = failure("ATTRIBUTION_REJECTED", "admission", false);
const PREPARE = failure("GIT_FAILED", "prepare", true);
/** A retryable failure in a phase the branch claim does not retry. */
const CREATE_UNKNOWN_RETRYABLE = failure(
	"CREATE_OUTCOME_UNKNOWN",
	"create",
	true,
);
const HEAD = { pullRequestHeadSha: "b".repeat(40) };

const PRE_CREATE: readonly Seed[] = [
	{ state: "QUEUED" },
	{ state: "OPENING" },
	{ state: "BLOCKED", with: { pullRequestFailure: V_TIMEOUT } },
	{ state: "BLOCKED", with: { pullRequestFailure: ADMISSION } },
];
const PRE_CREATE_GUARDED: readonly Seed[] = [
	{ state: "OPENING", with: HEAD },
	{ state: "BLOCKED", with: { pullRequestFailure: PREPARE } },
];

// Member proposal branches (Fizzy #2738 spec §4.3): v2 rows only. A #2563
// (v1) row in an allowed state is refused by the guard.
const V2 = { pullRequestContext: { v: 2 } };
const V1 = { pullRequestContext: { v: 1 } };
const ON_BRANCH_ROW = { ...V2, proposalBranchId: "branch_1" };
const APPEND_RETRYABLE = failure("BRANCH_CONFLICT", "append", true);
const WITHDRAWN = { withdrawRequestedAt: new Date("2026-09-24T10:00:00.000Z") };
const NON_TERMINAL = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"BLOCKED",
] as const;

const BRANCH_ROWS: readonly RowCase[] = [
	{
		row: "Join writes the branch, its sequence and a new assignment",
		event: "branch_join",
		to: "unchanged",
		allowed: [{ state: "QUEUED", with: { ...V2, proposalBranchId: null } }],
		guarded: [
			{ state: "QUEUED", with: ON_BRANCH_ROW },
			{ state: "QUEUED", with: V1 },
			{ state: "QUEUED" },
		],
		audit: [],
	},
	{
		row: "A stale destination blocks a branch proposal where it stands",
		event: "branch_stale_destination",
		to: "BLOCKED",
		allowed: [
			{ state: "QUEUED", with: V2 },
			{ state: "OPENING", with: ON_BRANCH_ROW },
			{ state: "OPEN", with: ON_BRANCH_ROW },
			{ state: "BLOCKED", with: ON_BRANCH_ROW },
		],
		guarded: [{ state: "QUEUED", with: V1 }, { state: "OPEN" }],
		audit: [],
	},
	{
		row: "Transfer (rehome, start over, Propose again) queues on the new branch",
		event: "branch_transfer",
		to: "QUEUED",
		allowed: (
			[
				"QUEUED",
				"OPENING",
				"OPEN",
				"BLOCKED",
				"MERGED",
				"CLOSED",
				"CANCELED",
			] as const
		).map((state) => ({ state, with: ON_BRANCH_ROW })),
		guarded: [
			{ state: "CANCELED", with: { ...ON_BRANCH_ROW, ...WITHDRAWN } },
			{ state: "QUEUED", with: { ...V2, proposalBranchId: null } },
			{ state: "MERGED", with: { ...V1, proposalBranchId: "branch_1" } },
		],
		audit: [],
	},
	{
		row: "Claim takes the queue head to OPENING",
		event: "branch_claim",
		to: "OPENING",
		allowed: [
			{ state: "QUEUED", with: ON_BRANCH_ROW },
			{ state: "OPENING", with: ON_BRANCH_ROW },
			{
				state: "BLOCKED",
				with: {
					...ON_BRANCH_ROW,
					pullRequestFailure: APPEND_RETRYABLE,
				},
			},
			{
				state: "BLOCKED",
				with: { ...ON_BRANCH_ROW, pullRequestFailure: V_TIMEOUT },
			},
		],
		guarded: [
			{ state: "QUEUED", with: { ...ON_BRANCH_ROW, ...WITHDRAWN } },
			{
				state: "BLOCKED",
				with: {
					...ON_BRANCH_ROW,
					pullRequestFailure: failure(
						"PUSH_OUTCOME_UNKNOWN",
						"append",
						false,
					),
				},
			},
			{
				state: "BLOCKED",
				with: {
					...ON_BRANCH_ROW,
					pullRequestFailure: CREATE_UNKNOWN_RETRYABLE,
				},
			},
			{ state: "QUEUED", with: { ...V2, proposalBranchId: null } },
			{ state: "OPENING", with: V1 },
		],
		audit: [],
	},
	{
		row: "Evidence cancels a withdrawn branch proposal",
		event: "branch_evidence",
		to: "CANCELED",
		allowed: NON_TERMINAL.map((state) => ({ state, with: ON_BRANCH_ROW })),
		guarded: [{ state: "OPEN", with: V1 }, { state: "OPEN" }],
		audit: [RECONCILED],
	},
	{
		row: "Evidence returns CLOSE_REQUESTED to OPEN (spec §4.3 amends #2563 §4.4)",
		event: "branch_evidence",
		to: "OPEN",
		allowed: NON_TERMINAL.map((state) => ({ state, with: ON_BRANCH_ROW })),
		guarded: [{ state: "CLOSE_REQUESTED", with: V1 }],
		audit: [],
	},
	{
		row: "Evidence of an unknown append blocks",
		event: "branch_evidence",
		to: "BLOCKED",
		allowed: NON_TERMINAL.map((state) => ({ state, with: ON_BRANCH_ROW })),
		guarded: [{ state: "OPENING", with: V1 }],
		audit: [],
	},
	{
		row: "Evidence of a pending withdrawal requests the close",
		event: "branch_evidence",
		to: "CLOSE_REQUESTED",
		allowed: NON_TERMINAL.map((state) => ({ state, with: ON_BRANCH_ROW })),
		guarded: [{ state: "OPEN", with: V1 }],
		audit: [],
	},
	{
		row: "Evidence that changes failure or intent only keeps the state",
		event: "branch_evidence",
		to: "unchanged",
		allowed: NON_TERMINAL.map((state) => ({ state, with: ON_BRANCH_ROW })),
		guarded: [{ state: "OPEN", with: V1 }],
		audit: [],
	},
	{
		row: "Stop tracking cancels every live proposal on the branch",
		event: "branch_stop_tracking",
		to: "CANCELED",
		allowed: NON_TERMINAL.map((state) => ({ state, with: ON_BRANCH_ROW })),
		guarded: [
			{ state: "OPEN", with: V1 },
			{ state: "OPEN", with: { ...V2, proposalBranchId: null } },
		],
		audit: [RECONCILED],
	},
	{
		row: "Withdrawal cancels a branch proposal not yet appended (spec §4.3)",
		event: "branch_withdraw",
		to: "CANCELED",
		allowed: [
			{ state: "QUEUED", with: { ...V2, proposalBranchId: null } },
			{ state: "QUEUED", with: ON_BRANCH_ROW },
			{
				state: "BLOCKED",
				with: {
					...ON_BRANCH_ROW,
					pullRequestFailure: APPEND_RETRYABLE,
				},
			},
			{
				state: "BLOCKED",
				with: {
					...V2,
					proposalBranchId: null,
					pullRequestFailure: failure(
						"CONFIGURATION_CHANGED",
						"admission",
						false,
					),
				},
			},
		],
		guarded: [
			{ state: "QUEUED", with: V1 },
			{ state: "QUEUED" },
			{
				state: "BLOCKED",
				with: { ...V1, pullRequestFailure: V_TIMEOUT },
			},
		],
		audit: [CLOSE_REQ],
	},
	{
		row: "Withdrawal of an appended change requests its revert (spec §6.8)",
		event: "branch_withdraw",
		to: "CLOSE_REQUESTED",
		allowed: [{ state: "OPEN", with: ON_BRANCH_ROW }],
		guarded: [
			{ state: "OPEN", with: V1 },
			{ state: "OPEN", with: { ...V2, proposalBranchId: null } },
			{ state: "OPEN", with: { ...ON_BRANCH_ROW, ...WITHDRAWN } },
		],
		audit: [CLOSE_REQ],
	},
	{
		row: "Withdrawal of the last live change keeps OPEN; the branch closes",
		event: "branch_withdraw",
		to: "unchanged",
		allowed: [{ state: "OPEN", with: ON_BRANCH_ROW }],
		guarded: [
			{ state: "OPEN", with: V1 },
			{ state: "OPEN", with: { ...ON_BRANCH_ROW, ...WITHDRAWN } },
		],
		audit: [CLOSE_REQ],
	},
];

const ROWS: readonly RowCase[] = [
	{
		row: "Validation READY clears a VALIDATION_FAILED failure",
		event: "validation_ready",
		to: "unchanged",
		allowed: [{ state: "QUEUED", with: { pullRequestFailure: V_FAILED } }],
		guarded: [
			{
				state: "QUEUED",
				with: {
					pullRequestFailure: failure(
						"LOOKUP_INCONCLUSIVE",
						"recover",
						true,
					),
				},
			},
		],
		audit: [],
	},
	{
		row: "Validation FAILED keeps the operation queued",
		event: "validation_failed",
		to: "unchanged",
		allowed: [{ state: "QUEUED" }],
		audit: [],
	},
	{
		row: "Validation REJECTED cancels every pre-create state",
		event: "validation_rejected",
		to: "CANCELED",
		allowed: PRE_CREATE,
		guarded: PRE_CREATE_GUARDED,
		audit: [RECONCILED],
	},
	{
		row: "Abandonment cancels every pre-create state",
		event: "abandoned",
		to: "CANCELED",
		allowed: PRE_CREATE,
		guarded: PRE_CREATE_GUARDED,
		audit: [RECONCILED],
	},
	{
		row: "Deadline reached blocks a queued operation",
		event: "deadline",
		to: "BLOCKED",
		allowed: [{ state: "QUEUED" }],
		audit: [],
	},
	{
		row: "Failure in the open activity blocks",
		event: "open_failure",
		to: "BLOCKED",
		allowed: [{ state: "OPENING" }],
		audit: [],
	},
	{
		row: "Failure in any other activity is failure-only",
		event: "failure",
		to: "unchanged",
		allowed: STATES.map((state) => ({ state })),
		audit: [],
	},
	{
		row: "Push outcome unknown with the ref absent continues",
		event: "push_unknown",
		to: "unchanged",
		allowed: [{ state: "OPENING" }, { state: "CLOSE_REQUESTED" }],
		audit: [],
	},
	{
		row: "Push outcome unknown with the ref present blocks the open",
		event: "push_unknown",
		to: "BLOCKED",
		allowed: [{ state: "OPENING" }],
		audit: [],
	},
	...BRANCH_ROWS,
];

function fromOf(c: RowCase): State[] {
	return [...new Set(c.allowed.map((s) => s.state))];
}

async function run(c: RowCase, expectedAttempt: number) {
	return transitionPullRequest({
		snapshotId: ID,
		organizationId: ORG,
		event: c.event,
		from: fromOf(c),
		expectedAttempt,
		to: c.to,
		bumpAttempt: PULL_REQUEST_TRANSITIONS[c.event].bump,
		data: {
			pullRequestLastCheckedAt: new Date("2026-09-24T12:00:00.000Z"),
		},
		audit: c.audit.map(audit),
	});
}

describe.each(ROWS)("§4.4: $row", (c) => {
	it.each(c.allowed)("moves from $state", async (s) => {
		const before = seed(s.state, s.with);
		const result = await run(c, 3);
		const bump = PULL_REQUEST_TRANSITIONS[c.event].bump;
		expect(result).toEqual({ ok: true, attempt: bump ? 4 : 3 });
		const after = current();
		const state = c.to === "unchanged" ? before.pullRequestState : c.to;
		expect(after.pullRequestState).toBe(state);
		expect(after.proposalStatus).toBe(
			proposalStatusForPullRequestState(state as State),
		);
		expect(after.pullRequestAttempt).toBe(bump ? 4 : 3);
		expect(after.pullRequestLastCheckedAt).toEqual(
			new Date("2026-09-24T12:00:00.000Z"),
		);
		// Audit rows go through recordAuditTx on the transaction's client.
		expect(auditMocks.recordAuditTx).toHaveBeenCalledTimes(c.audit.length);
		for (const [n, action] of c.audit.entries()) {
			const [client, input] = auditMocks.recordAuditTx.mock.calls[n];
			expect(client).toBe(store.txClients.at(-1));
			expect(input.action).toBe(action);
		}
	});

	const refused = STATES.filter((state) => !fromOf(c).includes(state));
	it.each(
		[
			...refused.map((state) => ({ state }) as Seed),
			...(c.guarded ?? []),
		].map((s) => ({
			...s,
			label: `${s.state}${s.with ? " (guard)" : ""}`,
		})),
	)("is refused from $label, writing nothing", async (s) => {
		const before = seed(s.state, s.with);
		expect(await run(c, 3)).toEqual({ ok: false });
		expect(current()).toEqual(before);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("is refused at a stale attempt", async () => {
		const first = c.allowed[0];
		const before = seed(first.state, first.with);
		expect(await run(c, 2)).toEqual({ ok: false });
		expect(current()).toEqual(before);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});
});

/**
 * The pre-create cancels read #2563 columns a member branch proposal
 * never writes, so on their own they would match a v2 row whose commit is
 * already on its branch (Fizzy #2738 spec §4.3 "Validation REJECTED or
 * abandonment": OPENING only with no journal operation). A v2 row with any
 * journal operation is refused under the row lock.
 */
describe("pre-create cancels never take a branch proposal with a journal operation", () => {
	const JOURNALED_V2: readonly Seed[] = [
		{ state: "QUEUED", with: ON_BRANCH_ROW },
		{ state: "OPENING", with: ON_BRANCH_ROW },
		{
			state: "BLOCKED",
			with: { ...ON_BRANCH_ROW, pullRequestFailure: V_TIMEOUT },
		},
	];
	const cancel = (
		event: (typeof PRE_CREATE_CANCEL_EVENTS)[number],
		state: State,
	) =>
		transitionPullRequest({
			snapshotId: ID,
			organizationId: ORG,
			event,
			from: [state],
			expectedAttempt: 3,
			to: "CANCELED",
			bumpAttempt: true,
			audit: audit(RECONCILED),
		});

	it("names exactly the two pre-create cancels, #2563's own cancel retired with its path (Fizzy #2748)", () => {
		expect([...PRE_CREATE_CANCEL_EVENTS].sort()).toEqual([
			"abandoned",
			"validation_rejected",
		]);
	});

	for (const event of ["validation_rejected", "abandoned"] as const) {
		it.each(JOURNALED_V2)(
			`${event} leaves a v2 $state proposal with a journal operation alone`,
			async (s) => {
				const before = seed(s.state, s.with);
				store.journaled.add(ID);

				expect(await cancel(event, s.state)).toEqual({ ok: false });
				expect(current()).toEqual(before);
				expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
			},
		);

		it(`${event} still cancels a v2 OPENING proposal with no journal operation`, async () => {
			seed("OPENING", ON_BRANCH_ROW);

			expect(await cancel(event, "OPENING")).toEqual({
				ok: true,
				attempt: 4,
			});
			expect(current().pullRequestState).toBe("CANCELED");
		});
	}

	it("reads the journal under the row lock, after it", async () => {
		seed("OPENING", ON_BRANCH_ROW);
		store.journaled.add(ID);

		await cancel("validation_rejected", "OPENING");

		const lock = store.queries.findIndex((q) => /FOR UPDATE/.test(q));
		const journal = store.queries.findIndex((q) =>
			q.includes('"project_instruction_proposal_branch_operation"'),
		);
		expect(lock).toBeGreaterThanOrEqual(0);
		expect(journal).toBeGreaterThan(lock);
	});

	it("leaves every other event's arms to their own guards", async () => {
		seed("OPEN", ON_BRANCH_ROW);
		store.journaled.add(ID);

		expect(
			await transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "branch_evidence",
				from: ["OPEN"],
				expectedAttempt: 3,
				to: "unchanged",
				bumpAttempt: true,
			}),
		).toEqual({ ok: true, attempt: 4 });
		expect(
			store.queries.some((q) =>
				q.includes('"project_instruction_proposal_branch_operation"'),
			),
		).toBe(false);
	});
});

/**
 * A merge racing the revert (Fizzy #2738 spec Decision 14, line 869): a
 * branch proposal CANCELED because its current withdrawal is an established
 * revert takes its pull request's outcome through `branch_settled`, and no
 * other CANCELED row does. The revert is read under the row lock.
 */
describe("branch_settled from CANCELED needs an established current revert", () => {
	const REVERT_CANCELED = { ...ON_BRANCH_ROW, ...WITHDRAWN };
	const settle = (
		to: "MERGED" | "CLOSED",
		expectedAttempt = 3,
		from: readonly State[] = ["CANCELED"],
	) =>
		transitionPullRequest({
			snapshotId: ID,
			organizationId: ORG,
			event: "branch_settled",
			from,
			expectedAttempt,
			to,
			bumpAttempt: true,
			branch: { id: "branch_1", assignment: 1 },
			audit: audit(RECONCILED),
		});

	it.each(["MERGED", "CLOSED"] as const)(
		"moves a revert-CANCELED proposal to %s with one reconciled row",
		async (to) => {
			seed("CANCELED", { ...REVERT_CANCELED, proposalAssignment: 1 });
			store.revertEstablished.add(ID);

			expect(await settle(to)).toEqual({ ok: true, attempt: 4 });
			const after = current();
			expect(after.pullRequestState).toBe(to);
			expect(after.proposalStatus).toBe(
				proposalStatusForPullRequestState(to),
			);
			expect(after.pullRequestAttempt).toBe(4);
			expect(auditMocks.recordAuditTx).toHaveBeenCalledTimes(1);
			expect(auditMocks.recordAuditTx.mock.calls[0]?.[1].action).toBe(
				RECONCILED,
			);
		},
	);

	it("refuses a CANCELED proposal whose current withdrawal is not an established revert, writing nothing", async () => {
		const before = seed("CANCELED", {
			...REVERT_CANCELED,
			proposalAssignment: 1,
		});

		expect(await settle("MERGED")).toEqual({ ok: false });
		expect(current()).toEqual(before);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "a #2563 row", with: { ...V1, ...WITHDRAWN } },
		{
			label: "a row off every branch",
			with: { ...V2, proposalBranchId: null, ...WITHDRAWN },
		},
		{
			label: "another assignment",
			with: { ...REVERT_CANCELED, proposalAssignment: 2 },
		},
		{
			label: "another branch",
			with: {
				...REVERT_CANCELED,
				proposalBranchId: "branch_2",
				proposalAssignment: 1,
			},
		},
	])("refuses $label even with an established revert", async (c) => {
		const before = seed("CANCELED", c.with);
		store.revertEstablished.add(ID);

		expect(await settle("MERGED")).toEqual({ ok: false });
		expect(current()).toEqual(before);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("is refused at a stale attempt", async () => {
		const before = seed("CANCELED", {
			...REVERT_CANCELED,
			proposalAssignment: 1,
		});
		store.revertEstablished.add(ID);

		expect(await settle("MERGED", 2)).toEqual({ ok: false });
		expect(current()).toEqual(before);
	});

	it("never takes CANCELED to CANCELED, nor a MERGED or CLOSED proposal anywhere", async () => {
		seed("CANCELED", { ...REVERT_CANCELED, proposalAssignment: 1 });
		store.revertEstablished.add(ID);

		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "branch_settled",
				from: ["CANCELED"],
				expectedAttempt: 3,
				to: "CANCELED",
				bumpAttempt: true,
				audit: audit(RECONCILED),
			}),
		).rejects.toThrow(/Illegal pull-request transition/);
		for (const state of ["MERGED", "CLOSED"] as const) {
			for (const to of ["MERGED", "CLOSED"] as const) {
				await expect(settle(to, 3, [state])).rejects.toThrow(
					/Illegal pull-request transition/,
				);
			}
		}
	});

	it("reads the revert under the row lock, after it", async () => {
		seed("CANCELED", { ...REVERT_CANCELED, proposalAssignment: 1 });
		store.revertEstablished.add(ID);

		await settle("MERGED");

		const lock = store.queries.findIndex((q) => /FOR UPDATE/.test(q));
		const revert = store.queries.findIndex((q) =>
			q.includes('AS "revertEstablished"'),
		);
		expect(lock).toBeGreaterThanOrEqual(0);
		expect(revert).toBeGreaterThan(lock);
	});

	it("reads no revert for a non-terminal arm, and a call naming both applies it only to CANCELED", async () => {
		seed("OPEN", { ...ON_BRANCH_ROW, proposalAssignment: 1 });

		expect(await settle("MERGED", 3, ["OPEN"])).toEqual({
			ok: true,
			attempt: 4,
		});
		expect(
			store.queries.some((q) => q.includes('AS "revertEstablished"')),
		).toBe(false);

		// OPEN and CANCELED named together: the OPEN row still moves, and
		// a CANCELED row without the revert does not.
		seed("OPEN", { ...ON_BRANCH_ROW, proposalAssignment: 1 });
		expect(await settle("CLOSED", 3, ["OPEN", "CANCELED"])).toEqual({
			ok: true,
			attempt: 4,
		});
		const before = seed("CANCELED", {
			...REVERT_CANCELED,
			proposalAssignment: 1,
		});
		expect(await settle("CLOSED", 3, ["OPEN", "CANCELED"])).toEqual({
			ok: false,
		});
		expect(current()).toEqual(before);
	});
});

describe("transition table invariants", () => {
	const events = Object.keys(PULL_REQUEST_TRANSITIONS) as PullRequestEvent[];
	const branchEvents: readonly PullRequestEvent[] =
		BRANCH_PULL_REQUEST_EVENTS;
	/**
	 * The §4.4 events readiness, the activity boundary and the branch
	 * writers still write: Fizzy #2738 §4.3 amends §4.4 for branch
	 * proposals only.
	 */
	const sharedEvents = events.filter(
		(event) => !branchEvents.includes(event),
	);

	it("never moves CLOSE_REQUESTED to BLOCKED or OPEN", () => {
		for (const event of sharedEvents) {
			for (const to of ["BLOCKED", "OPEN"] as const) {
				expect(() =>
					pullRequestTransitionWhere(
						event,
						["CLOSE_REQUESTED"],
						to,
						3,
					),
				).toThrow(/Illegal pull-request transition/);
			}
			for (const rule of PULL_REQUEST_TRANSITIONS[event].from) {
				if (rule.state === "CLOSE_REQUESTED") {
					expect(rule.to).not.toContain("BLOCKED");
					expect(rule.to).not.toContain("OPEN");
				}
			}
		}
	});

	it("never changes a terminal state: #2563's settlement confirmation was retired with its path (Fizzy #2748)", () => {
		for (const event of sharedEvents) {
			for (const rule of PULL_REQUEST_TRANSITIONS[event].from) {
				if (["MERGED", "CLOSED", "CANCELED"].includes(rule.state)) {
					expect(rule.to.filter((to) => to !== "unchanged")).toEqual(
						[],
					);
				}
			}
		}
	});

	it("guards every branch arm on a v2 context, so no #2563 row takes one", () => {
		for (const event of branchEvents) {
			for (const rule of PULL_REQUEST_TRANSITIONS[event].from) {
				expect(JSON.stringify(rule.guard)).toContain(
					'{"pullRequestContext":{"path":["v"],"equals":2}}',
				);
			}
		}
	});

	it("moves a branch proposal from CLOSE_REQUESTED to OPEN or BLOCKED only by its evidence", () => {
		for (const event of branchEvents) {
			for (const rule of PULL_REQUEST_TRANSITIONS[event].from) {
				if (
					rule.state === "CLOSE_REQUESTED" &&
					(rule.to.includes("OPEN") || rule.to.includes("BLOCKED"))
				) {
					expect(event).toBe("branch_evidence");
				}
			}
		}
	});

	it("moves a terminal branch proposal only by a transfer to QUEUED, or by classification from a revert CANCELED (Decision 14)", () => {
		for (const event of branchEvents) {
			for (const rule of PULL_REQUEST_TRANSITIONS[event].from) {
				if (!["MERGED", "CLOSED", "CANCELED"].includes(rule.state)) {
					continue;
				}
				if (event === "branch_settled") {
					expect(rule).toEqual({
						state: "CANCELED",
						to: ["MERGED", "CLOSED"],
						guard: {
							AND: [
								{
									pullRequestContext: {
										path: ["v"],
										equals: 2,
									},
								},
								{ proposalBranchId: { not: null } },
							],
						},
						requires: "established_current_revert",
					});
				} else {
					expect(event).toBe("branch_transfer");
					expect(rule.to).toEqual(["QUEUED"]);
					expect(rule.requires).toBeUndefined();
				}
			}
		}
	});

	it("lets no other event move a terminal branch proposal", () => {
		const terminal = ["MERGED", "CLOSED", "CANCELED"] as const;
		const moves: string[] = [];
		for (const event of events) {
			for (const rule of PULL_REQUEST_TRANSITIONS[event].from) {
				if (!(terminal as readonly string[]).includes(rule.state)) {
					continue;
				}
				for (const to of rule.to) {
					if (to !== "unchanged" && to !== rule.state) {
						moves.push(`${event}:${rule.state}->${to}`);
					}
				}
			}
		}
		expect(moves.sort()).toEqual(
			[
				"branch_settled:CANCELED->MERGED",
				"branch_settled:CANCELED->CLOSED",
				"branch_transfer:MERGED->QUEUED",
				"branch_transfer:CLOSED->QUEUED",
				"branch_transfer:CANCELED->QUEUED",
			].sort(),
		);
		// Only the Decision 14 arm carries the revert requirement.
		const requiring = events.flatMap((event) =>
			PULL_REQUEST_TRANSITIONS[event].from
				.filter((rule) => rule.requires !== undefined)
				.map((rule) => `${event}:${rule.state}`),
		);
		expect(requiring).toEqual(["branch_settled:CANCELED"]);
		// And every other (branch event, terminal state, target) is illegal.
		for (const event of branchEvents) {
			for (const state of terminal) {
				for (const to of [...STATES, "unchanged"] as const) {
					const legal =
						(event === "branch_transfer" && to === "QUEUED") ||
						(event === "branch_settled" &&
							state === "CANCELED" &&
							(to === "MERGED" || to === "CLOSED"));
					const where = () =>
						pullRequestTransitionWhere(event, [state], to, 3);
					if (legal) {
						expect(where).not.toThrow();
					} else {
						expect(where).toThrow(
							/Illegal pull-request transition/,
						);
					}
				}
			}
		}
	});

	it("refuses an illegal combination loudly rather than as a race", async () => {
		seed("QUEUED");
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "deadline",
				from: ["QUEUED"],
				expectedAttempt: 3,
				to: "MERGED",
				bumpAttempt: false,
			}),
		).rejects.toThrow(/Illegal pull-request transition/);
	});

	it("refuses an attempt bump the row does not make, and a missing one", async () => {
		seed("QUEUED");
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "deadline",
				from: ["QUEUED"],
				expectedAttempt: 3,
				to: "BLOCKED",
				bumpAttempt: true,
			}),
		).rejects.toThrow(/must not bump/);
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "validation_rejected",
				from: ["QUEUED"],
				expectedAttempt: 3,
				to: "CANCELED",
				bumpAttempt: false,
				audit: audit(RECONCILED),
			}),
		).rejects.toThrow(/must bump/);
	});

	it("writes audit rows only for a row with an audit column, and never omits them", async () => {
		seed("QUEUED");
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "deadline",
				from: ["QUEUED"],
				expectedAttempt: 3,
				to: "BLOCKED",
				bumpAttempt: false,
				audit: audit(RECONCILED),
			}),
		).rejects.toThrow(/writes exactly \[\], not/);
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "validation_rejected",
				from: ["QUEUED"],
				expectedAttempt: 3,
				to: "CANCELED",
				bumpAttempt: true,
			}),
		).rejects.toThrow(/writes exactly/);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("rolls the transition back when its audit write throws", async () => {
		const before = seed("QUEUED");
		auditMocks.recordAuditTx.mockRejectedValueOnce(new Error("audit down"));
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "validation_rejected",
				from: ["QUEUED"],
				expectedAttempt: 3,
				to: "CANCELED",
				bumpAttempt: true,
				audit: audit(RECONCILED),
			}),
		).rejects.toThrow("audit down");
		expect(current()).toEqual(before);
	});

	it("runs on the caller's transaction when one is passed", async () => {
		seed("QUEUED");
		const { db } = await import("../prisma/client");
		// A transaction client: the transition takes the row lock through it.
		const tx = {
			projectInstructionSnapshot: db.projectInstructionSnapshot,
			$queryRaw: db.$queryRaw,
		};
		const result = await transitionPullRequest(
			{
				snapshotId: ID,
				organizationId: ORG,
				event: "validation_failed",
				from: ["QUEUED"],
				expectedAttempt: 3,
				to: "unchanged",
				bumpAttempt: false,
				data: { pullRequestFailure: V_FAILED as Prisma.InputJsonValue },
			},
			tx as unknown as Prisma.TransactionClient,
		);
		expect(result).toEqual({ ok: true, attempt: 3 });
		expect(store.txClients).toEqual([]);
		expect(current().pullRequestFailure).toEqual(V_FAILED);
	});

	it("never matches another organization's row", async () => {
		const before = seed("QUEUED");
		expect(
			await transitionPullRequest({
				snapshotId: ID,
				organizationId: "org_2",
				event: "validation_failed",
				from: ["QUEUED"],
				expectedAttempt: 3,
				to: "unchanged",
				bumpAttempt: false,
			}),
		).toEqual({ ok: false });
		expect(current()).toEqual(before);
	});
});

/**
 * The attempt fence (spec §4.2, §4.4).
 * Every arm compares the caller's observed attempt, so two callers holding
 * one observation cannot both write and a stale activity cannot overwrite a
 * newer attempt. The only arms §4.4 named as not attempt-fenced, a receipt
 * landing on CLOSE_REQUESTED and a settlement confirmation, were #2563's and
 * were retired with that path (Fizzy #2748): no arm is unfenced now.
 */
describe("attempt fence policy (spec §4.2, §4.4)", () => {
	type Arm = {
		event: PullRequestEvent;
		state: State;
		to: State | "unchanged";
		independent: boolean;
	};
	const arms: Arm[] = (
		Object.keys(PULL_REQUEST_TRANSITIONS) as PullRequestEvent[]
	).flatMap((event) =>
		PULL_REQUEST_TRANSITIONS[event].from.flatMap((rule) =>
			rule.to.map((to) => ({
				event,
				state: rule.state,
				to,
				independent: rule.attemptIndependent === true,
			})),
		),
	);

	it("leaves no arm unfenced", () => {
		expect(arms.filter((a) => a.independent)).toEqual([]);
	});

	it("fences every arm that takes a new attempt", () => {
		for (const arm of arms) {
			if (PULL_REQUEST_TRANSITIONS[arm.event].bump) {
				expect(arm).toMatchObject({ independent: false });
			}
		}
	});

	it.each(
		arms
			.filter((a) => !a.independent)
			.map((a) => ({ ...a, label: `${a.event} ${a.state} -> ${a.to}` })),
	)("refuses expectedAttempt null for $label, writing nothing", async (a) => {
		const before = seed(a.state);
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: a.event,
				from: [a.state],
				expectedAttempt: null,
				to: a.to,
				bumpAttempt: PULL_REQUEST_TRANSITIONS[a.event].bump,
			}),
		).rejects.toThrow(/is attempt-fenced/);
		expect(current()).toEqual(before);
		expect(store.txClients).toEqual([]);
	});

	it("refuses a stale open activity's failure that names no attempt", async () => {
		const before = seed("OPENING", { pullRequestAttempt: 5 });
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "open_failure",
				from: ["OPENING"],
				expectedAttempt: null,
				to: "BLOCKED",
				bumpAttempt: false,
				data: {
					pullRequestFailure: PREPARE as Prisma.InputJsonValue,
				},
			}),
		).rejects.toThrow(/is attempt-fenced/);
		expect(current()).toEqual(before);
	});

	it("puts the attempt predicate inside each source clause", () => {
		expect(
			pullRequestTransitionWhere(
				"open_failure",
				["OPENING"],
				"BLOCKED",
				4,
			),
		).toEqual({ pullRequestState: "OPENING", pullRequestAttempt: 4 });
		expect(
			pullRequestTransitionWhere(
				"push_unknown",
				["OPENING", "CLOSE_REQUESTED"],
				"unchanged",
				2,
			),
		).toEqual({
			OR: [
				{ pullRequestState: "OPENING", pullRequestAttempt: 2 },
				{ pullRequestState: "CLOSE_REQUESTED", pullRequestAttempt: 2 },
			],
		});
	});
});

/**
 * Exact audit rows (spec §4.4 "Audit", §13.4). Each (event, target) names the multiset of actions its
 * transition writes, and a call must match it exactly: an omitted, extra or
 * duplicated action is refused before anything is written.
 */
describe("exact audit rows (spec §4.4, §13.4)", () => {
	type Case = {
		event: PullRequestEvent;
		state: State;
		to: State | "unchanged";
		independent: boolean;
		audits: string[];
	};
	/** One legal source per (event, target), for every event. */
	const cases: Case[] = (
		Object.keys(PULL_REQUEST_TRANSITIONS) as PullRequestEvent[]
	).flatMap((event) => {
		const seen = new Set<string>();
		return PULL_REQUEST_TRANSITIONS[event].from.flatMap((rule) =>
			rule.to
				.filter((to) => {
					if (seen.has(to)) {
						return false;
					}
					seen.add(to);
					return true;
				})
				.map((to) => ({
					event,
					state: rule.state,
					to,
					independent: rule.attemptIndependent === true,
					audits: [...requiredPullRequestAudits(event, to)],
				})),
		);
	});

	const short = (action: string) => action.split(".").at(-1);

	it("derives the audit rows from the event and its target", () => {
		expect(
			Object.fromEntries(
				cases
					.filter((c) => c.audits.length > 0)
					.map((c) => [`${c.event}:${c.to}`, [...c.audits].sort()]),
			),
		).toEqual({
			"validation_rejected:CANCELED": [RECONCILED],
			"abandoned:CANCELED": [RECONCILED],
			"branch_evidence:CANCELED": [RECONCILED],
			"branch_stop_tracking:CANCELED": [RECONCILED],
			"branch_withdraw:CANCELED": [CLOSE_REQ],
			"branch_withdraw:CLOSE_REQUESTED": [CLOSE_REQ],
			"branch_withdraw:unchanged": [CLOSE_REQ],
			"branch_settled:MERGED": [RECONCILED],
			"branch_settled:CLOSED": [RECONCILED],
			"branch_settled:CANCELED": [RECONCILED],
		});
	});

	const variants = cases.flatMap((c) => {
		const base = `${c.event} -> ${c.to}`;
		if (c.audits.length === 0) {
			return [
				{
					...c,
					label: `${base} with an audit row`,
					actions: [RECONCILED],
				},
			];
		}
		const first = c.audits[0] as string;
		return [
			...c.audits.map((omitted, n) => ({
				...c,
				label: `${base} without ${short(omitted)}`,
				actions: c.audits.filter((_, m) => m !== n),
			})),
			{
				...c,
				label: `${base} with ${short(first)} twice`,
				actions: [...c.audits, first],
			},
			{
				...c,
				label: `${base} with an extra action`,
				actions: [
					...c.audits,
					c.audits.includes(CLOSE_REQ) ? RECONCILED : CLOSE_REQ,
				],
			},
		];
	});

	it.each(variants)("refuses $label, writing nothing", async (v) => {
		const before = seed(v.state);
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: v.event,
				from: [v.state],
				expectedAttempt: v.independent ? null : 3,
				to: v.to,
				bumpAttempt: PULL_REQUEST_TRANSITIONS[v.event].bump,
				audit: v.actions.map(audit),
			}),
		).rejects.toThrow(/writes exactly/);
		expect(current()).toEqual(before);
		expect(store.txClients).toEqual([]);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});
});

describe("merge-sync receipts (spec §9.1)", () => {
	const RECEIPT_SELECT = {
		id: true,
		projectId: true,
		syncId: true,
		generation: true,
		trigger: true,
		startedAt: true,
		status: true,
		error: true,
	};

	it("finds the newest merge-triggered run for the tuple, started at or after the request", async () => {
		const requestedAt = new Date("2026-09-24T10:00:00.000Z");
		store.runFindFirst.mockResolvedValue({ id: "sync_1:run_1" });

		expect(
			await findMergeTriggeredRun({
				projectId: "p",
				organizationId: ORG,
				syncId: "sync_1",
				generation: 3,
				startedAtOrAfter: requestedAt,
			}),
		).toEqual({ id: "sync_1:run_1" });
		expect(store.runFindFirst).toHaveBeenCalledWith({
			where: {
				projectId: "p",
				organizationId: ORG,
				syncId: "sync_1",
				generation: 3,
				trigger: "PULL_REQUEST_MERGED",
				startedAt: { gte: requestedAt },
			},
			orderBy: { startedAt: "desc" },
			select: RECEIPT_SELECT,
		});
	});

	it("looks a receipt up by the Temporal run id, whichever sync row keyed it", async () => {
		store.runFindFirst.mockResolvedValue(null);

		expect(
			await getSyncRunReceiptByRunId({
				projectId: "p",
				organizationId: ORG,
				runId: "run_1",
			}),
		).toBeNull();
		expect(store.runFindFirst).toHaveBeenCalledWith({
			where: {
				projectId: "p",
				organizationId: ORG,
				id: { endsWith: ":run_1" },
			},
			select: RECEIPT_SELECT,
		});
	});

	it("refuses an empty run id, which would match every receipt", async () => {
		await expect(
			getSyncRunReceiptByRunId({
				projectId: "p",
				organizationId: ORG,
				runId: "",
			}),
		).rejects.toThrow(/run id/);
		expect(store.runFindFirst).not.toHaveBeenCalled();
	});

	it("reads a page's receipts in one tenant-scoped query, by the same run-id rule, keyed by run id", async () => {
		store.runFindMany.mockResolvedValue([
			{ id: "sync_2:run_2", status: "FAILED" },
			{ id: "sync_1:run_1", status: "SUCCEEDED" },
		]);

		const receipts = await getSyncRunReceiptsByRunIds({
			projectId: "p",
			organizationId: ORG,
			runIds: ["run_1", "run_2", "run_1", "run_3"],
		});

		expect(store.runFindMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				projectId: "p",
				organizationId: ORG,
				OR: [
					{ id: { endsWith: ":run_1" } },
					{ id: { endsWith: ":run_2" } },
					{ id: { endsWith: ":run_3" } },
				],
			},
			select: RECEIPT_SELECT,
		});
		expect(store.runFindFirst).not.toHaveBeenCalled();
		// A run with no receipt is absent, which reads as "none" exactly as
		// the single read's null does.
		expect([...receipts.entries()]).toEqual([
			["run_1", { id: "sync_1:run_1", status: "SUCCEEDED" }],
			["run_2", { id: "sync_2:run_2", status: "FAILED" }],
		]);
	});

	it("never asks for an empty run id, and issues no query when none is left", async () => {
		expect(
			await getSyncRunReceiptsByRunIds({
				projectId: "p",
				organizationId: ORG,
				runIds: ["", ""],
			}),
		).toEqual(new Map());
		expect(
			await getSyncRunReceiptsByRunIds({
				projectId: "p",
				organizationId: ORG,
				runIds: [],
			}),
		).toEqual(new Map());
		expect(store.runFindMany).not.toHaveBeenCalled();
	});
});
