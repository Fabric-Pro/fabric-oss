/**
 * `isRoadmapRecommendationProviderAvailable` (Fizzy #2208): true only when the
 * organization's default, enabled provider carries a credential the resolver
 * can use. Fail-closed on a null organization and on a lookup error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@repo/database", async () => {
	const credentials = await vi.importActual<
		typeof import("../../../../../../database/prisma/queries/ai-gateway")
	>("../../../../../../database/prisma/queries/ai-gateway");
	return {
		db: { cloudProviderConfig: { findFirst: mocks.findFirst } },
		readProviderRowCredentials: credentials.readProviderRowCredentials,
	};
});
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isRoadmapRecommendationProviderAvailable } from "../availability";

const ROW = {
	encryptedApiKey: null,
	clientId: null,
	encryptedClientSecret: null,
	config: null,
};

function check(organizationId: string | null = "org-1") {
	return isRoadmapRecommendationProviderAvailable({
		projectId: "p1",
		organizationId,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("isRoadmapRecommendationProviderAvailable", () => {
	it("is true when the organization's default provider has an API key", async () => {
		mocks.findFirst.mockResolvedValue({ ...ROW, encryptedApiKey: "enc" });
		await expect(check()).resolves.toBe(true);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: "org-1",
					isDefault: true,
					enabled: true,
				},
			}),
		);
	});

	it("is true for a service-principal provider with no API key", async () => {
		mocks.findFirst.mockResolvedValue({
			...ROW,
			clientId: "client",
			encryptedClientSecret: "secret",
		});
		await expect(check()).resolves.toBe(true);
	});

	it("honours a legacy key stored in config", async () => {
		mocks.findFirst.mockResolvedValue({
			...ROW,
			config: { apiKey: "legacy" },
		});
		await expect(check()).resolves.toBe(true);
	});

	it("is false when the organization has no default provider", async () => {
		mocks.findFirst.mockResolvedValue(null);
		await expect(check()).resolves.toBe(false);
	});

	it("is false when the provider row has no usable credential", async () => {
		mocks.findFirst.mockResolvedValue({ ...ROW, clientId: "client" });
		await expect(check()).resolves.toBe(false);
	});

	it("is false for a null organization, without a lookup", async () => {
		await expect(check(null)).resolves.toBe(false);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("is false when the lookup fails", async () => {
		mocks.findFirst.mockRejectedValue(new Error("db down"));
		await expect(check()).resolves.toBe(false);
	});
});
