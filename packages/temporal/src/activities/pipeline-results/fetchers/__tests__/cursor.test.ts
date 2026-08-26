import { describe, expect, it } from "vitest";
import { advanceCursor } from "../cursor";

describe("advanceCursor", () => {
	it("advances to the highest ingested run when nothing is in flight", () => {
		expect(
			advanceCursor({
				since: 10,
				ingestedIds: [11, 12, 13],
				inFlightIds: [],
			}),
		).toBe(13);
	});

	it("stays put when nothing new was ingested", () => {
		expect(
			advanceCursor({ since: 10, ingestedIds: [], inFlightIds: [] }),
		).toBe(10);
	});

	it("holds below an OLDER run that is still running", () => {
		// The regression: run 100 is still going, run 101 finished first.
		// Advancing to 101 would skip 100 forever once it completes.
		expect(
			advanceCursor({
				since: 99,
				ingestedIds: [101],
				inFlightIds: [100],
			}),
		).toBe(99);
	});

	it("advances past finished runs that precede the oldest in-flight one", () => {
		expect(
			advanceCursor({
				since: 10,
				ingestedIds: [11, 12, 15],
				inFlightIds: [13],
			}),
		).toBe(12);
	});

	it("ignores in-flight runs at or below the cursor", () => {
		// A run below `since` was already accounted for; it must not pin us back.
		expect(
			advanceCursor({
				since: 20,
				ingestedIds: [21, 22],
				inFlightIds: [5],
			}),
		).toBe(22);
	});

	it("never moves backwards", () => {
		expect(
			advanceCursor({ since: 50, ingestedIds: [], inFlightIds: [51] }),
		).toBe(50);
	});

	it("takes the OLDEST in-flight run as the barrier, not the newest", () => {
		expect(
			advanceCursor({
				since: 0,
				ingestedIds: [7, 8, 9],
				inFlightIds: [9_000, 5],
			}),
		).toBe(4);
	});
});
