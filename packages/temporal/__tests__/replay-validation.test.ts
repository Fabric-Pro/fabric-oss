/**
 * Replay validation — ensures current workflow code remains compatible with
 * production workflow histories. Catches non-determinism bugs before deploy.
 *
 * Populate fixtures with:
 *   pnpm --filter @repo/temporal fetch:replay-histories
 *
 * Fixtures live under __tests__/__fixtures__/histories/<WorkflowType>/ and
 * are gitignored (they may contain tenant data). The test skips when no
 * fixtures are present, so the main test suite remains green in clean checkouts.
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HistoryAndWorkflowId } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
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

type FixtureFile = {
	workflowId: string;
	runId?: string;
	bucket?: "closed" | "running";
	history: unknown;
};

async function loadHistoriesForType(
	workflowType: string,
): Promise<HistoryAndWorkflowId[]> {
	const dir = join(FIXTURES_DIR, workflowType);
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	return Promise.all(
		files.map(async (file) => {
			const raw = await readFile(join(dir, file), "utf8");
			const parsed = JSON.parse(raw) as FixtureFile;
			// Preserve the original workflowId — workflows that branch on
			// workflowInfo().workflowId (e.g. project-document-generation,
			// code-indexing) would either false-positive or mask real
			// non-determinism if we fed them a synthetic ID derived from the
			// sanitized filename.
			return {
				workflowId: parsed.workflowId,
				history: parsed.history,
			} as HistoryAndWorkflowId;
		}),
	);
}

// Workflow types undergoing an INTENTIONAL, backward-incompatible rewrite.
// Their PRE-RELEASE histories (staging only — the feature was never released to
// prod, so there are no real in-flight executions to protect) cannot replay
// against the new code and will age out of the fetch window (`--since-days`).
// Remove an entry once its old-shape histories have aged out of staging.
const INTENTIONAL_REWRITE_SKIP = new Set<string>([
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
			const histories = await loadHistoriesForType(workflowType);
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

			const results = await Worker.runReplayHistories(
				{
					workflowsPath: WORKFLOWS_PATH,
					// Replay the same interceptor stack production runs.
					// This path builds its own bundle from workflowsPath, so
					// unlike the worker (which uses a prebuilt bundle) it does
					// honour interceptors.workflowModules. Without this the
					// gate would replay workflows that never see the
					// interceptors, and so could not catch a determinism
					// problem one of them introduced.
					//
					// The OpenTelemetry module is added explicitly: the bundle
					// options only carry it once initTelemetry() has run, which
					// never happens in a test, while every production worker
					// has it. The Set is because the union is a no-op when
					// telemetry is initialised (Fizzy #2401).
					interceptors: {
						workflowModules: [
							...new Set([
								...(buildWorkflowBundleOptions(WORKFLOWS_PATH)
									.workflowInterceptorModules ?? []),
								OTEL_WORKFLOW_INTERCEPTOR_MODULE,
							]),
						],
					},
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
		}, 120_000);
	}
});
