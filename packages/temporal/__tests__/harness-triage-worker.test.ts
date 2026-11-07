import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("@temporalio/activity", async (original) => ({
	...(await original<typeof import("@temporalio/activity")>()),
	Context: { current: state.current },
}));

import { createHarnessTriageActivities } from "../src/lib/harness-triage-worker";

const input = {
	runId: "example-run",
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
	expiresAt: "2030-01-01T00:00:00.000Z",
};
const host = { execute: vi.fn(), failed: vi.fn(), purge: vi.fn() };
beforeEach(() => {
	vi.resetAllMocks();
	state.current.mockReturnValue({
		info: {
			attempt: 1,
			workflowExecution: {
				workflowId: "example-workflow",
				runId: "example-native-run",
			},
		},
		cancellationSignal: new AbortController().signal,
		heartbeat: vi.fn(),
	});
});

describe("private triage native activity boundary", () => {
	it("passes native identity and cancellation to the trusted host", async () => {
		host.execute.mockResolvedValue({
			runId: input.runId,
			status: "COMPLETED",
		});
		await expect(
			createHarnessTriageActivities(host).executeHarnessTriage(input),
		).resolves.toEqual({ runId: input.runId, status: "COMPLETED" });
		expect(host.execute).toHaveBeenCalledWith(
			input,
			"example-workflow",
			"example-native-run",
			expect.any(AbortSignal),
		);
	});
	it("uses native retries without serializing a private host error", async () => {
		host.execute.mockRejectedValue(
			Error("EXAMPLE_PRIVATE_SOURCE_DO_NOT_PERSIST"),
		);
		await expect(
			createHarnessTriageActivities(host).executeHarnessTriage(input),
		).rejects.toMatchObject({
			type: "TRIAGE_UNAVAILABLE",
			nonRetryable: false,
			message: "Private signal review is temporarily unavailable.",
		});
		expect(host.failed).not.toHaveBeenCalled();
	});
	it("records final failure without leaking a failure-recording exception", async () => {
		state.current().info.attempt = 3;
		host.execute.mockRejectedValue(Error("EXAMPLE_PRIVATE_MODEL_ERROR"));
		host.failed.mockRejectedValue(Error("EXAMPLE_PRIVATE_DATABASE_VALUE"));
		await expect(
			createHarnessTriageActivities(host).executeHarnessTriage(input),
		).rejects.toMatchObject({
			type: "TRIAGE_UNAVAILABLE",
			message: "Private signal review is temporarily unavailable.",
		});
		expect(host.failed).toHaveBeenCalledOnce();
	});
	it("does not retry revoked access", async () => {
		host.execute.mockRejectedValue(
			Object.assign(Error("EXAMPLE_PRIVATE_ACCESS"), {
				code: "FORBIDDEN",
			}),
		);
		await expect(
			createHarnessTriageActivities(host).executeHarnessTriage(input),
		).rejects.toMatchObject({
			type: "TRIAGE_ACCESS_UNAVAILABLE",
			nonRetryable: true,
		});
		expect(host.failed).toHaveBeenCalledOnce();
	});
	it("sanitizes retention failures before Temporal records them", async () => {
		host.purge.mockRejectedValue(Error("EXAMPLE_PRIVATE_SQL"));
		await expect(
			createHarnessTriageActivities(
				host,
			).purgeExpiredHarnessTriageContent(),
		).rejects.toMatchObject({
			type: "TRIAGE_RETENTION_UNAVAILABLE",
			message: "Private review cleanup is temporarily unavailable.",
		});
	});
	it("rejects an activity without a native workflow identity", async () => {
		state.current().info.workflowExecution = undefined;
		await expect(
			createHarnessTriageActivities(host).executeHarnessTriage(input),
		).rejects.toMatchObject({
			type: "TRIAGE_WORKFLOW_REQUIRED",
			nonRetryable: true,
		});
		expect(host.execute).not.toHaveBeenCalled();
	});
});
