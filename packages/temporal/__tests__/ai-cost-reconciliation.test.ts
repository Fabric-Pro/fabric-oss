import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getGatewayApiKey: vi.fn(),
	fetchGatewayGenerationCostUsd: vi.fn(),
	getPendingGatewayCostRows: vi.fn(),
	applyActualGatewayCost: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getGatewayApiKey: h.getGatewayApiKey,
	fetchGatewayGenerationCostUsd: h.fetchGatewayGenerationCostUsd,
}));
vi.mock("@repo/database", () => ({
	getPendingGatewayCostRows: h.getPendingGatewayCostRows,
	applyActualGatewayCost: h.applyActualGatewayCost,
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const { reconcileGatewayCosts } = await import(
	"../src/activities/ai-cost-reconciliation"
);

const INPUT = { windowMs: 3_600_000, batchLimit: 100 };

describe("reconcileGatewayCosts", () => {
	beforeEach(() => {
		h.getGatewayApiKey.mockReset();
		h.fetchGatewayGenerationCostUsd.mockReset();
		h.getPendingGatewayCostRows.mockReset();
		h.applyActualGatewayCost.mockReset();
		h.getGatewayApiKey.mockReturnValue("key");
		h.applyActualGatewayCost.mockResolvedValue(true);
	});

	it("skips entirely when no gateway API key is configured", async () => {
		h.getGatewayApiKey.mockReturnValue(undefined);
		const r = await reconcileGatewayCosts(INPUT);
		expect(r).toEqual({
			scanned: 0,
			reconciled: 0,
			pending: 0,
			skippedNoKey: true,
		});
		expect(h.getPendingGatewayCostRows).not.toHaveBeenCalled();
	});

	it("reconciles rows with a resolved cost, leaves null-cost rows pending", async () => {
		h.getPendingGatewayCostRows.mockResolvedValue([
			{ id: "a", gatewayGenerationId: "gen_a" },
			{ id: "b", gatewayGenerationId: "gen_b" },
			{ id: "c", gatewayGenerationId: "gen_c" },
		]);
		h.fetchGatewayGenerationCostUsd.mockImplementation(
			async (id: string) => (id === "gen_b" ? null : 0.01),
		);
		const r = await reconcileGatewayCosts(INPUT);
		expect(r).toMatchObject({ scanned: 3, reconciled: 2, pending: 1 });
		expect(h.applyActualGatewayCost).toHaveBeenCalledWith({
			id: "a",
			actualCostUsd: 0.01,
		});
		// null-cost row never gets an update
		expect(h.applyActualGatewayCost).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: "b" }),
		);
	});

	it("does not count a row already reconciled by a concurrent sweep", async () => {
		h.getPendingGatewayCostRows.mockResolvedValue([
			{ id: "a", gatewayGenerationId: "gen_a" },
		]);
		h.fetchGatewayGenerationCostUsd.mockResolvedValue(0.02);
		h.applyActualGatewayCost.mockResolvedValue(false); // guard lost the race
		const r = await reconcileGatewayCosts(INPUT);
		expect(r).toMatchObject({ scanned: 1, reconciled: 0, pending: 0 });
	});
});
