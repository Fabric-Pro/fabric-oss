/**
 * `createWorkflowExecutionIdempotent` — the find-or-create behind a manual
 * run's client idempotency key.
 *
 * The procedure test (`packages/api/.../start-execution.test.ts`) mocks this
 * function, so it proves the procedure honours the answer but nothing about
 * whether the answer is right. This file pins the query itself: the lock is
 * taken first and inside the transaction, the lookup is scoped to caller +
 * workflow + tenant + window + key, every row that still carries the key is a
 * match whatever its status (the key is released only by the explicit write
 * that records a confirmed not-started run), a fresh row carries the key where
 * the lookup will find it — and the key is resolved BEFORE the tenant's
 * in-flight cap, which only a new row reserves against.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRawMock = vi.fn();
const findFirstMock = vi.fn();
const countMock = vi.fn();
const createMock = vi.fn();
const queryRawMock = vi.fn();

vi.mock("../prisma/client", () => {
	const tx = {
		$queryRaw: (...args: unknown[]) => queryRawMock(...args),
		$executeRaw: (...args: unknown[]) => executeRawMock(...args),
		workflowExecution: {
			findFirst: (args: unknown) => findFirstMock(args),
			count: (args: unknown) => countMock(args),
			create: (args: unknown) => createMock(args),
		},
	};
	return {
		db: {
			$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn(tx),
		},
	};
});

import {
	createWorkflowExecutionIdempotent,
	EXECUTION_IDEMPOTENCY_KEY_PATH,
	releasedIdempotencyTriggerInput,
	reserveWorkflowExecution,
} from "../prisma/queries/workflows/executions";
import { listWorkspaceReviewHistory } from "../prisma/queries/workflows/workspace-review-history";
import {
	WorkspaceWorkflowBindingConflictError,
	type WorkspaceWorkflowRowGuard,
} from "../prisma/queries/workflows/workspace-workflow-binding";

const BASE = {
	workflowId: "wf-1",
	version: 3,
	triggerType: "MANUAL" as const,
	triggerInput: { triggerData: { a: 1 }, variables: undefined },
	userId: "user-1",
	idempotencyKey: "click-abc",
	windowMs: 5 * 60_000,
	limit: 25,
};

/** The SQL text of the n-th `$executeRaw`, placeholders as `?`. */
function rawSql(callIndex: number): string {
	const [strings] = executeRawMock.mock.calls[callIndex] as [
		TemplateStringsArray,
		...unknown[],
	];
	return strings.join("?");
}

beforeEach(() => {
	queryRawMock.mockReset().mockResolvedValue([{ id: "matched-row" }]);
	executeRawMock.mockReset().mockResolvedValue(1);
	findFirstMock.mockReset().mockResolvedValue(null);
	countMock.mockReset().mockResolvedValue(0);
	createMock.mockReset().mockImplementation(async (args) => ({
		id: "exec-new",
		...(args as { data: Record<string, unknown> }).data,
	}));
});

const binding: WorkspaceWorkflowRowGuard = {
	workflowId: BASE.workflowId,
	userId: BASE.userId,
	organizationId: "org-1",
	projectId: "project-1",
	workspaceFrameId: "workspace-1",
	workflowUpdatedAt: new Date("2026-01-01T12:00:00Z"),
	frameUpdatedAt: new Date("2026-01-01T11:00:00Z"),
	status: "PUBLISHED" as const,
	requirement: { kind: "row-only" },
};

describe("bound controller reservations and history", () => {
	it("checks binding under row locks before returning an existing key, without consulting capacity", async () => {
		findFirstMock.mockResolvedValueOnce({ id: "existing-run" });
		const result = await createWorkflowExecutionIdempotent({
			...BASE,
			organizationId: binding.organizationId,
			workspaceBinding: binding,
		});
		expect(result.outcome).toBe("existing");
		expect(queryRawMock).toHaveBeenCalledTimes(3);
		expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
			queryRawMock.mock.invocationCallOrder[0],
		);
		expect(queryRawMock.mock.invocationCallOrder[2]).toBeLessThan(
			findFirstMock.mock.invocationCallOrder[0],
		);
		expect(countMock).not.toHaveBeenCalled();
		expect(createMock).not.toHaveBeenCalled();
		const sql = queryRawMock.mock.calls.map(([strings]) =>
			strings.join("?"),
		);
		expect(sql[0]).toContain('"updatedAt" = ?');
		expect(sql[0]).toContain('status = ?::"WorkflowBuilderStatus"');
		expect(sql[1]).toContain("metadata->>'surface' = 'workspace'");
		expect(sql[2]).toContain('"deletedAt" IS NULL');
		for (const statement of sql) expect(statement).toContain("FOR SHARE");
	});

	it.each([0, 1, 2])(
		"fails closed when binding row %i no longer matches, before deduplication or insertion",
		async (missing) => {
			queryRawMock.mockImplementation(async () =>
				queryRawMock.mock.calls.length - 1 === missing
					? []
					: [{ id: "matched-row" }],
			);
			await expect(
				createWorkflowExecutionIdempotent({
					...BASE,
					organizationId: binding.organizationId,
					workspaceBinding: binding,
				}),
			).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
			expect(findFirstMock).not.toHaveBeenCalled();
			expect(countMock).not.toHaveBeenCalled();
			expect(createMock).not.toHaveBeenCalled();
		},
	);

	it("uses binding rows before the cap on the unkeyed path too", async () => {
		await reserveWorkflowExecution({
			userId: BASE.userId,
			organizationId: binding.organizationId,
			limit: 25,
			workspaceBinding: binding,
			data: {
				workflowId: BASE.workflowId,
				version: 1,
				triggerType: "MANUAL",
			},
		});
		expect(queryRawMock.mock.invocationCallOrder[2]).toBeLessThan(
			executeRawMock.mock.invocationCallOrder[0],
		);
		expect(createMock).toHaveBeenCalledOnce();
	});

	it("rejects mismatched guard actors before creating a row", async () => {
		await expect(
			createWorkflowExecutionIdempotent({
				...BASE,
				organizationId: binding.organizationId,
				workspaceBinding: { ...binding, userId: "foreign-user" },
			}),
		).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
		expect(queryRawMock).not.toHaveBeenCalled();
		expect(createMock).not.toHaveBeenCalled();
	});

	it("reads history only after checking the same binding inside its transaction", async () => {
		queryRawMock
			.mockResolvedValueOnce([{ id: "workflow" }])
			.mockResolvedValueOnce([{ id: "frame" }])
			.mockResolvedValueOnce([{ id: "project" }])
			.mockResolvedValueOnce([
				{ id: "one" },
				{ id: "two" },
				{ id: "extra" },
			]);
		expect(
			await listWorkspaceReviewHistory({
				binding,
				nodeId: "review",
				limit: 2,
				offset: 0,
			}),
		).toEqual({
			executions: [{ id: "one" }, { id: "two" }],
			hasMore: true,
			nextOffset: 2,
		});
		expect(queryRawMock).toHaveBeenCalledTimes(4);
		const [strings, ...values] = queryRawMock.mock.calls[3];
		expect(strings.join("?")).toContain(
			"octet_length(summary.review::text) <= ?",
		);
		expect(strings.join("?")).toContain("LIMIT ? OFFSET ?");
		expect(values).toEqual(
			expect.arrayContaining([
				binding.workflowId,
				binding.userId,
				binding.organizationId,
				"review",
				16_384,
				3,
				0,
			]),
		);
		queryRawMock.mockClear();
		queryRawMock.mockResolvedValueOnce([]);
		await expect(
			listWorkspaceReviewHistory({
				binding,
				nodeId: "review",
				limit: 2,
				offset: 0,
			}),
		).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
		expect(queryRawMock).toHaveBeenCalledOnce();
	});
});

describe("serialisation", () => {
	it("takes the key's advisory lock before reading, in the (int4, int4) space", async () => {
		await createWorkflowExecutionIdempotent(BASE);

		expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
			findFirstMock.mock.invocationCallOrder[0],
		);
		expect(rawSql(0)).toMatch(/pg_advisory_xact_lock\(\?::int, \?::int\)/);
	});

	it("takes the tenant's capacity lock only after the key lookup, and only when creating", async () => {
		// Lock order is key first, tenant second, on every path — the one
		// thing that keeps two reservations from waiting on each other.
		await createWorkflowExecutionIdempotent(BASE);

		expect(executeRawMock).toHaveBeenCalledTimes(2);
		expect(rawSql(1)).toMatch(/pg_advisory_xact_lock\(\?::int, \?::int\)/);
		expect(executeRawMock.mock.invocationCallOrder[1]).toBeGreaterThan(
			findFirstMock.mock.invocationCallOrder[0],
		);
		expect(executeRawMock.mock.invocationCallOrder[1]).toBeLessThan(
			countMock.mock.invocationCallOrder[0],
		);
	});
});

describe("lookup scope", () => {
	it("matches only the caller's rows for this workflow, in this tenant, inside the window, carrying the key", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
		try {
			await createWorkflowExecutionIdempotent({
				...BASE,
				organizationId: "org-1",
			});
		} finally {
			vi.useRealTimers();
		}

		expect(findFirstMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					workflowId: "wf-1",
					userId: "user-1",
					organizationId: "org-1",
					startedAt: { gte: new Date("2026-09-13T11:55:00Z") },
					triggerInput: {
						path: [...EXECUTION_IDEMPOTENCY_KEY_PATH],
						equals: "click-abc",
					},
				}),
			}),
		);
	});

	it("scopes a personal-context call to organizationId null, never to any organisation", async () => {
		await createWorkflowExecutionIdempotent(BASE);

		const { where } = findFirstMock.mock.calls[0][0];
		expect(where.organizationId).toBeNull();
	});

	it("does not infer a released key from the row's shape — a FAILED row with no run id still matches", async () => {
		// A run the engine accepted can end up FAILED with no run id: the
		// starter's run-id write fails and the workflow later records FAILED.
		// Excluding that shape let a same-key retry start a second run.
		await createWorkflowExecutionIdempotent(BASE);

		const { where } = findFirstMock.mock.calls[0][0];
		expect(where).not.toHaveProperty("NOT");
		expect(where).not.toHaveProperty("status");
		expect(where).not.toHaveProperty("temporalRunId");
	});

	it("returns an accepted run that later failed without a run id, rather than creating another", async () => {
		const accepted = {
			id: "exec-accepted",
			status: "FAILED",
			temporalRunId: null,
		};
		findFirstMock.mockResolvedValue(accepted);

		const result = await createWorkflowExecutionIdempotent(BASE);

		expect(result).toEqual({ outcome: "existing", execution: accepted });
		expect(createMock).not.toHaveBeenCalled();
	});
});

describe("releasedIdempotencyTriggerInput", () => {
	it("moves the key out of the matched path, keeping it for the history", () => {
		expect(
			releasedIdempotencyTriggerInput({
				triggerData: { a: 1 },
				[EXECUTION_IDEMPOTENCY_KEY_PATH[0]]: "click-abc",
			}),
		).toEqual({
			triggerData: { a: 1 },
			releasedIdempotencyKey: "click-abc",
		});
	});

	it("returns undefined — leave the column alone — when there is no key to release", () => {
		expect(
			releasedIdempotencyTriggerInput({ triggerData: {} }),
		).toBeUndefined();
		expect(releasedIdempotencyTriggerInput(null)).toBeUndefined();
		expect(releasedIdempotencyTriggerInput(undefined)).toBeUndefined();
		expect(releasedIdempotencyTriggerInput(["x"])).toBeUndefined();
	});
});

describe("outcome", () => {
	it("returns the existing run and does not create when one matches", async () => {
		const existing = { id: "exec-existing", status: "RUNNING" };
		findFirstMock.mockResolvedValue(existing);

		const result = await createWorkflowExecutionIdempotent(BASE);

		expect(result).toEqual({ outcome: "existing", execution: existing });
		expect(createMock).not.toHaveBeenCalled();
	});

	it("returns the existing run WITHOUT consulting the cap — a same-key retry asks for nothing new", async () => {
		// The first request started the last permitted run and lost its
		// response. Its retry must get that run back, not a 429.
		findFirstMock.mockResolvedValue({
			id: "exec-existing",
			status: "RUNNING",
		});
		countMock.mockResolvedValue(25);

		const result = await createWorkflowExecutionIdempotent({
			...BASE,
			limit: 25,
		});

		expect(result.outcome).toBe("existing");
		expect(countMock).not.toHaveBeenCalled();
		expect(executeRawMock).toHaveBeenCalledTimes(1);
	});

	it("refuses to create — and creates nothing — when the tenant is at its cap", async () => {
		countMock.mockResolvedValue(25);

		const result = await createWorkflowExecutionIdempotent({
			...BASE,
			limit: 25,
		});

		expect(result).toEqual({
			outcome: "limit-reached",
			inFlight: 25,
			limit: 25,
		});
		expect(createMock).not.toHaveBeenCalled();
	});

	it("creates a PENDING row with the key stored beside the trigger input when nothing matches", async () => {
		countMock.mockResolvedValue(3);

		const result = await createWorkflowExecutionIdempotent({
			...BASE,
			organizationId: "org-1",
		});

		expect(result).toMatchObject({
			outcome: "created",
			inFlight: 4,
			limit: 25,
		});
		expect(createMock).toHaveBeenCalledWith({
			data: expect.objectContaining({
				workflowId: "wf-1",
				version: 3,
				triggerType: "MANUAL",
				userId: "user-1",
				organizationId: "org-1",
				status: "PENDING",
				triggerInput: expect.objectContaining({
					triggerData: { a: 1 },
					[EXECUTION_IDEMPOTENCY_KEY_PATH[0]]: "click-abc",
				}),
			}),
		});
	});

	it("counts the tenant's in-flight rows under the XOR tenant filter before creating", async () => {
		await createWorkflowExecutionIdempotent(BASE);

		expect(countMock).toHaveBeenCalledWith({
			where: expect.objectContaining({
				userId: "user-1",
				organizationId: null,
				status: { in: ["PENDING", "RUNNING"] },
			}),
		});
	});
});
