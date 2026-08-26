import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #1902 AC5 regression guard — found in staging QA, not by any unit test.
 *
 * The per-meeting reset effect contained TWO `setActiveTab` calls: the
 * deep-link-aware one, followed by an unconditional `setActiveTab("decisions")`
 * left over from before. The second silently won, so a back-reference deep link
 * opened the correct meeting on the wrong tab — the highlighted action item was
 * rendered but off-screen behind another tab.
 *
 * Nothing in the component's rendered output distinguishes "tab chosen
 * correctly" from "tab chosen then overwritten in the same effect", which is why
 * this asserts on the source: exactly one setActiveTab call in that effect.
 */
describe("deep link opens the Actions tab (AC5)", () => {
	const source = readFileSync(
		resolve(__dirname, "../MeetingDetailSheet.tsx"),
		"utf8",
	);

	/** The per-meeting reset effect: from its opening through its dep array. */
	const resetEffect = (() => {
		const start = source.indexOf("pollsRef.current = 0;");
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("}, [transcriptId", start);
		expect(end).toBeGreaterThan(start);
		return source.slice(start, end);
	})();

	it("sets the tab exactly once, so nothing can clobber the choice", () => {
		const calls = resetEffect.match(/setActiveTab\(/g) ?? [];
		expect(calls).toHaveLength(1);
	});

	it("chooses the tab from highlightItemKey rather than hardcoding it", () => {
		expect(resetEffect).toContain(
			'setActiveTab(highlightItemKey ? "actions" : "decisions")',
		);
	});

	it("re-runs when the highlighted item changes, not only on meeting change", () => {
		// highlightItemKey arrives in the same commit as transcriptId on a deep
		// link, but keeping it in the deps makes the effect correct rather than
		// accidentally correct.
		expect(source).toContain("}, [transcriptId, highlightItemKey]);");
	});
});
