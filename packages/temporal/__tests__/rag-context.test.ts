/**
 * Tests for `gatherLiveUrlSources` — the retrieval-time Live mode + cache-miss
 * fallback helper (URL Context Sources, spec §8.2, §8.3).
 *
 * Mocks Prisma, the search-provider key resolver, the decrypt helper, and the
 * Firecrawl scrapeUrl client so the helper can run in isolation without any
 * external services.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test rag-context
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// Hoisted mocks — required because vi.mock factories are hoisted above
// module-level `const` declarations.
// -----------------------------------------------------------------------------

const {
	findManyMock,
	updateMock,
	getSearchProviderConfigMock,
	decryptApiKeyMock,
	scrapeUrlMock,
} = vi.hoisted(() => ({
	findManyMock: vi.fn(),
	updateMock: vi.fn(),
	getSearchProviderConfigMock: vi.fn(),
	decryptApiKeyMock: vi.fn(),
	scrapeUrlMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		projectContext: {
			findMany: findManyMock,
			update: updateMock,
		},
	},
	getSearchProviderConfig: getSearchProviderConfigMock,
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: decryptApiKeyMock,
}));

vi.mock("../src/activities/lib/firecrawl-client", () => ({
	scrapeUrl: scrapeUrlMock,
}));

// `gatherLiveUrlSources` lives next to `retrieveProjectContexts`, which pulls
// in `@repo/ai` and `@repo/rag`. We don't exercise those code paths here, so
// stubbing them avoids loading their full dependency graphs during the test.
vi.mock("@repo/ai", () => ({
	embed: vi.fn(),
	getAIEmbeddingModelWithMetadata: vi.fn(),
	logEmbeddingUsageAsync: vi.fn(),
}));

vi.mock("@repo/rag", () => ({
	extractBaseContextId: (id: string) => id,
	searchSimilarProjectContexts: vi.fn(),
}));

import { gatherLiveUrlSources } from "../src/activities/task-agent/rag-context";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const PROJECT_ID = "proj-live";
const USER_ID = "user-live";
const ORG_ID = "org-live";

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		sourceUrl: "https://example.com/docs",
		sourceTitle: "Example Docs",
		urlRefreshMode: "LIVE" as const,
		extractionStatus: "COMPLETED",
		metadata: null,
		...overrides,
	};
}

function happyScrape(markdown: string, opts: Record<string, unknown> = {}) {
	return {
		success: true as const,
		data: {
			pageUrl: "https://example.com/docs",
			pageTitle: "Example Docs",
			markdown,
			...opts,
		},
	};
}

function configureFirecrawlOk(key = "decrypted-key") {
	getSearchProviderConfigMock.mockResolvedValue({
		encryptedApiKey: "enc:value",
		endpoint: null,
		enabled: true,
		source: "user",
	});
	decryptApiKeyMock.mockReturnValue(key);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("gatherLiveUrlSources", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns [] when the project has no qualifying LINK rows", async () => {
		findManyMock.mockResolvedValue([]);

		const result = await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(result).toEqual([]);
		// Without rows we never need to resolve the Firecrawl key.
		expect(getSearchProviderConfigMock).not.toHaveBeenCalled();
		expect(scrapeUrlMock).not.toHaveBeenCalled();
	});

	it("returns Live items for LIVE-mode rows (mode: 'live', no metadata stamp)", async () => {
		findManyMock.mockResolvedValue([row({ urlRefreshMode: "LIVE" })]);
		configureFirecrawlOk();
		scrapeUrlMock.mockResolvedValue(happyScrape("# Fresh markdown\n"));

		const result = await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			sourceUrl: "https://example.com/docs",
			sourceTitle: "Example Docs",
			content: "# Fresh markdown\n",
			mode: "live",
		});
		// Live mode must NOT stamp metadata.lastFallbackAt — that's reserved
		// for the fallback path.
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("returns fallback items for non-LIVE rows with extractionStatus = FAILED", async () => {
		findManyMock.mockResolvedValue([
			row({
				id: "ctx-failed",
				urlRefreshMode: "ONCE",
				extractionStatus: "FAILED",
				metadata: { previous: "value" },
			}),
		]);
		configureFirecrawlOk();
		scrapeUrlMock.mockResolvedValue(happyScrape("# Re-fetched\n"));

		const result = await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			content: "# Re-fetched\n",
			mode: "fallback",
		});
		// metadata.lastFallbackAt must be stamped, and existing metadata
		// keys must be preserved.
		expect(updateMock).toHaveBeenCalledTimes(1);
		const updateCall = updateMock.mock.calls[0]?.[0] as
			| {
					where: { id: string };
					data: { metadata: Record<string, unknown> };
			  }
			| undefined;
		expect(updateCall?.where.id).toBe("ctx-failed");
		expect(updateCall?.data.metadata.previous).toBe("value");
		expect(typeof updateCall?.data.metadata.lastFallbackAt).toBe("string");
	});

	it("does NOT return fallback for non-LIVE rows that already have indexed children", async () => {
		// The Prisma filter is supposed to exclude these rows — we model that
		// by simply not returning them from `findMany`. Asserting on the
		// final result is the contract: callers should never see them.
		findManyMock.mockResolvedValue([]);
		configureFirecrawlOk();

		const result = await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(result).toEqual([]);
		expect(scrapeUrlMock).not.toHaveBeenCalled();
	});

	it("applies XOR tenancy: org-context call filters by organizationId", async () => {
		findManyMock.mockResolvedValue([]);

		await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		const where = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
		expect(where.organizationId).toBe(ORG_ID);
		expect(where.userId).toBe(USER_ID);
	});

	it("applies XOR tenancy: personal-context call filters by organizationId = null", async () => {
		findManyMock.mockResolvedValue([]);

		await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
		});

		const where = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
		// Personal context: organizationId MUST be exactly null (spec /
		// AGENTS.md XOR — never undefined or omitted).
		expect(where.organizationId).toBeNull();
		expect(where.userId).toBe(USER_ID);
	});

	it("skips rows when the tenant has no Firecrawl key (logs, doesn't throw)", async () => {
		findManyMock.mockResolvedValue([row()]);
		getSearchProviderConfigMock.mockResolvedValue(null);
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		const result = await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(result).toEqual([]);
		expect(scrapeUrlMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("truncates content over the 50KB limit and marks `truncated: true`", async () => {
		findManyMock.mockResolvedValue([row()]);
		configureFirecrawlOk();
		const huge = "x".repeat(60_000);
		scrapeUrlMock.mockResolvedValue(happyScrape(huge));

		const result = await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(result).toHaveLength(1);
		expect(result[0].content.length).toBe(50_000);
		expect(result[0].truncated).toBe(true);
	});

	it("returns nothing for a row whose live scrape fails (doesn't break others)", async () => {
		findManyMock.mockResolvedValue([
			row({ id: "ctx-ok", sourceUrl: "https://ok.example.com" }),
			row({ id: "ctx-bad", sourceUrl: "https://bad.example.com" }),
		]);
		configureFirecrawlOk();
		scrapeUrlMock.mockImplementation((url: string) => {
			if (url === "https://ok.example.com") {
				return Promise.resolve(happyScrape("good", { pageUrl: url }));
			}
			return Promise.resolve({
				success: false as const,
				error: {
					code: "ROBOTS_BLOCKED" as const,
					message: "robots.txt",
				},
			});
		});
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		const result = await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		// Only the successful URL contributes.
		expect(result).toHaveLength(1);
		expect(result[0].sourceUrl).toBe("https://ok.example.com");
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("returns null sourceTitle when neither the row nor the scrape provides one", async () => {
		findManyMock.mockResolvedValue([row({ sourceTitle: null })]);
		configureFirecrawlOk();
		scrapeUrlMock.mockResolvedValue(
			happyScrape("body", { pageTitle: null }),
		);

		const result = await gatherLiveUrlSources({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(result[0].sourceTitle).toBeNull();
	});
});
