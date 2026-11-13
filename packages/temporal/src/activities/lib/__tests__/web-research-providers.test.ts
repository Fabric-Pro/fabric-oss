/**
 * `getWebResearchSearcher` and `getWebResearchScraper` tests: each builds the
 * tenant's configured provider, or says why there is none — no provider at
 * all, or one whose key the server could not use.
 *
 * The provider resolvers, the provider rows and `@repo/search` are mocked so
 * the test is pure-unit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockResolveSearchProvider,
	mockCreateProvider,
	mockEnabledProviders,
	mockGetWebScraper,
	mockPreferredScrapeProvider,
} = vi.hoisted(() => ({
	mockResolveSearchProvider: vi.fn(),
	mockCreateProvider: vi.fn(),
	mockEnabledProviders: vi.fn(),
	mockGetWebScraper: vi.fn(),
	mockPreferredScrapeProvider: vi.fn(),
}));

vi.mock("../get-search-provider", () => ({
	resolveSearchProviderForTenant: mockResolveSearchProvider,
}));

vi.mock("../get-web-scraper", () => ({
	getWebScraperForTenant: mockGetWebScraper,
	getPreferredScrapeProviderName: mockPreferredScrapeProvider,
}));

vi.mock("@repo/database", () => ({
	getEnabledOrganizationSearchProviders: mockEnabledProviders,
}));

vi.mock("@repo/search", () => ({
	createProvider: mockCreateProvider,
	isWebSearchCapableProvider: (name: string) => name !== "cloudflare",
}));

import {
	getWebResearchScraper,
	getWebResearchSearcher,
} from "../web-research-providers";

beforeEach(() => {
	mockResolveSearchProvider.mockReset();
	mockCreateProvider.mockReset();
	mockEnabledProviders.mockReset();
	mockEnabledProviders.mockResolvedValue([]);
	mockGetWebScraper.mockReset();
	mockPreferredScrapeProvider.mockReset();
});

describe("getWebResearchSearcher", () => {
	it("reports no provider, without building one, when none is configured", async () => {
		mockResolveSearchProvider.mockResolvedValue(null);

		const searcher = await getWebResearchSearcher("user-1", "org-1");

		expect(searcher).toEqual({ unavailable: "none" });
		expect(mockCreateProvider).not.toHaveBeenCalled();
		expect(mockEnabledProviders).toHaveBeenCalledWith("org-1");
	});

	it("reports an unusable provider when an enabled search row has a key the resolver could not use", async () => {
		mockResolveSearchProvider.mockResolvedValue(null);
		mockEnabledProviders.mockResolvedValue([
			{ providerName: "tavily", enabled: true, encryptedApiKey: "x" },
		]);

		const searcher = await getWebResearchSearcher("user-1", "org-1");

		expect(searcher).toEqual({
			unavailable: "unusable",
			providerName: "tavily",
			reason: "key_unreadable",
		});
		expect(mockCreateProvider).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a scrape-only provider",
			{ providerName: "cloudflare", enabled: true, encryptedApiKey: "x" },
		],
		[
			"a row without a key",
			{ providerName: "tavily", enabled: true, encryptedApiKey: null },
		],
		[
			"a disabled row",
			{ providerName: "tavily", enabled: false, encryptedApiKey: "x" },
		],
	])("reports no provider when the only row is %s", async (_label, row) => {
		mockResolveSearchProvider.mockResolvedValue(null);
		mockEnabledProviders.mockResolvedValue([row]);

		const searcher = await getWebResearchSearcher("user-1", "org-1");

		expect(searcher).toEqual({ unavailable: "none" });
	});

	it("lets a failure to read the provider rows propagate", async () => {
		mockResolveSearchProvider.mockResolvedValue(null);
		mockEnabledProviders.mockRejectedValue(new Error("connection reset"));

		await expect(getWebResearchSearcher("user-1", "org-1")).rejects.toThrow(
			"connection reset",
		);
	});

	it("reports no provider when the configured provider cannot be built", async () => {
		mockResolveSearchProvider.mockResolvedValue({
			providerName: "unknown-provider",
			apiKey: "example-key",
		});
		mockCreateProvider.mockReturnValue(null);

		const searcher = await getWebResearchSearcher("user-1", "org-1");

		expect(searcher).toEqual({ unavailable: "none" });
		expect(mockCreateProvider).toHaveBeenCalledWith(
			"unknown-provider",
			"example-key",
		);
	});

	it("passes the user and organization to the resolver unchanged", async () => {
		mockResolveSearchProvider.mockResolvedValue(null);

		await getWebResearchSearcher("user-1", "org-1");

		expect(mockResolveSearchProvider).toHaveBeenCalledTimes(1);
		expect(mockResolveSearchProvider).toHaveBeenCalledWith(
			"user-1",
			"org-1",
		);
	});

	it("searches the configured provider for general results", async () => {
		const results = [
			{
				title: "Example result",
				url: "https://example.com/article",
				snippet: "An example snippet.",
			},
		];
		const providerSearch = vi.fn().mockResolvedValue({
			results,
			providerUsed: "tavily",
			searchTime: 12,
		});
		mockResolveSearchProvider.mockResolvedValue({
			providerName: "tavily",
			apiKey: "example-key",
		});
		mockCreateProvider.mockReturnValue({ search: providerSearch });

		const resolved = await getWebResearchSearcher("user-1", "org-1");
		if (!("searcher" in resolved)) {
			throw new Error("expected a searcher");
		}
		const { searcher } = resolved;

		expect(searcher.providerName).toBe("tavily");
		expect(mockCreateProvider).toHaveBeenCalledWith(
			"tavily",
			"example-key",
		);
		await expect(searcher.search("q", 3)).resolves.toEqual(results);
		expect(providerSearch).toHaveBeenCalledWith("q", {
			maxResults: 3,
			category: "general",
		});
	});
});

describe("getWebResearchScraper", () => {
	const scraper = { providerName: "firecrawl", scrape: vi.fn() };

	it("returns the scraper the tenant picker builds, for reading single pages", async () => {
		mockPreferredScrapeProvider.mockResolvedValue("firecrawl");
		mockGetWebScraper.mockResolvedValue(scraper);

		await expect(
			getWebResearchScraper({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ scraper });
		expect(mockGetWebScraper).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: false,
		});
		expect(mockPreferredScrapeProvider).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: false,
		});
	});

	it("reports an unusable provider when the key cannot be decrypted", async () => {
		mockGetWebScraper.mockRejectedValue(
			new Error("Unsupported state or unable to authenticate data"),
		);
		mockPreferredScrapeProvider.mockResolvedValue("firecrawl");

		await expect(
			getWebResearchScraper({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({
			unavailable: "unusable",
			providerName: "firecrawl",
			reason: "key_unreadable",
		});
		expect(mockPreferredScrapeProvider).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: false,
		});
	});

	it("reports a provider whose settings cannot build a scraper, not an unreadable key", async () => {
		mockGetWebScraper.mockResolvedValue(null);
		mockPreferredScrapeProvider.mockResolvedValue("cloudflare");

		await expect(
			getWebResearchScraper({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({
			unavailable: "unusable",
			providerName: "cloudflare",
			reason: "provider_unusable",
		});
	});

	it("reports no provider when none would be picked", async () => {
		mockGetWebScraper.mockResolvedValue(null);
		mockPreferredScrapeProvider.mockResolvedValue(null);

		await expect(
			getWebResearchScraper({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ unavailable: "none" });
	});

	it("lets a failed first read of the provider rows propagate instead of reporting an unusable key", async () => {
		// One shared row read: the first one fails, any later one succeeds,
		// as a transient database error does.
		let rowReads = 0;
		const readRows = async () => {
			rowReads++;
			if (rowReads === 1) {
				throw new Error("connection reset");
			}
		};
		mockPreferredScrapeProvider.mockImplementation(async () => {
			await readRows();
			return "firecrawl";
		});
		mockGetWebScraper.mockImplementation(async () => {
			await readRows();
			return scraper;
		});

		await expect(
			getWebResearchScraper({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toThrow("connection reset");
		expect(mockGetWebScraper).not.toHaveBeenCalled();
	});

	it("never builds a scraper, or decrypts a key, when no provider would be picked", async () => {
		mockPreferredScrapeProvider.mockResolvedValue(null);

		await expect(
			getWebResearchScraper({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ unavailable: "none" });
		expect(mockGetWebScraper).not.toHaveBeenCalled();
	});

	it("lets a failure to read the provider rows propagate", async () => {
		mockGetWebScraper.mockRejectedValue(new Error("connection reset"));
		mockPreferredScrapeProvider.mockRejectedValue(
			new Error("connection reset"),
		);

		await expect(
			getWebResearchScraper({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toThrow("connection reset");
	});
});
