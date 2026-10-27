import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workflowStart: vi.fn(), log: vi.fn() }));
vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: mocks.log,
}));

import { startParlumeRecap } from "../recap";

function alreadyStarted(): Error {
	const error = new Error("Workflow execution already started");
	error.name = "WorkflowExecutionAlreadyStartedError";
	return error;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.workflowStart.mockResolvedValue({});
});

describe("startParlumeRecap", () => {
	it("starts one recap per session under an id a closed run still holds", async () => {
		await startParlumeRecap("s1");

		expect(mocks.workflowStart).toHaveBeenCalledExactlyOnceWith(
			"parlumeRecapWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId: "parlume-recap-s1",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				args: [{ sessionId: "s1" }],
			},
		);
	});

	it("treats a second start for the same session as done", async () => {
		mocks.workflowStart
			.mockResolvedValueOnce({})
			.mockRejectedValueOnce(alreadyStarted());

		await startParlumeRecap("s1");
		await expect(startParlumeRecap("s1")).resolves.toBeUndefined();

		const ids = mocks.workflowStart.mock.calls.map(
			([, options]) => options.workflowId,
		);
		expect(ids).toEqual(["parlume-recap-s1", "parlume-recap-s1"]);
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("logs a failed start without throwing", async () => {
		mocks.workflowStart.mockRejectedValue(
			new Error("Temporal unavailable"),
		);

		await expect(startParlumeRecap("s1")).resolves.toBeUndefined();

		expect(mocks.log).toHaveBeenCalledWith("warn", "recap.start_failed", {
			sessionId: "s1",
			error: "Temporal unavailable",
		});
	});
});
