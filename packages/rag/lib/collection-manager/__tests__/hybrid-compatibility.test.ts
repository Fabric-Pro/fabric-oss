import type { QdrantClient } from "@qdrant/js-client-rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getCollections: vi.fn(),
	upsert: vi.fn<QdrantClient["upsert"]>(),
	getCollection: vi.fn(),
	createVectorName: vi.fn<QdrantClient["createVectorName"]>(),
	updateCollection: vi.fn(),
	createPayloadIndex: vi.fn(),
	warn: vi.fn(),
	info: vi.fn(),
}));
vi.mock("../../vector-store/client", () => ({
	qdrantClient: h,
	VECTOR_SIZE: 1536,
	DISTANCE_METRIC: "Cosine",
}));
vi.mock("@repo/logs", () => ({
	logger: { info: h.info, debug: vi.fn(), error: vi.fn(), warn: h.warn },
}));
vi.mock("../../project-contexts/client", () => ({ qdrantClient: h }));

const hybridInfo = {
	config: {
		params: { vectors: { size: 1536 }, sparse_vectors: { sparse: {} } },
	},
	payload_schema: {},
};

let getCollectionLayout: typeof import("../index").getCollectionLayout;

beforeEach(async () => {
	vi.resetAllMocks();
	vi.resetModules();
	({ getCollectionLayout } = await import("../index"));
	h.getCollections.mockResolvedValue({
		collections: [{ name: "project-contexts-org-example-org" }],
	});
	h.getCollection.mockResolvedValue({
		config: {
			params: {
				vectors: { size: 1536, distance: "Cosine" },
				sparse_vectors: null,
			},
		},
		payload_schema: {},
	});
	h.createPayloadIndex.mockResolvedValue(true);
	h.createVectorName.mockImplementation(async () => {
		h.getCollection.mockResolvedValue(hybridInfo);
		return { status: "completed", operation_id: 1 };
	});
});
describe("hybrid compatibility", () => {
	it("waits for project-context payload backfills before returning a layout", async () => {
		await getCollectionLayout("project-contexts", "example-org");
		for (const field_name of [
			"documentId",
			"repositoryIntegrationId",
			"parentContextId",
		]) {
			expect(h.createPayloadIndex).toHaveBeenCalledWith(
				"project-contexts-org-example-org",
				{
					field_name,
					field_schema: "keyword",
					wait: true,
				},
			);
		}
	});
	it("adds sparse in place without changing unnamed dense configuration", async () => {
		const layout = await getCollectionLayout(
			"project-contexts",
			"example-org",
		);
		expect(h.createVectorName).toHaveBeenCalledWith(
			"project-contexts-org-example-org",
			"sparse",
			{ sparse: {} },
		);
		expect(h.updateCollection).not.toHaveBeenCalled();
		expect(layout).toMatchObject({
			supportsHybrid: true,
			denseVectorName: null,
			sparseVectorName: "sparse",
		});
	});
	it("stays dense-only and warns once even when failed indexes prevent caching", async () => {
		h.createVectorName.mockRejectedValue(
			new Error("unsupported schema endpoint"),
		);
		h.createPayloadIndex.mockRejectedValue(new Error("index unavailable"));
		for (let i = 0; i < 3; i++) {
			expect(
				await getCollectionLayout("project-contexts", "example-org"),
			).toMatchObject({
				supportsHybrid: false,
				denseVectorName: null,
				sparseVectorName: null,
			});
		}
		const warnings = h.warn.mock.calls.filter(([message]) =>
			message.includes("Failed to enable sparse vectors"),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.[0]).toContain("unsupported schema endpoint");
	});
	it("preserves existing named dense and sparse", async () => {
		h.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: { dense: { size: 1536, distance: "Cosine" } },
					sparse_vectors: { sparse: {} },
				},
			},
		});
		expect(
			await getCollectionLayout("project-contexts", "example-org"),
		).toMatchObject({ supportsHybrid: true, denseVectorName: "dense" });
		expect(h.createVectorName).not.toHaveBeenCalled();
	});
});

it("warns independently for different collections", async () => {
	h.getCollections.mockResolvedValue({
		collections: [
			{ name: "project-contexts-org-example-org" },
			{ name: "project-contexts-org-example-other" },
		],
	});
	h.createVectorName.mockRejectedValue(
		new Error("unsupported schema endpoint"),
	);
	h.createPayloadIndex.mockRejectedValue(new Error("index unavailable"));
	for (const org of [
		"example-org",
		"example-other",
		"example-org",
		"example-other",
	]) {
		await getCollectionLayout("project-contexts", org);
	}
	expect(
		h.warn.mock.calls.filter(([message]) =>
			message.includes("Failed to enable sparse vectors"),
		),
	).toHaveLength(2);
});

it("shares an in-flight sparse attempt while each caller reads the schema", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.createVectorName.mockImplementation(async () => {
		await pending;
		h.getCollection.mockResolvedValue(hybridInfo);
		return { status: "completed", operation_id: 1 };
	});
	const first = getCollectionLayout("project-contexts", "example-org");
	await vi.waitFor(() => expect(h.createVectorName).toHaveBeenCalledTimes(1));
	const second = getCollectionLayout("project-contexts", "example-org");
	try {
		await vi.waitFor(() =>
			expect(h.getCollection).toHaveBeenCalledTimes(2),
		);
		expect(h.createVectorName).toHaveBeenCalledTimes(1);
	} finally {
		release();
	}
	const layouts = await Promise.all([first, second]);
	expect(layouts.map((layout) => layout.supportsHybrid)).toEqual([
		true,
		true,
	]);
	expect(
		(await getCollectionLayout("project-contexts", "example-org"))
			.supportsHybrid,
	).toBe(true);
	expect(h.createVectorName).toHaveBeenCalledTimes(1);
});
it("caches hybrid after a lost createVectorName response and successful schema re-read", async () => {
	h.createVectorName.mockRejectedValue(
		new Error("createVectorName response timed out"),
	);
	h.getCollection
		.mockResolvedValueOnce({
			config: {
				params: { vectors: { size: 1536 }, sparse_vectors: null },
			},
		})
		.mockResolvedValueOnce({
			config: {
				params: {
					vectors: { size: 1536 },
					sparse_vectors: { sparse: {} },
				},
			},
		});
	expect(
		await getCollectionLayout("project-contexts", "example-org"),
	).toMatchObject({ supportsHybrid: true, sparseVectorName: "sparse" });
	expect(h.getCollection).toHaveBeenCalledTimes(2);
	expect(h.warn).not.toHaveBeenCalled();
	await getCollectionLayout("project-contexts", "example-org");
	expect(h.getCollection).toHaveBeenCalledTimes(2);
	expect(h.createVectorName).toHaveBeenCalledTimes(1);
});
it("leaves a failed schema re-read uncached so the next request can recover", async () => {
	h.createVectorName.mockRejectedValue(new Error("create response lost"));
	h.getCollection
		.mockResolvedValueOnce({
			config: {
				params: { vectors: { size: 1536 }, sparse_vectors: null },
			},
		})
		.mockRejectedValueOnce(new Error("re-read unavailable"))
		.mockResolvedValue({
			config: {
				params: {
					vectors: { size: 1536 },
					sparse_vectors: { sparse: {} },
				},
			},
		});
	expect(
		(await getCollectionLayout("project-contexts", "example-org"))
			.supportsHybrid,
	).toBe(false);
	expect(
		(await getCollectionLayout("project-contexts", "example-org"))
			.supportsHybrid,
	).toBe(true);
});
it("does not mistake another sparse vector name for the configured sparse vector", async () => {
	h.createVectorName.mockRejectedValue(new Error("create rejected"));
	h.getCollection.mockResolvedValue({
		config: {
			params: { vectors: { size: 1536 }, sparse_vectors: { other: {} } },
		},
	});
	expect(
		(await getCollectionLayout("project-contexts", "example-org"))
			.supportsHybrid,
	).toBe(false);
	expect(h.createVectorName).toHaveBeenCalled();
});
it.each(["workspace-documents", "chat-documents", "company-contexts"] as const)(
	"does not add sparse in place to dense-only %s",
	async (base) => {
		h.getCollections.mockResolvedValue({
			collections: [{ name: `${base}-org-example-org` }],
		});
		expect(await getCollectionLayout(base, "example-org")).toMatchObject({
			supportsHybrid: false,
			denseVectorName: null,
		});
		await getCollectionLayout(base, "example-org");
		expect(h.getCollection).toHaveBeenCalledTimes(1);
		expect(h.createVectorName).not.toHaveBeenCalled();
	},
);
it.each(["workspace-documents", "chat-documents", "company-contexts"] as const)(
	"retains existing hybrid %s",
	async (base) => {
		h.getCollections.mockResolvedValue({
			collections: [{ name: `${base}-org-example-org` }],
		});
		h.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: { dense: { size: 1536 } },
					sparse_vectors: { sparse: {} },
				},
			},
		});
		expect(await getCollectionLayout(base, "example-org")).toMatchObject({
			supportsHybrid: true,
			denseVectorName: "dense",
		});
		expect(h.createVectorName).not.toHaveBeenCalled();
	},
);

it.each(["project-contexts", "chat-documents"] as const)(
	"releases a failed compatibility check so the next %s caller can retry",
	async (base) => {
		h.getCollections.mockResolvedValue({
			collections: [{ name: `${base}-org-example-org` }],
		});
		h.getCollection.mockRejectedValueOnce(
			new Error("collection read unavailable"),
		);
		await expect(getCollectionLayout(base, "example-org")).rejects.toThrow(
			"collection read unavailable",
		);
		h.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: { size: 1536 },
					sparse_vectors: { sparse: {} },
				},
			},
		});
		expect(
			(await getCollectionLayout(base, "example-org")).supportsHybrid,
		).toBe(true);
	},
);

const RETRY_INTERVAL_MS = 5 * 60 * 1000;
afterEach(() => vi.useRealTimers());

it("retries sparse enablement after five minutes and retains recovered hybrid", async () => {
	vi.useFakeTimers();
	h.createVectorName.mockRejectedValueOnce(new Error("503"));
	expect(
		(await getCollectionLayout("project-contexts", "example-org"))
			.supportsHybrid,
	).toBe(false);
	await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS - 1);
	await getCollectionLayout("project-contexts", "example-org");
	expect(h.createVectorName).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(
		(await getCollectionLayout("project-contexts", "example-org"))
			.supportsHybrid,
	).toBe(true);
	expect(h.createVectorName).toHaveBeenCalledTimes(2);
	const reads = h.getCollection.mock.calls.length;
	await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * 3);
	expect(
		(await getCollectionLayout("project-contexts", "example-org"))
			.supportsHybrid,
	).toBe(true);
	expect(h.getCollection).toHaveBeenCalledTimes(reads);
	expect(h.createVectorName).toHaveBeenCalledTimes(2);
	expect(
		h.info.mock.calls.filter(([message]) =>
			message.includes("Enabled sparse vectors"),
		),
	).toHaveLength(1);
});

it("reads the schema per throttled request, bounds failed attempts and warns once", async () => {
	vi.useFakeTimers();
	h.createVectorName.mockRejectedValue(new Error("unsupported"));
	await getCollectionLayout("project-contexts", "example-org");
	expect(h.getCollection).toHaveBeenCalledTimes(2);
	for (let attempt = 2; attempt <= 4; attempt++) {
		await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS - 1);
		expect(
			(await getCollectionLayout("project-contexts", "example-org"))
				.supportsHybrid,
		).toBe(false);
		expect(h.createVectorName).toHaveBeenCalledTimes(attempt - 1);
		expect(h.getCollection).toHaveBeenCalledTimes(3 * attempt - 3);
		await vi.advanceTimersByTimeAsync(1);
		expect(
			(await getCollectionLayout("project-contexts", "example-org"))
				.supportsHybrid,
		).toBe(false);
		expect(h.createVectorName).toHaveBeenCalledTimes(attempt);
		expect(h.getCollection).toHaveBeenCalledTimes(3 * attempt - 1);
	}
	expect(h.warn).toHaveBeenCalledTimes(1);
});

it("does not expire dense-only layouts without in-place sparse", async () => {
	vi.useFakeTimers();
	h.getCollections.mockResolvedValue({
		collections: [{ name: "chat-documents-org-example-org" }],
	});
	expect(
		(await getCollectionLayout("chat-documents", "example-org"))
			.supportsHybrid,
	).toBe(false);
	const reads = h.getCollection.mock.calls.length;
	await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * 10);
	expect(
		(await getCollectionLayout("chat-documents", "example-org"))
			.supportsHybrid,
	).toBe(false);
	expect(h.getCollection).toHaveBeenCalledTimes(reads);
	expect(h.createVectorName).not.toHaveBeenCalled();
});

it("shares one in-flight retry after the throttle interval", async () => {
	vi.useFakeTimers();
	h.createVectorName.mockRejectedValueOnce(new Error("503"));
	await getCollectionLayout("project-contexts", "example-org");
	await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.createVectorName.mockImplementation(async () => {
		await pending;
		h.getCollection.mockResolvedValue(hybridInfo);
		return { status: "completed", operation_id: 1 };
	});
	const callers = Array.from({ length: 5 }, () =>
		getCollectionLayout("project-contexts", "example-org"),
	);
	await vi.advanceTimersByTimeAsync(0);
	const attempts = h.createVectorName.mock.calls.length;
	const reads = h.getCollection.mock.calls.length;
	release();
	const layouts = await Promise.all(callers);
	expect(attempts).toBe(2);
	expect(reads).toBe(7);
	expect(layouts.every((layout) => layout.supportsHybrid)).toBe(true);
	expect(h.createVectorName).toHaveBeenCalledTimes(2);
});

it("refreshes a degraded layout before the next project-context upsert", async () => {
	h.createVectorName.mockRejectedValue(new Error("503"));
	const { storeProjectContext } = await import(
		"../../project-contexts/store"
	);
	const options = {
		contextId: "example-context",
		projectId: "example-project",
		userId: "example-user",
		organizationId: "example-org",
		content: "keyword example",
		embedding: [0.1, 0.2],
		sparseVector: { indices: [7], values: [1] },
	};
	expect(
		await getCollectionLayout("project-contexts", "example-org"),
	).toMatchObject({ supportsHybrid: false });
	await storeProjectContext(options);
	expect(h.upsert.mock.calls[0]?.[1]).toMatchObject({
		points: [{ vector: [0.1, 0.2] }],
	});
	const reads = h.getCollection.mock.calls.length;
	// A different replica or the backfill adds sparse inside the throttle window.
	h.getCollection.mockResolvedValue(hybridInfo);
	await storeProjectContext(options);
	expect(
		await getCollectionLayout("project-contexts", "example-org"),
	).toMatchObject({ supportsHybrid: true });
	expect(h.upsert.mock.calls[1]?.[1]).toMatchObject({
		points: [
			{
				vector: {
					"": [0.1, 0.2],
					sparse: { indices: [7], values: [1] },
				},
			},
		],
	});
	expect(h.getCollection).toHaveBeenCalledTimes(reads + 1);
	expect(h.createVectorName).toHaveBeenCalledTimes(1);
	expect(
		h.info.mock.calls.filter(([message]) =>
			message.includes("Enabled sparse vectors"),
		),
	).toHaveLength(1);
});

it("confirms sparse after a completed create before using a hybrid layout", async () => {
	h.createVectorName.mockResolvedValue({
		status: "completed",
		operation_id: 1,
	});
	expect(
		await getCollectionLayout("project-contexts", "example-org"),
	).toMatchObject({ supportsHybrid: false });
	expect(h.getCollection).toHaveBeenCalledTimes(2);
	expect(
		await getCollectionLayout("project-contexts", "example-org"),
	).toMatchObject({ supportsHybrid: false });
	expect(h.getCollection).toHaveBeenCalledTimes(3);
	expect(h.createVectorName).toHaveBeenCalledTimes(1);
});

it("keeps hybrid uncached until payload indexes are backfilled", async () => {
	h.getCollection.mockResolvedValue(hybridInfo);
	h.createPayloadIndex.mockRejectedValue(new Error("index unavailable"));
	await getCollectionLayout("project-contexts", "example-org");
	h.createPayloadIndex.mockResolvedValue(true);
	await getCollectionLayout("project-contexts", "example-org");
	expect(h.getCollection).toHaveBeenCalledTimes(2);
	await getCollectionLayout("project-contexts", "example-org");
	expect(h.getCollection).toHaveBeenCalledTimes(2);
});

it("logs recovery once when a schema observer overlaps an in-flight retry", async () => {
	vi.useFakeTimers();
	h.createVectorName.mockRejectedValueOnce(new Error("503"));
	await getCollectionLayout("project-contexts", "example-org");
	await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.createVectorName.mockImplementation(async () => {
		await pending;
		return { status: "completed", operation_id: 1 };
	});
	const retry = getCollectionLayout("project-contexts", "example-org");
	await vi.advanceTimersByTimeAsync(0);
	h.getCollection.mockResolvedValue(hybridInfo);
	try {
		expect(
			await getCollectionLayout("project-contexts", "example-org"),
		).toMatchObject({ supportsHybrid: true });
	} finally {
		release();
	}
	expect(await retry).toMatchObject({ supportsHybrid: true });
	expect(h.createVectorName).toHaveBeenCalledTimes(2);
	expect(
		h.info.mock.calls.filter(([message]) =>
			message.includes("Enabled sparse vectors"),
		),
	).toHaveLength(1);
});
