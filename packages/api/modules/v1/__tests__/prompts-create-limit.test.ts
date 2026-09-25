/**
 * Fizzy #2250: the public v1 `POST /prompts` route writes a prompt's initial
 * body straight into `createPrompt`, bypassing the oRPC `prompts.create`
 * guard, so it carries its own copy of the 50,000-character product limit.
 * What is pinned here is that copy: an over-limit body is refused with 400 and
 * the shared message before anything is written; the limit applies to the
 * trimmed body the route actually stores; a body at the limit, or none, is
 * accepted.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createPrompt } = vi.hoisted(() => ({ createPrompt: vi.fn() }));

vi.mock("@repo/database", () => ({
	createPrompt,
	db: {},
	listPrompts: vi.fn(),
	updatePrompt: vi.fn(),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<unknown>) =>
		next(),
}));

vi.mock("../helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../helpers")>()),
	resolveV1Context: async () => ({
		userId: "user-1",
		organizationId: "org-1",
	}),
}));

const { registerPromptRoutes } = await import("../prompts");

function buildApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "organization",
			userId: "user-1",
			organizationId: "org-1",
			scopes: ["prompts:write"],
		});
		await next();
	});
	registerPromptRoutes(
		app as unknown as Parameters<typeof registerPromptRoutes>[0],
	);
	return app;
}

function post(body: Record<string, unknown>) {
	return buildApp().request("/prompts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: "meeting-summary",
			name: "Meeting summary",
			...body,
		}),
	});
}

beforeEach(() => {
	createPrompt.mockReset();
	createPrompt.mockResolvedValue({
		id: "p-1",
		key: "meeting-summary",
		name: "Meeting summary",
		description: null,
		scope: "ORG",
		category: null,
		tags: [],
		format: "PLAIN_TEXT",
		usageCount: 0,
		createdAt: new Date("2026-09-26T00:00:00Z"),
		updatedAt: new Date("2026-09-26T00:00:00Z"),
	});
});

describe("v1 POST /prompts — prompt body length limit", () => {
	it("refuses a body over 50,000 characters with 400 and writes nothing", async () => {
		const res = await post({ content: "x".repeat(50_001) });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: {
				message:
					"Prompt content is 50,001 characters; the maximum is 50,000.",
			},
		});
		expect(createPrompt).not.toHaveBeenCalled();
	});

	it("accepts a body of exactly 50,000 characters", async () => {
		const res = await post({ content: "x".repeat(50_000) });

		expect(res.status).toBe(201);
		expect(createPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ initialContent: "x".repeat(50_000) }),
		);
	});

	it("measures the trimmed body the route stores, not the raw request", async () => {
		const res = await post({ content: `  ${"x".repeat(50_000)}\n` });

		expect(res.status).toBe(201);
		expect(createPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ initialContent: "x".repeat(50_000) }),
		);
	});

	it("still creates a prompt with no body", async () => {
		const res = await post({});

		expect(res.status).toBe(201);
		expect(createPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ initialContent: undefined }),
		);
	});
});
