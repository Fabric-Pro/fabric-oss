/**
 * `embedUrlPageActivity` for a company owner (Fizzy #2719): one crawled page
 * of a company website, embedded into the organization's company collection.
 *
 * What this pins, below the crawl workflow (`company-url-source.test.ts`
 * drives the whole crawl):
 *  - the embedding provider is checked through the organization's own model
 *    resolution, never the default-provider key an acting member's personal
 *    provider can answer, so an organization whose only provider is a
 *    dedicated embedding one can index;
 *  - no provider at all fails the page with the no-provider reason, as a
 *    non-retryable failure rather than a stray error;
 *  - the page records the model the embed reports having used, not the one
 *    resolved before it;
 *  - a failure after the page's earlier points were removed clears its index
 *    markers, and a failure of that removal itself does not.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run src/activities/url-source/__tests__/embed-company-url-page.test.ts
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "org-1";
const USER = "user-1";
const SOURCE = "src-1";
const PAGE = "page-1";
const MODEL = "OPENAI_DIRECT:text-embedding-3-small";

const mocks = vi.hoisted(() => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		getSystemRAGProviderConfig: vi.fn(),
		resolveCompanyEmbeddingModel: vi.fn(),
		embedCompanyContext: vi.fn(),
		embedProjectContext: vi.fn(),
		deleteCompanyContextRowPoints: vi.fn(),
		// The page's crawl store.
		markPageEmbedded: vi.fn(),
		recordPageFailure: vi.fn(),
		completeEmptyPage: vi.fn(),
	};
});

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: mocks.AIProviderNotConfiguredError,
	getSystemRAGProviderConfig: mocks.getSystemRAGProviderConfig,
}));

vi.mock("@repo/rag", () => ({
	deleteCompanyContextRowPoints: mocks.deleteCompanyContextRowPoints,
	embedCompanyContext: mocks.embedCompanyContext,
	embedProjectContext: mocks.embedProjectContext,
	resolveCompanyEmbeddingModel: mocks.resolveCompanyEmbeddingModel,
	unsupportedEmbeddingModelMessage: (model: { identity: string }) =>
		`Unsupported embedding model: ${model.identity}`,
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", () => ({ db: {} }));

vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	heartbeat: vi.fn(),
}));

vi.mock("../../../client", () => ({ getTemporalClient: vi.fn() }));

vi.mock("../../../lib/context-row-store", () => ({
	companyLinkCrawlStore: () => ({
		markPageEmbedded: mocks.markPageEmbedded,
		recordPageFailure: mocks.recordPageFailure,
		completeEmptyPage: mocks.completeEmptyPage,
	}),
}));

vi.mock("../../lib/activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE } from "../company-gate-activity";
import { embedUrlPageActivity } from "../embed-url-page-activity";

const INPUT = {
	pageId: PAGE,
	parentContextId: SOURCE,
	pageUrl: "https://example.com/services",
	parentSourceTitle: "Our website",
	content: "We run discovery, build and support engagements.",
	userId: USER,
	organizationId: ORG,
	owner: { kind: "company", organizationId: ORG } as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
		identity: MODEL,
		dimensions: 1536,
		supported: true,
	});
	mocks.deleteCompanyContextRowPoints.mockResolvedValue({
		collectionExists: true,
	});
	mocks.embedCompanyContext.mockResolvedValue({
		success: true,
		qdrantId: "point-0",
		chunksCreated: 2,
		embeddingModel: MODEL,
	});
	mocks.markPageEmbedded.mockResolvedValue(true);
	mocks.recordPageFailure.mockResolvedValue(true);
	mocks.completeEmptyPage.mockResolvedValue(true);
});

describe("embedUrlPageActivity with a company owner", () => {
	it("embeds the page without a default-provider key and marks it with the embed's model", async () => {
		const result = await embedUrlPageActivity(INPUT);

		expect(result).toEqual({
			success: true,
			qdrantId: "point-0",
			chunkCount: 2,
		});
		expect(mocks.getSystemRAGProviderConfig).not.toHaveBeenCalled();
		const options = mocks.embedCompanyContext.mock.calls[0][0];
		expect(options).not.toHaveProperty("apiKey");
		expect(options.company).toEqual({
			organizationId: ORG,
			sourceId: SOURCE,
			contextType: "LINK",
			parentContextId: SOURCE,
		});
		expect(mocks.markPageEmbedded).toHaveBeenCalledWith(PAGE, {
			embeddingModel: MODEL,
			qdrantId: "point-0",
			chunkCount: 2,
		});
		expect(mocks.embedProjectContext).not.toHaveBeenCalled();
	});

	it("indexes for an organization whose only provider is a dedicated embedding one", async () => {
		mocks.getSystemRAGProviderConfig.mockRejectedValue(
			new mocks.AIProviderNotConfiguredError("No AI provider configured"),
		);

		const result = await embedUrlPageActivity(INPUT);

		expect(result.success).toBe(true);
		expect(mocks.markPageEmbedded).toHaveBeenCalled();
		expect(mocks.recordPageFailure).not.toHaveBeenCalled();
	});

	it("fails the page, non-retryably and with its reason, when the organization has no embedding provider", async () => {
		mocks.resolveCompanyEmbeddingModel.mockRejectedValue(
			new mocks.AIProviderNotConfiguredError("No embedding provider"),
		);

		const run = embedUrlPageActivity(INPUT);

		await expect(run).rejects.toBeInstanceOf(ApplicationFailure);
		await run.catch((error: ApplicationFailure) => {
			expect(error.nonRetryable).toBe(true);
			expect(error.message).toBe(
				COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE,
			);
		});
		expect(mocks.recordPageFailure).toHaveBeenCalledWith(
			PAGE,
			COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE,
		);
		expect(mocks.deleteCompanyContextRowPoints).not.toHaveBeenCalled();
		expect(mocks.embedCompanyContext).not.toHaveBeenCalled();
	});

	it("records the model the embed reports, not the one resolved before it", async () => {
		// The organization switched models between the check and the embed.
		mocks.embedCompanyContext.mockResolvedValue({
			success: true,
			qdrantId: "point-0",
			chunksCreated: 2,
			embeddingModel: "OPENAI_COMPATIBLE:embed-1536",
		});

		await embedUrlPageActivity(INPUT);

		expect(mocks.markPageEmbedded).toHaveBeenCalledWith(PAGE, {
			embeddingModel: "OPENAI_COMPATIBLE:embed-1536",
			qdrantId: "point-0",
			chunkCount: 2,
		});
	});

	it("clears the page's index markers when the embed fails after its points were removed", async () => {
		mocks.embedCompanyContext.mockResolvedValue({
			success: false,
			error: "rate limited",
		});

		await expect(embedUrlPageActivity(INPUT)).rejects.toThrow(
			"rate limited",
		);
		expect(mocks.recordPageFailure).toHaveBeenCalledWith(
			PAGE,
			"rate limited",
			{ pointsRemoved: true },
		);
		expect(mocks.markPageEmbedded).not.toHaveBeenCalled();
	});

	it("keeps the page's index markers when removing its earlier points itself fails", async () => {
		mocks.deleteCompanyContextRowPoints.mockRejectedValue(
			new Error("qdrant unavailable"),
		);

		await expect(embedUrlPageActivity(INPUT)).rejects.toThrow(
			"qdrant unavailable",
		);
		expect(mocks.recordPageFailure).toHaveBeenCalledWith(
			PAGE,
			"qdrant unavailable",
			{ pointsRemoved: false },
		);
		expect(mocks.embedCompanyContext).not.toHaveBeenCalled();
	});
});
