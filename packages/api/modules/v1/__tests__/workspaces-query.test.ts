/**
 * v1 workspaces.query — Phase 7b integration tests
 *
 * Exercises POST /workspaces/:id/query end-to-end via Hono's request()
 * with @repo/database, @repo/ai, @repo/rag, and the api-key auth
 * middleware mocked. Confirms tenant ACL via getWorkspaceAccessContext
 * plus the resolved-organization binding, embedding pipeline call shape,
 * and limit clamping.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetWorkspaceAccessContext = vi.fn();
const mockListWorkspaces = vi.fn();
const mockGetAIEmbeddingModel = vi.fn();
const mockEmbed = vi.fn();
const mockSearchWorkspaceChunks = vi.fn();
const mockGenerateSparseVector = vi.fn();

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	getWorkspaceAccessContext: (...args: unknown[]) =>
		mockGetWorkspaceAccessContext(...args),
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

import { db } from "@repo/database";
import { registerWorkspaceRoutes } from "../workspaces";

type TestApiContext = {
	keyType: "personal" | "organization";
	organizationId: string | undefined;
};

function makeApp(
	apiContext: TestApiContext = {
		keyType: "personal",
		organizationId: "org-test",
	},
) {
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
			keyType: apiContext.keyType,
			keyId: "key-1",
			keyPrefix: "fab_test",
			userId: "user-1",
			organizationId: apiContext.organizationId,
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
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-test",
		});
		const res = await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(mockSearchWorkspaceChunks).not.toHaveBeenCalled();
	});

	it("400s on invalid JSON body", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-test",
		});
		const res = await makeApp().request("/workspaces/ws-1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});

	it("404s when caller has no access to the workspace", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue(null);
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
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-test",
		});
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

		// Embedding pipeline invoked with tenant context. The organization is
		// the one the key resolves to: a personal key naming none used to run
		// with no tenant at all, and PO-9 retired that.
		expect(mockGetAIEmbeddingModel).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-test",
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
				organizationId: "org-test",
				minSimilarity: 0.4,
			}),
		);
	});

	it("clamps caller-supplied limit to [1, 50]", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-test",
		});

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
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-test",
		});
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
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-test",
		});
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

/**
 * The workspace must be in the organization this request resolved to
 * (Fizzy #2629). Workspace access answers only "can this user open it" and
 * takes no organization, so an ORGANIZATION key whose creator also holds a
 * role on another organization's workspace passed it. The binding matches
 * `GET /workspaces/:id`, whose lookup filters on the resolved organization.
 */
describe("v1 workspaces.query binds the workspace to the resolved organization", () => {
	const orgKeyInA: TestApiContext = {
		keyType: "organization",
		organizationId: "org-a",
	};

	function query(
		app: ReturnType<typeof makeApp>,
		path = "/workspaces/ws-1/query",
	) {
		return app.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "OAuth flow" }),
		});
	}

	it("404s an org key on another organization's workspace, before embedding or searching", async () => {
		// The key's creator is a member of org-b with a role on its workspace.
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-b",
		});

		const res = await query(makeApp(orgKeyInA));

		expect(res.status).toBe(404);
		expect(mockGetWorkspaceAccessContext).toHaveBeenCalledWith(
			"ws-1",
			"user-1",
		);
		expect(mockGetAIEmbeddingModel).not.toHaveBeenCalled();
		expect(mockEmbed).not.toHaveBeenCalled();
		expect(mockSearchWorkspaceChunks).not.toHaveBeenCalled();
	});

	it("answers that refusal exactly as it answers no access at all", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-b",
		});
		const crossTenant = await query(makeApp(orgKeyInA));

		mockGetWorkspaceAccessContext.mockResolvedValue(null);
		const noAccess = await query(makeApp(orgKeyInA));

		expect(crossTenant.status).toBe(noAccess.status);
		expect(await crossTenant.json()).toEqual(await noAccess.json());
	});

	it("lets an org key query a workspace in its own organization", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-a",
		});

		const res = await query(makeApp(orgKeyInA));

		expect(res.status).toBe(200);
		expect(mockSearchWorkspaceChunks).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "ws-1",
				organizationId: "org-a",
			}),
		);
	});

	it("404s an org key on a personal workspace", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: null,
		});

		const res = await query(makeApp(orgKeyInA));

		expect(res.status).toBe(404);
		expect(mockSearchWorkspaceChunks).not.toHaveBeenCalled();
	});

	it("404s a personal key whose resolved organization is not the workspace's", async () => {
		// No ?org=, so the key resolves to its owner's organization (org-test).
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-b",
		});

		const res = await query(makeApp());

		expect(res.status).toBe(404);
		expect(mockEmbed).not.toHaveBeenCalled();
		expect(mockSearchWorkspaceChunks).not.toHaveBeenCalled();
	});

	it("lets a personal key reach that workspace by naming its organization", async () => {
		vi.mocked(db.organization.findFirst).mockResolvedValueOnce({
			id: "org-b",
		} as never);
		vi.mocked(db.member.findFirst).mockResolvedValueOnce({
			id: "member-1",
		} as never);
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-b",
		});

		const res = await query(
			makeApp(),
			"/workspaces/ws-1/query?org=example-org-b",
		);

		expect(res.status).toBe(200);
		expect(mockSearchWorkspaceChunks).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "ws-1",
				organizationId: "org-b",
			}),
		);
	});
});
