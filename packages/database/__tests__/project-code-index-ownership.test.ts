/**
 * ProjectCodeIndex writes are owned by the indexing chain that last claimed the
 * row.
 *
 * The code-indexing workflow id is stable per repo, and a re-index starts with
 * TERMINATE_EXISTING — which does not stop an activity the terminated run
 * already has in flight. Every writer used to key only on
 * (projectId, repositoryIntegrationId, branch), so a stalled write from the
 * terminated run landed on its successor's row: a late FAILED flipped a READY
 * index, a late init reset it to INDEXING for good.
 *
 * The db is an in-memory fake that evaluates the where-clauses the queries
 * build (equality, `lt`/`lte`, `OR`), so these assert which rows a write lands on,
 * not the shape of the query.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
	rows: [] as Row[],
	seq: 0,
	/** Runs once after the next findFirst; lets a test interleave a concurrent write. */
	afterFindFirst: null as null | (() => void),
}));

function valueMatches(actual: unknown, expected: unknown): boolean {
	if (
		expected !== null &&
		typeof expected === "object" &&
		!(expected instanceof Date)
	) {
		const { lt, lte } = expected as { lt?: Date; lte?: Date };
		if (!(actual instanceof Date)) {
			return false;
		}
		if (lt !== undefined) {
			return actual.getTime() < lt.getTime();
		}
		if (lte !== undefined) {
			return actual.getTime() <= lte.getTime();
		}
		throw new Error(
			`fake db: unsupported filter ${JSON.stringify(expected)}`,
		);
	}
	if (expected instanceof Date) {
		return (
			actual instanceof Date && actual.getTime() === expected.getTime()
		);
	}
	return (actual ?? null) === expected;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, expected]) =>
		key === "OR"
			? (expected as Record<string, unknown>[]).some((sub) =>
					matches(row, sub),
				)
			: valueMatches(row[key], expected),
	);
}

vi.mock("../prisma/client", () => ({
	db: {
		projectCodeIndex: {
			findFirst: async ({
				where,
			}: {
				where: Record<string, unknown>;
			}) => {
				const row = store.rows.find((r) => matches(r, where));
				const hook = store.afterFindFirst;
				store.afterFindFirst = null;
				hook?.();
				return row ? { ...row } : null;
			},
			updateMany: async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const hit = store.rows.filter((r) => matches(r, where));
				for (const row of hit) {
					Object.assign(row, data);
				}
				return { count: hit.length };
			},
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const row = store.rows.find((r) => r.id === where.id);
				if (!row) {
					throw new Error("Record to update not found.");
				}
				Object.assign(row, data);
				return { ...row };
			},
			create: async ({ data }: { data: Record<string, unknown> }) => {
				if (
					store.rows.some(
						(r) =>
							r.projectId === data.projectId &&
							r.repositoryIntegrationId ===
								data.repositoryIntegrationId &&
							r.branch === data.branch,
					)
				) {
					throw Object.assign(new Error("Unique constraint failed"), {
						code: "P2002",
					});
				}
				const row: Row = {
					ownerRunId: null,
					ownerRunStartedAt: null,
					...data,
					id: `idx-${++store.seq}`,
				};
				store.rows.push(row);
				return { ...row };
			},
		},
	},
}));

import {
	type CodeIndexOwner,
	updateCodeIndexProgress,
	updateCodeIndexStats,
	updateCodeIndexStatus,
	upsertProjectCodeIndex,
} from "../prisma/queries/project-code-index";

const KEY = {
	projectId: "proj-1",
	repositoryIntegrationId: "integration-1",
	branch: "main",
};

// A terminated chain and the successor TERMINATE_EXISTING started after it.
const OLDER: CodeIndexOwner = {
	runId: "run-older",
	startedAt: "2026-01-01T10:00:00.000Z",
};
const NEWER: CodeIndexOwner = {
	runId: "run-newer",
	startedAt: "2026-01-01T10:05:00.000Z",
};

function seedRow(overrides: Partial<Row> = {}): Row {
	const row: Row = {
		id: "idx-seeded",
		...KEY,
		userId: "user-1",
		organizationId: "org-1",
		commitSha: "sha-newer",
		status: "READY",
		error: null,
		filesIndexed: 10,
		chunksCreated: 40,
		summariesCreated: 10,
		indexedFileCount: 10,
		totalFileCount: 10,
		ownerRunId: NEWER.runId,
		ownerRunStartedAt: new Date(NEWER.startedAt),
		...overrides,
	};
	store.rows.push(row);
	return row;
}

const STATS = {
	...KEY,
	filesIndexed: 3,
	chunksCreated: 0,
	summariesCreated: 0,
	indexDurationMs: 5,
};

const UPSERT = {
	...KEY,
	userId: "user-1",
	organizationId: "org-1",
	commitSha: "sha-older",
	status: "INDEXING" as const,
	workflowId: "code-index-wf",
};

beforeEach(() => {
	store.rows.length = 0;
	store.seq = 0;
	store.afterFindFirst = null;
});

describe("a superseded chain's late write leaves the successor's row alone", () => {
	it("status: an older chain's FAILED does not flip the newer chain's READY row", async () => {
		const row = seedRow();

		await expect(
			updateCodeIndexStatus(KEY, "FAILED", "late failure", OLDER),
		).resolves.toBe("superseded");

		expect(row).toMatchObject({
			status: "READY",
			error: null,
			ownerRunId: NEWER.runId,
		});
	});

	it("stats: an older chain's finalize does not overwrite the newer chain's totals", async () => {
		const row = seedRow({ status: "INDEXING" });

		await expect(
			updateCodeIndexStats({ ...STATS, owner: OLDER }),
		).resolves.toBe("superseded");

		expect(row).toMatchObject({
			status: "INDEXING",
			filesIndexed: 10,
			chunksCreated: 40,
			ownerRunId: NEWER.runId,
		});
	});

	it("upsert: an older chain's late init does not reset the newer chain's READY row", async () => {
		const row = seedRow();

		await expect(
			upsertProjectCodeIndex({ ...UPSERT, owner: OLDER }),
		).resolves.toBe("superseded");

		expect(row).toMatchObject({
			status: "READY",
			commitSha: "sha-newer",
			indexedFileCount: 10,
			ownerRunId: NEWER.runId,
		});
	});

	it("upsert: the create-race fallback applies the same rule", async () => {
		// The newer chain creates the row between this upsert's findFirst and
		// its create, so the create hits the unique key and falls back.
		store.afterFindFirst = () => seedRow();

		await expect(
			upsertProjectCodeIndex({ ...UPSERT, owner: OLDER }),
		).resolves.toBe("superseded");

		expect(store.rows).toHaveLength(1);
		expect(store.rows[0]).toMatchObject({
			status: "READY",
			commitSha: "sha-newer",
			ownerRunId: NEWER.runId,
		});
	});

	it("progress: an older chain's batch does not move the newer chain's progress bar", async () => {
		const row = seedRow({ status: "INDEXING", indexedFileCount: 50 });

		const result = await updateCodeIndexProgress(
			KEY,
			{ indexedFileCount: 7, totalFileCount: 99 },
			OLDER,
		);

		expect(result.count).toBe(0);
		expect(row).toMatchObject({ indexedFileCount: 50, totalFileCount: 10 });
	});
});

describe("an owned write lands and claims the row", () => {
	it("when the chain already owns it", async () => {
		const row = seedRow({ status: "INDEXING" });

		await expect(
			updateCodeIndexStatus(KEY, "FAILED", "own failure", NEWER),
		).resolves.toBe("written");

		expect(row).toMatchObject({
			status: "FAILED",
			error: "own failure",
			ownerRunId: NEWER.runId,
		});
	});

	it("when an older chain owns it", async () => {
		const row = seedRow({
			ownerRunId: OLDER.runId,
			ownerRunStartedAt: new Date(OLDER.startedAt),
		});

		await expect(
			upsertProjectCodeIndex({
				...UPSERT,
				commitSha: "sha-newer-2",
				owner: NEWER,
			}),
		).resolves.toBe("written");

		expect(row).toMatchObject({
			status: "INDEXING",
			commitSha: "sha-newer-2",
			indexedFileCount: 0,
			totalFileCount: null,
			ownerRunId: NEWER.runId,
			ownerRunStartedAt: new Date(NEWER.startedAt),
		});
	});

	it("when no chain has claimed it yet (a row from before ownership)", async () => {
		const row = seedRow({
			status: "INDEXING",
			ownerRunId: null,
			ownerRunStartedAt: null,
		});

		await expect(
			updateCodeIndexStats({ ...STATS, chunksCreated: 9, owner: OLDER }),
		).resolves.toBe("written");

		expect(row).toMatchObject({
			status: "READY",
			filesIndexed: 3,
			chunksCreated: 9,
			ownerRunId: OLDER.runId,
			ownerRunStartedAt: new Date(OLDER.startedAt),
		});
	});

	it("a create records the owner", async () => {
		await expect(
			upsertProjectCodeIndex({ ...UPSERT, owner: NEWER }),
		).resolves.toBe("written");

		expect(store.rows).toHaveLength(1);
		expect(store.rows[0]).toMatchObject({
			...KEY,
			status: "INDEXING",
			ownerRunId: NEWER.runId,
			ownerRunStartedAt: new Date(NEWER.startedAt),
		});
	});

	it("when a successor started in the same millisecond as the owner (a tie)", async () => {
		// TERMINATE_EXISTING started the successor within the millisecond the
		// terminated chain's latest run started; the column keeps milliseconds,
		// so the two compare equal. Rejecting the successor here would skip its
		// init and finalize and strand the row in the old run's state.
		const row = seedRow({
			status: "INDEXING",
			ownerRunId: OLDER.runId,
			ownerRunStartedAt: new Date(OLDER.startedAt),
		});
		const tiedSuccessor: CodeIndexOwner = {
			runId: "run-tied-successor",
			startedAt: OLDER.startedAt,
		};

		await expect(
			upsertProjectCodeIndex({ ...UPSERT, owner: tiedSuccessor }),
		).resolves.toBe("written");
		await expect(
			updateCodeIndexStats({ ...STATS, owner: tiedSuccessor }),
		).resolves.toBe("written");

		expect(row).toMatchObject({
			status: "READY",
			ownerRunId: "run-tied-successor",
		});
	});

	it("accepts the start time as a Date", async () => {
		const row = seedRow({ status: "INDEXING" });

		await expect(
			updateCodeIndexStatus(KEY, "FAILED", "x", {
				runId: "run-newest",
				startedAt: new Date("2026-01-01T10:10:00.000Z"),
			}),
		).resolves.toBe("written");

		expect(row.ownerRunId).toBe("run-newest");
	});
});

describe("absent and unowned writes", () => {
	it("reports absent when no row exists for the key", async () => {
		await expect(
			updateCodeIndexStatus(KEY, "FAILED", "x", OLDER),
		).resolves.toBe("absent");
		await expect(
			updateCodeIndexStats({ ...STATS, owner: OLDER }),
		).resolves.toBe("absent");
		await expect(updateCodeIndexStatus(KEY, "FAILED", "x")).resolves.toBe(
			"absent",
		);
		expect(store.rows).toHaveLength(0);
	});

	it("a write without an owner stays unconditional and does not claim", async () => {
		const row = seedRow();

		await expect(
			updateCodeIndexStatus(KEY, "FAILED", "Cancelled by user"),
		).resolves.toBe("written");
		await expect(
			updateCodeIndexProgress(KEY, {
				indexedFileCount: 1,
				totalFileCount: 2,
			}),
		).resolves.toEqual({ count: 1 });

		expect(row).toMatchObject({
			status: "FAILED",
			error: "Cancelled by user",
			indexedFileCount: 1,
			ownerRunId: NEWER.runId,
			ownerRunStartedAt: new Date(NEWER.startedAt),
		});
	});

	it("an unowned upsert overwrites any owner's row, as before", async () => {
		const row = seedRow();

		await expect(upsertProjectCodeIndex(UPSERT)).resolves.toBe("written");

		expect(row).toMatchObject({
			status: "INDEXING",
			commitSha: "sha-older",
			ownerRunId: NEWER.runId,
		});
	});
});
