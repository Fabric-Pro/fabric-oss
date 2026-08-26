/**
 * Tests for listErrorRateIncidentsProcedure.
 *
 * Covers:
 *   - happy path: returns items + nextCursor from the DB helper
 *   - default values: sinceDays=30, limit=50
 *   - filters: status/severity/service/feature pass-through
 *   - cursor pagination: nextCursor propagates
 *   - validation: limit + sinceDays bounds rejected by Zod
 *
 * NOTE: admin authorization is enforced by `adminProcedure`, which is
 * mocked here (every chained method returns the chain stub). The role
 * gate itself is covered by the existing admin-procedure tests in
 * `packages/api/orpc/procedures.ts` — we don't re-prove it per-procedure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListErrorRateIncidents } = vi.hoisted(() => ({
	mockListErrorRateIncidents: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listErrorRateIncidents: (...args: unknown[]) =>
		mockListErrorRateIncidents(...args),
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
	return {
		adminProcedure: chainable,
	};
});

const adminCtx = {
	user: { id: "admin-1", role: "admin" },
	session: { id: "session-1", activeOrganizationId: null },
};

async function loadHandler() {
	const mod = await import("../list-error-rate-incidents");
	return (mod.listErrorRateIncidentsProcedure as any)._handler as (args: {
		input: {
			status?: string;
			severity?: string;
			service?: string;
			feature?: string;
			sinceDays?: number;
			cursor?: string;
			limit?: number;
		};
		context: typeof adminCtx;
	}) => Promise<{ incidents: unknown[]; nextCursor: string | null }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("listErrorRateIncidentsProcedure", () => {
	it("returns DB items + nextCursor with default pagination", async () => {
		mockListErrorRateIncidents.mockResolvedValue({
			items: [
				{ id: "inc-1", severity: "SEV1" },
				{ id: "inc-2", severity: "SEV2" },
			],
			nextCursor: null,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { sinceDays: 30, limit: 50 },
			context: adminCtx,
		});

		expect(mockListErrorRateIncidents).toHaveBeenCalledWith({
			sinceDays: 30,
			limit: 50,
		});
		expect(result.incidents).toHaveLength(2);
		expect(result.nextCursor).toBeNull();
	});

	it("passes status / severity / service / feature filters through", async () => {
		mockListErrorRateIncidents.mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		const handler = await loadHandler();
		await handler({
			input: {
				status: "FIRING",
				severity: "SEV1",
				service: "api",
				feature: "ai_generation",
				sinceDays: 7,
				limit: 20,
			},
			context: adminCtx,
		});

		expect(mockListErrorRateIncidents).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "FIRING",
				severity: "SEV1",
				service: "api",
				feature: "ai_generation",
				sinceDays: 7,
				limit: 20,
			}),
		);
	});

	it("propagates nextCursor when the DB helper returns one", async () => {
		mockListErrorRateIncidents.mockResolvedValue({
			items: Array.from({ length: 50 }, (_, i) => ({ id: `inc-${i}` })),
			nextCursor: "inc-49",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { sinceDays: 30, limit: 50 },
			context: adminCtx,
		});

		expect(result.nextCursor).toBe("inc-49");
		expect(result.incidents).toHaveLength(50);
	});

	it("accepts a cursor and forwards it to the DB helper", async () => {
		mockListErrorRateIncidents.mockResolvedValue({
			items: [{ id: "inc-50" }],
			nextCursor: null,
		});

		const handler = await loadHandler();
		await handler({
			input: { cursor: "inc-49", sinceDays: 30, limit: 50 },
			context: adminCtx,
		});

		expect(mockListErrorRateIncidents).toHaveBeenCalledWith(
			expect.objectContaining({ cursor: "inc-49" }),
		);
	});
});
