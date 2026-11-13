/**
 * The web-research endpoint promises logs that never carry the search query.
 * The query also passes through the search providers in `@repo/search`, so
 * this runs each real provider behind `getWebResearchSearcher`, with the
 * network cut off, and checks every log line it writes. The cut-off network
 * fails the way an upstream error can: with a message that repeats the query.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { logged, upstreamError } = vi.hoisted(() => ({
	logged: [] as unknown[][],
	upstreamError: () =>
		new Error(
			'400 Bad Request: {"query":"northwind quarterly widget roadmap"}',
		),
}));

vi.mock("@repo/logs", () => {
	const record = (...args: unknown[]) => {
		logged.push(args);
	};
	return {
		logger: {
			info: record,
			warn: record,
			error: record,
			debug: record,
			log: record,
		},
	};
});

vi.mock("../../../../../search/lib/providers/outbound", async (original) => ({
	...(await original<Record<string, unknown>>()),
	fetchSearchEndpoint: async () => {
		throw upstreamError();
	},
}));

vi.mock("exa-js", () => ({
	default: class {
		async search() {
			throw upstreamError();
		}
		async searchAndContents() {
			throw upstreamError();
		}
	},
}));

const resolveSearchProviderForTenant = vi.fn();
vi.mock("../get-search-provider", () => ({
	resolveSearchProviderForTenant: (...args: unknown[]) =>
		resolveSearchProviderForTenant(...args),
}));

vi.mock("@repo/database", () => ({
	getEnabledOrganizationSearchProviders: vi.fn().mockResolvedValue([]),
}));

import { getWebResearchSearcher } from "../web-research-providers";

const QUERY = "northwind quarterly widget roadmap";

describe.each(["exa", "firecrawl", "jina", "parallel", "tavily"])(
	"%s search through the web-research searcher",
	(providerName) => {
		beforeEach(() => {
			logged.length = 0;
			resolveSearchProviderForTenant.mockResolvedValue({
				providerName,
				apiKey: "test-key",
			});
		});

		it("logs the search without the query text", async () => {
			const resolved = await getWebResearchSearcher("user-1", "org-1");
			expect(resolved).toHaveProperty("searcher");

			if ("searcher" in resolved) {
				await resolved.searcher.search(QUERY, 3).catch(() => undefined);
			}

			expect(logged.length).toBeGreaterThan(0);
			expect(JSON.stringify(logged)).not.toContain("northwind");
		});
	},
);
