/**
 * R30/I2. The tab polled every 3 seconds for as long as ANY snapshot was
 * RECEIVING or VALIDATING, and nothing in the feature ever wrote a terminal
 * status for a workflow that failed — so a snapshot stranded in VALIDATING
 * polled forever, for every viewer, with no way out but a fresh upload that
 * left the stuck row behind still polling.
 */

import { describe, expect, it } from "vitest";
import {
	INSTRUCTIONS_FAST_POLL_MS,
	INSTRUCTIONS_FAST_POLL_WINDOW_MS,
	INSTRUCTIONS_PUBLISH_CONVERGENCE_POLLS,
	INSTRUCTIONS_SLOW_POLL_MS,
	instructionsAwaitsPublish,
	instructionsPollInterval,
} from "../instructions-poll";

describe("instructionsPollInterval", () => {
	it.each(["READY", "REJECTED", "FAILED"])(
		"stops polling once the newest snapshot is %s",
		(status) => {
			expect(instructionsPollInterval([{ status }], 0)).toBe(false);
		},
	);

	it("stops polling for an empty or absent list", () => {
		expect(instructionsPollInterval([], 0)).toBe(false);
		expect(instructionsPollInterval(undefined, 0)).toBe(false);
	});

	it.each(["RECEIVING", "VALIDATING"])(
		"polls fast while a snapshot is %s and the tab was opened recently",
		(status) => {
			expect(instructionsPollInterval([{ status }], 0)).toBe(
				INSTRUCTIONS_FAST_POLL_MS,
			);
		},
	);

	it("backs off to the slow interval once the fast window has elapsed", () => {
		const snapshots = [{ status: "VALIDATING" }];
		expect(
			instructionsPollInterval(
				snapshots,
				INSTRUCTIONS_FAST_POLL_WINDOW_MS - 1,
			),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
		expect(
			instructionsPollInterval(
				snapshots,
				INSTRUCTIONS_FAST_POLL_WINDOW_MS,
			),
		).toBe(INSTRUCTIONS_SLOW_POLL_MS);
		// Still bounded work, not a stopped clock: a genuinely long-running
		// validation keeps being watched, just cheaply.
		expect(instructionsPollInterval(snapshots, 60 * 60 * 1000)).toBe(
			INSTRUCTIONS_SLOW_POLL_MS,
		);
	});

	it("keeps polling when an older snapshot is in flight behind a terminal newest one", () => {
		expect(
			instructionsPollInterval(
				[{ status: "READY" }, { status: "VALIDATING" }],
				0,
			),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
	});

	// Important 4 (round 4): the caller can keep the poll alive past a
	// terminal list while the published pointer catches up.
	it("keeps polling a fully terminal list while publication has not converged", () => {
		expect(
			instructionsPollInterval([{ status: "READY" }], 0, {
				awaitingPublish: true,
			}),
		).toBe(INSTRUCTIONS_FAST_POLL_MS);
		expect(
			instructionsPollInterval([{ status: "READY" }], 0, {
				awaitingPublish: false,
			}),
		).toBe(false);
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
