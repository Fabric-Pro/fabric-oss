import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
		},
		projectRepositoryIntegration: {
			findMany: vi.fn(),
		},
	},
	getProjectRagSettings: vi.fn(),
	getRetrievableContextById: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../embedding", () => ({ generateEmbedding: vi.fn() }));

vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [1], values: [1] })),
}));

vi.mock("../store", () => ({ searchSimilarProjectContexts: vi.fn() }));

vi.mock("../summary-injection", () => ({
	applyContextSummary: (list: unknown) => list,
}));

import {
	db,
	getProjectRagSettings,
	getRetrievableContextById,
} from "@repo/database";
import { generateEmbedding } from "../../embedding";
import { formatContextsForPrompt, retrieveProjectContexts } from "../retrieval";
import { searchSimilarProjectContexts } from "../store";

describe("retrieveProjectContexts end-to-end roleTag resolution", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(getProjectRagSettings).mockResolvedValue({
			topK: 5,
			similarityThreshold: 0.5,
			enableReranking: false,
		} as any);
		vi.mocked(generateEmbedding).mockResolvedValue({
			embedding: [0.1, 0.2, 0.3],
			usage: { promptTokens: 1, totalTokens: 1 },
		} as any);
	});

	it("resolves roleTag for code contexts by repo ('owner/name') and formats prompt context headers", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			{ contextId: "ctx-legacy-1", score: 0.92 },
			{ contextId: "ctx-new-1", score: 0.88 },
		] as any);

		vi.mocked(db.projectRepositoryIntegration.findMany).mockResolvedValue([
			{
				id: "integ-legacy",
				repositoryOwner: "example-org",
				repositoryName: "legacy-app",
				roleTag: "Legacy",
			},
			{
				id: "integ-new",
				repositoryOwner: "example-org",
				repositoryName: "new-app",
				roleTag: "New",
			},
		] as any);

		vi.mocked(getRetrievableContextById)
			.mockResolvedValueOnce({
				id: "ctx-legacy-1",
				type: "TEXT",
				content: "function oldBilling() {}",
				originalFilename: "example-org/legacy-app/billing.ts",
				metadata: {
					provider: "CODE_ANALYSIS",
					repo: "example-org/legacy-app",
				},
			} as any)
			.mockResolvedValueOnce({
				id: "ctx-new-1",
				type: "TEXT",
				content: "function newBilling() {}",
				originalFilename: "example-org/new-app/billing.ts",
				metadata: {
					provider: "CODE_ANALYSIS",
					repo: "example-org/new-app",
				},
			} as any);

		const contexts = await retrieveProjectContexts({
			projectId: "proj-123",
			userId: "user-123",
			query: "billing calculation",
		});

		expect(db.projectRepositoryIntegration.findMany).toHaveBeenCalledWith({
			where: { projectId: "proj-123" },
			select: {
				id: true,
				repositoryOwner: true,
				repositoryName: true,
				roleTag: true,
			},
		});

		expect(contexts).toHaveLength(2);
		expect(contexts[0].metadata?.roleTag).toBe("Legacy");
		expect(contexts[1].metadata?.roleTag).toBe("New");

		const promptString = formatContextsForPrompt(contexts);
		expect(promptString).toContain(
			"--- Legacy: example-org/legacy-app/billing.ts (CODE_ANALYSIS, relevance: 92.0%) ---",
		);
		expect(promptString).toContain(
			"--- New: example-org/new-app/billing.ts (CODE_ANALYSIS, relevance: 88.0%) ---",
		);
	});

	it("ensures live DB roleTag lookup takes precedence over stale metadata snapshots when retagged", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			{ contextId: "ctx-retagged", score: 0.95 },
		] as any);

		vi.mocked(db.projectRepositoryIntegration.findMany).mockResolvedValue([
			{
				id: "integ-1",
				repositoryOwner: "example-org",
				repositoryName: "app-v1",
				roleTag: "UpdatedLegacyTag",
			},
		] as any);

		vi.mocked(getRetrievableContextById).mockResolvedValueOnce({
			id: "ctx-retagged",
			type: "TEXT",
			content: "function billing() {}",
			originalFilename: "example-org/app-v1/billing.ts",
			metadata: {
				provider: "CODE_ANALYSIS",
				repo: "example-org/app-v1",
				repositoryIntegrationId: "integ-1",
				roleTag: "StaleSnapshotTag", // Legacy static snapshot present on old row
			},
		} as any);

		const contexts = await retrieveProjectContexts({
			projectId: "proj-123",
			userId: "user-123",
			query: "billing",
		});

		expect(contexts[0].metadata?.roleTag).toBe("UpdatedLegacyTag");
		const promptString = formatContextsForPrompt(contexts);
		expect(promptString).toContain(
			"--- UpdatedLegacyTag: example-org/app-v1/billing.ts (CODE_ANALYSIS, relevance: 95.0%) ---",
		);
	});

	it("bypasses projectRepositoryIntegration database query when no code contexts are present", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			{ contextId: "ctx-doc-1", score: 0.9 },
		] as any);

		vi.mocked(getRetrievableContextById).mockResolvedValueOnce({
			id: "ctx-doc-1",
			type: "TEXT",
			content: "Product requirements document...",
			originalFilename: "prd.pdf",
			metadata: { provider: "DOCUMENT" },
		} as any);

		const contexts = await retrieveProjectContexts({
			projectId: "proj-123",
			userId: "user-123",
			query: "product requirements",
		});

		expect(db.projectRepositoryIntegration.findMany).not.toHaveBeenCalled();
		expect(contexts[0].metadata?.roleTag).toBeUndefined();
	});

	it("prefers repositoryIntegrationId primary join key over repoKey fallback", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			{ contextId: "ctx-code-1", score: 0.96 },
		] as any);

		vi.mocked(db.projectRepositoryIntegration.findMany).mockResolvedValue([
			{
				id: "integ-primary",
				repositoryOwner: "example-org",
				repositoryName: "app-primary",
				roleTag: "PrimaryTagByIntegrationId",
			},
			{
				id: "integ-secondary",
				repositoryOwner: "example-org",
				repositoryName: "app-fallback",
				roleTag: "FallbackTagByRepoKey",
			},
		] as any);

		vi.mocked(getRetrievableContextById).mockResolvedValueOnce({
			id: "ctx-code-1",
			type: "CODE_FILE",
			content: "export const config = {};",
			originalFilename: "example-org/app-primary/config.ts",
			metadata: {
				repositoryIntegrationId: "integ-primary",
				repo: "example-org/app-fallback", // Points to a different repoKey to test precedence
			},
		} as any);

		const contexts = await retrieveProjectContexts({
			projectId: "proj-123",
			userId: "user-123",
			query: "configuration",
		});

		expect(contexts[0].metadata?.roleTag).toBe("PrimaryTagByIntegrationId");
	});
});
