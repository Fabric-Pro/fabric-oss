/**
 * `embedCompanyContext` (Fizzy #2719): the shared embed, for a company
 * source.
 *
 * A company source is chunked with its organization's RAG settings — the
 * system defaults where the organization set nothing — never with a
 * project's, embedded in one call with the organization's model, written to
 * the company store in one batch with the company payload, and never marked
 * on a row: the caller marks its own row with the model identity the result
 * names, the identity of the model the embedding call actually used.
 * `embedProjectContext` is pinned alongside: the same content still reads the
 * project's settings, writes the project store and marks the project row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storeCompanyContextPoints: vi.fn(),
	storeProjectContext: vi.fn(),
	generateEmbedding: vi.fn(),
	generateEmbeddings: vi.fn(),
	chunkText: vi.fn(),
	enrichChunksWithTenantContext: vi.fn(),
	routeContentForChunking: vi.fn(),
	getOrganizationRagSettings: vi.fn(),
	getProjectRagSettings: vi.fn(),
	markContextAsEmbedded: vi.fn(),
}));

vi.mock("../../company-contexts/store", () => ({
	storeCompanyContextPoints: mocks.storeCompanyContextPoints,
}));

vi.mock("../store", () => ({
	storeProjectContext: mocks.storeProjectContext,
	deleteProjectContext: vi.fn(),
}));

vi.mock("../../embedding", () => ({
	generateEmbedding: mocks.generateEmbedding,
	generateEmbeddings: mocks.generateEmbeddings,
}));

vi.mock("../../chunking", () => ({
	chunkDescribedOpenApiSpec: vi.fn(),
	chunkText: mocks.chunkText,
	detectContentType: vi.fn(() => ({ type: "text" })),
	enrichChunksWithTenantContext: mocks.enrichChunksWithTenantContext,
	routeContentForChunking: mocks.routeContentForChunking,
}));

vi.mock("@repo/database", () => ({
	getOrganizationRagSettings: mocks.getOrganizationRagSettings,
	getProjectRagSettings: mocks.getProjectRagSettings,
	getDefaultRagSettings: () => ({
		chunkSize: 3000,
		chunkOverlap: 500,
		splitMethod: "DOCUMENT",
		embeddingModel: "TEXT_EMBEDDING_3_SMALL",
		topK: 5,
		similarityThreshold: 0.5,
		enableReranking: false,
	}),
	markContextAsEmbedded: mocks.markContextAsEmbedded,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	embedCompanyContext,
	embedProjectContext,
	getCompanyChunkSettings,
} from "../auto-embed";

const ORG = "org-1";
const MODEL = "OPENAI_DIRECT:text-embedding-3-small";
const SHORT = "We deliver data platforms.";
const LONG = "Company overview. ".repeat(200);

const company = {
	organizationId: ORG,
	sourceId: "src-1",
	contextType: "TEXT",
};

/** The batch embed's result, as the generator reports the model it used. */
function batchResult(
	texts: string[],
	model = {
		provider: "OPENAI_DIRECT",
		modelString: "text-embedding-3-small",
	},
) {
	return {
		embeddings: texts.map(() => [0.1, 0.2]),
		model: model.modelString,
		totalTokens: texts.length,
		cost: 0,
		...model,
	};
}

function chunk(index: number, text: string) {
	return {
		index,
		content: text,
		metadata: { headings: [], section: undefined },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.routeContentForChunking.mockResolvedValue({ kind: "text" });
	mocks.generateEmbedding.mockResolvedValue({
		embedding: [0.1, 0.2],
		model: "text-embedding-3-small",
		tokens: 4,
	});
	mocks.generateEmbeddings.mockImplementation(async (texts: string[]) =>
		batchResult(texts),
	);
	mocks.storeCompanyContextPoints.mockImplementation(
		async (points: Array<{ chunkIndex: number }>) =>
			points.map((point) => `point-${point.chunkIndex}`),
	);
	mocks.storeProjectContext.mockResolvedValue("project-point");
	mocks.getOrganizationRagSettings.mockResolvedValue(null);
	mocks.getProjectRagSettings.mockResolvedValue({
		chunkSize: 3000,
		chunkOverlap: 500,
		splitMethod: "DOCUMENT",
	});
	mocks.chunkText.mockReturnValue([
		chunk(0, "part one"),
		chunk(1, "part two"),
	]);
	mocks.enrichChunksWithTenantContext.mockImplementation(
		async (chunks: Array<{ index: number; content: string }>) =>
			chunks.map((c) => ({
				...c,
				originalContent: c.content,
				enrichedContent: `ctx: ${c.content}`,
			})),
	);
});

describe("embedCompanyContext", () => {
	it("writes a short text to the company store as one point, never touching a project", async () => {
		const result = await embedCompanyContext({
			contextId: "src-1",
			userId: "user-1",
			content: SHORT,
			type: "TEXT",
			metadata: { sourceTitle: "About us" },
			company,
		});

		expect(result).toEqual({
			success: true,
			qdrantId: "point-0",
			chunksCreated: 1,
			embeddingModel: MODEL,
		});
		expect(mocks.storeCompanyContextPoints).toHaveBeenCalledTimes(1);
		expect(mocks.storeCompanyContextPoints).toHaveBeenCalledWith([
			{
				organizationId: ORG,
				sourceId: "src-1",
				contextId: "src-1",
				parentContextId: null,
				contextType: "TEXT",
				embeddingModel: MODEL,
				sourceUrl: null,
				sourceTitle: "About us",
				content: SHORT,
				embedding: [0.1, 0.2],
				chunkIndex: 0,
			},
		]);
		// No key is handed over or checked: the call resolves the
		// organization's own embedding provider, whoever embeds.
		expect(mocks.generateEmbeddings).toHaveBeenCalledWith([SHORT], {
			userId: "user-1",
			organizationId: ORG,
			tags: ["company-context", "text"],
			organizationOnly: true,
		});
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
		expect(mocks.getOrganizationRagSettings).toHaveBeenCalledWith(ORG);
		expect(mocks.getProjectRagSettings).not.toHaveBeenCalled();
		expect(mocks.storeProjectContext).not.toHaveBeenCalled();
		expect(mocks.markContextAsEmbedded).not.toHaveBeenCalled();
	});

	it("chunks long content with the organization's RAG settings", async () => {
		mocks.getOrganizationRagSettings.mockResolvedValue({
			chunkSize: 1200,
			chunkOverlap: 100,
			splitMethod: "SENTENCE",
		});

		const result = await embedCompanyContext({
			contextId: "src-1",
			userId: "user-1",
			content: LONG,
			type: "TEXT",
			company,
		});

		expect(result).toEqual({
			success: true,
			qdrantId: "point-0",
			chunksCreated: 2,
			embeddingModel: MODEL,
		});
		expect(mocks.chunkText).toHaveBeenCalledWith(LONG, "src-1", {
			strategy: "SENTENCE",
			chunkSize: 1200,
			chunkOverlap: 100,
			contentType: "text",
		});
		expect(mocks.enrichChunksWithTenantContext).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({
				organizationId: ORG,
				projectId: undefined,
			}),
		);
		// One batched write for the whole source, not one per chunk.
		expect(mocks.storeCompanyContextPoints).toHaveBeenCalledTimes(1);
		expect(mocks.storeCompanyContextPoints.mock.calls[0][0]).toEqual([
			expect.objectContaining({
				chunkIndex: 0,
				content: "part one",
				embeddingModel: MODEL,
			}),
			expect.objectContaining({
				chunkIndex: 1,
				content: "part two",
				embeddingModel: MODEL,
			}),
		]);
		// One embedding call for every chunk, with its document context, on
		// the organization's model.
		expect(mocks.generateEmbeddings).toHaveBeenCalledTimes(1);
		expect(mocks.generateEmbeddings).toHaveBeenCalledWith(
			["ctx: part one", "ctx: part two"],
			expect.objectContaining({ organizationOnly: true }),
		);
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
		expect(mocks.getProjectRagSettings).not.toHaveBeenCalled();
		expect(mocks.markContextAsEmbedded).not.toHaveBeenCalled();
	});

	it("chunks with the system defaults when the organization set nothing", async () => {
		await embedCompanyContext({
			contextId: "src-1",
			userId: "user-1",
			content: LONG,
			type: "TEXT",
			company,
		});

		expect(mocks.chunkText).toHaveBeenCalledWith(LONG, "src-1", {
			strategy: "DOCUMENT",
			chunkSize: 3000,
			chunkOverlap: 500,
			contentType: "text",
		});
	});

	it("fails the whole embed when the batched write fails, naming no model", async () => {
		mocks.storeCompanyContextPoints.mockRejectedValue(
			new Error("qdrant timeout"),
		);

		const result = await embedCompanyContext({
			contextId: "src-1",
			userId: "user-1",
			content: LONG,
			type: "TEXT",
			company,
		});

		expect(result).toEqual({ success: false, error: "qdrant timeout" });
	});

	it("fails without writing anything when a chunk comes back without an embedding", async () => {
		mocks.generateEmbeddings.mockResolvedValue({
			...batchResult(["one", "two"]),
			embeddings: [[0.1, 0.2], []],
		});

		const result = await embedCompanyContext({
			contextId: "src-1",
			userId: "user-1",
			content: LONG,
			type: "TEXT",
			company,
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Failed to embed 1\/2 chunks/);
		expect(mocks.storeCompanyContextPoints).not.toHaveBeenCalled();
	});

	it("stamps the model the embedding call used, not one resolved before it", async () => {
		// The organization switched models after the caller checked its
		// model: the vectors are the new model's, and say so.
		mocks.generateEmbeddings.mockImplementation(async (texts: string[]) =>
			batchResult(texts, {
				provider: "OPENAI_COMPATIBLE",
				modelString: "embed-1536",
			}),
		);

		const result = await embedCompanyContext({
			contextId: "src-1",
			userId: "user-1",
			content: LONG,
			type: "TEXT",
			company,
		});

		expect(result.embeddingModel).toBe("OPENAI_COMPATIBLE:embed-1536");
		for (const point of mocks.storeCompanyContextPoints.mock.calls[0][0]) {
			expect(point.embeddingModel).toBe("OPENAI_COMPATIBLE:embed-1536");
		}
	});

	it("reports a missing embedding provider as a failed embed rather than throwing", async () => {
		mocks.generateEmbeddings.mockRejectedValue(
			new Error("No embedding provider configured."),
		);

		const result = await embedCompanyContext({
			contextId: "src-1",
			userId: "user-1",
			content: SHORT,
			type: "TEXT",
			company,
		});

		expect(result).toEqual({
			success: false,
			error: "No embedding provider configured.",
		});
		expect(mocks.storeCompanyContextPoints).not.toHaveBeenCalled();
	});

	it("keeps the source as originalContextId on a crawled page's points", async () => {
		await embedCompanyContext({
			contextId: "page-7",
			userId: "user-1",
			content: SHORT,
			type: "LINK",
			metadata: {
				sourceUrl: "https://example.com/services",
				sourceTitle: "Services",
			},
			company: {
				...company,
				contextType: "LINK",
				parentContextId: "src-1",
			},
		});

		expect(mocks.storeCompanyContextPoints).toHaveBeenCalledWith([
			expect.objectContaining({
				sourceId: "src-1",
				contextId: "page-7",
				parentContextId: "src-1",
				contextType: "LINK",
				sourceUrl: "https://example.com/services",
			}),
		]);
	});
});

describe("embedProjectContext is unchanged", () => {
	it("reads the project's settings, writes the project store and marks the project row", async () => {
		const result = await embedProjectContext({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: ORG,
			content: SHORT,
			type: "TEXT",
			apiKey: "key",
		});

		expect(result).toEqual({
			success: true,
			qdrantId: "project-point",
			chunksCreated: 1,
		});
		expect(mocks.getProjectRagSettings).toHaveBeenCalledWith("proj-1");
		expect(mocks.generateEmbedding).toHaveBeenCalledWith(
			SHORT,
			{
				userId: "user-1",
				organizationId: ORG,
				projectId: "proj-1",
				tags: ["project-context", "text"],
			},
			{ apiKey: "key" },
		);
		// The project path keeps the acting user's resolution.
		expect(mocks.generateEmbedding.mock.calls[0][1]).not.toHaveProperty(
			"organizationOnly",
		);
		expect(mocks.storeProjectContext).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "ctx-1",
				projectId: "proj-1",
				organizationId: ORG,
			}),
		);
		expect(mocks.markContextAsEmbedded).toHaveBeenCalledWith(
			"ctx-1",
			"project-point",
		);
		expect(mocks.getOrganizationRagSettings).not.toHaveBeenCalled();
		expect(mocks.storeCompanyContextPoints).not.toHaveBeenCalled();
		expect(mocks.generateEmbeddings).not.toHaveBeenCalled();
	});

	it("still embeds long content chunk by chunk, with the key it was handed", async () => {
		const result = await embedProjectContext({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: ORG,
			content: LONG,
			type: "TEXT",
			apiKey: "key",
		});

		expect(result).toEqual({
			success: true,
			qdrantId: "project-point",
			chunksCreated: 2,
		});
		expect(mocks.generateEmbedding.mock.calls).toEqual([
			[
				"ctx: part one",
				{
					userId: "user-1",
					organizationId: ORG,
					projectId: "proj-1",
					tags: ["project-context", "text", "chunk-0"],
				},
				{ apiKey: "key" },
			],
			[
				"ctx: part two",
				{
					userId: "user-1",
					organizationId: ORG,
					projectId: "proj-1",
					tags: ["project-context", "text", "chunk-1"],
				},
				{ apiKey: "key" },
			],
		]);
		expect(mocks.storeProjectContext).toHaveBeenCalledTimes(2);
		expect(mocks.markContextAsEmbedded).toHaveBeenCalledWith(
			"ctx-1",
			"project-point",
		);
		expect(mocks.generateEmbeddings).not.toHaveBeenCalled();
		expect(mocks.storeCompanyContextPoints).not.toHaveBeenCalled();
	});

	it("still refuses a project embed without a key", async () => {
		const result = await embedProjectContext({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: ORG,
			content: SHORT,
			type: "TEXT",
			apiKey: "",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/^No AI provider configured/);
		expect(mocks.getProjectRagSettings).not.toHaveBeenCalled();
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
	});
});

describe("getCompanyChunkSettings", () => {
	it("takes each setting the organization set, and a caller's defaults for the rest", async () => {
		mocks.getOrganizationRagSettings.mockResolvedValue({
			chunkSize: 1500,
			chunkOverlap: null,
			splitMethod: null,
		});

		await expect(
			getCompanyChunkSettings(ORG, {
				chunkSize: 2048,
				chunkOverlap: 200,
				splitMethod: null,
			}),
		).resolves.toEqual({
			chunkSize: 1500,
			chunkOverlap: 200,
			splitMethod: null,
			strategy: undefined,
		});
	});

	it("refuses to read settings without an organization", async () => {
		await expect(getCompanyChunkSettings("")).rejects.toThrow(
			/requires an organizationId/,
		);
		expect(mocks.getOrganizationRagSettings).not.toHaveBeenCalled();
	});
});
