/**
 * The proposal activities the member proposal branches still share with
 * #2563 (Fizzy #2563 spec §6 step 1, §11): readiness and the activity
 * boundary it runs under, and the retired #2563 operation lane's registered
 * stubs (Fizzy #2748). #2563's per-proposal open, close, recover,
 * reconcile, merge-sync and restart activities were retired with that path;
 * the member proposal branch activities have their own suites
 * (instruction-branch-*.test.ts).
 *
 * The database is an in-memory model of the transition primitive (its
 * fences and conditional writes are pinned against real Postgres in
 * packages/database). Every identifier is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);
const OP = `op${"0".repeat(21)}1`;
const BRANCH = `fabric/instructions/${OP}`;
const EMAIL = ["user", "example.com"].join("@");
const NOW = new Date("2026-09-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const m = vi.hoisted(() => {
	class CancelledFailure extends Error {
		constructor(message = "cancelled") {
			super(message);
			this.name = "CancelledFailure";
		}
	}
	return {
		CancelledFailure,
		state: {
			row: null as Record<string, unknown> | null,
			clock: new Date(0),
			audits: [] as Array<{ action: string; metadata?: unknown }>,
			transitions: [] as Array<Record<string, unknown>>,
			activity: null as {
				cancellationSignal: AbortSignal;
				info?: {
					startToCloseTimeoutMs: number;
					scheduleToCloseTimeoutMs: number;
					scheduledTimestampMs: number;
					currentAttemptScheduledTimestampMs: number;
					heartbeatTimeoutMs?: number;
				};
			} | null,
		},
		heartbeat: vi.fn(),
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
});

// ---------------------------------------------------------------------------
// The in-memory database (Task 5 semantics)
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => structuredClone(v);
const rowOf = () => m.state.row as Record<string, unknown>;

const STATUS: Record<string, string> = {
	QUEUED: "PENDING",
	OPENING: "PENDING",
	OPEN: "PENDING",
	CLOSE_REQUESTED: "PENDING",
	BLOCKED: "PENDING",
	MERGED: "MERGED",
	CLOSED: "CLOSED",
	CANCELED: "REJECTED",
};

function transition(i: {
	event: string;
	from: string[];
	expectedAttempt: number | null;
	to: string;
	bumpAttempt: boolean;
	data?: Record<string, unknown>;
	audit?: unknown;
}): { ok: true; attempt: number } | { ok: false } {
	const row = rowOf();
	m.state.transitions.push({
		event: i.event,
		from: i.from,
		to: i.to,
		expectedAttempt: i.expectedAttempt,
	});
	if (!i.from.includes(row.pullRequestState as string)) {
		return { ok: false };
	}
	if (
		i.expectedAttempt !== null &&
		row.pullRequestAttempt !== i.expectedAttempt
	) {
		return { ok: false };
	}
	Object.assign(row, clone(i.data ?? {}));
	if (i.to !== "unchanged") {
		row.pullRequestState = i.to;
		row.proposalStatus = STATUS[i.to];
	}
	if (i.bumpAttempt) {
		row.pullRequestAttempt = (row.pullRequestAttempt as number) + 1;
	}
	const audits =
		i.audit === undefined
			? []
			: Array.isArray(i.audit)
				? i.audit
				: [i.audit];
	m.state.audits.push(...(audits as Array<{ action: string }>));
	return { ok: true, attempt: row.pullRequestAttempt as number };
}

vi.mock("@repo/database", () => ({
	getProposalOperation: vi.fn(
		async (i: {
			snapshotId: string;
			projectId: string;
			organizationId: string;
		}) => {
			const row = m.state.row;
			if (
				!row ||
				row.id !== i.snapshotId ||
				row.projectId !== i.projectId ||
				row.organizationId !== i.organizationId
			) {
				return null;
			}
			return { ...clone(row), databaseNow: new Date(m.state.clock) };
		},
	),
	transitionPullRequest: vi.fn(async (i: Parameters<typeof transition>[0]) =>
		transition(i),
	),
	nextRetryDelayMs: (
		code: string,
		ctx: {
			retryAfterSeconds?: number;
			markerAgeMs?: number;
			recoveries?: number;
		},
	) => {
		const table: Record<string, number | null> = {
			VALIDATION_TIMEOUT: HOUR,
			REMOTE_REF_CONFLICT: 6 * HOUR,
			AUTHENTICATION_FAILED: 6 * HOUR,
			CLOSE_CREDENTIALS_UNAVAILABLE: 6 * HOUR,
			BRANCH_WRITE_REFUSED: 6 * HOUR,
			PERMISSION_REVOKED: null,
			CONFIGURATION_CHANGED: null,
			PR_CREATION_REFUSED: null,
		};
		if (code === "CREATE_OUTCOME_UNKNOWN") {
			if ((ctx.markerAgeMs ?? 0) >= 24 * HOUR) {
				return null;
			}
			return [1, 5, 15, 60][Math.min(ctx.recoveries ?? 0, 3)] * 60_000;
		}
		if (code === "PROVIDER_RATE_LIMITED") {
			return (ctx.retryAfterSeconds ?? 900) * 1000;
		}
		return code in table ? table[code] : 15 * 60_000;
	},
}));
// Nothing below is reached by readiness or the retired stubs; each is
// mocked so importing the activities module loads no provider, storage,
// Temporal client or billing code.
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: vi.fn(),
	forceReExchangeRepoCredentials: vi.fn(),
	markRepoReauthRequired: vi.fn(),
	REPO_REAUTH_STEP_BOUND_MS: 20_000,
	isGitAuthError: () => false,
}));
vi.mock(
	"@repo/integrations/instruction-pull-requests",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@repo/integrations/instruction-pull-requests")
		>()),
		adapterFor: vi.fn(),
	}),
);
vi.mock("@repo/storage", () => ({ getStorageProvider: vi.fn() }));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("../src/client", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../src/activities/lib/instruction-sync-start", () => ({
	startAutomaticInstructionSync: vi.fn(),
}));
vi.mock("../src/activities/lib/instruction-sync-temp", () => ({
	createSyncRunDir: vi.fn(),
	removeSyncRunDir: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: m.log }));
vi.mock("@temporalio/activity", async (importOriginal) => ({
	// Real: the failure the retired lane's stubs throw.
	ApplicationFailure: (
		await importOriginal<typeof import("@temporalio/activity")>()
	).ApplicationFailure,
	heartbeat: m.heartbeat,
	CancelledFailure: m.CancelledFailure,
	Context: {
		current: () => {
			if (!m.state.activity) {
				throw new Error("not in an activity");
			}
			return m.state.activity;
		},
	},
}));

import { getProposalOperation } from "@repo/database";
import {
	checkInstructionProposalReadiness,
	closeInstructionProposalPullRequest,
	deferInstructionProposalOperation,
	dispatchInstructionProposalMergeSync,
	dispatchInstructionProposalPullRequest,
	reconcileInstructionProposalPullRequest,
	recoverInstructionProposalPullRequest,
	selectDueInstructionProposalOperations,
} from "../src/activities/instruction-proposal-pull-requests";
import {
	activityCancellationSignal,
	ProposalDeadlineExceeded,
	withProposalDeadline,
} from "../src/activities/lib/instruction-proposal-boundary";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPOSITORIES = {
	GITHUB: { provider: "GITHUB", owner: "example-org", repo: "example-repo" },
	GITLAB: { provider: "GITLAB", projectPath: "example-org/example-repo" },
	AZURE_DEVOPS: {
		provider: "AZURE_DEVOPS",
		apiOrigin: "https://dev.azure.com",
		organization: "example-org",
		project: "Example Project",
		repository: "example-repo",
	},
} as const;
type Provider = keyof typeof REPOSITORIES;

function contextFor(provider: Provider = "GITHUB") {
	return {
		v: 1,
		integrationId: "int_1",
		syncId: "sync_1",
		syncGeneration: 3,
		provider,
		targetRef: "main",
		rootPath: "",
		baseCommitSha: BASE,
		repository: REPOSITORIES[provider],
		branch: BRANCH,
		author: { name: "Example User", email: EMAIL },
		committer: { name: "Example User", email: EMAIL },
		title: "Update the review rules",
		body: "Proposed in Fabric.",
		message: "Update the review rules\n\nProposed in Fabric.",
		committedAt: "2026-09-24T11:00:00Z",
	};
}

function seed(
	over: Record<string, unknown> = {},
	provider: Provider = "GITHUB",
) {
	m.state.row = {
		id: "snap_1",
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "user_1",
		version: 7,
		status: "READY",
		proposalStatus: "PENDING",
		proposalDestination: "REPOSITORY",
		baseSnapshotId: "snap_0",
		createdAt: new Date(NOW.getTime() - HOUR),
		pullRequestOperationId: OP,
		pullRequestState: "QUEUED",
		pullRequestAttempt: 0,
		pullRequestContext: contextFor(provider),
		pullRequestHeadSha: null,
		pullRequestRef: null,
		pullRequestAttempts: [],
		pullRequestUrl: null,
		pullRequestExternalId: null,
		pullRequestObservation: null,
		pullRequestFailure: null,
		pullRequestLastCheckedAt: null,
		pullRequestNextAttemptAt: null,
		mergeSyncRequestedAt: null,
		mergeSyncDispatchedAt: null,
		mergeSyncRunId: null,
		mergeSyncExpected: null,
		...over,
	};
}

const ids = {
	snapshotId: "snap_1",
	projectId: "proj_1",
	organizationId: "org_1",
	operationId: OP,
};
const row = () => rowOf();
const failure = () =>
	row().pullRequestFailure as {
		code: string;
		phase: string;
		retryable: boolean;
		params: Record<string, unknown>;
	} | null;

beforeEach(() => {
	vi.clearAllMocks();
	for (const value of [...Object.values(m), ...Object.values(m.log)]) {
		if (vi.isMockFunction(value)) {
			value.mockReset();
		}
	}
	m.state.clock = new Date(NOW);
	m.state.audits = [];
	m.state.transitions = [];
	m.state.activity = null;
	seed();
});

const readiness = (over: Record<string, unknown> = {}) =>
	checkInstructionProposalReadiness({ ...ids, ...over });

// ---------------------------------------------------------------------------
// Readiness (spec §6 step 1)
// ---------------------------------------------------------------------------

describe("checkInstructionProposalReadiness", () => {
	it("answers ready with the attempt read beside the READY verdict", async () => {
		seed({ pullRequestAttempt: 4, pullRequestState: "BLOCKED" });
		expect(await readiness()).toEqual({ kind: "ready", attempt: 4 });
	});

	it.each([
		["RECEIVING", false],
		["VALIDATING", false],
		["FAILED", true],
	])("answers pending for %s", async (status, validationFailed) => {
		seed({ status });
		expect(await readiness()).toEqual({
			kind: "pending",
			validationFailed,
		});
	});

	it("records VALIDATION_FAILED once, keeping QUEUED, and READY clears it", async () => {
		seed({ status: "FAILED" });
		await readiness();
		expect(row().pullRequestState).toBe("QUEUED");
		expect(failure()).toMatchObject({
			code: "VALIDATION_FAILED",
			phase: "validation",
			retryable: true,
		});
		await readiness();
		expect(
			m.state.transitions.filter((t) => t.event === "validation_failed"),
		).toHaveLength(1);
		row().status = "READY";
		expect(await readiness()).toEqual({ kind: "ready", attempt: 0 });
		expect(failure()).toBeNull();
	});

	it.each([
		["REJECTED snapshot", { status: "REJECTED" }],
		[
			"another operation",
			{ pullRequestOperationId: `op${"0".repeat(21)}2` },
		],
		["a FABRIC proposal", { proposalDestination: "FABRIC" }],
		["an OPEN row", { pullRequestState: "OPEN" }],
		["a CLOSE_REQUESTED row", { pullRequestState: "CLOSE_REQUESTED" }],
		["a CANCELED row", { pullRequestState: "CANCELED" }],
		["a MERGED row", { pullRequestState: "MERGED" }],
		["a decided proposal", { proposalStatus: "REJECTED" }],
	])("stops for %s", async (_label, over) => {
		seed(over);
		expect(await readiness()).toEqual({ kind: "stop" });
	});

	it("stops for a missing row", async () => {
		m.state.row = null;
		expect(await readiness()).toEqual({ kind: "stop" });
	});

	// A REJECTED snapshot left pre-create (its verdict's cancel never ran)
	// is selected by the sweeper's Restart sub-batch on every tick; the stop
	// must settle it, or the workflow is started for it forever.
	it("cancels a QUEUED operation on a REJECTED snapshot, and a second call writes nothing", async () => {
		seed({
			status: "REJECTED",
			proposalStatus: "REJECTED",
			rejection: [{ path: "a.md", reason: "secret" }],
		});
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(row()).toMatchObject({
			pullRequestState: "CANCELED",
			proposalStatus: "REJECTED",
			pullRequestAttempt: 1,
			pullRequestNextAttemptAt: null,
		});
		expect(failure()).toMatchObject({
			code: "VALIDATION_REJECTED",
			phase: "validation",
			retryable: false,
			params: {},
		});
		expect(m.state.transitions).toEqual([
			expect.objectContaining({
				event: "validation_rejected",
				from: ["QUEUED"],
				to: "CANCELED",
				expectedAttempt: 0,
			}),
		]);
		expect(m.state.audits).toEqual([
			expect.objectContaining({
				action: "project.instructions.pull_request_reconciled",
				metadata: expect.objectContaining({
					outcome: "canceled",
					code: "VALIDATION_REJECTED",
					operationId: OP,
				}),
			}),
		]);

		expect(await readiness()).toEqual({ kind: "stop" });
		expect(m.state.transitions).toHaveLength(1);
		expect(m.state.audits).toHaveLength(1);
		expect(row().pullRequestAttempt).toBe(1);
	});

	it("cancels an abandoned upload's operation as abandonment", async () => {
		seed({
			status: "REJECTED",
			rejection: [
				{
					path: "(upload)",
					reason: "abandoned",
					detail: "staging cleared",
				},
			],
		});
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(row().pullRequestState).toBe("CANCELED");
		expect(m.state.transitions).toEqual([
			expect.objectContaining({ event: "abandoned", to: "CANCELED" }),
		]);
		expect(failure()).toMatchObject({
			code: "VALIDATION_REJECTED",
			params: { reason: "abandoned" },
		});
	});

	it("cancels a BLOCKED validation-timeout operation whose snapshot was then REJECTED", async () => {
		seed({
			status: "REJECTED",
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 2,
			pullRequestFailure: {
				code: "VALIDATION_TIMEOUT",
				phase: "validation",
				retryable: true,
				params: {},
			},
		});
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(row()).toMatchObject({
			pullRequestState: "CANCELED",
			pullRequestAttempt: 3,
		});
	});

	it.each([
		["a head SHA", { pullRequestHeadSha: HEAD }],
		[
			"an issued push",
			{
				pullRequestState: "OPENING",
				pullRequestAttempts: [
					{
						attempt: 1,
						ref: BRANCH,
						sha: HEAD,
						pushIssuedAt: NOW.toISOString(),
						confirmations: 0,
					},
				],
			},
		],
		[
			"an issued create",
			{
				pullRequestState: "OPENING",
				pullRequestAttempts: [
					{
						attempt: 1,
						ref: BRANCH,
						sha: HEAD,
						createIssuedAt: NOW.toISOString(),
						confirmations: 0,
					},
				],
			},
		],
	])(
		"leaves a REJECTED snapshot's operation with %s to settlement",
		async (_label, over) => {
			seed({ status: "REJECTED", ...over });
			expect(await readiness()).toEqual({ kind: "stop" });
			expect(m.state.transitions).toEqual([]);
			expect(m.state.audits).toEqual([]);
		},
	);

	it("writes nothing for a READY snapshot whose proposal is decided", async () => {
		seed({ proposalStatus: "REJECTED" });
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(m.state.transitions).toEqual([]);
		expect(row().pullRequestState).toBe("QUEUED");
	});

	it("writes BLOCKED VALIDATION_TIMEOUT at the 6 h deadline and stops", async () => {
		seed({ status: "VALIDATING" });
		expect(await readiness({ deadlineReached: true })).toEqual({
			kind: "stop",
		});
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(failure()).toMatchObject({
			code: "VALIDATION_TIMEOUT",
			retryable: true,
		});
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + HOUR),
		);
	});
});

// ---------------------------------------------------------------------------
// The activity boundary and its cooperative deadline (spec §6), which every
// readiness and member proposal branch activity runs under
// ---------------------------------------------------------------------------

describe("the activity boundary", () => {
	it("maps an unclassified error to UNEXPECTED with params { phase }, failure-only, and logs only the class name", async () => {
		vi.mocked(getProposalOperation).mockRejectedValueOnce(
			new Error("secret text"),
		);
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(row().pullRequestState).toBe("QUEUED");
		expect(failure()).toMatchObject({
			code: "UNEXPECTED",
			phase: "validation",
			retryable: true,
			params: { phase: "validation" },
		});
		expect(m.state.transitions).toEqual([
			{
				event: "failure",
				from: ["QUEUED"],
				to: "unchanged",
				expectedAttempt: 0,
			},
		]);
		const logged = JSON.stringify([
			m.log.warn.mock.calls,
			m.log.info.mock.calls,
			m.log.debug.mock.calls,
			m.log.error.mock.calls,
		]);
		expect(logged).toContain('"errorClass":"Error"');
		expect(logged).not.toContain("secret text");
		expect(JSON.stringify(row())).not.toContain("secret text");
	});

	it("rethrows a CancelledFailure and records nothing", async () => {
		vi.mocked(getProposalOperation).mockRejectedValueOnce(
			new m.CancelledFailure(),
		);
		await expect(readiness()).rejects.toBeInstanceOf(m.CancelledFailure);
		expect(row().pullRequestFailure).toBeNull();
		expect(m.state.transitions).toEqual([]);
	});

	it("an attempt already past its deadline issues nothing and records nothing", async () => {
		await expect(
			readiness({
				deadlineAt: new Date(Date.now() - 1_000).toISOString(),
			}),
		).rejects.toBeInstanceOf(ProposalDeadlineExceeded);
		expect(getProposalOperation).not.toHaveBeenCalled();
		expect(m.state.transitions).toEqual([]);
		expect(row().pullRequestFailure).toBeNull();
	});
});

describe("the cooperative deadline", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	beforeEach(() => {
		vi.useFakeTimers({
			now: NOW,
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
	});

	/** Runs inside a Temporal activity with these timeouts (ms). */
	function inActivity(
		info: Partial<{
			startToCloseTimeoutMs: number;
			scheduleToCloseTimeoutMs: number;
			scheduledTimestampMs: number;
			currentAttemptScheduledTimestampMs: number;
			heartbeatTimeoutMs: number;
		}> = {},
	): void {
		m.state.activity = {
			cancellationSignal: new AbortController().signal,
			info: {
				startToCloseTimeoutMs: 0,
				scheduleToCloseTimeoutMs: 0,
				scheduledTimestampMs: Date.now(),
				currentAttemptScheduledTimestampMs: Date.now(),
				heartbeatTimeoutMs: 0,
				...info,
			},
		};
	}

	/** When, in ms after entry, the attempt's signal fired, and why. */
	async function stopOf(input: { deadlineAt?: string } = {}) {
		const t0 = Date.now();
		const run = withProposalDeadline(
			input,
			() =>
				new Promise<{ at: number; reason: unknown }>((resolve) => {
					const signal = activityCancellationSignal();
					signal.addEventListener(
						"abort",
						() =>
							resolve({
								at: Date.now() - t0,
								reason: signal.reason,
							}),
						{ once: true },
					);
				}),
		);
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		return run;
	}

	it("measures start-to-close from the attempt's scheduled time, not from entry: a late start gets no extra time", async () => {
		// Scheduled 20 s before the function ran: Temporal's start-to-close
		// fires 65 s after entry, so the attempt stops 10 s before, at 55 s.
		inActivity({
			startToCloseTimeoutMs: 85_000,
			currentAttemptScheduledTimestampMs: NOW.getTime() - 20_000,
		});
		const stopped = await stopOf();
		expect(stopped.at).toBe(55_000);
		expect(stopped.reason).toBeInstanceOf(ProposalDeadlineExceeded);
	});

	it("stops at the earliest bound: a caller's deadlineAt before the attempt's timeouts wins", async () => {
		inActivity({ startToCloseTimeoutMs: 10 * 60_000 });
		const stopped = await stopOf({
			deadlineAt: new Date(NOW.getTime() + 30_000).toISOString(),
		});
		expect(stopped.at).toBe(20_000);
		expect(stopped.reason).toBeInstanceOf(ProposalDeadlineExceeded);
	});

	it("heartbeats throughout an attempt that declares a heartbeat timeout", async () => {
		inActivity({
			startToCloseTimeoutMs: 10 * 60_000,
			heartbeatTimeoutMs: 60_000,
		});
		await stopOf();
		expect(m.heartbeat.mock.calls.length).toBeGreaterThan(1);
	});
});

// ---------------------------------------------------------------------------
// The retired #2563 operation lane (Fizzy #2748)
// ---------------------------------------------------------------------------

describe("the retired #2563 operation lane (Fizzy #2748)", () => {
	const deadlineAt = new Date(NOW.getTime() + 4 * 60_000).toISOString();

	it("selectDueInstructionProposalOperations answers that nothing is due and reads nothing", async () => {
		expect(
			await selectDueInstructionProposalOperations({
				close: 10,
				recover: 10,
				mergeSync: 10,
				observe: 20,
				restart: 10,
			}),
		).toEqual({
			close: [],
			recover: [],
			mergeSync: [],
			observe: [],
			restart: [],
		});
		expect(getProposalOperation).not.toHaveBeenCalled();
	});

	it.each([
		[
			"closeInstructionProposalPullRequest",
			() =>
				closeInstructionProposalPullRequest({
					...ids,
					expectedAttempt: 3,
					deadlineAt,
				}),
		],
		[
			"recoverInstructionProposalPullRequest",
			() =>
				recoverInstructionProposalPullRequest({
					...ids,
					expectedAttempt: 3,
					deadlineAt,
				}),
		],
		[
			"reconcileInstructionProposalPullRequest",
			() =>
				reconcileInstructionProposalPullRequest({
					...ids,
					expectedAttempt: 3,
					deadlineAt,
				}),
		],
		[
			"dispatchInstructionProposalMergeSync",
			() => dispatchInstructionProposalMergeSync({ ...ids, deadlineAt }),
		],
		[
			"dispatchInstructionProposalPullRequest",
			() =>
				dispatchInstructionProposalPullRequest({
					...ids,
					attempt: 3,
					deadlineAt,
				}),
		],
		[
			"deferInstructionProposalOperation",
			() => deferInstructionProposalOperation({ ...ids, attempt: 3 }),
		],
	] as const)(
		"%s fails non-retryably and touches nothing",
		async (name, act) => {
			await expect(act()).rejects.toMatchObject({
				name: "ApplicationFailure",
				type: "PROPOSAL_OPERATION_LANE_RETIRED",
				nonRetryable: true,
				message: expect.stringContaining(name),
			});
			expect(getProposalOperation).not.toHaveBeenCalled();
			expect(m.state.transitions).toEqual([]);
			expect(m.state.audits).toEqual([]);
		},
	);
});
