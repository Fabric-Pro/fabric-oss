import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteUserFirecrawlKey = vi.fn();
const recordAudit = vi.fn();

vi.mock("@repo/database", () => ({
	deleteUserFirecrawlKey: (...a: unknown[]) => deleteUserFirecrawlKey(...a),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => recordAudit(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		requirePermission: () => (c: unknown) => c,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

type Handler = (args: {
	context: { user: { id: string } };
}) => Promise<unknown>;

const context = { user: { id: "u1" } };

async function run() {
	const { deleteUserFirecrawlKeyProcedure } = await import("../delete-key");
	return (
		deleteUserFirecrawlKeyProcedure as unknown as { handler: Handler }
	).handler({ context });
}

beforeEach(() => vi.clearAllMocks());

describe("user Firecrawl key delete audit", () => {
	it("records account.integration.disconnected after the delete", async () => {
		await run();
		expect(deleteUserFirecrawlKey).toHaveBeenCalledWith("u1");
		expect(recordAudit).toHaveBeenCalledTimes(1);
		expect(recordAudit.mock.calls[0][1]).toMatchObject({
			action: "account.integration.disconnected",
			category: "account",
			organizationId: null,
			resource: {
				type: "integration",
				id: "firecrawl",
				name: "firecrawl",
			},
			metadata: { provider: "firecrawl" },
		});
	});

	it("records nothing when the delete fails", async () => {
		deleteUserFirecrawlKey.mockRejectedValue(new Error("db down"));
		await expect(run()).rejects.toThrow("db down");
		expect(recordAudit).not.toHaveBeenCalled();
	});
});
