import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensureCollection: vi.fn(),
	getCollectionName: vi.fn(),
	collectionExistsUncached: vi.fn(),
	delete: vi.fn(),
	upsert: vi.fn(),
}));
vi.mock("../../collection-manager", () => ({
	ensureCollection: mocks.ensureCollection,
	getCollectionName: mocks.getCollectionName,
	collectionExistsUncached: mocks.collectionExistsUncached,
}));
vi.mock("../client", () => ({
	qdrantClient: { delete: mocks.delete, upsert: mocks.upsert },
}));
vi.mock("../../utils", () => ({
	generatePointId: (id: string) => `point-${id}`,
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import {
	deleteConversationEpisodes,
	deleteEpisodeEmbedding,
	storeEpisodeEmbedding,
} from "../episodic-memory-store";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getCollectionName.mockImplementation(
		(base: string, org?: string | null) =>
			org ? `${base}-org-${org}` : base,
	);
	mocks.ensureCollection.mockResolvedValue("example-written-collection");
	mocks.collectionExistsUncached.mockResolvedValue(true);
});
const deletionPaths = {
	episode: (org: string | null) =>
		deleteEpisodeEmbedding("episode-example", org),
	conversation: (org: string | null) =>
		deleteConversationEpisodes("conversation-example", org),
};
describe.each(Object.entries(deletionPaths))("%s deletion", (name, remove) => {
	it.each(["example-org", null])(
		"does not provision or delete a missing collection (%s)",
		async (org) => {
			mocks.collectionExistsUncached.mockResolvedValue(false);
			expect(await remove(org)).toBe(true);
			expect(mocks.getCollectionName).toHaveBeenCalledWith(
				"fabric_episodic_memory",
				org,
			);
			expect(mocks.collectionExistsUncached).toHaveBeenCalledWith(
				org
					? `fabric_episodic_memory-org-${org}`
					: "fabric_episodic_memory",
			);
			expect(mocks.delete).not.toHaveBeenCalled();
			expect(mocks.ensureCollection).not.toHaveBeenCalled();
		},
	);
	it("returns failure when checking existence throws", async () => {
		mocks.collectionExistsUncached.mockRejectedValue(
			new Error("Qdrant unavailable"),
		);
		expect(await remove("example-org")).toBe(false);
		expect(mocks.delete).not.toHaveBeenCalled();
		expect(mocks.ensureCollection).not.toHaveBeenCalled();
	});
	it("deletes from an existing collection without provisioning", async () => {
		expect(await remove("example-org")).toBe(true);
		expect(mocks.delete).toHaveBeenCalledWith(
			"fabric_episodic_memory-org-example-org",
			name === "episode"
				? {
						wait: true,
						points: ["point-episode-example"],
					}
				: {
						wait: true,
						filter: {
							must: [
								{
									key: "conversationId",
									match: { value: "conversation-example" },
								},
							],
						},
					},
		);
		expect(mocks.ensureCollection).not.toHaveBeenCalled();
	});
});
it("returns the actual collection alongside the stored point id", async () => {
	const result = await storeEpisodeEmbedding({
		episode: {
			id: "episode-example",
			conversationId: "conversation-example",
			title: "Example",
			summary: "Example summary",
			keyTopics: [],
			userIntents: [],
			outcome: "success",
			userId: "user-example-1",
			organizationId: "example-org",
			conversationEndedAt: "2026-10-22T00:00:00.000Z",
		},
		embedding: [0.1, 0.2],
	});
	expect(result).toEqual({
		success: true,
		pointId: "point-episode-example",
		collectionName: "example-written-collection",
	});
	expect(mocks.upsert).toHaveBeenCalledWith(
		result.collectionName,
		expect.objectContaining({
			points: [expect.objectContaining({ id: result.pointId })],
		}),
	);
});
