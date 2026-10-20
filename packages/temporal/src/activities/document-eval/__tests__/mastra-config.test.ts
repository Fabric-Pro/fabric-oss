import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	findUnique: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { projectDocument: { findUnique: h.findUnique } },
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	getAIModelWithMetadata: h.getAIModelWithMetadata,
}));

import { resolveEvalModel } from "../mastra-config";

describe("resolveEvalModel", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});
	it("tags document quality scoring with its feature key", async () => {
		h.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: vi.fn(),
		});

		await resolveEvalModel({
			userId: "user-example-1",
			organizationId: "org-example-1",
		});

		expect(h.findUnique).not.toHaveBeenCalled();
		expect(h.getAIModelWithMetadata.mock.calls[0][1]).not.toHaveProperty(
			"projectId",
		);
		expect(h.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "EVAL" },
			{
				userId: "user-example-1",
				organizationId: "org-example-1",
				featureKey: "document-quality",
			},
		);
	});

	it("attributes scoring to the document's project", async () => {
		h.findUnique.mockResolvedValue({
			projectId: "project-example-1",
			project: { organizationId: "org-example-1" },
		});

		await resolveEvalModel({
			userId: "user-example-1",
			organizationId: "org-example-1",
			projectDocumentId: "document-example-1",
		});

		expect(h.findUnique).toHaveBeenCalledWith({
			where: { id: "document-example-1" },
			select: {
				projectId: true,
				project: { select: { organizationId: true } },
			},
		});
		expect(h.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "EVAL" },
			{
				userId: "user-example-1",
				organizationId: "org-example-1",
				featureKey: "document-quality",
				projectId: "project-example-1",
			},
		);
	});

	it("rejects a document from another organization before resolving a model", async () => {
		h.findUnique.mockResolvedValue({
			projectId: "project-example-2",
			project: { organizationId: "org-example-2" },
		});

		await expect(
			resolveEvalModel({
				userId: "user-example-1",
				organizationId: "org-example-1",
				projectDocumentId: "document-example-1",
			}),
		).rejects.toThrow(
			"Document project organization does not match evaluation organization",
		);
		expect(h.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("rejects a missing document before resolving a model", async () => {
		h.findUnique.mockResolvedValue(null);

		await expect(
			resolveEvalModel({
				userId: "user-example-1",
				organizationId: "org-example-1",
				projectDocumentId: "document-example-1",
			}),
		).rejects.toThrow("Document not found for evaluation model resolution");
		expect(h.getAIModelWithMetadata).not.toHaveBeenCalled();
	});
});
