import { describe, expect, it } from "vitest";
import { mapXrayToNormalizedRuns, type XrayTestExecution } from "../jira-xray";

// A realistic two-execution payload: one finished execution with a PASSED, a
// FAILED, and a TODO test run, plus a second still-running execution with an
// EXECUTING run (and no finish timestamp) to exercise the undefined paths.
const testExecutions: XrayTestExecution[] = [
	{
		key: "PROJ-123",
		summary: "Nightly automated regression",
		testEnvironments: ["chrome", "staging"],
		revision: "build-1042",
		version: "2.7.0",
		self: "https://acme.atlassian.net/browse/PROJ-123",
		startedOn: "2026-07-24T02:00:00.000Z",
		finishedOn: "2026-07-24T02:05:00.000Z",
		testRuns: [
			{
				testKey: "PROJ-1",
				testSummary: "Login succeeds",
				status: "PASSED",
				startedOn: "2026-07-24T02:00:00.000Z",
				finishedOn: "2026-07-24T02:00:03.000Z",
				comment: "Successful execution.",
			},
			{
				testKey: "PROJ-2",
				testSummary: "Password reset emails the user",
				status: "FAILED",
				startedOn: "2026-07-24T02:00:03.000Z",
				finishedOn: "2026-07-24T02:00:12.500Z",
				comment: "Expected a reset email but none was sent.",
				defects: ["PROJ-900"],
			},
			{
				// No summary, no timestamps — a not-yet-run test in the execution.
				testKey: "PROJ-3",
				status: "TODO",
			},
		],
	},
	{
		key: "PROJ-200",
		summary: "Smoke — in progress",
		self: "https://acme.atlassian.net/browse/PROJ-200",
		startedOn: "2026-07-24T09:00:00.000Z",
		testRuns: [
			{
				testKey: "PROJ-1",
				status: "EXECUTING",
				startedOn: "2026-07-24T09:00:00.000Z",
			},
		],
	},
];

describe("mapXrayToNormalizedRuns", () => {
	it("maps each Test Execution to a NormalizedRun and each test run to a NormalizedTestResult", () => {
		const runs = mapXrayToNormalizedRuns({ testExecutions });

		expect(runs).toHaveLength(2);

		const [nightly] = runs;

		// ── Run-level fields for the finished execution ──────────────────────
		expect(nightly.provider).toBe("jira-xray");
		expect(nightly.externalRunId).toBe("PROJ-123");
		expect(nightly.pipelineName).toBe("Nightly automated regression");
		// Xray exposes no git ref on a Test Execution.
		expect(nightly.branch).toBeUndefined();
		expect(nightly.commitSha).toBeUndefined();
		expect(nightly.runUrl).toBe(
			"https://acme.atlassian.net/browse/PROJ-123",
		);
		expect(nightly.startedAt).toEqual(new Date("2026-07-24T02:00:00.000Z"));
		expect(nightly.finishedAt).toEqual(
			new Date("2026-07-24T02:05:00.000Z"),
		);
		expect(nightly.durationMs).toBe(5 * 60 * 1000);
		expect(nightly.results).toHaveLength(3);

		// ── PASSED test run ──────────────────────────────────────────────────
		expect(nightly.results[0]).toEqual({
			name: "PROJ-1 Login succeeds",
			classname: "PROJ-1",
			rawStatus: "PASSED",
			durationMs: 3000,
			failureMessage: "Successful execution.",
		});

		// ── FAILED test run ──────────────────────────────────────────────────
		expect(nightly.results[1]).toEqual({
			name: "PROJ-2 Password reset emails the user",
			classname: "PROJ-2",
			rawStatus: "FAILED",
			durationMs: 9500,
			failureMessage: "Expected a reset email but none was sent.",
		});

		// ── TODO test run — no summary, no timestamps, no comment ────────────
		expect(nightly.results[2]).toEqual({
			name: "PROJ-3",
			classname: "PROJ-3",
			rawStatus: "TODO",
			durationMs: undefined,
			failureMessage: undefined,
		});
	});

	it("leaves run duration/finishedAt undefined for a still-running execution and passes the raw status through", () => {
		const [, smoke] = mapXrayToNormalizedRuns({ testExecutions });

		expect(smoke.externalRunId).toBe("PROJ-200");
		expect(smoke.startedAt).toEqual(new Date("2026-07-24T09:00:00.000Z"));
		expect(smoke.finishedAt).toBeUndefined();
		expect(smoke.durationMs).toBeUndefined();

		// The RAW Xray token survives untouched — the shared status-mapper, not
		// this provider, decides EXECUTING → BLOCKED.
		expect(smoke.results[0].rawStatus).toBe("EXECUTING");
		expect(smoke.results[0].durationMs).toBeUndefined();
	});

	it("returns an empty array for no executions", () => {
		expect(mapXrayToNormalizedRuns({ testExecutions: [] })).toEqual([]);
	});
});
