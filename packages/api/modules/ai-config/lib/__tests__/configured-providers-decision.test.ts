import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
	cloudProviderConfig: { findMany: vi.fn() },
	userCloudProviderConfig: { findMany: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	db: mockDb,
	ALL_AUDIO_CAPABLE_PROVIDERS: [],
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	ALL_IMAGE_CAPABLE_PROVIDERS: [],
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY"],
}));

import { getConfiguredProviders } from "../configured-providers";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getConfiguredProviders for DECISION", () => {
	it("uses a configured Vercel AI Gateway even when another provider is primary", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			{
				id: "primary-config",
				provider: "OPENAI_DIRECT",
				displayName: null,
				isDefault: true,
				priority: 10,
				config: {},
			},
			{
				id: "decision-config",
				provider: "VERCEL_GATEWAY",
				displayName: null,
				isDefault: false,
				priority: 5,
				config: { enabledProviders: ["OPENAI_DIRECT"] },
			},
		]);

		const result = await getConfiguredProviders(
			"user-1",
			"org-1",
			"DECISION",
		);

		expect(result.defaultProviderType).toBe("OPENAI_DIRECT");
		expect(result.effectiveProviders).toEqual(["VERCEL_GATEWAY"]);
		expect(mockDb.cloudProviderConfig.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1", enabled: true },
			}),
		);
	});

	it("does not use a personal provider in an organization context", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			{
				id: "primary-config",
				provider: "OPENAI_DIRECT",
				displayName: null,
				isDefault: true,
				priority: 10,
				config: {},
			},
		]);

		const result = await getConfiguredProviders(
			"user-1",
			"org-1",
			"DECISION",
		);

		expect(result.effectiveProviders).toEqual(["OPENAI_DIRECT"]);
		expect(mockDb.userCloudProviderConfig.findMany).not.toHaveBeenCalled();
	});
});
