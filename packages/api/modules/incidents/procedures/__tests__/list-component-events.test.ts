/**
 * Tests for listComponentEventsProcedure (component incident events).
 *
 * Covers:
 *   - happy path: returns the events list when the incident exists
 *   - NOT_FOUND when the component incident does not exist (and the events
 *     query is NOT called)
 *
 * Mirrors `list-events.test.ts` (the error-rate variant).
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetById, mockListEvents } = vi.hoisted(() => ({
	mockGetById: vi.fn(),
	mockListEvents: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getComponentIncidentById: (...args: unknown[]) => mockGetById(...args),
	listComponentIncidentEvents: (...args: unknown[]) =>
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

const adminCtx = { user: { id: "admin-9", role: "admin" } };

async function loadHandler() {
	const mod = await import("../list-component-events");
	return (mod.listComponentEventsProcedure as any)._handler as (args: {
		input: { id: string };
		context: typeof adminCtx;
	}) => Promise<{ events: unknown[] }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("listComponentEventsProcedure", () => {
	it("returns the events list when the component incident exists", async () => {
		mockGetById.mockResolvedValue({ id: "ci-1" });
		mockListEvents.mockResolvedValue([
			{ id: "e-1", eventType: "FIRED" },
			{ id: "e-2", eventType: "MANUAL_RESOLVED" },
		]);
		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ci-1" },
			context: adminCtx,
		});
		expect(result.events).toHaveLength(2);
		expect(mockListEvents).toHaveBeenCalledWith("ci-1");
	});

	it("throws NOT_FOUND when the component incident is missing", async () => {
		mockGetById.mockResolvedValue(null);
		const handler = await loadHandler();
		await expect(
			handler({ input: { id: "ghost" }, context: adminCtx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockListEvents).not.toHaveBeenCalled();
	});
});
