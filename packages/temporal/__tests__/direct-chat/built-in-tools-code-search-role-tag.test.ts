import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", () => ({
	tool: (def: unknown) => def,
}));

vi.mock("@repo/openapi-tools", () => ({
	describeOpenApiSpec: vi.fn(),
	looksLikeOpenApiSpec: vi.fn(),
}));

const mockFindManyIntegrations = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findMany: (...args: unknown[]) => mockFindManyIntegrations(...args),
		},
	},
	getMergedSearchProviderConfigs: vi.fn().mockResolvedValue([]),
	getSearchProviderConfig: vi.fn(),
	getProjectCodeIndexes: vi.fn().mockResolvedValue([{ status: "READY" }]),
	resolveModelWithCredentials: vi.fn(),
}));

vi.mock("@repo/rag/lib/embedding", () => ({
	generateEmbedding: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2] }),
}));

vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: vi.fn().mockReturnValue({ indices: [], values: [] }),
}));

vi.mock("@repo/rag/lib/collection-manager", () => ({
	ensureCollection: vi.fn().mockResolvedValue("project-contexts"),
	getCollectionLayout: vi.fn().mockResolvedValue({ supportsHybrid: false }),
}));

const mockQdrantCount = vi.fn().mockResolvedValue({ count: 1 });
const mockQdrantQuery = vi.fn().mockResolvedValue({
	points: [
		{
			score: 0.95,
			payload: {
				filePath: "src/checkout.ts",
				language: "typescript",
				contextType: "CODE_FILE",
				repositoryIntegrationId: "integ-legacy",
				repo: "example-org/payment-v1",
				content: "function processPayment() { return true; }",
			},
		},
		{
			score: 0.88,
			payload: {
				filePath: "src/billing.ts",
				language: "typescript",
				contextType: "CODE_FILE",
				repositoryIntegrationId: "integ-new",
				repo: "example-org/payment-v2",
				content: "function calculateTax() { return 0; }",
			},
		},
	],
});

vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: {
		count: (...args: unknown[]) => mockQdrantCount(...args),
		query: (...args: unknown[]) => mockQdrantQuery(...args),
	},
}));

import { createBuiltInTools } from "../../src/activities/direct-chat/built-in-tools";

describe("code_search tool roleTag attribution", () => {
	it("attaches live roleTag to results, citations, and excerpt headers", async () => {
		mockFindManyIntegrations.mockResolvedValue([
			{
				id: "integ-legacy",
				repositoryOwner: "example-org",
				repositoryName: "payment-v1",
				roleTag: "Legacy V1",
			},
			{
				id: "integ-new",
				repositoryOwner: "example-org",
				repositoryName: "payment-v2",
				roleTag: "New V2",
			},
		]);

		const tools = await createBuiltInTools({
			projectId: "proj-123",
			userId: "user-1",
			organizationId: "org-1",
		});

		const codeSearchTool = tools.code_search as any;
		expect(codeSearchTool).toBeDefined();

		const output = await codeSearchTool.execute({
			query: "processPayment",
		});

		expect(output.success).toBe(true);
		expect(output.results).toHaveLength(2);

		expect(output.results[0]).toMatchObject({
			filePath: "src/checkout.ts",
			roleTag: "Legacy V1",
			excerpt:
				"--- Legacy V1: src/checkout.ts ---\nfunction processPayment() { return true; }",
			citation: {
				projectId: "proj-123",
				filePath: "src/checkout.ts",
				contextType: "CODE_FILE",
				roleTag: "Legacy V1",
			},
		});

		expect(output.results[1]).toMatchObject({
			filePath: "src/billing.ts",
			roleTag: "New V2",
			excerpt:
				"--- New V2: src/billing.ts ---\nfunction calculateTax() { return 0; }",
			citation: {
				projectId: "proj-123",
				filePath: "src/billing.ts",
				contextType: "CODE_FILE",
				roleTag: "New V2",
			},
		});
	});
});
