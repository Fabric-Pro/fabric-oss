import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	context: vi.fn(),
	change: vi.fn(),
	schedule: vi.fn(),
	configure: vi.fn(),
	versions: vi.fn(),
}));
vi.mock("../helpers", () => ({
	resolveV1Context: m.context,
	ok: (data: unknown) => ({ data }),
}));
vi.mock("../../workflows/lib/workflow-lifecycle-commands", () => ({
	changeWorkflowLifecycleCommand: m.change,
	getWorkflowScheduleCommand: m.schedule,
	configureWorkflowScheduleCommand: m.configure,
	listWorkflowVersionsCommand: m.versions,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) => async (c: any, next: () => Promise<void>) => {
			if (
				!c
					.get("externalApiContext")
					.scopes.some((s: string) => s === scope || s === "*")
			) {
				return c.json({ error: { code: "INSUFFICIENT_SCOPE" } }, 403);
			}
			await next();
		},
}));

import { WorkflowCommandError } from "../../workflows/lib/workflow-command-context";
import { registerWorkflowLifecycleRoutes } from "../workflow-lifecycle";

function app(scopes = ["workflows:read", "workflows:write"]) {
	const a = new Hono();
	a.use("*", async (c, next) => {
		c.set("externalApiContext" as never, { scopes } as never);
		await next();
	});
	registerWorkflowLifecycleRoutes(a as any);
	return a;
}
beforeEach(() => {
	vi.clearAllMocks();
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	for (const f of [m.change, m.schedule, m.configure, m.versions]) {
		f.mockResolvedValue({ success: true });
	}
});
it.each(["publish", "unpublish", "pause", "resume", "rollback"] as const)(
	"routes %s to the same authorized command and resolved actor",
	async (op) => {
		const body = op === "rollback" ? { targetVersion: 1 } : {};
		const r = await app().request(`/workflows/example-workflow/${op}`, {
			method: "POST",
			body: JSON.stringify(body),
		});
		expect(r.status).toBe(200);
		expect(m.change).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			op,
			{ workflowId: "example-workflow", ...body },
		);
		expect(r.headers.get("cache-control")).toBe("private, no-store");
	},
);
it("supports paginated versions and saved-versus-live schedule operations", async () => {
	await app().request(
		"/workflows/example-workflow/versions?limit=10&offset=20",
	);
	expect(m.versions).toHaveBeenCalledWith(expect.anything(), {
		workflowId: "example-workflow",
		limit: 10,
		offset: 20,
	});
	await app().request("/workflows/example-workflow/schedule");
	expect(m.schedule).toHaveBeenCalledWith(expect.anything(), {
		workflowId: "example-workflow",
	});
	const r = await app().request("/workflows/example-workflow/schedule", {
		method: "PUT",
		body: JSON.stringify({ cron: "0 9 * * 1", timezone: "UTC" }),
	});
	expect(r.status).toBe(200);
	expect(m.configure).toHaveBeenCalledWith(expect.anything(), {
		workflowId: "example-workflow",
		cron: "0 9 * * 1",
		timezone: "UTC",
	});
});
it("separates scopes from current permission even for wildcard keys", async () => {
	expect(
		(
			await app(["workflows:read"]).request(
				"/workflows/example-workflow/pause",
				{ method: "POST" },
			)
		).status,
	).toBe(403);
	expect(m.change).not.toHaveBeenCalled();
	m.change.mockRejectedValue(
		new WorkflowCommandError("FORBIDDEN", "Current permission required"),
	);
	const r = await app(["*"]).request("/workflows/example-workflow/pause", {
		method: "POST",
	});
	expect(r.status).toBe(403);
	expect((await r.json()).error.code).toBe("FORBIDDEN");
});
it("refuses malformed requests, authority overrides and unknown body keys", async () => {
	for (const body of [
		"broken",
		JSON.stringify({ workflowId: "other" }),
		JSON.stringify({ organizationId: "other" }),
	]) {
		expect(
			(
				await app().request("/workflows/example-workflow/publish", {
					method: "POST",
					body,
				})
			).status,
		).toBe(400);
	}
	expect(m.change).not.toHaveBeenCalled();
});
it("keeps object access opaque and refuses invalid context", async () => {
	m.change.mockRejectedValue(
		new WorkflowCommandError("NOT_FOUND", "Workflow not found"),
	);
	expect(
		(await app().request("/workflows/other/pause", { method: "POST" }))
			.status,
	).toBe(404);
	m.context.mockResolvedValue({
		error: "Project sign-in is constrained",
		status: 403,
	});
	expect((await app().request("/workflows/example/schedule")).status).toBe(
		403,
	);
	expect(m.schedule).not.toHaveBeenCalled();
});
