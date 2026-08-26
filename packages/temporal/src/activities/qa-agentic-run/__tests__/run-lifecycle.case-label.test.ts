/**
 * What an agentic failure is CALLED in the results and findings it writes.
 *
 * Found on staging the moment the runner started producing findings at all: a
 * finding from an agentic run rendered its heading as `cmrmp2ow100000i9eyuzasigf`
 * — the test case's raw cuid — sitting beside CI findings that show their test
 * name. The detail underneath was correct; only the thing a reader scans was
 * unreadable. Nobody could have seen it before, because no agentic run had ever
 * got far enough to produce a finding.
 *
 * The fingerprint is deliberately NOT changed with it. Identity for an agentic
 * failure is the case, and a case may be renamed without becoming a different
 * failure — fingerprinting the label would orphan a finding's history and open a
 * duplicate on every rename.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Typed on the argument, so the recorded call has an element to read back. */
const ingestPipelineRun = vi.fn(
	async (_input: { matched: Array<{ testName: string }> }) => ({
		pipelineRunId: "pr_1",
	}),
);
const recordFindingsForRun = vi.fn(
	async (_input: {
		failures: Array<{ testName: string; fingerprint: string }>;
	}) => ({ created: 1 }),
);

vi.mock("@repo/database", () => ({
	AGENTIC_RUN_PROVIDER: "FABRIC_AGENTIC",
	attachAgenticStepLogs: vi.fn(async () => ({ attached: 0 })),
	finishAgenticRun: vi.fn(async () => true),
	getProjectQaSettings: vi.fn(async () => null),
	ingestPipelineRun: (i: unknown) => ingestPipelineRun(i as never),
	listCasesForAgenticRun: vi.fn(async () => []),
	markAgenticRunStarted: vi.fn(async () => true),
	recordAgenticCaseProgress: vi.fn(async () => undefined),
	// persistAgenticRun resolves the triggering user's display name so the run
	// history can say who ran it; null here keeps these tests about their own
	// subject rather than about attribution.
	resolveAgenticRunActor: vi.fn(async () => null),
	recordFindingsForRun: (i: unknown) => recordFindingsForRun(i as never),
	resolveEnvironmentAuth: vi.fn(async () => null),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { RunAgenticCaseResult } from "../run-case";
import { persistAgenticRun } from "../run-lifecycle";

const FAILED: RunAgenticCaseResult = {
	testCaseId: "cmrmp2ow100000i9eyuzasigf",
	result: "FAILED",
	failureMessage: "Step 1 — expected: a green button",
	durationMs: 10,
	steps: [],
	modelCalls: 2,
};

async function persist(caseLabels?: Record<string, string>) {
	await persistAgenticRun({
		projectId: "p1",
		organizationId: "o1",
		userId: "u1",
		runId: "r1",
		targetBaseUrl: "https://staging.example.com",
		startedAtMs: 1_700_000_000_000,
		results: [FAILED],
		skipped: [],
		costPerModelCallUsd: 0.01,
		...(caseLabels ? { caseLabels } : {}),
	});
	const ingested = ingestPipelineRun.mock.calls.at(-1);
	const recorded = recordFindingsForRun.mock.calls.at(-1);
	if (!ingested || !recorded) {
		throw new Error("persistAgenticRun did not reach ingestion");
	}
	return { matched: ingested[0].matched, failures: recorded[0].failures };
}

beforeEach(() => {
	ingestPipelineRun.mockClear();
	recordFindingsForRun.mockClear();
});

describe("agentic case labels", () => {
	it("names a finding after the case, not its cuid", async () => {
		const { failures } = await persist({
			[FAILED.testCaseId]:
				"TC-001 Primary buttons render new green accent",
		});

		expect(failures[0].testName).toBe(
			"TC-001 Primary buttons render new green accent",
		);
		expect(failures[0].testName).not.toContain(FAILED.testCaseId);
	});

	it("labels the ingested result too, so the run detail reads the same", async () => {
		const { matched } = await persist({
			[FAILED.testCaseId]:
				"TC-001 Primary buttons render new green accent",
		});

		expect(matched[0].testName).toBe(
			"TC-001 Primary buttons render new green accent",
		);
	});

	it("keeps the fingerprint keyed on the case id, so a rename cannot orphan history", async () => {
		const first = await persist({
			[FAILED.testCaseId]: "TC-001 Old title",
		});
		const renamed = await persist({
			[FAILED.testCaseId]: "TC-001 A completely different title",
		});

		expect(renamed.failures[0].fingerprint).toBe(
			first.failures[0].fingerprint,
		);
	});

	it("keeps the fingerprint stable when the model rewords the same failure", async () => {
		// The defect this guards, found on staging 2026-07-27. TC-001 failed at
		// the same step on the same expectation three times and produced THREE
		// findings, each "Seen 1 time", because `fingerprintFinding` hashed the
		// failure message and an agentic message is model prose that is reworded
		// on every run. The upsert therefore took the CREATE branch every time:
		// duplicates without bound, `occurrences` frozen at 1, and the
		// name-refresh-on-recurrence fix (#2346) unreachable.
		//
		// The sibling test above could not catch it — it varies the label while
		// holding the message constant, which is the one field that breaks this.
		const first = await persist({ [FAILED.testCaseId]: "TC-001 Buttons" });

		const reworded: RunAgenticCaseResult = {
			...FAILED,
			failureMessage:
				'Step 1 — expected: a green button. Observed: the ARIA snapshot provides no computed style for any button (e.g. "Continue"), so there is no evidence.',
		};
		await persistAgenticRun({
			projectId: "p1",
			organizationId: "o1",
			userId: "u1",
			runId: "r2",
			targetBaseUrl: "https://staging.example.com",
			startedAtMs: 1_700_000_000_000,
			results: [reworded],
			skipped: [],
			costPerModelCallUsd: 0.01,
			caseLabels: { [FAILED.testCaseId]: "TC-001 Buttons" },
		});
		const second = recordFindingsForRun.mock.calls.at(-1);
		if (!second) {
			throw new Error("persistAgenticRun did not reach ingestion");
		}

		expect(second[0].failures[0].fingerprint).toBe(
			first.failures[0].fingerprint,
		);
	});

	it("falls back to the id when no label is supplied", async () => {
		// A workflow already in flight when this shipped carries no labels; it
		// must still persist, with exactly the old behaviour.
		const { failures } = await persist();

		expect(failures[0].testName).toBe(FAILED.testCaseId);
	});
});
