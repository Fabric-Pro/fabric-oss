import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ownerPermissionAllowed: false,
	findChat: vi.fn(),
	findProject: vi.fn(),
	hasProjectAccess: vi.fn(),
	getEmbeddingConfig: vi.fn(),
	retrieveContext: vi.fn(),
	retrieveProjectContext: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getEmbeddingRAGProviderConfig: mocks.getEmbeddingConfig,
}));

vi.mock("@repo/database", () => ({
	db: {
		aiChat: { findFirst: mocks.findChat },
		project: { findFirst: mocks.findProject },
	},
	hasProjectAccess: mocks.hasProjectAccess,
}));

vi.mock("@repo/rag", () => ({
	retrieveContext: mocks.retrieveContext,
	retrieveRelevantContextsForSpec: mocks.retrieveProjectContext,
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		() => async (_context: unknown, next: () => Promise<unknown>) =>
			next(),
	requireV1OwnerPermission: async (
		c: { json: (body: unknown, status: number) => unknown },
		_context: unknown,
		action: string,
	) => {
		if (action !== "knowledge:chat-search") {
			throw new Error(
				`Unexpected knowledge permission action: ${action}`,
			);
		}
		return mocks.ownerPermissionAllowed
			? null
			: c.json(
					{
						error: "The key's owner no longer holds the access required for knowledge:read in this organization",
					},
					403,
				);
	},
}));

vi.mock("../helpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../helpers")>();
	return {
		...actual,
		resolveV1Context: vi.fn().mockResolvedValue({
			userId: "user-1",
			organizationId: "org-1",
		}),
	};
});

import { registerKnowledgeRoutes } from "../knowledge";

function makeApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			userId: "user-1",
			keyType: "personal",
			scopes: ["*"],
		});
		await next();
	});
	registerKnowledgeRoutes(app);
	return app;
}

describe("v1 knowledge search owner permissions", () => {
	beforeEach(() => {
		mocks.ownerPermissionAllowed = false;
		mocks.findChat.mockReset().mockResolvedValue({
			id: "chat-1",
			organizationId: "org-1",
		});
		mocks.findProject.mockReset().mockResolvedValue({ id: "project-1" });
		mocks.hasProjectAccess.mockReset().mockResolvedValue(true);
		mocks.getEmbeddingConfig.mockReset().mockResolvedValue({
			apiKey: "synthetic-key",
		});
		mocks.retrieveContext.mockReset().mockResolvedValue([]);
		mocks.retrieveProjectContext.mockReset().mockResolvedValue([]);
	});

	it("refuses a viewer's wildcard personal key before chat search spends", async () => {
		const response = await makeApp().request("/knowledge/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "release risks",
				scope: { kind: "chat", id: "chat-1" },
			}),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "The key's owner no longer holds the access required for knowledge:read in this organization",
		});
		expect(mocks.getEmbeddingConfig).not.toHaveBeenCalled();
		expect(mocks.retrieveContext).not.toHaveBeenCalled();
	});

	it("allows a member's personal key to search its chat", async () => {
		mocks.ownerPermissionAllowed = true;

		const response = await makeApp().request("/knowledge/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "release risks",
				scope: { kind: "chat", id: "chat-1" },
			}),
		});

		expect(response.status).toBe(200);
		expect(mocks.retrieveContext).toHaveBeenCalledOnce();
	});

	it("uses project access instead of requiring project ownership", async () => {
		const response = await makeApp().request("/knowledge/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "release risks",
				scope: { kind: "project", id: "project-1" },
			}),
		});

		expect(response.status).toBe(200);
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"project-1",
			"user-1",
			"org-1",
		);
		expect(mocks.findProject).toHaveBeenCalledWith({
			where: { id: "project-1", organizationId: "org-1" },
			select: { id: true },
		});
	});

	it("returns 404 before project retrieval when project access is absent", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const response = await makeApp().request("/knowledge/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "release risks",
				scope: { kind: "project", id: "project-1" },
			}),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { message: "Project not found" },
		});
		expect(mocks.findProject).not.toHaveBeenCalled();
		expect(mocks.retrieveProjectContext).not.toHaveBeenCalled();
		expect(mocks.getEmbeddingConfig).not.toHaveBeenCalled();
		expect(mocks.retrieveContext).not.toHaveBeenCalled();
	});
});
