/**
 * Living Memory repository sync — the database layer (design 2026-09-23 §4,
 * §5, Fizzy #2657): configuration, run receipts and ledger, the fence, and
 * the sync's writer.
 *
 * What this pins:
 *  - `configure` locks the configuration row FIRST and reads the managed-row
 *    count under that lock; it refuses a repository change while managed
 *    rows exist (a typed result), bumps the generation and clears
 *    `lastApplied*`, and leaves `activeRunKey` alone;
 *  - the fence locks the configuration row, then the run row, and answers
 *    `configuration-changed` for a moved generation or a missing
 *    configuration, `superseded` for a foreign `activeRunKey` or a finished
 *    receipt — without running the callback — and rolls back what a failing
 *    callback wrote;
 *  - the pin and the plan are written once, a second writer reading the
 *    first's; the apply ledger keeps each key's first decision;
 *  - the apply batch's outcome table: created (no duplicate refusal),
 *    unchanged, updated, adopted, path-in-use and conflict — including an
 *    adopt or update refused because the row moved or changed between the
 *    read and the write, and an insert that lost the path to a concurrent
 *    writer, which does not abort the batch;
 *  - the prune batch's guarded delete and its cleanup record commit together,
 *    and a row whose hash changed is a conflict, recorded once;
 *  - the integration disconnect locks the project row, releases the
 *    coding-instructions sync and the Living Memory sync that read from the
 *    integration, and deletes it, all in one transaction;
 *  - automatic sync (§11.1, Fizzy #2673): `configure` keeps `automatic`
 *    when omitted (off on insert) and resets the whole schedule on every
 *    configure, as the coding-instructions configure does; `record` without
 *    a frozen context finds its receipt by the workflow run id alone, in the
 *    caller's tenant, whether or not the configuration survives.
 *
 * The client is an in-memory store. Each `where` is evaluated (equality, plus
 * the `not`/`gt` operators the queries use), so a guard that is too wide
 * deletes or updates the wrong row here. `$transaction` works on a copy that
 * is committed only when the callback returns; `$queryRaw` answers the two
 * FOR UPDATE locks, and the project row locks the disconnect takes, and logs
 * them in the order they were taken.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/context-repository-sync-queries.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
	type Tables = Record<
		| "sync"
		| "run"
		| "context"
		| "integration"
		| "cleanup"
		| "instructionSync"
		| "project",
		Row[]
	>;
	const empty = (): Tables => ({
		sync: [],
		run: [],
		context: [],
		integration: [],
		cleanup: [],
		instructionSync: [],
		project: [],
	});
	const state = {
		committed: empty(),
		current: null as Tables | null,
		log: [] as string[],
		transactionOptions: [] as unknown[],
		nextId: 1,
	};
	const tables = () => state.current ?? state.committed;

	function matchValue(actual: unknown, condition: unknown): boolean {
		if (
			condition !== null &&
			typeof condition === "object" &&
			!(condition instanceof Date)
		) {
			const c = condition as Record<string, unknown>;
			if ("not" in c) {
				return (actual ?? null) !== c.not;
			}
			if ("gt" in c) {
				return actual != null && String(actual) > String(c.gt);
			}
			if ("endsWith" in c) {
				return (
					typeof actual === "string" &&
					actual.endsWith(String(c.endsWith))
				);
			}
			if ("gte" in c || "lte" in c) {
				const time = (value: unknown) =>
					value instanceof Date ? value.getTime() : Number(value);
				return (
					actual != null &&
					(!("gte" in c) || time(actual) >= time(c.gte)) &&
					(!("lte" in c) || time(actual) <= time(c.lte))
				);
			}
			throw new Error(
				`fake store: unsupported operator ${JSON.stringify(condition)}`,
			);
		}
		return (actual ?? null) === condition;
	}
	const matches = (row: Row, where: Row = {}) =>
		Object.entries(where).every(([key, value]) =>
			matchValue(row[key], value),
		);
	const clone = <T>(value: T): T =>
		value === undefined ? value : structuredClone(value);
	function pick(row: Row | undefined, select?: Row) {
		if (!row) {
			return null;
		}
		if (!select) {
			return clone(row);
		}
		return Object.fromEntries(
			Object.keys(select).map((key) => [key, clone(row[key] ?? null)]),
		);
	}
	function applyData(row: Row, data: Row) {
		for (const [key, value] of Object.entries(data)) {
			if (
				value !== null &&
				typeof value === "object" &&
				"increment" in (value as Row)
			) {
				row[key] =
					((row[key] as number) ?? 0) +
					((value as { increment: number }).increment ?? 0);
			} else {
				row[key] = clone(value);
			}
		}
		row.updatedAt = new Date();
	}
	function uniqueViolation() {
		return Object.assign(new Error("Unique constraint failed"), {
			code: "P2002",
		});
	}

	type Table = keyof Tables;
	const uniqueKeys: Partial<Record<Table, string[][]>> = {
		sync: [["id"], ["projectId"]],
		run: [["id"]],
		context: [["id"], ["projectId", "sourcePath"]],
	};
	const collides = (table: Table, candidate: Row) =>
		(uniqueKeys[table] ?? []).some((key) =>
			tables()[table].some((row) =>
				key.every(
					(column) =>
						candidate[column] != null &&
						row[column] === candidate[column],
				),
			),
		);
	const defaults: Partial<Record<Table, () => Row>> = {
		sync: () => ({
			generation: 1,
			activeRunKey: null,
			lastAppliedCommitSha: null,
			lastAppliedRunId: null,
		}),
		run: () => ({
			finishedAt: null,
			status: null,
			error: null,
			commitSha: null,
			plan: null,
			outcomes: {},
			removedCount: 0,
			pruneConflicts: {},
		}),
		context: () => ({
			repositorySyncId: null,
			embeddedAt: null,
			sourcePath: null,
		}),
	};
	function insert(table: Table, data: Row): Row {
		const row: Row = {
			id: `${table}-${state.nextId++}`,
			...(defaults[table]?.() ?? {}),
			...clone(data),
		};
		tables()[table].push(row);
		return row;
	}

	function model(table: Table) {
		type Args = {
			where?: Row;
			select?: Row;
			data?: Row | Row[];
			orderBy?: unknown;
			take?: number;
			skipDuplicates?: boolean;
		};
		const rows = () => tables()[table];
		const ordered = (hit: Row[], orderBy: unknown) => {
			const order = orderBy as
				| Record<string, "asc" | "desc">
				| Record<string, "asc" | "desc">[]
				| undefined;
			const keys = Array.isArray(order) ? order : order ? [order] : [];
			return [...hit].sort((x, y) => {
				for (const entry of keys) {
					const [key, dir] = Object.entries(entry)[0] as [
						string,
						"asc" | "desc",
					];
					const [a, b] = [x[key], y[key]].map((v) =>
						v instanceof Date ? v.getTime() : String(v),
					) as [string | number, string | number];
					if (a !== b) {
						const cmp = a < b ? -1 : 1;
						return dir === "asc" ? cmp : -cmp;
					}
				}
				return 0;
			});
		};
		return {
			findFirst: vi.fn(async (a: Args) =>
				pick(
					ordered(
						rows().filter((r) => matches(r, a.where)),
						a.orderBy,
					)[0],
					a.select,
				),
			),
			findUnique: vi.fn(async (a: Args) =>
				pick(
					rows().find((r) => matches(r, a.where)),
					a.select,
				),
			),
			findUniqueOrThrow: vi.fn(async (a: Args) => {
				const row = rows().find((r) => matches(r, a.where));
				if (!row) {
					throw new Error(`No ${table} found`);
				}
				return pick(row, a.select);
			}),
			findMany: vi.fn(async (a: Args) => {
				let hit = rows().filter((r) => matches(r, a.where));
				const order = a.orderBy as
					| Record<string, "asc" | "desc">
					| Record<string, "asc" | "desc">[]
					| undefined;
				const keys = Array.isArray(order)
					? order
					: order
						? [order]
						: [];
				hit = [...hit].sort((x, y) => {
					for (const entry of keys) {
						const [key, dir] = Object.entries(entry)[0] as [
							string,
							"asc" | "desc",
						];
						const cmp = String(x[key]) < String(y[key]) ? -1 : 1;
						if (x[key] !== y[key]) {
							return dir === "asc" ? cmp : -cmp;
						}
					}
					return 0;
				});
				return hit
					.slice(0, a.take ?? hit.length)
					.map((r) => pick(r, a.select));
			}),
			count: vi.fn(
				async (a: Args) =>
					rows().filter((r) => matches(r, a.where)).length,
			),
			create: vi.fn(async (a: Args) => {
				const data = a.data as Row;
				if (collides(table, data)) {
					throw uniqueViolation();
				}
				return pick(insert(table, data), a.select);
			}),
			createMany: vi.fn(async (a: Args) => {
				let count = 0;
				for (const data of a.data as Row[]) {
					if (collides(table, data)) {
						if (!a.skipDuplicates) {
							throw uniqueViolation();
						}
						continue;
					}
					insert(table, data);
					count++;
				}
				return { count };
			}),
			update: vi.fn(async (a: Args) => {
				const row = rows().find((r) => matches(r, a.where));
				if (!row) {
					throw Object.assign(new Error("Record not found"), {
						code: "P2025",
					});
				}
				applyData(row, a.data as Row);
				return pick(row, a.select);
			}),
			updateMany: vi.fn(async (a: Args) => {
				const hit = rows().filter((r) => matches(r, a.where));
				for (const row of hit) {
					applyData(row, a.data as Row);
				}
				return { count: hit.length };
			}),
			delete: vi.fn(async (a: Args) => {
				const row = rows().find((r) => matches(r, a.where));
				if (!row) {
					throw Object.assign(new Error("Record not found"), {
						code: "P2025",
					});
				}
				tables()[table] = rows().filter((r) => r !== row);
				return pick(row, a.select);
			}),
			deleteMany: vi.fn(async (a: Args) => {
				const before = rows().length;
				tables()[table] = rows().filter((r) => !matches(r, a.where));
				return { count: before - tables()[table].length };
			}),
		};
	}

	const models = {
		projectContextRepositorySync: model("sync"),
		projectContextRepositorySyncRun: model("run"),
		projectContext: model("context"),
		projectRepositoryIntegration: model("integration"),
		projectContextPendingVectorCleanup: model("cleanup"),
		// The coding-instructions sync and the project row, for the
		// disconnect that releases both syncs in one transaction.
		projectInstructionRepositorySync: model("instructionSync"),
		project: model("project"),
	};

	const LOCK_RUN = 'FROM "project_context_repository_sync_run"';
	const LOCK_SYNC = 'FROM "project_context_repository_sync"';
	const $queryRaw = vi.fn(
		async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.join("?");
			if (sql.includes(LOCK_RUN)) {
				state.log.push("lock:run");
				const row = tables().run.find((r) => r.id === values[0]);
				return row
					? [
							pick(row, {
								id: 1,
								syncId: 1,
								projectId: 1,
								organizationId: 1,
								userId: 1,
								generation: 1,
								finishedAt: 1,
							}),
						]
					: [];
			}
			if (sql.includes(LOCK_SYNC)) {
				state.log.push("lock:sync");
				const byId = /WHERE "id" =/.test(sql);
				const where = byId
					? {
							id: values[0],
							projectId: values[1],
							organizationId: values[2],
						}
					: { projectId: values[0], organizationId: values[1] };
				const row = tables().sync.find((r) => matches(r, where));
				return row
					? [
							pick(row, {
								id: 1,
								projectId: 1,
								organizationId: 1,
								userId: 1,
								repositoryIntegrationId: 1,
								ref: 1,
								paths: 1,
								generation: 1,
								activeRunKey: 1,
								automatic: 1,
								automaticPausedReason: 1,
								failureCount: 1,
							}),
						]
					: [];
			}
			if (/FROM "project"\s/.test(sql)) {
				if (sql.includes('"instructionSettings"')) {
					// `writeProjectInstructionSettings`' lock.
					state.log.push("lock:project-settings");
					const row = tables().project.find((r) =>
						matches(r, {
							id: values[0],
							organizationId: values[1],
						}),
					);
					return row ? [pick(row, { instructionSettings: 1 })] : [];
				}
				state.log.push("lock:project");
				const row = tables().project.find((r) => r.id === values[0]);
				return row ? [pick(row, { id: 1 })] : [];
			}
			throw new Error(`fake store: unexpected $queryRaw: ${sql}`);
		},
	);
	const $executeRaw = vi.fn(
		async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.join("?");
			if (sql.includes('SET "plan" =')) {
				const [json, runKey] = values as [string, string];
				const row = tables().run.find(
					(r) =>
						r.id === runKey &&
						r.plan === null &&
						r.finishedAt === null,
				);
				if (!row) {
					return 0;
				}
				row.plan = JSON.parse(json);
				return 1;
			}
			throw new Error(`fake store: unexpected $executeRaw: ${sql}`);
		},
	);

	const client = { ...models, $queryRaw, $executeRaw };
	const $transaction = vi.fn(
		async (
			callback: (tx: unknown) => Promise<unknown>,
			options?: unknown,
		) => {
			state.transactionOptions.push(options);
			const work = structuredClone(state.committed);
			state.current = work;
			try {
				const result = await callback(client);
				state.committed = work;
				return result;
			} finally {
				state.current = null;
			}
		},
	);

	return {
		state,
		models,
		$queryRaw,
		$executeRaw,
		$transaction,
		db: { ...client, $transaction },
		reset() {
			state.committed = empty();
			state.current = null;
			state.log = [];
			state.transactionOptions = [];
			state.nextId = 1;
		},
		insert,
	};
});

vi.mock("../prisma/client", () => ({
	db: h.db,
	Prisma: { sql: vi.fn(), join: vi.fn() },
}));
// Imported by the coding-instructions module the disconnect releases
// through; neither is reached by the release itself.
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: vi.fn() }));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: vi.fn(),
}));

import {
	acquireContextRepositorySyncRunKey,
	applyRepositoryContextBatch,
	CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS,
	type ContextSyncPlan,
	type ContextSyncRunFence,
	completeContextRepositorySyncRun,
	completeInterruptedContextRepositorySyncRuns,
	countAwaitingIndexContexts,
	countContextRepositorySyncRunCleanupPending,
	countManagedContexts,
	deleteContextRepositorySync,
	findContextRepositorySyncRunReceiptByWorkflowRunId,
	getContextRepositorySyncRun,
	getContextRepositorySyncRunForUpdate,
	getContextSyncIntegration,
	getNewestContextRepositorySyncRun,
	insertContextRepositorySyncRun,
	listContextRepositorySyncAwaitingIndex,
	listPruneCandidates,
	listUnfinishedContextRepositorySyncRuns,
	mergeContextRepositorySyncRunOutcomes,
	pinContextRepositorySyncRunCommit,
	pruneRepositoryContextBatch,
	type RepositoryContextFile,
	recordContextRepositorySyncLastApplied,
	recordContextRepositorySyncPrune,
	releaseContextRepositorySyncRunKey,
	upsertContextRepositorySync,
	withContextRepositorySyncRunFence,
	writeContextRepositorySyncRunPlan,
} from "../prisma/queries/projects/context-repository-sync";
import { deleteRepoIntegrationReleasingSyncs } from "../prisma/queries/projects/repository-integration-disconnect";

/** Run `fn` in the fake store's transaction, keeping its result type. */
function inTx<T>(fn: (tx: never) => Promise<T>): Promise<T> {
	return h.$transaction(
		fn as (tx: unknown) => Promise<unknown>,
	) as Promise<T>;
}

const PROJECT = "proj-1";
const ORG = "org-1";
const SYNC = "sync-1";
const RUN = `${SYNC}:run-a`;
/** The tenant every read of a sync's managed rows is scoped to. */
const SCOPE = { projectId: PROJECT, organizationId: ORG };
const committed = () => h.state.committed;

function seedIntegration(overrides: Row = {}) {
	committed().integration.push({
		id: "int-1",
		projectId: PROJECT,
		status: "ACTIVE",
		...overrides,
	});
}

function seedSync(overrides: Row = {}): Row {
	const row: Row = {
		id: SYNC,
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user-1",
		repositoryIntegrationId: "int-1",
		ref: "main",
		paths: ["docs"],
		generation: 3,
		activeRunKey: RUN,
		lastAppliedCommitSha: "c0ffee",
		lastAppliedRunId: "sync-1:run-0",
		automatic: false,
		nextCheckAt: new Date("2026-09-23T11:00:00Z"),
		failureCount: 0,
		automaticPausedReason: null,
		automaticPausedAt: null,
		suppressedCommitSha: null,
		suppressedGeneration: null,
		lastEvaluatedCommitSha: null,
		lastEvaluatedGeneration: null,
		pendingCommitSha: null,
		...overrides,
	};
	committed().sync.push(row);
	return row;
}

function seedRun(overrides: Row = {}): Row {
	const row: Row = {
		id: RUN,
		syncId: SYNC,
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user-2",
		generation: 3,
		context: {
			ref: "main",
			paths: ["docs"],
			repositoryIntegrationId: "int-1",
			actingUserId: "user-2",
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
		pruneConflicts: {},
		...overrides,
	};
	committed().run.push(row);
	return row;
}

function seedContext(overrides: Row = {}): Row {
	const row: Row = {
		id: `ctx-${h.state.nextId++}`,
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user-1",
		type: "TEXT",
		content: "old",
		sourcePath: "docs/a.md",
		contentHash: "hash-old",
		metadata: { title: "a.md", sourcePath: "docs/a.md" },
		repositorySyncId: null,
		embeddedAt: new Date("2026-09-20T09:00:00Z"),
		...overrides,
	};
	committed().context.push(row);
	return row;
}

const FENCE: ContextSyncRunFence = {
	syncId: SYNC,
	generation: 3,
	runKey: RUN,
	projectId: PROJECT,
	organizationId: ORG,
};

const PLAN: ContextSyncPlan = {
	keptCount: 2,
	excludedCount: 1,
	attentionCount: 0,
	attention: [],
	protectedPrefixes: [],
	missingPaths: [],
	keptKeys: ["docs/a.md", "docs/b.md"],
	protectedKeys: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	h.reset();
});

// =============================================================================
// configure / disable
// =============================================================================

describe("upsertContextRepositorySync (configure, §5.1)", () => {
	const input = {
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user-9",
		repositoryIntegrationId: "int-1",
		ref: "release",
		paths: ["docs", "notes/glossary.md"],
	};

	it("creates the configuration at generation 1 with the caller as its user, under a 30-second transaction", async () => {
		seedIntegration();

		const result = await upsertContextRepositorySync(input);

		expect(result).toEqual({
			status: "configured",
			sync: {
				id: expect.any(String),
				generation: 1,
				repositoryIntegrationId: "int-1",
				ref: "release",
				paths: ["docs", "notes/glossary.md"],
				automatic: false,
			},
			previous: null,
		});
		expect(committed().sync).toHaveLength(1);
		expect(committed().sync[0]).toMatchObject({
			projectId: PROJECT,
			organizationId: ORG,
			userId: "user-9",
			activeRunKey: null,
		});
		expect(h.state.transactionOptions).toEqual([
			{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
		]);
		expect(CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS).toBe(30_000);
	});

	it("re-configuring bumps the generation, clears lastApplied*, re-delegates to the caller and leaves activeRunKey alone", async () => {
		seedIntegration();
		seedSync();

		const result = await upsertContextRepositorySync(input);

		expect(result).toMatchObject({
			status: "configured",
			sync: { id: SYNC, generation: 4, ref: "release" },
			previous: {
				repositoryIntegrationId: "int-1",
				ref: "main",
				paths: ["docs"],
			},
		});
		expect(committed().sync[0]).toMatchObject({
			generation: 4,
			userId: "user-9",
			lastAppliedCommitSha: null,
			lastAppliedRunId: null,
			// An in-flight run is fenced by the bump, not released.
			activeRunKey: RUN,
		});
	});

	it("refuses a repository change while the configuration manages rows, writing nothing, and counts them under the lock", async () => {
		seedIntegration();
		seedIntegration({ id: "int-2" });
		seedSync();
		seedContext({ repositorySyncId: SYNC });
		seedContext({ repositorySyncId: SYNC, sourcePath: "docs/b.md" });
		seedContext({ sourcePath: "docs/c.md" });

		const result = await upsertContextRepositorySync({
			...input,
			repositoryIntegrationId: "int-2",
		});

		expect(result).toEqual({
			status: "repository-change-requires-disconnect",
			managedCount: 2,
			currentRepositoryIntegrationId: "int-1",
		});
		expect(committed().sync[0]).toMatchObject({
			repositoryIntegrationId: "int-1",
			generation: 3,
			ref: "main",
		});
		// The count is read INSIDE the lock-1 transaction: the lock was taken
		// before the count ran.
		const lockOrder = h.$queryRaw.mock.invocationCallOrder[0] ?? 0;
		const countOrder =
			h.models.projectContext.count.mock.invocationCallOrder[0] ?? 0;
		expect(lockOrder).toBeGreaterThan(0);
		expect(countOrder).toBeGreaterThan(lockOrder);
		expect(h.models.projectContext.count).toHaveBeenCalledWith({
			where: {
				projectId: PROJECT,
				organizationId: ORG,
				repositorySyncId: SYNC,
			},
		});
	});

	it("allows a repository change once nothing is managed", async () => {
		seedIntegration();
		seedIntegration({ id: "int-2" });
		seedSync();

		const result = await upsertContextRepositorySync({
			...input,
			repositoryIntegrationId: "int-2",
		});

		expect(result).toMatchObject({
			status: "configured",
			sync: { repositoryIntegrationId: "int-2", generation: 4 },
		});
	});

	it.each([
		["belongs to another project", { projectId: "proj-2" }],
		["is not ACTIVE", { status: "TOKEN_EXPIRED" }],
	])("refuses an integration that %s", async (_label, overrides) => {
		seedIntegration(overrides);

		expect(await upsertContextRepositorySync(input)).toEqual({
			status: "integration-unavailable",
		});
		expect(committed().sync).toEqual([]);
	});

	it("creates the configuration with automatic sync off and a fresh schedule, due now (§11.1)", async () => {
		seedIntegration();
		const before = Date.now();

		await upsertContextRepositorySync(input);

		const row = committed().sync[0];
		expect(row).toMatchObject({
			automatic: false,
			failureCount: 0,
			automaticPausedReason: null,
			automaticPausedAt: null,
			suppressedCommitSha: null,
			suppressedGeneration: null,
			lastEvaluatedCommitSha: null,
			lastEvaluatedGeneration: null,
			pendingCommitSha: null,
		});
		expect((row?.nextCheckAt as Date).getTime()).toBeGreaterThanOrEqual(
			before,
		);
	});

	it("creates the configuration with automatic sync on when asked", async () => {
		seedIntegration();

		const result = await upsertContextRepositorySync({
			...input,
			automatic: true,
		});

		expect(result).toMatchObject({ sync: { automatic: true } });
		expect(committed().sync[0]?.automatic).toBe(true);
	});

	it("re-configuring keeps automatic sync when omitted and resets the whole schedule: pause, suppression, cursor, pending re-check and failures, due now (§11.1)", async () => {
		seedIntegration();
		seedSync({
			automatic: true,
			failureCount: 4,
			nextCheckAt: new Date("2026-09-23T18:00:00Z"),
			automaticPausedReason: "REF_MISSING",
			automaticPausedAt: new Date("2026-09-23T10:00:00Z"),
			suppressedCommitSha: "a".repeat(40),
			suppressedGeneration: 3,
			lastEvaluatedCommitSha: "b".repeat(40),
			lastEvaluatedGeneration: 3,
			// A re-check request belongs to the old generation; due now
			// covers it (Fizzy #2673, the twin of #2682).
			pendingCommitSha: "e".repeat(40),
		});
		const before = Date.now();

		const result = await upsertContextRepositorySync(input);

		expect(result).toMatchObject({
			sync: { id: SYNC, generation: 4, automatic: true },
		});
		const row = committed().sync[0];
		expect(row).toMatchObject({
			automatic: true,
			generation: 4,
			failureCount: 0,
			automaticPausedReason: null,
			automaticPausedAt: null,
			suppressedCommitSha: null,
			suppressedGeneration: null,
			lastEvaluatedCommitSha: null,
			lastEvaluatedGeneration: null,
			pendingCommitSha: null,
		});
		expect((row?.nextCheckAt as Date).getTime()).toBeGreaterThanOrEqual(
			before,
		);
	});

	it("re-configuring with automatic off turns it off", async () => {
		seedIntegration();
		seedSync({ automatic: true });

		const result = await upsertContextRepositorySync({
			...input,
			automatic: false,
		});

		expect(result).toMatchObject({ sync: { automatic: false } });
		expect(committed().sync[0]?.automatic).toBe(false);
	});

	it("a refused repository change leaves automatic sync and its schedule alone", async () => {
		seedIntegration();
		seedIntegration({ id: "int-2" });
		seedSync({ automatic: true, failureCount: 2 });
		seedContext({ repositorySyncId: SYNC });

		await upsertContextRepositorySync({
			...input,
			repositoryIntegrationId: "int-2",
			automatic: false,
		});

		expect(committed().sync[0]).toMatchObject({
			automatic: true,
			failureCount: 2,
			generation: 3,
		});
	});

	it("a concurrent first configure that loses the project's unique key re-points the winner's row", async () => {
		seedIntegration();
		h.models.projectContextRepositorySync.create.mockImplementationOnce(
			async () => {
				// The other request's configuration committed first.
				seedSync({ generation: 1, activeRunKey: null });
				throw Object.assign(new Error("Unique constraint failed"), {
					code: "P2002",
				});
			},
		);

		const result = await upsertContextRepositorySync(input);

		expect(result).toMatchObject({
			status: "configured",
			sync: { id: SYNC, generation: 2, ref: "release" },
		});
		expect(committed().sync).toHaveLength(1);
	});
});

describe("findContextRepositorySyncRunReceiptByWorkflowRunId (§5.4, Fizzy #2672)", () => {
	it("finds a receipt by the workflow run id alone, whether or not its configuration survives", async () => {
		// No configuration row at all: disabled after begin inserted this.
		seedRun({ id: `${SYNC}:run-z`, syncId: SYNC });

		expect(
			await findContextRepositorySyncRunReceiptByWorkflowRunId("run-z", {
				projectId: PROJECT,
				organizationId: ORG,
			}),
		).toEqual({ id: `${SYNC}:run-z`, syncId: SYNC });
	});

	it("finds a receipt keyed under a configuration another one has replaced", async () => {
		seedSync({ id: "sync-new", activeRunKey: null });
		seedRun({ id: "sync-old:run-z", syncId: "sync-old" });

		expect(
			await findContextRepositorySyncRunReceiptByWorkflowRunId("run-z", {
				projectId: PROJECT,
				organizationId: ORG,
			}),
		).toEqual({ id: "sync-old:run-z", syncId: "sync-old" });
	});

	it("never answers with another tenant's receipt, a poll check's receipt, or another run's", async () => {
		seedRun({ id: `${SYNC}:run-z`, organizationId: "org-other" });
		seedRun({ id: `${SYNC}:run-z`, projectId: "proj-other" });
		// A poll check's receipt `<syncId>:<pollRunId>:<generation>`.
		seedRun({ id: `${SYNC}:run-z:3` });
		seedRun({ id: `${SYNC}:run-zz` });
		// A key whose prefix is not its own sync id.
		seedRun({ id: "other:run-z", syncId: SYNC });

		expect(
			await findContextRepositorySyncRunReceiptByWorkflowRunId("run-z", {
				projectId: PROJECT,
				organizationId: ORG,
			}),
		).toBeNull();
		expect(
			await findContextRepositorySyncRunReceiptByWorkflowRunId("", {
				projectId: PROJECT,
				organizationId: ORG,
			}),
		).toBeNull();
	});
});

describe("deleteContextRepositorySync (disable, §5.1)", () => {
	it("counts the managed rows under the lock, deletes the configuration and keeps its receipts", async () => {
		seedSync();
		seedRun({ finishedAt: new Date(), status: "SUCCEEDED" });
		seedContext({ repositorySyncId: SYNC });

		const result = await deleteContextRepositorySync({
			projectId: PROJECT,
			organizationId: ORG,
		});

		expect(result).toEqual({
			deleted: true,
			syncId: SYNC,
			managedCount: 1,
			repositoryIntegrationId: "int-1",
			activeRunKey: RUN,
		});
		expect(committed().sync).toEqual([]);
		expect(committed().run).toHaveLength(1);
		expect(h.state.log).toEqual(["lock:sync"]);
		expect(h.state.transactionOptions).toEqual([{ timeout: 30_000 }]);
	});

	it("never locks or deletes another organization's configuration", async () => {
		seedSync({ organizationId: "org-2" });

		expect(
			await deleteContextRepositorySync({
				projectId: PROJECT,
				organizationId: ORG,
			}),
		).toMatchObject({ deleted: false, managedCount: 0 });
		expect(committed().sync).toHaveLength(1);
	});
});

// =============================================================================
// The fence
// =============================================================================

describe("withContextRepositorySyncRunFence (§4.5)", () => {
	it("locks the configuration row, then the run row, runs the callback with the ledger, and commits its writes", async () => {
		seedSync();
		seedRun({ outcomes: { "docs/a.md": "created" } });
		const fn = vi.fn(async (tx: unknown, locked: { run: Row }) => {
			await (
				tx as typeof h.db
			).projectContextRepositorySyncRun.updateMany({
				where: { id: RUN },
				data: { removedCount: 7 },
			});
			return locked.run.outcomes;
		});

		const result = await withContextRepositorySyncRunFence(
			FENCE,
			fn as never,
		);

		expect(result).toEqual({
			status: "ok",
			value: { "docs/a.md": "created" },
		});
		expect(h.state.log).toEqual(["lock:sync", "lock:run"]);
		expect(committed().run[0]?.removedCount).toBe(7);
		expect(h.state.transactionOptions).toEqual([{ timeout: 30_000 }]);
	});

	it("binds the configuration lock to the run's project and organization", async () => {
		seedSync();
		seedRun();

		await withContextRepositorySyncRunFence(FENCE, async () => null);

		const [strings, ...values] = h.$queryRaw.mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		const sql = strings.join(" ");
		expect(sql).toContain('FROM "project_context_repository_sync"');
		// The pause and the re-check request are read under this lock, so a
		// run's scheduling write folds the marker in without a second read
		// (Fizzy #2673, the twin of #2682).
		expect(sql).toContain('"automaticPausedReason"');
		expect(sql).toContain('"pendingCommitSha"');
		// And the database's clock, read under that lock, which a completion
		// or a refusal dates its receipt and next check from (Fizzy #2683).
		expect(sql).toContain(
			`(clock_timestamp() AT TIME ZONE 'UTC') AS "now"`,
		);
		expect(sql).toContain('"projectId" =');
		expect(sql).toContain('"organizationId" =');
		expect(sql).toContain("FOR UPDATE");
		expect(values).toEqual([SYNC, PROJECT, ORG]);
	});

	it.each([
		["the generation moved", { generation: 4 }],
		[
			"the configuration belongs to another organization",
			{
				organizationId: "org-2",
			},
		],
	])(
		"is configuration-changed, running nothing, when %s",
		async (_label, overrides) => {
			seedSync(overrides);
			seedRun();
			const fn = vi.fn();

			expect(await withContextRepositorySyncRunFence(FENCE, fn)).toEqual({
				status: "configuration-changed",
			});
			expect(fn).not.toHaveBeenCalled();
			expect(h.state.log).toEqual(["lock:sync"]);
		},
	);

	it("is configuration-changed when the configuration is gone", async () => {
		seedRun();
		const fn = vi.fn();

		expect(await withContextRepositorySyncRunFence(FENCE, fn)).toEqual({
			status: "configuration-changed",
		});
		expect(fn).not.toHaveBeenCalled();
	});

	it.each([
		["another run holds the configuration", "sync-1:run-b"],
		["no run holds it (a reconciliation released it)", null],
	])(
		"is superseded, running nothing, when %s",
		async (_label, activeRunKey) => {
			seedSync({ activeRunKey });
			seedRun();
			const fn = vi.fn();

			expect(await withContextRepositorySyncRunFence(FENCE, fn)).toEqual({
				status: "superseded",
			});
			expect(fn).not.toHaveBeenCalled();
		},
	);

	it("is superseded when the run's receipt is finished", async () => {
		seedSync();
		seedRun({
			finishedAt: new Date(),
			status: "FAILED",
			error: "INTERRUPTED",
		});
		const fn = vi.fn();

		expect(await withContextRepositorySyncRunFence(FENCE, fn)).toEqual({
			status: "superseded",
		});
		expect(fn).not.toHaveBeenCalled();
		expect(h.state.log).toEqual(["lock:sync", "lock:run"]);
	});

	it("is superseded when the run has no receipt", async () => {
		seedSync();
		const fn = vi.fn();

		expect(await withContextRepositorySyncRunFence(FENCE, fn)).toEqual({
			status: "superseded",
		});
		expect(fn).not.toHaveBeenCalled();
	});

	it("rolls back everything the callback wrote when it throws", async () => {
		seedSync();
		seedRun();
		seedContext();

		await expect(
			withContextRepositorySyncRunFence(FENCE, async (tx) => {
				await tx.projectContext.deleteMany({
					where: { projectId: PROJECT },
				});
				throw new Error("vector queue unavailable");
			}),
		).rejects.toThrow("vector queue unavailable");

		expect(committed().context).toHaveLength(1);
	});
});

describe("getContextRepositorySyncRunForUpdate (lock 3)", () => {
	it("returns the typed ledger of an unfinished run", async () => {
		seedRun({
			outcomes: { "docs/a.md": "created", "docs/b.md": "bogus" },
			pruneConflicts: { keys: ["docs/x.md"], overflow: 2 },
			plan: PLAN,
			commitSha: "abc123",
		});

		const lock = await inTx((tx) =>
			getContextRepositorySyncRunForUpdate(tx as never, RUN),
		);

		expect(lock).toMatchObject({
			status: "ok",
			run: {
				id: RUN,
				commitSha: "abc123",
				plan: PLAN,
				// An entry outside the closed vocabulary is not a decision.
				outcomes: { "docs/a.md": "created" },
				pruneConflicts: { keys: ["docs/x.md"], overflow: 2 },
				context: { actingUserId: "user-2", paths: ["docs"] },
			},
		});
	});
});

// =============================================================================
// Receipts and the ledger
// =============================================================================

describe("run receipts", () => {
	it("inserts a receipt once, with ON CONFLICT DO NOTHING semantics", async () => {
		const run = {
			id: RUN,
			syncId: SYNC,
			projectId: PROJECT,
			organizationId: ORG,
			userId: "user-2",
			generation: 3,
			context: {
				ref: "main",
				paths: ["docs"],
				repositoryIntegrationId: "int-1",
				actingUserId: "user-2",
			},
			trigger: "MANUAL" as const,
			startedAt: new Date("2026-09-23T12:00:00Z"),
		};

		expect(
			await insertContextRepositorySyncRun(h.db as never, run),
		).toEqual({ inserted: true });
		expect(
			await insertContextRepositorySyncRun(h.db as never, run),
		).toEqual({ inserted: false });
		expect(committed().run).toHaveLength(1);
		expect(committed().run[0]).toMatchObject({
			finishedAt: null,
			status: null,
		});
	});

	it("inserts a refusal's receipt already finished, so history shows it", async () => {
		await insertContextRepositorySyncRun(h.db as never, {
			id: RUN,
			syncId: SYNC,
			projectId: PROJECT,
			organizationId: ORG,
			userId: "user-2",
			generation: 3,
			context: {
				ref: "main",
				paths: ["docs"],
				repositoryIntegrationId: "int-1",
				actingUserId: "user-2",
			},
			trigger: "MANUAL",
			startedAt: new Date("2026-09-23T12:00:00Z"),
			finished: {
				at: new Date("2026-09-23T12:00:01Z"),
				status: "FAILED",
				error: "RUN_IN_PROGRESS",
			},
		});

		expect(committed().run[0]).toMatchObject({
			finishedAt: new Date("2026-09-23T12:00:01Z"),
			status: "FAILED",
			error: "RUN_IN_PROGRESS",
		});
	});

	it("lists a sync's unfinished receipts oldest first, at most 20 by default", async () => {
		await listUnfinishedContextRepositorySyncRuns(SYNC);

		expect(
			h.models.projectContextRepositorySyncRun.findMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { syncId: SYNC, finishedAt: null },
				orderBy: [{ startedAt: "asc" }, { id: "asc" }],
				take: 20,
			}),
		);
	});

	it("completes a receipt once and answers a repeat with the stored receipt", async () => {
		seedRun();
		const first = await inTx((tx) =>
			completeContextRepositorySyncRun(tx as never, RUN, {
				status: "PARTIAL",
				error: null,
				now: new Date("2026-09-23T12:05:00Z"),
			}),
		);
		const second = await inTx((tx) =>
			completeContextRepositorySyncRun(tx as never, RUN, {
				status: "FAILED",
				error: "INTERRUPTED",
				now: new Date("2026-09-23T13:00:00Z"),
			}),
		);

		expect(first).toMatchObject({
			completed: true,
			run: { status: "PARTIAL", error: null },
		});
		expect(second).toMatchObject({
			completed: false,
			run: {
				status: "PARTIAL",
				finishedAt: new Date("2026-09-23T12:05:00Z"),
			},
		});
	});
});

describe("the pin and the plan are written once (§4.3, §5.3.1 steps 3 and 6)", () => {
	it("pins the first head and hands a second writer the winner's", async () => {
		seedRun();

		const first = await inTx((tx) =>
			pinContextRepositorySyncRunCommit(tx as never, RUN, "aaa111"),
		);
		const second = await inTx((tx) =>
			pinContextRepositorySyncRunCommit(tx as never, RUN, "bbb222"),
		);

		expect(first).toEqual({
			commitSha: "aaa111",
			pinnedByThisCall: true,
			plan: null,
		});
		expect(second).toEqual({
			commitSha: "aaa111",
			pinnedByThisCall: false,
			plan: null,
		});
		expect(committed().run[0]?.commitSha).toBe("aaa111");
	});

	it("writes the first plan and hands a second writer the stored one, even when its own plan differs", async () => {
		seedRun();
		const other: ContextSyncPlan = {
			...PLAN,
			keptCount: 1,
			keptKeys: ["docs/a.md"],
		};

		const first = await inTx((tx) =>
			writeContextRepositorySyncRunPlan(tx as never, RUN, PLAN),
		);
		const second = await inTx((tx) =>
			writeContextRepositorySyncRunPlan(tx as never, RUN, other),
		);

		expect(first).toEqual({ plan: PLAN, writtenByThisCall: true });
		expect(second).toEqual({ plan: PLAN, writtenByThisCall: false });
		const [strings] = h.$executeRaw.mock.calls[0] as [TemplateStringsArray];
		expect(strings.join(" ")).toContain('"plan" IS NULL');
	});

	it("hands the stored plan back with the pin, so a retry skips planning", async () => {
		seedRun({ plan: PLAN, commitSha: "aaa111" });

		expect(
			await inTx((tx) =>
				pinContextRepositorySyncRunCommit(tx as never, RUN, "bbb222"),
			),
		).toEqual({ commitSha: "aaa111", pinnedByThisCall: false, plan: PLAN });
	});
});

describe("mergeContextRepositorySyncRunOutcomes (§4.3)", () => {
	it("keeps each key's first decision and adds only undecided keys", async () => {
		seedRun({
			outcomes: { "docs/a.md": "conflict", "docs/b.md": "created" },
		});

		const merged = await inTx((tx) =>
			mergeContextRepositorySyncRunOutcomes(tx as never, RUN, {
				"docs/a.md": "updated",
				"docs/c.md": "adopted",
			}),
		);

		expect(merged).toEqual({
			"docs/a.md": "conflict",
			"docs/b.md": "created",
			"docs/c.md": "adopted",
		});
		expect(committed().run[0]?.outcomes).toEqual(merged);
	});

	it("writes nothing when every key was already decided", async () => {
		seedRun({ outcomes: { "docs/a.md": "created" } });

		await inTx((tx) =>
			mergeContextRepositorySyncRunOutcomes(tx as never, RUN, {
				"docs/a.md": "unchanged",
			}),
		);

		expect(
			h.models.projectContextRepositorySyncRun.update,
		).not.toHaveBeenCalled();
	});

	it("keeps a key named __proto__ as a key", async () => {
		seedRun();

		const merged = await inTx((tx) =>
			mergeContextRepositorySyncRunOutcomes(
				tx as never,
				RUN,
				JSON.parse('{"__proto__":"created"}'),
			),
		);

		expect(Object.keys(merged)).toEqual(["__proto__"]);
		expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
	});

	it("refuses to grow the ledger past 5 000 keys", async () => {
		seedRun({
			outcomes: Object.fromEntries(
				Array.from({ length: 5_000 }, (_, i) => [
					`k/${i}.md`,
					"created",
				]),
			),
		});

		await expect(
			inTx((tx) =>
				mergeContextRepositorySyncRunOutcomes(tx as never, RUN, {
					"k/extra.md": "created",
				}),
			),
		).rejects.toThrow("at most 5000");
	});
});

// =============================================================================
// The writer: apply
// =============================================================================

function applyBatch(files: RepositoryContextFile[], decided: string[] = []) {
	return inTx((tx) =>
		applyRepositoryContextBatch(tx as never, {
			projectId: PROJECT,
			organizationId: ORG,
			syncId: SYNC,
			actingUserId: "user-2",
			files,
			decided: new Set(decided),
		}),
	);
}

const file = (
	storageKey: string,
	contentHash: string,
	extra: Partial<RepositoryContextFile> = {},
): RepositoryContextFile => ({
	storageKey,
	contentHash,
	content: `content of ${storageKey} at ${contentHash}`,
	...extra,
});

describe("applyRepositoryContextBatch — the outcome table (§5.3.1 step 7)", () => {
	it("decides every key of a batch, skipping decided and repeated keys", async () => {
		const unchanged = seedContext({
			sourcePath: "docs/same.md",
			contentHash: "h-same",
			repositorySyncId: SYNC,
		});
		const updated = seedContext({
			sourcePath: "docs/changed.md",
			contentHash: "h-old",
			repositorySyncId: SYNC,
			embeddedAt: new Date(),
		});
		const adopted = seedContext({
			sourcePath: "docs/pushed.md",
			contentHash: "h-pushed",
		});
		const inUse = seedContext({
			sourcePath: "docs/local.md",
			contentHash: "h-local",
		});
		const decided = seedContext({
			sourcePath: "docs/decided.md",
			contentHash: "h-x",
		});

		const outcomes = await applyBatch(
			[
				file("docs/new.md", "h-new"),
				file("docs/same.md", "h-same"),
				file("docs/changed.md", "h-new-version"),
				file("docs/pushed.md", "h-pushed"),
				file("docs/local.md", "h-repo"),
				file("docs/decided.md", "h-y"),
				file("docs/new.md", "h-new-again"),
			],
			["docs/decided.md"],
		);

		expect(outcomes).toEqual({
			"docs/new.md": "created",
			"docs/same.md": "unchanged",
			"docs/changed.md": "updated",
			"docs/pushed.md": "adopted",
			"docs/local.md": "path-in-use",
		});
		const rows = new Map(
			committed().context.map((row) => [row.sourcePath, row]),
		);
		expect(rows.get("docs/same.md")).toEqual(unchanged);
		expect(rows.get("docs/changed.md")).toMatchObject({
			id: updated.id,
			contentHash: "h-new-version",
			contentUpdatedByUserId: "user-2",
			embeddedAt: null,
			repositorySyncId: SYNC,
		});
		expect(rows.get("docs/pushed.md")).toMatchObject({
			id: adopted.id,
			repositorySyncId: SYNC,
			contentHash: "h-pushed",
			// Adoption changes ownership, never content or its stamps.
			userId: "user-1",
		});
		expect(rows.get("docs/local.md")).toEqual(inUse);
		expect(rows.get("docs/decided.md")).toEqual(decided);
		expect(rows.get("docs/new.md")?.contentHash).toBe("h-new");
	});

	it("creates a managed TEXT row stamped with the acting user, titled by its file name, with no duplicate-by-hash refusal", async () => {
		seedContext({ sourcePath: "notes/copy.md", contentHash: "h-dup" });

		const outcomes = await applyBatch([
			file("docs/guide/setup.md", "h-dup", { content: "# Setup\n" }),
		]);

		expect(outcomes).toEqual({ "docs/guide/setup.md": "created" });
		const created = committed().context.find(
			(row) => row.sourcePath === "docs/guide/setup.md",
		);
		expect(created).toMatchObject({
			projectId: PROJECT,
			organizationId: ORG,
			userId: "user-2",
			type: "TEXT",
			content: "# Setup\n",
			contentHash: "h-dup",
			contentUpdatedByUserId: "user-2",
			metadata: { title: "setup.md", sourcePath: "docs/guide/setup.md" },
			repositorySyncId: SYNC,
			embeddedAt: null,
		});
		expect(created?.contentUpdatedAt).toBeInstanceOf(Date);
	});

	it("keys an update on the row, the project, the tenant, the path, the hash read and this sync", async () => {
		const row = seedContext({ repositorySyncId: SYNC });

		await applyBatch([file("docs/a.md", "hash-new", { title: "Guide" })]);

		expect(
			h.models.projectContext.updateMany.mock.calls[0]?.[0].where,
		).toEqual({
			id: row.id,
			projectId: PROJECT,
			organizationId: ORG,
			sourcePath: "docs/a.md",
			contentHash: "hash-old",
			repositorySyncId: SYNC,
		});
		expect(committed().context[0]?.metadata).toEqual({
			title: "Guide",
			sourcePath: "docs/a.md",
		});
	});

	it("keys an adopt on the row, the project, the tenant, the path, the hash and no owner", async () => {
		const row = seedContext({ contentHash: "h-1" });

		await applyBatch([file("docs/a.md", "h-1")]);

		expect(h.models.projectContext.updateMany.mock.calls[0]?.[0]).toEqual({
			where: {
				id: row.id,
				projectId: PROJECT,
				organizationId: ORG,
				sourcePath: "docs/a.md",
				contentHash: "h-1",
				repositorySyncId: null,
			},
			data: { repositorySyncId: SYNC },
		});
	});

	/** Change the row between the batch's read and its guarded write. */
	function interfereAfterRead(id: string, change: Row) {
		h.models.projectContext.findFirst.mockImplementationOnce(
			async (args) => {
				const rows = h.state.current?.context ?? [];
				const row = rows.find((r) => r.id === id);
				const snapshot = row ? structuredClone(row) : null;
				if (row) {
					Object.assign(row, change);
				}
				return snapshot
					? Object.fromEntries(
							Object.keys(args.select ?? snapshot).map((key) => [
								key,
								snapshot[key] ?? null,
							]),
						)
					: null;
			},
		);
	}

	it.each([
		["moved to another path", { sourcePath: "docs/moved.md" }],
		["changed by a CLI push", { contentHash: "h-2", content: "edited" }],
		["adopted by another run", { repositorySyncId: "sync-other" }],
	])(
		"refuses to adopt a row %s between the read and the write: conflict",
		async (_label, change) => {
			const row = seedContext({ contentHash: "h-1" });
			interfereAfterRead(row.id as string, change);

			const outcomes = await applyBatch([file("docs/a.md", "h-1")]);

			expect(outcomes).toEqual({ "docs/a.md": "conflict" });
			expect(committed().context[0]).toMatchObject(change);
			expect(committed().context[0]?.repositorySyncId ?? null).toBe(
				(change as Row).repositorySyncId ?? null,
			);
		},
	);

	it("refuses to update a managed row released between the read and the write: conflict", async () => {
		const row = seedContext({ repositorySyncId: SYNC });
		interfereAfterRead(row.id as string, { repositorySyncId: null });

		expect(await applyBatch([file("docs/a.md", "hash-new")])).toEqual({
			"docs/a.md": "conflict",
		});
		expect(committed().context[0]).toMatchObject({
			contentHash: "hash-old",
			repositorySyncId: null,
		});
	});

	it("does not abort the batch when a concurrent push takes the path before the insert: the key is decided from that row", async () => {
		h.models.projectContext.createMany.mockImplementationOnce(async () => {
			h.insert("context", {
				projectId: PROJECT,
				organizationId: ORG,
				sourcePath: "docs/race.md",
				contentHash: "h-cli",
			});
			return { count: 0 };
		});

		const outcomes = await applyBatch([
			file("docs/race.md", "h-repo"),
			file("docs/after.md", "h-after"),
		]);

		expect(outcomes).toEqual({
			"docs/race.md": "path-in-use",
			"docs/after.md": "created",
		});
		expect(
			h.models.projectContext.createMany.mock.calls[1]?.[0],
		).toMatchObject({ skipDuplicates: true });
	});

	it("never touches another tenant's or another sync's row at the path", async () => {
		const foreign = seedContext({
			sourcePath: "docs/x.md",
			contentHash: "h-x",
			organizationId: "org-2",
		});
		const otherSync = seedContext({
			sourcePath: "docs/y.md",
			contentHash: "h-y",
			repositorySyncId: "sync-other",
		});

		expect(
			await applyBatch([
				file("docs/x.md", "h-x"),
				file("docs/y.md", "h-y"),
			]),
		).toEqual({ "docs/x.md": "path-in-use", "docs/y.md": "path-in-use" });
		expect(committed().context).toEqual([foreign, otherSync]);
		expect(h.models.projectContext.updateMany).not.toHaveBeenCalled();
	});
});

// =============================================================================
// The writer: prune
// =============================================================================

describe("prune (§5.3.1 step 8)", () => {
	function pruneBatch(rows: Row[]) {
		return inTx((tx) =>
			pruneRepositoryContextBatch(tx as never, {
				projectId: PROJECT,
				organizationId: ORG,
				syncId: SYNC,
				runKey: RUN,
				actingUserId: "user-2",
				rows: rows.map((row) => ({
					id: row.id as string,
					sourcePath: row.sourcePath as string,
					contentHash: row.contentHash as string | null,
				})),
			}),
		);
	}

	it("deletes the managed rows it was given and queues ONE cleanup record for them, in the same transaction", async () => {
		const a = seedContext({ repositorySyncId: SYNC });
		const b = seedContext({
			repositorySyncId: SYNC,
			sourcePath: "docs/b.md",
		});
		const kept = seedContext({
			repositorySyncId: SYNC,
			sourcePath: "docs/kept.md",
		});

		const result = await pruneBatch([a, b]);

		expect(result).toEqual({
			deletedIds: [a.id, b.id],
			deletedKeys: ["docs/a.md", "docs/b.md"],
			conflicts: [],
			cleanupId: expect.any(String),
		});
		expect(committed().context).toEqual([kept]);
		expect(committed().cleanup).toEqual([
			{
				id: result.cleanupId,
				projectId: PROJECT,
				contextIds: [a.id, b.id],
				userId: null,
				organizationId: ORG,
				// The run's identity: its receipt counts the record by it.
				syncRunKey: RUN,
			},
		]);
	});

	it("keys each delete on the row, the project, the tenant, the path, this sync and the hash read", async () => {
		const a = seedContext({ repositorySyncId: SYNC });

		await pruneBatch([a]);

		expect(
			h.models.projectContext.deleteMany.mock.calls[0]?.[0].where,
		).toEqual({
			id: a.id,
			projectId: PROJECT,
			organizationId: ORG,
			sourcePath: "docs/a.md",
			repositorySyncId: SYNC,
			contentHash: "hash-old",
		});
	});

	it.each([
		["whose hash changed", { contentHash: "h-newer" }],
		["released by a disconnect", { repositorySyncId: null }],
	])(
		"is a conflict, deleting nothing, for a row %s since it was listed",
		async (_label, change) => {
			const a = seedContext({ repositorySyncId: SYNC });
			const listed = { ...a };
			committed().context[0] = { ...a, ...change };

			const result = await pruneBatch([listed]);

			expect(result).toEqual({
				deletedIds: [],
				deletedKeys: [],
				conflicts: ["docs/a.md"],
				cleanupId: null,
			});
			expect(committed().context).toHaveLength(1);
			expect(committed().cleanup).toEqual([]);
		},
	);

	it("rolls the deletes back when the cleanup record cannot be written", async () => {
		const a = seedContext({ repositorySyncId: SYNC });
		h.models.projectContextPendingVectorCleanup.create.mockRejectedValueOnce(
			new Error("queue down"),
		);

		await expect(pruneBatch([a])).rejects.toThrow("queue down");

		expect(committed().context).toEqual([a]);
	});

	it("records a batch: counts once, each conflicting key once, at most 100 keys then overflow", async () => {
		seedRun({
			removedCount: 3,
			pruneConflicts: {
				keys: Array.from({ length: 99 }, (_, i) => `k/${i}.md`),
				overflow: 0,
			},
		});

		const recorded = await inTx((tx) =>
			recordContextRepositorySyncPrune(tx as never, RUN, {
				removed: 2,
				conflicts: ["k/0.md", "k/new-1.md", "k/new-2.md", "k/new-3.md"],
			}),
		);

		expect(recorded.removedCount).toBe(5);
		expect(recorded.pruneConflicts.keys).toHaveLength(100);
		expect(recorded.pruneConflicts.keys).toContain("k/new-1.md");
		expect(recorded.pruneConflicts.overflow).toBe(2);
		expect(committed().run[0]).toMatchObject({
			removedCount: 5,
			pruneConflicts: recorded.pruneConflicts,
		});
		// No counter: the run's pending cleanups are counted live by key.
		expect(committed().run[0]).not.toHaveProperty("cleanupPending");
	});

	it("pages managed rows by key, after the last key returned", async () => {
		seedContext({ repositorySyncId: SYNC, sourcePath: "docs/c.md" });
		seedContext({ repositorySyncId: SYNC, sourcePath: "docs/a.md" });
		seedContext({ repositorySyncId: SYNC, sourcePath: "docs/b.md" });
		seedContext({ sourcePath: "docs/unowned.md" });
		seedContext({ repositorySyncId: SYNC, projectId: "proj-2" });
		// The right project and sync id, but another organization's.
		seedContext({
			repositorySyncId: SYNC,
			organizationId: "org-2",
			sourcePath: "docs/a0.md",
		});

		const first = await listPruneCandidates(SCOPE, SYNC, { limit: 2 });
		const second = await listPruneCandidates(SCOPE, SYNC, {
			afterKey: first.at(-1)?.sourcePath,
			limit: 2,
		});

		expect(first.map((row) => row.sourcePath)).toEqual([
			"docs/a.md",
			"docs/b.md",
		]);
		expect(second.map((row) => row.sourcePath)).toEqual(["docs/c.md"]);
		expect(first[0]).toEqual({
			id: expect.any(String),
			sourcePath: "docs/a.md",
			contentHash: "hash-old",
		});
	});
});

describe("counts", () => {
	it("counts a sync's managed rows awaiting indexing", async () => {
		seedContext({ repositorySyncId: SYNC, embeddedAt: null });
		seedContext({
			repositorySyncId: SYNC,
			sourcePath: "docs/b.md",
			embeddedAt: new Date(),
		});
		seedContext({ sourcePath: "docs/c.md", embeddedAt: null });

		expect(await countAwaitingIndexContexts(SCOPE, SYNC)).toBe(1);
	});

	it("counts a sync's managed rows in the tenant only", async () => {
		seedContext({ repositorySyncId: SYNC, embeddedAt: null });
		seedContext({ repositorySyncId: SYNC, sourcePath: "docs/b.md" });
		// The right project and sync id, but another organization's.
		seedContext({
			repositorySyncId: SYNC,
			organizationId: "org-2",
			sourcePath: "docs/c.md",
			embeddedAt: null,
		});

		expect(await countManagedContexts(h.db as never, SCOPE, SYNC)).toBe(2);
		expect(await countAwaitingIndexContexts(SCOPE, SYNC)).toBe(1);
	});

	it("pages a sync's managed rows awaiting indexing by key, each with the title its embedding starts under", async () => {
		seedContext({
			repositorySyncId: SYNC,
			sourcePath: "docs/c.md",
			embeddedAt: null,
			metadata: { title: "Glossary", sourcePath: "docs/c.md" },
		});
		seedContext({
			repositorySyncId: SYNC,
			sourcePath: "docs/a.md",
			embeddedAt: null,
			metadata: null,
		});
		seedContext({
			repositorySyncId: SYNC,
			sourcePath: "docs/b.md",
			embeddedAt: null,
		});
		// Indexed, unowned, another sync's, another project's: none of them.
		seedContext({ repositorySyncId: SYNC, sourcePath: "docs/d.md" });
		seedContext({ sourcePath: "docs/e.md", embeddedAt: null });
		seedContext({
			repositorySyncId: "sync-2",
			sourcePath: "docs/f.md",
			embeddedAt: null,
		});
		seedContext({
			repositorySyncId: SYNC,
			projectId: "proj-2",
			sourcePath: "docs/g.md",
			embeddedAt: null,
		});
		// The right project and sync id, but another organization's.
		seedContext({
			repositorySyncId: SYNC,
			organizationId: "org-2",
			sourcePath: "docs/b0.md",
			embeddedAt: null,
		});

		const first = await listContextRepositorySyncAwaitingIndex(
			SCOPE,
			SYNC,
			{ limit: 2 },
		);
		const second = await listContextRepositorySyncAwaitingIndex(
			SCOPE,
			SYNC,
			{ afterKey: first.at(-1)?.sourcePath, limit: 2 },
		);

		expect(first).toEqual([
			{ id: expect.any(String), sourcePath: "docs/a.md", title: "a.md" },
			{ id: expect.any(String), sourcePath: "docs/b.md", title: "a.md" },
		]);
		expect(second).toEqual([
			{
				id: expect.any(String),
				sourcePath: "docs/c.md",
				title: "Glossary",
			},
		]);
	});
});

// =============================================================================
// Reads for the tab (§5.1 `get`)
// =============================================================================

describe("receipt reads for the tab", () => {
	it("reads the newest receipt of the configuration, in the caller's tenant only, with the member's display name", async () => {
		seedRun({
			id: `${SYNC}:run-old`,
			startedAt: new Date("2026-09-23T09:00:00Z"),
			finishedAt: new Date("2026-09-23T09:01:00Z"),
			status: "SUCCEEDED",
		});
		seedRun({
			id: `${SYNC}:run-new`,
			startedAt: new Date("2026-09-23T11:00:00Z"),
			outcomes: { "docs/a.md": "created", bogus: "nope" },
			pruneConflicts: { keys: ["docs/z.md"], overflow: 2 },
			user: { name: "Example Member" },
		});
		// Same sync id under another organization: never read.
		seedRun({
			id: `${SYNC}:run-foreign`,
			organizationId: "org-2",
			startedAt: new Date("2026-09-23T12:30:00Z"),
		});

		const newest = await getNewestContextRepositorySyncRun(SYNC, {
			projectId: PROJECT,
			organizationId: ORG,
		});

		expect(newest).toMatchObject({
			id: `${SYNC}:run-new`,
			outcomes: { "docs/a.md": "created" },
			pruneConflicts: { keys: ["docs/z.md"], overflow: 2 },
			userName: "Example Member",
		});
		expect(newest?.outcomes).not.toHaveProperty("bogus");
	});

	it("reads the run named by lastAppliedRunId only inside the caller's project and organization", async () => {
		seedRun({ finishedAt: new Date(), status: "SUCCEEDED" });

		expect(
			await getContextRepositorySyncRun(RUN, {
				projectId: PROJECT,
				organizationId: ORG,
			}),
		).toMatchObject({ id: RUN, status: "SUCCEEDED", userName: null });
		expect(
			await getContextRepositorySyncRun(RUN, {
				projectId: PROJECT,
				organizationId: "org-2",
			}),
		).toBeNull();
		expect(
			await getContextRepositorySyncRun(RUN, {
				projectId: "proj-2",
				organizationId: ORG,
			}),
		).toBeNull();
	});

	describe("countContextRepositorySyncRunCleanupPending (live, by run key)", () => {
		const run = { id: RUN, projectId: PROJECT, organizationId: ORG };
		const seedCleanup = (overrides: Row) => {
			const record: Row = {
				id: `cleanup-${h.state.nextId++}`,
				projectId: PROJECT,
				organizationId: ORG,
				userId: null,
				contextIds: ["ctx-x"],
				syncRunKey: RUN,
				createdAt: new Date("2026-09-23T12:05:00Z"),
				...overrides,
			};
			committed().cleanup.push(record);
			return record;
		};

		it("counts the records the run's prune queued and no drain has cleared", async () => {
			seedCleanup({});
			seedCleanup({});

			expect(await countContextRepositorySyncRunCleanupPending(run)).toBe(
				2,
			);
			expect(
				h.models.projectContextPendingVectorCleanup.count,
			).toHaveBeenCalledWith({
				where: {
					syncRunKey: RUN,
					projectId: PROJECT,
					organizationId: ORG,
				},
			});
		});

		it("falls when somebody else drains one of the run's records — the sweep, or an abandoned drain that completed later", async () => {
			const first = seedCleanup({});
			seedCleanup({});
			expect(await countContextRepositorySyncRunCleanupPending(run)).toBe(
				2,
			);

			// Removed from the queue directly, as the sweep's clear does,
			// without the run knowing.
			committed().cleanup = committed().cleanup.filter(
				(record) => record.id !== first.id,
			);
			expect(await countContextRepositorySyncRunCleanupPending(run)).toBe(
				1,
			);
			committed().cleanup = [];
			expect(await countContextRepositorySyncRunCleanupPending(run)).toBe(
				0,
			);
		});

		it("never counts another delete's record queued in the run's window, another run's, another project's or another tenant's", async () => {
			seedCleanup({});
			// An unrelated delete of the same project while the run was open.
			seedCleanup({ syncRunKey: null });
			seedCleanup({ syncRunKey: null, createdAt: new Date() });
			// Another run of the same sync.
			seedCleanup({ syncRunKey: `${SYNC}:run-b` });
			// The same key under another project or tenant.
			seedCleanup({ projectId: "proj-2" });
			seedCleanup({ organizationId: "org-2" });

			expect(await countContextRepositorySyncRunCleanupPending(run)).toBe(
				1,
			);
		});
	});
});

// =============================================================================
// Reconciliation (§5.6)
// =============================================================================

describe("completeInterruptedContextRepositorySyncRuns (§5.6, §5.3.0 step 3)", () => {
	const scope = { syncId: SYNC, projectId: PROJECT, organizationId: ORG };
	const NOW = new Date("2026-09-23T14:00:00Z");

	it("completes a predecessor described closed as FAILED/INTERRUPTED, keeps its ledger, and clears the key it held — locks in order", async () => {
		seedSync();
		seedRun({ outcomes: { "docs/a.md": "created" }, removedCount: 2 });

		const result = await completeInterruptedContextRepositorySyncRuns({
			...scope,
			observedUnfinished: [RUN],
			closed: [RUN],
			now: NOW,
		});

		expect(result).toEqual({
			status: "ok",
			completed: [RUN],
			activeRunKey: null,
		});
		expect(committed().run[0]).toMatchObject({
			finishedAt: NOW,
			status: "FAILED",
			error: "INTERRUPTED",
			outcomes: { "docs/a.md": "created" },
			removedCount: 2,
		});
		expect(committed().sync[0]).toMatchObject({ activeRunKey: null });
		expect(h.state.log).toEqual(["lock:sync", "lock:run"]);
		expect(h.state.transactionOptions).toEqual([{ timeout: 30_000 }]);
	});

	it("leaves a predecessor described running (or unknown) alone and reports the key still held", async () => {
		seedSync();
		seedRun();

		const result = await completeInterruptedContextRepositorySyncRuns({
			...scope,
			observedUnfinished: [RUN],
			closed: [],
		});

		expect(result).toEqual({
			status: "ok",
			completed: [],
			activeRunKey: RUN,
		});
		expect(committed().run[0]).toMatchObject({ finishedAt: null });
		expect(committed().sync[0]).toMatchObject({ activeRunKey: RUN });
	});

	it("does not clear a key that names another run than the one it completed", async () => {
		const other = `${SYNC}:run-b`;
		seedSync({ activeRunKey: other });
		seedRun({ startedAt: new Date("2026-09-23T10:00:00Z") });
		seedRun({ id: other, startedAt: new Date("2026-09-23T11:00:00Z") });

		const result = await completeInterruptedContextRepositorySyncRuns({
			...scope,
			observedUnfinished: [RUN, other],
			closed: [RUN],
		});

		expect(result).toEqual({
			status: "ok",
			completed: [RUN],
			activeRunKey: other,
		});
		expect(committed().sync[0]).toMatchObject({ activeRunKey: other });
	});

	it("writes nothing and answers changed when a new unfinished receipt appeared after the read", async () => {
		const late = `${SYNC}:run-late`;
		seedSync();
		seedRun();
		seedRun({ id: late, startedAt: new Date("2026-09-23T12:30:00Z") });

		const result = await completeInterruptedContextRepositorySyncRuns({
			...scope,
			observedUnfinished: [RUN],
			closed: [RUN],
		});

		expect(result).toEqual({ status: "changed" });
		expect(committed().run.every((run) => run.finishedAt === null)).toBe(
			true,
		);
		expect(committed().sync[0]).toMatchObject({ activeRunKey: RUN });
	});

	it("answers changed when a receipt read as unfinished was completed by someone else", async () => {
		seedSync({ activeRunKey: null });
		seedRun({ finishedAt: new Date(), status: "SUCCEEDED" });

		expect(
			await completeInterruptedContextRepositorySyncRuns({
				...scope,
				observedUnfinished: [RUN],
				closed: [RUN],
			}),
		).toEqual({ status: "changed" });
	});

	it("clears a key that names a finished receipt: nothing else ever could", async () => {
		seedSync({ activeRunKey: RUN });
		seedRun({ finishedAt: new Date(), status: "SUCCEEDED" });

		expect(
			await completeInterruptedContextRepositorySyncRuns({
				...scope,
				observedUnfinished: [],
				closed: [],
			}),
		).toEqual({ status: "ok", completed: [], activeRunKey: null });
		expect(committed().sync[0]).toMatchObject({ activeRunKey: null });
	});

	it("ignores a closed key the lock-time read does not list as unfinished", async () => {
		seedSync({ activeRunKey: null });

		expect(
			await completeInterruptedContextRepositorySyncRuns({
				...scope,
				observedUnfinished: [],
				closed: [`${SYNC}:run-ghost`],
			}),
		).toEqual({ status: "ok", completed: [], activeRunKey: null });
		expect(h.state.log).toEqual(["lock:sync"]);
	});

	it("answers not-configured for a configuration gone, or another tenant's", async () => {
		seedSync({ organizationId: "org-2" });
		seedRun();

		expect(
			await completeInterruptedContextRepositorySyncRuns({
				...scope,
				observedUnfinished: [RUN],
				closed: [RUN],
			}),
		).toEqual({ status: "not-configured" });
		expect(committed().run[0]).toMatchObject({ finishedAt: null });
	});
});

// =============================================================================
// Disconnect (§5.1)
// =============================================================================

describe("deleteRepoIntegrationReleasingSyncs (disconnect, §5.1)", () => {
	function seedProject(overrides: Row = {}) {
		committed().project.push({
			id: PROJECT,
			organizationId: ORG,
			instructionSettings: { sourceOfTruth: "REPOSITORY" },
			...overrides,
		});
	}
	function seedInstructionSync(overrides: Row = {}) {
		committed().instructionSync.push({
			id: "instruction-sync-1",
			projectId: PROJECT,
			organizationId: ORG,
			repositoryIntegrationId: "int-1",
			...overrides,
		});
	}

	it("deletes the configuration under its lock with the integration, in one transaction, and reports what it managed", async () => {
		seedProject();
		seedIntegration();
		seedSync();
		seedContext({ repositorySyncId: SYNC });
		seedContext({ repositorySyncId: SYNC, sourcePath: "docs/b.md" });

		const result = await deleteRepoIntegrationReleasingSyncs({
			integrationId: "int-1",
			projectId: PROJECT,
		});

		expect(result).toEqual({
			deletedIntegration: true,
			releasedInstructionSync: null,
			releasedContextSync: {
				syncId: SYNC,
				organizationId: ORG,
				managedCount: 2,
				activeRunKey: RUN,
			},
		});
		expect(committed().sync).toEqual([]);
		expect(committed().integration).toEqual([]);
		// The project row first, then lock 1.
		expect(h.state.log).toEqual(["lock:project", "lock:sync"]);
		expect(h.$transaction).toHaveBeenCalledTimes(1);
		expect(h.state.transactionOptions).toEqual([
			{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
		]);
	});

	it("leaves a configuration that reads from another integration alone", async () => {
		seedIntegration();
		seedIntegration({ id: "int-2" });
		seedSync({ repositoryIntegrationId: "int-2" });

		const result = await deleteRepoIntegrationReleasingSyncs({
			integrationId: "int-1",
			projectId: PROJECT,
		});

		expect(result).toEqual({
			deletedIntegration: true,
			releasedInstructionSync: null,
			releasedContextSync: null,
		});
		expect(committed().sync).toHaveLength(1);
		expect(committed().integration.map((i) => i.id)).toEqual(["int-2"]);
	});

	it("never deletes another project's integration or configuration", async () => {
		seedIntegration({ projectId: "proj-2" });
		seedSync({ projectId: "proj-2" });

		expect(
			await deleteRepoIntegrationReleasingSyncs({
				integrationId: "int-1",
				projectId: PROJECT,
			}),
		).toEqual({
			deletedIntegration: false,
			releasedInstructionSync: null,
			releasedContextSync: null,
		});
		expect(committed().sync).toHaveLength(1);
		expect(committed().integration).toHaveLength(1);
	});

	it("releases both syncs on the same integration and deletes it in a single transaction", async () => {
		seedProject();
		seedIntegration();
		seedInstructionSync();
		seedSync();
		seedContext({ repositorySyncId: SYNC });

		const result = await deleteRepoIntegrationReleasingSyncs({
			integrationId: "int-1",
			projectId: PROJECT,
		});

		expect(result).toEqual({
			deletedIntegration: true,
			releasedInstructionSync: { organizationId: ORG },
			releasedContextSync: {
				syncId: SYNC,
				organizationId: ORG,
				managedCount: 1,
				activeRunKey: RUN,
			},
		});
		expect(committed().instructionSync).toEqual([]);
		expect(committed().sync).toEqual([]);
		expect(committed().integration).toEqual([]);
		// The project is back in upload mode, atomically with the delete.
		expect(committed().project[0]?.instructionSettings).toEqual({
			sourceOfTruth: "UPLOAD",
		});
		// Project row, then (the same row, for the mode flip) the
		// coding-instructions release, then the Living Memory lock 1.
		expect(h.state.log).toEqual([
			"lock:project",
			"lock:project-settings",
			"lock:sync",
		]);
		expect(h.$transaction).toHaveBeenCalledTimes(1);
		expect(h.state.transactionOptions).toEqual([
			{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
		]);
	});

	it("releases neither when no sync reads from the integration, and still deletes it", async () => {
		seedProject();
		seedIntegration();

		expect(
			await deleteRepoIntegrationReleasingSyncs({
				integrationId: "int-1",
				projectId: PROJECT,
			}),
		).toEqual({
			deletedIntegration: true,
			releasedInstructionSync: null,
			releasedContextSync: null,
		});
		expect(committed().integration).toEqual([]);
		expect(committed().project[0]?.instructionSettings).toEqual({
			sourceOfTruth: "REPOSITORY",
		});
		expect(h.state.log).toEqual(["lock:project"]);
		expect(h.$transaction).toHaveBeenCalledTimes(1);
	});
});

// =============================================================================
// Run lifecycle on the configuration row (§5.3.0 begin, §5.4 record — T3)
// =============================================================================

describe("the run key and lastApplied* (begin and record)", () => {
	it("acquires the key only while no run holds it", async () => {
		seedSync({ activeRunKey: null });

		expect(
			await inTx((tx) =>
				acquireContextRepositorySyncRunKey(tx, SYNC, RUN),
			),
		).toBe(true);
		expect(committed().sync[0]?.activeRunKey).toBe(RUN);

		expect(
			await inTx((tx) =>
				acquireContextRepositorySyncRunKey(tx, SYNC, `${SYNC}:run-b`),
			),
		).toBe(false);
		expect(committed().sync[0]?.activeRunKey).toBe(RUN);
	});

	it("releases the key only while it still names the run", async () => {
		seedSync({ activeRunKey: `${SYNC}:run-b` });

		expect(
			await inTx((tx) =>
				releaseContextRepositorySyncRunKey(tx, SYNC, RUN),
			),
		).toBe(false);
		expect(committed().sync[0]?.activeRunKey).toBe(`${SYNC}:run-b`);

		expect(
			await inTx((tx) =>
				releaseContextRepositorySyncRunKey(tx, SYNC, `${SYNC}:run-b`),
			),
		).toBe(true);
		expect(committed().sync[0]?.activeRunKey).toBeNull();
	});

	it("names the last applied run only under the run's fence: same generation, key still held", async () => {
		seedSync();

		expect(
			await inTx((tx) =>
				recordContextRepositorySyncLastApplied(tx, {
					syncId: SYNC,
					generation: 3,
					runKey: RUN,
					commitSha: "d".repeat(40),
				}),
			),
		).toBe(true);
		expect(committed().sync[0]).toMatchObject({
			lastAppliedCommitSha: "d".repeat(40),
			lastAppliedRunId: RUN,
			activeRunKey: RUN,
		});
	});

	it.each([
		["the generation moved", { generation: 4 }],
		["another run holds the key", { activeRunKey: `${SYNC}:run-b` }],
		["no run holds the key", { activeRunKey: null }],
	])("writes nothing when %s", async (_case, overrides) => {
		seedSync(overrides);

		expect(
			await inTx((tx) =>
				recordContextRepositorySyncLastApplied(tx, {
					syncId: SYNC,
					generation: 3,
					runKey: RUN,
					commitSha: "d".repeat(40),
				}),
			),
		).toBe(false);
		expect(committed().sync[0]).toMatchObject({
			lastAppliedCommitSha: "c0ffee",
			lastAppliedRunId: "sync-1:run-0",
		});
	});

	it("reads the configuration's integration inside the project only", async () => {
		seedIntegration({
			repositoryOwner: "example-org",
			repositoryName: "docs",
		});
		seedIntegration({
			id: "int-2",
			projectId: "proj-2",
			repositoryOwner: "example-org",
			repositoryName: "other",
		});

		expect(
			await inTx((tx) =>
				getContextSyncIntegration(tx, {
					repositoryIntegrationId: "int-1",
					projectId: PROJECT,
				}),
			),
		).toEqual({
			status: "ACTIVE",
			repositoryOwner: "example-org",
			repositoryName: "docs",
		});
		expect(
			await inTx((tx) =>
				getContextSyncIntegration(tx, {
					repositoryIntegrationId: "int-2",
					projectId: PROJECT,
				}),
			),
		).toBeNull();
	});
});
