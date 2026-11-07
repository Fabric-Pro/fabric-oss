import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	query: vi.fn(),
	transactionQuery: vi.fn(),
	deleteMany: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		$queryRaw: m.query,
		$transaction: async (callback: (tx: unknown) => unknown) =>
			callback({
				$queryRaw: m.transactionQuery,
				deliverySignalObservation: { deleteMany: m.deleteMany },
			}),
	},
	Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: vi.fn(),
	resolveProjectAccess: vi.fn(),
	canEditProject: vi.fn(),
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: vi.fn() }));

import {
	isDeliverySourceRetentionWorkerQualified,
	purgeExpiredDeliverySourceObservations,
} from "../prisma/queries/delivery-source-capture";

beforeEach(() => vi.resetAllMocks());
describe("private-source maintenance connection qualification", () => {
	it.each([false, null, undefined])(
		"refuses an unproven actual connection result %s",
		async (allowed) => {
			m.query.mockResolvedValue(
				allowed === undefined ? [] : [{ allowed }],
			);
			expect(await isDeliverySourceRetentionWorkerQualified()).toBe(
				false,
			);
		},
	);
	it("uses catalog-only exact worker and applicable policy requirements", async () => {
		m.query.mockResolvedValue([{ allowed: true }]);
		expect(await isDeliverySourceRetentionWorkerQualified()).toBe(true);
		const sql = m.query.mock.calls[0][0].join("?");
		expect(sql).toContain("current_user='fabric_worker'");
		expect(sql).toContain(
			"to_regclass('public.delivery_signal_observation') IS NOT NULL",
		);
		expect(sql).toContain("r.rolbypassrls OR r.rolsuper OR EXISTS");
		expect(sql).toContain("r.oid=ANY(p.polroles)");
		expect(sql).toContain("p.polcmd='*' AND p.polpermissive");
		expect(sql).toContain("pg_get_expr(p.polqual,p.polrelid)='true'");
		expect(sql).toContain("pg_get_expr(p.polwithcheck,p.polrelid)='true'");
		expect(sql).not.toMatch(/DELETE|INSERT|UPDATE|SET ROLE/i);
	});
	it("purge rechecks the transaction connection instead of accepting a prior external qualification", async () => {
		m.query.mockResolvedValue([{ allowed: true }]);
		expect(await isDeliverySourceRetentionWorkerQualified()).toBe(true);
		m.transactionQuery.mockResolvedValue([{ allowed: false }]);
		await expect(
			purgeExpiredDeliverySourceObservations({ batchSize: 20 }),
		).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
		expect(m.transactionQuery).toHaveBeenCalledTimes(1);
		expect(m.deleteMany).not.toHaveBeenCalled();
	});
	it("keeps bounded cleanup available after qualifying the same transaction connection", async () => {
		m.transactionQuery
			.mockResolvedValueOnce([{ allowed: true }])
			.mockResolvedValueOnce([{ id: "example-expired" }]);
		m.deleteMany.mockResolvedValue({ count: 1 });
		expect(
			await purgeExpiredDeliverySourceObservations({ batchSize: 20 }),
		).toBe(1);
		expect(m.query).not.toHaveBeenCalled();
		expect(m.transactionQuery).toHaveBeenCalledTimes(2);
	});
});
