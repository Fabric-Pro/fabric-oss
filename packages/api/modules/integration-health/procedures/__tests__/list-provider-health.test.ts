/**
 * Tests for listProviderHealthProcedure.
 *
 * Covers:
 *   - happy path: returns providers array from DB
 *   - empty providerKeys filter: returns all rows
 *   - explicit providerKeys filter: forwarded to DB helper
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListProviderHealth } = vi.hoisted(() => ({
	mockListProviderHealth: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listProviderHealth: (...args: unknown[]) => mockListProviderHealth(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return { protectedProcedure: chainable };
});

const userCtx = {
	user: { id: "user-9", role: "user" },
	session: { id: "session-9", activeOrganizationId: null },
};

async function loadHandler() {
	const mod = await import("../list-provider-health");
	return (mod.listProviderHealthProcedure as any)._handler as (args: {
		input: { providerKeys?: string[] };
		context: typeof userCtx;
	}) => Promise<{ providers: unknown[] }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("listProviderHealthProcedure", () => {
	it("returns all providers when no filter is supplied", async () => {
		mockListProviderHealth.mockResolvedValue([
			{ providerKey: "openai", displayName: "OpenAI" },
			{ providerKey: "stripe", displayName: "Stripe" },
		]);
		const handler = await loadHandler();
		const result = await handler({ input: {}, context: userCtx });
		expect(mockListProviderHealth).toHaveBeenCalledWith({
			providerKeys: undefined,
		});
		expect(result.providers).toHaveLength(2);
	});

	it("forwards providerKeys filter to the DB helper", async () => {
		mockListProviderHealth.mockResolvedValue([
			{ providerKey: "stripe", displayName: "Stripe" },
		]);
		const handler = await loadHandler();
		await handler({
			input: { providerKeys: ["stripe"] },
			context: userCtx,
		});
		expect(mockListProviderHealth).toHaveBeenCalledWith({
			providerKeys: ["stripe"],
		});
	});
});
