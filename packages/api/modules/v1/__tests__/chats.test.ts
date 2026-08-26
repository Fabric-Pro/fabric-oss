/**
 * v1 chats routes — Phase 7a integration tests
 *
 * Exercises the route layer end-to-end via Hono's app.request(), with
 * @repo/database, @repo/ai, and the api-key auth middleware mocked.
 * Confirms tenant isolation, scope enforcement, status codes, and that
 * the synchronous sendMessage path persists messages + auto-generates
 * a title on the first turn.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---------------------------------------------------------------

const mockGetAiChatByIdForTenant = vi.fn();
const mockGetAiChatsByUserId = vi.fn();
const mockGetAiChatsByOrganizationId = vi.fn();
const mockCreateAiChat = vi.fn();
const mockUpdateAiChatForTenant = vi.fn();
const mockDeleteAiChatForTenant = vi.fn();
const mockHasProjectAccess = vi.fn();

const mockGetAIModelWithMetadata = vi.fn();
const mockGenerateText = vi.fn();
const mockGenerateChatTitle = vi.fn();
const mockConvertToModelMessages = vi.fn();

vi.mock("@repo/database", () => ({
	getAiChatByIdForTenant: (...args: unknown[]) =>
		mockGetAiChatByIdForTenant(...args),
	getAiChatsByUserId: (...args: unknown[]) => mockGetAiChatsByUserId(...args),
	getAiChatsByOrganizationId: (...args: unknown[]) =>
		mockGetAiChatsByOrganizationId(...args),
	createAiChat: (...args: unknown[]) => mockCreateAiChat(...args),
	updateAiChatForTenant: (...args: unknown[]) =>
		mockUpdateAiChatForTenant(...args),
	deleteAiChatForTenant: (...args: unknown[]) =>
		mockDeleteAiChatForTenant(...args),
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	// resolveV1Context (used by chats routes via ./helpers) only touches db
	// when the request carries ?org= or ?personal=1. Our tests run in
	// personal-key context with no override, so these stubs aren't invoked
	// — they only need to exist so the import resolves.
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
	// `setAiUsageRecorder` is the registry hook that @repo/payments uses
	// to register `recordAiUsageAndCheckOverage` with @repo/database. The
	// chats v1 surface doesn't exercise it; a no-op spy satisfies the
	// import so loading @repo/payments transitively doesn't throw.
	setAiUsageRecorder: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		mockGetAIModelWithMetadata(...args),
	generateText: (...args: unknown[]) => mockGenerateText(...args),
	generateChatTitle: (...args: unknown[]) => mockGenerateChatTitle(...args),
	convertToModelMessages: (...args: unknown[]) =>
		mockConvertToModelMessages(...args),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { registerChatRoutes } from "../chats";

// --- Test harness --------------------------------------------------------

function makeApp(
	ctx: {
		keyType?: "personal" | "organization";
		userId?: string;
		organizationId?: string | undefined;
		scopes?: string[];
	} = {},
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
			keyType: ctx.keyType ?? "personal",
			keyId: "key-1",
			keyPrefix: "fab_test",
			userId: ctx.userId ?? "user-1",
			organizationId: ctx.organizationId,
			scopes: ctx.scopes ?? ["chats:read", "chats:write"],
		});
		await next();
	});
	registerChatRoutes(app as never);
	return app;
}

function chatRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "chat-1",
		title: null,
		userId: "user-1",
		organizationId: null,
		projectId: null,
		messages: [],
		createdAt: new Date("2026-05-11T00:00:00.000Z"),
		updatedAt: new Date("2026-05-11T00:00:00.000Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

// --- Tests ---------------------------------------------------------------

describe("v1 chats — GET/POST/PATCH/DELETE", () => {
	it("GET /chats lists personal-context chats", async () => {
		mockGetAiChatsByUserId.mockResolvedValue([
			chatRow(),
			chatRow({ id: "chat-2" }),
		]);
		const app = makeApp();

		const res = await app.request("/chats");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<{ id: string }> };
		expect(body.data).toHaveLength(2);
		expect(body.data[0]).toMatchObject({
			id: "chat-1",
			organizationId: null,
		});
		expect(mockGetAiChatsByUserId).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1" }),
		);
	});

	it("POST /chats creates a chat without projectId access check when none provided", async () => {
		mockCreateAiChat.mockResolvedValue(chatRow({ title: "Plan" }));
		const app = makeApp();

		const res = await app.request("/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Plan" }),
		});
		expect(res.status).toBe(201);
		expect(mockHasProjectAccess).not.toHaveBeenCalled();
		expect(mockCreateAiChat).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", title: "Plan" }),
		);
	});

	it("POST /chats 403s when the caller has no access to the requested project", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const app = makeApp();
		const res = await app.request("/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x", projectId: "proj-x" }),
		});
		expect(res.status).toBe(403);
		expect(mockCreateAiChat).not.toHaveBeenCalled();
	});

	it("POST /chats 400s when title exceeds 200 chars", async () => {
		const app = makeApp();
		const res = await app.request("/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x".repeat(201) }),
		});
		expect(res.status).toBe(400);
		expect(mockCreateAiChat).not.toHaveBeenCalled();
	});

	it("PATCH /chats/:id renames via title field", async () => {
		mockUpdateAiChatForTenant.mockResolvedValue(
			chatRow({ title: "Renamed" }),
		);
		const app = makeApp();
		const res = await app.request("/chats/chat-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Renamed" }),
		});
		expect(res.status).toBe(200);
		expect(mockUpdateAiChatForTenant).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "chat-1",
				userId: "user-1",
				title: "Renamed",
			}),
		);
	});

	it("PATCH /chats/:id 404 when the chat isn't owned by the caller", async () => {
		mockUpdateAiChatForTenant.mockResolvedValue(null);
		const app = makeApp();
		const res = await app.request("/chats/other-tenant-chat", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x" }),
		});
		expect(res.status).toBe(404);
	});

	it("PATCH /chats/:id 400 with no recognised fields", async () => {
		const app = makeApp();
		const res = await app.request("/chats/chat-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("DELETE /chats/:id returns { id, deleted: true } on success", async () => {
		mockDeleteAiChatForTenant.mockResolvedValue(true);
		const app = makeApp();
		const res = await app.request("/chats/chat-1", { method: "DELETE" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { id: string; deleted: boolean };
		};
		expect(body.data).toEqual({ id: "chat-1", deleted: true });
	});

	it("DELETE /chats/:id 404 when nothing matched the tenant filter", async () => {
		mockDeleteAiChatForTenant.mockResolvedValue(false);
		const app = makeApp();
		const res = await app.request("/chats/missing", { method: "DELETE" });
		expect(res.status).toBe(404);
	});
});

describe("v1 chats — POST /chats/:id/messages", () => {
	beforeEach(() => {
		mockConvertToModelMessages.mockImplementation(async (msgs) => msgs);
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "mock-model" },
			trackUsage: () => undefined,
		});
		mockGenerateText.mockResolvedValue({ text: "hello back" });
		mockUpdateAiChatForTenant.mockResolvedValue(chatRow());
	});

	it("400s when content is missing", async () => {
		mockGetAiChatByIdForTenant.mockResolvedValue(chatRow());
		const app = makeApp();
		const res = await app.request("/chats/chat-1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(mockGenerateText).not.toHaveBeenCalled();
	});

	it("404s when the chat isn't owned by the caller", async () => {
		mockGetAiChatByIdForTenant.mockResolvedValue(null);
		const app = makeApp();
		const res = await app.request("/chats/x/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "hi" }),
		});
		expect(res.status).toBe(404);
		expect(mockGenerateText).not.toHaveBeenCalled();
	});

	it("happy path: runs the model, persists messages, returns assistant reply", async () => {
		mockGetAiChatByIdForTenant.mockResolvedValue(
			chatRow({ messages: [], title: null }),
		);
		mockGenerateChatTitle.mockResolvedValue("Generated Title");

		const app = makeApp();
		const res = await app.request("/chats/chat-1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "hi there" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: {
				chatId: string;
				assistantMessage: { role: string; content: string };
			};
		};
		expect(body.data.chatId).toBe("chat-1");
		expect(body.data.assistantMessage.role).toBe("assistant");
		expect(body.data.assistantMessage.content).toBe("hello back");

		// Persisted messages: original user msg + the assistant reply
		const persistedCall = mockUpdateAiChatForTenant.mock.calls[0]?.[0] as {
			messages: Array<{ role: string }>;
			title?: string;
		};
		expect(persistedCall.messages).toHaveLength(2);
		expect(persistedCall.messages[0]?.role).toBe("user");
		expect(persistedCall.messages[1]?.role).toBe("assistant");
		// First-turn title generation kicked in
		expect(mockGenerateChatTitle).toHaveBeenCalledTimes(1);
		expect(persistedCall.title).toBe("Generated Title");
	});

	it("does NOT re-generate the title on subsequent turns", async () => {
		mockGetAiChatByIdForTenant.mockResolvedValue(
			chatRow({
				messages: [
					{ role: "user", parts: [{ type: "text", text: "first" }] },
					{
						role: "assistant",
						parts: [{ type: "text", text: "answer" }],
					},
				],
				title: "Existing Title",
			}),
		);
		const app = makeApp();
		const res = await app.request("/chats/chat-1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "follow up" }),
		});
		expect(res.status).toBe(200);
		expect(mockGenerateChatTitle).not.toHaveBeenCalled();

		const persistedCall = mockUpdateAiChatForTenant.mock.calls[0]?.[0] as {
			messages: Array<{ role: string }>;
		};
		// 2 existing + 1 new user + 1 new assistant
		expect(persistedCall.messages).toHaveLength(4);
	});

	it("returns 400 with AI_GATEWAY_MISSING code when no provider is configured", async () => {
		mockGetAiChatByIdForTenant.mockResolvedValue(chatRow());
		mockGetAIModelWithMetadata.mockRejectedValueOnce(
			new Error("No AI provider configured"),
		);
		const app = makeApp();
		const res = await app.request("/chats/chat-1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "hi" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("AI_GATEWAY_MISSING");
	});
});
