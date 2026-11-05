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
	incrementInstanceRunCount: vi.fn(),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: m.signal }) },
	}),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKeyMaybe: (value: string) => value,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		input: () => chain,
		handler: (run: unknown) => ({ _handler: run }),
	};
	return {
		publicProcedure: chain,
		Permissions: { AGENT_EXECUTE: "execute" },
		requirePermission: () => () => {},
	};
});

import { handleWebhookProcedure } from "../webhook-handler";

beforeEach(() => {
	vi.clearAllMocks();
	m.trigger.mockResolvedValue({
		id: "example-trigger",
		deploymentId: "example-deployment",
		isActive: true,
		config: { requireAuth: false },
		deployment: {
			id: "example-deployment",
			instanceId: "example-instance",
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
it("signals the webhook execution UUID while retaining row IDs in the response and trigger foreign key", async () => {
	const invoke = (
		handleWebhookProcedure as unknown as {
			_handler: (value: unknown) => Promise<{ executionId: string }>;
		}
	)._handler;
	const result = await invoke({
		input: {
			webhookUrl: "/api/webhooks/agent/example",
			payload: { message: "Example task" },
		},
	});
	const row = await m.create.mock.results[0].value;
	expect(m.signal).toHaveBeenCalledWith(
		"execute",
		expect.objectContaining({ executionId: row.executionId }),
	);
	expect(row.executionId).not.toBe(row.id);
	expect(result.executionId).toBe("example-row");
	expect(m.update).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ lastExecutionId: "example-row" }),
		}),
	);
});
