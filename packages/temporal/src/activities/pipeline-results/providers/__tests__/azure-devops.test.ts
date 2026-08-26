import { describe, expect, it } from "vitest";
import {
	type AdoTestResult,
	type AdoTestRun,
	AZURE_DEVOPS_PROVIDER,
	mapAzureDevOpsToNormalizedRuns,
} from "../azure-devops";

describe("mapAzureDevOpsToNormalizedRuns", () => {
	// Run 42: completed on main, has per-test results (Passed + Failed +
	// NotExecuted + Blocked). Run 43: an in-progress run with no results entry.
	const runs: AdoTestRun[] = [
		{
			id: 42,
			name: "CI · nightly-e2e",
			state: "Completed",
			startedDate: "2026-07-24T10:00:00Z",
			completedDate: "2026-07-24T10:12:30Z",
			build: { id: "9001", name: "20260724.3" },
			buildConfiguration: {
				branchName: "refs/heads/main",
				sourceVersion: "abc123def456",
			},
			webAccessUrl:
				"https://dev.azure.com/acme/portal/_TestManagement/Runs?runId=42",
			totalTests: 4,
			passedTests: 1,
			owner: {
				displayName: "Alice Anderson",
				imageUrl: "https://ado/alice.png",
			},
		},
		{
			id: 43,
			name: "CI · smoke",
			state: "InProgress",
			startedDate: "2026-07-24T11:00:00Z",
		},
	];

	const resultsByRunId: Record<string, AdoTestResult[]> = {
		"42": [
			{
				id: 100000,
				automatedTestName:
					"portal.checkout.CheckoutSpec.appliesDiscount",
				testCaseTitle: "applies discount",
				automatedTestStorage: "portal.checkout.dll",
				outcome: "Passed",
				durationInMs: 812,
			},
			{
				id: 100001,
				automatedTestName:
					"portal.checkout.CheckoutSpec.rejectsExpiredCard",
				testCaseTitle: "rejects expired card",
				automatedTestStorage: "portal.checkout.dll",
				outcome: "Failed",
				durationInMs: 1503,
				errorMessage: "Expected 402 but received 200",
			},
			{
				// No automatedTestName — falls back to testCaseTitle for the name.
				testCaseTitle: "settles refunds nightly",
				automatedTestStorage: "portal.billing.dll",
				outcome: "NotExecuted",
			},
			{
				id: 100003,
				automatedTestName: "portal.billing.BillingSpec.reconciles",
				automatedTestStorage: "portal.billing.dll",
				outcome: "Blocked",
				durationInMs: 0,
				errorMessage: "Upstream ledger unavailable",
			},
		],
	};

	const normalized = mapAzureDevOpsToNormalizedRuns({ runs, resultsByRunId });

	it("captures the run owner as the triggering actor (who ran)", () => {
		expect(normalized[0].triggeredByActor).toBe("Alice Anderson");
		expect(normalized[0].triggeredByActorAvatarUrl).toBe(
			"https://ado/alice.png",
		);
	});

	it("maps two runs and preserves order", () => {
		expect(normalized).toHaveLength(2);
		expect(normalized.map((r) => r.externalRunId)).toEqual(["42", "43"]);
	});

	it("maps run-level fields from the ADO Test Run", () => {
		const run = normalized[0];
		expect(run.provider).toBe(AZURE_DEVOPS_PROVIDER);
		expect(run.provider).toBe("azure-devops");
		expect(run.externalRunId).toBe("42");
		expect(run.pipelineName).toBe("CI · nightly-e2e");
		expect(run.branch).toBe("refs/heads/main");
		expect(run.commitSha).toBe("abc123def456");
		expect(run.runUrl).toBe(
			"https://dev.azure.com/acme/portal/_TestManagement/Runs?runId=42",
		);
		expect(run.status).toBe("Completed");
		expect(run.startedAt).toEqual(new Date("2026-07-24T10:00:00Z"));
		expect(run.finishedAt).toEqual(new Date("2026-07-24T10:12:30Z"));
	});

	it("passes each ADO outcome token through RAW as rawStatus (no conversion)", () => {
		const outcomes = normalized[0].results.map((r) => r.rawStatus);
		expect(outcomes).toEqual([
			"Passed",
			"Failed",
			"NotExecuted",
			"Blocked",
		]);
	});

	it("maps a passed result field-by-field", () => {
		expect(normalized[0].results[0]).toEqual({
			name: "portal.checkout.CheckoutSpec.appliesDiscount",
			classname: "portal.checkout.dll",
			rawStatus: "Passed",
			durationMs: 812,
		});
	});

	it("maps a failed result including the error message", () => {
		expect(normalized[0].results[1]).toEqual({
			name: "portal.checkout.CheckoutSpec.rejectsExpiredCard",
			classname: "portal.checkout.dll",
			rawStatus: "Failed",
			durationMs: 1503,
			failureMessage: "Expected 402 but received 200",
		});
	});

	it("falls back to testCaseTitle when automatedTestName is absent, and omits duration", () => {
		const notExecuted = normalized[0].results[2];
		expect(notExecuted).toEqual({
			name: "settles refunds nightly",
			classname: "portal.billing.dll",
			rawStatus: "NotExecuted",
		});
		expect(notExecuted).not.toHaveProperty("durationMs");
		expect(notExecuted).not.toHaveProperty("failureMessage");
	});

	it("keeps a zero durationMs (0 is a real duration, not missing)", () => {
		const blocked = normalized[0].results[3];
		expect(blocked.rawStatus).toBe("Blocked");
		expect(blocked.durationMs).toBe(0);
		expect(blocked.failureMessage).toBe("Upstream ledger unavailable");
		expect(blocked.name).toBe("portal.billing.BillingSpec.reconciles");
	});

	it("normalizes a run with no results entry to results: []", () => {
		const run = normalized[1];
		expect(run.externalRunId).toBe("43");
		expect(run.status).toBe("InProgress");
		expect(run.startedAt).toEqual(new Date("2026-07-24T11:00:00Z"));
		expect(run.results).toEqual([]);
		// No build info / completedDate → those optional fields are omitted.
		expect(run).not.toHaveProperty("branch");
		expect(run).not.toHaveProperty("commitSha");
		expect(run).not.toHaveProperty("finishedAt");
		expect(run).not.toHaveProperty("runUrl");
	});
});
