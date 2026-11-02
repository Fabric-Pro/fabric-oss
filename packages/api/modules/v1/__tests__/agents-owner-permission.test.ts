import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		createAgentTask: vi.fn(),
		findAgent: vi.fn(),
		ownerPermissionAllowed: true,
		start: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	createAgentTask: mocks.createAgentTask,
	db: { agent: { findFirst: mocks.findAgent } },
	getAgentById: vi.fn(),
	listAgents: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: mocks.start } }),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) =>
		next(),
	requireV1OwnerPermission: async (
		c: { json: (body: unknown, status: number) => unknown },
		_context: unknown,
		scope: string,
	) =>
		mocks.ownerPermissionAllowed
			? null
			: c.json(
					{
						error: `The key's owner no longer holds the access required for ${scope} in this organization`,
					},
					403,
				),
}));

vi.mock("../helpers", () => ({
	resolveV1Context: async () => ({
		userId: "user-example",
		organizationId: "org-example",
	}),
	notFound: (resource: string) => ({
		error: { message: `${resource} not found` },
	}),
	ok: (data: unknown) => ({ data }),
}));

const { registerAgentRoutes } = await import("../agents");

function request() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "personal",
			keyId: "key-example",
			keyPrefix: "fab_example",
			userId: "user-example",
			organizationId: undefined,
			scopes: ["agents:execute"],
		});
		await next();
	});
	registerAgentRoutes(
		app as unknown as Parameters<typeof registerAgentRoutes>[0],
	);
	return app.request("/agents/agent-example/execute", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ input: { prompt: "Example" } }),
	});
}

beforeEach(() => {
	mocks.ownerPermissionAllowed = true;
	mocks.findAgent.mockReset().mockResolvedValue({
		agentId: "agent-example",
		framework: "LANGGRAPH",
		status: "ACTIVE",
	});
	mocks.createAgentTask.mockReset().mockResolvedValue({ id: "task-example" });
	mocks.start.mockReset().mockResolvedValue({
		workflowId: "agent-execution-task-example",
		firstExecutionRunId: "run-example",
	});
});

describe("POST /agents/:id/execute", () => {
	it("refuses a viewer's personal key before creating an agent task", async () => {
		mocks.ownerPermissionAllowed = false;

		const response = await request();

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "The key's owner no longer holds the access required for agents:execute in this organization",
		});
		expect(mocks.createAgentTask).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("allows a member's personal key to execute an agent", async () => {
		const response = await request();

		expect(response.status).toBe(202);
		expect(mocks.createAgentTask).toHaveBeenCalledOnce();
		expect(mocks.start).toHaveBeenCalledOnce();
	});
});
