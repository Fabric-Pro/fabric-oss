import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	trigger: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	signal: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentDeploymentTrigger: { findFirst: m.trigger, update: m.update },
		agentDeploymentExecution: { create: m.create },
	},
	checkExecutionQuota: async () => ({ allowed: true }),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: m.signal }) },
	}),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKeyMaybe: (value: string) => value,
}));

import { POST } from "@/app/api/webhooks/agent/[...path]/route";

beforeEach(() => {
	vi.clearAllMocks();
	m.trigger.mockResolvedValue({
		id: "example-trigger",
		deploymentId: "example-deployment",
		isActive: true,
		config: { requireAuth: false },
		deployment: {
			id: "example-deployment",
			status: "ACTIVE",
			userId: "example-user",
			organizationId: "example-org",
			supervisorWorkflowId: "example-supervisor",
		},
	});
	m.create.mockImplementation(async ({ data }: { data: object }) => ({
		id: "example-row",
		...data,
	}));
});
it("signals the webhook execution UUID while keeping response and trigger row IDs", async () => {
	const response = await POST(
		new NextRequest("http://example.com/api/webhooks/agent/example", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "Example task" }),
		}),
		{ params: Promise.resolve({ path: ["example"] }) },
	);
	expect(response.status).toBe(200);
	const row = await m.create.mock.results[0].value;
	expect(m.signal).toHaveBeenCalledWith(
		"execute",
		expect.objectContaining({ executionId: row.executionId }),
	);
	expect(row.executionId).not.toBe(row.id);
	expect(await response.json()).toMatchObject({
		success: true,
		executionId: "example-row",
	});
	expect(m.update).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ lastExecutionId: "example-row" }),
		}),
	);
});
