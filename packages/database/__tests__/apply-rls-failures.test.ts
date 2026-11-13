import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: {
		$queryRaw: vi.fn().mockResolvedValue([]),
		$executeRawUnsafe: execute,
	},
}));

import { applyRLS } from "../scripts/apply-rls-direct";

describe("applyRLS policy failures", () => {
	beforeEach(() => {
		execute.mockReset().mockResolvedValue(0);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	it.each([
		[["purchase"], /purchase: denied purchase/],
		[
			["purchase", "ai_credit_account"],
			/purchase: denied purchase[\s\S]*ai_credit_account: denied ai_credit_account/,
		],
	])("rejects and names failed tables %s", async (tables, message) => {
		execute.mockImplementation(async (sql: string) => {
			for (const table of tables) {
				if (
					sql.includes("CREATE POLICY tenant_isolation") &&
					sql.includes(`"public"."${table}"`)
				) {
					throw new Error(`denied ${table}`);
				}
			}
			return 0;
		});
		await expect(applyRLS()).rejects.toThrow(message);
		expect(console.log).not.toHaveBeenCalledWith(
			"\n✅ RLS policies applied successfully!",
		);
	});
	it("resolves and reports success when policies succeed", async () => {
		await expect(applyRLS()).resolves.toBeUndefined();
		expect(console.log).toHaveBeenCalledWith(
			"\n✅ RLS policies applied successfully!",
		);
	});
});
