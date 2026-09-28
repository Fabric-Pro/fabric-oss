/**
 * What Temporal's answer about a Glossy build run means (Fizzy #2589, KTD4).
 *
 * Only `gone` lets `get` read a stuck holder as failed and lets `build` take
 * its claim over, so every doubtful answer must come out `unknown`, never
 * `gone`: a paused run, a state this code does not name, an error, and a
 * question Temporal does not answer in time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const describeRun = vi.fn();
const getTemporalClient = vi.fn();

vi.mock("@repo/database", () => ({
	claimGlossyBuild: vi.fn(),
	releaseGlossyClaim: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/temporal", () => ({
	GLOSSY_EDITION_TASK_QUEUE: "glossy-edition",
	getTemporalClient: () => getTemporalClient(),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(options: T) => options,
}));

const { GLOSSY_LIVENESS_TIMEOUT_MS, glossyRunLiveness } = await import(
	"../dispatch-glossy-build"
);

beforeEach(() => {
	describeRun.mockReset();
	getTemporalClient.mockReset();
	getTemporalClient.mockResolvedValue({
		workflow: { getHandle: () => ({ describe: () => describeRun() }) },
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("glossyRunLiveness", () => {
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

		expect(await glossyRunLiveness("wf-1")).toBe(expected);
	});

	it("reads a run Temporal has never heard of as gone", async () => {
		const notFound = new Error("workflow not found");
		notFound.name = "WorkflowNotFoundError";
		describeRun.mockRejectedValue(notFound);

		expect(await glossyRunLiveness("wf-1")).toBe("gone");
	});

	it("reads any other error, and an unreachable client, as unknown", async () => {
		describeRun.mockRejectedValue(new Error("connection reset"));
		expect(await glossyRunLiveness("wf-1")).toBe("unknown");

		getTemporalClient.mockRejectedValue(new Error("no connection"));
		expect(await glossyRunLiveness("wf-1")).toBe("unknown");
	});

	it("gives up after the timeout and reads a run Temporal does not answer about as unknown", async () => {
		vi.useFakeTimers();
		describeRun.mockReturnValue(new Promise(() => {}));

		const answer = glossyRunLiveness("wf-1");
		await vi.advanceTimersByTimeAsync(GLOSSY_LIVENESS_TIMEOUT_MS);

		expect(await answer).toBe("unknown");
	});

	it("asks nothing without a workflow id", async () => {
		expect(await glossyRunLiveness(null)).toBe("unknown");
		expect(getTemporalClient).not.toHaveBeenCalled();
	});
});
