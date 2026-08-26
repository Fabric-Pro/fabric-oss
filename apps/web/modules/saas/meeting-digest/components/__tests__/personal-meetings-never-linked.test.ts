import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #1902 AC11 privacy guard: a personal meeting must never have its action items
 * linked to work items.
 *
 * This holds structurally rather than by a runtime check, which is exactly why
 * it needs pinning: personal transcripts are fetched live from Graph and never
 * written to the database (see get-personal-transcript.ts), so no
 * `ProjectMeetingTranscript` row exists for the matcher to key on, and
 * `PersonalMeetingSheet` renders its own plain list instead of the shared
 * `ActionItemList`.
 *
 * Both halves of that are invisible in a diff. Someone "unifying" the two sheets
 * onto `ActionItemList` — a reasonable-looking cleanup — would wire linking into
 * personal meetings without a single failing assertion anywhere else. This test
 * is the tripwire for that specific refactor.
 */
describe("personal meetings are never action-item linked (AC11)", () => {
	const personalSheet = readFileSync(
		resolve(__dirname, "../PersonalMeetingSheet.tsx"),
		"utf8",
	);

	it("does not render the shared linkable ActionItemList", () => {
		expect(personalSheet).not.toContain("ActionItemList");
	});

	it("renders no link affordance of any kind", () => {
		expect(personalSheet).not.toContain("ActionItemLinks");
		expect(personalSheet).not.toContain("LinkStoryPicker");
		expect(personalSheet).not.toContain("linksByItemKey");
	});

	it("never calls a linking procedure", () => {
		expect(personalSheet).not.toContain("linkActionItems");
		expect(personalSheet).not.toContain("addActionItemLink");
		expect(personalSheet).not.toContain("removeActionItemLink");
	});

	it("the team sheet DOES link, so this guard is about personal specifically", () => {
		// Guards the guard: if the team sheet ever stopped linking, the three
		// assertions above would pass vacuously and mean nothing.
		const teamSheet = readFileSync(
			resolve(__dirname, "../MeetingDetailSheet.tsx"),
			"utf8",
		);
		expect(teamSheet).toContain("linkActionItems");
		expect(teamSheet).toContain("linksByItemKey");
	});
});
