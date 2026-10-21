/**
 * Embeddings the tool index makes, to search or to re-index the catalogue,
 * are tagged `tool-search` on their AI Usage rows. Without it the catalogue's
 * re-index landed as an untagged embedding row with no conversation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: { mCPConfig: { findMany: async () => [] } },
}));

const embeddings = vi.hoisted(() => ({
	generateEmbedding: vi.fn(),
	generateEmbeddings: vi.fn(),
}));
vi.mock("@repo/rag/lib/embedding/generator", () => embeddings);

vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	isCapabilityStoreAvailable: vi.fn(async () => true),
	searchCapabilities: vi.fn(async () => []),
	getCapabilitiesByTenant: vi.fn(async () => []),
	upsertCapabilities: vi.fn(),
	deleteCapabilitiesByServer: vi.fn(),
}));

import { ToolIndex } from "../tool-index";
import { toolSearchUsage } from "../tool-search-usage";

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	embeddings.generateEmbedding.mockReset();
	embeddings.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
});

describe("tool search embedding usage", () => {
	it("tags a Qdrant search's query embedding, keeping the conversation", async () => {
		await new ToolIndex().search(
			{
				query: "list issues",
				userId: "user-1",
				organizationId: "example-org",
				minConfidence: 0,
			},
			{
				userId: "user-1",
				organizationId: "example-org",
				conversationId: "conversation-1",
			},
		);

		expect(embeddings.generateEmbedding).toHaveBeenCalledWith(
			"list issues",
			expect.objectContaining({
				featureKey: "tool-search",
				conversationId: "conversation-1",
			}),
		);
	});

	it("keeps a feature the caller already named", () => {
		expect(
			toolSearchUsage({ userId: "user-1", featureKey: "workflow" }),
		).toEqual({ userId: "user-1", featureKey: "workflow" });
	});
});
