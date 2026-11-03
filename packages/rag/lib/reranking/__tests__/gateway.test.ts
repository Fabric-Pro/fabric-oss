import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	org: vi.fn(),
	decrypt: vi.fn(),
	usage: vi.fn(),
	rerank: vi.fn(),
	gateway: vi.fn(),
	model: vi.fn(),
	guard: vi.fn(),
	stop: vi.fn(),
	limits: vi.fn(),
	local: vi.fn(),
	localConstructor: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getOrganizationGatewaySearchConfig: mocks.org,
	logAiUsageAsync: mocks.usage,
}));
vi.mock("@repo/ai/lib/databricks-oauth", () => ({
	resolveProviderApiKey: mocks.decrypt,
}));
vi.mock("@repo/ai/lib/gateway-rerank-limits", () => ({
	assertGatewayRerankUsageLimits: mocks.limits,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("ai", () => ({ createGateway: mocks.gateway, rerank: mocks.rerank }));
vi.mock("@repo/utils/dispatch-guard", () => ({
	guardDispatch: mocks.guard,
	throwIfDispatchStopped: mocks.stop,
	rethrowIfDispatchStopped: (error: unknown) => {
		if (error instanceof Error && error.message === "dispatch stopped") {
			throw error;
		}
	},
}));
vi.mock("../providers/cross-encoder", () => ({
	CrossEncoderRerankerProvider: class {
		constructor() {
			mocks.localConstructor();
		}
		rerank = mocks.local;
	},
}));

import { logger } from "@repo/logs";
import type { RetrievedContext } from "../../project-contexts/retrieval";
import { getRerankerConfig } from "../config";
import { getAvailableRerankers, rerankContexts } from "../index";
import { GatewayRerankerProvider } from "../providers/gateway";

const tenant = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
};
const credential = {
	apiKey: "encrypted-example-key",
	configId: "example-config",
};
const documents = ["alpha", "beta", "gamma"].map((content) => ({
	content,
	score: 0.5,
	metadata: {},
})) as RetrievedContext[];

beforeEach(() => {
	vi.resetAllMocks();
	vi.unstubAllEnvs();
	vi.stubEnv("RERANKER_PROVIDER", "");
	vi.stubEnv("RERANKER_GATEWAY_MODEL", "");
	vi.stubEnv("COHERE_API_KEY", "");
	vi.stubEnv("VERCEL", "");
	vi.stubEnv("AI_GATEWAY_API_KEY", "");
	mocks.org.mockImplementation(async (organizationId) =>
		organizationId === tenant.organizationId ? null : credential,
	);
	mocks.limits.mockResolvedValue("example-rerank-canonical");
	mocks.local.mockResolvedValue([
		{ document: documents[1], relevanceScore: 0.9, originalIndex: 1 },
	]);
	mocks.decrypt.mockResolvedValue("example-key");
	mocks.gateway.mockReturnValue({ rerankingModel: mocks.model });
	mocks.model.mockReturnValue("example-model");
	mocks.guard.mockImplementation(async (signal) => signal);
	mocks.rerank.mockResolvedValue({
		ranking: [
			{ originalIndex: 0, score: 0.1, document: "alpha" },
			{ originalIndex: 2, score: 0.9, document: "gamma" },
			{ originalIndex: 1, score: 0.7, document: "beta" },
		],
		providerMetadata: { gateway: { generationId: "example-generation" } },
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("tenant-aware selection", () => {
	it.each([undefined, "cross-encoder"] as const)(
		"uses the org gateway for default preference %s",
		async (preference) => {
			mocks.org.mockResolvedValue(credential);
			expect(
				await getRerankerConfig(preference, undefined, tenant),
			).toMatchObject({
				provider: "gateway",
				apiKey: "example-key",
				providerConfigId: "example-config",
			});
			expect(mocks.org).toHaveBeenCalledExactlyOnceWith(
				tenant.organizationId,
			);
			expect(mocks.decrypt).toHaveBeenCalledWith(credential);
		},
	);
	it.each([undefined, "cross-encoder", "gateway"] as const)(
		"falls back to local without a credential (%s)",
		async (preference) => {
			expect(
				(await getRerankerConfig(preference, undefined, tenant))
					.provider,
			).toBe("cross-encoder");
			expect(mocks.decrypt).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ organizationId: "example-org" },
		{ userId: "example-user" },
		{ userId: "example-user", organizationId: null },
		undefined,
	])("does not look up a personal credential for %j", async (scope) => {
		vi.stubEnv("AI_GATEWAY_API_KEY", "example-platform-key");
		expect(
			await getRerankerConfig(undefined, undefined, scope),
		).toMatchObject({
			provider: "cross-encoder",
			providerConfigId: undefined,
		});
		expect(mocks.org).not.toHaveBeenCalled();
	});
	it.each([undefined, "cross-encoder", "gateway"] as const)(
		"ignores platform credentials when the organization has no gateway key (%s)",
		async (preference) => {
			vi.stubEnv("AI_GATEWAY_API_KEY", "example-platform-key");
			expect(
				(await getRerankerConfig(preference, undefined, tenant))
					.provider,
			).toBe("cross-encoder");
			expect(mocks.org).toHaveBeenCalledExactlyOnceWith(
				tenant.organizationId,
			);
			expect(mocks.decrypt).not.toHaveBeenCalled();
		},
	);

	it.each(["gateway", "cross-encoder", "cohere"] as const)(
		"honors environment %s over the stored default",
		async (provider) => {
			vi.stubEnv("RERANKER_PROVIDER", provider);
			vi.stubEnv("COHERE_API_KEY", "example-cohere-key");
			mocks.org.mockResolvedValue(credential);
			expect(
				(await getRerankerConfig("cross-encoder", undefined, tenant))
					.provider,
			).toBe(provider);
		},
	);
	it("resolves each organization's credential independently", async () => {
		mocks.org.mockImplementation(async (organizationId) => ({
			apiKey: `encrypted-${organizationId}`,
			configId: organizationId,
		}));
		mocks.decrypt.mockImplementation(async ({ apiKey }) => apiKey);
		const first = await getRerankerConfig(undefined, undefined, tenant);
		const second = await getRerankerConfig(undefined, undefined, {
			...tenant,
			organizationId: "example-other-org",
		});
		expect(first).toMatchObject({
			apiKey: "encrypted-example-org",
			providerConfigId: "example-org",
		});
		expect(second).toMatchObject({
			apiKey: "encrypted-example-other-org",
			providerConfigId: "example-other-org",
		});
		expect(mocks.org).toHaveBeenNthCalledWith(2, "example-other-org");
		expect(mocks.org).toHaveBeenCalledTimes(2);
	});
	it("does not expose credentials when resolution fails", async () => {
		mocks.org.mockResolvedValue(credential);
		mocks.decrypt.mockRejectedValue(new Error("example-secret-value"));
		await expect(
			getRerankerConfig(undefined, undefined, tenant),
		).rejects.toThrow("Gateway reranker credential resolution failed");
	});

	it("ignores an unknown environment provider", async () => {
		vi.stubEnv("RERANKER_PROVIDER", "unknown");
		mocks.org.mockResolvedValue(credential);
		expect(
			(await getRerankerConfig(undefined, undefined, tenant)).provider,
		).toBe("gateway");
	});
	it("honors explicit Cohere over gateway defaults and environment", async () => {
		vi.stubEnv("RERANKER_PROVIDER", "gateway");
		vi.stubEnv("COHERE_API_KEY", "example-cohere-key");
		expect(
			(await getRerankerConfig("cohere", undefined, tenant)).provider,
		).toBe("cohere");
		expect(mocks.org).not.toHaveBeenCalled();
	});
	it("preserves custom Cohere configuration when Cohere is available", async () => {
		vi.stubEnv("COHERE_API_KEY", "example-cohere-key");
		expect(
			await getRerankerConfig(
				"cohere",
				{
					apiKey: "example-custom-cohere-key",
					model: "example-model",
					timeout: 1234,
				},
				tenant,
			),
		).toMatchObject({
			provider: "cohere",
			apiKey: "example-custom-cohere-key",
			model: "example-model",
			timeout: 1234,
		});
	});

	it("falls back to local for explicit Cohere without its key", async () => {
		expect(
			(await getRerankerConfig("cohere", undefined, tenant)).provider,
		).toBe("cross-encoder");
	});
	it("honors explicit gateway over the environment and its model override", async () => {
		vi.stubEnv("RERANKER_PROVIDER", "cross-encoder");
		vi.stubEnv("RERANKER_GATEWAY_MODEL", "example/rerank-model");
		mocks.org.mockResolvedValue(credential);
		expect(
			await getRerankerConfig("gateway", undefined, tenant),
		).toMatchObject({ provider: "gateway", model: "example/rerank-model" });
	});
});

describe("gateway dispatch and usage", () => {
	const provider = () =>
		new GatewayRerankerProvider({
			provider: "gateway",
			apiKey: "example-key",
			tenant,
			providerConfigId: "example-config",
			timeout: 1234,
		});
	it("rejects a missing credential", () => {
		expect(
			() => new GatewayRerankerProvider({ provider: "gateway" }),
		).toThrow("requires a credential");
	});
	it("maps original indices, filters scores, sorts, limits and records usage", async () => {
		const results = await provider().rerank({
			query: "example query",
			documents,
			topK: 1,
			minRelevanceScore: 0.5,
		});
		expect(results).toEqual([
			{ document: documents[2], relevanceScore: 0.9, originalIndex: 2 },
		]);
		expect(mocks.model).toHaveBeenCalledWith("cohere/rerank-v5-pro");
		expect(mocks.rerank).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "example-model",
				query: "example query",
				documents: ["alpha", "beta", "gamma"],
				topN: 1,
				abortSignal: expect.any(AbortSignal),
				maxRetries: 0,
			}),
		);
		expect(mocks.usage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				...tenant,
				provider: "VERCEL_GATEWAY",
				providerModelId: "cohere/rerank-v5-pro",
				providerConfigId: "example-config",
				taskType: "EMBEDDING",
				callPurpose: "project-retrieval-rerank",
				gatewayGenerationId: "example-generation",
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				success: true,
			}),
		);
	});
	it("applies the relevance threshold independently of topK", async () => {
		expect(
			await provider().rerank({
				query: "q",
				documents,
				topK: 3,
				minRelevanceScore: 0.8,
			}),
		).toHaveLength(1);
	});
	it.each([undefined, { gateway: { generationId: 123 } }])(
		"tolerates absent or malformed generation metadata %j",
		async (providerMetadata) => {
			mocks.rerank.mockResolvedValue({ ranking: [], providerMetadata });
			await provider().rerank({ query: "q", documents });
			expect(
				mocks.usage.mock.calls[0][0].gatewayGenerationId,
			).toBeUndefined();
		},
	);
	it("keeps results when usage logging throws", async () => {
		mocks.usage.mockImplementation(() => {
			throw new Error("example logging failure");
		});
		expect(await provider().rerank({ query: "q", documents })).toHaveLength(
			3,
		);
	});
	it("does not dispatch or log for an empty document list", async () => {
		expect(await provider().rerank({ query: "q", documents: [] })).toEqual(
			[],
		);
		expect(mocks.rerank).not.toHaveBeenCalled();
		expect(mocks.usage).not.toHaveBeenCalled();
	});
	it("uses the dispatch guard signal and configured timeout", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const signal = new AbortController().signal;
		mocks.guard.mockResolvedValue(signal);
		await provider().rerank({ query: "q", documents });
		expect(timeout).toHaveBeenCalledWith(1234);
		expect(mocks.rerank.mock.calls[0][0].abortSignal).toBe(signal);
		expect(mocks.stop).toHaveBeenCalledTimes(2);
		timeout.mockRestore();
	});
	it("stops before the paid send when dispatch is latched", async () => {
		mocks.stop.mockImplementation(() => {
			throw new Error("dispatch stopped");
		});
		await expect(
			provider().rerank({ query: "q", documents }),
		).rejects.toThrow("dispatch stopped");
		expect(mocks.rerank).not.toHaveBeenCalled();
	});
	it("reports the resolved provider and passes through gateway errors without leaking keys", async () => {
		mocks.org.mockResolvedValue(credential);
		mocks.rerank.mockRejectedValue(new Error("example-key"));
		const result = await rerankContexts({
			query: "q",
			contexts: documents,
			provider: "cross-encoder",
			tenant,
		});
		expect(result.contexts).toBe(documents);
		expect(result.stats).toMatchObject({
			provider: "gateway",
			model: "fallback-passthrough",
		});
		expect(mocks.usage).not.toHaveBeenCalled();
		expect(
			JSON.stringify(vi.mocked(logger.error).mock.calls),
		).not.toContain("example-key");
	});
	it("reports gateway in successful stats and context metadata", async () => {
		mocks.org.mockResolvedValue(credential);
		const result = await rerankContexts({
			query: "q",
			contexts: documents,
			tenant,
		});
		expect(result.stats.provider).toBe("gateway");
		expect(result.contexts[0]).toMatchObject({
			metadata: { rerankedBy: "gateway" },
		});
	});
});

describe("Vercel local reranker availability", () => {
	it.each([undefined, "cross-encoder", "gateway", "cohere"] as const)(
		"skips unavailable local reranking after resolving %s on Vercel",
		async (provider) => {
			vi.stubEnv("VERCEL", "1");
			const result = await rerankContexts({
				query: "q",
				contexts: documents,
				provider,
				tenant,
			});
			expect(result.contexts).toBe(documents);
			expect(result.stats).toMatchObject({
				provider: "cross-encoder",
				model: "skipped",
				inputCount: 3,
				outputCount: 3,
			});
			expect(mocks.localConstructor).not.toHaveBeenCalled();
			expect(mocks.local).not.toHaveBeenCalled();
			expect(mocks.rerank).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
			expect(logger.info).toHaveBeenCalledExactlyOnceWith(
				expect.stringMatching(
					/skipped.*no gateway key.*organization.*local reranker.*unavailable on Vercel/i,
				),
			);
		},
	);
	it("uses the local reranker when VERCEL is absent", async () => {
		vi.unstubAllEnvs();
		vi.stubEnv("VERCEL", undefined);
		vi.stubEnv("RERANKER_PROVIDER", "cross-encoder");
		const result = await rerankContexts({
			query: "q",
			contexts: documents,
			tenant,
		});
		expect(mocks.localConstructor).toHaveBeenCalledOnce();
		expect(mocks.local).toHaveBeenCalledOnce();
		expect(result.stats.model).not.toBe("skipped");
		expect(result.contexts[0]).toMatchObject({
			content: "beta",
			score: 0.9,
		});
	});
	it("uses the organization's gateway key on Vercel", async () => {
		vi.stubEnv("VERCEL", "1");
		mocks.org.mockResolvedValue(credential);
		const result = await rerankContexts({
			query: "q",
			contexts: documents,
			tenant,
		});
		expect(result.stats.provider).toBe("gateway");
		expect(mocks.rerank).toHaveBeenCalledOnce();
		expect(mocks.localConstructor).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});
	it.each([undefined, "0", "true", "1"])(
		"reports local availability for VERCEL=%s",
		async (value) => {
			vi.stubEnv("VERCEL", value);
			expect(await getAvailableRerankers(tenant)).toMatchObject({
				"cross-encoder": value !== "1",
				gateway: false,
			});
			expect(mocks.localConstructor).not.toHaveBeenCalled();
		},
	);
});

describe("gateway limits and safe failures", () => {
	const provider = () =>
		new GatewayRerankerProvider({
			provider: "gateway",
			apiKey: "example-key",
			tenant,
			providerConfigId: "example-config",
			timeout: 1234,
		});
	it("checks the organization's usage scope after dispatch checks and before sending", async () => {
		await provider().rerank({ query: "q", documents });
		expect(mocks.limits).toHaveBeenCalledExactlyOnceWith({
			...tenant,
			providerConfigId: "example-config",
			providerModelId: "cohere/rerank-v5-pro",
		});
		expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.limits.mock.invocationCallOrder[0],
		);
		expect(mocks.limits.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.rerank.mock.invocationCallOrder[0],
		);
		expect(mocks.usage).toHaveBeenCalledWith(
			expect.objectContaining({
				modelCanonicalName: "example-rerank-canonical",
			}),
		);
	});
	it("propagates a limit refusal unchanged without sending or recording usage", async () => {
		const error = Object.assign(new Error("Example usage limit reached"), {
			name: "AiUsageLimitExceededError",
		});
		mocks.limits.mockRejectedValue(error);
		await expect(provider().rerank({ query: "q", documents })).rejects.toBe(
			error,
		);
		expect(mocks.rerank).not.toHaveBeenCalled();
		expect(mocks.usage).not.toHaveBeenCalled();
	});
	it("passes through a limit refusal and logs its class", async () => {
		mocks.org.mockResolvedValue(credential);
		mocks.limits.mockRejectedValue(
			Object.assign(new Error("Example usage limit reached"), {
				name: "AiUsageLimitExceededError",
			}),
		);
		const result = await rerankContexts({
			query: "q",
			contexts: documents,
			tenant,
		});
		expect(result.contexts).toBe(documents);
		expect(mocks.rerank).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("AiUsageLimitExceededError"),
		);
	});
	it("rechecks a dispatch stop latched during the asynchronous limit check", async () => {
		mocks.limits.mockImplementation(async () => {
			mocks.stop.mockImplementation(() => {
				throw new Error("dispatch stopped");
			});
		});
		await expect(
			provider().rerank({ query: "q", documents }),
		).rejects.toThrow("dispatch stopped");
		expect(mocks.rerank).not.toHaveBeenCalled();
	});
	it("preserves only name/status/type from an authentication error", async () => {
		mocks.rerank.mockRejectedValue(
			Object.assign(new Error("example-key example-private-body"), {
				name: "GatewayAuthenticationError",
				statusCode: 401,
				type: "authentication_error",
				cause: new Error("example-private-cause"),
				responseBody: "example-private-body",
				headers: { authorization: "example-private-header" },
			}),
		);
		const error = await provider()
			.rerank({ query: "q", documents })
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain('"name":"GatewayAuthenticationError"');
		expect(String(error)).toContain('"statusCode":401');
		expect(String(error)).toContain('"type":"authentication_error"');
		for (const secret of [
			"example-key",
			"example-private-body",
			"example-private-cause",
			"example-private-header",
		]) {
			expect(String(error)).not.toContain(secret);
		}
		expect((error as Error).cause).toBeUndefined();
	});
	it.each([
		{ name: "TimeoutError" },
		{ name: "GatewayTimeoutError" },
		{ name: "Error", type: "timeout_error", statusCode: 408 },
	])("reports a timeout distinctly for %j", async (fields) => {
		mocks.rerank.mockRejectedValue(
			Object.assign(new Error("example-private-timeout-body"), fields),
		);
		await expect(
			provider().rerank({ query: "q", documents }),
		).rejects.toThrow(/timed out.*1234ms/);
	});
	it("identifies an SDK abort caused by the configured timeout signal", async () => {
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		mocks.rerank.mockImplementation(async () => {
			timeout.abort(new DOMException("example timeout", "TimeoutError"));
			throw new DOMException("example abort body", "AbortError");
		});
		await expect(
			provider().rerank({ query: "q", documents }),
		).rejects.toThrow(/timed out.*1234ms/);
	});
});

it("keeps an unrelated abort distinguishable from a timeout", async () => {
	mocks.rerank.mockRejectedValue(
		new DOMException("example private abort", "AbortError"),
	);
	const provider = new GatewayRerankerProvider({
		provider: "gateway",
		apiKey: "example-key",
		tenant,
	});
	const error = await provider
		.rerank({ query: "q", documents })
		.catch((failure: unknown) => failure);
	expect(String(error)).toContain("Gateway rerank request failed");
	expect(String(error)).toContain("AbortError");
	expect(String(error)).not.toContain("timed out");
	expect(String(error)).not.toContain("example private abort");
});
it("omits non-scalar error fields rather than serializing their private values", async () => {
	mocks.rerank.mockRejectedValue({
		name: { secret: "example-private-name" },
		statusCode: { secret: "example-private-status" },
		type: { secret: "example-private-type" },
	});
	const provider = new GatewayRerankerProvider({
		provider: "gateway",
		apiKey: "example-key",
		tenant,
	});
	const error = await provider
		.rerank({ query: "q", documents })
		.catch((failure: unknown) => failure);
	expect(String(error)).not.toContain("example-private");
	expect(String(error)).toContain("Gateway rerank request failed {}");
});
