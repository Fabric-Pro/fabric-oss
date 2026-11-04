import type { QdrantClient } from "@qdrant/js-client-rest";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	sourceName: null as string | null,
	targetName: null as string | null,
	targetHybrid: true,
	scroll: vi.fn<QdrantClient["scroll"]>(),
	upsert: vi.fn<QdrantClient["upsert"]>(),
	delete: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/vector-store/client", () => ({ qdrantClient: h }));
vi.mock("../../lib/collection-manager", () => ({
	ensureCollection: vi.fn(),
	getCollectionName: vi.fn(() => "project-contexts-org-example-org"),
	getCollectionLayout: vi.fn(async (_base, org) => ({
		supportsHybrid: org ? h.targetHybrid : true,
		denseVectorName: org ? h.targetName : h.sourceName,
		sparseVectorName: "sparse",
	})),
}));

import { generateSparseVector } from "../../lib/embedding/sparse";
import { migrateOrganizationData } from "../migrate-org-data";

beforeEach(() => {
	vi.clearAllMocks();
	h.targetHybrid = true;
});
it.each([
	[null, null],
	[null, "dense"],
	["dense", null],
	["dense", "dense"],
])("remaps source %s to destination %s", async (sourceName, targetName) => {
	h.sourceName = sourceName;
	h.targetName = targetName;
	h.scroll.mockResolvedValueOnce({
		points: [
			{
				id: 1,
				vector: sourceName ? { [sourceName]: [0.1, 0.2] } : [0.1, 0.2],
				payload: { content: "keyword" },
			},
		],
		next_page_offset: null,
	});
	const result = await migrateOrganizationData(
		"project-contexts",
		"example-org",
		{ dryRun: false },
	);
	expect(result.errors).toEqual([]);
	expect(
		(h.upsert.mock.calls[0]?.[1] as { points: Array<{ vector: unknown }> })
			?.points[0]?.vector,
	).toEqual({
		[targetName ?? ""]: [0.1, 0.2],
		sparse: generateSparseVector("keyword"),
	});
});
it("preserves existing sparse values", async () => {
	h.sourceName = null;
	h.targetName = "dense";
	const sparse = { indices: [42], values: [1] };
	h.scroll.mockResolvedValueOnce({
		points: [{ id: 1, vector: { "": [0.1, 0.2], sparse }, payload: {} }],
		next_page_offset: null,
	});
	await migrateOrganizationData("project-contexts", "example-org", {
		dryRun: false,
	});
	expect(
		(h.upsert.mock.calls[0]?.[1] as { points: Array<{ vector: unknown }> })
			?.points[0]?.vector,
	).toEqual({ dense: [0.1, 0.2], sparse });
});

it("refreshes the layout between migration pages", async () => {
	h.sourceName = null;
	h.targetName = null;
	h.targetHybrid = false;
	h.scroll.mockResolvedValueOnce({
		points: [{ id: 1, vector: [0.1], payload: { content: "keyword" } }],
		next_page_offset: 1,
	});
	h.scroll.mockImplementationOnce(async () => {
		h.targetHybrid = true;
		return {
			points: [{ id: 2, vector: [0.2], payload: { content: "keyword" } }],
			next_page_offset: null,
		};
	});
	const result = await migrateOrganizationData(
		"project-contexts",
		"example-org",
		{ dryRun: false },
	);
	expect(result.errors).toEqual([]);
	expect(
		(h.upsert.mock.calls[0]?.[1] as { points: Array<{ vector: unknown }> })
			.points[0].vector,
	).toEqual([0.1]);
	expect(
		(h.upsert.mock.calls[1]?.[1] as { points: Array<{ vector: unknown }> })
			.points[0].vector,
	).toEqual({
		"": [0.2],
		sparse: generateSparseVector("keyword"),
	});
});
