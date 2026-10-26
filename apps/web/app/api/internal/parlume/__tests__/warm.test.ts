import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workflowStart: vi.fn(), grant: vi.fn() }));
vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("@repo/api/lib/agent-service-auth", () => ({
	mintParlumeActingGrantForTurn: mocks.grant,
}));

import { warmParlumeRuntime } from "../warm";

const fetchMock = vi.fn();

const warming = {
	origin: "https://fabric.example",
	session: {
		id: "s1",
		userId: "u1",
		organizationId: "o1",
		projectId: "p1",
		toolsReadOnly: true,
	},
};

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.workflowStart.mockResolvedValue({});
	mocks.grant.mockReturnValue("grant-1");
	fetchMock.mockResolvedValue(Response.json({ warm: true }));
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("warmParlumeRuntime", () => {
	it("starts the worker warm-up for the session on the worker queue, with the turn's grant", async () => {
		await warmParlumeRuntime(warming);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeWarmupWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId: "parlume-warmup-s1",
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [{ sessionId: "s1", actingGrant: "grant-1" }],
			},
		);
		expect(mocks.grant).toHaveBeenCalledWith({
			userId: "u1",
			organizationId: "o1",
			projectId: "p1",
			readOnly: true,
		});
	});

	it("asks the turns route to open its connections, with the service credential", async () => {
		await warmParlumeRuntime(warming);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://fabric.example/api/internal/parlume/turns?sessionId=s1",
		);
		expect(init).toMatchObject({
			method: "GET",
			headers: { "X-Agent-Service-Token": "service-secret" },
		});
	});

	it("loads the Fabric MCP gateway the first turn lists its tools from", async () => {
		await warmParlumeRuntime(warming);
		expect(
			fetchMock.mock.calls.map(([url, init]) => [
				String(url),
				init.method,
			]),
		).toContainEqual(["https://fabric.example/api/mcp-gateway", "GET"]);
	});

	it("never throws, whichever half fails", async () => {
		mocks.workflowStart.mockRejectedValue(
			new Error("Temporal unavailable"),
		);
		fetchMock.mockRejectedValue(new Error("Timed out"));
		await expect(warmParlumeRuntime(warming)).resolves.toBeUndefined();
	});

	it("still starts the worker warm-up when the service credential is missing", async () => {
		delete process.env.AGENT_SERVICE_SECRET;
		mocks.grant.mockReturnValue(undefined);
		await warmParlumeRuntime(warming);
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			"https://fabric.example/api/mcp-gateway",
		]);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
});
