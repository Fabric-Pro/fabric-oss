import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	search: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	read: vi.fn(),
	schedule: vi.fn(),
	audit: vi.fn(),
	context: vi.fn(),
}));
vi.mock("../../agent-deployments/lib/run-commands", () => ({
	listAgentRunCommand: m.list,
	getAgentRunCommand: m.get,
	cancelAgentRunCommand: m.cancel,
	readAgentRunScheduleCommand: m.read,
	scheduleAgentRunCommand: m.schedule,
}));
vi.mock("../../agent-deployments/lib/run-history", () => ({
	searchAgentRunCommand: m.search,
}));
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../helpers", () => ({
	ok: (data: unknown) => ({ data }),
	resolveV1Context: m.context,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) =>
		async (
			c: {
				get: (key: string) => { scopes: string[] };
				json: (value: unknown, status: number) => Response;
			},
			next: () => Promise<void>,
		) => {
			const scopes = c.get("externalApiContext").scopes;
			if (!scopes.includes(scope) && !scopes.includes("*")) {
				return c.json({ error: `Missing ${scope}` }, 403);
			}
			await next();
		},
}));

import { registerAgentRunRoutes } from "../agent-runs";

let scopes: string[];
const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		keyType: "organization",
		keyId: "example-key",
		keyPrefix: "org_example",
		userId: "example-user",
		organizationId: "example-org",
		scopes,
	});
	await next();
});
registerAgentRunRoutes(app);
const request = (path: string, method = "GET", body?: unknown) =>
	app.request(`http://example.com${path}?org=example-org`, {
		method,
		...(body === undefined
			? {}
			: {
					body: JSON.stringify(body),
					headers: { "Content-Type": "application/json" },
				}),
	});
const schedule = {
	cronExpression: "0 9 * * *",
	timezone: "UTC",
	input: { message: "Report" },
	enabled: true,
};
beforeEach(() => {
	vi.resetAllMocks();
	scopes = ["agents:read", "agents:execute", "agents:schedule"];
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	for (const fn of [m.search, m.list, m.get, m.cancel, m.read, m.schedule]) {
		fn.mockResolvedValue({ status: "RUNNING" });
	}
});
describe("REST run commands", () => {
	it.each([
		["/agent-instances/example-instance/runs", "list"],
		["/agent-instances/example-instance/run-schedule", "read"],
		["/agent-executions/example-row", "get"],
	] as const)(
		"routes %s through the same resolved actor service",
		async (path, name) => {
			const response = await request(path);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toContain("no-store");
			expect(m[name]).toHaveBeenCalledWith(
				{
					userId: "example-user",
					organizationId: "example-org",
					external: true,
				},
				expect.any(Object),
			);
		},
	);
	it.each([
		["agents:execute"],
		["agents:schedule"],
		["mcp:write"],
		["agents:read"],
	])(
		"requires BOTH explicit schedule and execute ceilings (%s)",
		async (...grants) => {
			scopes = grants;
			expect(
				(
					await request(
						"/agent-instances/example-instance/run-schedule",
						"PUT",
						schedule,
					)
				).status,
			).toBe(403);
			expect(m.schedule).not.toHaveBeenCalled();
		},
	);
	it("lets wildcard reach service but preserves service live permission refusal", async () => {
		scopes = ["*"];
		m.schedule.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Current role denied" }),
		);
		const response = await request(
			"/agent-instances/example-instance/run-schedule",
			"PUT",
			schedule,
		);
		expect(response.status).toBe(403);
		expect(m.schedule).toHaveBeenCalledOnce();
	});
	it("attributes mutations to the real key principal and never takes an actor from the body", async () => {
		m.schedule.mockImplementation(async (_actor, _input, audit) => {
			audit({
				action: "org.agent_schedule.updated",
				organizationId: "example-org",
			});
			return {};
		});
		await request(
			"/agent-instances/example-instance/run-schedule",
			"PUT",
			schedule,
		);
		expect(m.audit).toHaveBeenCalledWith(
			expect.objectContaining({ headers: expect.any(Headers) }),
			expect.objectContaining({
				actor: { type: "api_key", userId: "example-user" },
			}),
		);
	});
	it("cancellation carries only execution identity, not arbitrary workflow IDs", async () => {
		expect(
			(
				await request("/agent-executions/example-row/cancel", "POST", {
					runId: "foreign-run",
				})
			).status,
		).toBe(400);
		expect(m.cancel).not.toHaveBeenCalled();
		expect(
			(await request("/agent-executions/example-row/cancel", "POST", {}))
				.status,
		).toBe(200);
		expect(m.cancel).toHaveBeenCalledWith(
			expect.any(Object),
			{ executionId: "example-row" },
			expect.any(Function),
		);
	});
	it("fails closed for tenant/bound credential resolution before command I/O", async () => {
		m.context.mockResolvedValue({
			error: "Project-bound grant",
			status: 403,
		});
		expect(
			(await request("/agent-instances/example-instance/runs")).status,
		).toBe(403);
		expect(m.list).not.toHaveBeenCalled();
	});
	it("has no Portal-owner invocation route", async () => {
		expect(
			(
				await request(
					"/agent-instances/example-instance/runs",
					"POST",
					{ input: { message: "x" } },
				)
			).status,
		).toBe(404);
	});
});

it("preserves truthful unresolved schedule receipt for SDK callers without exposing arbitrary error data", async () => {
	m.schedule.mockRejectedValue(
		new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Inspect schedule state",
			data: {
				scheduleSaved: true,
				schedulingState: "UNKNOWN",
				privateValue: "must-not-escape",
			},
		}),
	);
	const response = await request(
		"/agent-instances/example-instance/run-schedule",
		"PUT",
		schedule,
	);
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({
		error: {
			code: "SERVICE_UNAVAILABLE",
			message: "Inspect schedule state",
			data: { scheduleSaved: true, schedulingState: "UNKNOWN" },
		},
	});
});

it("accepts bounded multibyte task text up to the shared 20,000-character contract", async () => {
	const response = await request(
		"/agent-instances/example-instance/run-schedule",
		"PUT",
		{ ...schedule, input: { message: "é".repeat(20000) } },
	);
	expect(response.status).toBe(200);
	expect(m.schedule).toHaveBeenCalledOnce();
});

describe("REST paged agent history", () => {
	it("forwards bounded metadata filters to the shared authorized query", async () => {
		const filters = {
			instanceId: "example-instance",
			status: "FAILED",
			triggerType: "SCHEDULE",
			from: "2026-01-01T00:00:00Z",
			to: "2026-02-01T00:00:00Z",
			query: "task & progress",
			cursor: "opaque_cursor",
			limit: "25",
		};
		const response = await app.request(
			`http://example.com/agent-runs?org=example-org&${new URLSearchParams(filters)}`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toContain("no-store");
		expect(m.search).toHaveBeenCalledWith(
			{
				userId: "example-user",
				organizationId: "example-org",
				external: true,
			},
			{ ...filters, limit: 25 },
		);
	});
	it.each([["mcp:read"], ["agents:execute"], []])(
		"refuses insufficient declared scopes before history access: %j",
		async (...scopesValue) => {
			scopes = scopesValue;
			expect((await request("/agent-runs")).status).toBe(403);
			expect(m.search).not.toHaveBeenCalled();
		},
	);
	it("wildcard cannot bypass the creator's current denial", async () => {
		scopes = ["*"];
		m.search.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Current role denied" }),
		);
		expect((await request("/agent-runs")).status).toBe(403);
		expect(m.search).toHaveBeenCalledOnce();
	});
	it("project-bound or cross-organization authority cannot invoke owner history", async () => {
		m.context.mockResolvedValue({
			error: "Unsupported connection",
			status: 403,
		});
		expect((await request("/agent-runs")).status).toBe(403);
		expect(m.search).not.toHaveBeenCalled();
	});
});

it.each(["example-v1", null])(
	"preserves current agent and original execution version metadata in REST history (%s)",
	async (originalInstanceId) => {
		const history = {
			executions: [
				{
					id: "example-run",
					instanceId: "example-v2",
					executionInstanceId: originalInstanceId,
					agentName: "Current delivery reporter",
					task: "Report progress",
					status: "COMPLETED",
					lastRecordedStatus: "COMPLETED",
					queuedAt: "2026-01-01T09:00:00Z",
					createdAt: "2026-01-01T09:00:01Z",
					completedAt: "2026-01-01T09:00:04Z",
					duration: 3000,
					triggerType: "MANUAL",
				},
			],
			nextCursor: null,
		};
		m.search.mockResolvedValue(history);
		const response = await request("/agent-runs");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: history });
	},
);
