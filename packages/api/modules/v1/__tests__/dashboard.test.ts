import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	record: vi.fn(),
	context: vi.fn(),
}));

vi.mock("../../dashboard/lib/curated-feedback-commands", () => ({
	listCuratedFeedbackCommand: m.list,
	recordCuratedFeedbackCommand: m.record,
}));
vi.mock("../helpers", () => ({
	ok: (data: unknown) => ({ data }),
	resolveV1Context: m.context,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) => async (c: any, next: () => Promise<void>) => {
			const scopes = c.get("externalApiContext").scopes;
			if (!scopes.includes(scope) && !scopes.includes("*")) {
				return c.json({ error: { code: "INSUFFICIENT_SCOPE" } }, 403);
			}
			await next();
		},
}));

import { registerDashboardRoutes } from "../dashboard";

const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		userId: "example-user",
		organizationId: "example-org",
		keyType: "organization",
		keyId: "example-key",
		keyPrefix: "example",
		scopes: (c.req.header("x-example-scopes") ?? "").split(","),
	});
	await next();
});
registerDashboardRoutes(app);

const actor = { userId: "example-user", organizationId: "example-org" };

beforeEach(() => {
	vi.clearAllMocks();
	m.context.mockResolvedValue(actor);
	m.list.mockResolvedValue({ preferences: [] });
	m.record.mockResolvedValue({ preference: { cardKey: "project:one" } });
});

describe("dashboard feedback API", () => {
	it("requires the declared scope", async () => {
		const response = await app.request("/dashboard/curated-feedback", {
			headers: { "x-example-scopes": "projects:read" },
		});
		expect(response.status).toBe(403);
		expect(m.list).not.toHaveBeenCalled();
	});

	it("lists feedback for the resolved actor", async () => {
		const response = await app.request("/dashboard/curated-feedback", {
			headers: { "x-example-scopes": "dashboard:read" },
		});
		expect(response.status).toBe(200);
		expect(m.list).toHaveBeenCalledWith(actor);
	});

	it("records the same command as Portal", async () => {
		const response = await app.request("/dashboard/curated-feedback", {
			method: "POST",
			headers: {
				"x-example-scopes": "dashboard:write",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ cardKey: "project:one", action: "pin" }),
		});
		expect(response.status).toBe(200);
		expect(m.record).toHaveBeenCalledWith(actor, {
			cardKey: "project:one",
			action: "pin",
		});
	});

	it("refuses an unresolved organization before reading preferences", async () => {
		m.context.mockResolvedValue({ error: "Not a member", status: 403 });
		const response = await app.request("/dashboard/curated-feedback", {
			headers: { "x-example-scopes": "*" },
		});
		expect(response.status).toBe(403);
		expect(m.list).not.toHaveBeenCalled();
	});
});
