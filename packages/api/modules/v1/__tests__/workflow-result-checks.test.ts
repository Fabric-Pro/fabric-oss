import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	context: vi.fn(),
	inspect: vi.fn(),
	list: vi.fn(),
	preview: vi.fn(),
	save: vi.fn(),
	apply: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("../helpers", () => ({
	resolveV1Context: m.context,
	ok: (data: unknown) => ({ data }),
}));
vi.mock("../../workflows/lib/workflow-result-checks", () => ({
	inspectWorkflowResult: m.inspect,
	listWorkflowChecks: m.list,
	previewWorkflowCheck: m.preview,
	saveWorkflowCheck: m.save,
	applyWorkflowCheck: m.apply,
	removeWorkflowCheck: m.remove,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: (scope: string) => async (c: any, next: any) => {
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
import { registerWorkflowResultCheckRoutes } from "../workflow-result-checks";

function app(scopes = ["workflows:read", "workflows:write"]) {
	const a = new Hono();
	a.use("*", async (c, next) => {
		c.set("externalApiContext" as never, { scopes } as never);
		await next();
	});
	registerWorkflowResultCheckRoutes(a as any);
	return a;
}
const path = "/workflows/example-workflow/checks";
const revision = "a".repeat(64);
const sample = {
	executionId: "example-run",
	nodeId: "draft",
	expectedRevision: revision,
	requiredPhrases: ["Next steps"],
	forbiddenPhrases: [],
};
beforeEach(() => {
	vi.clearAllMocks();
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	m.inspect.mockResolvedValue({ revision });
	m.list.mockResolvedValue({ cases: [], canManage: true });
	m.save.mockResolvedValue({ check: { id: "example-check" } });
});
it("uses the route workflow and resolved actor for saved checks", async () => {
	const response = await app().request(`${path}/save`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...sample, name: "Delivery evidence" }),
	});
	expect(response.status).toBe(200);
	expect(m.save).toHaveBeenCalledWith(
		{ userId: "example-user", organizationId: "example-org" },
		{
			...sample,
			name: "Delivery evidence",
			workflowId: "example-workflow",
		},
	);
});
it.each(["save", "remove"])(
	"requires write scope for %s independently of current permissions",
	async (action) => {
		const response = await app(["workflows:read"]).request(
			`${path}/${action}`,
			{ method: "POST", body: "{}" },
		);
		expect(response.status).toBe(403);
		expect(m.save).not.toHaveBeenCalled();
		expect(m.remove).not.toHaveBeenCalled();
	},
);
it("does not let wildcard keys bypass the shared current permission check", async () => {
	m.save.mockRejectedValueOnce(
		new WorkflowCommandError("FORBIDDEN", "Current permission required"),
	);
	const response = await app(["*"]).request(`${path}/save`, {
		method: "POST",
		body: JSON.stringify({ ...sample, name: "Delivery evidence" }),
	});
	expect(response.status).toBe(403);
	expect(await response.text()).toContain("Current permission");
});
it.each([
	{ workflowId: "other" },
	{ organizationId: "other" },
	{ recordedAnswer: "pretend" },
])("rejects authority or answer override %j", async (extra) => {
	const response = await app().request(`${path}/inspect`, {
		method: "POST",
		body: JSON.stringify({
			executionId: "example-run",
			nodeId: "draft",
			...extra,
		}),
	});
	expect(response.status).toBe(400);
	expect(m.inspect).not.toHaveBeenCalled();
});
it("refuses project-bound resolution before running a command", async () => {
	m.context.mockResolvedValue({
		error: "Project-bound credential",
		status: 403,
	});
	expect((await app().request(path)).status).toBe(403);
	expect(m.list).not.toHaveBeenCalled();
});
it("bounds request bodies before allocating a result-check command", async () => {
	expect(
		(
			await app().request(`${path}/preview`, {
				method: "POST",
				body: "x".repeat(128 * 1024 + 1),
			})
		).status,
	).toBe(413);
	expect(m.preview).not.toHaveBeenCalled();
});
it("does not let a write-only credential infer private answer contents by saving a baseline", async () => {
	const response = await app(["workflows:write"]).request(`${path}/save`, {
		method: "POST",
		body: JSON.stringify({ ...sample, name: "Delivery evidence" }),
	});
	expect(response.status).toBe(403);
	expect(m.save).not.toHaveBeenCalled();
});
it("accepts the same bounded Unicode expectations as the other transports", async () => {
	const make = (character: string) =>
		Array.from(
			{ length: 20 },
			(_, i) => String(i).padStart(2, "0") + character.repeat(510),
		);
	m.preview.mockResolvedValueOnce({ report: { status: "failed" } });
	const body = JSON.stringify({
		...sample,
		requiredPhrases: make("界"),
		forbiddenPhrases: make("別"),
	});
	expect(Buffer.byteLength(body)).toBeGreaterThan(32768);
	const response = await app().request(path + "/preview", {
		method: "POST",
		body,
	});
	expect(response.status).toBe(200);
	expect(m.preview).toHaveBeenCalled();
});
