import { describe, expect, it } from "vitest";
import { reviewDragAnnouncements } from "../newsletter-review-announcements";

const titles: Record<string, string> = {
	"highlight-0": "Faster search",
	"highlight-1": "New dashboard",
};
const announcements = reviewDragAnnouncements((id) => titles[id]);

function drag(activeId: string, overId: string | null) {
	return {
		active: { id: activeId },
		over: overId === null ? null : { id: overId },
	};
}

describe("reviewDragAnnouncements", () => {
	it("names the highlight that was picked up", () => {
		expect(announcements.onDragStart(drag("highlight-0", null))).toBe(
			"Picked up Faster search.",
		);
	});

	it("names both highlights while one is over another", () => {
		expect(
			announcements.onDragOver(drag("highlight-0", "highlight-1")),
		).toBe("Faster search is over New dashboard.");
	});

	it("says nothing while a highlight is over itself", () => {
		expect(
			announcements.onDragOver(drag("highlight-0", "highlight-0")),
		).toBeUndefined();
	});

	it("names the place a highlight was dropped in", () => {
		expect(
			announcements.onDragEnd(drag("highlight-0", "highlight-1")),
		).toBe("Faster search was moved to the place of New dashboard.");
	});

	it("says a highlight dropped on itself went back", () => {
		expect(
			announcements.onDragEnd(drag("highlight-0", "highlight-0")),
		).toBe("Faster search was put back in its place.");
	});

	it("says a cancelled reorder went back", () => {
		expect(announcements.onDragCancel(drag("highlight-0", null))).toBe(
			"Reordering cancelled. Faster search is back in its place.",
		);
	});

	it("never reads an unknown id aloud", () => {
		expect(
			announcements.onDragStart(drag("highlight-9", null)),
		).toBeUndefined();
		expect(
			announcements.onDragEnd(drag("highlight-9", "highlight-0")),
		).toBeUndefined();
	});
});
