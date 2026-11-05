import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

const m = vi.hoisted(() => ({
	assist: vi.fn(),
	preview: vi.fn(),
	context: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {},
	createPrompt: vi.fn(),
	updatePrompt: vi.fn(),
	listPrompts: vi.fn(),
}));
vi.mock("../../prompts/lib/workbench", () => ({
	assistPrompt: m.assist,
	tryPrompt: m.preview,
}));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));
vi.mock("../helpers", () => ({
	resolveV1Context: m.context,
	ok: (data: unknown) => ({ data }),
	forbidden: (message: string) => ({ error: { message } }),
	badRequest: vi.fn(),
	notFound: vi.fn(),
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

import { registerPromptRoutes } from "../prompts";

function app(
	scopes = ["prompts:read", "prompts:write"],
	boundProjectId?: string,
) {
	const a = new Hono<{ Variables: ExternalApiVariables }>();
	a.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "organization",
			keyId: "example-key",
			keyPrefix: "org_example",
			userId: "example-user",
			organizationId: "example-org",
			scopes,
			boundProjectId,
		});
		await next();
	});
	registerPromptRoutes(a);
	return a;
}
const input = { draft: { content: "Reply briefly" }, message: "Improve" };
beforeEach(() => {
	vi.clearAllMocks();
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	m.assist.mockResolvedValue({ message: "Review" });
	m.preview.mockResolvedValue({ output: "Actual output" });
});
it.each([
	["/prompt-assistance", "assist"],
	["/prompt-previews", "preview"],
] as const)(
	"propagates resolved actor and returns uncached %s",
	async (path, method) => {
		const r = await app().request(path, {
			method: "POST",
			body: JSON.stringify(input),
		});
		expect(r.status).toBe(200);
		expect(r.headers.get("cache-control")).toBe("private, no-store");
		expect(m[method]).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			input,
		);
	},
);
it("refuses scope before invoking core and preserves permission versus scope errors", async () => {
	const r = await app(["prompts:read"]).request("/prompt-assistance", {
		method: "POST",
		body: JSON.stringify(input),
	});
	expect(r.status).toBe(403);
	expect((await r.json()).error.code).toBe("INSUFFICIENT_SCOPE");
	expect(m.assist).not.toHaveBeenCalled();
	m.assist.mockRejectedValue(
		new ORPCError("FORBIDDEN", { message: "Current permission required" }),
	);
	const revoked = await app(["*"]).request("/prompt-assistance", {
		method: "POST",
		body: JSON.stringify(input),
	});
	expect(revoked.status).toBe(403);
	expect((await revoked.json()).error.code).toBe("FORBIDDEN");
});
it("denies project-bound credentials before org operations", async () => {
	const r = await app(["*"], "example-project").request("/prompt-previews", {
		method: "POST",
		body: JSON.stringify(input),
	});
	expect(r.status).toBe(403);
	expect(m.preview).not.toHaveBeenCalled();
});
it("rejects missing org, oversized body and malformed JSON before core", async () => {
	m.context.mockResolvedValue({ userId: "example-user" });
	expect(
		(
			await app().request("/prompt-previews", {
				method: "POST",
				body: "{}",
			})
		).status,
	).toBe(403);
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	expect(
		(
			await app().request("/prompt-previews", {
				method: "POST",
				body: "x".repeat(512 * 1024 + 1),
			})
		).status,
	).toBe(413);
	expect(
		(await app().request("/prompt-previews", { method: "POST", body: "{" }))
			.status,
	).toBe(400);
	expect(m.preview).not.toHaveBeenCalled();
});
