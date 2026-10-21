import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getGatewayApiKey: vi.fn(),
	fetchGatewayGenerationCostUsd: vi.fn(),
	getPendingGatewayCostRows: vi.fn(),
	applyActualGatewayCost: vi.fn(),
	getGatewayCostLookupCredentials: vi.fn(),
	resolveProviderApiKey: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getGatewayApiKey: h.getGatewayApiKey,
	fetchGatewayGenerationCostUsd: h.fetchGatewayGenerationCostUsd,
	resolveProviderApiKey: h.resolveProviderApiKey,
}));
vi.mock("@repo/database", () => ({
	getPendingGatewayCostRows: h.getPendingGatewayCostRows,
	applyActualGatewayCost: h.applyActualGatewayCost,
	getGatewayCostLookupCredentials: h.getGatewayCostLookupCredentials,
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
	log: { warn: h.warn },
}));

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
		h.getGatewayCostLookupCredentials.mockReset();
		h.resolveProviderApiKey.mockReset();
		h.getGatewayApiKey.mockReturnValue("key");
		h.applyActualGatewayCost.mockResolvedValue(true);
		h.getGatewayCostLookupCredentials.mockResolvedValue(new Map());
	});

	it("skips when no pending row has a key to look its cost up with", async () => {
		h.getGatewayApiKey.mockReturnValue(undefined);
		h.getPendingGatewayCostRows.mockResolvedValue([
			{ id: "a", gatewayGenerationId: "gen_a", providerConfigId: null },
		]);
		const r = await reconcileGatewayCosts(INPUT);
		expect(r).toEqual({
			scanned: 1,
			reconciled: 0,
			pending: 0,
			skippedNoKey: true,
		});
		expect(h.fetchGatewayGenerationCostUsd).not.toHaveBeenCalled();
	});

	it("looks a tenant's row up with its own provider key, with no platform key set", async () => {
		h.getGatewayApiKey.mockReturnValue(undefined);
		h.getPendingGatewayCostRows.mockResolvedValue([
			{
				id: "a",
				gatewayGenerationId: "gen_a",
				providerConfigId: "cfg-org",
			},
			{
				id: "b",
				gatewayGenerationId: "gen_b",
				providerConfigId: "cfg-gone",
			},
		]);
		const credential = {
			provider: "VERCEL_GATEWAY",
			apiKey: "encrypted",
			clientId: null,
			encryptedClientSecret: null,
		};
		h.getGatewayCostLookupCredentials.mockResolvedValue(
			new Map([["cfg-org", credential]]),
		);
		h.resolveProviderApiKey.mockResolvedValue("tenant-key");
		h.fetchGatewayGenerationCostUsd.mockResolvedValue(0.03);

		const r = await reconcileGatewayCosts(INPUT);

		expect(h.getGatewayCostLookupCredentials).toHaveBeenCalledWith([
			"cfg-org",
			"cfg-gone",
		]);
		expect(h.resolveProviderApiKey).toHaveBeenCalledWith(credential);
		expect(h.fetchGatewayGenerationCostUsd).toHaveBeenCalledExactlyOnceWith(
			"gen_a",
			"tenant-key",
		);
		expect(r).toEqual({
			scanned: 2,
			reconciled: 1,
			pending: 0,
			skippedNoKey: false,
		});
	});

	it("keeps going when one config's key cannot be read", async () => {
		h.getPendingGatewayCostRows.mockResolvedValue([
			{
				id: "a",
				gatewayGenerationId: "gen_a",
				providerConfigId: "cfg-bad",
			},
			{ id: "b", gatewayGenerationId: "gen_b", providerConfigId: null },
		]);
		h.getGatewayCostLookupCredentials.mockResolvedValue(
			new Map([
				[
					"cfg-bad",
					{
						provider: "VERCEL_GATEWAY",
						apiKey: "corrupt",
						clientId: null,
						encryptedClientSecret: null,
					},
				],
			]),
		);
		h.resolveProviderApiKey.mockRejectedValue(new Error("decrypt failed"));
		h.fetchGatewayGenerationCostUsd.mockResolvedValue(0.01);

		const r = await reconcileGatewayCosts(INPUT);

		expect(h.fetchGatewayGenerationCostUsd).toHaveBeenCalledExactlyOnceWith(
			"gen_b",
			"key",
		);
		expect(r).toMatchObject({ scanned: 2, reconciled: 1 });
		expect(h.warn).toHaveBeenCalledWith(
			"[AiCostReconciliation] Provider key unreadable",
			{ configId: "cfg-bad", error: "decrypt failed" },
		);
	});

	it("reconciles rows with a resolved cost, leaves null-cost rows pending", async () => {
		h.getPendingGatewayCostRows.mockResolvedValue([
			{ id: "a", gatewayGenerationId: "gen_a", providerConfigId: null },
			{ id: "b", gatewayGenerationId: "gen_b", providerConfigId: null },
			{ id: "c", gatewayGenerationId: "gen_c", providerConfigId: null },
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
			{ id: "a", gatewayGenerationId: "gen_a", providerConfigId: null },
		]);
		h.fetchGatewayGenerationCostUsd.mockResolvedValue(0.02);
		h.applyActualGatewayCost.mockResolvedValue(false); // guard lost the race
		const r = await reconcileGatewayCosts(INPUT);
		expect(r).toMatchObject({ scanned: 1, reconciled: 0, pending: 0 });
	});
});
