import { describe, expect, it } from "vitest";
import type { UpcomingMeeting } from "../../hooks/use-upcoming-meetings";
import { groupUpcomingByDay, mergeUpcomingChunks } from "../group-upcoming";

// Local noon, so the assertions do not depend on the runner's timezone offset
// the way a midnight-adjacent instant would.
const NOW = new Date(2026, 6, 25, 12, 0, 0);

function meeting(overrides: Partial<UpcomingMeeting> = {}): UpcomingMeeting {
	return {
		joinUrl: "https://teams/x",
		subject: "Fabric DSU",
		startTime: new Date(2026, 6, 25, 9, 0, 0).toISOString(),
		organizer: "Example Organizer",
		linkedMeetingId: "lm_1",
		agendaStatus: null,
		...overrides,
	};
}

describe("groupUpcomingByDay", () => {
	it("labels the current day Today and the next day Tomorrow", () => {
		const groups = groupUpcomingByDay(
			[
				meeting({
					startTime: new Date(2026, 6, 25, 9, 0).toISOString(),
				}),
				meeting({
					joinUrl: "https://teams/y",
					startTime: new Date(2026, 6, 26, 9, 0).toISOString(),
				}),
			],
			NOW,
		);

		expect(groups.map((g) => g.label)).toEqual(["Today", "Tomorrow"]);
	});

	it("labels a later day with its weekday and date", () => {
		const groups = groupUpcomingByDay(
			[meeting({ startTime: new Date(2026, 6, 29, 9, 0).toISOString() })],
			NOW,
		);

		expect(groups[0].label).toBe("Wednesday, 29 Jul");
	});

	it("omits days with no meetings entirely (D3)", () => {
		// 25th and 29th only — the 26th, 27th and 28th must not appear as
		// empty headers pushing real content off screen.
		const groups = groupUpcomingByDay(
			[
				meeting({
					startTime: new Date(2026, 6, 25, 9, 0).toISOString(),
				}),
				meeting({
					joinUrl: "https://teams/y",
					startTime: new Date(2026, 6, 29, 9, 0).toISOString(),
				}),
			],
			NOW,
		);

		expect(groups).toHaveLength(2);
	});

	it("orders days ascending and meetings within a day ascending", () => {
		const groups = groupUpcomingByDay(
			[
				meeting({
					subject: "Later day",
					joinUrl: "https://teams/z",
					startTime: new Date(2026, 6, 26, 9, 0).toISOString(),
				}),
				meeting({
					subject: "Second",
					startTime: new Date(2026, 6, 25, 15, 0).toISOString(),
				}),
				meeting({
					subject: "First",
					joinUrl: "https://teams/y",
					startTime: new Date(2026, 6, 25, 9, 0).toISOString(),
				}),
			],
			NOW,
		);

		expect(groups.map((g) => g.label)).toEqual(["Today", "Tomorrow"]);
		expect(groups[0].meetings.map((m) => m.subject)).toEqual([
			"First",
			"Second",
		]);
	});

	it("drops a meeting whose start time is unparseable rather than mis-bucketing it", () => {
		const groups = groupUpcomingByDay(
			[meeting({ startTime: "not-a-date" })],
			NOW,
		);

		expect(groups).toEqual([]);
	});
});

describe("mergeUpcomingChunks", () => {
	it("concatenates both chunks sorted by start time", () => {
		const near = [
			meeting({
				subject: "Today",
				startTime: "2026-07-25T09:00:00.000Z",
			}),
		];
		const later = [
			meeting({
				subject: "Next week",
				joinUrl: "https://teams/y",
				startTime: "2026-08-01T09:00:00.000Z",
			}),
		];

		expect(mergeUpcomingChunks(near, later).map((m) => m.subject)).toEqual([
			"Today",
			"Next week",
		]);
	});

	it("dedupes a meeting returned by both chunks", () => {
		// Graph's window bounds are inclusive at the start, so a meeting sitting
		// exactly on the chunk boundary comes back in both responses.
		const boundary = meeting({ startTime: "2026-07-27T12:00:00.000Z" });

		expect(mergeUpcomingChunks([boundary], [boundary])).toHaveLength(1);
	});

	it("keeps two meetings that share a joinUrl but not a start time", () => {
		// A recurring series: same join URL, different occurrences.
		const first = meeting({ startTime: "2026-07-25T09:00:00.000Z" });
		const second = meeting({ startTime: "2026-07-26T09:00:00.000Z" });

		expect(mergeUpcomingChunks([first], [second])).toHaveLength(2);
	});
});
