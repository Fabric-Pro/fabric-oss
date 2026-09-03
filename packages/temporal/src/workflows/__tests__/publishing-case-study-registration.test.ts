import { describe, expect, it } from "vitest";

/**
 * Registration guard for `generatePublishingCaseStudyWorkflow` (Fizzy #1854).
 *
 * The worker registers workflows by bundling the barrel, so a workflow missing
 * from `src/workflows/index.ts` is not registered under any name — and the
 * failure is close to invisible. `publishingSuite.generateCaseStudy` starts it
 * by the STRING "generatePublishingCaseStudyWorkflow", and today that string is
 * checked only against a hand-typed copy of itself in the procedure's own test:
 * two spellings of one guess, agreeing with each other.
 *
 * What an unregistered workflow actually does: `workflow.start` still succeeds
 * (the server accepts a type it has never seen and queues a task), so the
 * procedure returns cleanly; the row sits GENERATING; the failure marker never
 * runs because it lives INSIDE the workflow that was never scheduled; and the
 * reclaim is a lazy deadline sweep. The first signal anyone gets is a user
 * clicking the button again ten minutes later.
 *
 * The barrel is imported for real rather than scanned as text: a name that
 * appears in `index.ts` only inside a comment, a type-only export or a string
 * is not a runtime export, and `typeof === "function"` is the only check that
 * tells those apart.
 */

import * as workflows from "../index";

/** The string `publishingSuite.generateCaseStudy` passes to `workflow.start`. */
const WORKFLOW_TYPE = "generatePublishingCaseStudyWorkflow";

describe("publishing case study workflow registration", () => {
	it("exports the workflow type the procedure starts, as a function", () => {
		expect(
			typeof (workflows as Record<string, unknown>)[WORKFLOW_TYPE],
		).toBe("function");
	});

	it("exports the failure-marker's workflow-free sibling names unchanged", () => {
		// The other two publishing writers go through the same barrel and the
		// same start-by-string path. Pinned together so a barrel edit that
		// drops one is caught by the file that explains why it matters.
		for (const name of [
			"generatePublishingBlogPostWorkflow",
			"generatePublishingShortPostWorkflow",
		]) {
			expect(typeof (workflows as Record<string, unknown>)[name]).toBe(
				"function",
			);
		}
	});
});
