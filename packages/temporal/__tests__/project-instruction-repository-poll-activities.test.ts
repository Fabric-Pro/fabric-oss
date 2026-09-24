import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Assembled so the source carries no credential-shaped literal for the
// publication gitleaks scan, as in PR 1's sync activity tests.
const TOKEN = ["tok", "placeholder", "123"].join("-");
const SHA = "c".repeat(40);
const OLD_SHA = "b".repeat(40);
const RUN_DIR = "/tmp/fabric-instruction-sync/run-test";
const MIN = 60 * 1000;
const NOW_ISO = "2026-09-23T12:00:00.000Z";
/** The lease the claim wrote, as it travels through a Temporal payload. */
const LEASE_ISO = "2026-09-23T12:02:00.000Z";
const LATER_LEASE_ISO = "2026-09-23T12:07:00.000Z";
/** The poll's budget end. The check stops 5 s before the lease, 12:01:55. */
const DEADLINE_ISO = "2026-09-23T12:04:00.000Z";
/** Just past that stop. */
const LATE = new Date("2026-09-23T12:01:56.000Z");
/** What `startRun` answers (Decision 56). */
const STARTED = {
	outcome: "started",
	workflowId: "project-instruction-repository-sync-proj_1",
	runId: "run_1",
	runKey: "sync_1:run_1",
} as const;
const ALREADY_RUNNING = {
	outcome: "already_running",
	workflowId: "project-instruction-repository-sync-proj_1",
	runId: "run_open",
	runKey: "sync_1:run_open",
} as const;
/** The claimed row, as the start's `expected` (Decision 56). */
const EXPECTED = { syncId: "sync_1", generation: 3 };

const m = vi.hoisted(() => ({
	db: { $transaction: vi.fn() },
	tx: { tag: "tx" },
	patch: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	subjectFor: vi.fn(),
	/** The fake adapter every activity must go through (Decision 46). */
	subject: {
		kind: "instructions",
		listDueAndClaim: vi.fn(),
		leaseHeld: vi.fn(),
		writeBack: vi.fn(),
		recordCheckFailure: vi.fn(),
		findByRepository: vi.fn(),
		checkPermission: vi.fn(),
		startRun: vi.fn(),
	},
	resolveFreshRepoToken: vi.fn(),
	lsRemoteHead: vi.fn(),
	createSyncRunDir: vi.fn(),
	removeSyncRunDir: vi.fn(),
	sweepStaleSyncRunDirs: vi.fn(),
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Exactly these three: reading any instruction query straight from
// @repo/database, rather than through the subject, fails on the mock.
vi.mock("@repo/database", () => ({
	db: m.db,
	computeSchedulingPatch: m.patch,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
}));
vi.mock("../src/activities/lib/repository-sync-subjects", () => ({
	repositorySyncSubject: m.subjectFor,
}));
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: m.resolveFreshRepoToken,
}));
vi.mock("@repo/logs", () => ({ logger: m.log }));
vi.mock(
	"../src/activities/lib/instruction-sync-git",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-sync-git")
			>();
		return { ...real, lsRemoteHead: m.lsRemoteHead };
	},
);
vi.mock("../src/activities/lib/instruction-sync-temp", () => ({
	createSyncRunDir: m.createSyncRunDir,
	removeSyncRunDir: m.removeSyncRunDir,
	sweepStaleSyncRunDirs: m.sweepStaleSyncRunDirs,
}));

import { GitCommandError } from "../src/activities/lib/instruction-sync-git";
import {
	checkInstructionSyncRemoteHead,
	claimDueInstructionSyncChecks,
	sweepInstructionSyncTempDirs,
} from "../src/activities/project-instruction-repository-poll";
import type {
	ClaimedInstructionSyncCheck,
	InstructionSyncCheckInput,
} from "../src/lib/instruction-sync-types";

/** One claimed row as the subject's claim returns it. */
const ROW = {
	id: "sync_1",
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
	generation: 3,
	repositoryIntegrationId: "int_1",
	ref: "main",
	lastEvaluatedCommitSha: OLD_SHA,
	lastEvaluatedGeneration: 3,
	suppressedCommitSha: null,
	suppressedGeneration: null,
	failureCount: 2,
	leaseUntil: new Date(LEASE_ISO),
};
/** The same row after a Temporal payload: kind-tagged, lease as a string. */
const CLAIMED: ClaimedInstructionSyncCheck = {
	...ROW,
	kind: "instructions",
	leaseUntil: LEASE_ISO,
};
const CHECK: InstructionSyncCheckInput = {
	...CLAIMED,
	pollRunId: "poll_run_1",
	deadlineAt: DEADLINE_ISO,
};
/** What every fenced read and write compares (Decision 31). */
const FENCE = { id: "sync_1", generation: 3, leaseUntil: new Date(LEASE_ISO) };
const INTEGRATION = {
	id: "int_1",
	projectId: "proj_1",
	status: "ACTIVE",
	provider: "GITHUB",
	repositoryUrl: "https://github.com/example-org/example-repo",
};

/** The fake `computeSchedulingPatch` tags its effect, so a write shows which effect it carries. */
function patchFor(effect: object): { effect: object } {
	return { effect };
}

/** Everything a check could leak to: its result and every log line. */
function everyOutput(result: unknown): string {
	return JSON.stringify([
		result,
		m.log.debug.mock.calls,
		m.log.info.mock.calls,
		m.log.warn.mock.calls,
		m.log.error.mock.calls,
	]);
}

/** Nothing on the repository side ran: no integration read, no token, no git. */
function expectNoRepositoryAccess(): void {
	expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
	expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
	expect(m.createSyncRunDir).not.toHaveBeenCalled();
	expect(m.lsRemoteHead).not.toHaveBeenCalled();
}

beforeEach(() => {
	for (const fn of [
		m.db.$transaction,
		m.patch,
		m.getProjectRepoIntegration,
		m.subjectFor,
		m.subject.listDueAndClaim,
		m.subject.leaseHeld,
		m.subject.writeBack,
		m.subject.recordCheckFailure,
		m.subject.findByRepository,
		m.subject.checkPermission,
		m.subject.startRun,
		m.resolveFreshRepoToken,
		m.lsRemoteHead,
		m.createSyncRunDir,
		m.removeSyncRunDir,
		m.sweepStaleSyncRunDirs,
		...Object.values(m.log),
	]) {
		fn.mockReset();
	}
	m.subjectFor.mockReturnValue(m.subject);
	m.db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn(m.tx),
	);
	m.patch.mockImplementation((effect: object) => patchFor(effect));
	m.subject.leaseHeld.mockResolvedValue(true);
	m.subject.checkPermission.mockResolvedValue(true);
	m.subject.writeBack.mockResolvedValue({ applied: true });
	m.subject.recordCheckFailure.mockResolvedValue({ applied: true });
	m.subject.startRun.mockResolvedValue(STARTED);
	m.getProjectRepoIntegration.mockResolvedValue(INTEGRATION);
	m.resolveFreshRepoToken.mockResolvedValue({
		token: TOKEN,
		provider: "GITHUB",
	});
	m.createSyncRunDir.mockResolvedValue(RUN_DIR);
	m.removeSyncRunDir.mockResolvedValue(undefined);
	m.lsRemoteHead.mockResolvedValue({ kind: "found", sha: SHA });
});

describe("sweepInstructionSyncTempDirs (spec §8.2)", () => {
	it("removes the stale clone directories under the sync temp root", async () => {
		m.sweepStaleSyncRunDirs.mockResolvedValue({ removed: 2 });
		expect(await sweepInstructionSyncTempDirs()).toEqual({ removed: 2 });
		expect(m.sweepStaleSyncRunDirs).toHaveBeenCalledWith();
	});
});

describe("claimDueInstructionSyncChecks (spec §6.1)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(NOW_ISO));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("claims through the requested kind's subject, with a two-minute lease from this activity's clock (Decision 46)", async () => {
		m.subject.listDueAndClaim.mockResolvedValue([ROW]);
		expect(
			await claimDueInstructionSyncChecks({
				kind: "instructions",
				limit: 8,
			}),
		).toEqual([CLAIMED]);
		expect(m.subjectFor).toHaveBeenCalledWith("instructions");
		expect(m.subject.listDueAndClaim).toHaveBeenCalledWith(m.db, {
			limit: 8,
			leaseUntil: new Date(LEASE_ISO),
			now: new Date(NOW_ISO),
		});
	});

	it("hands each lease on as an ISO string that keeps its milliseconds (Decision 31)", async () => {
		m.subject.listDueAndClaim.mockResolvedValue([
			{ ...ROW, leaseUntil: new Date("2026-09-23T12:02:00.123Z") },
		]);
		const [claimed] = await claimDueInstructionSyncChecks({
			kind: "instructions",
			limit: 8,
		});
		expect(claimed?.leaseUntil).toBe("2026-09-23T12:02:00.123Z");
	});
});

describe("checkInstructionSyncRemoteHead (spec §6.1)", () => {
	// The check's deadline reads Date.now() and arms a timer (Decision 50).
	// Every case runs at 12:00 against a 12:02 lease and a 12:04 budget end,
	// so the check stops at 12:01:55.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(new Date(NOW_ISO));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves the claimed kind's subject, checks the lease and the delegate's permission first, then reads the head over a credential-free URL with the token only in the child env", async () => {
		await checkInstructionSyncRemoteHead(CHECK);
		expect(m.subjectFor).toHaveBeenCalledWith("instructions");
		expect(m.subject.leaseHeld).toHaveBeenCalledWith(m.db, FENCE);
		expect(m.subject.checkPermission).toHaveBeenCalledWith(ROW);
		expect(
			m.subject.checkPermission.mock.invocationCallOrder[0],
		).toBeLessThan(
			m.resolveFreshRepoToken.mock.invocationCallOrder[0] ?? 0,
		);
		expect(m.resolveFreshRepoToken).toHaveBeenCalledWith({
			integrationId: "int_1",
			projectId: "proj_1",
			userId: "user_1",
			organizationId: "org_1",
		});
		expect(m.lsRemoteHead).toHaveBeenCalledWith({
			cwd: RUN_DIR,
			url: "https://github.com/example-org/example-repo",
			ref: "main",
			timeoutMs: 30_000,
			// Fires at the check's own deadline (Decision 50).
			signal: expect.any(AbortSignal),
			env: expect.objectContaining({
				HOME: RUN_DIR,
				FABRIC_GIT_CREDENTIAL: TOKEN,
				FABRIC_GIT_USERNAME: "x-access-token",
				FABRIC_GIT_HOST: "github.com",
			}),
		});
		expect(m.removeSyncRunDir).toHaveBeenCalledWith(RUN_DIR);
	});

	it("strips userinfo from the integration URL before ls-remote sees it (Decision 45)", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...INTEGRATION,
			// Assembled so the literal is not email-shaped for the publication scan.
			repositoryUrl: `https://member@${"github.com"}/example-org/example-repo`,
		});
		await checkInstructionSyncRemoteHead(CHECK);
		expect(m.lsRemoteHead).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://github.com/example-org/example-repo",
				env: expect.objectContaining({ FABRIC_GIT_HOST: "github.com" }),
			}),
		);
	});

	it("skips a head evaluated under the claimed generation, writing the success patch built from the claimed row under the lease", async () => {
		m.lsRemoteHead.mockResolvedValue({ kind: "found", sha: OLD_SHA });
		const result = await checkInstructionSyncRemoteHead(CHECK);
		expect(result).toEqual({ outcome: "evaluated" });
		expect(m.patch).toHaveBeenCalledWith(
			{ kind: "success", commitSha: OLD_SHA },
			{ now: expect.any(Date), failureCount: 2, generation: 3 },
		);
		expect(m.subject.writeBack).toHaveBeenCalledWith(
			m.db,
			FENCE,
			patchFor({ kind: "success", commitSha: OLD_SHA }),
		);
		expect(m.subject.startRun).not.toHaveBeenCalled();
	});

	it("skips a head suppressed under the claimed generation", async () => {
		const result = await checkInstructionSyncRemoteHead({
			...CHECK,
			suppressedCommitSha: SHA,
			suppressedGeneration: 3,
		});
		expect(result).toEqual({ outcome: "suppressed" });
		expect(m.subject.writeBack).toHaveBeenCalledWith(
			m.db,
			FENCE,
			patchFor({ kind: "suppress", commitSha: SHA }),
		);
		expect(m.subject.startRun).not.toHaveBeenCalled();
	});

	it("re-evaluates after an ignore-rule change cleared the cursor", async () => {
		m.lsRemoteHead.mockResolvedValue({ kind: "found", sha: OLD_SHA });
		const result = await checkInstructionSyncRemoteHead({
			...CHECK,
			lastEvaluatedCommitSha: null,
			lastEvaluatedGeneration: null,
		});
		expect(result).toEqual({ outcome: "started" });
	});

	it("starts a POLL run through the subject FIRST, carrying the claimed row as expected, then reschedules 15 minutes out under the lease (Decisions 34 and 56)", async () => {
		const result = await checkInstructionSyncRemoteHead(CHECK);
		expect(result).toEqual({ outcome: "started" });
		expect(m.subject.startRun).toHaveBeenCalledWith(ROW, "POLL", {
			expected: EXPECTED,
		});
		expect(m.subject.writeBack).toHaveBeenCalledTimes(1);
		expect(m.subject.writeBack).toHaveBeenCalledWith(
			m.db,
			FENCE,
			patchFor({ kind: "reschedule", delayMs: 15 * MIN }),
		);
		expect(m.subject.startRun.mock.invocationCallOrder[0]).toBeLessThan(
			m.subject.writeBack.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("re-reads the lease before it starts, and starts nothing once it is lost", async () => {
		m.subject.leaseHeld
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "stale",
		});
		expect(m.subject.leaseHeld).toHaveBeenCalledTimes(2);
		expect(m.subject.startRun).not.toHaveBeenCalled();
		expect(m.subject.writeBack).not.toHaveBeenCalled();
	});

	it("starts a second run when the open one completes between the last lease read and the start, the one duplicate window, and reports it as started (Decision 51)", async () => {
		// The open run finishes right after the second lease read and moves
		// `nextCheckAt`. The start then begins a new run of the same
		// generation, which `expected` does not refuse; the reschedule finds
		// the lease gone and applies nothing, and the new run's completion
		// writes the schedule.
		m.subject.writeBack.mockResolvedValue({ applied: false });
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "started",
		});
		expect(m.subject.leaseHeld).toHaveBeenCalledTimes(2);
		expect(m.subject.leaseHeld.mock.invocationCallOrder[1]).toBeLessThan(
			m.subject.startRun.mock.invocationCallOrder[0] ?? 0,
		);
		expect(m.subject.startRun).toHaveBeenCalledTimes(1);
	});

	it("reports an open run as already running and reschedules 15 minutes out when this generation was evaluated, never backing off", async () => {
		m.subject.startRun.mockResolvedValue(ALREADY_RUNNING);
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "already_running",
		});
		expect(m.subject.writeBack).toHaveBeenCalledTimes(1);
		expect(m.subject.writeBack).toHaveBeenCalledWith(
			m.db,
			FENCE,
			patchFor({ kind: "reschedule", delayMs: 15 * MIN }),
		);
	});

	it("re-checks in two minutes when the open run belongs to a configuration this generation never evaluated (Decision 34)", async () => {
		m.subject.startRun.mockResolvedValue(ALREADY_RUNNING);
		expect(
			await checkInstructionSyncRemoteHead({
				...CHECK,
				lastEvaluatedGeneration: 2,
			}),
		).toEqual({ outcome: "already_running" });
		expect(m.subject.writeBack).toHaveBeenCalledWith(
			m.db,
			FENCE,
			patchFor({ kind: "reschedule", delayMs: 2 * MIN }),
		);
	});

	it("a crash between the start and the reschedule is left to the lease, and the next claim finds the run open (Decision 34)", async () => {
		m.subject.writeBack.mockRejectedValueOnce(
			new Error("connection reset"),
		);
		await expect(checkInstructionSyncRemoteHead(CHECK)).rejects.toThrow(
			"connection reset",
		);
		// No second write: the failed one is not retried as a backoff.
		expect(m.subject.writeBack).toHaveBeenCalledTimes(1);

		// The lease expired and a later tick claimed the row again.
		m.subject.startRun.mockResolvedValue(ALREADY_RUNNING);
		expect(
			await checkInstructionSyncRemoteHead({
				...CHECK,
				leaseUntil: LATER_LEASE_ISO,
			}),
		).toEqual({ outcome: "already_running" });
		expect(m.subject.writeBack).toHaveBeenLastCalledWith(
			m.db,
			{ ...FENCE, leaseUntil: new Date(LATER_LEASE_ISO) },
			patchFor({ kind: "reschedule", delayMs: 15 * MIN }),
		);
	});

	it("leaves a start whose outcome is unknown to the lease: stale, no retry, no backoff, and no token logged (Decision 51)", async () => {
		// The server may have started the run before the answer was lost.
		m.subject.startRun.mockRejectedValue(new Error("deadline exceeded"));
		const result = await checkInstructionSyncRemoteHead(CHECK);
		expect(result).toEqual({ outcome: "stale" });
		expect(m.subject.startRun).toHaveBeenCalledTimes(1);
		// The lease is left intact: no write of any kind.
		expect(m.subject.writeBack).not.toHaveBeenCalled();
		expect(m.patch).not.toHaveBeenCalled();
		expect(m.log.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.sync.poll_start_failed",
				errorClass: "Error",
			}),
			expect.any(String),
		);
		expect(everyOutput(result)).not.toContain(TOKEN);
	});

	it("a stalled token resolution released after the deadline runs no git, starts nothing and writes nothing (Review Focus 3)", async () => {
		let release: (value: { token: string; provider: string }) => void =
			() => {};
		m.resolveFreshRepoToken.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const pending = checkInstructionSyncRemoteHead(CHECK);
		await vi.waitFor(() =>
			expect(m.resolveFreshRepoToken).toHaveBeenCalled(),
		);

		// Temporal stopped waiting for this activity long ago, but its
		// JavaScript did not stop (Decision 50).
		vi.setSystemTime(new Date("2026-09-23T12:03:00.000Z"));
		release({ token: TOKEN, provider: "GITHUB" });

		expect(await pending).toEqual({ outcome: "stale" });
		expect(m.createSyncRunDir).not.toHaveBeenCalled();
		expect(m.lsRemoteHead).not.toHaveBeenCalled();
		expect(m.subject.startRun).not.toHaveBeenCalled();
		expect(m.subject.writeBack).not.toHaveBeenCalled();
		expect(m.subject.recordCheckFailure).not.toHaveBeenCalled();
		expect(m.db.$transaction).not.toHaveBeenCalled();
	});

	it.each([
		["its lease", CHECK, "2026-09-23T12:01:55.000Z"],
		[
			"the poll's budget",
			{ ...CHECK, deadlineAt: "2026-09-23T12:01:00.000Z" },
			"2026-09-23T12:00:55.000Z",
		],
	])(
		"reads nothing once it is within five seconds of %s ending, as when the task queue held it (Decision 50)",
		async (_label, input, now) => {
			vi.setSystemTime(new Date(now));
			expect(await checkInstructionSyncRemoteHead(input)).toEqual({
				outcome: "stale",
			});
			expect(m.subject.leaseHeld).not.toHaveBeenCalled();
			expect(m.subject.checkPermission).not.toHaveBeenCalled();
			expectNoRepositoryAccess();
			expect(m.subject.writeBack).not.toHaveBeenCalled();
		},
	);

	it("aborts a slow ls-remote at the check's deadline and reports stale, writing nothing (Decision 50)", async () => {
		m.lsRemoteHead.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(
							new GitCommandError(
								"timeout",
								null,
								"",
								"ls-remote",
							),
						),
					);
				}),
		);
		const pending = checkInstructionSyncRemoteHead(CHECK);
		await vi.waitFor(() => expect(m.lsRemoteHead).toHaveBeenCalled());

		// 12:00 to 12:01:55: the deadline timer fires, well inside the
		// ls-remote's own 30 s bound had it started later.
		await vi.advanceTimersByTimeAsync(115_000);

		expect(await pending).toEqual({ outcome: "stale" });
		expect(m.subject.writeBack).not.toHaveBeenCalled();
		expect(m.subject.startRun).not.toHaveBeenCalled();
		expect(m.log.debug).not.toHaveBeenCalled();
		expect(m.removeSyncRunDir).toHaveBeenCalledWith(RUN_DIR);
	});

	it.each([
		[
			"the evaluated write",
			() =>
				m.lsRemoteHead.mockImplementation(async () => {
					vi.setSystemTime(LATE);
					return { kind: "found", sha: OLD_SHA };
				}),
		],
		[
			"the backoff",
			() =>
				m.lsRemoteHead.mockImplementation(async () => {
					vi.setSystemTime(LATE);
					throw new GitCommandError("exit", 128, "", "ls-remote");
				}),
		],
		[
			"the missing-branch receipt",
			() =>
				m.lsRemoteHead.mockImplementation(async () => {
					vi.setSystemTime(LATE);
					return { kind: "missing" };
				}),
		],
		[
			"the revoked-delegate receipt",
			() =>
				m.subject.checkPermission.mockImplementation(async () => {
					vi.setSystemTime(LATE);
					return false;
				}),
		],
		[
			"the start",
			() =>
				m.subject.leaseHeld
					.mockResolvedValueOnce(true)
					.mockImplementationOnce(async () => {
						vi.setSystemTime(LATE);
						return true;
					}),
		],
	])(
		"does nothing when its deadline passes before %s (Decision 50)",
		async (_label, arrange) => {
			arrange();
			expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
				outcome: "stale",
			});
			expect(m.subject.writeBack).not.toHaveBeenCalled();
			expect(m.subject.recordCheckFailure).not.toHaveBeenCalled();
			expect(m.db.$transaction).not.toHaveBeenCalled();
			expect(m.subject.startRun).not.toHaveBeenCalled();
		},
	);

	it("reports a start whose answer came back after the deadline, but skips the reschedule (Decision 50)", async () => {
		m.subject.startRun.mockImplementation(async () => {
			vi.setSystemTime(LATE);
			return STARTED;
		});
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "started",
		});
		// The run's own completion writes the schedule; the lease covers the rest.
		expect(m.subject.writeBack).not.toHaveBeenCalled();
	});

	it("a check whose lease is gone reads nothing and starts nothing (Review Focus 3)", async () => {
		m.subject.leaseHeld.mockResolvedValue(false);
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "stale",
		});
		expect(m.subject.checkPermission).not.toHaveBeenCalled();
		expectNoRepositoryAccess();
		expect(m.subject.startRun).not.toHaveBeenCalled();
		expect(m.subject.writeBack).not.toHaveBeenCalled();
		expect(m.subject.recordCheckFailure).not.toHaveBeenCalled();
		expect(m.db.$transaction).not.toHaveBeenCalled();
	});

	it("reports stale when the lease was lost before an evaluated write", async () => {
		m.lsRemoteHead.mockResolvedValue({ kind: "found", sha: OLD_SHA });
		m.subject.writeBack.mockResolvedValue({ applied: false });
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "stale",
		});
	});

	it("records a missing branch as one FAILED POLL receipt, in one transaction, that pauses the sync (Decision 35)", async () => {
		m.lsRemoteHead.mockResolvedValue({ kind: "missing" });
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "ref_missing",
		});
		expect(m.db.$transaction).toHaveBeenCalledTimes(1);
		expect(m.subject.recordCheckFailure).toHaveBeenCalledWith(m.tx, {
			row: ROW,
			pollRunId: "poll_run_1",
			error: "REF_MISSING",
			pause: "REF_MISSING",
		});
		expect(m.subject.writeBack).not.toHaveBeenCalled();
		expect(m.subject.startRun).not.toHaveBeenCalled();
	});

	it("reports stale when the lease was lost before the receipt", async () => {
		m.lsRemoteHead.mockResolvedValue({ kind: "missing" });
		m.subject.recordCheckFailure.mockResolvedValue({ applied: false });
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "stale",
		});
	});

	it.each([
		["an evaluated head", CHECK, { kind: "found", sha: OLD_SHA } as const],
		[
			"a suppressed head",
			{ ...CHECK, suppressedCommitSha: SHA, suppressedGeneration: 3 },
			{ kind: "found", sha: SHA } as const,
		],
	])(
		"pauses a revoked delegate before touching the repository, even for %s (Decision 33)",
		async (_label, input, head) => {
			m.lsRemoteHead.mockResolvedValue(head);
			m.subject.checkPermission.mockResolvedValue(false);

			expect(await checkInstructionSyncRemoteHead(input)).toEqual({
				outcome: "permission_revoked",
			});

			expect(m.subject.recordCheckFailure).toHaveBeenCalledWith(m.tx, {
				row: {
					...ROW,
					suppressedCommitSha: input.suppressedCommitSha,
					suppressedGeneration: input.suppressedGeneration,
				},
				pollRunId: "poll_run_1",
				error: "PERMISSION_DENIED",
				pause: "PERMISSION_REVOKED",
			});
			expectNoRepositoryAccess();
			expect(m.subject.writeBack).not.toHaveBeenCalled();
			expect(m.subject.startRun).not.toHaveBeenCalled();
		},
	);

	it("backs off on a failed ls-remote and logs it at debug level with the token redacted", async () => {
		m.lsRemoteHead.mockRejectedValue(
			new GitCommandError(
				"exit",
				128,
				`fatal: Authentication failed for 'https://x-access-token:${TOKEN}@${"github.com"}/'`,
				"ls-remote",
			),
		);
		const result = await checkInstructionSyncRemoteHead(CHECK);
		expect(result).toEqual({ outcome: "transient" });
		expect(m.subject.writeBack).toHaveBeenCalledWith(
			m.db,
			FENCE,
			patchFor({ kind: "backoff" }),
		);
		expect(m.log.debug).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.sync.poll_git_failed",
				label: "ls-remote",
				kind: "exit",
			}),
			expect.any(String),
		);
		expect(everyOutput(result)).not.toContain(TOKEN);
		expect(m.removeSyncRunDir).toHaveBeenCalledWith(RUN_DIR);
	});

	it.each([
		[
			"the token cannot be resolved",
			() => m.resolveFreshRepoToken.mockResolvedValue({ token: null }),
		],
		[
			"token resolution throws",
			() =>
				m.resolveFreshRepoToken.mockRejectedValue(
					new Error("vault down"),
				),
		],
		[
			"the integration is not ACTIVE",
			() =>
				m.getProjectRepoIntegration.mockResolvedValue({
					...INTEGRATION,
					status: "TOKEN_EXPIRED",
				}),
		],
		[
			"the integration URL is not HTTPS",
			() =>
				m.getProjectRepoIntegration.mockResolvedValue({
					...INTEGRATION,
					repositoryUrl: `git@${"github.com"}:example-org/example-repo.git`,
				}),
		],
		[
			"the integration URL carries a query (Decision 45)",
			() =>
				m.getProjectRepoIntegration.mockResolvedValue({
					...INTEGRATION,
					repositoryUrl:
						"https://github.com/example-org/example-repo.git?access_token=secret",
				}),
		],
		[
			"the integration URL carries a fragment (Decision 45)",
			() =>
				m.getProjectRepoIntegration.mockResolvedValue({
					...INTEGRATION,
					repositoryUrl:
						"https://github.com/example-org/example-repo#secret",
				}),
		],
		[
			"the integration is gone",
			() => m.getProjectRepoIntegration.mockResolvedValue(null),
		],
	])("backs off without running git when %s", async (_label, arrange) => {
		arrange();
		expect(await checkInstructionSyncRemoteHead(CHECK)).toEqual({
			outcome: "transient",
		});
		expect(m.lsRemoteHead).not.toHaveBeenCalled();
		expect(m.subject.writeBack).toHaveBeenCalledWith(
			m.db,
			FENCE,
			patchFor({ kind: "backoff" }),
		);
	});
});
