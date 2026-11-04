import type { QdrantClient } from "@qdrant/js-client-rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSparseVector } from "../../lib/embedding/sparse";
import {
	backfillSparseVectors,
	parseBackfillArgs,
} from "../backfill-sparse-vectors";

const updateVectors = vi.fn<ReturnType<QdrantClient["api"]>["updateVectors"]>();
const client = {
	getCollections: vi.fn<QdrantClient["getCollections"]>(),
	getCollection: vi.fn<QdrantClient["getCollection"]>(),
	createVectorName: vi.fn<QdrantClient["createVectorName"]>(),
	scroll: vi.fn<QdrantClient["scroll"]>(),
	updateVectors,
	api: vi.fn(() => ({ updateVectors })),
};
const log = vi.fn();
// A client-boundary fake applying has_vector, limits and the exclusive next-page cursor.
let points: Array<{
	id: number;
	payload: { content?: unknown };
	sparse: boolean;
}>;
beforeEach(() => {
	vi.resetAllMocks();
	client.api.mockImplementation(() => ({ updateVectors }));
	points = [1, 2, 3, 4, 5].map((id) => ({
		id,
		payload: id === 2 ? {} : { content: `keyword ${id}` },
		sparse: id === 5,
	}));
	client.getCollections.mockResolvedValue({
		collections: [
			{ name: "project-contexts" },
			{ name: "project-contexts-org-example-org" },
			{ name: "chat-documents" },
			{ name: "project-contexts-backup" },
		],
	});
	client.getCollection.mockResolvedValue({
		config: { params: { sparse_vectors: { sparse: {} } } },
	} as unknown as Awaited<ReturnType<QdrantClient["getCollection"]>>);
	client.scroll.mockImplementation(async (_name, request) => {
		expect(request?.filter).toEqual({
			must_not: [{ has_vector: "sparse" }],
		});
		expect(request?.with_vector).toBe(false);
		const remaining = points.filter(
			(p) => !p.sparse && p.id >= Number(request?.offset ?? 0),
		);
		const page = remaining.slice(0, request?.limit ?? 100);
		return {
			points: page.map(({ id, payload }) => ({ id, payload })),
			next_page_offset:
				remaining.length > page.length
					? remaining[page.length]?.id
					: null,
		};
	});
	client.updateVectors.mockImplementation(async (request) => {
		for (const point of request.points) {
			const stored = points.find((p) => p.id === point.id);
			if (stored) {
				stored.sparse = true;
			}
		}
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers(),
			url: "http://localhost:6333",
			data: { result: { status: "completed", operation_id: 1 } },
		};
	});
});
describe("backfill", () => {
	it("dry run counts text and missing text without mutations", async () => {
		expect(
			await backfillSparseVectors(
				client,
				{ collection: "project-contexts", dryRun: true, batchSize: 2 },
				log,
			),
		).toEqual([
			{
				collection: "project-contexts",
				scanned: 4,
				updated: 3,
				skipped: 1,
			},
		]);
		expect(client.updateVectors).not.toHaveBeenCalled();
		expect(client.createVectorName).not.toHaveBeenCalled();
	});
	it("writes generated sparse vectors in bounded batches and advances past missing content", async () => {
		await backfillSparseVectors(
			client,
			{ collection: "project-contexts", dryRun: false, batchSize: 2 },
			log,
		);
		expect(client.updateVectors).toHaveBeenCalledTimes(2);
		const written = client.updateVectors.mock.calls.flatMap(([request]) => {
			expect(request.points.length).toBeLessThanOrEqual(2);
			expect(request.wait).toBe(true);
			expect(request.collection_name).toBe("project-contexts");
			expect(request.update_filter).toEqual({
				must_not: [{ has_vector: "sparse" }],
			});
			return request.points;
		});
		expect(written).toEqual(
			[1, 3, 4].map((id) => ({
				id,
				vector: { sparse: generateSparseVector(`keyword ${id}`) },
			})),
		);
		expect(client.scroll.mock.calls[1]?.[1]?.offset).toBe(3);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped=1"));
	});
	it("stops on error; a rerun excludes completed writes and finishes", async () => {
		client.updateVectors
			.mockImplementationOnce(async (request) => {
				for (const p of request.points) {
					const stored = points.find((point) => point.id === p.id);
					if (stored) {
						stored.sparse = true;
					}
				}
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: new Headers(),
					url: "http://localhost:6333",
					data: { result: { status: "completed", operation_id: 1 } },
				};
			})
			.mockRejectedValueOnce(new Error("Qdrant unavailable"));
		await expect(
			backfillSparseVectors(
				client,
				{ collection: "project-contexts", dryRun: false, batchSize: 2 },
				log,
			),
		).rejects.toThrow("Qdrant unavailable");
		expect(client.scroll).toHaveBeenCalledTimes(2);
		client.updateVectors.mockClear();
		const result = await backfillSparseVectors(
			client,
			{ collection: "project-contexts", dryRun: false, batchSize: 2 },
			log,
		);
		expect(result[0]).toMatchObject({ updated: 2, skipped: 1 });
		expect(
			client.updateVectors.mock.calls.flatMap(([r]) =>
				r.points.map((p) => p.id),
			),
		).toEqual([3, 4]);
	});
	it("selects only project-context collection names by default", async () => {
		const result = await backfillSparseVectors(
			client,
			{ dryRun: true, batchSize: 2 },
			log,
		);
		expect(result.map((r) => r.collection)).toEqual([
			"project-contexts",
			"project-contexts-org-example-org",
		]);
	});
	it("provisions the matching sparse schema only on a real run", async () => {
		client.getCollection.mockResolvedValue({
			config: { params: { sparse_vectors: null } },
		} as unknown as Awaited<ReturnType<QdrantClient["getCollection"]>>);
		await backfillSparseVectors(
			client,
			{ collection: "project-contexts", dryRun: true, batchSize: 2 },
			log,
		);
		expect(client.createVectorName).not.toHaveBeenCalled();
		await backfillSparseVectors(
			client,
			{ collection: "project-contexts", dryRun: false, batchSize: 2 },
			log,
		);
		expect(client.createVectorName).toHaveBeenCalledWith(
			"project-contexts",
			"sparse",
			{ sparse: {} },
		);
	});
	it.each(["0", "-1", "1.5", "NaN", "1001", "2junk"])(
		"rejects invalid batch size %s",
		(value) => {
			expect(() => parseBackfillArgs(["--batch-size", value])).toThrow(
				/batch size/,
			);
		},
	);
	it.each([
		["--collection"],
		["--collection", "chat-documents"],
		["--collection", "project-contexts-org-"],
		["--collection", "project-contexts-backup"],
		["--unexpected"],
	])("rejects invalid CLI args %j", (...args) => {
		expect(() => parseBackfillArgs(args)).toThrow();
	});
	it.each([undefined, null, 42, "", "   "])(
		"advances past non-text or blank content %s",
		async (content) => {
			points = [
				{ id: 1, payload: { content }, sparse: false },
				{ id: 2, payload: { content: "keyword" }, sparse: false },
			];
			const result = await backfillSparseVectors(
				client,
				{ collection: "project-contexts", dryRun: false, batchSize: 1 },
				log,
			);
			expect(result[0]).toMatchObject({ updated: 1, skipped: 1 });
			expect(client.scroll).toHaveBeenCalledTimes(2);
			expect(client.updateVectors.mock.calls[0]?.[0].points[0]?.id).toBe(
				2,
			);
		},
	);
	it.each([true, false])(
		"skips text with no keyword terms instead of sending an empty vector (dryRun=%s)",
		async (dryRun) => {
			const noTerms = "the and of ?! a .";
			// Guard the fixture: this text must really produce an empty sparse vector.
			expect(generateSparseVector(noTerms).indices).toHaveLength(0);
			points = [
				{ id: 1, payload: { content: noTerms }, sparse: false },
				{ id: 2, payload: { content: "keyword" }, sparse: false },
			];
			const result = await backfillSparseVectors(
				client,
				{ collection: "project-contexts", dryRun, batchSize: 2 },
				log,
			);
			expect(result[0]).toMatchObject({
				scanned: 2,
				updated: 1,
				skipped: 1,
			});
			const sent = client.updateVectors.mock.calls.flatMap(
				([r]) => r.points,
			);
			expect(sent.map((p) => p.id)).toEqual(dryRun ? [] : [2]);
		},
	);
	it("treats offset zero as a cursor, not end-of-scan", async () => {
		client.scroll
			.mockResolvedValueOnce({ points: [], next_page_offset: 0 })
			.mockResolvedValueOnce({ points: [], next_page_offset: null });
		await backfillSparseVectors(
			client,
			{ collection: "project-contexts", dryRun: true, batchSize: 2 },
			log,
		);
		expect(client.scroll.mock.calls[1]?.[1]?.offset).toBe(0);
	});
	it("stops on an unsupported scroll cursor", async () => {
		client.scroll.mockResolvedValueOnce({
			points: [],
			next_page_offset: {},
		});
		await expect(
			backfillSparseVectors(
				client,
				{ collection: "project-contexts", dryRun: true, batchSize: 2 },
				log,
			),
		).rejects.toThrow("unsupported scroll cursor");
	});
	it("parses supported options", () => {
		expect(
			parseBackfillArgs([
				"--dry-run",
				"--collection",
				"project-contexts",
				"--batch-size",
				"2",
			]),
		).toEqual({
			dryRun: true,
			collection: "project-contexts",
			batchSize: 2,
			help: false,
		});
	});
});

it("rejects invalid runner options before making a Qdrant call", async () => {
	client.getCollections.mockRejectedValue(
		new Error("unexpected Qdrant call"),
	);
	client.getCollection.mockRejectedValue(new Error("unexpected Qdrant call"));
	await expect(
		backfillSparseVectors(
			client,
			{ collection: "chat-documents", dryRun: true, batchSize: 2 },
			log,
		),
	).rejects.toThrow("Expected a project-context collection name");
	await expect(
		backfillSparseVectors(client, { dryRun: true, batchSize: 0 }, log),
	).rejects.toThrow("Invalid batch size");
	expect(client.getCollections).not.toHaveBeenCalled();
	expect(client.getCollection).not.toHaveBeenCalled();
});
it("accepts UUID scroll cursors", async () => {
	const cursor = "00000000-0000-0000-0000-000000000001";
	client.scroll
		.mockResolvedValueOnce({ points: [], next_page_offset: cursor })
		.mockResolvedValueOnce({ points: [], next_page_offset: null });
	await backfillSparseVectors(
		client,
		{ collection: "project-contexts", dryRun: true, batchSize: 2 },
		log,
	);
	expect(client.scroll.mock.calls[1]?.[1]?.offset).toBe(cursor);
});
