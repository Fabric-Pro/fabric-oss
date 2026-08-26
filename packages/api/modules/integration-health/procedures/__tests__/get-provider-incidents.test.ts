/**
 * Tests for getProviderIncidentsProcedure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListTimeline } = vi.hoisted(() => ({
	mockListTimeline: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listProviderIncidentsForTimeline: (...args: unknown[]) =>
		mockListTimeline(...args),
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

const userCtx = { user: { id: "u-1" } };

async function loadHandler() {
	const mod = await import("../get-provider-incidents");
	return (mod.getProviderIncidentsProcedure as any)._handler as (args: {
		input: { providerKey: string; windowDays?: number };
		context: typeof userCtx;
	}) => Promise<{ incidents: unknown[] }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("getProviderIncidentsProcedure", () => {
	it("forwards providerKey + windowDays to the DB helper", async () => {
		mockListTimeline.mockResolvedValue([{ id: "i-1" }]);
		const handler = await loadHandler();
		await handler({
			input: { providerKey: "openai", windowDays: 7 },
			context: userCtx,
		});
		expect(mockListTimeline).toHaveBeenCalledWith({
			providerKey: "openai",
			windowDays: 7,
		});
	});

	it("uses the default 30-day window when none is supplied", async () => {
		mockListTimeline.mockResolvedValue([]);
		const handler = await loadHandler();
		await handler({
			input: { providerKey: "stripe", windowDays: 30 },
			context: userCtx,
		});
		expect(mockListTimeline).toHaveBeenCalledWith({
			providerKey: "stripe",
			windowDays: 30,
		});
	});
});
