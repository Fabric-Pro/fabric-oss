/**
 * v1 workspaces.query — Phase 7b integration tests
 *
 * Exercises POST /workspaces/:id/query end-to-end via Hono's request()
 * with @repo/database, @repo/ai, @repo/rag, and the api-key auth
 * middleware mocked. Confirms tenant ACL via hasWorkspaceAccess,
 * embedding pipeline call shape, and limit clamping.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHasWorkspaceAccess = vi.fn();
const mockListWorkspaces = vi.fn();
const mockGetAIEmbeddingModel = vi.fn();
const mockEmbed = vi.fn();
const mockSearchWorkspaceChunks = vi.fn();
const mockGenerateSparseVector = vi.fn();

vi.mock("@repo/database", () => ({
	hasWorkspaceAccess: (...args: unknown[]) => mockHasWorkspaceAccess(...args),
	listWorkspaces: (...args: unknown[]) => mockListWorkspaces(...args),
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
		workspace: { findFirst: vi.fn() },
	},
}));

vi.mock("@repo/ai", () => ({
	getAIEmbeddingModel: (...args: unknown[]) =>
		mockGetAIEmbeddingModel(...args),
	embed: (...args: unknown[]) => mockEmbed(...args),
}));

vi.mock("@repo/rag", () => ({
	searchWorkspaceChunks: (...args: unknown[]) =>
		mockSearchWorkspaceChunks(...args),
	generateSparseVector: (...args: unknown[]) =>
		mockGenerateSparseVector(...args),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { registerWorkspaceRoutes } from "../workspaces";

function makeApp() {
	const app = new Hono<{
		Variables: {
			externalApiContext: {
				keyType: "personal" | "organization";
				keyId: string;
				keyPrefix: string;
				userId: string;
				organizationId: string | undefined;
				scopes: string[];
			};
		};
	}>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "personal",
			keyId: "key-1",
			keyPrefix: "fab_test",
			userId: "user-1",
			organizationId: undefined,
			scopes: ["workspaces:read"],
		});
		await next();
	});
	registerWorkspaceRoutes(app as never);
	return app;
}

const stubHits = [
	{
		chunkId: "chunk_1",
		documentId: "doc_1",
		workspaceId: "ws-1",
		filename: "auth.md",
		score: 0.92,
		chunkIndex: 3,
		pageNumber: 2,
		headings: ["Authentication"],
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	mockGetAIEmbeddingModel.mockResolvedValue({ id: "embed-model" });
	mockEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
	mockGenerateSparseVector.mockReturnValue({ indices: [], values: [] });
	mockSearchWorkspaceChunks.mockResolvedValue(stubHits);
});

describe("v1 workspaces.query", () => {
	it("400s when query is missing", async () => {
		mockHasWorkspaceAccess.mockResolvedValue(true);
		const res = await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(mockSearchWorkspaceChunks).not.toHaveBeenCalled();
	});

	it("400s on invalid JSON body", async () => {
		mockHasWorkspaceAccess.mockResolvedValue(true);
		const res = await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});

	it("404s when caller has no access to the workspace", async () => {
		mockHasWorkspaceAccess.mockResolvedValue(false);
		const res = await makeApp().request("/workspaces/ws-other/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(404);
		expect(mockEmbed).not.toHaveBeenCalled();
		expect(mockSearchWorkspaceChunks).not.toHaveBeenCalled();
	});

	it("happy path: embeds + searches and returns hit envelope", async () => {
		mockHasWorkspaceAccess.mockResolvedValue(true);
		const res = await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "OAuth flow" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: Array<{ chunkId: string; headings: string[] }>;
			meta: { total: number };
		};
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			chunkId: "chunk_1",
			documentId: "doc_1",
			filename: "auth.md",
			headings: ["Authentication"],
		});
		expect(body.meta.total).toBe(1);

		// Embedding pipeline invoked with tenant context
		expect(mockGetAIEmbeddingModel).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: undefined,
		});
		expect(mockEmbed).toHaveBeenCalledWith(
			expect.objectContaining({ value: "OAuth flow" }),
		);
		expect(mockGenerateSparseVector).toHaveBeenCalledWith("OAuth flow");

		// Search call sees the tenant + workspace filter
		expect(mockSearchWorkspaceChunks).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "ws-1",
				userId: "user-1",
				organizationId: undefined,
				minSimilarity: 0.4,
			}),
		);
	});

	it("clamps caller-supplied limit to [1, 50]", async () => {
		mockHasWorkspaceAccess.mockResolvedValue(true);

		await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "x", limit: 9999 }),
		});
		expect(mockSearchWorkspaceChunks).toHaveBeenLastCalledWith(
			expect.objectContaining({ topK: 50 }),
		);

		await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "x", limit: 0 }),
		});
		expect(mockSearchWorkspaceChunks).toHaveBeenLastCalledWith(
			expect.objectContaining({ topK: 1 }),
		);
	});

	it("forwards documentIds filter to searchWorkspaceChunks", async () => {
		mockHasWorkspaceAccess.mockResolvedValue(true);
		await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "x",
				documentIds: ["doc_a", "doc_b"],
			}),
		});
		expect(mockSearchWorkspaceChunks).toHaveBeenCalledWith(
			expect.objectContaining({ documentIds: ["doc_a", "doc_b"] }),
		);
	});

	it("returns 400 with RAG_PROVIDER_MISSING-equivalent on embed failure", async () => {
		mockHasWorkspaceAccess.mockResolvedValue(true);
		mockGetAIEmbeddingModel.mockRejectedValueOnce(
			new Error("no embedding provider"),
		);
		const res = await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("EMBEDDING_FAILED");
	});
});
