import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workflowStart: vi.fn() }));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

import { warmParlumeRuntime } from "../warm";

const fetchMock = vi.fn();

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.workflowStart.mockResolvedValue({});
	fetchMock.mockResolvedValue(Response.json({ warm: true }));
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("warmParlumeRuntime", () => {
	it("starts the worker warm-up for the session on the worker queue", async () => {
		await warmParlumeRuntime({
			origin: "https://fabric.example",
			sessionId: "s1",
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeWarmupWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId: "parlume-warmup-s1",
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [{ sessionId: "s1" }],
			},
		);
	});

	it("asks the turns route to open its connections, with the service credential", async () => {
		await warmParlumeRuntime({
			origin: "https://fabric.example",
			sessionId: "s1",
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://fabric.example/api/internal/parlume/turns?sessionId=s1",
		);
		expect(init).toMatchObject({
			method: "GET",
			headers: { "X-Agent-Service-Token": "service-secret" },
		});
	});

	it("never throws, whichever half fails", async () => {
		mocks.workflowStart.mockRejectedValue(
			new Error("Temporal unavailable"),
		);
		fetchMock.mockRejectedValue(new Error("Timed out"));
		await expect(
			warmParlumeRuntime({
				origin: "https://fabric.example",
				sessionId: "s1",
			}),
		).resolves.toBeUndefined();
	});

	it("still starts the worker warm-up when the service credential is missing", async () => {
		delete process.env.AGENT_SERVICE_SECRET;
		await warmParlumeRuntime({
			origin: "https://fabric.example",
			sessionId: "s1",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
});
