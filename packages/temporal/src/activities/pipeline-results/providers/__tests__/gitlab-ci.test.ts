import { describe, expect, it } from "vitest";
import {
	type GitlabPipeline,
	type GitlabTestReport,
	mapGitlabCiToNormalizedRuns,
} from "../gitlab-ci";

// A completed pipeline that produced a test report (named, 16.3+ style).
const passedPipeline: GitlabPipeline = {
	id: 4001,
	name: "Nightly E2E",
	ref: "main",
	sha: "abc123def456",
	web_url: "https://gitlab.com/acme/app/-/pipelines/4001",
	status: "failed",
	created_at: "2026-07-24T10:00:00.000Z",
	updated_at: "2026-07-24T10:05:30.000Z",
	duration: 330,
};

// A pipeline with no test report attached (e.g. still running / no reports job).
const runningPipeline: GitlabPipeline = {
	id: 4002,
	ref: "feature/checkout",
	sha: "feed0042",
	web_url: "https://gitlab.com/acme/app/-/pipelines/4002",
	status: "running",
	created_at: "2026-07-24T11:00:00.000Z",
	updated_at: "2026-07-24T11:01:00.000Z",
	duration: null,
};

const report4001: GitlabTestReport = {
	total_count: 3,
	test_suites: [
		{
			name: "checkout",
			test_cases: [
				{
					name: "applies a discount code",
					classname: "spec.checkout_spec",
					status: "success",
					execution_time: 1.5,
					system_output: null,
				},
				{
					name: "rejects an expired card",
					classname: "spec.checkout_spec",
					status: "failed",
					execution_time: 0.25,
					system_output: "expected 402 but got 500",
				},
				{
					name: "supports Apple Pay",
					classname: "spec.checkout_spec",
					status: "skipped",
					execution_time: 0,
					system_output: null,
				},
			],
		},
	],
};

describe("mapGitlabCiToNormalizedRuns", () => {
	it("maps two pipelines — one with a test report, one without", () => {
		const runs = mapGitlabCiToNormalizedRuns({
			pipelines: [passedPipeline, runningPipeline],
			testReportByPipelineId: { "4001": report4001 },
		});

		expect(runs).toHaveLength(2);

		// --- Pipeline 1: run-level fields ---
		const [withReport, noReport] = runs;
		expect(withReport).toMatchObject({
			provider: "gitlab-ci",
			externalRunId: "4001",
			pipelineName: "Nightly E2E", // name wins over ref
			branch: "main",
			commitSha: "abc123def456",
			runUrl: "https://gitlab.com/acme/app/-/pipelines/4001",
			status: "failed",
			durationMs: 330_000, // 330s * 1000
		});
		expect(withReport.startedAt).toEqual(
			new Date("2026-07-24T10:00:00.000Z"),
		);
		expect(withReport.finishedAt).toEqual(
			new Date("2026-07-24T10:05:30.000Z"),
		);

		// --- Pipeline 1: per-test results ---
		expect(withReport.results).toEqual([
			{
				name: "applies a discount code",
				classname: "spec.checkout_spec",
				rawStatus: "success",
				durationMs: 1500,
				failureMessage: undefined,
			},
			{
				name: "rejects an expired card",
				classname: "spec.checkout_spec",
				rawStatus: "failed",
				durationMs: 250,
				failureMessage: "expected 402 but got 500",
			},
			{
				name: "supports Apple Pay",
				classname: "spec.checkout_spec",
				rawStatus: "skipped",
				durationMs: 0,
				failureMessage: undefined,
			},
		]);

		// --- Pipeline 2: no report, no duration ---
		expect(noReport).toMatchObject({
			provider: "gitlab-ci",
			externalRunId: "4002",
			pipelineName: "feature/checkout", // falls back to ref (no name)
			branch: "feature/checkout",
			commitSha: "feed0042",
			status: "running",
		});
		expect(noReport.results).toEqual([]);
		expect(noReport.durationMs).toBeUndefined();
	});

	it("captures the pipeline user as the triggering actor", () => {
		const [run] = mapGitlabCiToNormalizedRuns({
			pipelines: [
				{
					id: 5001,
					ref: "main",
					sha: "cafebabe",
					web_url: "https://gitlab.com/acme/store/-/pipelines/5001",
					status: "failed",
					created_at: "2026-07-25T10:00:00Z",
					updated_at: "2026-07-25T10:01:00Z",
					duration: 42,
					user: {
						username: "alice",
						name: "Alice A",
						avatar_url: "https://gl/alice",
					},
				},
			],
		});
		expect(run.triggeredByActor).toBe("alice");
		expect(run.triggeredByActorAvatarUrl).toBe("https://gl/alice");
	});

	it("returns an empty array for no pipelines", () => {
		expect(mapGitlabCiToNormalizedRuns({ pipelines: [] })).toEqual([]);
	});
});
