import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	execute: vi.fn(),
	get: vi.fn(),
	context: vi.fn(),
	scope: vi.fn(),
}));
vi.mock("../../external-api/procedures/execute-agent", () => ({
	executeAgent: h.execute,
}));
vi.mock("../../agent-deployments/lib/run-commands", () => ({
	getAgentRunCommand: (_actor: unknown, input: { executionId: string }) =>
		h.get(input.executionId),
	listAgentRunCommand: vi.fn(),
	cancelAgentRunCommand: vi.fn(),
	readAgentRunScheduleCommand: vi.fn(),
	scheduleAgentRunCommand: vi.fn(),
}));
vi.mock("../../external-api/procedures/get-execution", () => ({
	getExecution: h.get,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) => async (_c: unknown, next: () => Promise<void>) => {
			h.scope(scope);
			await next();
		},
}));
vi.mock("../helpers", () => ({
	resolveV1Context: h.context,
	ok: (data: unknown) => ({ data }),
}));

import { registerAgentInstanceRoutes } from "../agent-instances";

const app = new Hono();
app.use("*", async (c, next) => {
	c.set(
		"externalApiContext" as never,
		{
			userId: "example-user",
			organizationId: "example-org",
			scopes: ["agents:execute"],
		} as never,
	);
	await next();
});
registerAgentInstanceRoutes(
	app as unknown as Parameters<typeof registerAgentInstanceRoutes>[0],
);
const request = (body: unknown, headers: Record<string, string> = {}) =>
	app.request("http://example.com/agent-instances/example-instance/invoke", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
beforeEach(() => {
	vi.clearAllMocks();
	h.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	h.execute.mockResolvedValue({
		data: {
			executionId: "example-execution",
			status: "PENDING",
			admissionStatus: "CONFIRMED",
		},
		status: 202,
	});
	h.get.mockResolvedValue({
		executionId: "example-execution",
		output: { verified: true },
	});
});
describe("saved instance REST contract", () => {
	it("honors a stable standard request header and returns an actual receipt", async () => {
		const response = await request(
			{ input: { message: "Example" } },
			{ "Idempotency-Key": "example-request" },
		);
		expect(response.status).toBe(202);
		expect(h.execute).toHaveBeenCalledWith(
			"example-instance",
			expect.objectContaining({ idempotencyKey: "example-request" }),
			expect.objectContaining({ organizationId: "example-org" }),
		);
		expect(h.scope).toHaveBeenCalledWith("agents:execute");
	});
	it("preserves structured unresolved error.data for SDK recovery", async () => {
		h.execute.mockResolvedValue({
			error: {
				code: "ADMISSION_UNRESOLVED",
				message: "Unknown",
				data: { executionId: "example-execution", retryable: true },
			},
			status: 503,
		});
		const response = await request({
			input: {},
			idempotencyKey: "example-key",
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: {
				code: "ADMISSION_UNRESOLVED",
				data: { executionId: "example-execution" },
			},
		});
	});
	it.each([
		{ input: [], idempotencyKey: "example" },
		{ input: {}, idempotencyKey: "" },
		{ input: {}, stream: true },
	])(
		"refuses malformed or unsupported input before invocation",
		async (body) => {
			expect((await request(body)).status).toBe(400);
			expect(h.execute).not.toHaveBeenCalled();
		},
	);
	it("rejects disagreeing body/header request keys before side effects", async () => {
		expect(
			(
				await request(
					{ input: {}, idempotencyKey: "one" },
					{ "Idempotency-Key": "two" },
				)
			).status,
		).toBe(400);
		expect(h.execute).not.toHaveBeenCalled();
	});
	it("fails closed when no organization is resolved", async () => {
		h.context.mockResolvedValue({
			userId: "example-user",
			organizationId: null,
		});
		expect((await request({ input: {} })).status).toBe(403);
		expect(h.execute).not.toHaveBeenCalled();
	});
	it("exposes polling through the independent read scope", async () => {
		const response = await app.request(
			"http://example.com/agent-executions/example-execution",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { output: { verified: true } },
		});
		expect(h.scope).toHaveBeenCalledWith("agents:read");
	});
});
