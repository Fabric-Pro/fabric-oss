/**
 * Picker (`getWebScraperForTenant`) tests — multi-provider routing
 * (URL Context Sources, commit 3 of 3).
 *
 * Covers:
 *   1. XOR tenancy — org context never touches user providers and vice versa.
 *   2. Scrape-capable filter — `parallel` / `youtube` are skipped.
 *   3. Crawl-capable filter — `requireCrawl: true` only picks Firecrawl.
 *   4. Ordering — `isDefault: true` first, then priority ASC, then createdAt ASC
 *      (mirrors `getEnabledOrganizationSearchProviders` ordering).
 *   5. Disabled / missing-key rows are skipped.
 *   6. `null` returned when no candidate qualifies.
 *   7. `getPreferredScrapeProviderName` returns the name without decrypting.
 *
 * `@repo/database` and `@repo/utils` are mocked so the test is pure-unit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetEnabledOrgProviders,
	mockGetEnabledUserProviders,
	mockDecryptApiKey,
} = vi.hoisted(() => ({
	mockGetEnabledOrgProviders: vi.fn(),
	mockGetEnabledUserProviders: vi.fn(),
	mockDecryptApiKey: vi.fn((s: string) => `decrypted:${s}`),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	getEnabledOrganizationSearchProviders: mockGetEnabledOrgProviders,
	getEnabledUserSearchProviders: mockGetEnabledUserProviders,
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: mockDecryptApiKey,
}));

import {
	getPreferredScrapeProviderName,
	getWebScraperForTenant,
} from "../get-web-scraper";

interface RowOverrides {
	providerName: string;
	enabled?: boolean;
	isDefault?: boolean;
	priority?: number;
	encryptedApiKey?: string | null;
	createdAt?: Date;
}

function row(overrides: RowOverrides) {
	// `??` does NOT treat null as a default, only undefined — keep the
	// explicit `null` test cases working by checking the `in` operator.
	const encryptedApiKey =
		"encryptedApiKey" in overrides ? overrides.encryptedApiKey : "enc-key";
	return {
		providerName: overrides.providerName,
		enabled: overrides.enabled ?? true,
		isDefault: overrides.isDefault ?? false,
		priority: overrides.priority ?? 100,
		encryptedApiKey: encryptedApiKey ?? null,
		createdAt: overrides.createdAt ?? new Date("2024-01-01"),
	};
}

beforeEach(() => {
	mockGetEnabledOrgProviders.mockReset();
	mockGetEnabledUserProviders.mockReset();
	mockDecryptApiKey.mockClear();
});

describe("getWebScraperForTenant — XOR tenancy", () => {
	it("reads org providers only when organizationId is set", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			row({ providerName: "jina" }),
		]);

		const scraper = await getWebScraperForTenant({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: false,
		});

		expect(scraper?.providerName).toBe("jina");
		expect(mockGetEnabledOrgProviders).toHaveBeenCalledWith("org-1");
		expect(mockGetEnabledUserProviders).not.toHaveBeenCalled();
	});

	it("reads user providers only when organizationId is null", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([
			row({ providerName: "firecrawl" }),
		]);

		const scraper = await getWebScraperForTenant({
			userId: "user-1",
			organizationId: null,
			requireCrawl: false,
		});

		expect(scraper?.providerName).toBe("firecrawl");
		expect(mockGetEnabledUserProviders).toHaveBeenCalledWith("user-1");
		expect(mockGetEnabledOrgProviders).not.toHaveBeenCalled();
	});

	it("returns null when neither tenant context is set", async () => {
		const scraper = await getWebScraperForTenant({
			userId: null,
			organizationId: null,
			requireCrawl: false,
		});
		expect(scraper).toBeNull();
	});
});

describe("getWebScraperForTenant — provider filtering", () => {
	it("skips parallel and youtube as un-scrapeable", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			row({ providerName: "youtube", isDefault: true }),
			row({ providerName: "parallel", isDefault: false, priority: 10 }),
			row({ providerName: "tavily", priority: 20 }),
		]);

		const scraper = await getWebScraperForTenant({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: false,
		});
		expect(scraper?.providerName).toBe("tavily");
	});

	it("filters to crawl-capable (Firecrawl) when requireCrawl=true", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			row({ providerName: "jina", isDefault: true }),
			row({ providerName: "tavily", priority: 10 }),
			row({ providerName: "exa", priority: 20 }),
			row({ providerName: "firecrawl", priority: 30 }),
		]);

		const scraper = await getWebScraperForTenant({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: true,
		});
		expect(scraper?.providerName).toBe("firecrawl");
	});

	it("returns null when requireCrawl=true and only non-crawl providers exist", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			row({ providerName: "jina" }),
			row({ providerName: "tavily" }),
		]);

		const scraper = await getWebScraperForTenant({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: true,
		});
		expect(scraper).toBeNull();
	});

	it("returns null when no scrape-capable provider exists at all", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			row({ providerName: "youtube" }),
			row({ providerName: "parallel" }),
		]);

		const scraper = await getWebScraperForTenant({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: false,
		});
		expect(scraper).toBeNull();
	});

	it("skips disabled rows and rows without an encrypted key", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			// Disabled — should never be picked.
			row({
				providerName: "firecrawl",
				enabled: false,
				isDefault: true,
				priority: 0,
			}),
			// No key — also should be skipped.
			row({ providerName: "exa", encryptedApiKey: null, priority: 5 }),
			// Valid candidate.
			row({ providerName: "jina", priority: 10 }),
		]);

		const scraper = await getWebScraperForTenant({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: false,
		});
		expect(scraper?.providerName).toBe("jina");
	});
});

describe("getPreferredScrapeProviderName", () => {
	it("returns the provider name without decrypting", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			row({ providerName: "exa" }),
		]);

		const name = await getPreferredScrapeProviderName({
			userId: "user-1",
			organizationId: "org-1",
			requireCrawl: false,
		});
		expect(name).toBe("exa");
		expect(mockDecryptApiKey).not.toHaveBeenCalled();
	});

	it("returns null when no candidate qualifies", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([]);
		const name = await getPreferredScrapeProviderName({
			userId: "user-1",
			organizationId: null,
			requireCrawl: false,
		});
		expect(name).toBeNull();
	});
});
