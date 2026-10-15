/**
 * Unit tests for `resolveUrlSourceProvider` — the one place that chooses the
 * scraper for a URL source, shared by `processLink`, its four follow-up
 * procedures and the company-context crawls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetEnabledOrgProviders,
	mockGetEnabledUserProviders,
	mockOrgFindUnique,
	mockDecryptApiKey,
} = vi.hoisted(() => ({
	mockGetEnabledOrgProviders: vi.fn(),
	mockGetEnabledUserProviders: vi.fn(),
	mockOrgFindUnique: vi.fn(),
	mockDecryptApiKey: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { organization: { findUnique: mockOrgFindUnique } },
	getEnabledOrganizationSearchProviders: mockGetEnabledOrgProviders,
	getEnabledUserSearchProviders: mockGetEnabledUserProviders,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/utils", () => ({ decryptApiKey: mockDecryptApiKey }));

import {
	providerWorkflowArgs,
	resolveUrlSourceProvider,
} from "../url-source-provider";

function providerRow(
	providerName: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		providerName,
		encryptedApiKey: `enc-${providerName}`,
		endpoint: null,
		enabled: true,
		isDefault: false,
		priority: 1,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDecryptApiKey.mockImplementation((v: string) => `dec:${v}`);
	mockGetEnabledOrgProviders.mockResolvedValue([]);
	mockGetEnabledUserProviders.mockResolvedValue([]);
});

describe("resolveUrlSourceProvider", () => {
	it("returns the first scrape-capable provider with its decrypted key", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("parallel"),
			providerRow("jina"),
			providerRow("firecrawl"),
		]);

		await expect(
			resolveUrlSourceProvider({
				organizationId: "org-1",
				userId: "user-1",
				scope: "SINGLE_PAGE",
			}),
		).resolves.toEqual({ providerName: "jina", apiKey: "dec:enc-jina" });
	});

	it("skips a row with no stored key", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("jina", { encryptedApiKey: null }),
			providerRow("exa"),
		]);

		const provider = await resolveUrlSourceProvider({
			organizationId: "org-1",
			userId: "user-1",
			scope: "SINGLE_PAGE",
		});

		expect(provider.providerName).toBe("exa");
	});

	it("returns the stored endpoint only when the row has one", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("cloudflare", { endpoint: "account-123" }),
		]);

		const provider = await resolveUrlSourceProvider({
			organizationId: "org-1",
			userId: "user-1",
			scope: "SINGLE_PAGE",
		});

		expect(provider.providerEndpoint).toBe("account-123");
		expect(providerWorkflowArgs(provider)).toEqual({
			apiKey: "dec:enc-cloudflare",
			providerName: "cloudflare",
			providerEndpoint: "account-123",
		});
		expect(
			providerWorkflowArgs({ providerName: "jina", apiKey: "k" }),
		).toEqual({ apiKey: "k", providerName: "jina" });
	});

	it("needs a crawl-capable provider for a path prefix, whatever ranks first", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("jina", { isDefault: true }),
			providerRow("firecrawl"),
		]);

		const provider = await resolveUrlSourceProvider({
			organizationId: "org-1",
			userId: "user-1",
			scope: "PATH_PREFIX",
		});

		expect(provider.providerName).toBe("firecrawl");
	});

	it("picks Cloudflare for a path prefix when it is the only crawl-capable provider", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("jina", { isDefault: true }),
			providerRow("cloudflare"),
		]);

		const provider = await resolveUrlSourceProvider({
			organizationId: "org-1",
			userId: "user-1",
			scope: "PATH_PREFIX",
		});

		expect(provider.providerName).toBe("cloudflare");
	});

	it("reads only the organization's providers when an organization is given", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([providerRow("exa")]);
		mockGetEnabledUserProviders.mockResolvedValue([
			providerRow("firecrawl"),
		]);

		await resolveUrlSourceProvider({
			organizationId: "org-1",
			userId: "user-1",
			scope: "SINGLE_PAGE",
		});

		expect(mockGetEnabledOrgProviders).toHaveBeenCalledWith("org-1");
		expect(mockGetEnabledUserProviders).not.toHaveBeenCalled();
	});

	it("reads only the user's providers when there is no organization", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("firecrawl"),
		]);
		mockGetEnabledUserProviders.mockResolvedValue([providerRow("exa")]);

		for (const organizationId of [undefined, null]) {
			const provider = await resolveUrlSourceProvider({
				organizationId,
				userId: "user-1",
				scope: "SINGLE_PAGE",
			});
			expect(provider.providerName).toBe("exa");
		}

		expect(mockGetEnabledUserProviders).toHaveBeenCalledWith("user-1");
		expect(mockGetEnabledOrgProviders).not.toHaveBeenCalled();
	});

	it("fails closed when it has neither an organization nor a user", async () => {
		await expect(
			resolveUrlSourceProvider({
				organizationId: undefined,
				userId: null,
				scope: "SINGLE_PAGE",
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(mockGetEnabledOrgProviders).not.toHaveBeenCalled();
		expect(mockGetEnabledUserProviders).not.toHaveBeenCalled();
	});

	it("throws SCRAPE_PROVIDER_NOT_CONFIGURED, naming the sources and the settings page", async () => {
		mockOrgFindUnique.mockResolvedValue({ slug: "example-org" });

		await expect(
			resolveUrlSourceProvider({
				organizationId: "org-1",
				userId: "user-1",
				scope: "SINGLE_PAGE",
				sourceNoun: "Website sources",
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(
				/^Website sources need a search provider/,
			),
			data: {
				code: "SCRAPE_PROVIDER_NOT_CONFIGURED",
				settingsPath: "/app/example-org/settings/search-providers",
			},
		});
	});

	it("throws CRAWL_PROVIDER_NOT_CONFIGURED for a path prefix with only scrape-only providers", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([providerRow("tavily")]);

		await expect(
			resolveUrlSourceProvider({
				organizationId: null,
				userId: "user-1",
				scope: "PATH_PREFIX",
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: {
				code: "CRAWL_PROVIDER_NOT_CONFIGURED",
				settingsPath: "/app/settings/search-providers",
			},
		});
	});

	it("names both crawl providers in the CRAWL_PROVIDER_NOT_CONFIGURED message", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([providerRow("jina")]);

		await expect(
			resolveUrlSourceProvider({
				organizationId: "org-1",
				userId: "user-1",
				scope: "PATH_PREFIX",
			}),
		).rejects.toMatchObject({
			data: { code: "CRAWL_PROVIDER_NOT_CONFIGURED" },
			message: expect.stringMatching(/Firecrawl or Cloudflare/),
		});
	});

	it("throws INTERNAL_SERVER_ERROR, not a configuration notice, when the key cannot be decrypted", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([providerRow("jina")]);
		mockDecryptApiKey.mockImplementation(() => {
			throw new Error("bad ciphertext");
		});

		await expect(
			resolveUrlSourceProvider({
				organizationId: "org-1",
				userId: "user-1",
				scope: "SINGLE_PAGE",
			}),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to read jina API key",
		});
	});
});
