import { ServiceError } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	scope: vi.fn(),
	admission: vi.fn(),
	attach: vi.fn(),
	client: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	project: vi.fn(),
	deadline: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getAgentTemplateInstanceForExecution: h.scope,
	readAgentExecutionAdmission: h.admission,
	attachAgentExecutionReceipt: h.attach,
	getProjectAccessContext: h.project,
	isProjectSoftDeleted: async () => false,
}));
vi.mock("@repo/temporal", () => ({ getTemporalClient: h.client }));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T extends object>(value: T) => ({
		...value,
		memo: {
			...(value as { memo?: object }).memo,
			correlationId: "example-correlation",
		},
	}),
}));

import { dispatchAdmittedAgentExecution } from "../dispatch-execution";

const row = {
	id: "example-execution",
	executionId: "example-channel",
	deploymentId: "example-deployment",
	userId: "example-user",
	organizationId: "example-org",
	input: { message: "Example" },
	metadata: {},
	workflowId: "example-workflow",
	runId: null,
	status: "PENDING",
	output: null,
};
const admission = {
	receiptOwner: "workflow",
	requestHash: "a".repeat(64),
	dispatch: {
		instanceId: "example-instance",
		workflowType: "nativeDeploymentExecutionWorkflow",
	},
	imageRefs: [],
};
const description = () => ({
	type: admission.dispatch.workflowType,
	runId: "example-run",
	memo: {
		fabricAgentAdmission: {
			version: 1,
			executionId: row.id,
			organizationId: row.organizationId,
			userId: row.userId,
			requestHash: admission.requestHash,
		},
	},
});
const rpcError = (code: number) =>
	new ServiceError("Synthetic RPC failure", {
		cause: Object.assign(new Error("status"), {
			code,
			details: "status",
			metadata: {},
		}),
	});
beforeEach(() => {
	vi.clearAllMocks();
	h.scope.mockResolvedValue({ instance: { customInstructions: {} } });
	h.admission.mockReturnValue(admission);
	h.attach.mockResolvedValue({ ...row, runId: "example-run" });
	h.deadline.mockImplementation((_at, fn) => fn());
	h.client.mockResolvedValue({
		connection: { withDeadline: h.deadline },
		workflow: {
			start: h.start,
			getHandle: () => ({ describe: h.describe }),
		},
	});
	h.start.mockResolvedValue({ firstExecutionRunId: "example-run" });
	h.describe.mockResolvedValue(description());
});
describe("Temporal-owned execution dispatch", () => {
	it("uses native running-ID reuse and closed-ID rejection, with workflow-owned projection", async () => {
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			confirmed: true,
			execution: { runId: "example-run", status: "PENDING" },
		});
		expect(h.start).toHaveBeenCalledWith(
			"nativeDeploymentExecutionWorkflow",
			expect.objectContaining({
				workflowId: row.workflowId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "USE_EXISTING",
				memo: expect.objectContaining({
					correlationId: "example-correlation",
				}),
				args: [
					expect.objectContaining({
						nativeAdmission: {
							version: 1,
							executionRowId: row.id,
							requestHash: admission.requestHash,
						},
						organizationId: row.organizationId,
					}),
				],
			}),
		);
		expect(h.attach).not.toHaveBeenCalled();
	});
	it("reconnects natively after a lost start response without starting another job", async () => {
		h.start.mockRejectedValueOnce(rpcError(14));
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			confirmed: true,
		});
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.describe).toHaveBeenCalledOnce();
		expect(h.attach).not.toHaveBeenCalled();
	});
	it("reconciles wrapped ALREADY_EXISTS from retained closed history", async () => {
		h.start.mockRejectedValueOnce(rpcError(6));
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			confirmed: true,
		});
		expect(h.attach).not.toHaveBeenCalled();
	});
	it("does not make API acceptance depend on a database projection write", async () => {
		h.attach.mockRejectedValue(
			new Error("Projection temporarily unavailable"),
		);
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			confirmed: true,
		});
		expect(h.attach).not.toHaveBeenCalled();
	});
	it("leaves an unknown start unconfirmed without declaring failure", async () => {
		h.start.mockRejectedValueOnce(rpcError(14));
		h.describe.mockRejectedValueOnce(rpcError(14));
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			confirmed: false,
			reason: "temporal_unavailable",
			execution: { status: "PENDING" },
		});
	});
	it("classifies wrapped NOT_FOUND without calling it a Temporal outage", async () => {
		h.describe.mockRejectedValueOnce(rpcError(5));
		expect(
			await dispatchAdmittedAgentExecution(row, { observeOnly: true }),
		).toMatchObject({ confirmed: false, reason: "workflow_unconfirmed" });
		expect(h.start).not.toHaveBeenCalled();
	});
	it("verifies the memo of a running workflow returned by USE_EXISTING", async () => {
		h.describe.mockResolvedValue({
			...description(),
			memo: {
				fabricAgentAdmission: {
					...description().memo.fabricAgentAdmission,
					organizationId: "example-other-org",
				},
			},
		});
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			confirmed: false,
			recoverable: false,
			reason: "identity_mismatch",
		});
		expect(h.attach).not.toHaveBeenCalled();
	});
	it("never blindly starts an older ambiguous intent after history has expired", async () => {
		h.admission.mockReturnValue({ ...admission, receiptOwner: undefined });
		h.describe.mockRejectedValueOnce(rpcError(5));
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			confirmed: false,
			recoverable: false,
			reason: "legacy_start_unconfirmed",
		});
		expect(h.start).not.toHaveBeenCalled();
	});
	it("can reconnect to a paused deployment without starting work", async () => {
		expect(
			await dispatchAdmittedAgentExecution(row, { allowStart: false }),
		).toMatchObject({ confirmed: true });
		expect(h.start).not.toHaveBeenCalled();
	});
	it("only explicit compatibility repair writes the old receipt projection", async () => {
		expect(
			await dispatchAdmittedAgentExecution(row, { observeOnly: true }),
		).toMatchObject({ confirmed: true });
		expect(h.start).not.toHaveBeenCalled();
		expect(h.attach).toHaveBeenCalledOnce();
	});
	it("checks current actor permissions before native lookup", async () => {
		h.scope.mockResolvedValue(null);
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			revoked: true,
		});
		expect(h.client).not.toHaveBeenCalled();
	});
	it("refuses pending project rebinding before start or lookup", async () => {
		h.scope.mockResolvedValue({
			instance: { customInstructions: {} },
			projectId: "example-new-project",
		});
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			revoked: true,
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.describe).not.toHaveBeenCalled();
	});
	it("reconnects completed work only with current and originally admitted grants", async () => {
		h.admission.mockReturnValue({
			...admission,
			dispatch: {
				...admission.dispatch,
				projectId: "example-old-project",
			},
		});
		h.scope.mockResolvedValue({
			instance: { customInstructions: {} },
			projectId: "example-new-project",
		});
		h.project.mockResolvedValue({ organizationId: row.organizationId });
		expect(
			await dispatchAdmittedAgentExecution({
				...row,
				status: "COMPLETED",
			}),
		).toMatchObject({ confirmed: true });
		expect(h.start).not.toHaveBeenCalled();
		h.project.mockResolvedValue(null);
		expect(
			await dispatchAdmittedAgentExecution({
				...row,
				status: "COMPLETED",
			}),
		).toMatchObject({ revoked: true });
	});
	it("starts the lookup deadline after permission database work", async () => {
		vi.useFakeTimers();
		try {
			const before = Date.now();
			h.scope.mockImplementationOnce(async () => {
				await vi.advanceTimersByTimeAsync(5000);
				return { instance: { customInstructions: {} } };
			});
			await dispatchAdmittedAgentExecution(row);
			expect(h.deadline).toHaveBeenCalledWith(
				before + 8000,
				expect.any(Function),
			);
		} finally {
			vi.useRealTimers();
		}
	});
	it("does not invent a native identity for a missing admission", async () => {
		h.admission.mockReturnValue(null);
		expect(await dispatchAdmittedAgentExecution(row)).toMatchObject({
			confirmed: false,
			recoverable: false,
			reason: "missing_admission",
		});
		expect(h.client).not.toHaveBeenCalled();
	});
});
