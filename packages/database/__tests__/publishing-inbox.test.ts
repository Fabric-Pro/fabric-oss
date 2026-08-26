import { describe, expect, it } from "vitest";
import { composeInboxSections, isTopicSnoozed } from "../src/publishing-inbox";

type T = {
	id: string;
	status: string;
	isSnoozed: boolean;
	createdAt: Date;
	updatedAt: Date;
};

const topic = (o: Partial<T> & { id: string }): T => ({
	status: "SUGGESTION",
	isSnoozed: false,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	...o,
});

describe("composeInboxSections", () => {
	it("puts IN_PROGRESS and SELECTED in Recently Modified, newest-modified first", () => {
		const out = composeInboxSections([
			topic({
				id: "a",
				status: "IN_PROGRESS",
				updatedAt: new Date("2026-02-01T00:00:00.000Z"),
			}),
			topic({
				id: "b",
				status: "SELECTED",
				updatedAt: new Date("2026-03-01T00:00:00.000Z"),
			}),
		]);
		expect(out.recentlyModified.map((t) => t.id)).toEqual(["b", "a"]);
	});

	it("caps Recently Modified at three but reports the true total", () => {
		const items = ["a", "b", "c", "d"].map((id, i) =>
			topic({
				id,
				status: "IN_PROGRESS",
				updatedAt: new Date(Date.UTC(2026, 0, i + 1)),
			}),
		);
		const out = composeInboxSections(items);
		expect(out.recentlyModified).toHaveLength(3);
		expect(out.recentlyModifiedTotal).toBe(4);
		// Newest-modified first: d, c, b — never the array's own order.
		expect(out.recentlyModified.map((t) => t.id)).toEqual(["d", "c", "b"]);
	});

	// NEGATIVE CONTROL for the 1B regression (spec 6.2). The fixture is built so
	// that tier order and pure-date order DISAGREE: "old-contributed" arrives
	// first because it is tier 1, but it is the OLDEST. A fixture where the two
	// orders agree would pass under either implementation and prove nothing.
	it("preserves the caller's 1B tier order in Suggested instead of re-sorting by date", () => {
		const out = composeInboxSections([
			topic({
				id: "old-contributed",
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
			}),
			topic({
				id: "new-untiered",
				createdAt: new Date("2026-09-01T00:00:00.000Z"),
			}),
		]);
		expect(out.suggested.map((t) => t.id)).toEqual([
			"old-contributed",
			"new-untiered",
		]);
	});

	it("excludes snoozed topics from both sections", () => {
		const out = composeInboxSections([
			topic({ id: "s", isSnoozed: true }),
			topic({ id: "p", status: "IN_PROGRESS", isSnoozed: true }),
		]);
		expect(out.suggested).toEqual([]);
		expect(out.recentlyModified).toEqual([]);
		expect(out.recentlyModifiedTotal).toBe(0);
	});

	it("excludes terminal statuses from both sections", () => {
		const out = composeInboxSections([
			topic({ id: "pub", status: "PUBLISHED" }),
			topic({ id: "dec", status: "DECLINED" }),
		]);
		expect(out.suggested).toEqual([]);
		expect(out.recentlyModified).toEqual([]);
	});

	it("returns empty sections rather than throwing on no input", () => {
		const out = composeInboxSections([]);
		expect(out).toEqual({
			recentlyModified: [],
			recentlyModifiedTotal: 0,
			suggested: [],
		});
	});
});

describe("isTopicSnoozed", () => {
	const now = new Date("2026-05-01T12:00:00.000Z");

	it("treats a null deadline as not snoozed", () => {
		expect(isTopicSnoozed(null, now)).toBe(false);
	});

	it("treats a future deadline as snoozed", () => {
		expect(isTopicSnoozed(new Date("2026-05-01T12:00:00.001Z"), now)).toBe(
			true,
		);
	});

	// THE BOUNDARY. This is the assertion the database test cannot make,
	// because it cannot control the `now` the query captures. Exactly equal
	// must read as ELAPSED — this case, and only this case, distinguishes
	// `>` from `>=`.
	it("treats a deadline exactly equal to now as elapsed", () => {
		expect(isTopicSnoozed(new Date(now.getTime()), now)).toBe(false);
	});

	it("treats a past deadline as elapsed", () => {
		expect(isTopicSnoozed(new Date("2026-05-01T11:59:59.999Z"), now)).toBe(
			false,
		);
	});
});
