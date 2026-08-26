/**
 * Unit tests for the `@repo/database` PmSyncLog query layer
 * (`createPmSyncLog` + `listPmSyncLog`).
 *
 * Mocks the Prisma client (`../prisma/client`) — no real DB. Mirrors the
 * `coding-runs-query.test.ts` convention.
 *
 * Run with: pnpm --filter @repo/database test __tests__/pm-sync-log.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, findMany, count, $transaction } = vi.hoisted(() => ({
	create: vi.fn(),
	findMany: vi.fn(),
	count: vi.fn(),
	// Mirror the real client: resolve the array of operation promises.
	$transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
}));

vi.mock("../prisma/client", async () => {
	// Pull the real `Prisma` namespace so `Prisma.JsonNull` etc. behave like
	// production; only the `db` client is mocked.
	const actual =
		await vi.importActual<typeof import("../prisma/client")>(
			"../prisma/client",
		);
	return {
		Prisma: actual.Prisma,
		db: {
			pmSyncLog: { create, findMany, count },
			$transaction,
		},
	};
});

import {
	type CreatePmSyncLogInput,
	createPmSyncLog,
	listPmSyncLog,
} from "../prisma/queries/pm-sync-log";

const baseCreate: CreatePmSyncLogInput = {
	organizationId: "org_1",
	direction: "push",
	entityType: "FEATURE",
	entityId: "feat_1",
	title: "Checkout flow refactor",
	pmTool: "azure-devops",
	status: "SUCCESS",
	projectId: "proj_1",
};

describe("createPmSyncLog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		create.mockResolvedValue({ id: "log_1" });
	});

	it("inserts exactly one row and returns its id", async () => {
		const result = await createPmSyncLog(baseCreate);

		expect(create).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ id: "log_1" });
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ select: { id: true } }),
		);
	});

	it("applies org tenant fields exactly as provided (org row)", async () => {
		await createPmSyncLog({
			...baseCreate,
			organizationId: "org_9",
			userId: undefined,
		});

		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.organizationId).toBe("org_9");
		expect(data.userId).toBeNull();
	});

	it("applies personal tenant fields exactly as provided (personal row)", async () => {
		await createPmSyncLog({
			userId: "user_7",
			direction: "push",
			entityType: "STORY",
			entityId: "story_1",
			title: "Personal story",
			pmTool: "jira",
			status: "FAILURE",
			projectId: "proj_2",
		});

		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.userId).toBe("user_7");
		expect(data.organizationId).toBeNull();
	});

	it.each(["EPIC", "FEATURE", "STORY"] as const)(
		"accepts entityType %s (EPIC|FEATURE|STORY — never TASK)",
		async (entityType) => {
			await createPmSyncLog({ ...baseCreate, entityType });

			const data = create.mock.calls[0]?.[0]?.data as Record<
				string,
				unknown
			>;
			expect(data.entityType).toBe(entityType);
		},
	);

	it("persists snapshot + context columns as provided", async () => {
		await createPmSyncLog({
			...baseCreate,
			status: "FAILURE",
			errorPayload: { code: "TF401347" },
			batchId: "batch_1",
			actorUserId: "user_3",
			correlationId: "run_abc",
			durationMs: 1234,
			externalId: "AB#42",
			externalUrl: "https://dev.azure.com/x/_workitems/edit/42",
		});

		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data).toMatchObject({
			direction: "push",
			pmTool: "azure-devops",
			status: "FAILURE",
			errorPayload: { code: "TF401347" },
			batchId: "batch_1",
			actorUserId: "user_3",
			correlationId: "run_abc",
			durationMs: 1234,
			externalId: "AB#42",
			externalUrl: "https://dev.azure.com/x/_workitems/edit/42",
			title: "Checkout flow refactor",
		});
	});

	it("omits errorPayload entirely when none is provided (SQL NULL, not JSON null)", async () => {
		await createPmSyncLog(baseCreate);

		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		// Omitting the key makes Prisma write SQL NULL, so `errorPayload IS
		// NULL` matches SUCCESS rows — a JSON `null` literal would not.
		expect("errorPayload" in data).toBe(false);
	});

	it("omits errorPayload when explicitly passed null", async () => {
		await createPmSyncLog({ ...baseCreate, errorPayload: null });

		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect("errorPayload" in data).toBe(false);
	});

	it("defaults optional context columns to null when omitted", async () => {
		await createPmSyncLog(baseCreate);

		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.batchId).toBeNull();
		expect(data.actorUserId).toBeNull();
		expect(data.correlationId).toBeNull();
		expect(data.durationMs).toBeNull();
		expect(data.externalId).toBeNull();
		expect(data.externalUrl).toBeNull();
	});
});

describe("listPmSyncLog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findMany.mockResolvedValue([]);
		count.mockResolvedValue(0);
	});

	function lastFindManyArgs(): Record<string, unknown> {
		return findMany.mock.calls[0]?.[0] as Record<string, unknown>;
	}
	function lastFindManyWhere(): Record<string, unknown> {
		return lastFindManyArgs().where as Record<string, unknown>;
	}

	it("returns { rows, total } from a single transaction", async () => {
		findMany.mockResolvedValue([{ id: "log_1" }, { id: "log_2" }]);
		count.mockResolvedValue(42);

		const result = await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
		});

		expect($transaction).toHaveBeenCalledTimes(1);
		expect(result.rows).toHaveLength(2);
		expect(result.total).toBe(42);
	});

	it("orders newest-first (createdAt desc)", async () => {
		await listPmSyncLog({ projectId: "proj_1", organizationId: "org_1" });

		expect(lastFindManyArgs().orderBy).toEqual({ createdAt: "desc" });
	});

	it("applies org tenant XOR (projectId + organizationId, no userId)", async () => {
		await listPmSyncLog({ projectId: "proj_1", organizationId: "org_5" });

		const where = lastFindManyWhere();
		expect(where).toMatchObject({
			projectId: "proj_1",
			organizationId: "org_5",
		});
		expect(where.userId).toBeUndefined();
	});

	it("applies personal tenant XOR (projectId + userId, organizationId null)", async () => {
		await listPmSyncLog({ projectId: "proj_1", userId: "user_2" });

		const where = lastFindManyWhere();
		expect(where).toMatchObject({
			projectId: "proj_1",
			organizationId: null,
			userId: "user_2",
		});
	});

	it("filters by pmTool", async () => {
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			pmTool: "jira",
		});

		expect(lastFindManyWhere().pmTool).toBe("jira");
	});

	it("filters by entityId", async () => {
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			entityId: "feat_9",
		});

		expect(lastFindManyWhere().entityId).toBe("feat_9");
	});

	it("filters by status", async () => {
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			status: "CONFLICT",
		});

		expect(lastFindManyWhere().status).toBe("CONFLICT");
	});

	it("filters by dateFrom/dateTo (gte/lte) and composes with AND", async () => {
		const dateFrom = new Date("2026-05-01T00:00:00Z");
		const dateTo = new Date("2026-05-26T00:00:00Z");
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			dateFrom,
			dateTo,
		});

		expect(lastFindManyWhere().createdAt).toEqual({
			gte: dateFrom,
			lte: dateTo,
		});
	});

	it("composes multiple filters together (AND semantics)", async () => {
		const dateFrom = new Date("2026-05-01T00:00:00Z");
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			pmTool: "azure-devops",
			entityId: "story_3",
			status: "FAILURE",
			dateFrom,
		});

		const where = lastFindManyWhere();
		expect(where).toMatchObject({
			projectId: "proj_1",
			organizationId: "org_1",
			pmTool: "azure-devops",
			entityId: "story_3",
			status: "FAILURE",
			createdAt: { gte: dateFrom },
		});
	});

	it("omits unspecified filters from the where clause", async () => {
		await listPmSyncLog({ projectId: "proj_1", organizationId: "org_1" });

		const where = lastFindManyWhere();
		expect(where.pmTool).toBeUndefined();
		expect(where.entityId).toBeUndefined();
		expect(where.status).toBeUndefined();
		expect(where.createdAt).toBeUndefined();
	});

	it("defaults to page size 50 with offset 0", async () => {
		await listPmSyncLog({ projectId: "proj_1", organizationId: "org_1" });

		const args = lastFindManyArgs();
		expect(args.take).toBe(50);
		expect(args.skip).toBe(0);
	});

	it("honors explicit limit and offset", async () => {
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			limit: 25,
			offset: 100,
		});

		const args = lastFindManyArgs();
		expect(args.take).toBe(25);
		expect(args.skip).toBe(100);
	});

	it("clamps limit to a maximum of 100", async () => {
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			limit: 5000,
		});

		expect(lastFindManyArgs().take).toBe(100);
	});

	it("clamps a non-positive limit up to 1", async () => {
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			limit: 0,
		});

		expect(lastFindManyArgs().take).toBe(1);
	});

	it("clamps a negative offset to 0", async () => {
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			offset: -10,
		});

		expect(lastFindManyArgs().skip).toBe(0);
	});

	it("counts with the same where clause as the page query", async () => {
		await listPmSyncLog({
			projectId: "proj_1",
			organizationId: "org_1",
			status: "FAILURE",
		});

		const findManyWhere = lastFindManyWhere();
		const countWhere = count.mock.calls[0]?.[0]?.where as Record<
			string,
			unknown
		>;
		expect(countWhere).toEqual(findManyWhere);
	});
});
