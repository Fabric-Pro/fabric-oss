/**
 * The Fabric AI scrape tools use the tenant's configured scraper.
 *
 * `scrapeUrlActivity` and the direct mode of `scrapeAndAnalyzeActivity`
 * resolve their scraper through `getWebScraperForTenant` (default provider
 * first, then priority) instead of looking only for a Jina key. The real
 * picker and the real adapters run here; `@repo/database` returns provider
 * rows and `fetch` is stubbed, so the assertions are on the outbound request.
 * Only a tenant with no scrape-capable provider reaches the Fabric AI server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getEffectiveDelegationSetting: vi.fn(),
	getEnabledOrganizationSearchProviders: vi.fn(),
	getEnabledUserSearchProviders: vi.fn(),
	createFabricClient: vi.fn(),
	executePatternHybrid: vi.fn(),
	serverScrapeUrl: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	getEffectiveDelegationSetting: h.getEffectiveDelegationSetting,
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
vi.mock("@repo/ai-token", () => ({ issueAIToken: vi.fn() }));
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
vi.mock("@repo/fabric-ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/fabric-ai")>()),
	createFabricClient: h.createFabricClient,
	executePatternHybrid: h.executePatternHybrid,
}));

import { scrapeAndAnalyzeActivity, scrapeUrlActivity } from "../index";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CLOUDFLARE_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const URL_TO_SCRAPE = "https://example.com/page";

function providerRow(overrides: Record<string, unknown>) {
	return {
		providerName: "jina",
		encryptedApiKey: "key",
		endpoint: null,
		enabled: true,
		isDefault: false,
		priority: 0,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

/** The org's default scraper is Cloudflare; Jina is configured but not default. */
const ORG_PROVIDERS = [
	providerRow({
		providerName: "cloudflare",
		encryptedApiKey: "cf-key",
		endpoint: CLOUDFLARE_ENDPOINT,
		isDefault: true,
	}),
	providerRow({ providerName: "jina", encryptedApiKey: "jina-key" }),
];

function cloudflareOk(markdown: string): Response {
	return new Response(JSON.stringify({ success: true, result: markdown }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	for (const mock of Object.values(h)) {
		mock.mockReset();
	}
	h.getEffectiveDelegationSetting.mockResolvedValue(false);
	h.getEnabledOrganizationSearchProviders.mockResolvedValue(ORG_PROVIDERS);
	h.getEnabledUserSearchProviders.mockResolvedValue([]);
	h.serverScrapeUrl.mockResolvedValue("server markdown");
	h.createFabricClient.mockReturnValue({ scrapeUrl: h.serverScrapeUrl });
	fetchMock = vi.fn(async () => cloudflareOk("# Example\n\ncloudflare body"));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("scrapeUrlActivity", () => {
	it("scrapes with the organization's default provider, not Jina", async () => {
		const result = await scrapeUrlActivity({
			url: URL_TO_SCRAPE,
			userId: "user-example-1",
			organizationId: "org-example-1",
		});

		expect(result).toMatchObject({
			success: true,
			content: "# Example\n\ncloudflare body",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [requestUrl, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(requestUrl).toBe(
			`${CLOUDFLARE_ENDPOINT}/browser-rendering/markdown`,
		);
		expect(requestUrl).not.toContain("r.jina.ai");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer decrypted-cf-key",
		);
		expect(h.createFabricClient).not.toHaveBeenCalled();
	});

	it("looks providers up under the organization, never the user", async () => {
		await scrapeUrlActivity({
			url: URL_TO_SCRAPE,
			userId: "user-example-1",
			organizationId: "org-example-1",
		});

		expect(h.getEnabledOrganizationSearchProviders).toHaveBeenCalledWith(
			"org-example-1",
		);
		expect(h.getEnabledUserSearchProviders).not.toHaveBeenCalled();
	});

	it("returns the scraper's error with no fallback when the scrape fails", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));

		const result = await scrapeUrlActivity({
			url: URL_TO_SCRAPE,
			userId: "user-example-1",
			organizationId: "org-example-1",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("Cloudflare Browser Rendering rejected");
		expect(result.content).toBeUndefined();
		expect(h.createFabricClient).not.toHaveBeenCalled();
	});

	it("falls back to the Fabric AI server when no scrape provider is configured", async () => {
		h.getEnabledOrganizationSearchProviders.mockResolvedValue([]);

		const result = await scrapeUrlActivity({
			url: URL_TO_SCRAPE,
			userId: "user-example-1",
			organizationId: "org-example-1",
		});

		expect(result).toMatchObject({
			success: true,
			content: "server markdown",
		});
		expect(h.serverScrapeUrl).toHaveBeenCalledWith(URL_TO_SCRAPE);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses the user's providers when there is no organization", async () => {
		h.getEnabledUserSearchProviders.mockResolvedValue([
			providerRow({
				providerName: "jina",
				encryptedApiKey: "jina-key",
				isDefault: true,
			}),
		]);
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					data: { content: "jina body", url: URL_TO_SCRAPE },
				}),
				{ status: 200 },
			),
		);

		const result = await scrapeUrlActivity({
			url: URL_TO_SCRAPE,
			userId: "user-example-1",
		});

		expect(result).toMatchObject({ success: true, content: "jina body" });
		expect(h.getEnabledUserSearchProviders).toHaveBeenCalledWith(
			"user-example-1",
		);
		expect(h.getEnabledOrganizationSearchProviders).not.toHaveBeenCalled();
	});

	it("goes straight to the Fabric AI server without a user ID", async () => {
		const result = await scrapeUrlActivity({ url: URL_TO_SCRAPE });

		expect(result).toMatchObject({
			success: true,
			content: "server markdown",
		});
		expect(h.getEnabledOrganizationSearchProviders).not.toHaveBeenCalled();
		expect(h.getEnabledUserSearchProviders).not.toHaveBeenCalled();
	});
});

describe("scrapeAndAnalyzeActivity (direct mode)", () => {
	const input = {
		url: URL_TO_SCRAPE,
		pattern: "summarize" as const,
		userId: "user-example-1",
		organizationId: "org-example-1",
	};

	beforeEach(() => {
		h.executePatternHybrid.mockResolvedValue({
			success: true,
			output: "the analysis",
			metadata: {
				pattern: "summarize",
				model: "example-model",
				executionMode: "hybrid",
			},
		});
	});

	it("analyses the content the tenant's scraper returned", async () => {
		const result = await scrapeAndAnalyzeActivity(input);

		expect(result).toMatchObject({
			success: true,
			analysis: "the analysis",
		});
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"/browser-rendering/markdown",
		);
		expect(h.getEnabledOrganizationSearchProviders).toHaveBeenCalledWith(
			"org-example-1",
		);
		expect(h.executePatternHybrid).toHaveBeenCalledWith(
			expect.objectContaining({ input: "# Example\n\ncloudflare body" }),
		);
		expect(h.createFabricClient).not.toHaveBeenCalled();
	});

	it("falls back to the Fabric AI server when the scraper fails", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 429 }));

		const result = await scrapeAndAnalyzeActivity(input);

		expect(result).toMatchObject({
			success: true,
			analysis: "the analysis",
		});
		expect(h.serverScrapeUrl).toHaveBeenCalledWith(URL_TO_SCRAPE);
		expect(h.executePatternHybrid).toHaveBeenCalledWith(
			expect.objectContaining({ input: "server markdown" }),
		);
	});
});
