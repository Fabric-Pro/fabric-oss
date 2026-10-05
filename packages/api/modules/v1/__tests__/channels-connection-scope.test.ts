import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, member, send } = await vi.hoisted(async () => {
	const { createWorkflowIntegrationStore } = await import(
		"../../integrations/__tests__/procedures/workflow-integration-store"
	);
	return {
		store: createWorkflowIntegrationStore(),
		member: vi.fn(),
		send: vi.fn(),
	};
});
vi.mock("@repo/database/prisma/client", () => ({
	db: { workflowIntegration: store.delegate, member: { findFirst: member } },
}));
vi.mock("@repo/database", async () => ({
	...(await import(
		"@repo/database/prisma/queries/workflows/integration-access"
	)),
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: (value: string) => value }));
vi.mock("@repo/integrations", () => ({
	channelRegistry: {
		list: () => [
			{ channel: "telegram", name: "Telegram", providerKey: "TELEGRAM" },
		],
		get: () => ({ name: "Telegram", providerKey: "TELEGRAM", send }),
	},
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) =>
		next(),
}));
vi.mock("../helpers", () => ({
	resolveV1Context: async () => ({
		userId: "actor",
		organizationId: "org-example",
	}),
	ok: (data: unknown) => ({ data }),
	badRequest: (message: string) => ({ error: { message } }),
	notFound: (message: string) => ({ error: { message } }),
}));

import { registerChannelRoutes } from "../channels";

function seed(
	userId: string,
	usageScope: "OWNER_ONLY" | "ORGANIZATION_SHARED",
	organizationId = "org-example",
) {
	store.rows.push({
		id: `connection-${store.rows.length}`,
		userId,
		organizationId,
		provider: "TELEGRAM",
		name: "Example bot",
		isActive: true,
		lastUsedAt: null,
		credentials: JSON.stringify({ botToken: `${userId}-token` }),
		usageScope,
	});
}
async function request() {
	const app = new Hono();
	registerChannelRoutes(app as never);
	return app.request("/channels/telegram/send", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ channelId: "example-chat", text: "Example" }),
	});
}
beforeEach(() => {
	store.reset();
	member.mockReset().mockResolvedValue({ id: "example-member" });
	send.mockReset().mockResolvedValue({ ok: true });
});
describe("channel credential access", () => {
	it("does not execute with a teammate's private bot token", async () => {
		seed("teammate", "OWNER_ONLY");
		expect((await request()).status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});
	it("allows an explicitly shared bot and prefers the acting user's own connection", async () => {
		seed("teammate", "ORGANIZATION_SHARED");
		seed("actor", "OWNER_ONLY");
		expect((await request()).status).toBe(200);
		expect(send.mock.calls[0][1].credentials.botToken).toBe("actor-token");
	});
	it("allows a shared bot when the acting user has no personal connection", async () => {
		seed("teammate", "ORGANIZATION_SHARED");
		expect((await request()).status).toBe(200);
		expect(send.mock.calls[0][1].credentials.botToken).toBe(
			"teammate-token",
		);
	});
	it("does not use a shared connection in another organization", async () => {
		seed("teammate", "ORGANIZATION_SHARED", "org-other");
		expect((await request()).status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});
	it("does not send after membership is removed", async () => {
		seed("actor", "OWNER_ONLY");
		member.mockResolvedValue(null);
		expect((await request()).status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});
});
