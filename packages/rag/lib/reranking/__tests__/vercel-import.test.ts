import { afterEach, expect, it, vi } from "vitest";

const transformersImported = vi.hoisted(() => vi.fn());
const orgLookup = vi.hoisted(() =>
	vi.fn(async (organizationId: string) =>
		organizationId === "example-org"
			? null
			: {
					apiKey: "encrypted-example-foreign-key",
					configId: "example-foreign-config",
				},
	),
);
vi.mock("@huggingface/transformers", () => {
	transformersImported();
	throw new Error("The native model must not be imported on Vercel");
});
vi.mock("@repo/database", () => ({
	getOrganizationGatewaySearchConfig: orgLookup,
}));
vi.mock("@repo/ai/lib/databricks-oauth", () => ({
	resolveProviderApiKey: vi.fn().mockResolvedValue("example-foreign-key"),
}));
vi.mock("@repo/ai/lib/gateway-rerank-limits", () => ({
	assertGatewayRerankUsageLimits: vi.fn(),
}));
vi.mock("ai", () => ({
	createGateway: vi.fn(() => ({ rerankingModel: vi.fn() })),
	rerank: vi.fn().mockRejectedValue(new Error("Unexpected gateway dispatch")),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { logger } from "@repo/logs";
import { rerankContexts } from "../index";

afterEach(() => {
	vi.unstubAllEnvs();
});

it("does not import transformers through the real cross-encoder module on Vercel", async () => {
	vi.stubEnv("VERCEL", "1");
	vi.stubEnv("RERANKER_PROVIDER", "");
	const contexts = [
		{
			id: "example-first",
			type: "TEXT",
			content: "example first document",
			score: 0.8,
		},
		{
			id: "example-second",
			type: "TEXT",
			content: "example second document",
			score: 0.7,
		},
	];
	const result = await rerankContexts({
		query: "example query",
		contexts,
		tenant: { userId: "example-user", organizationId: "example-org" },
	});
	expect(orgLookup).toHaveBeenCalledExactlyOnceWith("example-org");
	expect(result.contexts).toBe(contexts);
	expect(result.stats.model).toBe("skipped");
	expect(transformersImported).not.toHaveBeenCalled();
	expect(logger.error).not.toHaveBeenCalled();
});
