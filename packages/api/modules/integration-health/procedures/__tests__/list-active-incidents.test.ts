/**
 * Tests for listActiveIncidentsProcedure.
 *
 * Covers:
 *   - happy path: returns errorRate + integration + component arrays from DB helper
 *   - empty case: all three arrays empty when nothing is active
 *   - v3 admin-incidents pass: the new `component` stream is returned even
 *     when only component incidents are FIRING (no integration/errorRate).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListActive } = vi.hoisted(() => ({ mockListActive: vi.fn() }));

vi.mock("@repo/database", () => ({
	listActiveSevHighIncidents: (...args: unknown[]) => mockListActive(...args),
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

const userCtx = { user: { id: "u-1", role: "user" } };

async function loadHandler() {
	const mod = await import("../list-active-incidents");
	return (mod.listActiveIncidentsProcedure as any)._handler as (args: {
		context: typeof userCtx;
	}) => Promise<{
		errorRate: unknown[];
		integration: unknown[];
		component: unknown[];
	}>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("listActiveIncidentsProcedure", () => {
	it("returns FIRING/ACKNOWLEDGED SEV1/SEV2 incidents from all three streams", async () => {
		mockListActive.mockResolvedValue({
			errorRate: [{ id: "e1", severity: "SEV1", status: "FIRING" }],
			integration: [
				{ id: "i1", severity: "SEV2", status: "ACKNOWLEDGED" },
				{ id: "i2", severity: "SEV1", status: "FIRING" },
			],
			component: [{ id: "c1", severity: "SEV1", status: "FIRING" }],
		});
		const handler = await loadHandler();
		const result = await handler({ context: userCtx });
		expect(result.errorRate).toHaveLength(1);
		expect(result.integration).toHaveLength(2);
		expect(result.component).toHaveLength(1);
	});

	it("returns empty arrays when nothing is active", async () => {
		mockListActive.mockResolvedValue({
			errorRate: [],
			integration: [],
			component: [],
		});
		const handler = await loadHandler();
		const result = await handler({ context: userCtx });
		expect(result.errorRate).toEqual([]);
		expect(result.integration).toEqual([]);
		expect(result.component).toEqual([]);
	});

	it("surfaces a component-only outage when only component incidents are FIRING", async () => {
		mockListActive.mockResolvedValue({
			errorRate: [],
			integration: [],
			component: [
				{
					id: "c1",
					severity: "SEV1",
					status: "FIRING",
					componentKey: "temporal-worker",
					componentName: "Temporal Worker",
				},
			],
		});
		const handler = await loadHandler();
		const result = await handler({ context: userCtx });
		expect(result.errorRate).toEqual([]);
		expect(result.integration).toEqual([]);
		expect(result.component).toHaveLength(1);
	});
});
