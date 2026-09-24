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
 *    still completes the run row when the configuration is gone.
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
	};
	const empty = (): Tables => ({
		sync: [],
		run: [],
		integration: [],
		audit: [],
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
		[
			"the integration is not ACTIVE",
			"INTEGRATION_UNAVAILABLE",
			() => seedIntegration({ status: "REVOKED" }),
			"example-org/handbook",
		],
		["the integration is gone", "INTEGRATION_UNAVAILABLE", () => {}, null],
		[
			"the requester lost CONTEXT_CREATE",
			"PERMISSION_DENIED",
			() => {
				seedIntegration();
				h.state.permitted = new Set();
			},
			"example-org/handbook",
		],
	])(
		"refuses when %s, leaving a finished receipt, a completed audit row and no key",
		async (_case, error, arrange, repository) => {
			seedSync();
			arrange();

			const result = await beginContextRepositorySyncRun(INPUT);

			expect(result).toEqual({ ok: false, error, context: context() });
			expect(runRow()).toMatchObject({ status: "FAILED", error });
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
				}),
			]);
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

	it("without a context, rebuilds the run key from the workflow's run id and completes what begin committed", async () => {
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
