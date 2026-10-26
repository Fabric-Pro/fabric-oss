import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	createOrganizationContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { createTenantDbClient } from "../src/tenant-db";

// The real extension runs, but the database boundary is intercepted so this
// regression is covered by the default unit run without a Postgres service.
function setup() {
	const base = new PrismaClient({
		adapter: new PrismaPg({
			connectionString: "postgresql://test:test@localhost:5432/test",
		}),
	});
	const executeRaw = vi.spyOn(base, "$executeRaw");
	const transaction = vi
		.spyOn(base, "$transaction")
		.mockResolvedValue([0, []]);
	const tenant = createTenantDbClient(base);
	return { tenant, transaction, executeRaw };
}

async function readInTenant(tenant: ReturnType<typeof createTenantDbClient>) {
	return runWithTenantContext(
		createOrganizationContext("example-org", "example-user"),
		async () => await tenant.aiChat.findMany(),
	);
}

describe("tenant-db transaction boundary", () => {
	it("submits context and query as a two-operation batch", async () => {
		const { tenant, transaction } = setup();
		await readInTenant(tenant);
		expect(transaction).toHaveBeenCalledTimes(1);
		const batch = transaction.mock.calls[0][0];
		expect(Array.isArray(batch)).toBe(true);
		expect(batch).toHaveLength(2);
	});

	it("parameterizes the RLS statement with tenant type, tenant id and user id", async () => {
		const { tenant, executeRaw } = setup();
		await readInTenant(tenant);
		expect(executeRaw).toHaveBeenCalledExactlyOnceWith(
			expect.any(Array),
			"organization",
			"example-org",
			"example-user",
		);
	});

	it.each(["callback", "array"] as const)(
		"rejects the public %s transaction API",
		(form) => {
			const { tenant, transaction } = setup();
			// Exercise JS callers despite the public type omitting $transaction.
			const runtime = tenant as unknown as Pick<
				PrismaClient,
				"$transaction"
			>;
			expect(() =>
				form === "callback"
					? runtime.$transaction(async () => undefined)
					: runtime.$transaction([]),
			).toThrow("use withRLSContext(db, tx => …)");
			expect(transaction).not.toHaveBeenCalled();
		},
	);
});
