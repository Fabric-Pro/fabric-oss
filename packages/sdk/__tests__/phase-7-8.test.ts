/**
 * Phase 7 + 8 SDK unit tests
 *
 * Covers the SDK methods landed in:
 *   - 7a: ChatsResource.create / rename / update / delete / sendMessage
 *   - 7b: WorkspacesResource.query
 *   - 8 : ProjectsResource.{listDocuments, getDocument, createDocument, updateDocument}
 *   - 8 : WorkflowsResource.{listExecutions, cancelExecution}
 *
 * These are shape tests: the SDK is checked for "does it issue the right
 * HTTP request given these inputs?" by stubbing `fetch`. They do NOT
 * exercise the server side — that's covered by the v1 route integration
 * tests in @repo/api.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFabric, type FabricClient } from "../src/index.js";

interface CapturedRequest {
	url: string;
	method: string;
	body: unknown;
	headers: Record<string, string>;
}

function buildClient({
	responseBody = {},
	status = 200,
}: {
	responseBody?: unknown;
	status?: number;
} = {}): { client: FabricClient; captured: CapturedRequest[] } {
	const captured: CapturedRequest[] = [];
	const stub: typeof fetch = async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const headers: Record<string, string> = {};
		if (init?.headers) {
			const h = new Headers(init.headers);
			h.forEach((v, k) => {
				headers[k] = v;
			});
		}
		captured.push({
			url,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(init.body as string) : null,
			headers,
		});
		return new Response(JSON.stringify({ data: responseBody }), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};

	const client = createFabric({
		apiKey: "fab_test_key",
		baseUrl: "https://test.fabric",
		fetch: stub,
		retry: { maxRetries: 0 },
	});
	return { client, captured };
}

function lastRequest(captured: CapturedRequest[]): CapturedRequest {
	const r = captured[captured.length - 1];
	if (!r) {
		throw new Error("No captured request");
	}
	return r;
}

// ---------------------------------------------------------------------------
// Phase 7a — Chats write surface
// ---------------------------------------------------------------------------
describe("Phase 7a — chats write surface", () => {
	let client: FabricClient;
	let captured: CapturedRequest[];

	beforeEach(() => {
		({ client, captured } = buildClient({
			responseBody: {
				id: "chat_1",
				title: null,
				userId: "user_1",
				organizationId: null,
				createdAt: "2026-05-11T00:00:00.000Z",
				updatedAt: "2026-05-11T00:00:00.000Z",
				deleted: true,
				chatId: "chat_1",
				assistantMessage: {
					id: "msg_assistant",
					role: "assistant",
					content: "hello back",
				},
			},
		}));
	});

	it("chats.create posts to /chats with body fields", async () => {
		await client.chats.create({ title: "Plan", projectId: "proj_1" });
		const req = lastRequest(captured);
		expect(req.method).toBe("POST");
		expect(req.url).toBe("https://test.fabric/api/v1/chats");
		expect(req.body).toEqual({ title: "Plan", projectId: "proj_1" });
	});

	it("chats.create passes org/personal via query, not body", async () => {
		await client.chats.create({ title: "Org", org: "acme" });
		const req = lastRequest(captured);
		expect(req.url).toContain("?org=acme");
		expect(req.body).toEqual({ title: "Org" });
	});

	it("chats.rename patches with { title }", async () => {
		await client.chats.rename("chat_1", "Renamed");
		const req = lastRequest(captured);
		expect(req.method).toBe("PATCH");
		expect(req.url).toBe("https://test.fabric/api/v1/chats/chat_1");
		expect(req.body).toEqual({ title: "Renamed" });
	});

	it("chats.rename(null) sends title:null to clear", async () => {
		await client.chats.rename("chat_2", null);
		expect(lastRequest(captured).body).toEqual({ title: null });
	});

	it("chats.update accepts partial updates", async () => {
		await client.chats.update("chat_3", { title: "Updated" });
		const req = lastRequest(captured);
		expect(req.method).toBe("PATCH");
		expect(req.body).toEqual({ title: "Updated" });
	});

	it("chats.delete returns { id, deleted } envelope", async () => {
		const result = await client.chats.delete("chat_4");
		const req = lastRequest(captured);
		expect(req.method).toBe("DELETE");
		expect(req.url).toBe("https://test.fabric/api/v1/chats/chat_4");
		expect(result.deleted).toBe(true);
	});

	it("chats.sendMessage posts content and returns assistant message", async () => {
		const result = await client.chats.sendMessage("chat_5", {
			content: "hi",
		});
		const req = lastRequest(captured);
		expect(req.method).toBe("POST");
		expect(req.url).toBe(
			"https://test.fabric/api/v1/chats/chat_5/messages",
		);
		expect(req.body).toEqual({ content: "hi" });
		expect(result.assistantMessage.role).toBe("assistant");
		expect(result.assistantMessage.content).toBe("hello back");
	});

	it("chats.sendMessage threads org into query string", async () => {
		await client.chats.sendMessage("chat_6", {
			content: "x",
			org: "acme",
		});
		const req = lastRequest(captured);
		expect(req.url).toContain("?org=acme");
		expect(req.body).toEqual({ content: "x" });
	});

	it("withOrg() bound clone injects ?org= on new chats", async () => {
		await client.withOrg("acme").chats.create({ title: "Bound" });
		expect(lastRequest(captured).url).toContain("?org=acme");
	});

	it("withPersonal() bound clone injects ?personal=1", async () => {
		await client.withPersonal().chats.create({ title: "Personal" });
		expect(lastRequest(captured).url).toContain("personal=1");
	});
});

// ---------------------------------------------------------------------------
// Phase 7b — workspaces.query
// ---------------------------------------------------------------------------
describe("Phase 7b — workspaces.query", () => {
	let client: FabricClient;
	let captured: CapturedRequest[];

	beforeEach(() => {
		({ client, captured } = buildClient({
			responseBody: [
				{
					chunkId: "chunk_1",
					documentId: "doc_1",
					filename: "auth.md",
					score: 0.92,
					chunkIndex: 3,
					pageNumber: 2,
					headings: ["Authentication", "OAuth"],
				},
			],
		}));
	});

	it("posts to /workspaces/:id/query with body", async () => {
		const hits = await client.workspaces.query("ws_1", {
			query: "OAuth flow",
		});
		const req = lastRequest(captured);
		expect(req.method).toBe("POST");
		expect(req.url).toBe(
			"https://test.fabric/api/v1/workspaces/ws_1/query",
		);
		expect(req.body).toEqual({ query: "OAuth flow" });
		expect(hits).toHaveLength(1);
		expect(hits[0].headings).toEqual(["Authentication", "OAuth"]);
	});

	it("forwards limit and documentIds in body", async () => {
		await client.workspaces.query("ws_1", {
			query: "rate limits",
			limit: 25,
			documentIds: ["doc_a", "doc_b"],
		});
		const req = lastRequest(captured);
		expect(req.body).toEqual({
			query: "rate limits",
			limit: 25,
			documentIds: ["doc_a", "doc_b"],
		});
	});

	it("threads org via query string, not body", async () => {
		await client.workspaces.query("ws_1", {
			query: "x",
			org: "acme",
		});
		const req = lastRequest(captured);
		expect(req.url).toContain("?org=acme");
		expect(req.body).toEqual({ query: "x" });
	});

	it("withPersonal() bound clone injects ?personal=1", async () => {
		await client
			.withPersonal()
			.workspaces.query("ws_1", { query: "personal" });
		expect(lastRequest(captured).url).toContain("personal=1");
	});
});

// ---------------------------------------------------------------------------
// Phase 8 — Documents
// ---------------------------------------------------------------------------
describe("Phase 8 — projects.*Document methods", () => {
	let client: FabricClient;
	let captured: CapturedRequest[];

	beforeEach(() => {
		({ client, captured } = buildClient({
			responseBody: {
				id: "doc_1",
				projectId: "proj_1",
				type: "PRD",
				title: "Stub",
				content: "# stub",
				status: "DRAFT",
				version: 1,
				wordCount: 1,
				createdAt: "2026-05-11T00:00:00.000Z",
				updatedAt: "2026-05-11T00:00:00.000Z",
			},
		}));
	});

	it("listDocuments → GET /projects/:id/documents with type filter", async () => {
		await client.projects.listDocuments("proj_1", { type: "PRD" });
		const req = lastRequest(captured);
		expect(req.method).toBe("GET");
		expect(req.url).toContain("/projects/proj_1/documents");
		expect(req.url).toContain("type=PRD");
	});

	it("getDocument → GET /documents/:id (flat, not nested)", async () => {
		await client.projects.getDocument("doc_xyz");
		const req = lastRequest(captured);
		expect(req.method).toBe("GET");
		expect(req.url).toBe("https://test.fabric/api/v1/documents/doc_xyz");
	});

	it("createDocument → POST /projects/:id/documents with body", async () => {
		await client.projects.createDocument("proj_1", {
			type: "TECHNICAL_SPEC",
			title: "Spec",
			content: "# Spec",
		});
		const req = lastRequest(captured);
		expect(req.method).toBe("POST");
		expect(req.url).toBe(
			"https://test.fabric/api/v1/projects/proj_1/documents",
		);
		expect(req.body).toEqual({
			type: "TECHNICAL_SPEC",
			title: "Spec",
			content: "# Spec",
		});
	});

	it("createDocument forwards optional status", async () => {
		await client.projects.createDocument("proj_1", {
			type: "PRD",
			title: "t",
			content: "x",
			status: "REVIEW",
		});
		expect(lastRequest(captured).body).toMatchObject({ status: "REVIEW" });
	});

	it("updateDocument → PATCH /documents/:id with partial body", async () => {
		await client.projects.updateDocument("doc_1", {
			title: "Renamed",
			status: "COMPLETE",
		});
		const req = lastRequest(captured);
		expect(req.method).toBe("PATCH");
		expect(req.url).toBe("https://test.fabric/api/v1/documents/doc_1");
		expect(req.body).toEqual({ title: "Renamed", status: "COMPLETE" });
	});

	it("withOrg() bound clone injects ?org= on document list", async () => {
		await client.withOrg("acme").projects.listDocuments("proj_1");
		expect(lastRequest(captured).url).toContain("?org=acme");
	});
});

// ---------------------------------------------------------------------------
// Phase 8 — Workflow executions
// ---------------------------------------------------------------------------
describe("Phase 8 — workflows.*Execution methods", () => {
	let client: FabricClient;
	let captured: CapturedRequest[];

	beforeEach(() => {
		({ client, captured } = buildClient({
			responseBody: [
				{
					id: "exec_1",
					workflowId: "wf_1",
					status: "RUNNING",
					triggerType: "MANUAL",
					startedAt: "2026-05-11T00:00:00.000Z",
				},
			],
		}));
	});

	it("listExecutions → GET /workflows/:id/executions", async () => {
		await client.workflows.listExecutions("wf_1");
		const req = lastRequest(captured);
		expect(req.method).toBe("GET");
		expect(req.url).toBe(
			"https://test.fabric/api/v1/workflows/wf_1/executions",
		);
	});

	it("listExecutions forwards status + pagination as query string", async () => {
		await client.workflows.listExecutions("wf_1", {
			status: "RUNNING",
			limit: 50,
			offset: 10,
		});
		const req = lastRequest(captured);
		expect(req.url).toContain("status=RUNNING");
		expect(req.url).toContain("limit=50");
		expect(req.url).toContain("offset=10");
	});

	it("cancelExecution → POST /workflows/:id/executions/:execId/cancel", async () => {
		await client.workflows.cancelExecution("wf_1", "exec_42");
		const req = lastRequest(captured);
		expect(req.method).toBe("POST");
		expect(req.url).toBe(
			"https://test.fabric/api/v1/workflows/wf_1/executions/exec_42/cancel",
		);
	});

	it("cancelExecution threads org via query string", async () => {
		await client.workflows.cancelExecution("wf_1", "exec_43", {
			org: "acme",
		});
		expect(lastRequest(captured).url).toContain("?org=acme");
	});

	it("withPersonal() bound clone injects ?personal=1 on listExecutions", async () => {
		await client.withPersonal().workflows.listExecutions("wf_1");
		expect(lastRequest(captured).url).toContain("personal=1");
	});
});

// ---------------------------------------------------------------------------
// Cross-cutting: auth + error envelope
// ---------------------------------------------------------------------------
describe("HTTP envelope", () => {
	it("adds Bearer token + Idempotency-Key on mutating requests", async () => {
		const { client, captured } = buildClient();
		await client.chats.create({ title: "x" });
		const req = lastRequest(captured);
		expect(req.headers.authorization).toBe("Bearer fab_test_key");
		expect(req.headers["idempotency-key"]).toBeDefined();
		expect(req.headers["idempotency-key"]).not.toBe("");
	});

	let _afterClient: FabricClient | undefined;
	afterEach(() => {
		_afterClient = undefined;
	});

	it("throws FabricNotFoundError on 404", async () => {
		const captured: CapturedRequest[] = [];
		const stub: typeof fetch = async (input, init) => {
			const url =
				typeof input === "string" ? input : (input as Request).url;
			captured.push({
				url,
				method: init?.method ?? "GET",
				body: null,
				headers: {},
			});
			return new Response(
				JSON.stringify({ error: { message: "Chat not found" } }),
				{
					status: 404,
					headers: { "Content-Type": "application/json" },
				},
			);
		};
		const c = createFabric({
			apiKey: "fab_test_key",
			baseUrl: "https://test.fabric",
			fetch: stub,
			retry: { maxRetries: 0 },
		});
		await expect(c.chats.delete("missing")).rejects.toMatchObject({
			status: 404,
		});
	});
});
