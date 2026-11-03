import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ canonical: vi.fn(), limits: vi.fn() }));
vi.mock("@repo/database", () => ({
	getCanonicalNameForProviderModelId: mocks.canonical,
}));
vi.mock("@repo/payments", () => ({ assertWithinAiUsageLimits: mocks.limits }));

import { assertGatewayRerankUsageLimits } from "../gateway-rerank-limits";

const scope = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
	providerConfigId: "example-config",
	providerModelId: "cohere/rerank-v5-pro",
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.canonical.mockResolvedValue("example-rerank-canonical");
});
describe("gateway rerank usage limits", () => {
	it("checks the matching tenant, connection, canonical model, task and project scope", async () => {
		expect(await assertGatewayRerankUsageLimits(scope)).toBe(
			"example-rerank-canonical",
		);
		expect(mocks.canonical).toHaveBeenCalledExactlyOnceWith(
			"cohere/rerank-v5-pro",
			"VERCEL_GATEWAY",
		);
		expect(mocks.limits).toHaveBeenCalledExactlyOnceWith({
			userId: "example-user",
			organizationId: "example-org",
			projectId: "example-project",
			providerConfigId: "example-config",
			modelCanonicalName: "example-rerank-canonical",
			taskType: "EMBEDDING",
		});
	});
	it("checks the broader scopes even when the model is absent from the catalog", async () => {
		mocks.canonical.mockResolvedValue(null);
		await assertGatewayRerankUsageLimits({
			userId: scope.userId,
			organizationId: scope.organizationId,
			providerModelId: scope.providerModelId,
		});
		expect(mocks.limits).toHaveBeenCalledExactlyOnceWith({
			userId: "example-user",
			organizationId: "example-org",
			projectId: null,
			providerConfigId: null,
			modelCanonicalName: null,
			taskType: "EMBEDDING",
		});
	});
	it.each([
		{ userId: undefined },
		{ organizationId: undefined },
		{ organizationId: null },
	])("rejects missing attribution %j", async (missing) => {
		await expect(
			assertGatewayRerankUsageLimits({ ...scope, ...missing }),
		).rejects.toThrow("organization and user");
		expect(mocks.limits).not.toHaveBeenCalled();
		expect(mocks.canonical).not.toHaveBeenCalled();
	});
	it("preserves the actual hard-limit error instance", async () => {
		const error = new AiUsageLimitExceededError({
			message: "Example limit reached",
			limitId: "example-limit",
			dimension: "TOKENS" as never,
			window: "MONTHLY" as never,
			used: BigInt(1),
			max: BigInt(1),
			manageLimitsUrl: "https://example.com/limits",
		});
		mocks.limits.mockRejectedValue(error);
		await expect(assertGatewayRerankUsageLimits(scope)).rejects.toBe(error);
	});
});
