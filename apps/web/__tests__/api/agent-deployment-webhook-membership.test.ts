import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	trigger: vi.fn(),
	member: vi.fn(),
	quota: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	signal: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	checkExecutionQuota: mocks.quota,
	isDeploymentOwnerCurrentMember: mocks.member,
	db: {
		agentDeploymentTrigger: {
			findFirst: mocks.trigger,
			update: mocks.update,
		},
		agentDeploymentExecution: { create: mocks.create },
	},
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: mocks.signal }) },
	}),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKeyMaybe: (value: string) => value,
}));

import { POST } from "../../app/api/webhooks/agent/[...path]/route";

const deployment = {
	id: "deployment-example",
	userId: "owner-example",
	organizationId: "example-org",
	status: "ACTIVE",
	supervisorWorkflowId: "supervisor-example",
};

async function post() {
	return POST(
		new Request("https://example.com/api/webhooks/agent/example", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}) as never,
		{ params: Promise.resolve({ path: ["example"] }) },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.trigger.mockResolvedValue({
		id: "trigger-example",
		deploymentId: deployment.id,
		deployment,
		isActive: true,
		config: { requireAuth: false },
	});
	mocks.member.mockResolvedValue(true);
	mocks.quota.mockResolvedValue({ allowed: true });
	mocks.create.mockResolvedValue({ id: "execution-example" });
});

it("returns the unknown webhook response for a removed owner without queueing", async () => {
	mocks.member.mockResolvedValue(false);
	const response = await post();
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "Webhook not found" });
	expect(mocks.create).not.toHaveBeenCalled();
	expect(mocks.signal).not.toHaveBeenCalled();
});

it("hides a removed owner's trigger before checking its signature", async () => {
	mocks.member.mockResolvedValue(false);
	mocks.trigger.mockResolvedValue({
		id: "trigger-example",
		deploymentId: deployment.id,
		deployment,
		isActive: true,
		config: { requireAuth: true },
	});
	const response = await post();
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "Webhook not found" });
});

it("rechecks membership immediately before queueing", async () => {
	mocks.member.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
	const response = await post();
	expect(response.status).toBe(404);
	expect(mocks.create).not.toHaveBeenCalled();
});

it("fails closed when membership cannot be read", async () => {
	mocks.member.mockRejectedValue(new Error("lookup failed"));
	const response = await post();
	expect(response.status).toBe(500);
	expect(mocks.create).not.toHaveBeenCalled();
	expect(mocks.signal).not.toHaveBeenCalled();
});

it("queues a current member's webhook", async () => {
	const response = await post();
	expect(response.status).toBe(200);
	expect(mocks.member).toHaveBeenCalledWith(deployment);
	expect(mocks.create).toHaveBeenCalledTimes(1);
	expect(mocks.signal).toHaveBeenCalledTimes(1);
});
