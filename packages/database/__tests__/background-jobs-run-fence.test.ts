/**
 * The chain fence on BackgroundJob writers (`BackgroundJobKey.runId`).
 *
 * Code indexing reuses one workflow id per repo and supersedes a live run with
 * TERMINATE_EXISTING, which does not stop the terminated run's in-flight
 * activities. The start path relabels the repo's open job row with the new
 * chain's first run id, so a fenced write from the old chain must leave that
 * row alone — while an unlabeled row, the chain's own row, and every unfenced
 * caller (all other job kinds) behave as before.
 *
 * The chain then makes an ORDERED claim on the row (`runStartedAt`), so a
 * start request that stalls cannot take the row back from a newer chain, and a
 * superseded chain's late ensure cannot open a ghost row.
 *
 * The Prisma-client writers run against an in-memory fake that evaluates the
 * where-clauses they build (equality, lte/gt, AND, OR) and enforces the
 * one-open-row-per-source unique index; the raw-SQL counter writers are
 * checked on the statement they render.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
	rows: [] as Row[],
	/** Runs once after the next read; lets a test interleave a concurrent write. */
	afterRead: null as null | (() => void),
}));

function afterRead(): void {
	const hook = store.afterRead;
	store.afterRead = null;
	hook?.();
}
const executeRaw = vi.hoisted(() => vi.fn());

function valueMatches(actual: unknown, expected: unknown): boolean {
	if (expected instanceof Date) {
		return (
			actual instanceof Date && actual.getTime() === expected.getTime()
		);
	}
	if (expected !== null && typeof expected === "object") {
		const { lte, gt, not, ...rest } = expected as {
			lte?: Date;
			gt?: Date;
			not?: null;
		};
		if (
			Object.keys(rest).length > 0 ||
			(lte === undefined && gt === undefined) ||
			("not" in (expected as object) && not !== null)
		) {
			throw new Error(
				`fake db: unsupported filter ${JSON.stringify(expected)}`,
			);
		}
		// SQL semantics: a comparison against NULL is never true, so `not: null`
		// only restates what `lte` / `gt` already imply.
		if (!(actual instanceof Date)) {
			return false;
		}
		return lte !== undefined
			? actual.getTime() <= lte.getTime()
			: actual.getTime() > (gt as Date).getTime();
	}
	return (actual ?? null) === expected;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, expected]) => {
		if (key === "AND") {
			return (expected as Record<string, unknown>[]).every((sub) =>
				matches(row, sub),
			);
		}
		if (key === "OR") {
			return (expected as Record<string, unknown>[]).some((sub) =>
				matches(row, sub),
			);
		}
		return valueMatches(row[key], expected);
	});
}

vi.mock("../prisma/client", async () => {
	const { Prisma } = await import("../prisma/generated/client");
	const backgroundJob = {
		findFirst: async ({ where }: { where: Record<string, unknown> }) => {
			const row = store.rows.find((r) => matches(r, where));
			const copy = row ? structuredClone(row) : null;
			afterRead();
			return copy;
		},
		findMany: async ({ where }: { where: Record<string, unknown> }) => {
			const rows = store.rows
				.filter((r) => matches(r, where))
				.map((r) => structuredClone(r));
			afterRead();
			return rows;
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
		create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
			// The partial unique index: one open row per (workflowId, sourceId).
			if (
				store.rows.some(
					(r) =>
						r.status === "RUNNING" &&
						r.workflowId === data.workflowId &&
						(r.sourceId ?? null) === (data.sourceId ?? null),
				)
			) {
				throw Object.assign(new Error("Unique constraint failed"), {
					code: "P2002",
				});
			}
			const row = {
				status: "RUNNING",
				runStartedAt: null,
				steps: [],
				...data,
				id: `job-${store.rows.length + 1}`,
			} as Row;
			store.rows.push(row);
			return { id: row.id };
		}),
	};
	return {
		db: {
			backgroundJob,
			$executeRaw: executeRaw,
			$transaction: async (fn: (tx: unknown) => unknown) =>
				fn({ backgroundJob }),
		},
		Prisma,
	};
});

import {
	completeBackgroundJob,
	createBackgroundJob,
	ensureRunningBackgroundJob,
	failBackgroundJob,
	failRunningBackgroundJobStep,
	incrementBackgroundJobCounts,
	setBackgroundJobCounts,
	setBackgroundJobStep,
	touchBackgroundJobHeartbeat,
} from "../prisma/queries/background-jobs";

const WORKFLOW_ID = "code-index-proj-1-repo-1";
const SOURCE_ID = "repo-1";
const OLD = "run-older-chain";
const NEW = "run-newer-chain";
const STALE = new Date("2026-01-01T00:00:00.000Z");

function seedJob(runId: string | null, overrides: Partial<Row> = {}): Row {
	const row: Row = {
		id: `job-${store.rows.length + 1}`,
		runStartedAt: null,
		workflowId: WORKFLOW_ID,
		sourceId: SOURCE_ID,
		runId,
		status: "RUNNING",
		error: null,
		errorClass: null,
		completedAt: null,
		heartbeatAt: STALE,
		counts: {},
		steps: [
			{ key: "clone", status: "completed" },
			{ key: "embed", status: "running" },
			{ key: "finalize", status: "pending" },
		],
		...overrides,
	};
	store.rows.push(row);
	return row;
}

function stepStatus(row: Row, key: string) {
	return (row.steps as Array<{ key: string; status: string }>).find(
		(s) => s.key === key,
	)?.status;
}

/** Each fenced Prisma-client writer, and how to tell it wrote the row. */
const WRITERS: Array<{
	name: string;
	write: (runId?: string) => Promise<void>;
	wrote: (row: Row) => boolean;
}> = [
	{
		name: "setBackgroundJobStep",
		write: (runId) =>
			setBackgroundJobStep(
				{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId },
				"finalize",
				"completed",
			),
		wrote: (row) => stepStatus(row, "finalize") === "completed",
	},
	{
		name: "touchBackgroundJobHeartbeat",
		write: (runId) =>
			touchBackgroundJobHeartbeat({
				workflowId: WORKFLOW_ID,
				sourceId: SOURCE_ID,
				runId,
			}),
		wrote: (row) => (row.heartbeatAt as Date).getTime() !== STALE.getTime(),
	},
	{
		name: "completeBackgroundJob",
		write: (runId) =>
			completeBackgroundJob({
				workflowId: WORKFLOW_ID,
				sourceId: SOURCE_ID,
				runId,
			}),
		// The close also sweeps the unreached step, fenced the same way.
		wrote: (row) =>
			row.status === "COMPLETED" &&
			stepStatus(row, "finalize") === "skipped",
	},
	{
		name: "failBackgroundJob",
		write: (runId) =>
			failBackgroundJob(
				{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId },
				{ error: "late failure" },
			),
		wrote: (row) =>
			row.status === "FAILED" &&
			stepStatus(row, "finalize") === "skipped",
	},
	{
		name: "failRunningBackgroundJobStep",
		write: (runId) =>
			failRunningBackgroundJobStep(
				{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId },
				"late failure",
			),
		wrote: (row) => stepStatus(row, "embed") === "failed",
	},
];

beforeEach(() => {
	store.rows.length = 0;
	store.afterRead = null;
	executeRaw.mockReset();
	executeRaw.mockResolvedValue(1);
});

describe.each(WRITERS)("$name", ({ write, wrote }) => {
	it("leaves a row labeled with another chain untouched", async () => {
		const row = seedJob(NEW);
		const before = structuredClone(row);

		await write(OLD);

		expect(row).toEqual(before);
	});

	it("writes the row labeled with its own chain", async () => {
		const row = seedJob(NEW);

		await write(NEW);

		expect(wrote(row)).toBe(true);
	});

	it("writes an unlabeled row", async () => {
		const row = seedJob(null);

		await write(OLD);

		expect(wrote(row)).toBe(true);
	});

	it("without a fence, writes any chain's row as before", async () => {
		const row = seedJob(NEW);

		await write(undefined);

		expect(wrote(row)).toBe(true);
	});
});

describe("raw-SQL counter writers", () => {
	const RAW = [
		{
			name: "incrementBackgroundJobCounts",
			write: (runId?: string) =>
				incrementBackgroundJobCounts(
					{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId },
					{ filesProcessed: 50 },
				),
		},
		{
			name: "setBackgroundJobCounts",
			write: (runId?: string) =>
				setBackgroundJobCounts(
					{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId },
					{ totalFiles: 3400 },
				),
		},
	];

	it.each(RAW)("$name fences the UPDATE on the chain", async ({ write }) => {
		await write(OLD);

		const statement = executeRaw.mock.calls[0][0];
		expect(statement.text).toMatch(
			/\("runId" = \$\d+ OR "runId" IS NULL\)/,
		);
		expect(statement.values).toContain(OLD);
	});

	it.each(RAW)(
		"$name without a fence renders no runId predicate",
		async ({ write }) => {
			await write(undefined);

			const statement = executeRaw.mock.calls[0][0];
			expect(statement.text).not.toContain('"runId"');
		},
	);

	it("completeBackgroundJob fences the counts it writes before the close", async () => {
		seedJob(NEW);

		await completeBackgroundJob(
			{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId: OLD },
			{ counts: { filesProcessed: 1 } },
		);

		const statement = executeRaw.mock.calls[0][0];
		expect(statement.text).toMatch(/"runId" = \$\d+ OR "runId" IS NULL/);
		expect(statement.values).toContain(OLD);
	});
});

const OLD_START = new Date("2026-01-01T10:00:00.000Z");
const NEW_START = new Date("2026-01-01T10:05:00.000Z");

const JOB = {
	kind: "CODE_INDEXING" as const,
	title: "example-org/example-repo",
	projectId: "proj-1",
	userId: "user-1",
	workflowId: WORKFLOW_ID,
	sourceId: SOURCE_ID,
};

/** A chain's ordered claim, as its init makes it. */
const claim = (runId: string, runStartedAt: Date) =>
	ensureRunningBackgroundJob({ ...JOB, runId, runStartedAt });

/** A start path's label, as `createBackgroundJob` makes it after workflow.start. */
const startPathLabel = (runId: string, title = JOB.title) =>
	createBackgroundJob({ ...JOB, title, runId });

describe("the start path's relabel cannot undo an ordered claim", () => {
	it("a stale start request after the newer chain's claim leaves the label alone", async () => {
		const row = seedJob(NEW, { runStartedAt: NEW_START });

		const id = await startPathLabel(OLD, "refreshed title");

		expect(id).toBe(row.id);
		expect(row.runId).toBe(NEW);
		// Metadata and heartbeat still refresh; only the label is kept.
		expect(row.title).toBe("refreshed title");
		expect((row.heartbeatAt as Date).getTime()).not.toBe(STALE.getTime());
	});

	it("a stale start request before the newer chain's claim is overridden by that claim, and the older chain's late claim is refused", async () => {
		const row = seedJob(NEW); // B's start path labeled it; no claim yet.

		await startPathLabel(OLD); // A's request, delayed until now.
		expect(row.runId).toBe(OLD);

		await expect(claim(NEW, NEW_START)).resolves.toBe(row.id);
		expect(row).toMatchObject({ runId: NEW, runStartedAt: NEW_START });

		// A's own init arrives late.
		await expect(claim(OLD, OLD_START)).resolves.toBeNull();
		expect(row).toMatchObject({ runId: NEW, runStartedAt: NEW_START });
		expect(store.rows).toHaveLength(1);
	});

	it("a claim with the same start time relabels (a tie is not a refusal)", async () => {
		const row = seedJob(OLD, { runStartedAt: OLD_START });

		await expect(claim(NEW, new Date(OLD_START))).resolves.toBe(row.id);

		expect(row.runId).toBe(NEW);
	});

	it("the chain's own repeated claim is accepted", async () => {
		const row = seedJob(NEW, { runStartedAt: NEW_START });

		await expect(claim(NEW, NEW_START)).resolves.toBe(row.id);
		expect(row.runId).toBe(NEW);
	});
});

describe("an ordered claim whose candidate changes under it", () => {
	const NEWEST = "run-newest-chain";
	const NEWEST_START = new Date("2026-01-01T10:10:00.000Z");

	it("retries when the open row closes between the read and the claim, and ends with its own RUNNING row", async () => {
		const candidate = seedJob(OLD, { runStartedAt: OLD_START });
		store.afterRead = () => {
			candidate.status = "COMPLETED";
		};

		const id = await claim(NEW, NEW_START);

		expect(id).not.toBeNull();
		const own = store.rows.find((r) => r.id === id);
		expect(own).toMatchObject({
			status: "RUNNING",
			runId: NEW,
			runStartedAt: NEW_START,
		});
		expect(store.rows.filter((r) => r.status === "RUNNING")).toHaveLength(
			1,
		);
	});

	it("retries when the open row vanishes between the read and the claim", async () => {
		const candidate = seedJob(OLD, { runStartedAt: OLD_START });
		store.afterRead = () => {
			store.rows.splice(store.rows.indexOf(candidate), 1);
		};

		const id = await claim(NEW, NEW_START);

		expect(store.rows).toHaveLength(1);
		expect(store.rows[0]).toMatchObject({
			id,
			runId: NEW,
			status: "RUNNING",
		});
	});

	it("returns null and creates nothing when a newer chain's closed claim lands in the gap", async () => {
		const candidate = seedJob(OLD, { runStartedAt: OLD_START });
		let reads = 0;
		const hook = () => {
			reads += 1;
			if (reads === 1) {
				candidate.status = "COMPLETED";
				seedJob(NEWEST, {
					runStartedAt: NEWEST_START,
					status: "COMPLETED",
				});
			}
			store.afterRead = hook;
		};
		store.afterRead = hook;

		await expect(claim(NEW, NEW_START)).resolves.toBeNull();

		store.afterRead = null;
		expect(store.rows).toHaveLength(2);
		expect(store.rows.some((r) => r.runId === NEW)).toBe(false);
		// Refused on the first re-check — the candidate read, then the open-row
		// read and the newer-claim read — not by going round the retry loop.
		expect(reads).toBe(3);
	});

	it("returns null when the candidate is replaced by a row a newer chain claimed", async () => {
		const candidate = seedJob(OLD, { runStartedAt: OLD_START });
		let reads = 0;
		const hook = () => {
			reads += 1;
			if (reads === 1) {
				candidate.status = "COMPLETED";
				seedJob(NEWEST, { runStartedAt: NEWEST_START });
			}
			store.afterRead = hook;
		};
		store.afterRead = hook;

		await expect(claim(NEW, NEW_START)).resolves.toBeNull();

		store.afterRead = null;
		expect(store.rows).toHaveLength(2);
		expect(store.rows.some((r) => r.runId === NEW)).toBe(false);
		// Refused on the first re-read, not by exhausting the retry bound.
		expect(reads).toBe(2);
	});

	it("gives up, without throwing, when the candidate keeps closing past the bound", async () => {
		seedJob(OLD, { runStartedAt: OLD_START });
		// After every read: close whatever is open and open a fresh, claimable
		// row — so each attempt's claim finds its candidate gone.
		let reads = 0;
		const churn = () => {
			reads += 1;
			for (const row of store.rows) {
				if (row.status === "RUNNING") {
					row.status = "COMPLETED";
				}
			}
			seedJob(OLD, { runStartedAt: OLD_START });
			store.afterRead = churn;
		};
		store.afterRead = churn;

		await expect(claim(NEW, NEW_START)).resolves.toBeNull();

		store.afterRead = null;
		expect(store.rows.some((r) => r.runId === NEW)).toBe(false);
		// Bounded: one candidate read plus one re-read per attempt.
		expect(reads).toBe(6);
	});
});

describe("an ordered claim with no open row", () => {
	it("creates nothing once a newer chain has claimed a row, even a closed one (no ghost row)", async () => {
		seedJob(NEW, { runStartedAt: NEW_START, status: "COMPLETED" });

		await expect(claim(OLD, OLD_START)).resolves.toBeNull();

		expect(store.rows).toHaveLength(1);
	});

	it("creates the row labeled and claimed when no newer chain has claimed one", async () => {
		seedJob(OLD, { runStartedAt: OLD_START, status: "COMPLETED" });

		const id = await claim(NEW, NEW_START);

		const created = store.rows.find((r) => r.id === id);
		expect(created).toMatchObject({
			status: "RUNNING",
			runId: NEW,
			runStartedAt: NEW_START,
		});
	});

	it("claims the winner through the ordering check when it loses the create race", async () => {
		// The start path's row appears between the claim's read and its create.
		store.afterRead = () => {
			store.afterRead = () => {
				seedJob(OLD);
			};
		};

		const id = await claim(NEW, NEW_START);

		expect(store.rows).toHaveLength(1);
		expect(id).toBe(store.rows[0].id);
		expect(store.rows[0]).toMatchObject({
			runId: NEW,
			runStartedAt: NEW_START,
		});
	});
});

describe("read-modify-write writers repeat their filter in the UPDATE", () => {
	it("setBackgroundJobStep writes nothing if the row is relabeled between its read and its write", async () => {
		const row = seedJob(OLD);
		const before = structuredClone(row.steps);
		store.afterRead = () => {
			row.runId = NEW;
		};

		await setBackgroundJobStep(
			{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId: OLD },
			"finalize",
			"completed",
		);

		expect(row.steps).toEqual(before);
	});

	it("failRunningBackgroundJobStep writes nothing if the row is relabeled between its read and its write", async () => {
		const row = seedJob(OLD);
		const before = structuredClone(row.steps);
		store.afterRead = () => {
			row.runId = NEW;
		};

		await failRunningBackgroundJobStep(
			{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId: OLD },
			"late failure",
		);

		expect(row.steps).toEqual(before);
	});

	it("an unfenced step write does not land on a row that closed between its read and its write", async () => {
		const row = seedJob(null);
		store.afterRead = () => {
			row.status = "COMPLETED";
		};

		await setBackgroundJobStep(
			{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID },
			"finalize",
			"completed",
		);

		expect(stepStatus(row, "finalize")).toBe("pending");
	});

	it("the close's step sweep writes nothing if the row is relabeled after its read", async () => {
		const row = seedJob(OLD);
		// The first read is the sweep's, after the close itself landed.
		store.afterRead = () => {
			row.runId = NEW;
		};

		await failBackgroundJob(
			{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId: OLD },
			{ error: "late failure" },
		);

		expect(row.status).toBe("FAILED");
		expect(stepStatus(row, "finalize")).toBe("pending");
	});
});

describe("an ordered fail takes over a row claimed by an older chain", () => {
	/** A chain's pre-init failure, as `failCodeIndexActivity` makes it. */
	const orderedFail = (runId: string, runStartedAt: Date, error: string) =>
		failBackgroundJob(
			{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId },
			{ error, runStartedAt },
		);

	it("a successor that fails before its init fails the predecessor-claimed row with its own error, and labels it", async () => {
		const row = seedJob(OLD, { runStartedAt: OLD_START });

		await orderedFail(NEW, NEW_START, "No repository token available");

		expect(row).toMatchObject({
			status: "FAILED",
			error: "No repository token available",
			runId: NEW,
			runStartedAt: NEW_START,
		});
		expect(stepStatus(row, "finalize")).toBe("skipped");
	});

	it("a late fail from an older chain is refused once a newer chain has claimed", async () => {
		const row = seedJob(NEW, { runStartedAt: NEW_START });

		await orderedFail(OLD, OLD_START, "late failure");

		expect(row).toMatchObject({
			status: "RUNNING",
			runId: NEW,
			error: null,
		});
	});

	it("a row a newer start path labeled without an ordered claim is not taken over", async () => {
		const row = seedJob(NEW); // runStartedAt NULL: nothing to compare.

		await orderedFail(OLD, OLD_START, "late failure");

		expect(row).toMatchObject({ status: "RUNNING", runId: NEW });
	});

	it("a tie lands (last writer wins, as for the other ordered rules)", async () => {
		const row = seedJob(OLD, { runStartedAt: OLD_START });

		await orderedFail(NEW, new Date(OLD_START), "tied failure");

		expect(row).toMatchObject({ status: "FAILED", runId: NEW });
	});

	it("sweeps the steps of the row it closed and no other", async () => {
		const closed = seedJob(OLD, { runStartedAt: OLD_START });
		// An unlabeled row of the same source, already FAILED — the plain
		// fence's NULL arm would reach it.
		const other = seedJob(null, { status: "FAILED" });
		const otherSteps = structuredClone(other.steps);
		// Stamp it with the very completion time this close uses, the only way
		// the sweep's completedAt filter could match it.
		const fixed = new Date("2026-01-01T12:00:00.000Z");
		other.completedAt = new Date(fixed);
		vi.useFakeTimers({ now: fixed, toFake: ["Date"] });
		try {
			await orderedFail(NEW, NEW_START, "own failure");
		} finally {
			vi.useRealTimers();
		}

		expect(stepStatus(closed, "finalize")).toBe("skipped");
		expect(other.steps).toEqual(otherSteps);
	});

	it("without runStartedAt the fail keeps the plain fence and never relabels", async () => {
		const row = seedJob(OLD, { runStartedAt: OLD_START });

		await failBackgroundJob(
			{ workflowId: WORKFLOW_ID, sourceId: SOURCE_ID, runId: NEW },
			{ error: "unordered failure" },
		);

		expect(row).toMatchObject({ status: "RUNNING", runId: OLD });
	});
});

describe("job kinds that never make an ordered claim are unchanged", () => {
	it("the start path relabels an unclaimed row, as before", async () => {
		const row = seedJob(OLD);

		await startPathLabel(NEW);

		expect(row.runId).toBe(NEW);
	});

	it("an unordered ensure never relabels and still creates past a closed row", async () => {
		seedJob(NEW, { runStartedAt: NEW_START, status: "COMPLETED" });

		const id = await ensureRunningBackgroundJob({ ...JOB, runId: OLD });

		expect(id).not.toBeNull();
		expect(store.rows).toHaveLength(2);
		expect(store.rows[1].runStartedAt ?? null).toBeNull();
	});
});

describe("ensureRunningBackgroundJob", () => {
	it("adopts an open row without relabeling it — the start path owns the label", async () => {
		const row = seedJob(NEW);

		const id = await ensureRunningBackgroundJob({
			kind: "CODE_INDEXING",
			title: "example-org/example-repo",
			projectId: "proj-1",
			userId: "user-1",
			workflowId: WORKFLOW_ID,
			sourceId: SOURCE_ID,
			runId: OLD,
		});

		expect(id).toBe("job-1");
		expect(row.runId).toBe(NEW);
	});
});
