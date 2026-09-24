/**
 * An in-memory fake of exactly the `@repo/database` helpers the Living
 * Memory sync activity calls (design 2026-09-23 §4.3, §4.5, §5.3.1), with
 * the semantics their own tests pin
 * (`packages/database/__tests__/context-repository-sync-queries.test.ts`):
 *
 *  - the fence copies the committed tables, locks the configuration row and
 *    then the run row (logged in that order), answers
 *    `configuration-changed` / `superseded` without running its callback,
 *    and commits the callback's writes only when it returns;
 *  - the pin and the plan are written once; the ledger keeps each key's
 *    first decision;
 *  - the apply batch's outcome table and the prune batch's guarded deletes,
 *    with the cleanup record in the batch's own transaction, stamped with
 *    the run key.
 *
 * Used by `project-context-repository-sync-tree.test.ts` and
 * `project-context-repository-sync-real-git.test.ts` through
 * `vi.mock("@repo/database", …)`, so it imports nothing from that package:
 * the two pure helpers the rules need come from their source file.
 */
import { createHash } from "node:crypto";
import {
	ContextSourcePathError,
	normalizeContextSourcePath,
} from "@repo/database/prisma/queries/projects/context-source-path";
import { vi } from "vitest";

export type Row = Record<string, unknown>;

type Tables = {
	sync: Row[];
	run: Row[];
	context: Row[];
	cleanup: Row[];
	integration: Row[];
};

const empty = (): Tables => ({
	sync: [],
	run: [],
	context: [],
	cleanup: [],
	integration: [],
});

const clone = <T>(value: T): T =>
	value === undefined ? value : structuredClone(value);

export const TX = { __transaction: true } as const;

export const store = {
	committed: empty(),
	current: null as Tables | null,
	/** Locks and the writes that matter for ordering, in the order taken. */
	log: [] as string[],
	permitted: new Set<string>(),
	fenceCalls: 0,
	/**
	 * Runs before the Nth fence (1-based) takes its locks: mutate
	 * `store.committed` to move the configuration or the run, or throw to
	 * fail the transaction as the database would.
	 */
	beforeFence: null as null | ((call: number) => void),
	/** Keys whose guarded update or adopt matches nothing (a concurrent writer). */
	racedKeys: new Set<string>(),
	/** Fail this many `recordContextRepositorySyncPrune` calls, inside the transaction. */
	failRecordPrune: 0,
	nextId: 1,
};

export const tables = (): Tables => store.current ?? store.committed;
export const committed = (): Tables => store.committed;

export function resetStore(): void {
	store.committed = empty();
	store.current = null;
	store.log = [];
	store.permitted = new Set(["user-1"]);
	store.fenceCalls = 0;
	store.beforeFence = null;
	store.racedKeys = new Set();
	store.failRecordPrune = 0;
	store.nextId = 1;
}

export const sha256 = (text: string): string =>
	createHash("sha256").update(text, "utf8").digest("hex");

const runOf = (runKey: string) => {
	const row = tables().run.find((r) => r.id === runKey);
	if (!row) {
		throw new Error(`fake store: no run ${runKey}`);
	}
	return row;
};

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

const basename = (key: string) => key.slice(key.lastIndexOf("/") + 1);

type Fence = {
	syncId: string;
	generation: number;
	runKey: string;
	projectId: string;
	organizationId: string;
};

export const databaseMock = {
	normalizeContextSourcePath,
	ContextSourcePathError,
	hashContextContent: (content: string) => sha256(content),

	withContextRepositorySyncRunFence: vi.fn(
		async (
			fence: Fence,
			fn: (
				tx: unknown,
				locked: { sync: Row; run: Row },
			) => Promise<unknown>,
		) => {
			store.fenceCalls++;
			store.beforeFence?.(store.fenceCalls);
			const work = clone(store.committed);
			store.current = work;
			try {
				const sync = work.sync.find(
					(s) =>
						s.id === fence.syncId &&
						s.projectId === fence.projectId &&
						s.organizationId === fence.organizationId,
				);
				store.log.push("lock:sync");
				if (!sync || sync.generation !== fence.generation) {
					return { status: "configuration-changed" };
				}
				if (sync.activeRunKey !== fence.runKey) {
					return { status: "superseded" };
				}
				const run = work.run.find((r) => r.id === fence.runKey);
				store.log.push("lock:run");
				if (
					!run ||
					run.finishedAt !== null ||
					run.generation !== fence.generation
				) {
					return { status: "superseded" };
				}
				const value = await fn(TX, {
					sync: clone(sync),
					run: ledgerOf(run),
				});
				store.committed = work;
				return { status: "ok", value };
			} finally {
				store.current = null;
			}
		},
	),

	pinContextRepositorySyncRunCommit: vi.fn(
		async (tx: unknown, runKey: string, commitSha: string) => {
			expectTx(tx);
			const run = runOf(runKey);
			const pinnedByThisCall = run.commitSha === null;
			if (pinnedByThisCall) {
				run.commitSha = commitSha;
			}
			return {
				commitSha: run.commitSha as string,
				pinnedByThisCall,
				plan: clone(run.plan) ?? null,
			};
		},
	),

	writeContextRepositorySyncRunPlan: vi.fn(
		async (tx: unknown, runKey: string, plan: Row) => {
			expectTx(tx);
			const run = runOf(runKey);
			const writtenByThisCall = run.plan === null;
			if (writtenByThisCall) {
				// Through JSON, as the jsonb column stores it.
				run.plan = JSON.parse(JSON.stringify(plan));
				store.log.push("write:plan");
			}
			return { plan: clone(run.plan), writtenByThisCall };
		},
	),

	mergeContextRepositorySyncRunOutcomes: vi.fn(
		async (
			tx: unknown,
			runKey: string,
			outcomes: Record<string, string>,
		) => {
			expectTx(tx);
			const run = runOf(runKey);
			const merged = { ...(run.outcomes as Record<string, string>) };
			for (const [key, outcome] of Object.entries(outcomes)) {
				if (!(key in merged)) {
					merged[key] = outcome;
				}
			}
			run.outcomes = merged;
			return clone(merged);
		},
	),

	applyRepositoryContextBatch: vi.fn(
		async (
			tx: unknown,
			input: {
				projectId: string;
				organizationId: string;
				syncId: string;
				actingUserId: string;
				files: Array<{
					storageKey: string;
					content: string;
					contentHash: string;
				}>;
				decided: ReadonlySet<string>;
			},
		) => {
			expectTx(tx);
			const outcomes: Record<string, string> = {};
			for (const file of input.files) {
				const key = file.storageKey;
				if (input.decided.has(key) || key in outcomes) {
					continue;
				}
				const row = tables().context.find(
					(c) =>
						c.projectId === input.projectId && c.sourcePath === key,
				);
				if (!row) {
					tables().context.push({
						id: `ctx-${store.nextId++}`,
						projectId: input.projectId,
						organizationId: input.organizationId,
						type: "TEXT",
						sourcePath: key,
						content: file.content,
						contentHash: file.contentHash,
						metadata: { title: basename(key), sourcePath: key },
						repositorySyncId: input.syncId,
						embeddedAt: null,
					});
					store.log.push(`create:${key}`);
					outcomes[key] = "created";
					continue;
				}
				if (row.organizationId !== input.organizationId) {
					outcomes[key] = "path-in-use";
					continue;
				}
				if (row.repositorySyncId === input.syncId) {
					if (row.contentHash === file.contentHash) {
						outcomes[key] = "unchanged";
					} else if (store.racedKeys.has(key)) {
						outcomes[key] = "conflict";
					} else {
						row.content = file.content;
						row.contentHash = file.contentHash;
						row.embeddedAt = null;
						store.log.push(`update:${key}`);
						outcomes[key] = "updated";
					}
					continue;
				}
				if (
					row.repositorySyncId !== null ||
					row.contentHash !== file.contentHash
				) {
					outcomes[key] = "path-in-use";
					continue;
				}
				if (store.racedKeys.has(key)) {
					outcomes[key] = "conflict";
					continue;
				}
				row.repositorySyncId = input.syncId;
				store.log.push(`adopt:${key}`);
				outcomes[key] = "adopted";
			}
			return outcomes;
		},
	),

	listPruneCandidates: vi.fn(
		async (
			projectId: string,
			syncId: string,
			page: { afterKey?: string | null; limit: number },
		) =>
			committed()
				.context.filter(
					(c) =>
						c.projectId === projectId &&
						c.repositorySyncId === syncId &&
						typeof c.sourcePath === "string" &&
						(page.afterKey == null ||
							(c.sourcePath as string) > page.afterKey),
				)
				.sort((a, b) =>
					(a.sourcePath as string) < (b.sourcePath as string)
						? -1
						: 1,
				)
				.slice(0, page.limit)
				.map((c) => ({
					id: c.id as string,
					sourcePath: c.sourcePath as string,
					contentHash: (c.contentHash as string | null) ?? null,
				})),
	),

	pruneRepositoryContextBatch: vi.fn(
		async (
			tx: unknown,
			input: {
				projectId: string;
				organizationId: string;
				syncId: string;
				runKey: string;
				actingUserId: string;
				rows: Array<{
					id: string;
					sourcePath: string;
					contentHash: string | null;
				}>;
			},
		) => {
			expectTx(tx);
			const deletedIds: string[] = [];
			const deletedKeys: string[] = [];
			const conflicts: string[] = [];
			for (const row of input.rows) {
				const before = tables().context.length;
				tables().context = tables().context.filter(
					(c) =>
						!(
							c.id === row.id &&
							c.projectId === input.projectId &&
							c.organizationId === input.organizationId &&
							c.sourcePath === row.sourcePath &&
							c.repositorySyncId === input.syncId &&
							(c.contentHash ?? null) === row.contentHash
						),
				);
				if (tables().context.length < before) {
					deletedIds.push(row.id);
					deletedKeys.push(row.sourcePath);
					store.log.push(`delete:${row.sourcePath}`);
				} else {
					conflicts.push(row.sourcePath);
				}
			}
			let cleanupId: string | null = null;
			if (deletedIds.length > 0) {
				cleanupId = `cleanup-${store.nextId++}`;
				tables().cleanup.push({
					id: cleanupId,
					projectId: input.projectId,
					contextIds: deletedIds,
					userId: null,
					organizationId: input.organizationId,
					syncRunKey: input.runKey,
				});
			}
			return { deletedIds, deletedKeys, conflicts, cleanupId };
		},
	),

	recordContextRepositorySyncPrune: vi.fn(
		async (
			tx: unknown,
			runKey: string,
			batch: {
				removed: number;
				conflicts: string[];
			},
		) => {
			expectTx(tx);
			if (store.failRecordPrune > 0) {
				store.failRecordPrune--;
				throw new Error("fake store: the ledger write failed");
			}
			const run = runOf(runKey);
			const current = (run.pruneConflicts as {
				keys?: string[];
				overflow?: number;
			}) ?? { keys: [], overflow: 0 };
			const keys = new Set(current.keys ?? []);
			for (const key of batch.conflicts) {
				keys.add(key);
			}
			run.pruneConflicts = {
				keys: [...keys],
				overflow: current.overflow ?? 0,
			};
			run.removedCount = (run.removedCount as number) + batch.removed;
			return {
				removedCount: run.removedCount,
				pruneConflicts: run.pruneConflicts,
			};
		},
	),

	listContextRepositorySyncAwaitingIndex: vi.fn(
		async (
			projectId: string,
			syncId: string,
			page: { afterKey?: string | null; limit: number },
		) =>
			committed()
				.context.filter(
					(c) =>
						c.projectId === projectId &&
						c.repositorySyncId === syncId &&
						c.embeddedAt === null &&
						typeof c.sourcePath === "string" &&
						(page.afterKey == null ||
							(c.sourcePath as string) > page.afterKey),
				)
				.sort((a, b) =>
					(a.sourcePath as string) < (b.sourcePath as string)
						? -1
						: 1,
				)
				.slice(0, page.limit)
				.map((c) => ({
					id: c.id as string,
					sourcePath: c.sourcePath as string,
					title:
						((c.metadata as Row | null)?.title as
							| string
							| undefined) ?? basename(c.sourcePath as string),
				})),
	),

	canCreateProjectContexts: vi.fn(
		async (_projectId: string, userId: string, client?: unknown) => {
			expectTx(client);
			store.log.push("permission");
			return store.permitted.has(userId);
		},
	),

	getProjectRepoIntegration: vi.fn(
		async (integrationId: string, projectId: string) =>
			clone(
				committed().integration.find(
					(i) => i.id === integrationId && i.projectId === projectId,
				),
			) ?? null,
	),

	getUserById: vi.fn(async (id: string) => ({ id, name: "Example Member" })),
};

function expectTx(tx: unknown): void {
	if (tx !== TX) {
		throw new Error("fake store: called outside the fence's transaction");
	}
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

export const PROJECT = "proj-1";
export const ORG = "org-1";
export const SYNC = "sync-1";
export const RUN = `${SYNC}:run-a`;

export function seedIntegration(overrides: Row = {}): void {
	committed().integration.push({
		id: "int-1",
		projectId: PROJECT,
		provider: "GITHUB",
		repositoryUrl: "https://github.com/example-org/handbook.git",
		status: "ACTIVE",
		...overrides,
	});
}

export function seedSync(overrides: Row = {}): Row {
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
		...overrides,
	};
	committed().sync.push(row);
	return row;
}

export function seedRun(overrides: Row = {}): Row {
	const row: Row = {
		id: RUN,
		syncId: SYNC,
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user-1",
		generation: 3,
		context: {},
		trigger: "MANUAL",
		startedAt: new Date("2026-09-23T12:00:00Z"),
		finishedAt: null,
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

/** A synced row; managed by the sync unless `repositorySyncId` says otherwise. */
export function seedContext(
	key: string,
	content: string,
	overrides: Row = {},
): Row {
	const row: Row = {
		id: `ctx-${store.nextId++}`,
		projectId: PROJECT,
		organizationId: ORG,
		type: "TEXT",
		sourcePath: key,
		content,
		contentHash: sha256(content),
		metadata: { title: basename(key), sourcePath: key },
		repositorySyncId: SYNC,
		embeddedAt: new Date("2026-09-20T09:00:00Z"),
		...overrides,
	};
	committed().context.push(row);
	return row;
}

export const contextRow = (key: string): Row | undefined =>
	committed().context.find((c) => c.sourcePath === key);
export const runRow = (): Row =>
	committed().run.find((r) => r.id === RUN) as Row;

/**
 * The run's vector cleanup records still queued — what the receipt's live
 * `cleanupPending` counts (`countContextRepositorySyncRunCleanupPending`).
 */
export function queuedCleanupsOf(runKey: string = RUN): Row[] {
	return committed().cleanup.filter((record) => record.syncRunKey === runKey);
}
