import { OAUTH_APP_ROW_NAMES } from "@repo/database/prisma/queries/lib/oauth-app-row";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock } = vi.hoisted(() => ({
	findManyMock: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	workflowIntegrationAccessWhere: (
		await import(
			"@repo/database/prisma/queries/workflows/integration-access"
		)
	).workflowIntegrationAccessWhere,
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

	it("discovers owned or explicitly shared active org integrations", async () => {
		await searchAvailableIntegrations({
			query: "search databricks",
			userId: "member-b",
			organizationId: "org-1",
		});

		expect(findManyMock).toHaveBeenCalledWith({
			where: {
				organizationId: "org-1",
				OR: [
					{ userId: "member-b" },
					{
						usageScope: "ORGANIZATION_SHARED",
						NOT: { provider: { in: ["GITLAB"] } },
					},
				],
				isActive: true,
				NOT: { name: { in: OAUTH_APP_ROW_NAMES } },
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
				NOT: { name: { in: OAUTH_APP_ROW_NAMES } },
			},
		});
	});
});
