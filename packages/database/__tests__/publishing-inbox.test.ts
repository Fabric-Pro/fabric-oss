import { describe, expect, it } from "vitest";
import {
	AGING_AFTER_DAYS,
	composeInboxSections,
	isTopicSnoozed,
	STALE_AFTER_DAYS,
	topicNeglect,
} from "../src/publishing-inbox";

type T = {
	id: string;
	status: string;
	isSnoozed: boolean;
	createdAt: Date;
	updatedAt: Date;
	snoozedUntil: Date | null;
};

const topic = (o: Partial<T> & { id: string }): T => ({
	status: "SUGGESTION",
	isSnoozed: false,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	snoozedUntil: null,
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
	//
	// `now` is passed explicitly so both fixtures are unambiguously FRESH.
	// Without it the function reads the real clock, both topics fall past the
	// staleness threshold, and the case would keep passing for the wrong
	// reason — as a test of the stale partition below rather than of tier
	// order.
	it("preserves the caller's 1B tier order in Suggested instead of re-sorting by date", () => {
		const out = composeInboxSections(
			[
				topic({
					id: "old-contributed",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
				}),
				topic({
					id: "new-untiered",
					createdAt: new Date("2026-09-01T00:00:00.000Z"),
				}),
			],
			{ now: new Date("2026-01-10T00:00:00.000Z") },
		);
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

	// The archive, and the property that makes it safe: it is a PARTITION, so
	// 1B's tier order has to survive inside each group. The fixture
	// interleaves fresh and stale in the incoming array precisely so that a
	// naive `sort` by staleness — or one that swept a date tiebreak in with it
	// — reorders something and fails here.
	it("archives stale suggestions out of Suggested and preserves tier order inside each group", () => {
		const now = new Date("2026-06-01T00:00:00.000Z");
		const stale = new Date("2026-01-01T00:00:00.000Z");
		const fresh = new Date("2026-05-30T00:00:00.000Z");
		const out = composeInboxSections(
			[
				topic({ id: "fresh-1", updatedAt: fresh }),
				topic({ id: "stale-1", updatedAt: stale }),
				topic({ id: "fresh-2", updatedAt: fresh }),
				topic({ id: "stale-2", updatedAt: stale }),
			],
			{ now },
		);
		expect(out.suggested.map((t) => t.id)).toEqual(["fresh-1", "fresh-2"]);
		expect(out.archived.map((t) => t.id)).toEqual(["stale-1", "stale-2"]);
	});

	// The aging band SINKS. This replaces an assertion that it stays put — the
	// card owner asked for the opposite ("if for 10+ days we can start lowering
	// it in the list"), and that decision overrides the earlier one.
	//
	// What is still protected, and what this fixture is built to prove, is that
	// the sink does NOT flatten 1B's per-viewer tier order across the section.
	// The input interleaves aging and fresh so that the head keeps its incoming
	// order exactly — `fresh-1` before `fresh-2` — while the tail is ordered by
	// neglect, least neglected first. An implementation that simply sorted the
	// whole section by age would put `fresh-1` and `fresh-2` in a different
	// relationship to each other and fail here.
	it("sinks the aging band below the live topics, oldest last", () => {
		const now = new Date("2026-06-01T00:00:00.000Z");
		const daysBefore = (n: number) =>
			new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
		const out = composeInboxSections(
			[
				topic({
					id: "aging-old",
					updatedAt: daysBefore(STALE_AFTER_DAYS - 1),
				}),
				topic({ id: "fresh-1", updatedAt: daysBefore(1) }),
				topic({
					id: "aging-new",
					updatedAt: daysBefore(AGING_AFTER_DAYS),
				}),
				topic({
					id: "stale-1",
					updatedAt: daysBefore(STALE_AFTER_DAYS),
				}),
				topic({ id: "fresh-2", updatedAt: daysBefore(2) }),
			],
			{ now },
		);
		// Head: incoming order, untouched. Tail: by neglect, ascending — the
		// topic quiet for 10 days sits above the one quiet for 29.
		expect(out.suggested.map((t) => t.id)).toEqual([
			"fresh-1",
			"fresh-2",
			"aging-new",
			"aging-old",
		]);
		expect(out.archived.map((t) => t.id)).toEqual(["stale-1"]);
	});

	// The head is where 1B's ranking lives, so it must survive the sink
	// untouched even when every topic in it is equally fresh. A comparator
	// applied to the WHOLE section rather than to the aging tail would reorder
	// these by `updatedAt` and fail.
	it("never reorders the live topics among themselves", () => {
		const now = new Date("2026-06-01T00:00:00.000Z");
		const daysBefore = (n: number) =>
			new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
		const out = composeInboxSections(
			[
				topic({ id: "ranked-3rd", updatedAt: daysBefore(1) }),
				topic({ id: "ranked-1st", updatedAt: daysBefore(5) }),
				topic({ id: "ranked-2nd", updatedAt: daysBefore(3) }),
			],
			{ now },
		);
		expect(out.suggested.map((t) => t.id)).toEqual([
			"ranked-3rd",
			"ranked-1st",
			"ranked-2nd",
		]);
	});

	// NEGATIVE CONTROL for the archive: de-cluttered is not deleted. A stale
	// suggestion leaves Suggested, but it has to leave INTO something — this
	// is what makes the archive reachable rather than a filter that drops the
	// topic on the floor.
	it("loses no stale suggestion — what leaves Suggested arrives in archived", () => {
		const out = composeInboxSections(
			[topic({ id: "ancient", updatedAt: new Date("2020-01-01") })],
			{ now: new Date("2026-06-01T00:00:00.000Z") },
		);
		expect(out.suggested).toEqual([]);
		expect(out.archived.map((t) => t.id)).toEqual(["ancient"]);
	});

	// FR8 at the section level: the archive must never take a snoozed topic,
	// and must hand back one whose snooze has ended even though its last real
	// edit is far past the threshold. Both arrive here from the same property
	// rather than from a check this function makes.
	it("never archives a snoozed topic, and returns one whose snooze has ended", () => {
		const now = new Date("2026-06-01T00:00:00.000Z");
		const daysBefore = (n: number) =>
			new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
		const out = composeInboxSections(
			[
				topic({
					id: "returned",
					updatedAt: new Date("2020-01-01"),
					snoozedUntil: daysBefore(3),
				}),
				topic({
					id: "still-asleep",
					isSnoozed: true,
					updatedAt: new Date("2020-01-01"),
					snoozedUntil: new Date("2026-09-01T00:00:00.000Z"),
				}),
			],
			{ now },
		);
		// The returned topic is back in Suggested, not archived — the whole of
		// UC5. The sleeping one is in neither section (snoozed topics never
		// are) and, critically, is NOT in `archived`: it must still be waiting
		// when its three months are up.
		expect(out.suggested.map((t) => t.id)).toEqual(["returned"]);
		expect(out.archived).toEqual([]);
	});

	// Recently Modified is explicitly out of scope: an untouched IN_PROGRESS
	// topic is a different problem from a suggestion nobody picked up, and its
	// section keeps its own updatedAt-desc order.
	it("never archives anything in Recently Modified", () => {
		const now = new Date("2026-06-01T00:00:00.000Z");
		const out = composeInboxSections(
			[
				topic({
					id: "ancient",
					status: "IN_PROGRESS",
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				}),
				topic({
					id: "recent",
					status: "SELECTED",
					updatedAt: new Date("2026-05-30T00:00:00.000Z"),
				}),
			],
			{ now },
		);
		expect(out.recentlyModified.map((t) => t.id)).toEqual([
			"recent",
			"ancient",
		]);
	});

	it("returns empty sections rather than throwing on no input", () => {
		const out = composeInboxSections([]);
		expect(out).toEqual({
			recentlyModified: [],
			recentlyModifiedTotal: 0,
			suggested: [],
			archived: [],
		});
	});
});

describe("topicNeglect", () => {
	const now = new Date("2026-06-01T00:00:00.000Z");
	const daysBefore = (n: number) =>
		new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

	it("returns the whole-day count for an untouched suggestion", () => {
		const days = STALE_AFTER_DAYS + 12;
		expect(
			topicNeglect(topic({ id: "a", updatedAt: daysBefore(days) }), now),
		).toEqual({ days, level: "stale" });
	});

	// THE BOUNDARY — the assertion that distinguishes `>=` from `>`, and the
	// reason `now` is a parameter at all. Exactly at the threshold counts as
	// stale, so the badge escalates on the day it is due rather than the day
	// after.
	it("treats exactly the stale threshold as stale", () => {
		expect(
			topicNeglect(
				topic({ id: "a", updatedAt: daysBefore(STALE_AFTER_DAYS) }),
				now,
			),
		).toEqual({ days: STALE_AFTER_DAYS, level: "stale" });
	});

	// The SAME boundary assertion for the earlier threshold, and the case that
	// distinguishes graduated staleness from the binary version this replaced:
	// one day inside the stale threshold used to be nothing at all.
	it("reports aging one day inside the stale threshold", () => {
		expect(
			topicNeglect(
				topic({ id: "a", updatedAt: daysBefore(STALE_AFTER_DAYS - 1) }),
				now,
			),
		).toEqual({ days: STALE_AFTER_DAYS - 1, level: "aging" });
	});

	it("treats exactly the aging threshold as aging", () => {
		expect(
			topicNeglect(
				topic({ id: "a", updatedAt: daysBefore(AGING_AFTER_DAYS) }),
				now,
			),
		).toEqual({ days: AGING_AFTER_DAYS, level: "aging" });
	});

	// NEGATIVE CONTROL for the pair above: a level every suggestion carries
	// would say nothing.
	it("returns null one day inside the aging threshold", () => {
		expect(
			topicNeglect(
				topic({ id: "a", updatedAt: daysBefore(AGING_AFTER_DAYS - 1) }),
				now,
			),
		).toBeNull();
	});

	// A snooze is a deliberate "not now" — the opposite of neglect. Badging a
	// snoozed topic would tell the person who parked it that parking it was a
	// mistake.
	//
	// The fixture carries a REAL future `snoozedUntil` rather than only
	// `isSnoozed: true`, and that is the whole point of the case. There is no
	// `if (isSnoozed)` guard in the source any more — the exemption comes out
	// of `topicLastActivityAt`, which counts a snooze as activity. A fixture
	// that set only the boolean would pass against a guard and prove nothing
	// about the property, so a broken property could ship green.
	it("never calls a snoozed topic neglected, however old", () => {
		expect(
			topicNeglect(
				topic({
					id: "a",
					isSnoozed: true,
					updatedAt: new Date("2020-01-01"),
					snoozedUntil: new Date("2026-09-01T00:00:00.000Z"),
				}),
				now,
			),
		).toBeNull();
	});

	// FR8/UC5, the half a threshold measured on `updatedAt` alone gets wrong:
	// "No topic is permanently lost due to snoozing; it always returns on
	// schedule." This topic was last edited in 2020 and would be archived on
	// any reading of `updatedAt` — but its snooze ended a week ago, and a
	// snooze ending IS activity, so it comes back fresh and unbadged.
	it("treats a topic returning from snooze as fresh, however old its last edit", () => {
		expect(
			topicNeglect(
				topic({
					id: "a",
					updatedAt: new Date("2020-01-01"),
					snoozedUntil: daysBefore(7),
				}),
				now,
			),
		).toBeNull();
	});

	// The other side of that: returning from snooze restarts the clock, it
	// does not stop it. Nobody touched this one for the two months after it
	// came back, so it is stale on its own account.
	it("ages a returned topic from the moment its snooze elapsed", () => {
		expect(
			topicNeglect(
				topic({
					id: "a",
					updatedAt: new Date("2020-01-01"),
					snoozedUntil: daysBefore(STALE_AFTER_DAYS + 5),
				}),
				now,
			),
		).toEqual({ days: STALE_AFTER_DAYS + 5, level: "stale" });
	});

	// Neglect is about a suggestion nobody acted on. Once a topic has a
	// status, "nothing happened lately" is a different statement and this is
	// not the mechanism that should make it.
	it.each(["SELECTED", "IN_PROGRESS", "PUBLISHED", "DECLINED"])(
		"never calls a %s topic neglected",
		(status) => {
			expect(
				topicNeglect(
					topic({
						id: "a",
						status,
						updatedAt: new Date("2020-01-01"),
					}),
					now,
				),
			).toBeNull();
		},
	);
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
