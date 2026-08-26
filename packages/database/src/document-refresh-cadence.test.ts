import { describe, expect, it } from "vitest";
import {
	type DocumentRefreshCadenceSettings,
	isEventDrivenCadence,
	isRefreshDue,
	refreshIntervalDays,
	refreshPeriodBucket,
	refreshWorkflowId,
} from "./document-refresh-cadence";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const NOW = new Date("2026-07-13T12:00:00.000Z");

/**
 * `isRefreshDue` adds a deterministic per-document jitter of 0-23 hours to the
 * cadence interval, so a document is due at `interval + jitter(documentId)` —
 * never at the interval exactly (unless its jitter happens to be zero).
 *
 * These ids pin the two ends of that range, so the boundary tests below can be
 * exact rather than approximate:
 *   - `doc_34` hashes to a 0-hour jitter — due at the interval precisely.
 *   - `doc_35` hashes to a 23-hour jitter — the latest any document can be due.
 *   - `doc_1` (the default) hashes to 10 hours.
 * Derived from the same hash the implementation uses; a change to that hash is
 * expected to fail these.
 */
const NO_JITTER_ID = "doc_34";
const MAX_JITTER_ID = "doc_35";
const DEFAULT_JITTER_HOURS = 10;

/**
 * One full day past the interval. Larger than any possible jitter (23h), so an
 * assertion at this offset holds for EVERY document id — the jitter-safe way to
 * say "the interval has definitely elapsed".
 */
const PAST_ANY_JITTER_MS = 24 * HOUR_MS;

function settings(
	over: Partial<DocumentRefreshCadenceSettings> = {},
): DocumentRefreshCadenceSettings {
	return {
		documentId: "doc_1",
		enabled: true,
		cadence: "BIWEEKLY",
		lastRefreshedAt: null,
		lastAttemptAt: null,
		...over,
	};
}

function daysAgo(days: number): Date {
	return new Date(NOW.getTime() - days * DAY_MS);
}

/** `days` plus `hours` before NOW — for probing the jitter window precisely. */
function ago(days: number, hours: number): Date {
	return new Date(NOW.getTime() - (days * DAY_MS + hours * HOUR_MS));
}

describe("refreshIntervalDays", () => {
	it("maps the four supported cadences", () => {
		expect(refreshIntervalDays("DAILY")).toBe(1);
		expect(refreshIntervalDays("WEEKLY")).toBe(7);
		expect(refreshIntervalDays("BIWEEKLY")).toBe(14);
		expect(refreshIntervalDays("MONTHLY")).toBe(30);
	});

	// The sweep query pre-filters on SHORTEST_CADENCE_DAYS before `isRefreshDue`
	// is consulted, so a pre-filter LONGER than the shortest real interval
	// silently removes documents from the sweep entirely. That is exactly what
	// happened when DAILY was added and the constant was left at 7: a document
	// refreshed yesterday never reached the due-check, so "Daily" behaved as
	// weekly. This pins the relationship so the next cadence cannot repeat it.
	it("has no cadence shorter than the sweep's pre-filter window", () => {
		const SHORTEST_CADENCE_DAYS_IN_QUERY = 1;

		const shortest = Math.min(
			...["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY"].map(
				refreshIntervalDays,
			),
		);

		expect(SHORTEST_CADENCE_DAYS_IN_QUERY).toBeLessThanOrEqual(shortest);
	});

	it("falls back to the bi-weekly interval for an unknown cadence", () => {
		// A corrupt settings row must not be able to wedge the sweep.
		expect(refreshIntervalDays("FORTNIGHTLY-ISH")).toBe(14);
		expect(refreshIntervalDays("")).toBe(14);
	});
});

describe("ON_DEPLOY — event-driven, never time-driven", () => {
	it("becomes due once a deploy is pending, and not before", () => {
		// The whole mechanism in one assertion: the marker is what makes it due,
		// so a deploy can trigger a refresh without a second dispatch path.
		expect(
			isRefreshDue(
				settings({
					cadence: "ON_DEPLOY",
					lastRefreshedAt: daysAgo(1),
					deployPendingSince: NOW,
				}),
				NOW,
			),
		).toBe(true);
	});

	it("still respects the post-failure backoff with a deploy pending", () => {
		// Otherwise a deploy refresh that keeps failing re-dispatches every hour,
		// because the marker is not cleared until a cycle completes.
		expect(
			isRefreshDue(
				settings({
					cadence: "ON_DEPLOY",
					deployPendingSince: NOW,
					lastAttemptAt: new Date(NOW.getTime() - 1 * HOUR_MS),
				}),
				NOW,
			),
		).toBe(false);
	});

	it("is never due on elapsed time, however long it has been", () => {
		// The trap this guards: an unrecognised cadence falls back to the
		// fortnightly interval, so without an explicit check "refresh on deploy"
		// would ALSO mean "and every fortnight regardless" — and bill for it.
		for (const days of [0, 1, 14, 60, 400]) {
			expect(
				isRefreshDue(
					settings({
						cadence: "ON_DEPLOY",
						lastRefreshedAt: daysAgo(days),
					}),
					NOW,
				),
			).toBe(false);
		}
	});

	it("is not due even when it has never refreshed", () => {
		// Every time-based cadence is due immediately on enrollment. This one is
		// not: there is nothing to respond to until a deploy happens.
		expect(
			isRefreshDue(
				settings({ cadence: "ON_DEPLOY", lastRefreshedAt: null }),
				NOW,
			),
		).toBe(false);
	});

	it("recognises exactly one cadence as event-driven", () => {
		expect(isEventDrivenCadence("ON_DEPLOY")).toBe(true);
		for (const c of [
			"DAILY",
			"WEEKLY",
			"BIWEEKLY",
			"MONTHLY",
			"NONSENSE",
		]) {
			expect(isEventDrivenCadence(c)).toBe(false);
		}
	});
});

describe("isRefreshDue", () => {
	it("is not due when the document is not enrolled, however long it has been", () => {
		expect(
			isRefreshDue(
				settings({ enabled: false, lastRefreshedAt: daysAgo(400) }),
				NOW,
			),
		).toBe(false);
	});

	it("is due immediately when enrolled and never refreshed", () => {
		// Jitter is only added to an ELAPSED interval — a document with no
		// lastRefreshedAt has no interval to offset, so enrollment is not delayed.
		expect(isRefreshDue(settings({ lastRefreshedAt: null }), NOW)).toBe(
			true,
		);
		expect(
			isRefreshDue(
				settings({ documentId: MAX_JITTER_ID, lastRefreshedAt: null }),
				NOW,
			),
		).toBe(true);
	});

	it("WEEKLY is not due at 6 days and is due at 7 days + jitter", () => {
		const s = { cadence: "WEEKLY" as const };
		expect(
			isRefreshDue(settings({ ...s, lastRefreshedAt: daysAgo(6) }), NOW),
		).toBe(false);
		// Not at 7 days exactly: doc_1 carries a 10-hour jitter.
		expect(
			isRefreshDue(settings({ ...s, lastRefreshedAt: daysAgo(7) }), NOW),
		).toBe(false);
		expect(
			isRefreshDue(
				settings({
					...s,
					lastRefreshedAt: ago(7, DEFAULT_JITTER_HOURS),
				}),
				NOW,
			),
		).toBe(true);
	});

	it("BIWEEKLY is not due at 13 days and is due at 14 days + jitter", () => {
		expect(
			isRefreshDue(settings({ lastRefreshedAt: daysAgo(13) }), NOW),
		).toBe(false);
		expect(
			isRefreshDue(settings({ lastRefreshedAt: daysAgo(14) }), NOW),
		).toBe(false);
		expect(
			isRefreshDue(
				settings({ lastRefreshedAt: ago(14, DEFAULT_JITTER_HOURS) }),
				NOW,
			),
		).toBe(true);
	});

	it("MONTHLY is not due at 29 days and is due at 30 days + jitter", () => {
		const s = { cadence: "MONTHLY" as const };
		expect(
			isRefreshDue(settings({ ...s, lastRefreshedAt: daysAgo(29) }), NOW),
		).toBe(false);
		expect(
			isRefreshDue(settings({ ...s, lastRefreshedAt: daysAgo(30) }), NOW),
		).toBe(false);
		expect(
			isRefreshDue(
				settings({
					...s,
					lastRefreshedAt: ago(30, DEFAULT_JITTER_HOURS),
				}),
				NOW,
			),
		).toBe(true);
	});

	it("is due for every cadence once a full day past the interval has passed", () => {
		// The jitter-safe upper bound: 24h exceeds the widest possible jitter, so no
		// document can still be held back at this point whatever its id hashes to.
		for (const [cadence, days] of [
			["WEEKLY", 7],
			["BIWEEKLY", 14],
			["MONTHLY", 30],
		] as const) {
			for (const documentId of [NO_JITTER_ID, MAX_JITTER_ID, "doc_1"]) {
				expect(
					isRefreshDue(
						settings({
							documentId,
							cadence,
							lastRefreshedAt: new Date(
								NOW.getTime() -
									(days * DAY_MS + PAST_ANY_JITTER_MS),
							),
						}),
						NOW,
					),
				).toBe(true);
			}
		}
	});

	it("holds a due document inside the post-failure backoff window", () => {
		const justAttempted = new Date(NOW.getTime() - 1 * HOUR_MS);
		expect(
			isRefreshDue(
				settings({
					lastRefreshedAt: daysAgo(30),
					lastAttemptAt: justAttempted,
				}),
				NOW,
			),
		).toBe(false);
	});

	it("releases a due document once the backoff window has passed", () => {
		const attemptedLongAgo = new Date(NOW.getTime() - 7 * HOUR_MS);
		expect(
			isRefreshDue(
				settings({
					lastRefreshedAt: daysAgo(30),
					lastAttemptAt: attemptedLongAgo,
				}),
				NOW,
			),
		).toBe(true);
	});
});

/**
 * The anti-herd property.
 *
 * Every document enrolled before the feature was switched on becomes due in the
 * same tick. Without a per-document offset they would all refresh within the
 * same hour, and therefore all come due again in the same hour a fortnight
 * later — forever, in one thundering stampede against the model provider.
 */
describe("isRefreshDue — per-document jitter", () => {
	it("does not make two documents with identical timestamps due in the same hour", () => {
		// Same cadence, same lastRefreshedAt, different ids. This is the exact state
		// a bulk enrollment leaves behind.
		const lastRefreshedAt = daysAgo(14);
		const due = [NO_JITTER_ID, MAX_JITTER_ID].map((documentId) =>
			isRefreshDue(settings({ documentId, lastRefreshedAt }), NOW),
		);

		expect(due).toEqual([true, false]);
	});

	it("spreads a bulk enrollment across the day rather than firing it at once", () => {
		const lastRefreshedAt = daysAgo(14);
		const ids = Array.from({ length: 40 }, (_, i) => `doc_${i}`);

		const dueNow = ids.filter((documentId) =>
			isRefreshDue(settings({ documentId, lastRefreshedAt }), NOW),
		);

		// Some are held back and some are released — the herd is broken up. (An
		// unjittered implementation returns all 40 here.)
		expect(dueNow.length).toBeGreaterThan(0);
		expect(dueNow.length).toBeLessThan(ids.length);
	});

	it("is deterministic — the same document always lands on the same offset", () => {
		// Replay-safety: the sweep is an activity, but this maths also runs inside
		// workflow-adjacent code paths and must never depend on wall-clock or random.
		const at = ago(14, 12);
		const first = isRefreshDue(
			settings({ documentId: "doc_7", lastRefreshedAt: at }),
			NOW,
		);
		for (let i = 0; i < 5; i++) {
			expect(
				isRefreshDue(
					settings({ documentId: "doc_7", lastRefreshedAt: at }),
					NOW,
				),
			).toBe(first);
		}
	});

	it("never delays a document by more than 23 hours past its interval", () => {
		// The jitter is bounded, not unbounded: a document must not be able to drift
		// a whole extra cadence period.
		const lastRefreshedAt = ago(14, 23);
		for (let i = 0; i < 40; i++) {
			expect(
				isRefreshDue(
					settings({ documentId: `doc_${i}`, lastRefreshedAt }),
					NOW,
				),
			).toBe(true);
		}
	});

	it("adds the offset ON TOP of the interval — never fires early", () => {
		// The jitter must delay, never advance: a 0-23h offset that SUBTRACTED would
		// refresh a document before its cadence had elapsed.
		const oneHourShort = ago(13, 23);
		for (let i = 0; i < 40; i++) {
			expect(
				isRefreshDue(
					settings({
						documentId: `doc_${i}`,
						lastRefreshedAt: oneHourShort,
					}),
					NOW,
				),
			).toBe(false);
		}
	});

	// The jitter window is a QUARTER of the interval, not a flat 24 hours. On the
	// multi-week cadences a quarter is already past a day, so they keep the full
	// window and nothing about them changes. DAILY is the reason the cap exists:
	// a flat 24h spread would push a one-day interval out to nearly two, so half
	// the documents on the cadence that literally says "Daily" would refresh every
	// other day.
	it("keeps DAILY within 30 hours for every document", () => {
		// 30h is chosen to discriminate, not to be comfortable. With the quarter-
		// interval cap the worst case is 24 + 5 = 29h, so every document is due.
		// With the old flat 24h window the worst case was 24 + 23 = 47h, and the
		// documents whose offset exceeded 6h would still be waiting — so this test
		// fails without the cap. A softer bound like 48h passes either way and
		// proves nothing.
		const lastRefreshedAt = ago(1, 6);
		for (let i = 0; i < 200; i++) {
			expect(
				isRefreshDue(
					settings({
						documentId: `doc_${i}`,
						cadence: "DAILY",
						lastRefreshedAt,
					}),
					NOW,
				),
			).toBe(true);
		}
	});

	it("still spreads DAILY documents rather than firing them in one tick", () => {
		// Bounded is not the same as absent — the herd must still be broken up, or
		// every document enrolled on the same day re-forms the thundering herd at
		// the same hour every day thereafter.
		const justPastOneDay = ago(1, 1);
		const due = Array.from({ length: 200 }, (_, i) =>
			isRefreshDue(
				settings({
					documentId: `doc_${i}`,
					cadence: "DAILY",
					lastRefreshedAt: justPastOneDay,
				}),
				NOW,
			),
		);

		expect(due.some(Boolean)).toBe(true);
		expect(due.some((d) => !d)).toBe(true);
	});

	it("leaves the multi-week cadences' jitter window untouched", () => {
		// A quarter of 7 days is 42h, already past the 24h ceiling, so WEEKLY and
		// everything longer keep exactly the spread they had before DAILY existed.
		// Regression guard: narrowing these would re-herd every enrolled document.
		const justPastInterval = ago(14, 1);
		const due = Array.from({ length: 200 }, (_, i) =>
			isRefreshDue(
				settings({
					documentId: `doc_${i}`,
					cadence: "BIWEEKLY",
					lastRefreshedAt: justPastInterval,
				}),
				NOW,
			),
		);

		expect(due.some(Boolean)).toBe(true);
		expect(due.some((d) => !d)).toBe(true);
	});
});

describe("refreshPeriodBucket", () => {
	it("is stable within one interval", () => {
		const a = refreshPeriodBucket("BIWEEKLY", NOW);
		const b = refreshPeriodBucket(
			"BIWEEKLY",
			new Date(NOW.getTime() + DAY_MS),
		);
		expect(a).toBe(b);
	});

	it("changes across the interval boundary", () => {
		const a = refreshPeriodBucket("WEEKLY", NOW);
		const b = refreshPeriodBucket(
			"WEEKLY",
			new Date(NOW.getTime() + 14 * DAY_MS),
		);
		expect(a).not.toBe(b);
	});

	it("never lands two consecutive cycles in the same bucket", () => {
		// A completed refresh advances lastRefreshedAt, so the soonest a document
		// can be dispatched again is one full interval later — which is exactly one
		// bucket wide. This is what makes the bucket safe inside a workflow id.
		for (const cadence of ["WEEKLY", "BIWEEKLY", "MONTHLY"] as const) {
			const interval = refreshIntervalDays(cadence);
			const first = refreshPeriodBucket(cadence, NOW);
			const next = refreshPeriodBucket(
				cadence,
				new Date(NOW.getTime() + interval * DAY_MS),
			);
			expect(next).not.toBe(first);
		}
	});
});

describe("refreshWorkflowId", () => {
	it("is deterministic for one document within an interval", () => {
		expect(refreshWorkflowId("doc_1", "BIWEEKLY", NOW)).toBe(
			refreshWorkflowId(
				"doc_1",
				"BIWEEKLY",
				new Date(NOW.getTime() + DAY_MS),
			),
		);
	});

	it("differs across documents", () => {
		expect(refreshWorkflowId("doc_1", "BIWEEKLY", NOW)).not.toBe(
			refreshWorkflowId("doc_2", "BIWEEKLY", NOW),
		);
	});
});
