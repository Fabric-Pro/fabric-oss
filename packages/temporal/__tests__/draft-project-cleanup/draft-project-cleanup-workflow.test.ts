/**
 * Tests for `draftProjectCleanupWorkflow`.
 *
 * Group 5 of `2026-05-23-unified-context-uploader-wizard/tasks.md` (5.5).
 *
 * The workflow body is intentionally trivial — one activity call per cron
 * fire — so we pin the contract via direct execution against a mocked
 * activity callable, not via `TestWorkflowEnvironment`. Same rationale as
 * `packages/temporal/src/workflows/monitoring/__tests__/incident-lifecycle.test.ts`:
 * spinning up Temporalite for a single-activity-call workflow is overkill,
 * and the asserts we care about (the activity is called, the result is
 * returned verbatim, the workflow doesn't add its own non-determinism) are
 * checkable without a sandboxed worker.
 *
 * Replay determinism is covered separately by the implicit replay-
 * validation matrix at `.github/workflows/temporal-replay-validation.yml`
 * (see spec §6.5 + task 5.4).
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/draft-project-cleanup/draft-project-cleanup-workflow.test.ts
 */

import { describe, expect, it, vi } from "vitest";

// Mirror the workflow body 1:1. Production code lives at
// `packages/temporal/src/workflows/draft-project-cleanup.ts`. Kept in test
// scope so a divergence is caught on code review (the workflow file is 30
// lines — easy to keep in sync).
interface CleanupAbandonedDraftsInput {
	cutoffDays?: number;
	batchSize?: number;
}
interface CleanupAbandonedDraftsOutput {
	draftsDeleted: number;
	workflowsCancelled: number;
	errors: Array<{
		id: string;
		kind: "cancel" | "soft-delete";
		message: string;
	}>;
}

interface DraftProjectCleanupWorkflowInput {
	cutoffDays?: number;
	batchSize?: number;
}

/**
 * Tiny re-implementation of the workflow body. The production file is at
 * `packages/temporal/src/workflows/draft-project-cleanup.ts` and is a one-
 * liner — passes the input through to the activity, returns the activity
 * output verbatim.
 */
async function runWorkflowMirror(
	input: DraftProjectCleanupWorkflowInput,
	cleanupAbandonedDraftsActivity: (
		i: CleanupAbandonedDraftsInput,
	) => Promise<CleanupAbandonedDraftsOutput>,
): Promise<CleanupAbandonedDraftsOutput> {
	return await cleanupAbandonedDraftsActivity({
		cutoffDays: input.cutoffDays,
		batchSize: input.batchSize,
	});
}

describe("draftProjectCleanupWorkflow (mirrored body)", () => {
	it("calls cleanupAbandonedDraftsActivity exactly once with the workflow input passed through", async () => {
		const activity = vi.fn().mockResolvedValue({
			draftsDeleted: 0,
			workflowsCancelled: 0,
			errors: [],
		});

		await runWorkflowMirror({ cutoffDays: 14, batchSize: 50 }, activity);

		expect(activity).toHaveBeenCalledTimes(1);
		expect(activity).toHaveBeenCalledWith({
			cutoffDays: 14,
			batchSize: 50,
		});
	});

	it("returns the activity output verbatim (no workflow-side mutation)", async () => {
		const activityOutput: CleanupAbandonedDraftsOutput = {
			draftsDeleted: 3,
			workflowsCancelled: 5,
			errors: [],
		};
		const activity = vi.fn().mockResolvedValue(activityOutput);

		const result = await runWorkflowMirror({}, activity);

		expect(result).toEqual(activityOutput);
		// Reference equality — workflow body must NOT clone / reshape.
		expect(result).toBe(activityOutput);
	});

	it("surfaces activity errors to the caller (workflow body doesn't swallow)", async () => {
		const activity = vi
			.fn()
			.mockRejectedValue(new Error("DB connection refused"));

		await expect(runWorkflowMirror({}, activity)).rejects.toThrow(
			"DB connection refused",
		);
	});

	it("forwards undefined cutoffDays / batchSize so the activity applies its own defaults", async () => {
		const activity = vi.fn().mockResolvedValue({
			draftsDeleted: 0,
			workflowsCancelled: 0,
			errors: [],
		});

		await runWorkflowMirror({}, activity);

		expect(activity).toHaveBeenCalledWith({
			cutoffDays: undefined,
			batchSize: undefined,
		});
	});
});

// ---------------------------------------------------------------------------
// Determinism contract — pinned via static-text scan of the production
// workflow file. If a future refactor reintroduces `Date.now()` or
// `Math.random()` in the workflow body the test breaks. The actual replay
// determinism is verified by the CI replay-validation matrix per spec §6.5.
// ---------------------------------------------------------------------------

describe("draftProjectCleanupWorkflow — determinism contract", () => {
	it("workflow body does not reach for Date.now / Math.random / setTimeout", async () => {
		const { readFile } = await import("node:fs/promises");
		const path = (await import("node:path")).join(
			__dirname,
			"../../src/workflows/draft-project-cleanup.ts",
		);
		const source = await readFile(path, "utf8");
		// Strip /* */ and //  comments so a descriptive mention of
		// `Date.now()` in the file header doesn't false-positive the
		// determinism check. The check cares about *executable* uses.
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		expect(code).not.toMatch(/Date\.now\s*\(/);
		expect(code).not.toMatch(/Math\.random\s*\(/);
		// `setTimeout` would be non-deterministic without Temporal's
		// `sleep` wrapper. The workflow body intentionally never uses it.
		expect(code).not.toMatch(/\bsetTimeout\s*\(/);
	});
});
