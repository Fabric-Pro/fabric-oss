import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock } = vi.hoisted(() => ({
	findManyMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findMany: findManyMock,
		},
	},
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(),
	generateEmbeddings: vi.fn(),
}));

vi.mock("../capability-embeddings", () => ({
	cosineSimilarity: vi.fn(),
}));

import { searchAvailableIntegrations } from "../search-integrations";

describe("searchAvailableIntegrations tenant scoping", () => {
	beforeEach(() => {
		findManyMock.mockReset();
		findManyMock.mockResolvedValue([]);
	});

	it("discovers all active org integrations without filtering by creator", async () => {
		await searchAvailableIntegrations({
			query: "search databricks",
			userId: "member-b",
			organizationId: "org-1",
		});

		expect(findManyMock).toHaveBeenCalledWith({
			where: {
				organizationId: "org-1",
				isActive: true,
			},
		});
	});

	it("discovers only the user's personal integrations outside org context", async () => {
		await searchAvailableIntegrations({
			query: "search databricks",
			userId: "member-b",
		});

		expect(findManyMock).toHaveBeenCalledWith({
			where: {
				userId: "member-b",
				organizationId: null,
				isActive: true,
			},
		});
	});
});
