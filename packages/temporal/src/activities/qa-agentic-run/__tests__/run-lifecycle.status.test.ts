/**
 * What status a finished agentic run gets.
 *
 * The first real run on staging came back `PASSED` with 0 passed, 0 failed and 1
 * blocked: every case had died at sign-in and the run still showed green. The
 * derivation was `failed > 0 ? FAILED : PASSED`, so `blocked` — computed and
 * stored right beside it — never influenced the verdict.
 *
 * That is the failure the enum's own wording rules out: PASSED means "every case
 * reached a verdict and none failed", and a blocked case reaches no verdict. It
 * is also the mistake REFUSED exists to prevent, in the opposite direction —
 * reading "nothing was tested" as a test result.
 *
 * These pin the derivation directly, which is why the module's DB and logging
 * dependencies are stubbed rather than exercised: the thing under test is which
 * status `finishAgenticRun` is called with.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Only the field these cases assert on; the real input carries more. */
type FinishCall = { status: string };

const finishAgenticRun = vi.fn(async (_input: FinishCall) => true);

vi.mock("@repo/database", () => ({
	AGENTIC_RUN_PROVIDER: "FABRIC_AGENTIC",
	attachAgenticStepLogs: vi.fn(async () => ({ attached: 0 })),
	finishAgenticRun: (input: FinishCall) => finishAgenticRun(input),
	getProjectQaSettings: vi.fn(async () => null),
	ingestPipelineRun: vi.fn(async () => ({ pipelineRunId: "pr_1" })),
	listCasesForAgenticRun: vi.fn(async () => []),
	markAgenticRunStarted: vi.fn(async () => true),
	recordAgenticCaseProgress: vi.fn(async () => undefined),
	recordFindingsForRun: vi.fn(async () => ({ created: 0 })),
	// persistAgenticRun resolves who triggered the run so the history can say
	// so; null keeps these tests about run STATUS, which is their subject.
	resolveAgenticRunActor: vi.fn(async () => null),
	resolveEnvironmentAuth: vi.fn(async () => null),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { RunAgenticCaseResult } from "../run-case";
import { persistAgenticRun } from "../run-lifecycle";

function caseResult(
	result: "PASSED" | "FAILED" | "BLOCKED" | "NEEDS_REVIEW",
	id: string,
): RunAgenticCaseResult {
	return {
		testCaseId: id,
		result,
		failureMessage:
			result === "PASSED" ? null : `${result} because reasons`,
		durationMs: 10,
		steps: [],
		modelCalls: 1,
	};
}

async function statusFor(
	results: RunAgenticCaseResult[],
	skipped: Array<{ testCaseId: string; reason: string }> = [],
): Promise<string | undefined> {
	finishAgenticRun.mockClear();
	await persistAgenticRun({
		projectId: "p1",
		organizationId: "o1",
		userId: "u1",
		runId: "r1",
		targetBaseUrl: "https://staging.example.com",
		startedAtMs: 1_700_000_000_000,
		results,
		skipped,
		costPerModelCallUsd: 0.01,
	});
	return finishAgenticRun.mock.calls[0]?.[0]?.status;
}

describe("persistAgenticRun — a run that verified nothing is not green", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("is BLOCKED when the only case was blocked", async () => {
		// The exact shape of the first real staging run.
		expect(await statusFor([caseResult("BLOCKED", "c1")])).toBe("BLOCKED");
	});

	it("is BLOCKED when a case was blocked alongside a pass", async () => {
		expect(
			await statusFor([
				caseResult("PASSED", "c1"),
				caseResult("BLOCKED", "c2"),
			]),
		).toBe("BLOCKED");
	});

	it("is BLOCKED when every case was skipped for having no steps", async () => {
		expect(
			await statusFor([], [{ testCaseId: "c1", reason: "no steps" }]),
		).toBe("BLOCKED");
	});

	it("is FAILED when a case failed, even alongside a block", async () => {
		// A real disagreement with the product outranks "could not attempt".
		expect(
			await statusFor([
				caseResult("FAILED", "c1"),
				caseResult("BLOCKED", "c2"),
			]),
		).toBe("FAILED");
	});

	it("is NEEDS_REVIEW when every case needed review", async () => {
		// The most ordinary way to reach the state, and it was wrong when the
		// status first shipped: `passed === 0` — a proxy for "nothing was
		// established", written when SKIPPED was the only way to get there —
		// evaluated first and swallowed it, so a run entirely awaiting review
		// reported BLOCKED and the new status was unreachable on its own.
		expect(
			await statusFor([
				caseResult("NEEDS_REVIEW", "c1"),
				caseResult("NEEDS_REVIEW", "c2"),
			]),
		).toBe("NEEDS_REVIEW");
	});

	it("is NEEDS_REVIEW when a case needed review alongside a pass", async () => {
		expect(
			await statusFor([
				caseResult("PASSED", "c1"),
				caseResult("NEEDS_REVIEW", "c2"),
			]),
		).toBe("NEEDS_REVIEW");
	});

	it("is BLOCKED, not NEEDS_REVIEW, when a case also never ran", async () => {
		// A case that reached no verdict because it could not be attempted
		// outranks one that ran inconclusively: the first says the runner could
		// not do its job, which is the more urgent fact.
		expect(
			await statusFor([
				caseResult("NEEDS_REVIEW", "c1"),
				caseResult("BLOCKED", "c2"),
			]),
		).toBe("BLOCKED");
	});

	it("is FAILED, not NEEDS_REVIEW, when a case actually failed", async () => {
		// A real disagreement with the product is a failed run whatever else it
		// holds — an uncertain verdict elsewhere does not soften it.
		expect(
			await statusFor([
				caseResult("NEEDS_REVIEW", "c1"),
				caseResult("FAILED", "c2"),
			]),
		).toBe("FAILED");
	});

	it("is PASSED when every case passed", async () => {
		expect(
			await statusFor([
				caseResult("PASSED", "c1"),
				caseResult("PASSED", "c2"),
			]),
		).toBe("PASSED");
	});

	it("stays PASSED when some cases passed and others were only skipped", async () => {
		// Skips are surfaced separately; they do not erase real passes.
		expect(
			await statusFor(
				[caseResult("PASSED", "c1")],
				[{ testCaseId: "c2", reason: "no steps" }],
			),
		).toBe("PASSED");
	});
});
