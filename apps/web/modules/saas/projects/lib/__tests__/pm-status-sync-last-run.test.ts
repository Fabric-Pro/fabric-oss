import { describe, expect, it } from "vitest";
import {
	derivePmStatusSyncRunView,
	formatPmStatusSyncFetch,
	formatPmStatusSyncOutcomes,
} from "../pm-status-sync-last-run";
import { STALE_AFTER_MS } from "../pm-sync-status";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const zeroCounts = {
	moved: 0,
	unchanged: 0,
	"fabric-ahead": 0,
	"not-mapped": 0,
	ambiguous: 0,
	unverified: 0,
	stale: 0,
	"skipped-conflict": 0,
	raced: 0,
};

const fetchAt = (msAgo: number) => ({
	at: ago(msAgo),
	linked: 12,
	fetched: 12,
	failed: 0,
	notFound: 0,
	complete: true,
});

describe("derivePmStatusSyncRunView", () => {
	it("waits for the first run while the session is younger than two poll intervals", () => {
		expect(
			derivePmStatusSyncRunView({
				lastRun: null,
				sessionAt: ago(10 * MINUTE),
				now: NOW,
			}),
		).toEqual({ kind: "waiting" });
	});

	it("reports silence longer than two poll intervals after the switch went on as stale", () => {
		const sessionAt = ago(STALE_AFTER_MS + MINUTE);
		expect(
			derivePmStatusSyncRunView({ lastRun: null, sessionAt, now: NOW }),
		).toEqual({ kind: "stale", at: new Date(sessionAt), run: null });
		// The same rule for a stored summary that only carries its session.
		expect(
			derivePmStatusSyncRunView({
				lastRun: { sessionAt },
				sessionAt,
				now: NOW,
			}),
		).toEqual({ kind: "stale", at: new Date(sessionAt), run: null });
	});

	it("is healthy when the latest event succeeded within two poll intervals", () => {
		const run = {
			sessionAt: ago(180 * MINUTE),
			fetch: fetchAt(6 * MINUTE),
			outcome: {
				at: ago(5 * MINUTE),
				counts: { ...zeroCounts, unchanged: 12 },
			},
		};
		expect(
			derivePmStatusSyncRunView({
				lastRun: run,
				sessionAt: run.sessionAt,
				now: NOW,
			}),
		).toEqual({ kind: "healthy", at: new Date(NOW - 5 * MINUTE), run });
	});

	it("is stale when the latest success is older than two poll intervals", () => {
		const run = {
			sessionAt: ago(600 * MINUTE),
			fetch: fetchAt(STALE_AFTER_MS + 10 * MINUTE),
		};
		expect(
			derivePmStatusSyncRunView({
				lastRun: run,
				sessionAt: run.sessionAt,
				now: NOW,
			}),
		).toEqual({
			kind: "stale",
			at: new Date(NOW - STALE_AFTER_MS - 10 * MINUTE),
			run,
		});
	});

	it("shows a failed fetch as failed, never as a healthy empty run", () => {
		const run = {
			sessionAt: ago(180 * MINUTE),
			fetch: fetchAt(70 * MINUTE),
			failure: {
				at: ago(10 * MINUTE),
				kind: "fetch-failed" as const,
				error: "GitLab returned 503",
			},
		};
		expect(
			derivePmStatusSyncRunView({
				lastRun: run,
				sessionAt: run.sessionAt,
				now: NOW,
			}),
		).toEqual({
			kind: "failed",
			at: new Date(NOW - 10 * MINUTE),
			reason: "fetch-failed",
			error: "GitLab returned 503",
		});
	});

	it("shows a skipped project (PM source not found) as failed", () => {
		const run = {
			sessionAt: ago(30 * MINUTE),
			failure: {
				at: ago(20 * MINUTE),
				kind: "source-not-found" as const,
				error: "PM source not found",
			},
		};
		expect(
			derivePmStatusSyncRunView({
				lastRun: run,
				sessionAt: run.sessionAt,
				now: NOW,
			}).kind,
		).toBe("failed");
	});

	it("is healthy again once a later fetch succeeds after a failure", () => {
		const run = {
			sessionAt: ago(180 * MINUTE),
			fetch: fetchAt(5 * MINUTE),
			failure: {
				at: ago(70 * MINUTE),
				kind: "fetch-failed" as const,
				error: "GitLab returned 503",
			},
		};
		expect(
			derivePmStatusSyncRunView({
				lastRun: run,
				sessionAt: run.sessionAt,
				now: NOW,
			}).kind,
		).toBe("healthy");
	});

	it("shows outcome counts only when the outcome is from the current fetch cycle (outcome.at >= fetch.at)", () => {
		// Positive control: the outcome is newer than the fetch — the normal,
		// in-order case — so its counts are part of the run.
		const currentOutcome = {
			sessionAt: ago(180 * MINUTE),
			fetch: fetchAt(6 * MINUTE),
			outcome: {
				at: ago(5 * MINUTE),
				counts: { ...zeroCounts, unchanged: 12 },
			},
		};
		expect(
			derivePmStatusSyncRunView({
				lastRun: currentOutcome,
				sessionAt: currentOutcome.sessionAt,
				now: NOW,
			}),
		).toEqual({
			kind: "healthy",
			at: new Date(NOW - 5 * MINUTE),
			run: currentOutcome,
		});

		// A new cycle's fetch has landed, but reconcile has not (yet, or ever)
		// recorded THIS cycle's outcome — the stored outcome still dates from
		// the PREVIOUS cycle. Printing it under the new fetch time would
		// misrepresent an unreconciled cycle as already reconciled.
		const staleOutcome = {
			sessionAt: ago(180 * MINUTE),
			fetch: fetchAt(2 * MINUTE),
			outcome: {
				at: ago(65 * MINUTE),
				counts: { ...zeroCounts, unchanged: 12 },
			},
		};
		expect(
			derivePmStatusSyncRunView({
				lastRun: staleOutcome,
				sessionAt: staleOutcome.sessionAt,
				now: NOW,
			}),
		).toEqual({
			kind: "healthy",
			at: new Date(NOW - 2 * MINUTE),
			run: {
				sessionAt: staleOutcome.sessionAt,
				fetch: staleOutcome.fetch,
			},
		});
	});

	describe("a fetch whose outcome never arrived (reconcile did not finish)", () => {
		const view = (run: Record<string, unknown>) =>
			derivePmStatusSyncRunView({
				lastRun: { sessionAt: ago(180 * MINUTE), ...run },
				sessionAt: ago(180 * MINUTE),
				now: NOW,
			});

		it("positive control: a fresh fetch (5 minutes) with no outcome yet is healthy — reconcile may still be running", () => {
			expect(view({ fetch: fetchAt(5 * MINUTE) })).toEqual({
				kind: "healthy",
				at: new Date(NOW - 5 * MINUTE),
				run: {
					sessionAt: ago(180 * MINUTE),
					fetch: fetchAt(5 * MINUTE),
				},
			});
		});

		it("a fetch 16 minutes old with no outcome is overdue, never healthy", () => {
			expect(view({ fetch: fetchAt(16 * MINUTE) })).toEqual({
				kind: "outcome-overdue",
				at: new Date(NOW - 16 * MINUTE),
				run: {
					sessionAt: ago(180 * MINUTE),
					fetch: fetchAt(16 * MINUTE),
				},
			});
		});

		it("a fetch 16 minutes old whose stored outcome is from the previous cycle is overdue", () => {
			expect(
				view({
					fetch: fetchAt(16 * MINUTE),
					outcome: {
						at: ago(75 * MINUTE),
						counts: { ...zeroCounts, unchanged: 12 },
					},
				}),
			).toEqual({
				kind: "outcome-overdue",
				at: new Date(NOW - 16 * MINUTE),
				// The previous cycle's counts are still dropped.
				run: {
					sessionAt: ago(180 * MINUTE),
					fetch: fetchAt(16 * MINUTE),
				},
			});
		});

		it("a current outcome keeps the run healthy whatever the fetch's age", () => {
			for (const fetchMinutesAgo of [5, 16, 40, 100]) {
				const run = {
					fetch: fetchAt(fetchMinutesAgo * MINUTE),
					outcome: {
						at: ago((fetchMinutesAgo - 1) * MINUTE),
						counts: { ...zeroCounts, unchanged: 12 },
					},
				};
				expect(view(run)).toEqual({
					kind: "healthy",
					at: new Date(NOW - (fetchMinutesAgo - 1) * MINUTE),
					run: { sessionAt: ago(180 * MINUTE), ...run },
				});
			}
		});

		it("past two poll intervals the run is stale, as before", () => {
			expect(view({ fetch: fetchAt(STALE_AFTER_MS + MINUTE) }).kind).toBe(
				"stale",
			);
		});
	});

	it("is unreadable when the stored JSON does not match the schema", () => {
		// Positive control: the same summary with a valid count parses.
		const valid = {
			sessionAt: ago(30 * MINUTE),
			fetch: fetchAt(5 * MINUTE),
		};
		expect(
			derivePmStatusSyncRunView({
				lastRun: valid,
				sessionAt: null,
				now: NOW,
			}).kind,
		).toBe("healthy");

		expect(
			derivePmStatusSyncRunView({
				lastRun: { ...valid, fetch: { ...valid.fetch, linked: "12" } },
				sessionAt: null,
				now: NOW,
			}),
		).toEqual({ kind: "unreadable" });
		expect(
			derivePmStatusSyncRunView({
				lastRun: "garbage",
				sessionAt: null,
				now: NOW,
			}),
		).toEqual({ kind: "unreadable" });
	});
});

describe("formatPmStatusSyncFetch", () => {
	it("prints all five fetch counts, deriving the ones never fetched", () => {
		expect(
			formatPmStatusSyncFetch({
				at: ago(MINUTE),
				linked: 10,
				fetched: 6,
				failed: 1,
				notFound: 1,
				complete: true,
			}),
		).toBe(
			"10 linked · 6 fetched · 1 failed · 1 not found · 2 not fetched",
		);
	});

	it("flags an incomplete fetch", () => {
		expect(
			formatPmStatusSyncFetch({
				at: ago(MINUTE),
				linked: 10,
				fetched: 6,
				failed: 4,
				notFound: 0,
				complete: false,
			}),
		).toBe(
			"10 linked · 6 fetched · 4 failed · 0 not found · 0 not fetched (incomplete — the rest is checked on the next run)",
		);
	});
});

describe("formatPmStatusSyncOutcomes", () => {
	it("prints all nine outcome counts in decision-table order", () => {
		expect(
			formatPmStatusSyncOutcomes({
				...zeroCounts,
				moved: 2,
				unchanged: 8,
				"fabric-ahead": 1,
				raced: 1,
			}),
		).toBe(
			"2 moved · 8 unchanged · 1 Fabric ahead · 0 not mapped · 0 ambiguous · 0 unverified · 0 stale · 0 skipped (conflict) · 1 raced",
		);
	});
});
