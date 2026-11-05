import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	list: vi.fn(),
	claim: vi.fn(),
	admission: vi.fn(),
	dispatch: vi.fn(),
	heartbeat: vi.fn(),
	warn: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	listAgentExecutionReceiptCandidates: h.list,
	claimAgentExecutionReceiptObservation: h.claim,
	readAgentExecutionAdmission: h.admission,
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: h.heartbeat,
	Context: {
		current: () => {
			throw new Error("outside activity");
		},
	},
}));
vi.mock("@repo/logs", () => ({ logger: { warn: h.warn } }));
vi.mock("../../lib/agent-execution-dispatch", () => ({
	dispatchAdmittedAgentExecution: h.dispatch,
}));

import { recoverAgentExecutionReceipts } from "../agent-execution-receipt-recovery";

const row = {
	id: "example-execution",
	userId: "example-user",
	organizationId: "example-org",
	status: "PENDING",
	metadata: {},
	deployment: {
		userId: "example-user",
		organizationId: "example-org",
		instanceId: "example-instance",
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	h.list.mockResolvedValue([row]);
	h.claim.mockResolvedValue(true);
	h.admission.mockReturnValue({
		dispatch: { instanceId: "example-instance" },
	});
	h.dispatch.mockResolvedValue({ confirmed: true });
});
describe("saved-agent periodic receipt observation", () => {
	it("uses observe-only dispatch after scoped CAS", async () => {
		expect(await recoverAgentExecutionReceipts()).toEqual({
			scanned: 1,
			recovered: 1,
			unresolved: 0,
			refused: 0,
			skipped: 0,
		});
		expect(h.list).toHaveBeenCalledWith({
			limit: 25,
			before: expect.any(Date),
		});
		expect(h.dispatch).toHaveBeenCalledWith(row, { observeOnly: true });
	});
	it("skips concurrent worker changes before contacting Temporal", async () => {
		h.claim.mockResolvedValue(false);
		expect(await recoverAgentExecutionReceipts()).toMatchObject({
			skipped: 1,
		});
		expect(h.dispatch).not.toHaveBeenCalled();
	});
	it.each([
		{ deployment: { ...row.deployment, userId: "example-other" } },
		{
			deployment: {
				...row.deployment,
				organizationId: "example-other-org",
			},
		},
		{
			deployment: {
				...row.deployment,
				instanceId: "example-other-instance",
			},
		},
		{ organizationId: null },
	])("refuses a changed deployment boundary %#", async (change) => {
		h.list.mockResolvedValue([{ ...row, ...change }]);
		expect(await recoverAgentExecutionReceipts()).toMatchObject({
			refused: 1,
		});
		expect(h.dispatch).not.toHaveBeenCalled();
	});
	it("does not interpret a legacy or malformed snapshot as restart permission", async () => {
		h.admission.mockReturnValue(null);
		expect(await recoverAgentExecutionReceipts()).toMatchObject({
			refused: 1,
		});
		expect(h.dispatch).not.toHaveBeenCalled();
	});
	it("continues past missing histories and RPC failures without declaring failed work", async () => {
		h.list.mockResolvedValue([row, { ...row, id: "example-next" }]);
		h.dispatch.mockResolvedValueOnce({
			confirmed: false,
			reason: "temporal_unavailable",
		});
		expect(await recoverAgentExecutionReceipts()).toMatchObject({
			scanned: 2,
			recovered: 1,
			unresolved: 1,
		});
		expect(h.heartbeat).toHaveBeenCalledTimes(2);
		expect(h.heartbeat.mock.calls[0]?.[0]).toMatchObject({
			recovered: 0,
			unresolved: 0,
		});
		expect(h.warn).toHaveBeenCalledWith(
			{
				event: "agent.receipt_recovery.failed",
				stage: "temporal_unavailable",
			},
			expect.any(String),
		);
	});
	it("counts a failed observation claim as uninspected and logs no raw content", async () => {
		h.claim.mockRejectedValueOnce(new Error("example-private-content"));
		expect(await recoverAgentExecutionReceipts()).toMatchObject({
			skipped: 1,
			unresolved: 0,
		});
		expect(h.dispatch).not.toHaveBeenCalled();
		expect(h.warn).toHaveBeenCalledWith(
			{
				event: "agent.receipt_recovery.failed",
				stage: "observation_claim",
			},
			expect.any(String),
		);
		expect(JSON.stringify(h.warn.mock.calls)).not.toContain(
			"example-private-content",
		);
	});
	it("distinguishes permission/storage errors before inspection from uncertain remote work", async () => {
		h.dispatch.mockRejectedValueOnce(new Error("example-private-content"));
		expect(await recoverAgentExecutionReceipts()).toMatchObject({
			skipped: 1,
			unresolved: 0,
		});
		expect(h.warn).toHaveBeenCalledWith(
			{
				event: "agent.receipt_recovery.failed",
				stage: "authorization_or_storage",
			},
			expect.any(String),
		);
	});
	it("records refusal and uncertainty separately", async () => {
		h.list.mockResolvedValue([row, { ...row, id: "example-next" }]);
		h.dispatch
			.mockResolvedValueOnce({ confirmed: false, revoked: true })
			.mockResolvedValueOnce({ confirmed: false });
		expect(await recoverAgentExecutionReceipts()).toMatchObject({
			refused: 1,
			unresolved: 1,
		});
	});
});
