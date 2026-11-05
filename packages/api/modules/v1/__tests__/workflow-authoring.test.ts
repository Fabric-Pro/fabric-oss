import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	check: vi.fn(),
	context: vi.fn(),
}));
vi.mock("../../workflows/lib/workflow-authoring", () => ({
	listWorkflowStarters: m.list,
	createWorkflowFromStarter: m.create,
	checkWorkflowReadiness: m.check,
}));
vi.mock("../helpers", () => ({
	ok: (data: unknown) => ({ data }),
	resolveV1Context: m.context,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) => async (c: any, next: () => Promise<void>) => {
			if (
				!c
					.get("externalApiContext")
					.scopes.some((s: string) => s === scope || s === "*")
			)
				return c.json({ error: { code: "INSUFFICIENT_SCOPE" } }, 403);
			await next();
		},
}));

import { WorkflowCommandError } from "../../workflows/lib/workflow-command-context";
import { registerWorkflowAuthoringRoutes } from "../workflow-authoring";

function app(scopes = ["workflows:read", "workflows:write"]) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext" as never, { scopes } as never);
		await next();
	});
	registerWorkflowAuthoringRoutes(app as any);
	return app;
}
beforeEach(() => {
	vi.clearAllMocks();
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	m.list.mockResolvedValue([]);
	m.create.mockResolvedValue({ workflow: { id: "example-workflow" } });
	m.check.mockResolvedValue({ ready: true });
});
it("propagates the resolved organization actor through all operations and avoids caching", async () => {
	for (const [path, method, fn, input] of [
		["/workflows/starters", "GET", m.list, undefined],
		["/workflows/starters", "POST", m.create, { starterId: "action-plan" }],
		[
			"/workflows/example-workflow/readiness",
			"GET",
			m.check,
			{ id: "example-workflow" },
		],
	] as const) {
		const r = await app().request(path, {
			method,
			...(method === "POST" ? { body: JSON.stringify(input) } : {}),
		});
		expect(r.status).toBe(200);
		expect(r.headers.get("cache-control")).toBe("private, no-store");
		expect(fn).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			...(input ? [input] : []),
		);
	}
});
it("separates declared-scope failure from revoked live permission even with wildcard credentials", async () => {
	expect((await app([]).request("/workflows/starters")).status).toBe(403);
	expect(m.list).not.toHaveBeenCalled();
	m.list.mockRejectedValue(
		new WorkflowCommandError("FORBIDDEN", "Current permission required"),
	);
	const r = await app(["*"]).request("/workflows/starters");
	expect(r.status).toBe(403);
	expect((await r.json()).error.code).toBe("FORBIDDEN");
});
it("rejects unresolved or constrained tenant context without invoking a command", async () => {
	m.context.mockResolvedValue({
		error: "Project credentials cannot use this operation",
		status: 403,
	});
	expect((await app(["*"]).request("/workflows/starters")).status).toBe(403);
	expect(m.list).not.toHaveBeenCalled();
});
it("keeps missing object access opaque", async () => {
	m.check.mockRejectedValue(
		new WorkflowCommandError("NOT_FOUND", "Workflow not found"),
	);
	expect((await app().request("/workflows/other/readiness")).status).toBe(
		404,
	);
});
