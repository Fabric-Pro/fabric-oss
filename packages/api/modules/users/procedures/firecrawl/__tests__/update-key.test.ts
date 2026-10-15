import { beforeEach, describe, expect, it, vi } from "vitest";

const updateUserFirecrawlKey = vi.fn();
const recordAudit = vi.fn();

vi.mock("@repo/database", () => ({
	updateUserFirecrawlKey: (...a: unknown[]) => updateUserFirecrawlKey(...a),
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (key: string) => `encrypted:${key}`,
	isValidApiKeyFormat: (key: string) => key.length >= 8,
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
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

const KEY = "fc-secretvalue-123456";
const context = { user: { id: "u1" } };

async function run(input: Record<string, unknown>) {
	const { updateUserFirecrawlKeyProcedure } = await import("../update-key");
	return (
		updateUserFirecrawlKeyProcedure as unknown as { handler: Handler }
	).handler({ input, context });
}

beforeEach(() => vi.clearAllMocks());

describe("user Firecrawl key update audit", () => {
	it("records account.integration.config_updated without the key", async () => {
		await run({ apiKey: KEY, enabled: true });
		expect(recordAudit).toHaveBeenCalledTimes(1);
		expect(recordAudit.mock.calls[0][1]).toMatchObject({
			action: "account.integration.config_updated",
			category: "account",
			organizationId: null,
			resource: { type: "integration", id: "firecrawl" },
		});
		const serialized = JSON.stringify(recordAudit.mock.calls[0]);
		expect(serialized).not.toContain("secretvalue");
		expect(serialized).not.toContain("encrypted:");
	});

	it("records nothing when the key format is rejected", async () => {
		await expect(run({ apiKey: "short", enabled: true })).rejects.toThrow(
			/Invalid API key format/,
		);
		expect(updateUserFirecrawlKey).not.toHaveBeenCalled();
		expect(recordAudit).not.toHaveBeenCalled();
	});

	it("records nothing when the write rejects, and only after it resolves", async () => {
		updateUserFirecrawlKey.mockRejectedValue(new Error("db down"));
		await expect(run({ apiKey: KEY, enabled: true })).rejects.toThrow(
			"db down",
		);
		expect(recordAudit).not.toHaveBeenCalled();

		let release: (v?: unknown) => void = () => {};
		updateUserFirecrawlKey.mockReturnValue(
			new Promise((r) => {
				release = r;
			}),
		);
		const pending = run({ apiKey: KEY, enabled: true });
		await new Promise((r) => setTimeout(r, 10));
		expect(updateUserFirecrawlKey).toHaveBeenCalledTimes(2);
		expect(recordAudit).not.toHaveBeenCalled();
		release();
		await pending;
		expect(recordAudit).toHaveBeenCalledTimes(1);
	});
});
