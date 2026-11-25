/**
 * Replay validation — ensures current workflow code remains compatible with
 * production workflow histories. Catches non-determinism bugs before deploy.
 *
 * Populate fixtures with:
 *   pnpm --filter @repo/temporal fetch:replay-histories
 *
 * Fetched fixtures live under __tests__/__fixtures__/histories/<WorkflowType>/ and
 * are gitignored (they may contain tenant data). The test skips when no
 * fetched fixtures are present. Synthetic workflow fixtures run separately.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { loadHistoriesForType } from "../scripts/replay-fixtures";
import { buildWorkflowBundleOptions } from "../src/lib/workflow-bundle-options";
import { OTEL_WORKFLOW_INTERCEPTOR_MODULE } from "../src/telemetry";

const FIXTURES_DIR = join(__dirname, "__fixtures__", "histories");
// Absolute path to the workflows directory. We avoid `require.resolve` here
// because Vitest doesn't patch Node's CJS resolver for .ts files the way tsx
// does, so `require.resolve("../src/workflows")` fails with MODULE_NOT_FOUND
// in CI. Temporal's bundleWorkflowCode accepts a directory path and lets
// webpack handle .ts resolution internally.
const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");

function listTypeDirs(): string[] {
	if (!existsSync(FIXTURES_DIR)) {
		return [];
	}
	return readdirSync(FIXTURES_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

// Workflow types undergoing an INTENTIONAL, backward-incompatible rewrite.
// Their PRE-RELEASE histories (staging only — the feature was never released to
// prod, so there are no real in-flight executions to protect) cannot replay
// against the new code and will age out of the fetch window (`--since-days`).
// Remove an entry once its old-shape histories have aged out of staging.
const INTENTIONAL_REWRITE_SKIP = new Set<string>([
	// Removed unused story-task agent; no executions recorded on staging or prod.
	"taskAgentWorkflow",
	// PR #1832: security "Group into tickets" was rewritten from write-during-run
	// into a propose → review → apply workflow — old activities such as
	// checkAgentAccessActivity / processThemeActivity no longer exist, so the
	// pre-release staging histories fail replay by design.
	"securityFindingGroupingWorkflow",
	// PR #1884: the in-app Release Notifications feature was removed in favor of a
	// CI-only chat-webhook notification, so this workflow no longer exists in the
	// code. Its only histories are pre-release staging Send-test runs (the feature
	// never reached prod), which can't replay against the new code and will age
	// out of the fetch window (--since-days).
	"releaseNotificationWorkflow",
	// The Pipeline tab was retired, and with it the only thing that started this
	// workflow (the `pipeline.start` procedure). Unlike the entries above, it DID
	// run in prod, so prod and staging both hold histories of it; none can replay
	// against code that no longer defines the workflow or its pipeline-only
	// activities. Any execution still running must be drained before the worker
	// deploy that drops it. Remove this entry once those histories have aged out
	// of the fetch window (--since-days).
	"prdToTasksPipelineWorkflow",
	// Fizzy #2748: the #2563 per-proposal pull-request workflow was retired
	// once every proposal it served had drained (new proposals go through
	// their member's branch since Fizzy #2738). It ran only in staging, never
	// in prod, and a run lives at most through readiness (a 6 h clock), one
	// open and one close, so every recorded history is of a finished run; none
	// can replay against code that no longer defines the workflow. Remove this
	// entry once those histories have aged out of the fetch window
	// (--since-days).
	"projectInstructionProposalPullRequestWorkflow",
]);

/**
 * Set by the CI job, unset everywhere else.
 *
 * Without it this suite treats "no fixtures" as "nothing to do" and goes green,
 * which is right for a clean checkout and WRONG for the gate: if the fetch step
 * returns nothing — an empty window, an unreachable namespace, a query that
 * matched no executions — the gate reports success having replayed nothing at
 * all, and a `pass` that proves nothing is worse than a red one because it stops
 * anybody looking. A check that can legitimately return "nothing found" needs a
 * way to tell that apart from a broken instrument.
 */
const REQUIRE_FIXTURES = process.env.REPLAY_REQUIRE_FIXTURES === "1";

function buildReplayBundle() {
	const options = buildWorkflowBundleOptions(WORKFLOWS_PATH);
	return bundleWorkflowCode({
		...options,
		// initTelemetry does not run in tests. Include the interceptor the
		// worker adds during startup so replay uses the production stack.
		workflowInterceptorModules: [
			...new Set([
				...(options.workflowInterceptorModules ?? []),
				OTEL_WORKFLOW_INTERCEPTOR_MODULE,
			]),
		],
	});
}

let replayBundle: ReturnType<typeof buildReplayBundle> | undefined;

async function replay(
	workflowType: string,
	histories: Awaited<ReturnType<typeof loadHistoriesForType>>,
) {
	replayBundle ??= buildReplayBundle();
	const results = await Worker.runReplayHistories(
		{
			workflowBundle: await replayBundle,
			// A replay worker never invokes a sink unless it opted in
			// with callDuringReplay, and this one has not — but the
			// worker checks that a sink is registered before it checks
			// that, and logs an error per span otherwise. Register the
			// shape production registers so the replay log stays clean.
			sinks: {
				exporter: { export: { fn: () => undefined } },
			},
		},
		histories,
	);

	const failures: Array<{ workflowId: string; error: string }> = [];
	for await (const result of results) {
		if (result.error) {
			failures.push({
				workflowId: result.workflowId,
				error: result.error.message ?? String(result.error),
			});
		}
	}

	if (failures.length > 0) {
		const detail = failures
			.map((f) => `  - ${f.workflowId}: ${f.error}`)
			.join("\n");
		expect.fail(
			`${failures.length} / ${histories.length} ${workflowType} histories failed to replay:\n${detail}`,
		);
	}
}

it("replays a synthetic URL crawl recorded before credential references", async () => {
	const workflowType = "urlSourceCrawlWorkflow";
	const histories = await loadHistoriesForType(
		join(__dirname, "__fixtures__", "url-source-synthetic-histories"),
		workflowType,
		true,
	);
	await replay(workflowType, histories);
}, 120_000);

it("replays a synthetic connector sync recorded before worker-side credential resolution", async () => {
	const workflowType = "connectorSyncWorkflow";
	const histories = await loadHistoriesForType(
		join(__dirname, "__fixtures__", "connector-sync-synthetic-histories"),
		workflowType,
		true,
	);
	expect(histories).toHaveLength(1);
	await replay(workflowType, histories);
}, 120_000);

describe("Replay validation", () => {
	const typeDirs = listTypeDirs();

	if (typeDirs.length === 0) {
		if (REQUIRE_FIXTURES) {
			it("fetched at least one history to replay", () => {
				expect.fail(
					"No replay fixtures were written. The fetch step exited 0 but produced nothing, " +
						"so this gate would have passed without replaying a single history. Check the " +
						"fetch log for the namespace it queried and the window it used.",
				);
			});
			return;
		}
		it.skip("no fixtures present — run `pnpm fetch:replay-histories` to populate", () => {
			// Intentionally empty; skipped.
		});
		return;
	}

	for (const workflowType of typeDirs) {
		it(`${workflowType} histories replay without non-determinism`, async () => {
			if (INTENTIONAL_REWRITE_SKIP.has(workflowType)) {
				// Intentional, backward-incompatible rewrite — see the note above.
				return;
			}
			const histories = await loadHistoriesForType(
				FIXTURES_DIR,
				workflowType,
				REQUIRE_FIXTURES,
			);
			if (histories.length === 0) {
				// A directory with no loadable history is not "nothing to do": the
				// fetch created the directory, so it meant to put something there.
				// Silently returning made a per-type coverage hole look identical to
				// a per-type pass.
				if (REQUIRE_FIXTURES) {
					expect.fail(
						`${workflowType} has a fixture directory but no loadable histories — coverage for this type is a hole, not a pass.`,
					);
				}
				return;
			}

			await replay(workflowType, histories);
		}, 120_000);
	}
});
