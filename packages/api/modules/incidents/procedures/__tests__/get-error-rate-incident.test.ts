/**
 * Tests for getErrorRateIncidentProcedure.
 *
 * Covers:
 *   - happy path: returns incident + events split
 *   - NOT_FOUND when the DB helper returns null
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetById } = vi.hoisted(() => ({ mockGetById: vi.fn() }));

vi.mock("@repo/database", () => ({
	getErrorRateIncidentById: (...args: unknown[]) => mockGetById(...args),
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

const adminCtx = { user: { id: "admin-1", role: "admin" } };

async function loadHandler() {
	const mod = await import("../get-error-rate-incident");
	return (mod.getErrorRateIncidentProcedure as any)._handler as (args: {
		input: { id: string };
		context: typeof adminCtx;
	}) => Promise<{ incident: unknown; events: unknown[] }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("getErrorRateIncidentProcedure", () => {
	it("returns the incident split from the events timeline", async () => {
		mockGetById.mockResolvedValue({
			id: "inc-9",
			severity: "SEV1",
			events: [
				{ id: "e-1", eventType: "FIRED" },
				{ id: "e-2", eventType: "ACKNOWLEDGED" },
			],
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "inc-9" },
			context: adminCtx,
		});
		expect(result.incident).toMatchObject({
			id: "inc-9",
			severity: "SEV1",
		});
		// The events property is removed from `incident` and exposed at top level.
		expect(
			(result.incident as { events?: unknown }).events,
		).toBeUndefined();
		expect(result.events).toHaveLength(2);
	});

	it("throws NOT_FOUND when the row is missing", async () => {
		mockGetById.mockResolvedValue(null);
		const handler = await loadHandler();
		await expect(
			handler({ input: { id: "ghost" }, context: adminCtx }),
		).rejects.toBeInstanceOf(ORPCError);
	});
});
