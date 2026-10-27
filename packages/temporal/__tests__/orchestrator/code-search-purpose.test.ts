import { currentAiCallPurpose } from "@repo/ai/lib/call-purpose-context";
import { expect, it, vi } from "vitest";

const seen = vi.hoisted(
	() => [] as Array<{ purpose?: string; context: unknown }>,
);
vi.mock("@repo/ai", () => ({ tool: (definition: unknown) => definition }));
vi.mock("@repo/database", () => ({
	getProjectAccessContext: vi.fn(async () => ({
		organizationId: "org-example",
	})),
	db: {
		project: { findUnique: vi.fn(async () => null) },
		projectRepositoryIntegration: { findMany: vi.fn(async () => []) },
	},
	getProjectCodeIndexes: vi.fn(async () => [{ status: "READY" }]),
	getProjectReposForCodeSearch: vi.fn(async () => [
		{
			provider: "GITHUB",
			owner: "example-org",
			repo: "example-repo",
			branch: "main",
		},
	]),
	parseRepoUrl: vi.fn(),
}));
vi.mock("@repo/rag/lib/embedding", () => ({
	generateEmbedding: vi.fn(async (_query, context) => {
		seen.push({ purpose: currentAiCallPurpose(), context });
		return { embedding: [0.1] };
	}),
}));
vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	ensureCollection: vi.fn(async () => "example-collection"),
	getCollectionLayout: vi.fn(async () => ({ supportsHybrid: false })),
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: {
		count: vi.fn(async () => ({ count: 1 })),
		query: vi.fn(async () => ({ points: [] })),
	},
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: vi.fn(async () => ({
		token: "token-example",
		method: "pat",
	})),
}));
vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: vi.fn(async () => ({ results: [] })),
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: vi.fn(),
}));

import { CodeSearchHandler } from "../../src/activities/orchestrator/execution/handlers/code-search-handler";

it("attributes code-index query embeddings separately from capability search", async () => {
	const handler = new CodeSearchHandler();
	await handler.execute({
		input: {
			step: {
				id: "step-example",
				app: "code_search",
				inputs: { query: "query" },
			},
			projectId: "project-example",
			userId: "user-example",
			organizationId: "org-example",
		},
		variables: {},
		toolCalls: [],
		startTime: Date.now(),
	} as any);
	expect(seen).toEqual([
		{
			purpose: "code-search-embedding",
			context: expect.objectContaining({
				featureKey: "code-index",
				userId: "user-example",
				organizationId: "org-example",
			}),
		},
	]);
});

it("attributes code-index embeddings reached through the catalog adapter", async () => {
	seen.length = 0;
	const { runFabricCatalogTool } = await import(
		"../../src/activities/orchestrator/execution/fabric-catalog-adapter"
	);
	const result = await runFabricCatalogTool({
		toolName: "code_search",
		args: { query: "query" },
		projectId: "project-example",
		userId: "user-example",
		organizationId: "org-example",
	});
	expect(result.success ? undefined : result.error).toBeUndefined();
	expect(result).toMatchObject({ success: true });
	expect(seen).toEqual([
		{
			purpose: "code-search-embedding",
			context: expect.objectContaining({ featureKey: "code-index" }),
		},
	]);
});
