/**
 * A cancelled run must not be reported as having thrown its work away.
 *
 * Observed on staging: pressing Stop mid-run showed "This run recorded no
 * steps." and kept showing it. The run had in fact kept both cases that had
 * finished, with their observations and screenshots — a reload proved it. The
 * cause is a sequencing one: the workflow flips the run to a terminal status and
 * only THEN calls `persistAgenticRun` to write the step log, so for a few
 * seconds a CANCELLED run genuinely has no cases. The detail query stopped
 * polling the instant the status left QUEUED/RUNNING, so the panel latched the
 * empty reading and never re-checked.
 *
 * These pin the predicate that decides whether to keep looking.
 */

import { describe, expect, it } from "vitest";
import {
	advanceRunDetailPollState,
	shouldPollRunDetail,
} from "../AgenticRunsPanel";

const poll = (status: string, caseCount: number, pollsSoFar = 0): boolean =>
	shouldPollRunDetail({ status, caseCount, pollsSoFar });

describe("shouldPollRunDetail", () => {
	it.each(["QUEUED", "RUNNING"])("keeps polling while %s", (status) => {
		expect(poll(status, 0)).toBe(true);
		// Still in flight even once some cases have landed — the rest are coming.
		expect(poll(status, 3)).toBe(true);
	});

	it("keeps polling a just-cancelled run that has no steps YET", () => {
		// The bug. This returned false, which latched "recorded no steps".
		expect(poll("CANCELLED", 0)).toBe(true);
	});

	it("stops once the cancelled run's steps have arrived", () => {
		expect(poll("CANCELLED", 2)).toBe(false);
	});

	it("never polls a REFUSED run", () => {
		// Refused before dispatch: it has no steps and never will, so polling it
		// would be the tab-that-never-goes-quiet with nothing to wait for.
		expect(poll("REFUSED", 0)).toBe(false);
	});

	it("gives up after a bounded number of attempts", () => {
		// A run that genuinely recorded nothing must not be polled forever.
		expect(poll("FAILED", 0, 7)).toBe(true);
		expect(poll("FAILED", 0, 8)).toBe(false);
	});

	it.each(["PASSED", "FAILED"])(
		"applies the same settling window to a %s run",
		(status) => {
			// Cancel is where it was seen, but the write-after-status ordering is
			// the same for every terminal state.
			expect(poll(status, 0)).toBe(true);
			expect(poll(status, 1)).toBe(false);
		},
	);

	it("does not spend the settle budget while the run is still active", () => {
		let state = { runId: null as string | null, terminalEmptyPolls: 0 };
		for (let update = 0; update < 30; update += 1) {
			state = advanceRunDetailPollState(state, {
				runId: "run-1",
				status: "RUNNING",
				caseCount: 0,
			}).state;
		}

		const terminal = advanceRunDetailPollState(state, {
			runId: "run-1",
			status: "PASSED",
			caseCount: 0,
		});

		expect(terminal.pollsSoFar).toBe(0);
		expect(
			shouldPollRunDetail({
				status: "PASSED",
				caseCount: 0,
				pollsSoFar: terminal.pollsSoFar,
			}),
		).toBe(true);
	});
});
