/**
 * The recent-note buttons: a shortened label that still tells two long notes
 * apart.
 */

import {
	RECENT_NOTE_LABEL_LENGTH,
	recentNoteLabels,
} from "@saas/time-tracking/lib/recent-note-labels";
import { describe, expect, it } from "vitest";

describe("recentNoteLabels", () => {
	it("shows a short note whole", () => {
		expect(recentNoteLabels(["REQS", "Development"])).toEqual([
			"REQS",
			"Development",
		]);
	});

	it("keeps the start and the end of long notes, so ones that start alike stay apart", () => {
		const labels = recentNoteLabels([
			"Requirements and project management",
			"Requirements and project meetings",
		]);

		expect(labels).toEqual([
			"Requirements…management",
			"Requirements…meetings",
		]);
		for (const label of labels) {
			expect(Array.from(label).length).toBeLessThanOrEqual(
				RECENT_NOTE_LABEL_LENGTH,
			);
		}
	});

	it("shows where two long notes differ when their start and end match", () => {
		const labels = recentNoteLabels([
			"Weekly review of alpha project status and notes",
			"Weekly review of gamma project status and notes",
		]);

		expect(labels).toEqual([
			"…alpha project status a…",
			"…gamma project status a…",
		]);
	});

	it("keeps the word that tells two notes apart when they share their last word", () => {
		const labels = recentNoteLabels([
			"Requirements review with the product team",
			"Requirements review with the design team",
		]);

		expect(labels).toEqual([
			"…with the product team",
			"Requirements…design team",
		]);
		for (const label of labels) {
			expect(Array.from(label).length).toBeLessThanOrEqual(
				RECENT_NOTE_LABEL_LENGTH,
			);
		}
	});

	it("never cuts an emoji in half", () => {
		expect(recentNoteLabels([`${"🚀".repeat(30)} release`])).toEqual([
			`${"🚀".repeat(12)}…release`,
		]);
	});
});
