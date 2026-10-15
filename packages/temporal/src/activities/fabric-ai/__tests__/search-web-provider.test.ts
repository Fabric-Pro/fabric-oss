/**
 * The Fabric AI search tools use the tenant's configured search provider.
 *
 * `searchWebActivity` and `searchAndAnalyzeActivity` resolve their provider
 * through `resolveSearchProviderForTenant` (default provider first, then any
 * other enabled one) instead of looking only for a Jina key, and never
 * consult the delegation setting: search and scrape no longer route through
 * the Fabric AI server's delegated endpoints. Only a tenant with no
 * search-capable provider reaches the Fabric AI server. `@repo/database`
 * returns provider rows and `createProvider` is stubbed, so the assertions
 * are on which provider was built and what it was asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getEffectiveDelegationSetting: vi.fn(),
	getMergedSearchProviderConfigs: vi.fn(),
	getSearchProviderConfig: vi.fn(),
	getEnabledOrganizationSearchProviders: vi.fn(),
	getEnabledUserSearchProviders: vi.fn(),
	issueAIToken: vi.fn(),
	createProvider: vi.fn(),
	jinaSearch: vi.fn(),
	createJinaClient: vi.fn(),
	providerSearch: vi.fn(),
	createFabricClient: vi.fn(),
	executePatternHybrid: vi.fn(),
	serverSearchWeb: vi.fn(),
	serverScrapeUrl: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	getEffectiveDelegationSetting: h.getEffectiveDelegationSetting,
	getMergedSearchProviderConfigs: h.getMergedSearchProviderConfigs,
	getSearchProviderConfig: h.getSearchProviderConfig,
	getEnabledOrganizationSearchProviders:
		h.getEnabledOrganizationSearchProviders,
	getEnabledUserSearchProviders: h.getEnabledUserSearchProviders,
	logAiUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(),
	getSystemRAGProviderConfig: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai-token", () => ({ issueAIToken: h.issueAIToken }));
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_provider: string,
		_operation: string,
		fn: () => Promise<unknown>,
	) => fn(),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => `decrypted-${value}`,
}));
vi.mock("@repo/search", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/search")>()),
	createProvider: h.createProvider,
}));
vi.mock("@repo/fabric-ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/fabric-ai")>()),
	createJinaClient: h.createJinaClient,
	createFabricClient: h.createFabricClient,
	executePatternHybrid: h.executePatternHybrid,
}));

import {
	scrapeAndAnalyzeActivity,
	searchAndAnalyzeActivity,
	searchWebActivity,
} from "../index";

const USER = { userId: "user-example-1", organizationId: "org-example-1" };

function providerRow(overrides: Record<string, unknown>) {
	return {
		providerName: "jina",
		encryptedApiKey: "key",
		endpoint: null,
		enabled: true,
		isDefault: false,
		priority: 0,
		source: "organization",
		...overrides,
	};
}

/** The org's default search provider is Exa; Jina is configured but not default. */
const ORG_PROVIDERS = [
	providerRow({
		providerName: "exa",
		encryptedApiKey: "exa-key",
		isDefault: true,
	}),
	providerRow({ providerName: "jina", encryptedApiKey: "jina-key" }),
];

const EXA_RESPONSE = {
	providerUsed: "exa",
	searchTime: 5,
	results: [
		{
			title: "First hit",
			url: "https://example.com/one",
			snippet: "short snippet",
			content: "full page content",
			source: "exa",
		},
		{
			title: "Second hit",
			url: "https://example.com/two",
			snippet: "only a snippet",
			source: "exa",
		},
	],
};

const JINA_CONTENT = "# Full Jina markdown\n\n" + "long body ".repeat(200);

const JINA_ONLY = [
	providerRow({
		providerName: "jina",
		encryptedApiKey: "jina-key",
		isDefault: true,
	}),
];

const EXA_MARKDOWN = [
	"## First hit\n\nhttps://example.com/one\n\nfull page content",
	"## Second hit\n\nhttps://example.com/two\n\nonly a snippet",
].join("\n\n---\n\n");

beforeEach(() => {
	for (const mock of Object.values(h)) {
		mock.mockReset();
	}
	// Delegation is on: the old code took the delegated branch first.
	h.getEffectiveDelegationSetting.mockResolvedValue(true);
	// Rows exist for org-example-1 only: a lookup that drops the
	// organization finds no provider and the tool goes to the server.
	h.getMergedSearchProviderConfigs.mockImplementation(
		async (args: { organizationId?: string | null }) =>
			args.organizationId === USER.organizationId ? ORG_PROVIDERS : [],
	);
	h.createJinaClient.mockReturnValue({ search: h.jinaSearch });
	h.jinaSearch.mockResolvedValue({ success: true, content: JINA_CONTENT });
	h.getSearchProviderConfig.mockResolvedValue(null);
	h.getEnabledOrganizationSearchProviders.mockResolvedValue([]);
	h.getEnabledUserSearchProviders.mockResolvedValue([]);
	h.createProvider.mockReturnValue({ search: h.providerSearch });
	h.providerSearch.mockResolvedValue(EXA_RESPONSE);
	h.serverSearchWeb.mockResolvedValue("server results");
	h.serverScrapeUrl.mockResolvedValue("server markdown");
	h.createFabricClient.mockReturnValue({
		searchWeb: h.serverSearchWeb,
		scrapeUrl: h.serverScrapeUrl,
		// The removed delegated endpoints: calling either would be a regression.
		searchWebDelegated: vi.fn(),
		scrapeUrlDelegated: vi.fn(),
	});
	h.executePatternHybrid.mockResolvedValue({
		success: true,
		output: "analysis",
		metadata: { pattern: "summarize", model: "m", executionMode: "direct" },
	});
});

describe("searchWebActivity", () => {
	it("searches with the organization's default provider, not Jina", async () => {
		const result = await searchWebActivity({ question: "q", ...USER });

		expect(result).toMatchObject({ success: true, results: EXA_MARKDOWN });
		expect(h.createProvider).toHaveBeenCalledTimes(1);
		expect(h.createProvider).toHaveBeenCalledWith(
			"exa",
			"decrypted-exa-key",
		);
		expect(h.providerSearch).toHaveBeenCalledWith("q", {
			maxResults: 10,
			category: "general",
		});
		expect(h.createFabricClient).not.toHaveBeenCalled();
		expect(h.getMergedSearchProviderConfigs).toHaveBeenCalledWith({
			userId: USER.userId,
			organizationId: USER.organizationId,
		});
	});

	it("falls back to the Fabric AI server when no provider is configured", async () => {
		h.getMergedSearchProviderConfigs.mockImplementation(async () => []);

		const result = await searchWebActivity({ question: "q", ...USER });

		expect(result).toMatchObject({
			success: true,
			results: "server results",
		});
		expect(h.serverSearchWeb).toHaveBeenCalledWith("q");
		expect(h.providerSearch).not.toHaveBeenCalled();
	});

	it("falls back to the Fabric AI server when there is no user", async () => {
		const result = await searchWebActivity({ question: "q" });

		expect(result).toMatchObject({
			success: true,
			results: "server results",
		});
		expect(h.getMergedSearchProviderConfigs).not.toHaveBeenCalled();
	});

	it("returns the provider's error with no fallback", async () => {
		h.providerSearch.mockRejectedValue(new Error("exa rejected the key"));

		const result = await searchWebActivity({ question: "q", ...USER });

		expect(result).toMatchObject({
			success: false,
			error: "exa rejected the key",
		});
		expect(h.createFabricClient).not.toHaveBeenCalled();
	});

	it("does not consult the delegation setting or issue an AI token", async () => {
		await searchWebActivity({ question: "q", ...USER });

		expect(h.getEffectiveDelegationSetting).not.toHaveBeenCalled();
		expect(h.issueAIToken).not.toHaveBeenCalled();
	});
});

describe("searchAndAnalyzeActivity", () => {
	it("analyzes the configured provider's results, not Jina's", async () => {
		const result = await searchAndAnalyzeActivity({
			question: "q",
			pattern: "summarize",
			...USER,
		});

		expect(result).toMatchObject({ success: true, analysis: "analysis" });
		expect(h.createProvider).toHaveBeenCalledWith(
			"exa",
			"decrypted-exa-key",
		);
		expect(h.getMergedSearchProviderConfigs).toHaveBeenCalledWith({
			userId: USER.userId,
			organizationId: USER.organizationId,
		});
		expect(h.executePatternHybrid).toHaveBeenCalledWith(
			expect.objectContaining({ input: EXA_MARKDOWN }),
		);
		expect(h.createFabricClient).not.toHaveBeenCalled();
	});

	it("falls back to the Fabric AI server when no provider is configured", async () => {
		h.getMergedSearchProviderConfigs.mockImplementation(async () => []);

		await searchAndAnalyzeActivity({
			question: "q",
			pattern: "summarize",
			...USER,
		});

		expect(h.serverSearchWeb).toHaveBeenCalledWith("q");
		expect(h.executePatternHybrid).toHaveBeenCalledWith(
			expect.objectContaining({ input: "server results" }),
		);
	});

	it("falls back to the Fabric AI server when the provider fails", async () => {
		h.providerSearch.mockRejectedValue(new Error("exa down"));

		const result = await searchAndAnalyzeActivity({
			question: "q",
			pattern: "summarize",
			...USER,
		});

		expect(result.success).toBe(true);
		expect(h.serverSearchWeb).toHaveBeenCalledWith("q");
		expect(h.executePatternHybrid).toHaveBeenCalledWith(
			expect.objectContaining({ input: "server results" }),
		);
	});

	it("falls back to the Fabric AI server when the provider returns nothing", async () => {
		h.providerSearch.mockResolvedValue({ ...EXA_RESPONSE, results: [] });

		await searchAndAnalyzeActivity({
			question: "q",
			pattern: "summarize",
			...USER,
		});

		expect(h.serverSearchWeb).toHaveBeenCalledWith("q");
	});

	it("does not consult the delegation setting or issue an AI token", async () => {
		await searchAndAnalyzeActivity({
			question: "q",
			pattern: "summarize",
			...USER,
		});

		expect(h.getEffectiveDelegationSetting).not.toHaveBeenCalled();
		expect(h.issueAIToken).not.toHaveBeenCalled();
	});
});

describe("a tenant whose provider is Jina", () => {
	beforeEach(() => {
		h.getMergedSearchProviderConfigs.mockImplementation(
			async () => JINA_ONLY,
		);
	});

	it("searchWeb returns Jina's full content through JinaClient", async () => {
		const result = await searchWebActivity({ question: "q", ...USER });

		expect(result).toMatchObject({ success: true, results: JINA_CONTENT });
		expect(h.createJinaClient).toHaveBeenCalledWith({
			apiKey: "decrypted-jina-key",
		});
		expect(h.jinaSearch).toHaveBeenCalledWith("q");
		expect(h.createProvider).not.toHaveBeenCalled();
		expect(h.createFabricClient).not.toHaveBeenCalled();
	});

	it("searchWeb returns a Jina failure with no fallback", async () => {
		h.jinaSearch.mockResolvedValue({
			success: false,
			content: "",
			error: "Jina search failed (401)",
		});

		const result = await searchWebActivity({ question: "q", ...USER });

		expect(result).toMatchObject({
			success: false,
			error: "Jina search failed (401)",
		});
		expect(h.createFabricClient).not.toHaveBeenCalled();
	});

	it("searchAndAnalyze analyzes Jina's full content", async () => {
		await searchAndAnalyzeActivity({
			question: "q",
			pattern: "summarize",
			...USER,
		});

		expect(h.executePatternHybrid).toHaveBeenCalledWith(
			expect.objectContaining({ input: JINA_CONTENT }),
		);
		expect(h.createProvider).not.toHaveBeenCalled();
		expect(h.createFabricClient).not.toHaveBeenCalled();
	});

	it("searchAndAnalyze falls back to the server when Jina fails", async () => {
		h.jinaSearch.mockResolvedValue({
			success: false,
			content: "",
			error: "boom",
		});

		await searchAndAnalyzeActivity({
			question: "q",
			pattern: "summarize",
			...USER,
		});

		expect(h.serverSearchWeb).toHaveBeenCalledWith("q");
	});
});

describe("scrapeAndAnalyzeActivity", () => {
	it("does not consult the delegation setting or issue an AI token", async () => {
		// No scrape provider: the activity goes straight to the server.
		await scrapeAndAnalyzeActivity({
			url: "https://example.com/page",
			pattern: "summarize",
			...USER,
		});

		expect(h.getEffectiveDelegationSetting).not.toHaveBeenCalled();
		expect(h.issueAIToken).not.toHaveBeenCalled();
		expect(h.serverScrapeUrl).toHaveBeenCalledWith(
			"https://example.com/page",
		);
	});
});
