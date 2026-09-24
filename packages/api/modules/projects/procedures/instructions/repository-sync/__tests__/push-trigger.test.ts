/**
 * The GitHub push webhook's automatic-sync hook (spec §6.2, §9 webhook
 * cases), against fake repository-sync subjects. The eligibility rules are
 * the REAL `shouldStartAutomaticSync` from @repo/instructions, the same
 * function the poll uses. Which rows a push may reach at all (the tenant
 * join, Review Focus 1) is the subject's lookup, pinned in
 * packages/database/__tests__/instruction-repository-sync-queries.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const REPO_URL = "https://github.com/example-org/example-repo";

const m = vi.hoisted(() => {
	const subject = (kind: string) => ({
		kind,
		findByRepository: vi.fn(),
		startRun: vi.fn(),
		recordPendingHead: vi.fn(),
		settlePendingHead: vi.fn(),
	});
	return {
		/** Stands for `db`: the client the pending-head write is handed. */
		db: { tag: "db" },
		/** The registry's kind list. One test appends a second, fake kind. */
		kinds: ["instructions"],
		subjects: {
			instructions: subject("instructions"),
			fake: subject("fake"),
		},
		withCorrelationMemo: vi.fn(),
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
});

vi.mock("@repo/temporal/repository-sync-subjects", () => ({
	REPOSITORY_SYNC_SUBJECT_KINDS: m.kinds,
	repositorySyncSubject: (kind: keyof typeof m.subjects) => m.subjects[kind],
}));
vi.mock("../../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: m.withCorrelationMemo,
}));
vi.mock("@repo/logs", () => ({ logger: m.log }));
vi.mock("@repo/database", () => ({ db: m.db }));

import {
	startInstructionSyncsForPush,
	WEBHOOK_SYNC_START_BUDGET_MS,
} from "../push-trigger";

const { instructions, fake } = m.subjects;

function syncRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		generation: 3,
		ref: "main",
		automatic: true,
		automaticPausedReason: null,
		lastEvaluatedCommitSha: null,
		lastEvaluatedGeneration: null,
		suppressedCommitSha: null,
		suppressedGeneration: null,
		...overrides,
	};
}

/** A second project, in another organization, following the same branch. */
const SECOND = syncRow({
	id: "sync_2",
	projectId: "proj_2",
	organizationId: "org_2",
});

/** What `startRun` answers (Decision 56); the hook reads only `outcome`. */
const STARTED = {
	outcome: "started",
	workflowId: "project-instruction-repository-sync-proj_1",
	runId: "run_1",
} as const;
const ALREADY_RUNNING = {
	outcome: "already_running",
	workflowId: "project-instruction-repository-sync-proj_1",
	runId: "run_open",
} as const;

/**
 * `startRun`'s options for a row: the row the hook decided on, as `expected`
 * (Decision 56), and the request's correlation memo.
 */
function startOptions(row: { id: string; generation: number }) {
	return {
		expected: { syncId: row.id, generation: row.generation },
		decorate: m.withCorrelationMemo,
	};
}

function push(overrides: Record<string, unknown> = {}) {
	return {
		repositoryUrl: REPO_URL,
		ref: "refs/heads/main",
		after: HEAD,
		...overrides,
	} as {
		repositoryUrl: string;
		ref: string | undefined;
		after: string | undefined;
	};
}

beforeEach(() => {
	for (const fn of [
		instructions.findByRepository,
		instructions.startRun,
		instructions.recordPendingHead,
		instructions.settlePendingHead,
		fake.findByRepository,
		fake.startRun,
		fake.recordPendingHead,
		fake.settlePendingHead,
		m.withCorrelationMemo,
		...Object.values(m.log),
	]) {
		fn.mockReset();
	}
	m.kinds.splice(0, m.kinds.length, "instructions");
	m.withCorrelationMemo.mockImplementation((options: object) => options);
	instructions.findByRepository.mockResolvedValue([syncRow()]);
	instructions.startRun.mockResolvedValue(STARTED);
	instructions.recordPendingHead.mockResolvedValue({ applied: true });
	instructions.settlePendingHead.mockResolvedValue({
		applied: false,
		settled: "consumer_pending",
	});
	fake.findByRepository.mockResolvedValue([]);
	fake.startRun.mockResolvedValue(STARTED);
	fake.recordPendingHead.mockResolvedValue({ applied: true });
	fake.settlePendingHead.mockResolvedValue({
		applied: false,
		settled: "consumer_pending",
	});
});

describe("startInstructionSyncsForPush (spec §6.2)", () => {
	it("starts a WEBHOOK run through the subject, with the row it decided on and the request's correlation memo, when the pushed branch is the sync's branch (Decision 56)", async () => {
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 1,
			failed: 0,
			deferred: 0,
		});
		expect(instructions.findByRepository).toHaveBeenCalledWith({
			repositoryUrl: REPO_URL,
			ref: "main",
		});
		expect(instructions.startRun).toHaveBeenCalledWith(
			syncRow(),
			"WEBHOOK",
			{
				expected: { syncId: "sync_1", generation: 3 },
				decorate: m.withCorrelationMemo,
			},
		);
	});

	it("looks the pushed branch up by its whole name, slashes included", async () => {
		await startInstructionSyncsForPush(
			push({ ref: "refs/heads/release/2026" }),
		);
		expect(instructions.findByRepository).toHaveBeenCalledWith({
			repositoryUrl: REPO_URL,
			ref: "release/2026",
		});
	});

	it.each([
		["a tag push", { ref: "refs/tags/main" }],
		["a push with no ref", { ref: undefined }],
		["a branch deletion (all-zero after)", { after: "0".repeat(40) }],
	])("looks nothing up for %s", async (_label, overrides) => {
		expect(await startInstructionSyncsForPush(push(overrides))).toEqual({
			started: 0,
			failed: 0,
			deferred: 0,
		});
		expect(instructions.findByRepository).not.toHaveBeenCalled();
		expect(instructions.startRun).not.toHaveBeenCalled();
	});

	it.each([
		["automatic sync is off", { automatic: false }],
		["the sync is paused", { automaticPausedReason: "REF_MISSING" }],
		[
			"the head is suppressed under this configuration",
			{ suppressedCommitSha: HEAD, suppressedGeneration: 3 },
		],
	])("starts nothing when %s", async (_label, overrides) => {
		instructions.findByRepository.mockResolvedValue([syncRow(overrides)]);
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 0,
			deferred: 0,
		});
		expect(instructions.startRun).not.toHaveBeenCalled();
	});

	it("a redelivered push for the evaluated head starts nothing (Review Focus 1)", async () => {
		instructions.findByRepository.mockResolvedValue([
			syncRow({
				lastEvaluatedCommitSha: HEAD,
				lastEvaluatedGeneration: 3,
			}),
		]);
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 0,
			deferred: 0,
		});
		expect(instructions.startRun).not.toHaveBeenCalled();
	});

	it("starts nothing when no sync follows the pushed branch", async () => {
		instructions.findByRepository.mockResolvedValue([]);
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 0,
			deferred: 0,
		});
	});

	it("counts an already running sync as not started, without error, leaves a re-check request and settles it against the open run's receipt (Fizzy #2682)", async () => {
		instructions.startRun.mockResolvedValue(ALREADY_RUNNING);
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 0,
			deferred: 1,
		});
		// One start: `already_running` is settled against the receipt, never
		// retried.
		expect(instructions.startRun).toHaveBeenCalledTimes(1);
		expect(instructions.recordPendingHead).toHaveBeenCalledTimes(1);
		expect(instructions.recordPendingHead).toHaveBeenCalledWith(
			m.db,
			syncRow(),
			HEAD,
		);
		// The open run the answer named, after the marker landed.
		expect(instructions.settlePendingHead).toHaveBeenCalledTimes(1);
		expect(instructions.settlePendingHead).toHaveBeenCalledWith(
			m.db,
			syncRow(),
			"run_open",
		);
		expect(
			instructions.recordPendingHead.mock.invocationCallOrder[0],
		).toBeLessThan(
			instructions.settlePendingHead.mock.invocationCallOrder[0] ?? 0,
		);
		expect(m.log.info).toHaveBeenCalledWith(
			{
				event: "instructions.sync.webhook_deferred",
				kind: "instructions",
				projectId: "proj_1",
				syncId: "sync_1",
				settled: "consumer_pending",
			},
			expect.any(String),
		);
		expect(JSON.stringify(m.log.info.mock.calls)).not.toContain(REPO_URL);
	});

	it("counts a marker the settle applied itself as deferred too: the open run's completion had already committed (Fizzy #2682)", async () => {
		instructions.startRun.mockResolvedValue(ALREADY_RUNNING);
		instructions.settlePendingHead.mockResolvedValue({
			applied: true,
			settled: "made_due",
		});
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 0,
			deferred: 1,
		});
		expect(m.log.info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.sync.webhook_deferred",
				settled: "made_due",
			}),
			expect.any(String),
		);
	});

	it("does not count a settle that found the row moved on (stale)", async () => {
		instructions.startRun.mockResolvedValue(ALREADY_RUNNING);
		instructions.settlePendingHead.mockResolvedValue({
			applied: false,
			settled: "stale",
		});
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 0,
			deferred: 0,
		});
		expect(m.log.info).not.toHaveBeenCalled();
	});

	it.each([
		["`after` is missing", { after: undefined }],
		["`after` is malformed", { after: "not-a-sha" }],
	])(
		"leaves nothing pending on an open run when %s: there is no head to compare",
		async (_label, overrides) => {
			instructions.startRun.mockResolvedValue(ALREADY_RUNNING);
			expect(await startInstructionSyncsForPush(push(overrides))).toEqual(
				{
					started: 0,
					failed: 0,
					deferred: 0,
				},
			);
			expect(instructions.startRun).toHaveBeenCalledTimes(1);
			expect(instructions.recordPendingHead).not.toHaveBeenCalled();
			expect(instructions.settlePendingHead).not.toHaveBeenCalled();
		},
	);

	it("leaves nothing pending for a run it started: that run reads the head itself", async () => {
		await startInstructionSyncsForPush(push());
		expect(instructions.recordPendingHead).not.toHaveBeenCalled();
		expect(instructions.settlePendingHead).not.toHaveBeenCalled();
	});

	it("neither counts nor settles a marker the row refused (re-configured since the lookup)", async () => {
		instructions.startRun.mockResolvedValue(ALREADY_RUNNING);
		instructions.recordPendingHead.mockResolvedValue({ applied: false });
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 0,
			deferred: 0,
		});
		expect(instructions.settlePendingHead).not.toHaveBeenCalled();
		expect(m.log.info).not.toHaveBeenCalled();
	});

	it("counts a failed settle as failed and names that stage, once the marker is on the row", async () => {
		instructions.startRun.mockResolvedValue(ALREADY_RUNNING);
		instructions.settlePendingHead.mockRejectedValue(
			new Error(`connection reset ${REPO_URL}`),
		);
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 1,
			deferred: 0,
		});
		expect(instructions.recordPendingHead).toHaveBeenCalledTimes(1);
		expect(m.log.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.sync.webhook_start_failed",
				projectId: "proj_1",
				stage: "settle_pending",
				errorClass: "Error",
			}),
			expect.any(String),
		);
		expect(JSON.stringify(m.log.warn.mock.calls)).not.toContain(REPO_URL);
	});

	it("counts a failed pending-head write as failed, names the stage, and logs no URL", async () => {
		instructions.startRun.mockResolvedValue(ALREADY_RUNNING);
		instructions.recordPendingHead.mockRejectedValue(
			new Error(`connection reset ${REPO_URL}`),
		);
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 0,
			failed: 1,
			deferred: 0,
		});
		expect(instructions.startRun).toHaveBeenCalledTimes(1);
		expect(instructions.settlePendingHead).not.toHaveBeenCalled();
		expect(m.log.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.sync.webhook_start_failed",
				kind: "instructions",
				projectId: "proj_1",
				stage: "record_pending",
				errorClass: "Error",
			}),
			expect.any(String),
		);
		expect(JSON.stringify(m.log.warn.mock.calls)).not.toContain(REPO_URL);
	});

	it("starts without the cursors when `after` is missing or malformed: only the run can tell", async () => {
		instructions.findByRepository.mockResolvedValue([
			syncRow({
				lastEvaluatedCommitSha: HEAD,
				lastEvaluatedGeneration: 3,
			}),
		]);
		await startInstructionSyncsForPush(push({ after: undefined }));
		await startInstructionSyncsForPush(push({ after: "not-a-sha" }));
		expect(instructions.startRun).toHaveBeenCalledTimes(2);
	});

	it("starts one run per sync that follows the branch, each under its own row's organization", async () => {
		instructions.findByRepository.mockResolvedValue([syncRow(), SECOND]);
		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 2,
			failed: 0,
			deferred: 0,
		});
		expect(instructions.startRun).toHaveBeenCalledWith(
			SECOND,
			"WEBHOOK",
			startOptions(SECOND),
		);
	});

	it("dispatches every registered kind through its own subject (Decision 46)", async () => {
		m.kinds.push("fake");
		fake.findByRepository.mockResolvedValue([SECOND]);

		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 2,
			failed: 0,
			deferred: 0,
		});
		expect(fake.findByRepository).toHaveBeenCalledWith({
			repositoryUrl: REPO_URL,
			ref: "main",
		});
		expect(instructions.startRun).toHaveBeenCalledTimes(1);
		expect(instructions.startRun).toHaveBeenCalledWith(
			syncRow(),
			"WEBHOOK",
			startOptions(syncRow()),
		);
		expect(fake.startRun).toHaveBeenCalledTimes(1);
		expect(fake.startRun).toHaveBeenCalledWith(
			SECOND,
			"WEBHOOK",
			startOptions(SECOND),
		);
	});

	it("a failed lookup for one subject does not stop another's starts, and logs no URL (Decision 36)", async () => {
		m.kinds.push("fake");
		instructions.findByRepository.mockRejectedValue(
			new Error(`relation missing for ${REPO_URL}`),
		);
		fake.findByRepository.mockResolvedValue([SECOND]);

		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 1,
			failed: 1,
			deferred: 0,
		});
		expect(fake.startRun).toHaveBeenCalledTimes(1);
		expect(m.log.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.sync.webhook_lookup_failed",
				kind: "instructions",
				errorClass: "Error",
			}),
			expect.any(String),
		);
		expect(JSON.stringify(m.log.warn.mock.calls)).not.toContain(REPO_URL);
	});

	it("a failed start for one project does not stop the next, and logs no URL", async () => {
		instructions.findByRepository.mockResolvedValue([syncRow(), SECOND]);
		// Keyed by project, not by call order: the starts run side by side.
		instructions.startRun.mockImplementation(
			async ({ projectId }: { projectId: string }) => {
				if (projectId === "proj_1") {
					throw new Error(`temporal unreachable ${REPO_URL}`);
				}
				return STARTED;
			},
		);

		expect(await startInstructionSyncsForPush(push())).toEqual({
			started: 1,
			failed: 1,
			deferred: 0,
		});
		expect(m.log.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.sync.webhook_start_failed",
				kind: "instructions",
				projectId: "proj_1",
				stage: "start",
				errorClass: "Error",
			}),
			expect.any(String),
		);
		expect(JSON.stringify(m.log.warn.mock.calls)).not.toContain(REPO_URL);
	});

	it("returns at its five-second budget while a start still hangs, and says how many are unsettled (Decision 36)", async () => {
		vi.useFakeTimers();
		try {
			instructions.findByRepository.mockResolvedValue([
				syncRow(),
				SECOND,
			]);
			instructions.startRun.mockImplementation(
				async ({ projectId }: { projectId: string }) =>
					projectId === "proj_1"
						? new Promise<typeof STARTED>(() => {})
						: STARTED,
			);

			const pending = startInstructionSyncsForPush(push());
			await vi.advanceTimersByTimeAsync(WEBHOOK_SYNC_START_BUDGET_MS);

			await expect(pending).resolves.toEqual({
				started: 1,
				failed: 0,
				deferred: 0,
			});
			expect(m.log.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					event: "instructions.sync.webhook_budget_exhausted",
					unsettled: 1,
				}),
				expect.any(String),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears its budget timer when every start settles in time", async () => {
		vi.useFakeTimers();
		try {
			instructions.findByRepository.mockResolvedValue([
				syncRow(),
				SECOND,
			]);
			await expect(startInstructionSyncsForPush(push())).resolves.toEqual(
				{
					started: 2,
					failed: 0,
					deferred: 0,
				},
			);
			expect(vi.getTimerCount()).toBe(0);
			expect(m.log.warn).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("pins the webhook's start budget at five seconds", () => {
		expect(WEBHOOK_SYNC_START_BUDGET_MS).toBe(5_000);
	});
});
