import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveCredential } = vi.hoisted(() => ({
	resolveCredential: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	resolveUrlSourceScraperCredential: resolveCredential,
}));

import { firecrawlCrawlActivity } from "../../src/activities/url-source/firecrawl-crawl-activity";
import { firecrawlMapActivity } from "../../src/activities/url-source/firecrawl-map-activity";
import { firecrawlScrapeActivity } from "../../src/activities/url-source/firecrawl-scrape-activity";

const key = "fc-test-not-a-real-key";
const reference = {
	url: "https://example.com/docs",
	contextId: "example-context",
	organizationId: "example-org",
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetAllMocks();
});

describe.each([
	["scrape", firecrawlScrapeActivity],
	["map", firecrawlMapActivity],
	["crawl", firecrawlCrawlActivity],
] as const)("%s activity scraper credential", (_name, activity) => {
	it.each([
		["source-not-authorized", "URL_SCRAPER_SOURCE_NOT_AUTHORIZED"],
		["provider-unavailable", "URL_SCRAPER_PROVIDER_UNAVAILABLE"],
		["credential-unreadable", "URL_SCRAPER_CREDENTIAL_UNREADABLE"],
	])(
		"rejects %s before HTTP, even with a legacy key",
		async (status, type) => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			resolveCredential.mockResolvedValue({ status });
			await expect(
				activity({ ...reference, apiKey: key }),
			).rejects.toMatchObject({
				type,
				nonRetryable: true,
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("rejects a request with neither reference nor legacy key", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(activity({ url: reference.url })).rejects.toMatchObject({
			type: "URL_SCRAPER_CREDENTIAL_REQUIRED",
			nonRetryable: true,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uses the current key and redacts a provider transport error", async () => {
		const fetch = vi.fn(async () => {
			throw new Error(`echo ${key} and ${key}`);
		});
		vi.stubGlobal("fetch", fetch);
		resolveCredential.mockResolvedValue({
			status: "resolved",
			apiKey: key,
			endpoint: null,
		});
		await expect(
			activity({ ...reference, apiKey: "example-stale-key" }),
		).rejects.toMatchObject({
			message: expect.stringContaining("echo [redacted] and [redacted]"),
		});
		expect(fetch).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: `Bearer ${key}`,
				}),
			}),
		);
	});
});

it("uses the authorized Cloudflare endpoint and removes echoed keys from the returned page", async () => {
	const account = "0123456789abcdef0123456789abcdef";
	const fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					success: true,
					result: `# ${key}\n\nBody ${key}`,
				}),
			),
	);
	vi.stubGlobal("fetch", fetch);
	resolveCredential.mockResolvedValue({
		status: "resolved",
		apiKey: key,
		endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}`,
	});

	const result = await firecrawlScrapeActivity({
		...reference,
		providerName: "cloudflare",
		providerEndpoint:
			"https://api.cloudflare.com/client/v4/accounts/ffffffffffffffffffffffffffffffff",
		apiKey: "example-stale-key",
	});

	expect(resolveCredential).toHaveBeenCalledWith({
		contextId: reference.contextId,
		organizationId: reference.organizationId,
		providerName: "cloudflare",
		company: false,
	});
	expect(fetch).toHaveBeenCalledWith(
		expect.stringContaining(`/accounts/${account}/`),
		expect.objectContaining({
			headers: expect.objectContaining({
				Authorization: `Bearer ${key}`,
			}),
		}),
	);
	expect(result).toMatchObject({
		pageTitle: "[redacted]",
		markdown: "# [redacted]\n\nBody [redacted]",
	});
});

it("rejects a company owner from another organization before HTTP", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	resolveCredential.mockImplementation(async ({ organizationId }) =>
		organizationId
			? { status: "resolved", apiKey: key, endpoint: null }
			: { status: "source-not-authorized" },
	);
	await expect(
		firecrawlScrapeActivity({
			...reference,
			owner: { kind: "company", organizationId: "example-other-org" },
		}),
	).rejects.toMatchObject({
		type: "URL_SCRAPER_SOURCE_NOT_AUTHORIZED",
		nonRetryable: true,
	});
	expect(fetch).not.toHaveBeenCalled();
});
