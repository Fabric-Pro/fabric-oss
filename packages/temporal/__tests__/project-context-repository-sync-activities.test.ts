/**
 * `begin` and `record` of the Living Memory repository sync (design
 * 2026-09-23 §5.3.0, §5.4, Fizzy #2657).
 *
 * What this pins:
 *  - `begin` reads and describes with no lock, then opens ONE transaction
 *    that locks the configuration row first and revalidates: a new run
 *    inserts its receipt with the frozen context and takes the key; a retried
 *    `begin` returns the receipt it froze; a delayed `begin` whose receipt
 *    reconciliation already finished is `SUPERSEDED` and leaves the key (a
 *    successor's) alone; a predecessor Temporal reports closed is completed
 *    `FAILED` / `INTERRUPTED` with its ledger kept and its key released; a
 *    running predecessor, or a held key, is `RUN_IN_PROGRESS`, never a
 *    takeover; one that could not be described is retried by throwing until
 *    the last attempt, which refuses; state that moved between the read and
 *    the lock is re-read, three times, then `STORE_FAILED`; refusals leave a
 *    finished receipt and a completed audit row, `NOT_CONFIGURED` leaves
 *    nothing; the permission re-check reads through the transaction client;
 *  - `record` completes the receipt once from its ledger (the status table),
 *    releases the key on every terminal outcome, names the run last applied
 *    only with a plan receipt, a pinned commit and a matching generation,
 *    audits counts and never paths, writes nothing on a second delivery, and
 *    still completes the run row when the configuration is gone;
 *  - automatic sync (§11.1, Fizzy #2673): `begin` skips a POLL / WEBHOOK run,
 *    writing nothing, while automatic sync is off or paused, refuses one
 *    whose configuration moved since its start was decided
 *    (`CONFIGURATION_CHANGED`), and runs it as the configuration's member;
 *    every receipt and audit row carries the run's own trigger; a refusal
 *    and a completion write the verdict's scheduling effect while the
 *    configuration is at the run's generation; and `record` without a
 *    context, when the current configuration holds no receipt for the run,
 *    finds it by the workflow's run id and completes one whose configuration
 *    is gone or replaced as FAILED / CONFIGURATION_CHANGED, with its audit
 *    row and no schedule (the instructions sync's twin, Fizzy #2672);
 *  - an automatic-sync toggle, which keeps the generation (Fizzy #2713),
 *    neither skips nor fences a run already begun: a retried `begin`
 *    answers its frozen context and `record` names it last applied; and a
 *    PERMISSION_DENIED it records pauses automatic sync only while the
 *    configuration's current member still lacks CONTEXT_CREATE, so it never
 *    undoes a re-enable by another member or by one whose permission was
 *    restored.
 *
 * The database is an in-memory fake of exactly the `@repo/database` helpers
 * the activities call, with the semantics their own tests pin
 * (`packages/database/__tests__/context-repository-sync-queries.test.ts`):
 * a transaction works on a copy committed only when its callback returns,
 * and the two row locks are logged in the order they are taken.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/project-context-repository-sync-activities.test.ts
 */
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
	type Tables = {
		sync: Row[];
		run: Row[];
		integration: Row[];
		audit: Row[];
		/** Each scheduling effect written: `{ syncId, generation, effect }`. */
		schedule: Row[];
	};
	const empty = (): Tables => ({
		sync: [],
		run: [],
		integration: [],
		audit: [],
		schedule: [],
	});
	const TX = { __transaction: true } as const;
	const state = {
		committed: empty(),
		current: null as Tables | null,
		log: [] as string[],
		transactionOptions: [] as unknown[],
		permitted: new Set<string>(),
		attempt: 1,
		/** Answers the lock-time predecessor read with something else. */
		lockTimeUnfinished: null as null | ((ids: string[]) => string[]),
	};
	const tables = () => state.current ?? state.committed;
	const clone = <T>(value: T): T => structuredClone(value);

	const ledgerOf = (row: Row) => ({
		id: row.id,
		syncId: row.syncId,
		projectId: row.projectId,
		organizationId: row.organizationId,
		userId: row.userId,
		generation: row.generation,
		context: clone(row.context),
		trigger: row.trigger,
		startedAt: row.startedAt,
		commitSha: row.commitSha,
		plan: clone(row.plan),
		outcomes: clone(row.outcomes),
		removedCount: row.removedCount,
		pruneConflicts: clone(row.pruneConflicts),
	});

	const db = {
		$transaction: vi.fn(
			async (
				callback: (tx: unknown) => Promise<unknown>,
				options?: unknown,
			) => {
				state.transactionOptions.push(options);
				const work = clone(state.committed);
				state.current = work;
				try {
					const result = await callback(TX);
					state.committed = work;
					return result;
				} finally {
					state.current = null;
				}
			},
		),
	};

	const api = {
		CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS: 30_000,
		CONTEXT_SYNC_UNFINISHED_RUNS_LIMIT: 20,
		db,
		getContextRepositorySync: vi.fn(
			async (projectId: string, organizationId: string) => {
				const row = tables().sync.find(
					(s) =>
						s.projectId === projectId &&
						s.organizationId === organizationId,
				);
				return row ? clone(row) : null;
			},
		),
		getContextRepositorySyncRun: vi.fn(
			async (
				runKey: string,
				scope: { projectId: string; organizationId: string },
			) => {
				const row = tables().run.find(
					(r) =>
						r.id === runKey &&
						r.projectId === scope.projectId &&
						r.organizationId === scope.organizationId,
				);
				return row ? clone(row) : null;
			},
		),
		listUnfinishedContextRepositorySyncRuns: vi.fn(
			async (syncId: string, _limit?: number, client?: unknown) => {
				const ids = tables()
					.run.filter(
						(r) => r.syncId === syncId && r.finishedAt === null,
					)
					.map((r) => r.id as string);
				const answer =
					client === TX && state.lockTimeUnfinished
						? state.lockTimeUnfinished(ids)
						: ids;
				return answer.map((id) => ({ id }));
			},
		),
		getContextRepositorySyncForUpdate: vi.fn(
			async (
				tx: unknown,
				syncId: string,
				scope: { projectId: string; organizationId: string },
			) => {
				expect(tx).toBe(TX);
				const row = tables().sync.find(
					(s) =>
						s.id === syncId &&
						s.projectId === scope.projectId &&
						s.organizationId === scope.organizationId,
				);
				if (!row) {
					return null;
				}
				state.log.push("lock:sync");
				return clone(row);
			},
		),
		getContextRepositorySyncRunForUpdate: vi.fn(
			async (tx: unknown, runKey: string) => {
				expect(tx).toBe(TX);
				const row = tables().run.find((r) => r.id === runKey);
				if (row) {
					state.log.push(`lock:run:${runKey}`);
				}
				if (!row || row.finishedAt !== null) {
					return {
						status: "superseded",
						run: row
							? {
									id: row.id,
									syncId: row.syncId,
									projectId: row.projectId,
									organizationId: row.organizationId,
									userId: row.userId,
									generation: row.generation,
									finishedAt: row.finishedAt,
								}
							: null,
					};
				}
				return { status: "ok", run: ledgerOf(row) };
			},
		),
		completeContextRepositorySyncRun: vi.fn(
			async (
				tx: unknown,
				runKey: string,
				result: { status: string; error: string | null },
			) => {
				expect(tx).toBe(TX);
				const row = tables().run.find((r) => r.id === runKey);
				let completed = false;
				if (row && row.finishedAt === null) {
					row.finishedAt = new Date("2026-09-23T13:00:00Z");
					row.status = result.status;
					row.error = result.error;
					completed = true;
				}
				return { completed, run: row ? clone(row) : null };
			},
		),
		insertContextRepositorySyncRun: vi.fn(
			async (
				tx: unknown,
				input: Row & {
					finished?: { at: Date; status: string; error: string };
				},
			) => {
				expect(tx).toBe(TX);
				if (tables().run.some((r) => r.id === input.id)) {
					return { inserted: false };
				}
				const { finished, ...columns } = input;
				tables().run.push({
					...clone(columns),
					finishedAt: finished?.at ?? null,
					status: finished?.status ?? null,
					error: finished?.error ?? null,
					commitSha: null,
					plan: null,
					outcomes: {},
					removedCount: 0,
					pruneConflicts: { keys: [], overflow: 0 },
				});
				return { inserted: true };
			},
		),
		acquireContextRepositorySyncRunKey: vi.fn(
			async (tx: unknown, syncId: string, runKey: string) => {
				expect(tx).toBe(TX);
				const row = tables().sync.find(
					(s) => s.id === syncId && s.activeRunKey === null,
				);
				if (row) {
					row.activeRunKey = runKey;
				}
				return Boolean(row);
			},
		),
		releaseContextRepositorySyncRunKey: vi.fn(
			async (tx: unknown, syncId: string, runKey: string) => {
				expect(tx).toBe(TX);
				const row = tables().sync.find(
					(s) => s.id === syncId && s.activeRunKey === runKey,
				);
				if (row) {
					row.activeRunKey = null;
				}
				return Boolean(row);
			},
		),
		recordContextRepositorySyncLastApplied: vi.fn(
			async (
				tx: unknown,
				input: {
					syncId: string;
					generation: number;
					runKey: string;
					commitSha: string;
				},
			) => {
				expect(tx).toBe(TX);
				const row = tables().sync.find(
					(s) =>
						s.id === input.syncId &&
						s.generation === input.generation &&
						s.activeRunKey === input.runKey,
				);
				if (row) {
					row.lastAppliedCommitSha = input.commitSha;
					row.lastAppliedRunId = input.runKey;
				}
				return Boolean(row);
			},
		),
		findContextRepositorySyncRunReceiptByWorkflowRunId: vi.fn(
			async (
				workflowRunId: string,
				scope: { projectId: string; organizationId: string },
			) => {
				// The helper's contract (context-repository-sync-queries.test.ts):
				// the one receipt in the tenant keyed `<its syncId>:<run id>`.
				const matches = tables().run.filter(
					(r) =>
						r.projectId === scope.projectId &&
						r.organizationId === scope.organizationId &&
						r.id === `${r.syncId}:${workflowRunId}`,
				);
				return matches.length === 1
					? { id: matches[0]?.id, syncId: matches[0]?.syncId }
					: null;
			},
		),
		writeContextRepositorySyncScheduling: vi.fn(
			async (
				tx: unknown,
				input: {
					sync: {
						id: string;
						generation: number;
						automaticPausedReason: string | null;
						pendingCommitSha: string | null;
					};
					generation: number;
					effect: { kind: string };
				},
			) => {
				expect(tx).toBe(TX);
				// The helper's contract (context-repository-sync-automatic-
				// queries.test.ts): the run's generation must still be the
				// row's, and `none` writes nothing unless the locked row
				// carries a re-check request, which any effect folds in: due
				// now, or no next check on a paused row (Fizzy #2673).
				const marker = input.sync.pendingCommitSha ?? null;
				if (
					input.sync.generation !== input.generation ||
					(input.effect.kind === "none" && marker === null)
				) {
					return { applied: false };
				}
				const paused =
					(input.sync.automaticPausedReason ?? null) !== null ||
					input.effect.kind === "pause";
				tables().schedule.push(
					clone({
						syncId: input.sync.id,
						generation: input.generation,
						effect: input.effect,
						...(marker === null
							? {}
							: { recheck: paused ? "unscheduled" : "due_now" }),
					}),
				);
				if (marker !== null) {
					const row = tables().sync.find(
						(r) => r.id === input.sync.id,
					);
					if (row) {
						row.pendingCommitSha = null;
					}
				}
				return { applied: true };
			},
		),
		getContextSyncIntegration: vi.fn(
			async (
				client: unknown,
				input: { repositoryIntegrationId: string; projectId: string },
			) => {
				expect(client).toBe(TX);
				const row = tables().integration.find(
					(i) =>
						i.id === input.repositoryIntegrationId &&
						i.projectId === input.projectId,
				);
				return row
					? {
							status: row.status,
							repositoryOwner: row.repositoryOwner,
							repositoryName: row.repositoryName,
						}
					: null;
			},
		),
		canCreateProjectContexts: vi.fn(
			async (_projectId: string, userId: string, _client?: unknown) =>
				state.permitted.has(userId),
		),
		recordAuditTx: vi.fn(async (tx: unknown, input: Row) => {
			expect(tx).toBe(TX);
			tables().audit.push(clone(input));
		}),
	};

	return {
		TX,
		state,
		api,
		describe: vi.fn(),
		reset() {
			state.committed = empty();
			state.current = null;
			state.log = [];
			state.transactionOptions = [];
			state.permitted = new Set(["user-1"]);
			state.attempt = 1;
			state.lockTimeUnfinished = null;
		},
	};
});

vi.mock("@repo/database", () => h.api);

vi.mock("../src/activities/lib/context-sync-describe", () => ({
	describeContextSyncExecutions: h.describe,
}));

// The sync activity's collaborators, which `begin` and `record` never reach
// (`project-context-repository-sync-tree.test.ts` exercises them). Stubbed
// so loading the module does not load the integrations, vector-store,
// realtime and Temporal-client stacks.
vi.mock("@repo/integrations", () => ({}));
vi.mock("../src/lib/delete-channel-context", () => ({}));
vi.mock("@repo/utils/realtime-emit", () => ({}));
vi.mock("../src/client", () => ({}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	activityInfo: () => ({ attempt: h.state.attempt }),
}));

import {
	beginContextRepositorySyncRun,
	recordContextRepositorySyncRun,
} from "../src/activities/project-context-repository-sync";
import {
	CONTEXT_SYNC_BEGIN_MAX_ATTEMPTS,
	type ContextSyncFrozenContext,
	type RecordContextSyncRunInput,
} from "../src/lib/context-sync-types";

const PROJECT = "proj-1";
const ORG = "org-1";
const SYNC = "sync-1";
const RUN_ID = "run-b";
const RUN = `${SYNC}:${RUN_ID}`;
const PREDECESSOR = `${SYNC}:run-a`;
const SHA = "c".repeat(40);

const INPUT = {
	projectId: PROJECT,
	organizationId: ORG,
	trigger: "MANUAL" as const,
	requesterUserId: "user-1",
	workflowRunId: RUN_ID,
};

/** What the poll and the push webhook start: no requester. */
const AUTOMATIC = {
	projectId: PROJECT,
	organizationId: ORG,
	trigger: "POLL" as "POLL" | "WEBHOOK",
	workflowRunId: RUN_ID,
};

/** The configuration's member, whom an automatic run acts as. */
const DELEGATE = "user-9";

const committed = () => h.state.committed;

function seedSync(overrides: Row = {}): Row {
	const row: Row = {
		id: SYNC,
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user-9",
		repositoryIntegrationId: "int-1",
		ref: "main",
		paths: ["docs", "notes/glossary.md"],
		generation: 3,
		activeRunKey: null,
		lastAppliedCommitSha: "0ld",
		lastAppliedRunId: `${SYNC}:run-0`,
		automatic: false,
		automaticPausedReason: null,
		failureCount: 0,
		pendingCommitSha: null,
		...overrides,
	};
	committed().sync.push(row);
	return row;
}

function seedIntegration(overrides: Row = {}) {
	committed().integration.push({
		id: "int-1",
		projectId: PROJECT,
		status: "ACTIVE",
		repositoryOwner: "example-org",
		repositoryName: "handbook",
		...overrides,
	});
}

function seedRun(overrides: Row = {}): Row {
	const row: Row = {
		id: RUN,
		syncId: SYNC,
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user-1",
		generation: 3,
		context: {
			ref: "main",
			paths: ["docs", "notes/glossary.md"],
			repositoryIntegrationId: "int-1",
			actingUserId: "user-1",
		},
		trigger: "MANUAL",
		startedAt: new Date("2026-09-23T12:00:00Z"),
		finishedAt: null,
		status: null,
		error: null,
		commitSha: null,
		plan: null,
		outcomes: {},
		removedCount: 0,
		pruneConflicts: { keys: [], overflow: 0 },
		...overrides,
	};
	committed().run.push(row);
	return row;
}

function context(overrides: Partial<ContextSyncFrozenContext> = {}) {
	return {
		projectId: PROJECT,
		organizationId: ORG,
		syncId: SYNC,
		generation: 3,
		runKey: RUN,
		trigger: "MANUAL" as const,
		repositoryIntegrationId: "int-1",
		ref: "main",
		paths: ["docs", "notes/glossary.md"],
		actingUserId: "user-1",
		...overrides,
	};
}

function describedAs(states: Record<string, string>) {
	h.describe.mockImplementation(async () => new Map(Object.entries(states)));
}

const runRow = (id = RUN) => committed().run.find((r) => r.id === id);
const syncRow = () => committed().sync[0];

beforeEach(() => {
	vi.clearAllMocks();
	h.reset();
	h.describe.mockImplementation(async () => new Map());
});

// =============================================================================
// begin (§5.3.0)
// =============================================================================

describe("beginContextRepositorySyncRun", () => {
	it("opens a new run: its receipt with the frozen context and the key, in one 30-second transaction under lock 1", async () => {
		seedSync();
		seedIntegration();

		const result = await beginContextRepositorySyncRun(INPUT);

		expect(result).toEqual({ ok: true, context: context() });
		expect(runRow()).toMatchObject({
			syncId: SYNC,
			userId: "user-1",
			generation: 3,
			trigger: "MANUAL",
			finishedAt: null,
			context: {
				ref: "main",
				paths: ["docs", "notes/glossary.md"],
				repositoryIntegrationId: "int-1",
				actingUserId: "user-1",
			},
		});
		expect(syncRow()?.activeRunKey).toBe(RUN);
		expect(h.state.log[0]).toBe("lock:sync");
		expect(h.api.db.$transaction).toHaveBeenCalledTimes(1);
		expect(h.state.transactionOptions).toEqual([{ timeout: 30_000 }]);
		expect(committed().audit).toEqual([]);
	});

	it("re-checks the requester's CONTEXT_CREATE through the transaction client", async () => {
		seedSync();
		seedIntegration();

		await beginContextRepositorySyncRun(INPUT);

		expect(h.api.canCreateProjectContexts).toHaveBeenCalledWith(
			PROJECT,
			"user-1",
			h.TX,
		);
	});

	it("is idempotent: a retried begin answers with the context it froze and writes nothing", async () => {
		// Re-configured paths since, same generation: the frozen context wins.
		seedSync({ activeRunKey: RUN, paths: ["elsewhere"] });
		seedIntegration();
		seedRun();
		const before = structuredClone(committed());

		const result = await beginContextRepositorySyncRun(INPUT);

		expect(result).toEqual({ ok: true, context: context() });
		expect(committed()).toEqual(before);
		expect(h.describe).toHaveBeenCalledWith(
			expect.objectContaining({ runKeys: [] }),
		);
	});

	it("a delayed begin whose run reconciliation already finished is SUPERSEDED, and leaves the successor's key alone", async () => {
		const successor = `${SYNC}:run-c`;
		seedSync({ activeRunKey: successor });
		seedIntegration();
		seedRun({
			finishedAt: new Date("2026-09-23T12:30:00Z"),
			status: "FAILED",
			error: "INTERRUPTED",
		});
		seedRun({ id: successor });
		const before = structuredClone(committed());

		const result = await beginContextRepositorySyncRun(INPUT);

		expect(result).toEqual({ ok: false, error: "SUPERSEDED" });
		expect(committed()).toEqual(before);
		expect(syncRow()?.activeRunKey).toBe(successor);
	});

	it("a retried begin after a re-configure is CONFIGURATION_CHANGED, with the context it froze", async () => {
		seedSync({ activeRunKey: RUN, generation: 4 });
		seedIntegration();
		seedRun();

		expect(await beginContextRepositorySyncRun(INPUT)).toEqual({
			ok: false,
			error: "CONFIGURATION_CHANGED",
			context: context({ generation: 3 }),
		});
	});

	it.each(["closed", "not-found"])(
		"completes a predecessor described %s as FAILED/INTERRUPTED with its ledger kept, releases its key, then begins",
		async (state) => {
			seedSync({ activeRunKey: PREDECESSOR });
			seedIntegration();
			seedRun({
				id: PREDECESSOR,
				outcomes: { "docs/a.md": "created", "docs/b.md": "conflict" },
				removedCount: 2,
			});
			describedAs({ [PREDECESSOR]: state });

			const result = await beginContextRepositorySyncRun(INPUT);

			expect(h.describe).toHaveBeenCalledWith({
				projectId: PROJECT,
				syncId: SYNC,
				runKeys: [PREDECESSOR],
			});
			expect(runRow(PREDECESSOR)).toMatchObject({
				status: "FAILED",
				error: "INTERRUPTED",
				outcomes: { "docs/a.md": "created", "docs/b.md": "conflict" },
				removedCount: 2,
			});
			expect(runRow(PREDECESSOR)?.finishedAt).not.toBeNull();
			expect(result).toEqual({ ok: true, context: context() });
			expect(syncRow()?.activeRunKey).toBe(RUN);
			// Configuration first, then the run rows.
			expect(h.state.log).toEqual([
				"lock:sync",
				`lock:run:${PREDECESSOR}`,
			]);
		},
	);

	it("refuses RUN_IN_PROGRESS when a predecessor is running — never a takeover — and leaves a finished receipt", async () => {
		seedSync({ activeRunKey: PREDECESSOR });
		seedIntegration();
		seedRun({ id: PREDECESSOR });
		describedAs({ [PREDECESSOR]: "running" });

		const result = await beginContextRepositorySyncRun(INPUT);

		expect(result).toEqual({
			ok: false,
			error: "RUN_IN_PROGRESS",
			context: context(),
		});
		expect(runRow(PREDECESSOR)?.finishedAt).toBeNull();
		expect(syncRow()?.activeRunKey).toBe(PREDECESSOR);
		expect(runRow()).toMatchObject({
			status: "FAILED",
			error: "RUN_IN_PROGRESS",
			userId: "user-1",
		});
		expect(runRow()?.finishedAt).not.toBeNull();
		expect(committed().audit).toEqual([
			expect.objectContaining({
				action: "project.context.repository_sync_completed",
				actor: { type: "user", userId: "user-1" },
				metadata: expect.objectContaining({
					runId: RUN,
					status: "FAILED",
					error: "RUN_IN_PROGRESS",
					commitSha: null,
				}),
			}),
		]);
	});

	it("retries a predecessor it could not describe until its last attempt, which refuses RUN_IN_PROGRESS with a receipt", async () => {
		seedSync({ activeRunKey: PREDECESSOR });
		seedIntegration();
		seedRun({ id: PREDECESSOR });
		describedAs({ [PREDECESSOR]: "unknown" });

		const failure = await beginContextRepositorySyncRun(INPUT).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect(failure).toMatchObject({
			type: "RUN_IN_PROGRESS",
			nonRetryable: false,
		});
		expect(runRow()).toBeUndefined();
		expect(syncRow()?.activeRunKey).toBe(PREDECESSOR);

		h.state.attempt = CONTEXT_SYNC_BEGIN_MAX_ATTEMPTS;
		expect(await beginContextRepositorySyncRun(INPUT)).toEqual({
			ok: false,
			error: "RUN_IN_PROGRESS",
			context: context(),
		});
		expect(runRow()).toMatchObject({
			status: "FAILED",
			error: "RUN_IN_PROGRESS",
		});
		expect(runRow(PREDECESSOR)?.finishedAt).toBeNull();
	});

	it("refuses RUN_IN_PROGRESS while another run holds the key", async () => {
		// The key names a run with no unfinished receipt; only the API's
		// reconciliation releases such a key, never a begin.
		seedSync({ activeRunKey: `${SYNC}:run-z` });
		seedIntegration();

		expect(await beginContextRepositorySyncRun(INPUT)).toEqual({
			ok: false,
			error: "RUN_IN_PROGRESS",
			context: context(),
		});
		expect(syncRow()?.activeRunKey).toBe(`${SYNC}:run-z`);
	});

	it("re-reads when state moved between the read and the lock, and begins once it holds still", async () => {
		seedSync();
		seedIntegration();
		// Under the first lock a receipt appears that the read did not see.
		let moved = false;
		h.state.lockTimeUnfinished = (ids) => {
			if (moved) {
				return ids;
			}
			moved = true;
			return [...ids, PREDECESSOR];
		};

		const result = await beginContextRepositorySyncRun(INPUT);

		expect(result).toEqual({ ok: true, context: context() });
		expect(h.api.db.$transaction).toHaveBeenCalledTimes(2);
		expect(h.describe).toHaveBeenCalledTimes(2);
	});

	it("gives up after three moving passes with a retryable STORE_FAILED, having written nothing", async () => {
		seedSync();
		seedIntegration();
		seedRun({ id: PREDECESSOR });
		describedAs({ [PREDECESSOR]: "closed" });
		// Completed by someone else between every read and its lock.
		h.state.lockTimeUnfinished = (ids) =>
			ids.filter((id) => id !== PREDECESSOR);
		const before = structuredClone(committed());

		const failure = await beginContextRepositorySyncRun(INPUT).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect(failure).toMatchObject({
			type: "STORE_FAILED",
			nonRetryable: false,
		});
		expect(h.api.db.$transaction).toHaveBeenCalledTimes(3);
		expect(committed()).toEqual(before);
	});

	it.each([
		// A manual run never backs off automatic sync (§11.1): the poll's
		// own runs find the integration unavailable and back off themselves.
		[
			"the integration is not ACTIVE",
			"INTEGRATION_UNAVAILABLE",
			() => seedIntegration({ status: "REVOKED" }),
			"example-org/handbook",
			[],
		],
		[
			"the integration is gone",
			"INTEGRATION_UNAVAILABLE",
			() => {},
			null,
			[],
		],
		[
			// A manual run's revoked requester says nothing about the
			// configuration's member: no pause (§11.1).
			"the requester lost CONTEXT_CREATE",
			"PERMISSION_DENIED",
			() => {
				seedIntegration();
				h.state.permitted = new Set();
			},
			"example-org/handbook",
			[],
		],
	])(
		"refuses when %s, leaving a finished receipt, a completed audit row, its scheduling effect and no key",
		async (_case, error, arrange, repository, schedule) => {
			seedSync();
			arrange();

			const result = await beginContextRepositorySyncRun(INPUT);

			expect(result).toEqual({ ok: false, error, context: context() });
			expect(runRow()).toMatchObject({
				status: "FAILED",
				error,
				trigger: "MANUAL",
			});
			expect(runRow()?.finishedAt).not.toBeNull();
			expect(syncRow()?.activeRunKey).toBeNull();
			expect(committed().audit).toEqual([
				expect.objectContaining({
					action: "project.context.repository_sync_completed",
					outcome: "failure",
					resource: {
						type: "project_context_repository_sync",
						id: SYNC,
						name: repository,
					},
					metadata: expect.objectContaining({ trigger: "MANUAL" }),
				}),
			]);
			expect(committed().schedule).toEqual(schedule);
		},
	);

	it("answers NOT_CONFIGURED with no receipt and no transaction when there is no configuration in the tenant", async () => {
		seedSync({ organizationId: "org-other" });

		expect(await beginContextRepositorySyncRun(INPUT)).toEqual({
			ok: false,
			error: "NOT_CONFIGURED",
		});
		expect(committed().run).toEqual([]);
		expect(h.api.db.$transaction).not.toHaveBeenCalled();
	});

	it("refuses input without a requester or a run id, finally", async () => {
		await expect(
			beginContextRepositorySyncRun({ ...INPUT, requesterUserId: "" }),
		).rejects.toMatchObject({
			type: "CONTEXT_SYNC_INPUT_INVALID",
			nonRetryable: true,
		});
	});

	it("refuses a trigger it does not know, finally, before reading anything", async () => {
		await expect(
			beginContextRepositorySyncRun({
				...AUTOMATIC,
				trigger: "SCHEDULE" as unknown as "POLL",
			}),
		).rejects.toMatchObject({
			type: "CONTEXT_SYNC_INPUT_INVALID",
			nonRetryable: true,
		});
		expect(h.api.getContextRepositorySync).not.toHaveBeenCalled();
	});
});

// =============================================================================
// begin, automatic triggers (§11.1, Fizzy #2673)
// =============================================================================

describe("beginContextRepositorySyncRun, automatic triggers", () => {
	it.each(["POLL", "WEBHOOK"] as const)(
		"runs a %s run as the configuration's member, re-checked through the transaction, and stores its trigger",
		async (trigger) => {
			seedSync({ automatic: true });
			seedIntegration();
			h.state.permitted = new Set([DELEGATE]);

			const result = await beginContextRepositorySyncRun({
				...AUTOMATIC,
				trigger,
				expected: { syncId: SYNC, generation: 3 },
			});

			expect(result).toEqual({
				ok: true,
				context: context({ trigger, actingUserId: DELEGATE }),
			});
			expect(runRow()).toMatchObject({
				userId: DELEGATE,
				trigger,
				finishedAt: null,
				context: expect.objectContaining({ actingUserId: DELEGATE }),
			});
			expect(syncRow()?.activeRunKey).toBe(RUN);
			expect(h.api.canCreateProjectContexts).toHaveBeenCalledWith(
				PROJECT,
				DELEGATE,
				h.TX,
			);
		},
	);

	it.each([
		["automatic sync is off", { automatic: false }, "automatic_disabled"],
		[
			"automatic sync is paused",
			{ automatic: true, automaticPausedReason: "REF_MISSING" },
			"paused",
		],
		[
			// Off wins: turning automatic sync off re-configures the row, and
			// that must read as a skip, not as a configuration change.
			"automatic sync is off and the row moved",
			{ automatic: false, generation: 4 },
			"automatic_disabled",
		],
	])(
		"skips an automatic run while %s, writing nothing — no receipt, no audit row, no schedule, no key",
		async (_case, sync, skipped) => {
			seedSync(sync);
			seedIntegration();
			h.state.permitted = new Set([DELEGATE]);
			const before = structuredClone(committed());

			const result = await beginContextRepositorySyncRun({
				...AUTOMATIC,
				trigger: "WEBHOOK",
				expected: { syncId: SYNC, generation: 3 },
			});

			expect(result).toEqual({ ok: false, error: null, skipped });
			expect(committed()).toEqual(before);
			expect(h.api.canCreateProjectContexts).not.toHaveBeenCalled();
		},
	);

	it("never gates a manual run on automatic sync: Sync now runs while it is off or paused", async () => {
		seedSync({
			automatic: true,
			automaticPausedReason: "PERMISSION_REVOKED",
		});
		seedIntegration();

		expect(await beginContextRepositorySyncRun(INPUT)).toEqual({
			ok: true,
			context: context(),
		});
	});

	it.each([
		["re-configured", { syncId: SYNC, generation: 2 }],
		["replaced", { syncId: "sync-0", generation: 3 }],
	])(
		"refuses an automatic run whose configuration was %s since its start was decided: CONFIGURATION_CHANGED, with a receipt and an audit row carrying its trigger, and no schedule",
		async (_case, expected) => {
			seedSync({ automatic: true });
			seedIntegration();
			h.state.permitted = new Set([DELEGATE]);

			const result = await beginContextRepositorySyncRun({
				...AUTOMATIC,
				expected,
			});

			expect(result).toEqual({
				ok: false,
				error: "CONFIGURATION_CHANGED",
				context: context({ trigger: "POLL", actingUserId: DELEGATE }),
			});
			expect(runRow()).toMatchObject({
				status: "FAILED",
				error: "CONFIGURATION_CHANGED",
				trigger: "POLL",
				userId: DELEGATE,
			});
			expect(syncRow()?.activeRunKey).toBeNull();
			expect(committed().audit).toEqual([
				expect.objectContaining({
					actor: { type: "user", userId: DELEGATE },
					metadata: expect.objectContaining({
						trigger: "POLL",
						error: "CONFIGURATION_CHANGED",
					}),
				}),
			]);
			// The re-configure already made the row due; the refusal leaves
			// the schedule to it.
			expect(committed().schedule).toEqual([]);
			// Refused before the permission re-check.
			expect(h.api.canCreateProjectContexts).not.toHaveBeenCalled();
		},
	);

	it("pauses automatic sync as PERMISSION_REVOKED when the configuration's member lost CONTEXT_CREATE", async () => {
		seedSync({ automatic: true });
		seedIntegration();
		h.state.permitted = new Set(["user-1"]);

		const result = await beginContextRepositorySyncRun({
			...AUTOMATIC,
			trigger: "WEBHOOK",
		});

		expect(result).toEqual({
			ok: false,
			error: "PERMISSION_DENIED",
			context: context({ trigger: "WEBHOOK", actingUserId: DELEGATE }),
		});
		expect(runRow()).toMatchObject({
			status: "FAILED",
			error: "PERMISSION_DENIED",
			trigger: "WEBHOOK",
		});
		expect(committed().schedule).toEqual([
			{
				syncId: SYNC,
				generation: 3,
				effect: { kind: "pause", reason: "PERMISSION_REVOKED" },
			},
		]);
		expect(committed().audit).toEqual([
			expect.objectContaining({
				metadata: expect.objectContaining({ trigger: "WEBHOOK" }),
			}),
		]);
	});

	it("backs off an automatic run whose integration is not ACTIVE, counting from the row's failures", async () => {
		seedSync({ automatic: true, failureCount: 2 });
		seedIntegration({ status: "REVOKED" });
		h.state.permitted = new Set([DELEGATE]);

		expect(await beginContextRepositorySyncRun(AUTOMATIC)).toMatchObject({
			ok: false,
			error: "INTEGRATION_UNAVAILABLE",
		});
		expect(h.api.writeContextRepositorySyncScheduling).toHaveBeenCalledWith(
			h.TX,
			{
				sync: expect.objectContaining({
					id: SYNC,
					generation: 3,
					failureCount: 2,
				}),
				generation: 3,
				effect: { kind: "backoff" },
				now: expect.any(Date),
			},
		);
	});

	it("dates a refusal's receipt and next check on the database's clock lock 1 read, not this worker's (Fizzy #2683)", async () => {
		const DB_NOW = new Date("2026-09-23T15:00:00Z");
		seedSync({ automatic: true, failureCount: 2, now: DB_NOW });
		seedIntegration({ status: "REVOKED" });
		h.state.permitted = new Set([DELEGATE]);

		expect(await beginContextRepositorySyncRun(AUTOMATIC)).toMatchObject({
			ok: false,
			error: "INTEGRATION_UNAVAILABLE",
		});
		expect(h.api.insertContextRepositorySyncRun).toHaveBeenCalledWith(
			h.TX,
			expect.objectContaining({
				startedAt: DB_NOW,
				finished: expect.objectContaining({ at: DB_NOW }),
			}),
		);
		expect(h.api.writeContextRepositorySyncScheduling).toHaveBeenCalledWith(
			h.TX,
			expect.objectContaining({ now: DB_NOW }),
		);
	});

	it("folds a re-check request left while the refused run was open into the refusal's schedule, read under the same lock (Fizzy #2673)", async () => {
		const PUSHED = "d".repeat(40);
		seedSync({
			automatic: true,
			failureCount: 2,
			pendingCommitSha: PUSHED,
		});
		seedIntegration({ status: "REVOKED" });
		h.state.permitted = new Set([DELEGATE]);

		expect(await beginContextRepositorySyncRun(AUTOMATIC)).toMatchObject({
			ok: false,
			error: "INTEGRATION_UNAVAILABLE",
		});
		expect(h.api.writeContextRepositorySyncScheduling).toHaveBeenCalledWith(
			h.TX,
			expect.objectContaining({
				sync: expect.objectContaining({
					id: SYNC,
					automaticPausedReason: null,
					pendingCommitSha: PUSHED,
				}),
			}),
		);
		expect(committed().schedule).toEqual([
			{
				syncId: SYNC,
				generation: 3,
				effect: { kind: "backoff" },
				recheck: "due_now",
			},
		]);
		expect(syncRow()?.pendingCommitSha).toBeNull();
	});
});

// =============================================================================
// record (§5.4)
// =============================================================================

function recordInput(
	overrides: Partial<RecordContextSyncRunInput> = {},
): RecordContextSyncRunInput {
	return {
		projectId: PROJECT,
		organizationId: ORG,
		trigger: "MANUAL",
		workflowRunId: RUN_ID,
		context: context(),
		error: null,
		cancelled: false,
		commitSha: SHA,
		...overrides,
	};
}

const PLAN = {
	keptCount: 3,
	excludedCount: 1,
	attentionCount: 0,
	attention: [],
	protectedPrefixes: [],
	missingPaths: [],
	keptKeys: ["docs/a.md", "docs/b.md", "docs/c.md"],
	protectedKeys: [],
};

describe("recordContextRepositorySyncRun", () => {
	it("completes the receipt from its ledger, names it last applied, releases the key and audits counts — configuration locked first", async () => {
		seedSync({ activeRunKey: RUN });
		seedIntegration();
		seedRun({
			commitSha: SHA,
			plan: PLAN,
			outcomes: {
				"docs/a.md": "created",
				"docs/b.md": "updated",
				"docs/c.md": "unchanged",
			},
			removedCount: 1,
		});

		const result = await recordContextRepositorySyncRun(recordInput());

		expect(result).toEqual({
			recorded: true,
			status: "SUCCEEDED",
			error: null,
		});
		expect(runRow()).toMatchObject({ status: "SUCCEEDED", error: null });
		expect(syncRow()).toMatchObject({
			activeRunKey: null,
			lastAppliedCommitSha: SHA,
			lastAppliedRunId: RUN,
		});
		expect(h.state.log).toEqual(["lock:sync", `lock:run:${RUN}`]);
		expect(h.state.transactionOptions).toEqual([{ timeout: 30_000 }]);
		expect(committed().audit).toEqual([
			{
				action: "project.context.repository_sync_completed",
				category: "project",
				severity: "info",
				outcome: "success",
				actor: { type: "user", userId: "user-1" },
				organizationId: ORG,
				projectId: PROJECT,
				resource: {
					type: "project_context_repository_sync",
					id: SYNC,
					name: "example-org/handbook",
				},
				metadata: {
					runId: RUN,
					trigger: "MANUAL",
					status: "SUCCEEDED",
					error: null,
					commitSha: SHA,
					counts: {
						created: 1,
						updated: 1,
						adopted: 0,
						unchanged: 1,
						conflict: 0,
						pathInUse: 0,
						removed: 1,
						pruneConflicts: 0,
						attention: 0,
					},
				},
			},
		]);
		// Never a path.
		expect(JSON.stringify(committed().audit)).not.toContain("docs/");
	});

	it.each([
		[
			"a typed failure",
			{ error: "PATHS_MISSING" as const },
			{},
			"FAILED",
			"PATHS_MISSING",
		],
		["a cancellation", { cancelled: true }, {}, "FAILED", "INTERRUPTED"],
		[
			"attention in the plan",
			{},
			{ plan: { ...PLAN, attentionCount: 2 } },
			"PARTIAL",
			null,
		],
		[
			"an apply conflict",
			{},
			{ plan: PLAN, outcomes: { "docs/a.md": "conflict" } },
			"PARTIAL",
			null,
		],
		[
			"a path in use",
			{},
			{ plan: PLAN, outcomes: { "docs/a.md": "path-in-use" } },
			"PARTIAL",
			null,
		],
		[
			"a prune conflict past the kept keys",
			{},
			{ plan: PLAN, pruneConflicts: { keys: [], overflow: 1 } },
			"PARTIAL",
			null,
		],
		[
			"only an adoption",
			{},
			{ plan: PLAN, outcomes: { "docs/a.md": "adopted" } },
			"SUCCEEDED",
			null,
		],
		[
			"only a removal",
			{},
			{ plan: PLAN, removedCount: 3 },
			"SUCCEEDED",
			null,
		],
		[
			"nothing written",
			{},
			{ plan: PLAN, outcomes: { "docs/a.md": "unchanged" } },
			"UNCHANGED",
			null,
		],
	])(
		"records %s as %s and releases the key",
		async (_case, input, ledger, status, error) => {
			seedSync({ activeRunKey: RUN });
			seedIntegration();
			seedRun({ commitSha: SHA, ...ledger });

			const result = await recordContextRepositorySyncRun(
				recordInput(input),
			);

			expect(result).toEqual({ recorded: true, status, error });
			expect(runRow()).toMatchObject({ status, error });
			expect(syncRow()?.activeRunKey).toBeNull();
		},
	);

	it("never releases a key another run holds", async () => {
		seedSync({ activeRunKey: `${SYNC}:run-z` });
		seedIntegration();
		seedRun({ commitSha: SHA, plan: PLAN });

		await recordContextRepositorySyncRun(
			recordInput({ error: "SUPERSEDED" }),
		);

		expect(runRow()).toMatchObject({
			status: "FAILED",
			error: "SUPERSEDED",
		});
		expect(syncRow()).toMatchObject({
			activeRunKey: `${SYNC}:run-z`,
			lastAppliedRunId: `${SYNC}:run-0`,
		});
	});

	it.each([
		["no plan receipt", { plan: null, commitSha: SHA }, {}],
		["no pinned commit", { plan: PLAN, commitSha: null }, {}],
		[
			"a moved generation",
			{ plan: PLAN, commitSha: SHA },
			{ generation: 4 },
		],
	])(
		"does not name the run last applied with %s",
		async (_case, ledger, sync) => {
			seedSync({ activeRunKey: RUN, ...sync });
			seedIntegration();
			seedRun(ledger);

			await recordContextRepositorySyncRun(recordInput());

			expect(syncRow()).toMatchObject({
				lastAppliedCommitSha: "0ld",
				lastAppliedRunId: `${SYNC}:run-0`,
				activeRunKey: null,
			});
		},
	);

	it("names a run that failed part-way last applied: the tab says so", async () => {
		seedSync({ activeRunKey: RUN });
		seedIntegration();
		seedRun({ plan: PLAN, commitSha: SHA });

		await recordContextRepositorySyncRun(
			recordInput({ error: "STORE_FAILED" }),
		);

		expect(syncRow()).toMatchObject({
			lastAppliedCommitSha: SHA,
			lastAppliedRunId: RUN,
		});
	});

	it("writes nothing on a second delivery and answers the stored verdict", async () => {
		seedSync({ activeRunKey: RUN });
		seedIntegration();
		seedRun({ plan: PLAN, commitSha: SHA });
		await recordContextRepositorySyncRun(recordInput());
		const afterFirst = structuredClone(committed());

		const second = await recordContextRepositorySyncRun(
			recordInput({ error: "CLONE_FAILED" }),
		);

		expect(second).toEqual({
			recorded: false,
			status: "UNCHANGED",
			error: null,
		});
		expect(committed()).toEqual(afterFirst);
		expect(committed().audit).toHaveLength(1);
	});

	it("answers a refusal's receipt as begin stored it, without a second audit row", async () => {
		seedSync();
		seedIntegration();
		seedRun({
			finishedAt: new Date("2026-09-23T12:00:01Z"),
			status: "FAILED",
			error: "PERMISSION_DENIED",
		});

		expect(
			await recordContextRepositorySyncRun(
				recordInput({ error: "PERMISSION_DENIED" }),
			),
		).toEqual({
			recorded: false,
			status: "FAILED",
			error: "PERMISSION_DENIED",
		});
		expect(committed().audit).toEqual([]);
	});

	it("still completes the run row when the configuration is gone, locking only the run row", async () => {
		seedIntegration();
		seedRun({
			plan: PLAN,
			commitSha: SHA,
			outcomes: { "docs/a.md": "created" },
		});

		const result = await recordContextRepositorySyncRun(
			recordInput({ error: "CONFIGURATION_CHANGED" }),
		);

		expect(result).toEqual({
			recorded: true,
			status: "FAILED",
			error: "CONFIGURATION_CHANGED",
		});
		expect(runRow()).toMatchObject({
			status: "FAILED",
			error: "CONFIGURATION_CHANGED",
		});
		expect(h.state.log).toEqual([`lock:run:${RUN}`]);
		expect(
			h.api.recordContextRepositorySyncLastApplied,
		).not.toHaveBeenCalled();
		expect(committed().audit).toHaveLength(1);
	});

	it("without a context, rebuilds the run key from the current configuration and the workflow's run id, and completes what begin committed", async () => {
		seedSync({ activeRunKey: RUN });
		seedIntegration();
		seedRun();

		const result = await recordContextRepositorySyncRun(
			recordInput({
				context: null,
				error: "STORE_FAILED",
				commitSha: null,
			}),
		);

		expect(result).toEqual({
			recorded: true,
			status: "FAILED",
			error: "STORE_FAILED",
		});
		expect(syncRow()?.activeRunKey).toBeNull();
		expect(
			h.api.findContextRepositorySyncRunReceiptByWorkflowRunId,
		).not.toHaveBeenCalled();
	});

	it("without a context, completes a cancelled run as INTERRUPTED — never as a clone failure", async () => {
		seedSync({ activeRunKey: RUN });
		seedIntegration();
		seedRun();

		expect(
			await recordContextRepositorySyncRun(
				recordInput({
					context: null,
					cancelled: true,
					commitSha: null,
				}),
			),
		).toEqual({ recorded: true, status: "FAILED", error: "INTERRUPTED" });
	});

	it("records nothing for NOT_CONFIGURED", async () => {
		expect(
			await recordContextRepositorySyncRun(
				recordInput({ context: null, error: "NOT_CONFIGURED" }),
			),
		).toEqual({ recorded: false, status: null, error: null });
		expect(h.api.db.$transaction).not.toHaveBeenCalled();
	});

	it("never completes another tenant's run", async () => {
		seedSync({ activeRunKey: RUN });
		seedIntegration();
		seedRun({ organizationId: "org-other" });
		const before = structuredClone(committed());

		expect(await recordContextRepositorySyncRun(recordInput())).toEqual({
			recorded: false,
			status: null,
			error: null,
		});
		expect(committed()).toEqual(before);
	});
});

// =============================================================================
// record, the schedule and the run's own trigger (§11.1, Fizzy #2673)
// =============================================================================

describe("recordContextRepositorySyncRun, automatic sync", () => {
	it("audits the run's own trigger and marks the applied head evaluated", async () => {
		seedSync({ activeRunKey: RUN, automatic: true });
		seedIntegration();
		seedRun({
			trigger: "WEBHOOK",
			userId: DELEGATE,
			commitSha: SHA,
			plan: PLAN,
			outcomes: { "docs/a.md": "created" },
		});

		expect(
			await recordContextRepositorySyncRun(
				recordInput({
					trigger: "WEBHOOK",
					context: context({
						trigger: "WEBHOOK",
						actingUserId: DELEGATE,
					}),
				}),
			),
		).toEqual({ recorded: true, status: "SUCCEEDED", error: null });

		expect(committed().audit).toEqual([
			expect.objectContaining({
				actor: { type: "user", userId: DELEGATE },
				metadata: expect.objectContaining({
					trigger: "WEBHOOK",
					status: "SUCCEEDED",
				}),
			}),
		]);
		expect(committed().schedule).toEqual([
			{
				syncId: SYNC,
				generation: 3,
				effect: { kind: "success", commitSha: SHA },
			},
		]);
		expect(syncRow()?.activeRunKey).toBeNull();
	});

	it("takes the trigger from the receipt, not from the workflow's input", async () => {
		seedSync({ activeRunKey: RUN, automatic: true });
		seedIntegration();
		seedRun({ trigger: "POLL", userId: DELEGATE });

		await recordContextRepositorySyncRun(
			recordInput({
				context: null,
				error: "CLONE_FAILED",
				commitSha: null,
			}),
		);

		expect(committed().audit).toEqual([
			expect.objectContaining({
				metadata: expect.objectContaining({
					trigger: "POLL",
					error: "CLONE_FAILED",
				}),
			}),
		]);
	});

	it.each([
		[
			"a clean run",
			{},
			{
				plan: PLAN,
				commitSha: SHA,
				outcomes: { "docs/a.md": "unchanged" },
			},
			{ kind: "success", commitSha: SHA },
		],
		[
			"a PARTIAL run: every file it could was applied",
			{},
			{
				plan: PLAN,
				commitSha: SHA,
				outcomes: { "docs/a.md": "conflict" },
			},
			{ kind: "success", commitSha: SHA },
		],
		[
			"LIMITS_EXCEEDED at a pinned head",
			{ error: "LIMITS_EXCEEDED" as const },
			{ commitSha: SHA },
			{ kind: "suppress", commitSha: SHA },
		],
		[
			"LIMITS_EXCEEDED before a head was pinned",
			{ error: "LIMITS_EXCEEDED" as const, commitSha: null },
			{},
			{ kind: "backoff" },
		],
		[
			"PATHS_MISSING",
			{ error: "PATHS_MISSING" as const },
			{ commitSha: SHA },
			{ kind: "pause", reason: "REF_MISSING" },
		],
		[
			"REF_MISSING",
			{ error: "REF_MISSING" as const, commitSha: null },
			{},
			{ kind: "pause", reason: "REF_MISSING" },
		],
		[
			"a clone failure",
			{ error: "CLONE_FAILED" as const, commitSha: null },
			{},
			{ kind: "backoff" },
		],
		[
			"a cancellation",
			{ cancelled: true, commitSha: null },
			{},
			{ kind: "backoff" },
		],
	])(
		"schedules %s from its verdict",
		async (_case, input, ledger, effect) => {
			seedSync({ activeRunKey: RUN, automatic: true });
			seedIntegration();
			seedRun({ trigger: "POLL", userId: DELEGATE, ...ledger });

			await recordContextRepositorySyncRun(
				recordInput({
					trigger: "POLL",
					context: context({
						trigger: "POLL",
						actingUserId: DELEGATE,
					}),
					...input,
				}),
			);

			expect(committed().schedule).toEqual([
				{ syncId: SYNC, generation: 3, effect },
			]);
		},
	);

	it.each([
		[
			"CONFIGURATION_CHANGED",
			{ error: "CONFIGURATION_CHANGED" as const },
			{},
		],
		["SUPERSEDED", { error: "SUPERSEDED" as const }, {}],
		[
			"a run of an older generation: the re-configure reset the schedule",
			{},
			{ generation: 4 },
		],
	])("writes no schedule for %s", async (_case, input, sync) => {
		seedSync({ activeRunKey: RUN, automatic: true, ...sync });
		seedIntegration();
		seedRun({ trigger: "POLL", plan: PLAN, commitSha: SHA });

		await recordContextRepositorySyncRun(
			recordInput({ context: context({ trigger: "POLL" }), ...input }),
		);

		expect(runRow()?.finishedAt).not.toBeNull();
		expect(committed().schedule).toEqual([]);
	});

	it("records a manual run's applied head evaluated for the poll", async () => {
		seedSync({ activeRunKey: RUN, automatic: true });
		seedIntegration();
		seedRun({
			trigger: "MANUAL",
			commitSha: SHA,
			plan: PLAN,
			outcomes: { "docs/a.md": "created" },
		});

		await recordContextRepositorySyncRun(recordInput());

		expect(committed().schedule).toEqual([
			{
				syncId: SYNC,
				generation: 3,
				effect: { kind: "success", commitSha: SHA },
			},
		]);
	});

	it.each([
		[
			"PATHS_MISSING",
			{ error: "PATHS_MISSING" as const },
			{ commitSha: SHA },
		],
		["REF_MISSING", { error: "REF_MISSING" as const, commitSha: null }, {}],
		[
			"a clone failure",
			{ error: "CLONE_FAILED" as const, commitSha: null },
			{},
		],
		[
			"a store failure",
			{ error: "STORE_FAILED" as const },
			{ commitSha: SHA },
		],
		["a cancellation", { cancelled: true, commitSha: null }, {}],
		[
			"LIMITS_EXCEEDED before a head was pinned",
			{ error: "LIMITS_EXCEEDED" as const, commitSha: null },
			{},
		],
	])(
		"never pauses or backs off automatic sync for a manual run's %s",
		async (_case, input, ledger) => {
			seedSync({ activeRunKey: RUN, automatic: true, failureCount: 2 });
			seedIntegration();
			seedRun({ trigger: "MANUAL", ...ledger });

			await recordContextRepositorySyncRun(recordInput(input));

			expect(
				h.api.writeContextRepositorySyncScheduling,
			).toHaveBeenCalledWith(
				h.TX,
				expect.objectContaining({ effect: { kind: "none" } }),
			);
			expect(committed().schedule).toEqual([]);
			expect(syncRow()).toMatchObject({
				automaticPausedReason: null,
				failureCount: 2,
			});
		},
	);

	it("suppresses the pinned head a manual run failed on, so the poll does not retry it", async () => {
		seedSync({ activeRunKey: RUN, automatic: true });
		seedIntegration();
		seedRun({ trigger: "MANUAL", commitSha: SHA });

		await recordContextRepositorySyncRun(
			recordInput({ error: "LIMITS_EXCEEDED" }),
		);

		expect(committed().schedule).toEqual([
			{
				syncId: SYNC,
				generation: 3,
				effect: { kind: "suppress", commitSha: SHA },
			},
		]);
	});

	it("writes no schedule when the configuration is gone", async () => {
		seedIntegration();
		seedRun({ trigger: "POLL", plan: PLAN, commitSha: SHA });

		await recordContextRepositorySyncRun(
			recordInput({ context: context({ trigger: "POLL" }) }),
		);

		expect(
			h.api.writeContextRepositorySyncScheduling,
		).not.toHaveBeenCalled();
	});

	it("dates the receipt's completion on the database's clock lock 1 read, not this worker's (Fizzy #2683)", async () => {
		const DB_NOW = new Date("2026-09-23T15:00:00Z");
		seedSync({ activeRunKey: RUN, automatic: true, now: DB_NOW });
		seedIntegration();
		seedRun({ trigger: "POLL", userId: DELEGATE });

		await recordContextRepositorySyncRun(
			recordInput({
				context: null,
				error: "CLONE_FAILED",
				commitSha: null,
			}),
		);

		expect(h.api.completeContextRepositorySyncRun).toHaveBeenCalledWith(
			h.TX,
			RUN,
			expect.objectContaining({ now: DB_NOW }),
		);
		// The scheduling write reads the same clock off the locked row.
		expect(h.api.writeContextRepositorySyncScheduling).toHaveBeenCalledWith(
			h.TX,
			expect.objectContaining({
				sync: expect.objectContaining({ now: DB_NOW }),
			}),
		);
	});

	describe("the re-check request a push or a poll left while the run was open (Fizzy #2673)", () => {
		const PUSHED = "d".repeat(40);

		it("hands the locked row's marker and pause to the scheduling write, which makes the row due now and clears the marker", async () => {
			seedSync({
				activeRunKey: RUN,
				automatic: true,
				pendingCommitSha: PUSHED,
			});
			seedIntegration();
			seedRun({
				trigger: "WEBHOOK",
				userId: DELEGATE,
				commitSha: SHA,
				plan: PLAN,
				outcomes: { "docs/a.md": "created" },
			});

			await recordContextRepositorySyncRun(
				recordInput({
					trigger: "WEBHOOK",
					context: context({
						trigger: "WEBHOOK",
						actingUserId: DELEGATE,
					}),
				}),
			);

			// The same lock-1 read, not a second one: the row the lock
			// returned is what the write folds.
			expect(
				h.api.writeContextRepositorySyncScheduling,
			).toHaveBeenCalledWith(
				h.TX,
				expect.objectContaining({
					sync: expect.objectContaining({
						id: SYNC,
						automaticPausedReason: null,
						pendingCommitSha: PUSHED,
					}),
				}),
			);
			expect(committed().schedule).toEqual([
				{
					syncId: SYNC,
					generation: 3,
					effect: { kind: "success", commitSha: SHA },
					recheck: "due_now",
				},
			]);
			expect(syncRow()?.pendingCommitSha).toBeNull();
		});

		it("a paused row keeps no next check, and the marker goes", async () => {
			seedSync({
				activeRunKey: RUN,
				automatic: true,
				automaticPausedReason: "REF_MISSING",
				pendingCommitSha: PUSHED,
			});
			seedIntegration();
			seedRun({ trigger: "POLL", userId: DELEGATE });

			await recordContextRepositorySyncRun(
				recordInput({
					context: null,
					error: "CLONE_FAILED",
					commitSha: null,
				}),
			);

			expect(committed().schedule).toEqual([
				{
					syncId: SYNC,
					generation: 3,
					effect: { kind: "backoff" },
					recheck: "unscheduled",
				},
			]);
			expect(syncRow()?.pendingCommitSha).toBeNull();
		});

		it("a cancelled manual run's none effect, which schedules nothing, still folds the marker", async () => {
			seedSync({
				activeRunKey: RUN,
				automatic: true,
				pendingCommitSha: PUSHED,
			});
			seedIntegration();
			seedRun({ trigger: "MANUAL" });

			await recordContextRepositorySyncRun(
				recordInput({ cancelled: true, commitSha: null }),
			);

			expect(
				h.api.writeContextRepositorySyncScheduling,
			).toHaveBeenCalledWith(
				h.TX,
				expect.objectContaining({ effect: { kind: "none" } }),
			);

			expect(committed().schedule).toEqual([
				{
					syncId: SYNC,
					generation: 3,
					effect: { kind: "none" },
					recheck: "due_now",
				},
			]);
			expect(syncRow()?.pendingCommitSha).toBeNull();
		});
	});
});

// =============================================================================
// an open run and an automatic-sync toggle (Fizzy #2713)
// =============================================================================

describe("an open automatic run and an automatic-sync toggle (Fizzy #2713)", () => {
	/**
	 * What `configure` writes when the repository, branch and paths are the
	 * stored ones: the flag, the pause and the schedule move; the generation,
	 * the key and the last applied run do not.
	 */
	function toggleAutomatic(automatic: boolean) {
		const row = syncRow() as Row;
		row.automatic = automatic;
		row.automaticPausedReason = null;
		row.failureCount = 0;
	}

	function seedOpenPollRun(overrides: Row = {}) {
		seedSync({ activeRunKey: RUN, automatic: true });
		seedIntegration();
		seedRun({
			trigger: "POLL",
			userId: DELEGATE,
			context: {
				ref: "main",
				paths: ["docs", "notes/glossary.md"],
				repositoryIntegrationId: "int-1",
				actingUserId: DELEGATE,
			},
			...overrides,
		});
	}

	const pollContext = () =>
		context({ trigger: "POLL", actingUserId: DELEGATE });

	it("a retried begin after automatic sync was switched off answers the context it froze: the run is not skipped or fenced", async () => {
		seedOpenPollRun();
		toggleAutomatic(false);
		const before = structuredClone(committed());

		expect(await beginContextRepositorySyncRun(AUTOMATIC)).toEqual({
			ok: true,
			context: pollContext(),
		});
		expect(committed()).toEqual(before);
	});

	it.each([
		["off", false],
		["on", true],
	])(
		"record after automatic sync was switched %s completes the run, names it last applied and writes its schedule",
		async (_label, automatic) => {
			seedOpenPollRun({
				commitSha: SHA,
				plan: PLAN,
				outcomes: { "docs/a.md": "created" },
			});
			toggleAutomatic(automatic);

			expect(
				await recordContextRepositorySyncRun(
					recordInput({ trigger: "POLL", context: pollContext() }),
				),
			).toEqual({ recorded: true, status: "SUCCEEDED", error: null });

			expect(syncRow()).toMatchObject({
				generation: 3,
				activeRunKey: null,
				lastAppliedCommitSha: SHA,
				lastAppliedRunId: RUN,
			});
			expect(committed().schedule).toEqual([
				{
					syncId: SYNC,
					generation: 3,
					effect: { kind: "success", commitSha: SHA },
				},
			]);
		},
	);

	describe("a PERMISSION_DENIED recorded after a re-enable", () => {
		/** The run acted as DELEGATE and failed its CONTEXT_CREATE re-check. */
		async function recordDenied() {
			return recordContextRepositorySyncRun(
				recordInput({
					trigger: "POLL",
					context: pollContext(),
					error: "PERMISSION_DENIED",
				}),
			);
		}

		it("still pauses automatic sync while the configuration's member lacks CONTEXT_CREATE", async () => {
			seedOpenPollRun({ commitSha: SHA });

			await recordDenied();

			expect(h.api.canCreateProjectContexts).toHaveBeenCalledWith(
				PROJECT,
				DELEGATE,
				h.TX,
			);
			expect(committed().schedule).toEqual([
				{
					syncId: SYNC,
					generation: 3,
					effect: { kind: "pause", reason: "PERMISSION_REVOKED" },
				},
			]);
		});

		it.each([
			["another member re-enabled it", "user-7"],
			[
				"its member's permission was restored and they re-enabled it",
				DELEGATE,
			],
		])(
			"does not pause it again when %s: the receipt still completes FAILED and releases the key",
			async (_label, member) => {
				seedOpenPollRun({ commitSha: SHA });
				// What the re-enable wrote while the run waited to record.
				(syncRow() as Row).userId = member;
				h.state.permitted.add(member);

				expect(await recordDenied()).toEqual({
					recorded: true,
					status: "FAILED",
					error: "PERMISSION_DENIED",
				});

				expect(h.api.canCreateProjectContexts).toHaveBeenCalledWith(
					PROJECT,
					member,
					h.TX,
				);
				expect(
					h.api.writeContextRepositorySyncScheduling,
				).toHaveBeenCalledWith(
					h.TX,
					expect.objectContaining({ effect: { kind: "none" } }),
				);
				expect(committed().schedule).toEqual([]);
				expect(runRow()).toMatchObject({
					status: "FAILED",
					error: "PERMISSION_DENIED",
				});
				expect(syncRow()).toMatchObject({
					activeRunKey: null,
					automaticPausedReason: null,
				});
				expect(committed().audit).toEqual([
					expect.objectContaining({
						actor: { type: "user", userId: DELEGATE },
						metadata: expect.objectContaining({
							error: "PERMISSION_DENIED",
						}),
					}),
				]);
			},
		);

		it("still folds a re-check request left while the run was open: due now", async () => {
			seedOpenPollRun({ commitSha: SHA });
			(syncRow() as Row).userId = "user-7";
			(syncRow() as Row).pendingCommitSha = "e".repeat(40);
			h.state.permitted.add("user-7");

			await recordDenied();

			expect(committed().schedule).toEqual([
				{
					syncId: SYNC,
					generation: 3,
					effect: { kind: "none" },
					recheck: "due_now",
				},
			]);
			expect(syncRow()?.pendingCommitSha).toBeNull();
		});
	});
});

// =============================================================================
// record without a context: the receipt, found by its run (§11.1, Decision 7)
// =============================================================================

describe("recordContextRepositorySyncRun without a context", () => {
	it.each([
		["a cancellation", { cancelled: true }],
		["a crash", { error: "STORE_FAILED" as const }],
		["no error at all", {}],
	])(
		"completes an open receipt whose configuration is gone as FAILED/CONFIGURATION_CHANGED, whatever the workflow saw (%s), with its audit row and no schedule",
		async (_case, input) => {
			// Disabled or disconnected after begin inserted the receipt and
			// before its answer arrived: the receipt survives (Fizzy #2672)
			// and nothing else would ever close it.
			seedIntegration();
			seedRun({ trigger: "WEBHOOK", userId: DELEGATE });

			const result = await recordContextRepositorySyncRun(
				recordInput({ context: null, commitSha: null, ...input }),
			);

			expect(result).toEqual({
				recorded: true,
				status: "FAILED",
				error: "CONFIGURATION_CHANGED",
			});
			expect(runRow()).toMatchObject({
				status: "FAILED",
				error: "CONFIGURATION_CHANGED",
			});
			expect(runRow()?.finishedAt).not.toBeNull();
			expect(h.state.log).toEqual([`lock:run:${RUN}`]);
			expect(committed().audit).toEqual([
				expect.objectContaining({
					action: "project.context.repository_sync_completed",
					severity: "warning",
					outcome: "failure",
					actor: { type: "user", userId: DELEGATE },
					metadata: expect.objectContaining({
						runId: RUN,
						trigger: "WEBHOOK",
						status: "FAILED",
						error: "CONFIGURATION_CHANGED",
					}),
				}),
			]);
			expect(
				h.api.writeContextRepositorySyncScheduling,
			).not.toHaveBeenCalled();
			expect(
				h.api.findContextRepositorySyncRunReceiptByWorkflowRunId,
			).toHaveBeenCalledWith(RUN_ID, {
				projectId: PROJECT,
				organizationId: ORG,
			});
		},
	);

	it("treats a configuration replaced by one of another id as gone, and leaves the new one alone", async () => {
		const successor = "sync-2";
		seedSync({
			id: successor,
			automatic: true,
			activeRunKey: `${successor}:run-x`,
		});
		seedIntegration();
		seedRun();
		const successorBefore = structuredClone(syncRow());

		const result = await recordContextRepositorySyncRun(
			recordInput({ context: null, cancelled: true, commitSha: null }),
		);

		expect(result).toEqual({
			recorded: true,
			status: "FAILED",
			error: "CONFIGURATION_CHANGED",
		});
		expect(runRow()).toMatchObject({
			syncId: SYNC,
			status: "FAILED",
			error: "CONFIGURATION_CHANGED",
		});
		// Looked for under the current configuration first, by its exact key.
		expect(h.api.getContextRepositorySyncRun).toHaveBeenCalledWith(
			`${successor}:${RUN_ID}`,
			{ projectId: PROJECT, organizationId: ORG },
		);
		expect(syncRow()).toEqual(successorBefore);
		expect(committed().schedule).toEqual([]);
		expect(committed().audit).toHaveLength(1);
	});

	it("leaves a receipt whose configuration is gone alone once it is finished", async () => {
		seedIntegration();
		seedRun({
			finishedAt: new Date("2026-09-23T12:30:00Z"),
			status: "FAILED",
			error: "INTERRUPTED",
		});
		const before = structuredClone(committed());

		expect(
			await recordContextRepositorySyncRun(
				recordInput({
					context: null,
					cancelled: true,
					commitSha: null,
				}),
			),
		).toEqual({ recorded: false, status: "FAILED", error: "INTERRUPTED" });
		expect(committed()).toEqual(before);
	});

	it("records nothing, and opens no transaction, for a run begin skipped", async () => {
		seedSync({ automatic: false });
		seedIntegration();

		expect(
			await recordContextRepositorySyncRun(
				recordInput({
					trigger: "POLL",
					context: null,
					commitSha: null,
				}),
			),
		).toEqual({ recorded: false, status: null, error: null });
		expect(h.api.db.$transaction).not.toHaveBeenCalled();
	});

	it("never finds another tenant's receipt", async () => {
		seedIntegration();
		seedRun({ organizationId: "org-other" });
		const before = structuredClone(committed());

		expect(
			await recordContextRepositorySyncRun(
				recordInput({
					context: null,
					cancelled: true,
					commitSha: null,
				}),
			),
		).toEqual({ recorded: false, status: null, error: null });
		expect(committed()).toEqual(before);
		expect(h.api.db.$transaction).not.toHaveBeenCalled();
	});
});
