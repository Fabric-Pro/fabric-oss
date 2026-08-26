import { describe, expect, it } from "vitest";
import {
	type GithubWorkflowRun,
	type JUnitSuite,
	mapGithubActionsToNormalizedRuns,
} from "../github-actions";

// Two realistic workflow runs: a completed CI run with a JUnit report
// (pass + fail + skipped) and a nightly run that uploaded no JUnit artifact.
const workflowRuns: GithubWorkflowRun[] = [
	{
		id: 15234567890,
		name: "CI",
		head_branch: "main",
		head_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334",
		html_url: "https://github.com/acme/fabric/actions/runs/15234567890",
		status: "completed",
		conclusion: "failure",
		run_started_at: "2024-05-01T12:00:00Z",
		updated_at: "2024-05-01T12:05:30Z",
	},
	{
		id: 15234567999,
		name: "Nightly E2E",
		head_branch: "release/2.0",
		head_sha: "f9e8d7c6b5a40312837465afbecd0918273645ff",
		html_url: "https://github.com/acme/fabric/actions/runs/15234567999",
		status: "completed",
		conclusion: "success",
		run_started_at: "2024-05-01T02:00:00Z",
		updated_at: "2024-05-01T02:10:00Z",
	},
];

const junitByRunId: Record<string, JUnitSuite[]> = {
	"15234567890": [
		{
			name: "auth.spec.ts",
			testcases: [
				{
					name: "logs in with valid credentials",
					classname: "Auth",
					time: 0.42,
					status: "passed",
				},
				{
					name: "rejects an expired token",
					classname: "Auth",
					time: 1.5,
					status: "failed",
					failureMessage: "expected 401 but received 500",
				},
				{
					name: "supports SSO login",
					classname: "Auth",
					time: 0,
					status: "skipped",
				},
			],
		},
	],
};

describe("mapGithubActionsToNormalizedRuns", () => {
	const runs = mapGithubActionsToNormalizedRuns({
		workflowRuns,
		junitByRunId,
	});

	it("maps one workflow run to one NormalizedRun", () => {
		expect(runs).toHaveLength(2);
	});

	it("captures the triggering actor (who ran), preferring triggering_actor", () => {
		const [run] = mapGithubActionsToNormalizedRuns({
			workflowRuns: [
				{
					id: 99,
					head_sha: "deadbeef",
					html_url: "https://github.com/acme/store/actions/runs/99",
					triggering_actor: {
						login: "alice",
						avatar_url: "https://avatars/alice",
					},
					actor: { login: "bob" },
				},
			],
		});
		expect(run.triggeredByActor).toBe("alice");
		expect(run.triggeredByActorAvatarUrl).toBe("https://avatars/alice");
	});

	it("maps run-level metadata field-by-field (JUnit-backed run)", () => {
		const run = runs[0];
		expect(run.provider).toBe("github-actions");
		expect(run.externalRunId).toBe("15234567890");
		expect(run.pipelineName).toBe("CI");
		expect(run.branch).toBe("main");
		expect(run.commitSha).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f9001122334");
		expect(run.runUrl).toBe(
			"https://github.com/acme/fabric/actions/runs/15234567890",
		);
		// conclusion wins over the lifecycle status.
		expect(run.status).toBe("failure");
		expect(run.startedAt).toEqual(new Date("2024-05-01T12:00:00Z"));
		expect(run.finishedAt).toEqual(new Date("2024-05-01T12:05:30Z"));
		// wall-clock: 5m30s → 330_000 ms.
		expect(run.durationMs).toBe(330_000);
	});

	it("maps each JUnit testcase to a NormalizedTestResult (raw status + ms + failure text)", () => {
		expect(runs[0].results).toEqual([
			{
				name: "logs in with valid credentials",
				classname: "Auth",
				rawStatus: "passed",
				durationMs: 420,
				failureMessage: undefined,
			},
			{
				name: "rejects an expired token",
				classname: "Auth",
				rawStatus: "failed",
				durationMs: 1500,
				failureMessage: "expected 401 but received 500",
			},
			{
				name: "supports SSO login",
				classname: "Auth",
				rawStatus: "skipped",
				durationMs: 0,
				failureMessage: undefined,
			},
		]);
	});

	it("ingests a run with no JUnit data as a run-level record with results: []", () => {
		const run = runs[1];
		expect(run.provider).toBe("github-actions");
		expect(run.externalRunId).toBe("15234567999");
		expect(run.pipelineName).toBe("Nightly E2E");
		expect(run.branch).toBe("release/2.0");
		expect(run.commitSha).toBe("f9e8d7c6b5a40312837465afbecd0918273645ff");
		expect(run.runUrl).toBe(
			"https://github.com/acme/fabric/actions/runs/15234567999",
		);
		expect(run.status).toBe("success");
		expect(run.startedAt).toEqual(new Date("2024-05-01T02:00:00Z"));
		expect(run.finishedAt).toEqual(new Date("2024-05-01T02:10:00Z"));
		expect(run.durationMs).toBe(600_000);
		expect(run.results).toEqual([]);
	});

	it("falls back to the lifecycle status when the run has no conclusion yet", () => {
		const [run] = mapGithubActionsToNormalizedRuns({
			workflowRuns: [
				{
					id: 42,
					name: "CI",
					head_branch: null,
					head_sha: "deadbeef",
					html_url: "https://github.com/acme/fabric/actions/runs/42",
					status: "in_progress",
					conclusion: null,
					run_started_at: "2024-05-01T12:00:00Z",
					updated_at: "2024-05-01T12:00:00Z",
				},
			],
		});
		expect(run.status).toBe("in_progress");
		// null head_branch normalizes to undefined; no JUnit → empty results.
		expect(run.branch).toBeUndefined();
		expect(run.durationMs).toBe(0);
		expect(run.results).toEqual([]);
	});
});
