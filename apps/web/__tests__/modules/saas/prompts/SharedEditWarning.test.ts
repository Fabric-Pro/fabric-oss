/**
 * FR21: warn which other actions an edit will reach, before it is saved.
 *
 * A prompt's body is shared by every action bound to it, so editing while
 * looking at one silently changes the rest. This rule had no test at all — the
 * component that implements it has no test file — which is how a condition with
 * three clauses ends up nobody's responsibility.
 *
 * Each clause matters on its own:
 *   - warn on a CONTENT change only; interrupting for a rename trains people to
 *     dismiss the dialog, and then the real warning goes unread too
 *   - warn only when MORE than one action is bound; with one, the reach is the
 *     thing on screen
 *   - NAME the actions; a count tells the reader to go and look elsewhere
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/SharedEditWarning.test.ts
 */

import {
	needsSharedEditWarning,
	sharedEditWarning,
} from "@saas/prompts/lib/shared-edit-warning";
import { describe, expect, it } from "vitest";

describe("when to warn", () => {
	it("warns when shared content changes", () => {
		expect(
			needsSharedEditWarning({
				contentChanged: true,
				boundActionCount: 3,
			}),
		).toBe(true);
	});

	it("stays quiet when only metadata changed", () => {
		// A rename or a tag edit changes nothing any agent reads.
		expect(
			needsSharedEditWarning({
				contentChanged: false,
				boundActionCount: 3,
			}),
		).toBe(false);
	});

	it("stays quiet when the prompt serves a single action", () => {
		// The reach is exactly the action the user is looking at.
		expect(
			needsSharedEditWarning({
				contentChanged: true,
				boundActionCount: 1,
			}),
		).toBe(false);
	});

	it("stays quiet when the prompt is bound to nothing", () => {
		expect(
			needsSharedEditWarning({
				contentChanged: true,
				boundActionCount: 0,
			}),
		).toBe(false);
	});
});

describe("what the warning says", () => {
	it("names every action the edit reaches", () => {
		const { message } = sharedEditWarning([
			"Test Case Drafter — General",
			"Test Case Step Reviser — General",
		]);

		expect(message).toContain("Test Case Drafter — General");
		expect(message).toContain("Test Case Step Reviser — General");
	});

	it("counts them, so the number and the list cannot disagree", () => {
		const { message } = sharedEditWarning(["A", "B", "C"]);

		expect(message).toContain("all 3");
	});

	it("explains why one edit reaches all of them", () => {
		// Without the reason the dialog reads as an obstacle rather than a fact.
		const { message } = sharedEditWarning(["A", "B"]);

		expect(message).toMatch(/share one body/i);
	});
});
