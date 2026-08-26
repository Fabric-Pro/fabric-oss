/**
 * Tests for listEventsProcedure (error-rate incident events).
 *
 * Covers:
 *   - happy path: returns the events list
 *   - NOT_FOUND when the incident does not exist
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetById, mockListEvents } = vi.hoisted(() => ({
	mockGetById: vi.fn(),
	mockListEvents: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getErrorRateIncidentById: (...args: unknown[]) => mockGetById(...args),
	listErrorRateIncidentEvents: (...args: unknown[]) =>
		mockListEvents(...args),
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
	return { adminProcedure: chainable };
});

const adminCtx = { user: { id: "admin-4", role: "admin" } };

async function loadHandler() {
	const mod = await import("../list-events");
	return (mod.listEventsProcedure as any)._handler as (args: {
		input: { id: string };
		context: typeof adminCtx;
	}) => Promise<{ events: unknown[] }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("listEventsProcedure", () => {
	it("returns the events list when the incident exists", async () => {
		mockGetById.mockResolvedValue({ id: "inc-3" });
		mockListEvents.mockResolvedValue([
			{ id: "e-1", eventType: "FIRED" },
			{ id: "e-2", eventType: "COMMENT" },
		]);
		const handler = await loadHandler();
		const result = await handler({
			input: { id: "inc-3" },
			context: adminCtx,
		});
		expect(result.events).toHaveLength(2);
	});

	it("throws NOT_FOUND when the incident is missing", async () => {
		mockGetById.mockResolvedValue(null);
		const handler = await loadHandler();
		await expect(
			handler({ input: { id: "ghost" }, context: adminCtx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockListEvents).not.toHaveBeenCalled();
	});
});
