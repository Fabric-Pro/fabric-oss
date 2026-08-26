import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("daily-brief workflow wiring", () => {
	it("calls the completion helpers and gates deployments behind the v4 patch", async () => {
		const source = await readFile(
			join(
				__dirname,
				"../src/workflows/daily-brief-generation-workflow.ts",
			),
			"utf8",
		);
		// Strip comments so prose mentions don't false-positive.
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		expect(code).toMatch(/patched\("daily-brief-v4-github-releases"\)/);
		expect(code).toMatch(/applyDeploymentsResult\(/);
		expect(code).toMatch(/resolveBriefCompletion\(/);
		expect(code).toMatch(/assembleFinalBrief\(/);
		// The eager settle handler must be attached at the call site (no bare await
		// of the raw activity promise without a .then wrapper). `[^)]*` spans the
		// `{ ...collectorInput, userId: triggeredByUserId }` arg (it has no `)`).
		expect(code).toMatch(/collectGitHubReleasesActivity\([^)]*\)\.then\(/);
	});

	it("gates the prod-release anchor behind the v5 patch and assembles via helper", async () => {
		const source = await readFile(
			join(
				__dirname,
				"../src/workflows/daily-brief-generation-workflow.ts",
			),
			"utf8",
		);
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		expect(code).toMatch(/patched\("daily-brief-v5-prod-release-anchor"\)/);
		expect(code).toMatch(/assembleFinalBrief\(/);
	});

	it("passes userId (triggeredByUserId) to the PR-collector activity in both v1 and v2 branches", async () => {
		const source = await readFile(
			join(
				__dirname,
				"../src/workflows/daily-brief-generation-workflow.ts",
			),
			"utf8",
		);
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		// Both Promise.allSettled branches (v2 and v1) must spread triggeredByUserId
		// into the PR-collector call — count occurrences to cover both callsites.
		const matches = code.match(
			/collectGitHubPullRequestsActivity\(\{[^}]*userId:\s*triggeredByUserId[^}]*\}\)/g,
		);
		expect(matches).not.toBeNull();
		expect(matches?.length).toBe(2);
	});

	it("gates release-note exclusion filtering behind the v6 patch and wires the pure helper + loader activity", async () => {
		const source = await readFile(
			join(
				__dirname,
				"../src/workflows/daily-brief-generation-workflow.ts",
			),
			"utf8",
		);
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		// Filter gate + pure helper application.
		expect(code).toMatch(/patched\("daily-brief-v6-exclusions"\)/);
		expect(code).toMatch(/filterExcludedMergedPrs\(/);
		// Exclusions are loaded via a DB-local activity (I/O out of the sandbox),
		// keyed by (projectId, organizationId).
		expect(code).toMatch(
			/loadReleaseNoteExclusionsActivity\(\{[^}]*projectId[^}]*\}\)/,
		);
		// Freshness/convergence: capture the applied signature and re-check it.
		expect(code).toMatch(/exclusionSignature\(/);
		expect(code).toMatch(/regenChainDepth/);
		// Self-rerun on a mid-generation change (bounded).
		expect(code).toMatch(/continueAsNew/);
		// CRITICAL — the broad catch must rethrow the ContinueAsNew control-flow
		// error so a self-rerun is NOT converted into a FAILED brief. A source-scan
		// can't prove the rethrow executes; the behavioral test in
		// daily-brief-workflow-convergence.test.ts does that.
		expect(code).toMatch(/instanceof ContinueAsNew/);
	});
});
