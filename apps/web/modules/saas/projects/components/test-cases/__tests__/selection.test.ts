import { describe, expect, it } from "vitest";
import {
	clearSelection,
	escalateToAllMatching,
	isAllVisibleSelected,
	type SelectionState,
	toggleAllVisible,
	toggleSelection,
} from "../selection";

const PAGE_1 = ["a", "b", "c"];
const BOTH_PAGES = [...PAGE_1, "d", "e", "f"];

const ids = (state: SelectionState) => [...state.selected].sort();

describe("toggleSelection", () => {
	it("ticks a row in ids mode", () => {
		const next = toggleSelection(clearSelection(), {
			id: "b",
			visibleIds: PAGE_1,
		});
		expect(ids(next)).toEqual(["b"]);
		expect(next.selectAllMatching).toBe(false);
	});

	it("unticks a row in ids mode", () => {
		const state: SelectionState = {
			selected: new Set(["a", "b"]),
			selectAllMatching: false,
		};
		expect(
			ids(toggleSelection(state, { id: "a", visibleIds: PAGE_1 })),
		).toEqual(["b"]);
	});

	it("unticking while escalated keeps every OTHER loaded row", () => {
		// Regression: `selected` is empty while escalated, so a plain toggle
		// ADDED the row being unticked — leaving it as the only selection while
		// every other loaded row silently unchecked. A Delete then hit the
		// inverse of what the reader saw.
		const next = toggleSelection(escalateToAllMatching(), {
			id: "d",
			visibleIds: BOTH_PAGES,
		});
		expect(ids(next)).toEqual(["a", "b", "c", "e", "f"]);
		expect(next.selectAllMatching).toBe(false);
	});

	it("unticking while escalated drops the escalation", () => {
		const next = toggleSelection(escalateToAllMatching(), {
			id: "a",
			visibleIds: PAGE_1,
		});
		// The selection can no longer honestly claim "everything matching":
		// it describes loaded rows only, and the banner re-offers escalation.
		expect(next.selectAllMatching).toBe(false);
		expect(next.selected.has("a")).toBe(false);
	});
});

describe("toggleAllVisible", () => {
	it("selects every loaded row", () => {
		expect(
			ids(toggleAllVisible({ visibleIds: PAGE_1, checked: true })),
		).toEqual(["a", "b", "c"]);
	});

	it("clears, and never leaves the escalation behind", () => {
		const next = toggleAllVisible({ visibleIds: PAGE_1, checked: false });
		expect(ids(next)).toEqual([]);
		expect(next.selectAllMatching).toBe(false);
	});
});

describe("isAllVisibleSelected", () => {
	it("is true while escalated even though no ids are stored", () => {
		// Otherwise the header renders indeterminate above a page of rows that
		// all render checked.
		expect(isAllVisibleSelected(escalateToAllMatching(), BOTH_PAGES)).toBe(
			true,
		);
	});

	it("is false when only some loaded rows are ticked", () => {
		expect(
			isAllVisibleSelected(
				{ selected: new Set(["a"]), selectAllMatching: false },
				PAGE_1,
			),
		).toBe(false);
	});

	it("is false for an empty page", () => {
		expect(isAllVisibleSelected(clearSelection(), [])).toBe(false);
	});
});
