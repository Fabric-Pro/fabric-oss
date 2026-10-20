/**
 * How a Glossy build asks whether its stuck holder's run is gone (Fizzy
 * #2589). The answer itself — every status, error and the time bound — is
 * the shared probe's, pinned in `workflow-run-liveness.test.ts`; what is the
 * build's own is that it asks through the shared Temporal client, inside the
 * probe's bound, and asks nothing about a holder without a workflow id.
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

const { glossyRunLiveness } = await import("../dispatch-glossy-build");
const { WORKFLOW_RUN_LIVENESS_TIMEOUT_MS } = await import(
	"../workflow-run-liveness"
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
	it("asks the shared Temporal client about the holder's run", async () => {
		describeRun.mockResolvedValue({ status: { name: "TIMED_OUT" } });
		expect(await glossyRunLiveness("wf-1")).toBe("gone");

		describeRun.mockResolvedValue({ status: { name: "PAUSED" } });
		expect(await glossyRunLiveness("wf-1")).toBe("running");
	});

	it("reads an unreachable client as unknown", async () => {
		getTemporalClient.mockRejectedValue(new Error("no connection"));
		expect(await glossyRunLiveness("wf-1")).toBe("unknown");
	});

	it("bounds the client's connection by the probe's timeout", async () => {
		vi.useFakeTimers();
		getTemporalClient.mockReturnValue(new Promise(() => {}));

		const answer = glossyRunLiveness("wf-1");
		await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_LIVENESS_TIMEOUT_MS);

		expect(await answer).toBe("unknown");
	});

	it("asks nothing without a workflow id", async () => {
		expect(await glossyRunLiveness(null)).toBe("unknown");
		expect(getTemporalClient).not.toHaveBeenCalled();
	});
});
