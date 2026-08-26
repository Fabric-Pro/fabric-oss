import { describe, expect, it } from "vitest";
import { buildBacklogUpdaterPrompt } from "../prompts";

/**
 * The bug section names this agent instructs the model to emit are a contract
 * with a downstream guard, not formatting.
 *
 * `detectDestructiveRewrite` (packages/temporal/src/lib/structure-guards.ts)
 * recognises a bug body by counting how many of its canonical section names
 * appear as markdown HEADING lines. It refuses a rewrite that had them and came
 * back with none. Two properties therefore have to hold in this prompt, and
 * neither is visible from reading the guard alone:
 *
 *  1. The names must match the guard's list. This agent used to say "Expected
 *     Behavior" / "Actual Behavior" where the guard carries "Expected Result" /
 *     "Actual Result", so its output scored zero.
 *  2. They must be headings. A bolded inline label (`- **Steps to Reproduce**:`)
 *     is not a heading line and scores zero too — the guard silently never arms.
 *
 * Fizzy #2048. Kept as a copy rather than an import: this agent is a separate
 * build with no dependency on @repo/temporal, and adding one to reach a test
 * fixture would invert that boundary.
 */
const GUARD_BUG_SECTIONS = [
	"Steps to Reproduce",
	"Expected Result",
	"Actual Result",
	"Impact",
] as const;

/** Names the guard does NOT carry — emitting these scores nothing. */
const OFF_CANON_NAMES = ["Expected Behavior", "Actual Behavior"] as const;

function promptText(): string {
	// The builder only interpolates conversation state around the static rules,
	// so an empty state still contains the formatting section under test.
	return buildBacklogUpdaterPrompt(
		{} as Parameters<typeof buildBacklogUpdaterPrompt>[0],
	);
}

describe("backlog-updater bug formatting rules", () => {
	it("asks for every section name the structure guard matches on", () => {
		const prompt = promptText();
		for (const name of GUARD_BUG_SECTIONS) {
			expect(prompt).toContain(name);
		}
	});

	it("asks for them as markdown headings, not inline bold labels", () => {
		const prompt = promptText();
		for (const name of GUARD_BUG_SECTIONS) {
			expect(prompt).toContain(`## ${name}`);
		}
	});

	it("no longer carries the off-canon names the guard cannot see", () => {
		const prompt = promptText();
		for (const name of OFF_CANON_NAMES) {
			expect(prompt).not.toContain(name);
		}
	});

	it("states why the heading form matters, so a future edit does not undo it", () => {
		// A bare list of names invites "tidying" back into bullets. The rule has
		// to carry its own reason or this test is the only thing standing in the
		// way, and a reader who deletes the rule will delete the test with it.
		expect(promptText()).toMatch(
			/heading lines only|never as inline bold/i,
		);
	});
});
