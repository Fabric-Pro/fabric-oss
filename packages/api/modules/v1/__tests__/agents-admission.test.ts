import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	agent: vi.fn(),
	create: vi.fn(),
	receipt: vi.fn(),
	unresolved: vi.fn(),
	client: vi.fn(),
	start: vi.fn(),
	context: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { agent: { findFirst: m.agent } },
	createAgentTask: m.create,
	updateAgentTaskWorkflow: m.receipt,
	markAgentTaskAdmissionUnresolved: m.unresolved,
	getAgentById: vi.fn(),
	listAgents: vi.fn(),
}));
vi.mock("@repo/temporal", () => ({ getTemporalClient: m.client }));
vi.mock("../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) =>
		next(),
	requireV1OwnerPermission: async () => null,
}));
vi.mock("../helpers", () => ({
	resolveV1Context: m.context,
	ok: (data: unknown) => ({ data }),
	notFound: (name: string) => ({ error: { message: `${name} not found` } }),
}));

import { registerAgentRoutes } from "../agents";

const app = new Hono();
registerAgentRoutes(
	app as unknown as Parameters<typeof registerAgentRoutes>[0],
);
const invoke = () =>
	app.request("http://example.com/agents/example-agent/execute", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ input: { message: "Example task" } }),
	});
beforeEach(() => {
	vi.clearAllMocks();
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	m.agent.mockResolvedValue({
		agentId: "example-agent",
		status: "ACTIVE",
		framework: "example",
	});
	m.create.mockResolvedValue({ id: "example-task" });
	m.client.mockResolvedValue({ workflow: { start: m.start } });
	m.start.mockResolvedValue({
		workflowId: "agent-execution-example-task",
		firstExecutionRunId: "example-run",
	});
	m.receipt.mockResolvedValue({});
	m.unresolved.mockResolvedValue({ count: 1 });
});
describe("honest registered-agent background capability", () => {
	it("refuses unsupported background execution before creating a task or contacting Temporal", async () => {
		const response = await invoke();
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "AGENT_EXECUTION_UNSUPPORTED" },
		});
		expect(m.create).not.toHaveBeenCalled();
		expect(m.client).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
	it("rejects missing organization before agent or workflow access", async () => {
		m.context.mockResolvedValue({ userId: "example-user" });
		expect((await invoke()).status).toBe(403);
		expect(m.agent).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	});
	it("does not disclose an agent outside the authorized lookup", async () => {
		m.agent.mockResolvedValue(null);
		expect((await invoke()).status).toBe(404);
		expect(m.create).not.toHaveBeenCalled();
	});
});
