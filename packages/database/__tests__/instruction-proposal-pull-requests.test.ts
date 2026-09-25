/**
 * Proposal pull requests: the state mapping, the attempt records and one
 * test per spec §4.4 transition row (Fizzy #2563).
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
	/** The database clock the claim's `now()` compares against. */
	now: new Date("2026-09-24T12:00:00.000Z"),
	queries: [] as string[],
	txClients: [] as unknown[],
	/** The sweeper's sub-batch statements, flattened as Prisma binds them. */
	selections: [] as Array<{ batch: string; sql: string; values: unknown[] }>,
	/** What each sub-batch returns, keyed by the `sweep:<batch>` marker in its SQL. */
	selectionRows: {} as Record<string, Array<Record<string, unknown>>>,
	executes: [] as Array<{ sql: string; values: unknown[] }>,
	executeCount: 1,
	transactionOptions: [] as unknown[],
	runFindFirst: vi.fn(),
	runFindMany: vi.fn(),
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
		const batch = /\/\* sweep:(\w+) \*\//.exec(flat.sql)?.[1];
		if (batch) {
			store.selections.push({
				batch,
				sql: flat.sql.replace(/\s+/g, " "),
				values: flat.values,
			});
			return structuredClone(store.selectionRows[batch] ?? []);
		}
		const sql = strings.join("?");
		store.queries.push(sql);
		const [id, organizationId] = values as [string, string];
		const row = store.rows.get(id);
		if (!row || row.organizationId !== organizationId) {
			return [];
		}
		if (sql.includes("<= (now() AT TIME ZONE 'UTC')")) {
			const next = row.pullRequestNextAttemptAt as Date | null;
			return [
				{
					state: row.pullRequestState,
					attempt: row.pullRequestAttempt,
					failure: structuredClone(row.pullRequestFailure),
					attempts: structuredClone(row.pullRequestAttempts),
					due: next === null || next.getTime() <= store.now.getTime(),
				},
			];
		}
		return [{ id }];
	}

	async function executeRaw(
		strings: TemplateStringsArray,
		...values: unknown[]
	) {
		const flat = sqltag(strings, ...values);
		store.executes.push({
			sql: flat.sql.replace(/\s+/g, " "),
			values: flat.values,
		});
		return store.executeCount;
	}

	const client = {
		projectInstructionSnapshot: snapshot,
		projectInstructionRepositorySyncRun: {
			findFirst: (...a: unknown[]) => store.runFindFirst(...a),
			findMany: (...a: unknown[]) => store.runFindMany(...a),
		},
		$queryRaw: queryRaw,
		$executeRaw: executeRaw,
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
			$transaction: async (
				cb: (tx: unknown) => Promise<unknown>,
				options?: unknown,
			) => {
				store.transactionOptions.push(options);
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
	claimPullRequestOpen,
	clearMergeSyncRequest,
	deferProposalOperation,
	findMergeTriggeredRun,
	getSyncRunReceiptByRunId,
	getSyncRunReceiptsByRunIds,
	hasOutstandingObligation,
	INSTRUCTION_PULL_REQUEST_FAILURE_CODES,
	nextRetryDelayMs,
	PULL_REQUEST_TRANSITIONS,
	type PullRequestAttemptRecord,
	type PullRequestEvent,
	proposalStatusForPullRequestState,
	pullRequestTransitionWhere,
	requiredPullRequestAudits,
	selectDueProposalOperations,
	summarizeAttempts,
	transitionPullRequest,
	writeAttemptRecord,
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
	store.selections = [];
	store.selectionRows = {};
	store.executes = [];
	store.executeCount = 1;
	store.transactionOptions = [];
	store.runFindFirst.mockReset();
	store.runFindMany.mockReset();
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
	/** For rows not fenced on the attempt. */
	unfenced?: boolean;
};

const RECONCILED = "project.instructions.pull_request_reconciled";
const OPENED = "project.instructions.pull_request_opened";
const CLOSE_REQ = "project.instructions.pull_request_close_requested";

const V_FAILED = failure("VALIDATION_FAILED", "validation", true);
const V_TIMEOUT = failure("VALIDATION_TIMEOUT", "validation", true);
const ADMISSION = failure("ATTRIBUTION_REJECTED", "admission", false);
const PREPARE = failure("GIT_FAILED", "prepare", true);
const CREATE_UNKNOWN_RETRYABLE = failure(
	"CREATE_OUTCOME_UNKNOWN",
	"create",
	true,
);
const CREATE_UNKNOWN_FINAL = failure("CREATE_OUTCOME_UNKNOWN", "create", false);
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
		row: "Close's claim takes a new attempt and keeps CLOSE_REQUESTED",
		event: "claim",
		to: "unchanged",
		allowed: [{ state: "CLOSE_REQUESTED" }],
		audit: [],
	},
	{
		row: "Recovery adoption opens",
		event: "adopt",
		to: "OPEN",
		allowed: [
			{ state: "OPENING" },
			{ state: "BLOCKED", with: { pullRequestFailure: PREPARE } },
			{ state: "QUEUED" },
		],
		audit: [OPENED],
	},
	{
		row: "Recovery adoption of a merged pull request",
		event: "adopt",
		to: "MERGED",
		allowed: [
			{ state: "OPENING" },
			{ state: "BLOCKED", with: { pullRequestFailure: PREPARE } },
			{ state: "QUEUED" },
		],
		audit: [OPENED, RECONCILED],
	},
	{
		row: "Recovery adoption of a closed pull request",
		event: "adopt",
		to: "CLOSED",
		allowed: [
			{ state: "OPENING" },
			{ state: "BLOCKED", with: { pullRequestFailure: PREPARE } },
			{ state: "QUEUED" },
		],
		audit: [OPENED, RECONCILED],
	},
	{
		row: "Recovery adoption keeps CLOSE_REQUESTED, which close then closes",
		event: "adopt",
		to: "unchanged",
		allowed: [{ state: "CLOSE_REQUESTED" }],
		audit: [OPENED],
	},
	{
		row: "Receipt recorded at my attempt",
		event: "receipt",
		to: "OPEN",
		allowed: [{ state: "OPENING" }],
		audit: [OPENED],
	},
	{
		row: "Receipt of a pull request already observed merged",
		event: "receipt",
		to: "MERGED",
		allowed: [{ state: "OPENING" }],
		audit: [OPENED, RECONCILED],
	},
	{
		row: "Receipt of a pull request already observed closed",
		event: "receipt",
		to: "CLOSED",
		allowed: [{ state: "OPENING" }],
		audit: [OPENED, RECONCILED],
	},
	{
		row: "Receipt recorded on CLOSE_REQUESTED records facts, unfenced",
		event: "receipt",
		to: "unchanged",
		allowed: [{ state: "CLOSE_REQUESTED" }],
		audit: [OPENED],
		unfenced: true,
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
		row: "Create unresolved 24 h after the marker",
		event: "create_unknown_expired",
		to: "BLOCKED",
		allowed: [
			{
				state: "OPENING",
				with: { pullRequestFailure: CREATE_UNKNOWN_RETRYABLE },
			},
			{
				state: "BLOCKED",
				with: { pullRequestFailure: CREATE_UNKNOWN_RETRYABLE },
			},
		],
		guarded: [
			{
				state: "BLOCKED",
				with: { pullRequestFailure: CREATE_UNKNOWN_FINAL },
			},
			{ state: "OPENING", with: { pullRequestFailure: PREPARE } },
		],
		audit: [],
	},
	{
		row: "Retry opening is requested on a row only a human may re-issue",
		event: "retry",
		to: "unchanged",
		allowed: [
			{
				state: "BLOCKED",
				with: { pullRequestFailure: CREATE_UNKNOWN_FINAL },
			},
			{
				state: "BLOCKED",
				with: {
					pullRequestFailure: failure(
						"PR_CREATION_REFUSED",
						"create",
						false,
					),
				},
			},
			{
				state: "BLOCKED",
				with: {
					pullRequestFailure: failure(
						"REMOTE_REF_CONFLICT",
						"push",
						false,
					),
				},
			},
		],
		guarded: [
			{
				state: "BLOCKED",
				with: { pullRequestFailure: CREATE_UNKNOWN_RETRYABLE },
			},
			{ state: "BLOCKED", with: { pullRequestFailure: PREPARE } },
		],
		audit: ["project.instructions.pull_request_retry_requested"],
	},
	{
		row: "Retry settlement found nothing: the re-issue's ref, at my attempt",
		event: "reissue",
		to: "unchanged",
		allowed: [{ state: "OPENING" }],
		audit: [],
	},
	{
		row: "Cancel requested before any push or create",
		event: "cancel_pre_create",
		to: "CANCELED",
		allowed: [
			{ state: "QUEUED" },
			{ state: "BLOCKED", with: { pullRequestFailure: V_TIMEOUT } },
			{ state: "BLOCKED", with: { pullRequestFailure: ADMISSION } },
		],
		guarded: [
			{ state: "QUEUED", with: HEAD },
			{
				state: "BLOCKED",
				with: { pullRequestFailure: V_TIMEOUT, ...HEAD },
			},
			{
				state: "BLOCKED",
				with: {
					pullRequestFailure: V_TIMEOUT,
					pullRequestObligationOpen: true,
				},
			},
			{ state: "BLOCKED", with: { pullRequestFailure: PREPARE } },
		],
		audit: [CLOSE_REQ],
	},
	{
		row: "Cancel requested later",
		event: "cancel_later",
		to: "CLOSE_REQUESTED",
		allowed: [
			{ state: "OPENING" },
			{ state: "OPEN" },
			{ state: "BLOCKED", with: { pullRequestFailure: PREPARE } },
			{
				state: "BLOCKED",
				with: { pullRequestFailure: V_TIMEOUT, ...HEAD },
			},
			{
				state: "BLOCKED",
				with: {
					pullRequestFailure: V_TIMEOUT,
					pullRequestObligationOpen: true,
				},
			},
		],
		// Exactly the rows the pre-create cancel takes.
		guarded: [
			{ state: "BLOCKED", with: { pullRequestFailure: V_TIMEOUT } },
			{ state: "BLOCKED", with: { pullRequestFailure: ADMISSION } },
		],
		audit: [CLOSE_REQ],
	},
	{
		row: "Settled closed one",
		event: "settled",
		to: "CLOSED",
		allowed: [{ state: "CLOSE_REQUESTED" }],
		audit: [RECONCILED],
	},
	{
		row: "Settled with none existing",
		event: "settled",
		to: "CANCELED",
		allowed: [{ state: "CLOSE_REQUESTED" }],
		audit: [RECONCILED],
	},
	{
		row: "Settled, and MERGED wins",
		event: "settled",
		to: "MERGED",
		allowed: [{ state: "CLOSE_REQUESTED" }],
		audit: [RECONCILED],
	},
	{
		row: "Settlement confirmation closes a late pull request on a canceled row",
		event: "confirmation",
		to: "CLOSED",
		allowed: [{ state: "CANCELED" }],
		audit: [RECONCILED],
		unfenced: true,
	},
	{
		row: "Settlement confirmation finds a merge on a canceled row",
		event: "confirmation",
		to: "MERGED",
		allowed: [{ state: "CANCELED" }],
		audit: [RECONCILED],
		unfenced: true,
	},
	{
		row: "Settlement confirmation keeps any other row's state",
		event: "confirmation",
		to: "unchanged",
		allowed: STATES.map((state) => ({ state })),
		audit: [],
		unfenced: true,
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
	{
		row: "Settlement cannot delete: failure-only on CLOSE_REQUESTED",
		event: "settle_blocked",
		to: "unchanged",
		allowed: [{ state: "CLOSE_REQUESTED" }],
		audit: [],
	},
	{
		row: "Settlement cannot delete, under retry",
		event: "settle_blocked",
		to: "BLOCKED",
		allowed: [{ state: "OPENING" }],
		audit: [],
	},
	{
		row: "Observe merged",
		event: "observe",
		to: "MERGED",
		allowed: [{ state: "OPEN" }],
		audit: [RECONCILED],
	},
	{
		row: "Observe closed",
		event: "observe",
		to: "CLOSED",
		allowed: [{ state: "OPEN" }],
		audit: [RECONCILED],
	},
	{
		row: "Observe still open stamps the check",
		event: "observe",
		to: "unchanged",
		allowed: [{ state: "OPEN" }],
		audit: [],
	},
	{
		row: "Sweeper restart defers a row whose workflow is running",
		event: "restart_deferred",
		to: "unchanged",
		allowed: [
			{ state: "QUEUED" },
			{ state: "OPENING" },
			{ state: "BLOCKED", with: { pullRequestFailure: PREPARE } },
		],
		audit: [],
	},
];

function fromOf(c: RowCase): State[] {
	return [...new Set(c.allowed.map((s) => s.state))];
}

async function run(c: RowCase, expectedAttempt: number | null) {
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
		const result = await run(c, c.unfenced ? null : 3);
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
		expect(await run(c, c.unfenced ? null : 3)).toEqual({ ok: false });
		expect(current()).toEqual(before);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	if (!c.unfenced) {
		it("is refused at a stale attempt", async () => {
			const first = c.allowed[0];
			const before = seed(first.state, first.with);
			expect(await run(c, 2)).toEqual({ ok: false });
			expect(current()).toEqual(before);
			expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
		});
	}
});

describe("transition table invariants", () => {
	const events = Object.keys(PULL_REQUEST_TRANSITIONS) as PullRequestEvent[];

	it("never moves CLOSE_REQUESTED to BLOCKED or OPEN", () => {
		for (const event of events) {
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

	it("changes a terminal state only by a settlement confirmation", () => {
		for (const event of events) {
			for (const rule of PULL_REQUEST_TRANSITIONS[event].from) {
				if (["MERGED", "CLOSED", "CANCELED"].includes(rule.state)) {
					const moves = rule.to.filter((to) => to !== "unchanged");
					if (event === "confirmation" && rule.state === "CANCELED") {
						expect(moves).toEqual(["CLOSED", "MERGED"]);
					} else {
						expect(moves).toEqual([]);
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
				event: "observe",
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

	it("reads the attempt back for an attempt-independent arm, whatever the row's attempt", async () => {
		seed("CLOSE_REQUESTED", { pullRequestAttempt: 7 });
		expect(
			await transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "receipt",
				from: ["CLOSE_REQUESTED"],
				expectedAttempt: null,
				to: "unchanged",
				bumpAttempt: false,
				audit: audit(OPENED),
			}),
		).toEqual({ ok: true, attempt: 7 });
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
 * newer attempt. The only arms that never compare it are the facts §4.4
 * names as not attempt-fenced: a receipt landing on CLOSE_REQUESTED and a
 * settlement confirmation, which is fenced on its record's identity instead.
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

	it("leaves only a receipt on CLOSE_REQUESTED and settlement confirmations unfenced", () => {
		expect(
			[
				...new Set(
					arms
						.filter(
							(a) =>
								a.independent &&
								PULL_REQUEST_TRANSITIONS[a.event].writer ===
									undefined,
						)
						.map((a) => `${a.event}:${a.state}`),
				),
			].sort(),
		).toEqual(
			[
				...STATES.map((state) => `confirmation:${state}`),
				"receipt:CLOSE_REQUESTED",
			].sort(),
		);
	});

	it("fences the merge-sync events on mergeSyncExpected through their one writer, never unfenced", async () => {
		for (const event of [
			"merge_sync_acknowledged",
			"merge_sync_given_up",
		] as const) {
			expect(PULL_REQUEST_TRANSITIONS[event].writer).toBe(
				"clearMergeSyncRequest",
			);
			const before = seed("MERGED", {
				mergeSyncRequestedAt: new Date("2026-09-24T09:00:00.000Z"),
			});
			await expect(
				transitionPullRequest({
					snapshotId: ID,
					organizationId: ORG,
					event,
					from: ["MERGED"],
					expectedAttempt: null,
					to: "unchanged",
					bumpAttempt: false,
					data: { mergeSyncRequestedAt: null },
				}),
			).rejects.toThrow(/written only by clearMergeSyncRequest/);
			expect(current()).toEqual(before);
		}
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

	it("refuses a Close claim that names no attempt, so two claims cannot both take the row", async () => {
		const before = seed("CLOSE_REQUESTED", { pullRequestAttempt: 7 });
		const claim = () =>
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "claim",
				from: ["CLOSE_REQUESTED"],
				expectedAttempt: null,
				to: "unchanged",
				bumpAttempt: true,
			});
		await expect(claim()).rejects.toThrow(/is attempt-fenced/);
		await expect(claim()).rejects.toThrow(/is attempt-fenced/);
		expect(current()).toEqual(before);
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

	it("refuses an attempt on a call that names only attempt-independent arms", async () => {
		const before = seed("CLOSE_REQUESTED");
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "receipt",
				from: ["CLOSE_REQUESTED"],
				expectedAttempt: 3,
				to: "unchanged",
				bumpAttempt: false,
				audit: audit(OPENED),
			}),
		).rejects.toThrow(/attempt-independent/);
		expect(current()).toEqual(before);
		const canceled = seed("CANCELED");
		await expect(
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "confirmation",
				from: ["CANCELED"],
				expectedAttempt: 3,
				to: "CLOSED",
				bumpAttempt: false,
				audit: audit(RECONCILED),
			}),
		).rejects.toThrow(/attempt-independent/);
		expect(current()).toEqual(canceled);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("puts the attempt predicate inside each fenced source clause only", () => {
		expect(
			pullRequestTransitionWhere("receipt", ["OPENING"], "OPEN", 4),
		).toEqual({ pullRequestState: "OPENING", pullRequestAttempt: 4 });
		expect(
			pullRequestTransitionWhere(
				"receipt",
				["CLOSE_REQUESTED"],
				"unchanged",
				null,
			),
		).toEqual({ pullRequestState: "CLOSE_REQUESTED" });
		expect(
			pullRequestTransitionWhere(
				"cancel_later",
				["OPENING", "OPEN"],
				"CLOSE_REQUESTED",
				2,
			),
		).toEqual({
			OR: [
				{ pullRequestState: "OPENING", pullRequestAttempt: 2 },
				{ pullRequestState: "OPEN", pullRequestAttempt: 2 },
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
	const RETRY = "project.instructions.pull_request_retry_requested";
	const MERGE_SYNC = "project.instructions.pull_request_merge_sync_requested";

	type Case = {
		event: PullRequestEvent;
		state: State;
		to: State | "unchanged";
		independent: boolean;
		audits: string[];
	};
	/** One legal source per (event, target), for every generally written event. */
	const cases: Case[] = (
		Object.keys(PULL_REQUEST_TRANSITIONS) as PullRequestEvent[]
	)
		.filter((event) => PULL_REQUEST_TRANSITIONS[event].writer === undefined)
		.flatMap((event) => {
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
		const both = [OPENED, RECONCILED].sort();
		expect(
			Object.fromEntries(
				cases
					.filter((c) => c.audits.length > 0)
					.map((c) => [`${c.event}:${c.to}`, [...c.audits].sort()]),
			),
		).toEqual({
			"validation_rejected:CANCELED": [RECONCILED],
			"abandoned:CANCELED": [RECONCILED],
			"adopt:OPEN": [OPENED],
			"adopt:MERGED": both,
			"adopt:CLOSED": both,
			"adopt:unchanged": [OPENED],
			"receipt:OPEN": [OPENED],
			"receipt:MERGED": both,
			"receipt:CLOSED": both,
			"receipt:unchanged": [OPENED],
			"retry:unchanged": [RETRY],
			"cancel_pre_create:CANCELED": [CLOSE_REQ],
			"cancel_later:CLOSE_REQUESTED": [CLOSE_REQ],
			"settled:CLOSED": [RECONCILED],
			"settled:CANCELED": [RECONCILED],
			"settled:MERGED": [RECONCILED],
			"confirmation:CLOSED": [RECONCILED],
			"confirmation:MERGED": [RECONCILED],
			"observe:MERGED": [RECONCILED],
			"observe:CLOSED": [RECONCILED],
		});
		expect(
			requiredPullRequestAudits("merge_sync_acknowledged", "unchanged"),
		).toEqual([MERGE_SYNC]);
		expect(
			requiredPullRequestAudits("merge_sync_given_up", "unchanged"),
		).toEqual([]);
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
					c.audits.includes(RETRY) ? CLOSE_REQ : RETRY,
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

	it("writes exactly one pull_request_retry_requested row for Retry opening", async () => {
		seed("BLOCKED", { pullRequestFailure: CREATE_UNKNOWN_FINAL });
		const retry = (actions: string[]) =>
			transitionPullRequest({
				snapshotId: ID,
				organizationId: ORG,
				event: "retry",
				from: ["BLOCKED"],
				expectedAttempt: 3,
				to: "unchanged",
				bumpAttempt: false,
				audit: actions.map(audit),
			});
		await expect(retry([])).rejects.toThrow(/writes exactly/);
		await expect(retry([RETRY, RETRY])).rejects.toThrow(/writes exactly/);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
		expect(await retry([RETRY])).toEqual({ ok: true, attempt: 3 });
		expect(auditMocks.recordAuditTx).toHaveBeenCalledTimes(1);
	});

	it("keeps the retry request on BLOCKED; the re-issue's own write at OPENING is reissue", () => {
		expect(() =>
			pullRequestTransitionWhere("retry", ["OPENING"], "unchanged", 3),
		).toThrow(/Illegal pull-request transition/);
		expect(
			pullRequestTransitionWhere("reissue", ["OPENING"], "unchanged", 3),
		).toEqual({ pullRequestState: "OPENING", pullRequestAttempt: 3 });
	});

	it.each([
		["adopt", "MERGED"],
		["adopt", "CLOSED"],
		["receipt", "MERGED"],
		["receipt", "CLOSED"],
	] as const)(
		"writes both pull_request_opened and pull_request_reconciled for %s to %s",
		async (event, to) => {
			const before = seed("OPENING");
			const record = (actions: string[]) =>
				transitionPullRequest({
					snapshotId: ID,
					organizationId: ORG,
					event,
					from: ["OPENING"],
					expectedAttempt: 3,
					to,
					bumpAttempt: false,
					audit: actions.map(audit),
				});
			await expect(record([OPENED])).rejects.toThrow(/writes exactly/);
			await expect(record([RECONCILED])).rejects.toThrow(
				/writes exactly/,
			);
			expect(current()).toEqual(before);
			expect(await record([RECONCILED, OPENED])).toEqual({
				ok: true,
				attempt: 3,
			});
			expect(
				auditMocks.recordAuditTx.mock.calls.map(
					([, input]) => (input as { action: string }).action,
				),
			).toEqual([RECONCILED, OPENED]);
		},
	);
});

// ---------------------------------------------------------------------------
// Attempt records
// ---------------------------------------------------------------------------

describe("writeAttemptRecord (spec §4.1)", () => {
	const A: PullRequestAttemptRecord = {
		attempt: 1,
		ref: "fabric/instructions/op",
		sha: "a".repeat(40),
		pushIssuedAt: "2026-09-24T10:00:00.000Z",
		confirmations: 0,
	};
	const B: PullRequestAttemptRecord = {
		attempt: 4,
		ref: "fabric/instructions/op-4",
		sha: "a".repeat(40),
		pushIssuedAt: "2026-09-24T11:00:00.000Z",
		pushAckedAt: "2026-09-24T11:00:01.000Z",
		confirmations: 0,
	};

	function write(
		overrides: Partial<Parameters<typeof writeAttemptRecord>[0]>,
	) {
		return writeAttemptRecord({
			snapshotId: ID,
			organizationId: ORG,
			identity: { attempt: 1, ref: A.ref },
			expect: {},
			patch: {},
			...overrides,
		});
	}

	it("finds the record by (attempt, ref), checks the expectation and rewrites only it", async () => {
		seed("OPENING", { pullRequestAttempts: [A, B] });
		expect(
			await write({
				expect: { pushIssuedAt: "set", pushAckedAt: null },
				patch: { pushAckedAt: "2026-09-24T10:00:05.000Z" },
			}),
		).toBe(true);
		const records = current()
			.pullRequestAttempts as PullRequestAttemptRecord[];
		expect(records).toEqual([
			{ ...A, pushAckedAt: "2026-09-24T10:00:05.000Z" },
			B,
		]);
		// The row lock is taken first.
		expect(store.queries[0]).toMatch(/FOR UPDATE/);
	});

	it("refuses when an expectation does not hold, writing nothing", async () => {
		const before = seed("OPENING", { pullRequestAttempts: [A, B] });
		expect(
			await write({
				identity: { attempt: 4, ref: B.ref },
				expect: { pushAckedAt: "set", createIssuedAt: "set" },
				patch: { createIssuedAt: "2026-09-24T11:00:02.000Z" },
			}),
		).toBe(false);
		expect(current()).toEqual(before);
	});

	it("sets the create marker once and keeps the summary columns in step", async () => {
		seed("OPENING", { pullRequestAttempts: [A, B] });
		const marker = {
			identity: { attempt: 4, ref: B.ref },
			expect: { pushAckedAt: "set", createIssuedAt: null } as const,
			patch: { createIssuedAt: "2026-09-24T11:00:02.000Z" },
		};
		expect(await write(marker)).toBe(true);
		expect(await write(marker)).toBe(false);
		const after = current();
		expect(after.pullRequestObligationOpen).toBe(true);
		expect(after.pullRequestConfirmationDueAt).toBeNull();
	});

	it("refuses a record that does not exist", async () => {
		seed("OPENING", { pullRequestAttempts: [A] });
		expect(
			await write({
				identity: { attempt: 2, ref: A.ref },
				patch: { pushAckedAt: "x" },
			}),
		).toBe(false);
		expect(
			await write({
				identity: { attempt: 1, ref: "fabric/instructions/other" },
				patch: { pushAckedAt: "x" },
			}),
		).toBe(false);
	});

	it("appends a record and never edits an earlier one", async () => {
		seed("OPENING", { pullRequestAttempts: [A] });
		expect(
			await write({
				identity: { attempt: 4, ref: B.ref },
				append: true,
				patch: { sha: B.sha, pushIssuedAt: B.pushIssuedAt },
			}),
		).toBe(true);
		expect(current().pullRequestAttempts).toEqual([
			A,
			{
				attempt: 4,
				ref: B.ref,
				sha: B.sha,
				pushIssuedAt: B.pushIssuedAt,
				confirmations: 0,
			},
		]);
		// The same identity again is not a second record.
		expect(
			await write({
				identity: { attempt: 4, ref: B.ref },
				append: true,
				patch: { sha: B.sha },
			}),
		).toBe(false);
		expect(current().pullRequestObligationOpen).toBe(true);
	});

	it("clears only the confirmed record's create marker on its second confirmation", async () => {
		const settledA = {
			...A,
			pushAckedAt: "2026-09-24T10:00:01.000Z",
			createIssuedAt: "2026-09-24T10:00:02.000Z",
			settledAt: "2026-09-23T10:00:00.000Z",
			confirmations: 1,
			outcome: "settled" as const,
		};
		const markedB = { ...B, createIssuedAt: "2026-09-24T11:00:02.000Z" };
		seed("OPEN", { pullRequestAttempts: [settledA, markedB] });
		expect(
			await write({
				identity: { attempt: 1, ref: A.ref },
				expect: { settledAt: "set", confirmations: 1 },
				patch: { confirmations: 2, createIssuedAt: null },
			}),
		).toBe(true);
		const records = current()
			.pullRequestAttempts as PullRequestAttemptRecord[];
		expect(records[0].createIssuedAt).toBeUndefined();
		expect(records[0].confirmations).toBe(2);
		expect(records[1]).toEqual(markedB);
		// B's marker still holds the obligation open.
		expect(current().pullRequestObligationOpen).toBe(true);
		expect(current().pullRequestConfirmationDueAt).toBeNull();
	});

	it("maintains the confirmation clock from settledAt", async () => {
		seed("CLOSE_REQUESTED", {
			pullRequestAttempts: [
				{ ...A, pushAckedAt: "2026-09-24T10:00:01.000Z" },
			],
		});
		expect(
			await write({
				expect: { settledAt: null },
				patch: {
					settledAt: "2026-09-24T12:00:00.000Z",
					confirmations: 0,
					outcome: "settled",
				},
			}),
		).toBe(true);
		expect(current().pullRequestConfirmationDueAt).toEqual(
			new Date("2026-09-24T13:00:00.000Z"),
		);
	});

	it("checks the row's state and attempt when asked", async () => {
		seed("OPENING", { pullRequestAttempts: [A] });
		expect(
			await write({
				row: { states: ["CLOSE_REQUESTED"] },
				patch: { pushAckedAt: "x" },
			}),
		).toBe(false);
		expect(
			await write({ row: { attempt: 2 }, patch: { pushAckedAt: "x" } }),
		).toBe(false);
		expect(
			await write({
				row: { states: ["OPENING"], attempt: 3 },
				patch: { pushAckedAt: "x" },
			}),
		).toBe(true);
	});

	it("never patches a record's identity", async () => {
		seed("OPENING", { pullRequestAttempts: [A] });
		await expect(
			write({ patch: { ref: "fabric/instructions/else" } as never }),
		).rejects.toThrow(/identity/);
	});

	it("refuses another organization's row", async () => {
		const before = seed("OPENING", { pullRequestAttempts: [A] });
		expect(
			await writeAttemptRecord({
				snapshotId: ID,
				organizationId: "org_2",
				identity: { attempt: 1, ref: A.ref },
				expect: {},
				patch: { pushAckedAt: "x" },
			}),
		).toBe(false);
		expect(current()).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// The open claim
// ---------------------------------------------------------------------------

describe("claimPullRequestOpen (spec §4.4, plan Decision 7)", () => {
	const marker: PullRequestAttemptRecord = {
		attempt: 3,
		ref: "fabric/instructions/op",
		sha: "a".repeat(40),
		pushIssuedAt: "2026-09-24T10:00:00.000Z",
		pushAckedAt: "2026-09-24T10:00:01.000Z",
		createIssuedAt: "2026-09-24T10:00:02.000Z",
		confirmations: 0,
	};
	const future = new Date(store.now.getTime() + 10 * MIN);
	const past = new Date(store.now.getTime() - 10 * MIN);

	function claim(
		expectedAttempt = 3,
		retryCreate?: { expectedAttempt: number },
	) {
		return claimPullRequestOpen({
			snapshotId: ID,
			organizationId: ORG,
			expectedAttempt,
			...(retryCreate ? { retryCreate } : {}),
		});
	}

	it.each([
		["QUEUED", {}],
		["OPENING", {}],
		[
			"BLOCKED",
			{ pullRequestFailure: PREPARE, pullRequestNextAttemptAt: past },
		],
		[
			"BLOCKED",
			{ pullRequestFailure: PREPARE, pullRequestNextAttemptAt: null },
		],
	] as const)("claims %s at the observed attempt", async (state, extra) => {
		seed(state, extra);
		expect(await claim()).toEqual({ kind: "claimed", attempt: 4 });
		const after = current();
		expect(after.pullRequestState).toBe("OPENING");
		expect(after.proposalStatus).toBe("PENDING");
		expect(after.pullRequestAttempt).toBe(4);
	});

	it.each([
		["OPEN", "open"],
		["CLOSE_REQUESTED", "close_requested"],
		["MERGED", "terminal"],
		["CLOSED", "terminal"],
		["CANCELED", "terminal"],
	] as const)(
		"answers %s with %s and writes nothing",
		async (state, kind) => {
			const before = seed(state);
			expect(await claim()).toEqual({ kind });
			expect(current()).toEqual(before);
		},
	);

	it("refuses a stale observation", async () => {
		const before = seed("QUEUED");
		expect(await claim(2)).toEqual({ kind: "not_claimable" });
		expect(current()).toEqual(before);
	});

	it("waits for a retryable BLOCKED row's backoff by the database clock", async () => {
		seed("BLOCKED", {
			pullRequestFailure: PREPARE,
			pullRequestNextAttemptAt: future,
		});
		expect(await claim()).toEqual({ kind: "not_claimable" });
		// The due test is SQL `now()`, never a worker timestamp.
		const sql = store.queries.find((q) => q.includes("now()")) ?? "";
		expect(sql).toContain(
			`"pullRequestNextAttemptAt" <= (now() AT TIME ZONE 'UTC')`,
		);
	});

	it("refuses a non-retryable BLOCKED row to an ordinary claim", async () => {
		seed("BLOCKED", { pullRequestFailure: CREATE_UNKNOWN_FINAL });
		expect(await claim()).toEqual({ kind: "not_claimable" });
	});

	it("claims a row with a create marker only through retryCreate", async () => {
		seed("OPENING", { pullRequestAttempts: [marker] });
		expect(await claim()).toEqual({ kind: "not_claimable" });
		seed("BLOCKED", {
			pullRequestAttempts: [marker],
			pullRequestFailure: CREATE_UNKNOWN_FINAL,
		});
		expect(await claim(3, { expectedAttempt: 3 })).toEqual({
			kind: "claimed",
			attempt: 4,
		});
	});

	it("lets a settled marker's row be claimed again", async () => {
		seed("QUEUED", {
			pullRequestAttempts: [
				{ ...marker, settledAt: "2026-09-24T11:00:00.000Z" },
			],
		});
		expect(await claim()).toEqual({ kind: "claimed", attempt: 4 });
	});

	it("lets a human retry at the current attempt ignore the backoff", async () => {
		seed("BLOCKED", {
			pullRequestFailure: CREATE_UNKNOWN_FINAL,
			pullRequestNextAttemptAt: future,
		});
		expect(await claim(3, { expectedAttempt: 3 })).toEqual({
			kind: "claimed",
			attempt: 4,
		});
	});

	it("refuses a human retry naming another attempt, or a row that is not BLOCKED", async () => {
		seed("BLOCKED", { pullRequestFailure: CREATE_UNKNOWN_FINAL });
		expect(await claim(3, { expectedAttempt: 2 })).toEqual({
			kind: "not_claimable",
		});
		seed("QUEUED");
		expect(await claim(3, { expectedAttempt: 3 })).toEqual({
			kind: "not_claimable",
		});
	});

	it("refuses a missing row, another organization's row and a FABRIC row", async () => {
		expect(await claim()).toEqual({ kind: "not_claimable" });
		seed("QUEUED", { organizationId: "org_2" });
		expect(await claim()).toEqual({ kind: "not_claimable" });
		seed(null);
		expect(await claim()).toEqual({ kind: "not_claimable" });
	});
});

// ---------------------------------------------------------------------------
// The sweeper's selection (spec §9, §9.1)
// ---------------------------------------------------------------------------

describe("selectDueProposalOperations (spec §9)", () => {
	const LIMITS = {
		close: 11,
		recover: 12,
		mergeSync: 13,
		observe: 21,
		restart: 14,
	};
	const DUE =
		'(s."pullRequestNextAttemptAt" IS NULL OR s."pullRequestNextAttemptAt" <= (now() AT TIME ZONE \'UTC\'))';
	const BY_NEXT_ATTEMPT =
		'ORDER BY s."pullRequestNextAttemptAt" ASC NULLS FIRST, s."id" ASC';

	function statement(batch: string) {
		const found = store.selections.find((q) => q.batch === batch);
		if (!found) {
			throw new Error(`no ${batch} statement`);
		}
		return found;
	}

	function item(id: string, extra: Record<string, unknown> = {}) {
		return {
			snapshotId: id,
			projectId: `p_${id}`,
			organizationId: ORG,
			operationId: `op_${id}`,
			attempt: 2,
			integrationId: "int_1",
			...extra,
		};
	}

	it("runs the five sub-batches in the table's order, Close first, in one read", async () => {
		await selectDueProposalOperations(LIMITS);

		expect(store.selections.map((q) => q.batch)).toEqual([
			"close",
			"recover",
			"merge_sync",
			"observe",
			"restart",
		]);
		// One transaction, so the five statements read one snapshot.
		expect(store.transactionOptions).toEqual([
			{ isolationLevel: "RepeatableRead" },
		]);
	});

	it("binds every limit and no JavaScript Date: every due test is the database clock", async () => {
		await selectDueProposalOperations(LIMITS);

		for (const [batch, limit] of [
			["close", LIMITS.close],
			["recover", LIMITS.recover],
			["merge_sync", LIMITS.mergeSync],
			["observe", LIMITS.observe],
			["restart", LIMITS.restart],
		] as const) {
			const q = statement(batch);
			expect(q.values.at(-1)).toBe(limit);
			expect(q.sql).toMatch(/LIMIT \?$/);
			expect(q.sql).not.toContain(String(limit));
			for (const value of q.values) {
				expect(value).not.toBeInstanceOf(Date);
			}
		}
	});

	it("requires the row to be due on every sub-batch, except a due confirmation", async () => {
		await selectDueProposalOperations(LIMITS);

		for (const batch of [
			"close",
			"recover",
			"merge_sync",
			"observe",
			"restart",
		]) {
			expect(statement(batch).sql).toContain(DUE);
		}
		// A confirmation is selected on its record's clock alone, in any state.
		expect(statement("close").sql).toContain(
			`((s."pullRequestState" = 'CLOSE_REQUESTED' AND ${DUE}) OR s."pullRequestConfirmationDueAt" <= (now() AT TIME ZONE 'UTC'))`,
		);
	});

	it("orders by the next attempt, except Observe, which is fair by last check", async () => {
		await selectDueProposalOperations(LIMITS);

		for (const batch of ["close", "recover", "merge_sync", "restart"]) {
			expect(statement(batch).sql).toContain(BY_NEXT_ATTEMPT);
		}
		const observe = statement("observe").sql;
		expect(observe).toContain(
			'ORDER BY s."pullRequestLastCheckedAt" ASC NULLS FIRST, s."id" ASC',
		);
		expect(observe).toContain(`s."pullRequestState" = 'OPEN'`);
		expect(observe).toContain(
			`(s."pullRequestLastCheckedAt" IS NULL OR s."pullRequestLastCheckedAt" <= (now() AT TIME ZONE 'UTC') - interval '10 minutes')`,
		);
	});

	it("recovers an unsettled record with a marker or an issued, unacknowledged push (1), or an acknowledged current record never created (2)", async () => {
		await selectDueProposalOperations(LIMITS);

		const recover = statement("recover").sql;
		// Clause (1)'s push arm needs the push to have been issued: a record
		// a branch-write refusal returned to not issued is Restart's.
		expect(recover).toContain(
			`EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") r WHERE r->>'settledAt' IS NULL AND (r->>'createIssuedAt' IS NOT NULL OR (r->>'pushIssuedAt' IS NOT NULL AND r->>'pushAckedAt' IS NULL AND r->>'outcome' IS NULL)))`,
		);
		// Clause (1) only in a state that is not terminal.
		expect(recover).toContain(
			`s."pullRequestState" IN ('QUEUED', 'OPENING', 'OPEN', 'CLOSE_REQUESTED', 'BLOCKED')`,
		);
		// Clause (2).
		expect(recover).toContain(
			`(s."pullRequestExternalId" IS NULL AND (s."pullRequestState" IN ('QUEUED', 'OPENING') OR (s."pullRequestState" = 'BLOCKED' AND (s."pullRequestFailure"->>'retryable') = 'true')) AND NOT EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") m WHERE m->>'createIssuedAt' IS NOT NULL AND m->>'settledAt' IS NULL) AND EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") c WHERE c->>'ref' = s."pullRequestRef" AND c->>'pushAckedAt' IS NOT NULL))`,
		);
		expect(recover).toContain('AS "recoverClause"');
	});

	it("restarts only QUEUED, OPENING or retryable BLOCKED rows with no marker, created over 2 minutes ago", async () => {
		await selectDueProposalOperations(LIMITS);

		const restart = statement("restart").sql;
		expect(restart).toContain(
			`(s."pullRequestState" IN ('QUEUED', 'OPENING') OR (s."pullRequestState" = 'BLOCKED' AND (s."pullRequestFailure"->>'retryable') = 'true'))`,
		);
		expect(restart).toContain(
			// Only an UNSETTLED marker is outstanding: a human retry's settled
			// old record must not keep the row from Restart for a day.
			`NOT EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") m WHERE m->>'createIssuedAt' IS NOT NULL AND m->>'settledAt' IS NULL)`,
		);
		expect(restart).toContain(
			`s."createdAt" <= (now() AT TIME ZONE 'UTC') - interval '2 minutes'`,
		);
		expect(statement("merge_sync").sql).toContain(
			's."mergeSyncRequestedAt" IS NOT NULL',
		);
	});

	it("excludes an id an earlier sub-batch took, and maps the rows it returns", async () => {
		store.selectionRows = {
			close: [item("a")],
			recover: [item("b", { recoverClause: 2 })],
			observe: [item("c")],
		};

		const due = await selectDueProposalOperations(LIMITS);

		const taken = (batch: string) =>
			statement(batch).values.find(Array.isArray) as string[];
		expect(taken("close")).toEqual([]);
		expect(taken("recover")).toEqual(["a"]);
		expect(taken("merge_sync")).toEqual(["a", "b"]);
		expect(taken("observe")).toEqual(["a", "b"]);
		expect(taken("restart")).toEqual(["a", "b", "c"]);
		for (const batch of [
			"close",
			"recover",
			"merge_sync",
			"observe",
			"restart",
		]) {
			expect(statement(batch).sql).toContain('s."id" <> ALL(?::text[])');
		}
		expect(due).toEqual({
			close: [item("a")],
			recover: [item("b", { recoverClause: 2 })],
			mergeSync: [],
			observe: [item("c")],
			restart: [],
		});
	});
});

describe("selectDueProposalOperations: Close takes an abandoned acknowledged push", () => {
	const DUE =
		'(s."pullRequestNextAttemptAt" IS NULL OR s."pullRequestNextAttemptAt" <= (now() AT TIME ZONE \'UTC\'))';
	const closeSql = async () => {
		await selectDueProposalOperations({
			close: 1,
			recover: 1,
			mergeSync: 1,
			observe: 1,
			restart: 1,
		});
		const found = store.selections.find((q) => q.batch === "close");
		if (!found) {
			throw new Error("no close statement");
		}
		return found.sql;
	};

	it("selects a due non-retryable BLOCKED row whose current record is acknowledged and never created, settled or given an outcome", async () => {
		expect(await closeSql()).toContain(
			`OR ((s."pullRequestState" = 'BLOCKED' AND (s."pullRequestFailure"->>'retryable') = 'false' AND s."pullRequestExternalId" IS NULL AND NOT EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") m WHERE m->>'createIssuedAt' IS NOT NULL AND m->>'settledAt' IS NULL) AND EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") c WHERE c->>'ref' = s."pullRequestRef" AND c->>'pushAckedAt' IS NOT NULL AND c->>'settledAt' IS NULL AND c->>'createIssuedAt' IS NULL AND c->>'outcome' IS NULL)) AND ${DUE})`,
		);
	});
});

describe("deferProposalOperation (spec §9)", () => {
	it("pushes the next attempt out on the database clock, fenced on the attempt read at selection", async () => {
		expect(
			await deferProposalOperation({
				snapshotId: ID,
				organizationId: ORG,
				attempt: 4,
				minutes: 30,
			}),
		).toBe(true);

		const [q] = store.executes;
		expect(q!.sql).toContain(
			`SET "pullRequestNextAttemptAt" = (now() AT TIME ZONE 'UTC') + make_interval(mins => ?::int)`,
		);
		expect(q!.sql).toContain(
			'WHERE "id" = ? AND "organizationId" = ? AND "pullRequestAttempt" = ?',
		);
		expect(q!.values).toEqual([30, ID, ORG, 4]);
	});

	it("reports false when another actor moved the attempt first", async () => {
		store.executeCount = 0;
		expect(
			await deferProposalOperation({
				snapshotId: ID,
				organizationId: ORG,
				attempt: 4,
				minutes: 30,
			}),
		).toBe(false);
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

describe("clearMergeSyncRequest (spec §9.1 steps 2 and 5)", () => {
	const EXPECTED = { syncId: "sync_1", generation: 3 };
	const MERGE_SYNC = "project.instructions.pull_request_merge_sync_requested";
	const GIVE_UP = {
		phase: "merge_sync" as const,
		code: "MERGE_SYNC_FAILED" as const,
		retryable: false as const,
		at: "2026-09-25T09:00:00.000Z",
		params: {},
	};

	function mergedRow(overrides: Partial<Row> = {}) {
		return seed("MERGED", {
			mergeSyncRequestedAt: new Date("2026-09-24T09:00:00.000Z"),
			mergeSyncDispatchedAt: new Date("2026-09-24T09:05:00.000Z"),
			mergeSyncRunId: "run_1",
			mergeSyncExpected: EXPECTED,
			...overrides,
		});
	}

	const acknowledge = (overrides: Record<string, unknown> = {}) =>
		clearMergeSyncRequest({
			kind: "acknowledged",
			snapshotId: ID,
			organizationId: ORG,
			expected: EXPECTED,
			audit: audit(MERGE_SYNC),
			...overrides,
		} as Parameters<typeof clearMergeSyncRequest>[0]);

	const giveUp = (overrides: Record<string, unknown> = {}) =>
		clearMergeSyncRequest({
			kind: "gave_up",
			snapshotId: ID,
			organizationId: ORG,
			expected: EXPECTED,
			failure: GIVE_UP,
			...overrides,
		} as Parameters<typeof clearMergeSyncRequest>[0]);

	it("acknowledgment clears both markers, keeps the run id and writes its one audit row", async () => {
		mergedRow();

		expect(await acknowledge()).toBe(true);
		expect(current()).toMatchObject({
			pullRequestState: "MERGED",
			mergeSyncRequestedAt: null,
			mergeSyncDispatchedAt: null,
			mergeSyncRunId: "run_1",
			pullRequestFailure: null,
		});
		expect(auditMocks.recordAuditTx).toHaveBeenCalledTimes(1);
		expect(auditMocks.recordAuditTx.mock.calls[0]?.[1]).toMatchObject({
			action: MERGE_SYNC,
		});
	});

	it("give-up writes a non-retryable failure, drops the run id and writes no audit row; the state stays MERGED", async () => {
		mergedRow();

		expect(await giveUp()).toBe(true);
		expect(current()).toMatchObject({
			pullRequestState: "MERGED",
			proposalStatus: "MERGED",
			mergeSyncRequestedAt: null,
			mergeSyncDispatchedAt: null,
			mergeSyncRunId: null,
			pullRequestFailure: GIVE_UP,
			pullRequestNextAttemptAt: null,
		});
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("fails, writing nothing, when mergeSyncExpected changed since it was compared", async () => {
		const before = mergedRow({
			mergeSyncExpected: { syncId: "sync_1", generation: 4 },
		});

		expect(await acknowledge()).toBe(false);
		expect(await giveUp()).toBe(false);
		expect(current()).toEqual(before);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("gives up on a request that was never dispatched when expected is null", async () => {
		mergedRow({ mergeSyncExpected: null, mergeSyncDispatchedAt: null });

		expect(
			await giveUp({
				expected: null,
				failure: { ...GIVE_UP, code: "CONFIGURATION_CHANGED" },
			}),
		).toBe(true);
		expect(current().mergeSyncRequestedAt).toBeNull();
	});

	it("never touches a row that is not MERGED, or one with no request", async () => {
		const open = seed("OPEN", {
			mergeSyncRequestedAt: new Date("2026-09-24T09:00:00.000Z"),
			mergeSyncExpected: EXPECTED,
		});
		expect(await acknowledge()).toBe(false);
		expect(current()).toEqual(open);
		const idle = mergedRow({ mergeSyncRequestedAt: null });
		expect(await giveUp()).toBe(false);
		expect(current()).toEqual(idle);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it.each([
		["no audit row", { audit: undefined }],
		["another action", { audit: audit(RECONCILED) }],
		["the action twice", { audit: [audit(MERGE_SYNC), audit(MERGE_SYNC)] }],
	])(
		"refuses an acknowledgment with %s, writing nothing",
		async (_, overrides) => {
			const before = mergedRow();
			await expect(acknowledge(overrides)).rejects.toThrow(
				/writes exactly/,
			);
			expect(current()).toEqual(before);
			expect(store.txClients).toEqual([]);
		},
	);

	it("refuses an acknowledgment that names no tuple or carries a failure", async () => {
		const before = mergedRow();
		await expect(acknowledge({ expected: null })).rejects.toThrow(
			/acknowledgment names the receipt's/,
		);
		await expect(acknowledge({ failure: GIVE_UP })).rejects.toThrow(
			/acknowledgment writes no failure/,
		);
		expect(current()).toEqual(before);
	});

	it.each([
		["a retryable failure", { failure: { ...GIVE_UP, retryable: true } }],
		[
			"a failure outside merge_sync",
			{ failure: { ...GIVE_UP, phase: "close" } },
		],
		["no failure", { failure: undefined }],
	])("refuses a give-up with %s, writing nothing", async (_, overrides) => {
		const before = mergedRow();
		await expect(giveUp(overrides)).rejects.toThrow(
			/non-retryable merge_sync failure/,
		);
		expect(current()).toEqual(before);
		expect(store.txClients).toEqual([]);
	});

	it("refuses a give-up that carries the acknowledgment audit row", async () => {
		const before = mergedRow();
		await expect(giveUp({ audit: audit(MERGE_SYNC) })).rejects.toThrow(
			/writes exactly \[\], not/,
		);
		expect(current()).toEqual(before);
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});
});
