/**
 * v1 documents — Phase 8a integration tests
 *
 * Exercises the project-scoped documents routes via Hono request().
 * Confirms access gating (hasProjectAccess for reads, canEditProject
 * for writes), validation, and the underlying DB call shape.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListDocuments = vi.fn();
const mockGetDocumentById = vi.fn();
const mockCreateDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockHasProjectAccess = vi.fn();
const mockCanEditProject = vi.fn();

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	listDocuments: (...args: unknown[]) => mockListDocuments(...args),
	getDocumentById: (...args: unknown[]) => mockGetDocumentById(...args),
	createDocument: (...args: unknown[]) => mockCreateDocument(...args),
	updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	canEditProject: (...args: unknown[]) => mockCanEditProject(...args),
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { registerDocumentRoutes } from "../documents";

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
			scopes: ["documents:read", "documents:write"],
		});
		await next();
	});
	registerDocumentRoutes(app as never);
	return app;
}

function docRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc-1",
		projectId: "proj-1",
		type: "PRD" as const,
		title: "PRD",
		content: "# stub",
		status: "DRAFT" as const,
		version: 1,
		wordCount: 1,
		createdAt: new Date("2026-05-11T00:00:00.000Z"),
		updatedAt: new Date("2026-05-11T00:00:00.000Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("v1 documents — list/get", () => {
	it("GET /projects/:id/documents 404 when no project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const res = await makeApp().request("/projects/proj-x/documents");
		expect(res.status).toBe(404);
		expect(mockListDocuments).not.toHaveBeenCalled();
	});

	it("GET /projects/:id/documents lists with type filter", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockListDocuments.mockResolvedValue({
			documents: [docRow(), docRow({ id: "doc-2" })],
			total: 2,
			hasMore: false,
		});
		const res = await makeApp().request(
			"/projects/proj-1/documents?type=PRD&limit=5",
		);
		expect(res.status).toBe(200);
		expect(mockListDocuments).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				type: "PRD",
				limit: 5,
			}),
		);
		const body = (await res.json()) as {
			data: Array<{ id: string; content?: string }>;
		};
		expect(body.data).toHaveLength(2);
		// Summary shape — no content
		expect(body.data[0].content).toBeUndefined();
	});

	it("GET /projects/:id/documents 400 on invalid type filter", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		const res = await makeApp().request(
			"/projects/proj-1/documents?type=NOTATHING",
		);
		expect(res.status).toBe(400);
	});

	it("GET /documents/:id returns full content", async () => {
		mockGetDocumentById.mockResolvedValue(docRow({ content: "# Real" }));
		mockHasProjectAccess.mockResolvedValue(true);
		const res = await makeApp().request("/documents/doc-1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { content: string } };
		expect(body.data.content).toBe("# Real");
	});

	it("GET /documents/:id 404 when document doesn't exist", async () => {
		mockGetDocumentById.mockResolvedValue(null);
		const res = await makeApp().request("/documents/missing");
		expect(res.status).toBe(404);
	});

	it("GET /documents/:id 404 when caller has no project access (cross-tenant)", async () => {
		mockGetDocumentById.mockResolvedValue(docRow());
		mockHasProjectAccess.mockResolvedValue(false);
		const res = await makeApp().request("/documents/doc-1");
		expect(res.status).toBe(404);
	});
});

describe("v1 documents — create", () => {
	beforeEach(() => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockCanEditProject.mockResolvedValue(true);
		mockCreateDocument.mockResolvedValue(docRow());
	});

	it("happy path creates and returns 201", async () => {
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "TECHNICAL_SPEC",
				title: "Spec",
				content: "# spec",
			}),
		});
		expect(res.status).toBe(201);
		expect(mockCreateDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				type: "TECHNICAL_SPEC",
				title: "Spec",
				content: "# spec",
				status: "DRAFT",
				userId: "user-1",
			}),
		);
	});

	it("404 when caller has no project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const res = await makeApp().request("/projects/proj-x/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "PRD",
				title: "x",
				content: "x",
			}),
		});
		expect(res.status).toBe(404);
		expect(mockCreateDocument).not.toHaveBeenCalled();
	});

	it("403 when read access but no edit permission", async () => {
		mockCanEditProject.mockResolvedValue(false);
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "PRD",
				title: "x",
				content: "x",
			}),
		});
		expect(res.status).toBe(403);
		expect(mockCreateDocument).not.toHaveBeenCalled();
	});

	it("400 on missing required fields", async () => {
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "PRD", title: "no content" }),
		});
		expect(res.status).toBe(400);
	});

	it("400 on invalid type enum", async () => {
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "NOT_A_TYPE",
				title: "x",
				content: "x",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 on empty title", async () => {
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "PRD",
				title: "   ",
				content: "x",
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe("v1 documents — update", () => {
	beforeEach(() => {
		mockGetDocumentById.mockResolvedValue(docRow());
		mockHasProjectAccess.mockResolvedValue(true);
		mockCanEditProject.mockResolvedValue(true);
		mockUpdateDocument.mockResolvedValue(docRow({ title: "Renamed" }));
	});

	it("happy path updates title + status", async () => {
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Renamed", status: "COMPLETE" }),
		});
		expect(res.status).toBe(200);
		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({
				title: "Renamed",
				status: "COMPLETE",
				userId: "user-1",
			}),
		);
	});

	it("404 when document missing", async () => {
		mockGetDocumentById.mockResolvedValue(null);
		const res = await makeApp().request("/documents/missing", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x" }),
		});
		expect(res.status).toBe(404);
	});

	it("404 when caller has no project access (cross-tenant)", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x" }),
		});
		expect(res.status).toBe(404);
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	it("403 when read access but no edit permission", async () => {
		mockCanEditProject.mockResolvedValue(false);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x" }),
		});
		expect(res.status).toBe(403);
	});

	it("400 when no recognized fields", async () => {
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("400 on invalid status enum", async () => {
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "NOTASTATUS" }),
		});
		expect(res.status).toBe(400);
	});
});
