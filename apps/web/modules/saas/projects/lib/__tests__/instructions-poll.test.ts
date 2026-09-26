/**
 * R30/I2. The tab polled every 3 seconds for as long as ANY snapshot was
 * RECEIVING or VALIDATING, and nothing in the feature ever wrote a terminal
 * status for a workflow that failed — so a snapshot stranded in VALIDATING
 * polled forever, for every viewer, with no way out but a fresh upload that
 * left the stuck row behind still polling.
 */

import {
	DEFERRED_SCAN_STALE_AFTER_MS,
	RECEIVING_ABANDON_AFTER_MS,
	VALIDATING_STALE_AFTER_MS,
} from "@repo/instructions";
import { describe, expect, it } from "vitest";
import {
	INSTRUCTIONS_FAST_POLL_MS,
	INSTRUCTIONS_FAST_POLL_WINDOW_MS,
	INSTRUCTIONS_PUBLISH_CONVERGENCE_POLLS,
	INSTRUCTIONS_SLOW_POLL_MS,
	instructionsAwaitsPublish,
	instructionsPollInterval,
} from "../instructions-poll";

/** A fixed clock, so nothing here depends on when the suite runs. */
const NOW = 1_800_000_000_000;

describe("instructionsPollInterval", () => {
	it.each(["READY", "REJECTED", "FAILED"])(
		"stops polling once the newest snapshot is %s",
		(status) => {
			expect(
				instructionsPollInterval([{ status }], 0, { now: NOW }),
			).toBe(false);
		},
	);

	it("stops polling for an empty or absent list", () => {
		expect(instructionsPollInterval([], 0, { now: NOW })).toBe(false);
		expect(instructionsPollInterval(undefined, 0, { now: NOW })).toBe(
			false,
		);
	});

	it.each(["RECEIVING", "VALIDATING"])(
		"polls fast while a snapshot is %s and the tab was opened recently",
		(status) => {
			expect(
				instructionsPollInterval([{ status }], 0, { now: NOW }),
			).toBe(INSTRUCTIONS_FAST_POLL_MS);
		},
	);

	it("backs off to the slow interval once the fast window has elapsed", () => {
		const snapshots = [{ status: "VALIDATING" }];
		expect(
			instructionsPollInterval(
				snapshots,
				INSTRUCTIONS_FAST_POLL_WINDOW_MS - 1,
				{ now: NOW },
			),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
		expect(
			instructionsPollInterval(
				snapshots,
				INSTRUCTIONS_FAST_POLL_WINDOW_MS,
				{ now: NOW },
			),
		).toBe(INSTRUCTIONS_SLOW_POLL_MS);
		// Still bounded work, not a stopped clock: a genuinely long-running
		// validation keeps being watched, just cheaply.
		expect(
			instructionsPollInterval(snapshots, 60 * 60 * 1000, { now: NOW }),
		).toBe(INSTRUCTIONS_SLOW_POLL_MS);
	});

	it("keeps polling when an older snapshot is in flight behind a terminal newest one", () => {
		expect(
			instructionsPollInterval(
				[{ status: "READY" }, { status: "VALIDATING" }],
				0,
				{ now: NOW },
			),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
	});

	// Important 4 (round 4): the caller can keep the poll alive past a
	// terminal list while the published pointer catches up.
	it("keeps polling a fully terminal list while publication has not converged", () => {
		expect(
			instructionsPollInterval([{ status: "READY" }], 0, {
				now: NOW,
				awaitingPublish: true,
			}),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
		expect(
			instructionsPollInterval([{ status: "READY" }], 0, {
				now: NOW,
				awaitingPublish: false,
			}),
		).toBe(false);
	});
});

/**
 * Fizzy #2550. `begin` writes RECEIVING and hands the browser its signed
 * PUTs; `finalize` starts the workflow. Close the upload dialog part-way
 * through and `finalize` never happens — there is no workflow, nothing will
 * ever move the row, and the tab polled it for every viewer indefinitely. The
 * scheduled reaper closes such a row out on its own; the tab stops waiting on
 * it at the same threshold.
 */
describe("instructionsPollInterval and an abandoned RECEIVING row", () => {
	const receiving = (ageMs: number) => [
		{ status: "RECEIVING", createdAt: new Date(NOW - ageMs).toISOString() },
	];

	it("keeps polling a RECEIVING row through the abandonment threshold", () => {
		expect(
			instructionsPollInterval(
				receiving(RECEIVING_ABANDON_AFTER_MS - 1),
				0,
				{ now: NOW },
			),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
		// The boundary instant itself: the sweep's predicate is a STRICT
		// `createdAt < cutoff`, so a row of exactly this age is not selected
		// yet. Stopping here left it RECEIVING and unwatched until the next
		// hourly pass.
		expect(
			instructionsPollInterval(receiving(RECEIVING_ABANDON_AFTER_MS), 0, {
				now: NOW,
			}),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
	});

	it("stops polling a RECEIVING row past the threshold", () => {
		expect(
			instructionsPollInterval(
				receiving(RECEIVING_ABANDON_AFTER_MS + 1),
				0,
				{ now: NOW },
			),
		).toBe(false);
		expect(
			instructionsPollInterval(
				receiving(RECEIVING_ABANDON_AFTER_MS * 10),
				0,
				{ now: NOW },
			),
		).toBe(false);
	});

	it("accepts a Date as well as the serialized string the query returns", () => {
		expect(
			instructionsPollInterval(
				[
					{
						status: "RECEIVING",
						createdAt: new Date(
							NOW - RECEIVING_ABANDON_AFTER_MS - 1,
						),
					},
				],
				0,
				{ now: NOW },
			),
		).toBe(false);
	});

	it("keeps polling a VALIDATING row well past the RECEIVING threshold", () => {
		// VALIDATING at six hours is a workflow that owns the row, or one the
		// reaper has not reached yet. The row is still watched; the interval
		// comes from how long THIS TAB has been open (`elapsedMs`), which is
		// a separate clock.
		expect(
			instructionsPollInterval(
				[
					{
						status: "VALIDATING",
						createdAt: new Date(
							NOW - RECEIVING_ABANDON_AFTER_MS,
						).toISOString(),
					},
				],
				INSTRUCTIONS_FAST_POLL_WINDOW_MS,
				{ now: NOW },
			),
		).toBe(INSTRUCTIONS_SLOW_POLL_MS);
	});

	it.each([undefined, null, "not a date"])(
		"keeps polling when createdAt is %s — age is the only thing that can retire the row",
		(createdAt) => {
			expect(
				instructionsPollInterval(
					[{ status: "RECEIVING", createdAt }],
					0,
					{ now: NOW },
				),
			).toBe(INSTRUCTIONS_FAST_POLL_MS);
		},
	);

	it("still polls an abandoned row's list while publication is converging on a newer one", () => {
		// The abandoned row no longer counts as active, but the caller's
		// separate publish-convergence budget is untouched by it.
		expect(
			instructionsPollInterval(
				receiving(RECEIVING_ABANDON_AFTER_MS + 1),
				0,
				{ now: NOW, awaitingPublish: true },
			),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
	});
});

/**
 * Round 7, finding 1. A VALIDATING row whose execution is gone — a `finalize`
 * status write that landed after the run had already closed, or a worker that
 * died between the gate's claim and the boundary catch — has nothing left to
 * write its verdict. The tab polled it forever and never offered "Try again".
 * The reaper's phase 0 heals it at `VALIDATING_STALE_AFTER_MS`; the tab stops
 * waiting a full sweep cycle later, and only after allowing for the fact that
 * a row may sit in RECEIVING for the whole abandonment window before
 * `finalize` is ever called — `createdAt` is the only timestamp the list
 * projection carries, so that allowance has to be in the bound.
 */
describe("instructionsPollInterval and a stranded VALIDATING row", () => {
	const ONE_HOUR_MS = 60 * 60 * 1000;
	/** The tab's own threshold, rebuilt from the constants it shares. */
	const STOPS_AFTER_MS =
		RECEIVING_ABANDON_AFTER_MS + VALIDATING_STALE_AFTER_MS + ONE_HOUR_MS;
	const validating = (ageMs: number) => [
		{
			status: "VALIDATING",
			createdAt: new Date(NOW - ageMs).toISOString(),
		},
	];

	it("keeps polling right up to and including the threshold", () => {
		expect(
			instructionsPollInterval(validating(STOPS_AFTER_MS - 1), 0, {
				now: NOW,
			}),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
		// The boundary instant itself, matching the sweep's STRICT
		// `updatedAt < cutoff` on the other side of the constant.
		expect(
			instructionsPollInterval(validating(STOPS_AFTER_MS), 0, {
				now: NOW,
			}),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
	});

	it("stops polling past the threshold", () => {
		expect(
			instructionsPollInterval(validating(STOPS_AFTER_MS + 1), 0, {
				now: NOW,
			}),
		).toBe(false);
		expect(
			instructionsPollInterval(validating(STOPS_AFTER_MS * 10), 0, {
				now: NOW,
			}),
		).toBe(false);
	});

	it("still watches a validation whose upload sat in RECEIVING for hours first", () => {
		// `finalize` has no age predicate of its own, so a row created at the
		// very edge of the abandonment window can enter VALIDATING legitimately
		// and then take the reaper's whole staleness window. A bound that left
		// the RECEIVING term out would give up on it immediately.
		expect(
			instructionsPollInterval(
				validating(
					RECEIVING_ABANDON_AFTER_MS + VALIDATING_STALE_AFTER_MS,
				),
				0,
				{ now: NOW },
			),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
	});

	it("keeps polling when createdAt is unusable — age is all that can retire it", () => {
		expect(
			instructionsPollInterval(
				[{ status: "VALIDATING", createdAt: null }],
				0,
				{ now: NOW },
			),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
	});
});

/**
 * Important 4 (round 4). `finalizeInstructionSnapshot` writes READY; the NEXT
 * activity moves the project's published pointer. The list poll's terminal
 * condition fired on the first of those and stopped in the gap, so a first
 * upload kept showing "nothing published" and a replacement kept showing the
 * old tree until the viewer reloaded or refocused the tab. A single refetch on
 * seeing READY is not enough either — that refetch can land inside the same
 * gap.
 */
describe("instructionsAwaitsPublish", () => {
	const base = {
		snapshots: [{ id: "snap_2", status: "READY", publishOnReady: true }],
		publishedId: "snap_1",
		readySince: 1_000,
		now: 1_000,
		elapsedMs: 0,
	};

	it("waits while the newest READY snapshot is not yet the published pointer", () => {
		expect(instructionsAwaitsPublish(base)).toBe(true);
	});

	it("stops as soon as the pointer names that snapshot", () => {
		expect(
			instructionsAwaitsPublish({ ...base, publishedId: "snap_2" }),
		).toBe(false);
	});

	it.each(["RECEIVING", "VALIDATING", "REJECTED", "FAILED"])(
		"never waits on a %s snapshot",
		(status) => {
			expect(
				instructionsAwaitsPublish({
					...base,
					snapshots: [{ id: "snap_2", status, publishOnReady: true }],
				}),
			).toBe(false);
		},
	);

	// A manual-publish project never moves the pointer on its own; the History
	// dialog's Publish button invalidates both queries itself.
	it("does not wait when the snapshot is not set to publish itself", () => {
		expect(
			instructionsAwaitsPublish({
				...base,
				snapshots: [
					{ id: "snap_2", status: "READY", publishOnReady: false },
				],
			}),
		).toBe(false);
	});

	it("does not wait before this tab has seen the snapshot reach READY", () => {
		expect(instructionsAwaitsPublish({ ...base, readySince: null })).toBe(
			false,
		);
	});

	it("gives up after the bounded run of further polls, at whichever interval is in force", () => {
		const fastBudget =
			INSTRUCTIONS_PUBLISH_CONVERGENCE_POLLS * INSTRUCTIONS_FAST_POLL_MS;
		expect(
			instructionsAwaitsPublish({ ...base, now: 1_000 + fastBudget - 1 }),
		).toBe(true);
		expect(
			instructionsAwaitsPublish({ ...base, now: 1_000 + fastBudget }),
		).toBe(false);

		// Past the fast window the budget is measured in slow polls, so a tab
		// left open on a long validation still gets its 20 chances.
		const slowBudget =
			INSTRUCTIONS_PUBLISH_CONVERGENCE_POLLS * INSTRUCTIONS_SLOW_POLL_MS;
		const late = {
			...base,
			elapsedMs: INSTRUCTIONS_FAST_POLL_WINDOW_MS,
		};
		expect(
			instructionsAwaitsPublish({ ...late, now: 1_000 + slowBudget - 1 }),
		).toBe(true);
		expect(
			instructionsAwaitsPublish({ ...late, now: 1_000 + slowBudget }),
		).toBe(false);
	});

	it("does not wait on an empty or absent list", () => {
		expect(instructionsAwaitsPublish({ ...base, snapshots: [] })).toBe(
			false,
		);
		expect(
			instructionsAwaitsPublish({ ...base, snapshots: undefined }),
		).toBe(false);
	});
});

/**
 * Publish first, scan afterwards (Fizzy #2737). A version published before
 * its secret scan is READY while the scan is PENDING, and the tab has a
 * verdict still to show — so READY alone is not "nothing left to watch".
 * The same age rule as the active statuses retires one whose workflow died:
 * the reaper's `DEFERRED_SCAN_STALE_AFTER_MS`, by `readyAt`, plus one hourly
 * cycle for the sweep to record INCOMPLETE.
 */
describe("instructionsPollInterval — deferred secret scan", () => {
	const HOUR = 60 * 60 * 1000;
	const bound = DEFERRED_SCAN_STALE_AFTER_MS + HOUR;
	const pending = (readyAgoMs: number | null) => ({
		status: "READY",
		deferredScanStatus: "PENDING",
		readyAt: readyAgoMs === null ? null : new Date(NOW - readyAgoMs),
	});

	it("keeps polling while a READY version's scan is pending", () => {
		expect(instructionsPollInterval([pending(0)], 0, { now: NOW })).toBe(
			INSTRUCTIONS_FAST_POLL_MS,
		);
	});

	it("keeps polling up to and including the bound, and stops past it", () => {
		expect(
			instructionsPollInterval([pending(bound)], 0, { now: NOW }),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
		expect(
			instructionsPollInterval([pending(bound + 1)], 0, { now: NOW }),
		).toBe(false);
	});

	it("keeps polling a pending scan with no usable readyAt", () => {
		expect(instructionsPollInterval([pending(null)], 0, { now: NOW })).toBe(
			INSTRUCTIONS_FAST_POLL_MS,
		);
	});

	it.each(["PASSED", "ISSUES_FOUND", "INCOMPLETE"])(
		"stops once the scan's verdict is %s",
		(deferredScanStatus) => {
			expect(
				instructionsPollInterval(
					[{ ...pending(0), deferredScanStatus }],
					0,
					{ now: NOW },
				),
			).toBe(false);
		},
	);

	// A pending marker on a row that is not READY is not this case; the
	// row's own status decides.
	it("does not treat a pending marker on a terminal non-READY row as in flight", () => {
		expect(
			instructionsPollInterval(
				[{ ...pending(0), status: "REJECTED" }],
				0,
				{ now: NOW },
			),
		).toBe(false);
	});

	// The published view renders its alert off the pointer row, which need
	// not be in the list the tab holds.
	it("keeps polling on the published row's pending scan alone", () => {
		expect(
			instructionsPollInterval([{ status: "READY" }], 0, {
				now: NOW,
				published: pending(0),
			}),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
		expect(
			instructionsPollInterval([{ status: "READY" }], 0, {
				now: NOW,
				published: pending(bound + 1),
			}),
		).toBe(false);
		expect(
			instructionsPollInterval([{ status: "READY" }], 0, {
				now: NOW,
				published: null,
			}),
		).toBe(false);
	});

	it("backs off to the slow interval like any other in-flight row", () => {
		expect(
			instructionsPollInterval(
				[pending(0)],
				INSTRUCTIONS_FAST_POLL_WINDOW_MS,
				{ now: NOW },
			),
		).toBe(INSTRUCTIONS_SLOW_POLL_MS);
	});
});
