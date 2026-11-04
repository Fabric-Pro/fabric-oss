import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	layout: {
		supportsHybrid: true,
		denseVectorName: null as string | null,
		sparseVectorName: "sparse",
	},
	upsert: vi.fn<QdrantClient["upsert"]>(),
}));
vi.mock("../lib/job-progress", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	jobStep: vi.fn(),
	jobIncrement: vi.fn(),
	jobHeartbeat: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	findProjectCodeIndexId: vi.fn(async () => null),
	upsertProjectCodeFile: vi.fn(),
	stampContextsEmbedded: vi.fn(),
}));
vi.mock("@repo/ai", () => ({ getSystemEmbeddingRAGProviderConfig: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
	heartbeat: vi.fn(),
}));
vi.mock("@repo/rag/lib/embedding", () => ({
	boundQueryForEmbedding: vi.fn((text: string) => text),
	generateEmbeddings: vi.fn(async (texts: string[]) => ({
		embeddings: texts.map(() => [0.1, 0.2]),
	})),
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	getCollectionLayout: vi.fn(async () => h.layout),
	getCollectionName: vi.fn(() => "project-contexts"),
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: { upsert: h.upsert },
}));
vi.mock("@repo/rag/lib/utils", () => ({
	generatePointId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
}));
vi.mock("@repo/rag", () => ({
	boundQueryForEmbedding: vi.fn((text: string) => text),
	ensureCollection: vi.fn(async () => "project-contexts"),
	generateEmbeddings: vi.fn(),
	generatePointId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
	qdrantClient: { upsert: h.upsert },
}));

import { generateSparseVector } from "@repo/rag/lib/embedding/sparse";
import {
	chunkAndEmbedBatchActivity,
	generateFileSummariesActivity,
} from "../code-indexing";
import { storeContextsInQdrant } from "../project-context-embedding";

let dir: string;
beforeEach(() => {
	vi.clearAllMocks();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "qdrant-hybrid-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});
describe.each([
	{ supportsHybrid: true, denseVectorName: null },
	{ supportsHybrid: true, denseVectorName: "dense" },
	{ supportsHybrid: false, denseVectorName: null },
])("Qdrant writes %j", (layout) => {
	it("uses the collection layout for chunks, summaries and context batches", async () => {
		Object.assign(h.layout, layout);
		const absolutePath = path.join(dir, "example.md");
		fs.writeFileSync(
			absolutePath,
			"# Example\nA keyword example with enough content to index.",
		);
		const input = {
			projectId: "example-project",
			userId: "example-user",
			organizationId: "example-org",
			repoName: "example-org/example-repo",
			files: [
				{
					relativePath: "example.md",
					absolutePath,
					language: "markdown",
				},
			],
		};
		await chunkAndEmbedBatchActivity(input);
		await generateFileSummariesActivity(input);
		await storeContextsInQdrant({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			contexts: [
				{
					id: "example-context",
					type: "DOCUMENT",
					content: "keyword example",
				},
			],
			embeddings: [[0.1, 0.2]],
		});
		expect(h.upsert).toHaveBeenCalledTimes(3);
		for (const [, request] of h.upsert.mock.calls) {
			expect("points" in request).toBe(true);
			if (!("points" in request)) {
				throw new Error("expected points request");
			}
			for (const point of request.points) {
				expect(point.vector).toEqual(
					layout.supportsHybrid
						? {
								[layout.denseVectorName ?? ""]: [0.1, 0.2],
								sparse: generateSparseVector(
									String(point.payload?.content),
								),
							}
						: [0.1, 0.2],
				);
			}
		}
	});
});

it("reads the chunk layout after embedding instead of holding a dense-only answer", async () => {
	h.layout = {
		supportsHybrid: false,
		denseVectorName: null,
		sparseVectorName: "sparse",
	};
	const { generateEmbeddings } = await import("@repo/rag/lib/embedding");
	vi.mocked(generateEmbeddings).mockImplementationOnce(async (texts) => {
		h.layout = { ...h.layout, supportsHybrid: true };
		return { embeddings: texts.map(() => [0.1, 0.2]) } as Awaited<
			ReturnType<typeof generateEmbeddings>
		>;
	});
	const absolutePath = path.join(dir, "example.md");
	fs.writeFileSync(
		absolutePath,
		"# Example\nA keyword example with enough content to index.",
	);
	await chunkAndEmbedBatchActivity({
		projectId: "example-project",
		userId: "example-user",
		organizationId: "example-org",
		repoName: "example-org/example-repo",
		files: [{ relativePath: "example.md", absolutePath }],
	});
	const request = h.upsert.mock.calls[0]?.[1];
	expect(
		request && "points" in request && request.points[0].vector,
	).toHaveProperty("sparse");
});
