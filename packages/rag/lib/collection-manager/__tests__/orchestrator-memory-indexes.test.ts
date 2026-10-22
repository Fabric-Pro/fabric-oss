import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCollections: vi.fn(),
	getCollection: vi.fn(),
	createCollection: vi.fn(),
	createPayloadIndex: vi.fn(),
	search: vi.fn(),
}));
vi.mock("../../vector-store/client", () => ({
	qdrantClient: mocks,
	DISTANCE_METRIC: "Cosine",
	VECTOR_SIZE: 1536,
}));
vi.mock("@repo/database", () => ({
	filterAccessibleMemoryScopes: vi.fn(async (rows) => rows),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { searchSimilarExecutions } from "../../vector-store/orchestrator-memory";
import { clearCollectionCache, getCollectionName } from "../index";

beforeEach(() => {
	vi.resetAllMocks();
	clearCollectionCache();
	mocks.getCollection.mockResolvedValue({
		config: { params: { vectors: { size: 1536 } } },
		payload_schema: {
			userId: {},
			organizationId: {},
			outcome: {},
			timestamp: {},
		},
	});
	mocks.search.mockResolvedValue([]);
	mocks.createPayloadIndex.mockResolvedValue({});
	mocks.createCollection.mockResolvedValue(true);
});

it.each([undefined, "example-org"])(
	"backfills an existing summary collection before search (%s), covering filter keys",
	async (organizationId) => {
		const collection = getCollectionName(
			"fabric_orchestrator_memory",
			organizationId,
		);
		mocks.getCollections.mockResolvedValue({
			collections: [{ name: collection }],
		});
		await searchSimilarExecutions({
			queryEmbedding: [0.1],
			userId: "example-user",
			organizationId,
			outcomeFilter: "success",
		});
		expect(mocks.createPayloadIndex).toHaveBeenCalledWith(collection, {
			field_name: "accessScopeVersion",
			field_schema: "integer",
		});
		expect(
			mocks.createPayloadIndex.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.search.mock.invocationCallOrder[0]);
		const indexedKeys = new Set([
			...Object.keys((await mocks.getCollection()).payload_schema),
			...mocks.createPayloadIndex.mock.calls.map(
				([, index]) => index.field_name,
			),
		]);
		for (const condition of mocks.search.mock.calls[0][1].filter.must) {
			expect(
				indexedKeys.has(condition.key ?? condition.is_empty.key),
			).toBe(true);
		}
	},
);

it.each([undefined, "example-new-org"])(
	"creates indexes covering the filter keys for a new collection (%s)",
	async (organizationId) => {
		const collection = getCollectionName(
			"fabric_orchestrator_memory",
			organizationId,
		);
		mocks.getCollections.mockResolvedValue({ collections: [] });
		await searchSimilarExecutions({
			queryEmbedding: [0.1],
			userId: "example-user",
			organizationId,
			outcomeFilter: "success",
		});
		expect(mocks.createPayloadIndex).toHaveBeenCalledWith(collection, {
			field_name: "accessScopeVersion",
			field_schema: "integer",
		});
		const indexedKeys = new Set(
			mocks.createPayloadIndex.mock.calls.map(
				([, index]) => index.field_name,
			),
		);
		for (const condition of mocks.search.mock.calls[0][1].filter.must) {
			expect(
				indexedKeys.has(condition.key ?? condition.is_empty.key),
			).toBe(true);
		}
		expect(
			mocks.createPayloadIndex.mock.invocationCallOrder.at(-1),
		).toBeLessThan(mocks.search.mock.invocationCallOrder[0]);
	},
);

it("finishes the index request before searching an existing collection", async () => {
	mocks.getCollections.mockResolvedValue({
		collections: [
			{ name: "fabric_orchestrator_memory-org-example-pending-org" },
		],
	});
	let finishIndex!: () => void;
	const indexPending = new Promise<void>((resolve) => {
		finishIndex = resolve;
	});
	mocks.createPayloadIndex.mockReturnValueOnce(indexPending);
	const recall = searchSimilarExecutions({
		queryEmbedding: [0.1],
		userId: "example-user",
		organizationId: "example-pending-org",
	});
	await vi.waitFor(() => expect(mocks.createPayloadIndex).toHaveBeenCalled());
	expect(mocks.search).not.toHaveBeenCalled();
	finishIndex();
	await recall;
	expect(mocks.search).toHaveBeenCalledTimes(1);
});
