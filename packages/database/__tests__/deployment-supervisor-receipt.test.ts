import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	read: vi.fn(),
	claim: vi.fn(),
	final: vi.fn(),
	quota: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		$transaction: async (run: (tx: unknown) => unknown) =>
			run({
				agentDeployment: {
					findUnique: h.read,
					updateMany: h.claim,
					findUniqueOrThrow: h.final,
				},
				organizationDeploymentQuota: { update: h.quota },
			}),
	},
}));

import { setDeploymentSupervisor } from "../prisma/queries/agent-deployments/deployments";

const receipt = {
	id: "example-deployment",
	organizationId: "example-org",
	supervisorWorkflowId: "example-workflow",
	supervisorRunId: "example-run",
	status: "PAUSED",
};
const invoke = () =>
	setDeploymentSupervisor(
		receipt.id,
		receipt.supervisorWorkflowId,
		receipt.supervisorRunId,
		"agents",
	);
beforeEach(() => {
	vi.clearAllMocks();
	h.read.mockResolvedValue({ ...receipt, supervisorRunId: null });
	h.claim.mockResolvedValue({ count: 1 });
	h.final.mockResolvedValue(receipt);
});
describe("atomic deployment supervisor receipt", () => {
	it("charges only a successfully claimed first receipt without changing lifecycle status", async () => {
		expect(await invoke()).toEqual(receipt);
		expect(h.quota).toHaveBeenCalledOnce();
		expect(h.claim.mock.calls[0][0].data).not.toHaveProperty("status");
	});
	it("reattaches an identical persisted receipt without another quota charge", async () => {
		h.read.mockResolvedValue(receipt);
		await invoke();
		expect(h.claim).not.toHaveBeenCalled();
		expect(h.quota).not.toHaveBeenCalled();
	});
	it("does not charge the loser of a concurrent identical claim", async () => {
		h.claim.mockResolvedValue({ count: 0 });
		await invoke();
		expect(h.quota).not.toHaveBeenCalled();
	});
	it("rejects a conflicting receipt that won a concurrent claim", async () => {
		h.claim.mockResolvedValue({ count: 0 });
		h.final.mockResolvedValue({
			...receipt,
			supervisorRunId: "example-other-run",
		});
		await expect(invoke()).rejects.toThrow("conflicts");
		expect(h.quota).not.toHaveBeenCalled();
	});
	it("rejects a previously admitted different run", async () => {
		h.read.mockResolvedValue({
			...receipt,
			supervisorRunId: "example-other-run",
		});
		await expect(invoke()).rejects.toThrow("conflicts");
		expect(h.quota).not.toHaveBeenCalled();
	});
});
