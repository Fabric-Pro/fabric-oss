/**
 * `generateEmbedding(s)` forward `organizationOnly` to the model resolver
 * (company context, Fizzy #2719).
 *
 * Company vectors are written by one member and searched by every other, so
 * the model they embed with has to be the organization's, the one
 * `resolveCompanyEmbeddingModel` names — never the acting member's personal
 * provider. The tenant context carries that request; these tests pin that it
 * reaches `getAIEmbeddingModelWithMetadata`, and that a caller without it
 * resolves exactly as before. Both also report the model the call resolved,
 * so a caller that records its index's model stamps the one that produced
 * the vectors.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAIEmbeddingModelWithMetadataMock } = vi.hoisted(() => ({
	getAIEmbeddingModelWithMetadataMock: vi.fn(),
}));

vi.mock("ai", () => ({
	embed: vi.fn(async () => ({ embedding: [0.1], usage: { tokens: 1 } })),
	embedMany: vi.fn(async ({ values }: { values: string[] }) => ({
		embeddings: values.map(() => [0.1]),
		usage: { tokens: values.length },
	})),
}));

vi.mock("@repo/ai", () => ({
	getAIEmbeddingModelWithMetadata: getAIEmbeddingModelWithMetadataMock,
	logEmbeddingUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generateEmbedding, generateEmbeddings } from "../generator";

const COMPANY = {
	userId: "user-1",
	organizationId: "org-1",
	tags: ["company-context"],
	organizationOnly: true,
};

const PROJECT = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "proj-1",
	tags: ["project-context"],
};

beforeEach(() => {
	vi.clearAllMocks();
	getAIEmbeddingModelWithMetadataMock.mockResolvedValue({
		model: { id: "text-embedding-3-small" },
		metadata: {
			modelString: "openai/text-embedding-3-small",
			provider: "VERCEL_GATEWAY",
			selectionSource: "system_default",
		},
		trackUsage: vi.fn(),
	});
});

describe("organizationOnly", () => {
	it("reaches the resolver from generateEmbedding", async () => {
		await generateEmbedding("query", COMPANY);

		expect(getAIEmbeddingModelWithMetadataMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			organizationOnly: true,
		});
	});

	it("reaches the resolver from generateEmbeddings", async () => {
		await generateEmbeddings(["one", "two"], COMPANY);

		expect(getAIEmbeddingModelWithMetadataMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			organizationOnly: true,
		});
	});

	it("reports the provider and full model string the call resolved", async () => {
		const single = await generateEmbedding("query", COMPANY);
		const batch = await generateEmbeddings(["one", "two"], COMPANY);

		for (const result of [single, batch]) {
			expect(result).toMatchObject({
				// The base name, as before …
				model: "text-embedding-3-small",
				// … and the model that produced the vectors, unstripped.
				provider: "VERCEL_GATEWAY",
				modelString: "openai/text-embedding-3-small",
			});
		}
	});

	it("is absent for every other caller, whose resolution is unchanged", async () => {
		await generateEmbedding("query", PROJECT);
		await generateEmbeddings(["one"], PROJECT);

		for (const [context] of getAIEmbeddingModelWithMetadataMock.mock
			.calls) {
			expect(context).toEqual({
				userId: "user-1",
				organizationId: "org-1",
			});
			expect(context).not.toHaveProperty("organizationOnly");
		}
	});
});
