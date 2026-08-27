import type { LinkableCase } from "@repo/database/prisma/queries/projects/automation-linkage";
import { describe, expect, it } from "vitest";
import type { NormalizedRun } from "../normalized-result";
import { prepareRunForIngestion } from "../prepare-ingestion";

const cases: LinkableCase[] = [
	{
		id: "c1",
		identifier: "TC-014",
		title: "resets the password",
		automationRef: "resets the password",
		automationFilePath: "tests/auth/reset.spec.ts",
	},
	{
		id: "c2",
		identifier: "TC-020",
		title: "login succeeds",
		automationRef: "login succeeds",
		automationFilePath: null,
	},
];

const tenant = { projectId: "p1", organizationId: "org1", userId: "u1" };

const run: NormalizedRun = {
	provider: "github-actions",
	externalRunId: "4821",
	pipelineName: "CI",
	branch: "main",
	commitSha: "abc123",
	runUrl: "https://gh/run/4821",
	status: "failure",
	startedAt: new Date("2026-07-24T10:00:00Z"),
	finishedAt: new Date("2026-07-24T10:05:00Z"),
	durationMs: 300000,
	results: [
		{ name: "resets the password", rawStatus: "passed" }, // → c1 (path)
		{ name: "login succeeds", rawStatus: "failed" }, // → c2 (title)
		{ name: "some orphan test", rawStatus: "skipped" }, // unmatched
	],
};

describe("prepareRunForIngestion", () => {
	it("matches results to cases, maps status, and tallies run counts", () => {
		const out = prepareRunForIngestion(run, cases, tenant);

		// Tenant + run metadata pass through.
		expect(out.projectId).toBe("p1");
		expect(out.run.externalRunId).toBe("4821");
		expect(out.run.provider).toBe("github-actions");

		// Counts over ALL 3 results. Result normalisation inverted what these two columns
		// mean: skippedCount used to be fed by NOT_RUN (queued/pending) while a CI
		// "skipped" was mapped to BLOCKED and landed in otherCount — so the number
		// the UI labelled "skipped" counted something else, and real skips were
		// invisible. Now a CI "skipped" is SKIPPED and counts as skipped;
		// otherCount carries NOT_RUN and BLOCKED, the two "did not produce a
		// verdict" cases.
		expect(out.run.totalCount).toBe(3);
		expect(out.run.passedCount).toBe(1);
		expect(out.run.failedCount).toBe(1);
		expect(out.run.skippedCount).toBe(1);
		expect(out.run.otherCount).toBe(0);

		// Two matched (c1 via path, c2 via title), one unmatched.
		expect(out.matched).toEqual([
			{
				testCaseId: "c1",
				result: "PASSED",
				testName: "resets the password",
				matchTier: "path",
			},
			{
				testCaseId: "c2",
				result: "FAILED",
				testName: "login succeeds",
				matchTier: "title",
			},
		]);
		expect(out.unmatchedCount).toBe(1);
		expect(out.results?.map((result) => result.rawStatus)).toEqual([
			"passed",
			"failed",
			"skipped",
		]);
	});

	it("counts an unknown/aborted status into the 'other' (BLOCKED) bucket", () => {
		const out = prepareRunForIngestion(
			{ ...run, results: [{ name: "x", rawStatus: "aborted" }] },
			cases,
			tenant,
		);
		expect(out.run.otherCount).toBe(1);
		expect(out.run.totalCount).toBe(1);
		expect(out.unmatchedCount).toBe(1); // "x" matches no case
	});

	// A failure message is the customer's own test output, and test output is
	// where credentials surface: a Prisma exception carrying a DATABASE_URL, an
	// assertion dumping an Authorization header. From here it is persisted, can
	// be copied into a promoted bug that syncs to a PM tool, and is embedded in
	// the root-cause prompt sent to a third-party model — so it is scrubbed at
	// this seam rather than at any one of those three.
	it("scrubs credentials out of a provider failure message", () => {
		const out = prepareRunForIngestion(
			{
				...run,
				results: [
					{
						name: "login succeeds",
						rawStatus: "failed",
						failureMessage:
							"Error: request failed\n  Authorization: Bearer ghp_supersecrettokenvalue\n  at login (auth.ts:20)",
					},
				],
			},
			cases,
			tenant,
		);

		const message = out.results?.[0]?.failureMessage ?? "";
		expect(message).not.toContain("ghp_supersecrettokenvalue");
		expect(message).toContain("[REDACTED]");
		// The diagnosis itself must survive — a scrub that blanks the message
		// makes the finding useless.
		expect(message).toContain("at login (auth.ts:20)");
	});

	// The named-key rules do not match a DSN, because its credential is
	// positional. This is the likeliest secret to appear in real test output:
	// a connection failure prints the whole URL.
	it("redacts a connection-string password out of a failure message", () => {
		const out = prepareRunForIngestion(
			{
				...run,
				results: [
					{
						name: "login succeeds",
						rawStatus: "failed",
						failureMessage:
							"PrismaClientInitializationError: can't reach postgresql://fabric:hunter2@db.invalid:5432/app",
					},
				],
			},
			cases,
			tenant,
		);

		const message = out.results?.[0]?.failureMessage ?? "";
		expect(message).not.toContain("hunter2");
		// Host and database still identify WHICH datasource failed.
		expect(message).toContain("@db.invalid:5432/app");
	});
});
