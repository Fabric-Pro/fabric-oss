/**
 * What Temporal's answer about a run means, for every caller that lets a new
 * run take over only once the old one is gone: a Glossy build's stuck-claim
 * reclaim and a client-document Proposal's join of its live run (Fizzy
 * #2589, #2946).
 *
 * Only `gone` lets a caller take over, so every doubtful answer must come out
 * `unknown`, never `gone`: a paused run, a state this code does not name, an
 * error, a client that cannot connect, and a question Temporal does not
 * answer in time.
 */
import { WorkflowNotFoundError } from "@temporalio/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	WORKFLOW_RUN_LIVENESS_TIMEOUT_MS,
	workflowRunLiveness,
} from "../workflow-run-liveness";

const describeRun = vi.fn();
const getHandle = vi.fn();

type Client = Parameters<typeof workflowRunLiveness>[0];

function client(): Client {
	return { workflow: { getHandle } } as unknown as Client;
}

beforeEach(() => {
	describeRun.mockReset();
	getHandle.mockReset();
	getHandle.mockReturnValue({ describe: () => describeRun() });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("workflowRunLiveness", () => {
	it.each([
		["RUNNING", "running"],
		["PAUSED", "running"],
		["COMPLETED", "gone"],
		["FAILED", "gone"],
		["CANCELLED", "gone"],
		["TERMINATED", "gone"],
		["CONTINUED_AS_NEW", "gone"],
		["TIMED_OUT", "gone"],
		["UNSPECIFIED", "unknown"],
		["UNKNOWN", "unknown"],
	])("reads a run reported %s as %s", async (status, expected) => {
		describeRun.mockResolvedValue({ status: { name: status } });

		expect(await workflowRunLiveness(client(), "wf-1")).toBe(expected);
		expect(getHandle).toHaveBeenCalledWith("wf-1");
	});

	it("reads a run Temporal has never heard of as gone", async () => {
		describeRun.mockRejectedValue(
			new WorkflowNotFoundError("Workflow not found", "wf-1", undefined),
		);
		expect(await workflowRunLiveness(client(), "wf-1")).toBe("gone");

		// By name, so a caller whose mocks carry another copy of the class
		// reads it the same way.
		const named = new Error("workflow not found");
		named.name = "WorkflowNotFoundError";
		describeRun.mockRejectedValue(named);
		expect(await workflowRunLiveness(client(), "wf-1")).toBe("gone");
	});

	it("reads any other error, a falsy rejection and an unreachable client as unknown", async () => {
		describeRun.mockRejectedValue(new Error("connection reset"));
		expect(await workflowRunLiveness(client(), "wf-1")).toBe("unknown");

		describeRun.mockRejectedValue(undefined);
		expect(await workflowRunLiveness(client(), "wf-1")).toBe("unknown");

		expect(
			await workflowRunLiveness(
				Promise.reject(new Error("no connection")),
				"wf-1",
			),
		).toBe("unknown");
	});

	it("gives up after the timeout and reads a run Temporal does not answer about as unknown", async () => {
		vi.useFakeTimers();
		describeRun.mockReturnValue(new Promise(() => {}));

		const answer = workflowRunLiveness(client(), "wf-1");
		await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_LIVENESS_TIMEOUT_MS);

		expect(await answer).toBe("unknown");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds a client that never connects by the same timeout", async () => {
		vi.useFakeTimers();

		const answer = workflowRunLiveness(new Promise(() => {}), "wf-1");
		await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_LIVENESS_TIMEOUT_MS);

		expect(await answer).toBe("unknown");
		expect(getHandle).not.toHaveBeenCalled();
	});
});
