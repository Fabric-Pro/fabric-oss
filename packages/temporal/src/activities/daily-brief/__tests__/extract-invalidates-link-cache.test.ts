import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #1902 regression guard.
 *
 * Extraction rewrites the ProjectMeetingActionItem rows that the link matcher
 * keys on, so it MUST clear the matcher's freshness stamp in the same write.
 * Without it, `linkMeetingActionItemsActivity` short-circuits on
 * `actionItemsLinkVersion === ACTION_ITEM_LINK_VERSION` and a meeting is never
 * re-matched — most visibly, a meeting first extracted with zero action items
 * is stamped "matched" and can never gain links afterwards.
 *
 * Asserted against the source because the write is one field inside a
 * $transaction array that is otherwise expensive to drive end-to-end; the
 * behavioural coverage of the matcher's guard lives in
 * activities/meeting-digest/__tests__/link-action-items.test.ts.
 */
describe("extractMeetingInsightsActivity invalidates the link cache", () => {
	const source = readFileSync(
		resolve(__dirname, "../extract-meeting-insights.ts"),
		"utf8",
	);

	it("clears actionItemsLinkVersion when it rewrites action items", () => {
		expect(source).toContain("actionItemsLinkVersion: null");
	});

	it("clears actionItemsLinkedAt alongside it", () => {
		expect(source).toContain("actionItemsLinkedAt: null");
	});

	it("clears them in the same update that stamps the insights version", () => {
		const stamp = source.indexOf(
			"insightsVersion: MEETING_INSIGHTS_VERSION",
		);
		const clear = source.indexOf("actionItemsLinkVersion: null");
		expect(stamp).toBeGreaterThan(-1);
		expect(clear).toBeGreaterThan(stamp);
		// Same object literal — a few lines apart, not in some other code path.
		expect(clear - stamp).toBeLessThan(600);
	});
});
