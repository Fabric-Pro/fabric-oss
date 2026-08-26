/**
 * Wiring tests for the ASYNC backlog decision pre-check (card #1365 NFR).
 *
 * The user-interactive AI-Update path must not block the proposal on the ~20s
 * LLM judge: the analysis workflow returns/exposes the proposal first, then runs
 * the judge as a SEPARATE, patched-guarded activity and folds any findings back
 * into its queryable proposal state. These are source-level assertions (mirroring
 * `document-decision-precheck-wiring.test.ts`) — replay determinism is enforced
 * separately by the replay-validation matrix.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const wf = readFileSync(
	join(__dirname, "../backlog-context-analysis-workflow.ts"),
	"utf8",
);
const applyWf = readFileSync(
	join(__dirname, "../backlog-apply-changes-workflow.ts"),
	"utf8",
);
const activity = readFileSync(
	join(__dirname, "../../activities/backlog-context/analyze-context.ts"),
	"utf8",
);
const idx = readFileSync(join(__dirname, "../../activities/index.ts"), "utf8");

describe("backlog async decision pre-check wiring", () => {
	it("gates the new activity call behind the patch marker (replay safety)", () => {
		// Old histories (patched() === false) must skip the new command so they
		// replay deterministically (regression #1251 class).
		expect(wf).toContain('patched("backlog-decision-precheck-async-v1")');
	});

	it("defers the analyzer's inline pre-check on the AI-Update path", () => {
		expect(wf).toContain("deferDecisionPrecheck: true");
		// The analyzer only runs the inline pre-check when NOT deferred, so the
		// AI-Update path never pays the judge cost twice.
		expect(activity).toContain("if (!deferDecisionPrecheck) {");
	});

	it("exposes the proposal BEFORE running the judge (proposal is not a precondition of the judge)", () => {
		// Anchor every marker AFTER the analyzer call. The invariant is about
		// what happens once a proposal exists, and the workflow has earlier
		// exits that legitimately complete and return without one — the
		// no-meeting-content guard (Fizzy #2260) is one. Searching from index 0
		// would pin this test to whichever early return happens to be first in
		// the file rather than to the ordering it exists to protect.
		const analyzeIdx = wf.indexOf("analyzeContextAndPropose({");
		const completeIdx = wf.indexOf(
			'progress.status = "complete"',
			analyzeIdx,
		);
		const precheckIdx = wf.indexOf(
			"runBacklogDecisionPrecheckActivity({",
			analyzeIdx,
		);
		const returnIdx = wf.indexOf("success: true,", analyzeIdx);

		expect(analyzeIdx).toBeGreaterThan(-1);
		expect(completeIdx).toBeGreaterThan(-1);
		expect(precheckIdx).toBeGreaterThan(-1);
		expect(returnIdx).toBeGreaterThan(-1);

		// proposal produced → status flipped to "complete" (exposed to the poll)
		// → THEN the judge runs → THEN the workflow returns. This ordering is the
		// invariant: the proposal is delivered independent of / before the judge.
		expect(completeIdx).toBeGreaterThan(analyzeIdx);
		expect(precheckIdx).toBeGreaterThan(completeIdx);
		expect(returnIdx).toBeGreaterThan(precheckIdx);
	});

	it("folds findings back into the queryable proposal state after the judge", () => {
		expect(wf).toContain("proposal.decisionConflicts = decisionConflicts");
	});

	it("keeps the async pre-check non-fatal (try/catch around the activity)", () => {
		expect(wf).toContain(
			"Backlog decision pre-check activity failed; returning proposal without warnings",
		);
	});

	it("defines and barrel-exports the activity", () => {
		expect(activity).toContain(
			"export async function runBacklogDecisionPrecheckActivity(",
		);
		expect(idx).toContain("runBacklogDecisionPrecheckActivity");
	});
});

describe("backlog decision pre-check — apply-time coverage lives in the procedure, not the workflow", () => {
	// The former GAP (finding #6): the chat agent's "skip analysis" shortcut, a
	// fast apply that beat the async judge's fold, or a forged client relay could
	// reach `applyChangesProcedure` and be applied with ZERO / suppressed
	// contradiction detection. That gap is now CLOSED in the procedure
	// (packages/api/modules/projects/procedures/backlog/apply-changes.ts): it runs
	// `runDecisionPrecheck` AUTHORITATIVELY on every apply (client input is never
	// trusted for the WORM override log; covered by that file's own tests). The
	// check belongs in the PROCEDURE — where the override row is written
	// synchronously with the audit ledger — NOT in the apply WORKFLOW, which stays
	// pre-check-free. This test pins that separation so the judge is never re-run
	// inside the replayable apply workflow.
	it("does not run any decision pre-check inside the backlog APPLY workflow", () => {
		expect(applyWf).not.toContain("runDecisionPrecheck");
		expect(applyWf).not.toContain("runBacklogDecisionPrecheckActivity");
	});
});
