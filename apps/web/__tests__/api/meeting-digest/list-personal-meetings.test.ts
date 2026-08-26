import { beforeEach, describe, expect, it, vi } from "vitest";

const { isFeatureEnabled } = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
}));

// Spread-the-actual so every other @repo/database export (db, hasProjectAccess,
// etc.) stays real; only the feature-gate read is swapped for a controllable mock.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		isFeatureEnabled,
	};
});

import { buildImportedContextMetadata } from "@repo/api/modules/projects/procedures/meeting-digest/import-personal-meeting-content";
import {
	buildPersonalRows,
	type GraphCalendarMeeting,
	listPersonalMeetingsProcedure,
	normalizeGraphDateTime,
	toImportedOccurrences,
} from "@repo/api/modules/projects/procedures/meeting-digest/list-personal-meetings";

const meeting = (
	over: Partial<GraphCalendarMeeting> = {},
): GraphCalendarMeeting => ({
	id: "evt1",
	subject: "1:1 with Sam",
	start: "2026-07-14T09:00:00Z",
	organizer: "Sam Rivers",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
	isOnlineMeeting: true,
	...over,
});

/**
 * QA on #2170 found `alreadyImported` was keyed on the join URL alone, which
 * every occurrence of a recurring series shares. Importing one occurrence
 * therefore marked ALL of them — the sheet told the reader a still-private
 * meeting was "stored in Fabric… visible to everyone with access to this
 * project", and replaced its Add button with "Already in project context", so
 * the siblings could not be imported at all.
 *
 * That is the same untruth #2884 was opened to remove, pointing the other way,
 * and it contradicts the confirmation dialog's own promise that "future
 * meetings in this series stay private unless you add them too".
 *
 * The answer has to be per-OCCURRENCE, matched on the calendar instant the
 * import stored in `metadata.meetingDate`.
 */
/**
 * The reader and the writer of `metadata` are coupled by convention alone — the
 * column is JSON, so nothing in the type system ties the key names together. A
 * rename on the write side would make every occurrence read
 * `alreadyImported: false`, putting the sheet back to calling a stored,
 * project-visible transcript private, with every other test still green.
 *
 * So this feeds REAL `buildImportedContextMetadata` output through the reader
 * rather than a hand-written literal. Do not replace it with a fixture.
 */
describe("toImportedOccurrences reads what the importer writes (#2170)", () => {
	const realMetadata = buildImportedContextMetadata({
		meetingId: "meeting-1",
		transcriptId: "transcript-1",
		joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
		meetingSubject: "1:1 with Sam",
		occurrenceDate: "2026-07-14T09:00:00Z",
		speakerNames: ["Sam Rivers"],
		importedByUserId: "u1",
		importedAt: new Date("2026-07-14T10:00:00Z"),
	});

	it("recovers the join URL and occurrence date the importer stored", () => {
		expect(toImportedOccurrences([{ metadata: realMetadata }])).toEqual([
			{
				joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
				meetingDate: "2026-07-14T09:00:00Z",
			},
		]);
	});

	it("marks the occurrence when that real metadata is fed straight back in", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting({ start: "2026-07-14T09:00:00.0000000Z" })],
			linkedJoinUrls: [],
			importedOccurrences: toImportedOccurrences([
				{ metadata: realMetadata },
			]),
		});

		expect(rows[0].alreadyImported).toBe(true);
	});

	it("drops a row with no join URL rather than matching everything", () => {
		expect(
			toImportedOccurrences([{ metadata: { meetingDate: "x" } }]),
		).toEqual([]);
	});

	it("keeps a dateless row, which can then never match an occurrence", () => {
		const occurrences = toImportedOccurrences([
			{
				metadata: {
					joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
				},
			},
		]);

		expect(occurrences).toEqual([
			{
				joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
				meetingDate: null,
			},
		]);
		expect(
			buildPersonalRows({
				graphMeetings: [meeting()],
				linkedJoinUrls: [],
				importedOccurrences: occurrences,
			})[0].alreadyImported,
		).toBe(false);
	});
});

describe("buildPersonalRows — alreadyImported is per occurrence (#2170)", () => {
	const SERIES = "https://teams.microsoft.com/l/meetup-join/AAA";

	it("marks only the imported occurrence, not its siblings in the same series", () => {
		const rows = buildPersonalRows({
			graphMeetings: [
				meeting({ id: "imported", start: "2026-07-14T09:00:00Z" }),
				meeting({ id: "sibling", start: "2026-07-21T09:00:00Z" }),
			],
			linkedJoinUrls: [],
			importedOccurrences: [
				{ joinUrl: SERIES, meetingDate: "2026-07-14T09:00:00.000Z" },
			],
		});

		expect(rows.map((r) => r.alreadyImported)).toEqual([true, false]);
	});

	it("matches on the instant, not the string", () => {
		// Graph returns `…T09:00:00.0000000Z`; the import stores whatever the
		// client sent, e.g. `…T09:00:00.000Z`. Same moment, different text.
		const rows = buildPersonalRows({
			graphMeetings: [meeting({ start: "2026-07-14T09:00:00.0000000Z" })],
			linkedJoinUrls: [],
			importedOccurrences: [
				{ joinUrl: SERIES, meetingDate: "2026-07-14T09:00:00.000Z" },
			],
		});

		expect(rows[0].alreadyImported).toBe(true);
	});

	it("does not match an import of a different series at the same instant", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting({ start: "2026-07-14T09:00:00Z" })],
			linkedJoinUrls: [],
			importedOccurrences: [
				{
					joinUrl: "https://teams.microsoft.com/l/meetup-join/ZZZ",
					meetingDate: "2026-07-14T09:00:00.000Z",
				},
			],
		});

		expect(rows[0].alreadyImported).toBe(false);
	});

	// Both directions of "we cannot tell which occurrence this is" resolve to
	// false. Offering an action whose worst case is the server answering
	// `duplicate` beats claiming a private meeting is already shared.
	it("reads as not-imported when the occurrence has no start time", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting({ start: undefined })],
			linkedJoinUrls: [],
			importedOccurrences: [
				{ joinUrl: SERIES, meetingDate: "2026-07-14T09:00:00.000Z" },
			],
		});

		expect(rows[0].alreadyImported).toBe(false);
	});

	it("reads as not-imported when the stored import has no meeting date", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting({ start: "2026-07-14T09:00:00Z" })],
			linkedJoinUrls: [],
			importedOccurrences: [{ joinUrl: SERIES, meetingDate: null }],
		});

		expect(rows[0].alreadyImported).toBe(false);
	});
});

describe("buildPersonalRows — alreadyImported (#2170)", () => {
	it("marks an occurrence the project already holds an imported copy of", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting()],
			linkedJoinUrls: [],
			importedOccurrences: [
				{
					joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
					meetingDate: "2026-07-14T09:00:00Z",
				},
			],
		});

		expect(rows[0].alreadyImported).toBe(true);
	});

	it("leaves an un-imported occurrence false", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting()],
			linkedJoinUrls: [],
			importedOccurrences: [
				{
					joinUrl: "https://teams.microsoft.com/l/meetup-join/ZZZ",
					meetingDate: "2026-07-14T09:00:00Z",
				},
			],
		});

		expect(rows[0].alreadyImported).toBe(false);
	});

	it("matches the join URL the same way the linked check does", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting()],
			linkedJoinUrls: [],
			importedOccurrences: [
				{
					joinUrl:
						"  HTTPS://TEAMS.MICROSOFT.COM/L/MEETUP-JOIN/AAA  ",
					meetingDate: "2026-07-14T09:00:00Z",
				},
			],
		});

		expect(rows[0].alreadyImported).toBe(true);
	});

	// The field arrived after the rest of this shape; a caller that predates it
	// must read as "nothing imported" rather than crashing or guessing true.
	it("treats an omitted list as nothing imported", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting()],
			linkedJoinUrls: [],
		});

		expect(rows[0].alreadyImported).toBe(false);
	});
});

describe("buildPersonalRows", () => {
	it("maps a Graph calendar meeting to a personal row", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting()],
			linkedJoinUrls: [],
		});

		expect(rows).toEqual([
			{
				id: "evt1",
				subject: "1:1 with Sam",
				startTime: "2026-07-14T09:00:00Z",
				organizer: "Sam Rivers",
				joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
				linkedWithoutTranscript: false,
				alreadyImported: false,
			},
		]);
	});

	it("drops meetings with no joinUrl (not an online meeting)", () => {
		const rows = buildPersonalRows({
			graphMeetings: [
				meeting({ id: "focus", joinUrl: undefined }),
				meeting({ id: "empty", joinUrl: "" }),
				meeting({ id: "keep" }),
			],
			linkedJoinUrls: [],
		});

		expect(rows.map((r) => r.id)).toEqual(["keep"]);
	});

	// This test previously asserted that being LINKED was enough to drop a
	// meeting. That was DEF-0 itself: linked-but-unsynced meetings produce no
	// team row, so dropping them here erased them from the digest. Suppression
	// now keys on renderedJoinUrls (covered below); what this case still guards
	// is that join-URL matching ignores case and surrounding whitespace, which
	// Graph and the stored link records do not agree on.
	it("classifies linked meetings case-insensitively and ignoring whitespace", () => {
		const rows = buildPersonalRows({
			graphMeetings: [
				meeting({ id: "linked" }),
				meeting({
					id: "mine",
					joinUrl: "https://teams.microsoft.com/l/meetup-join/BBB",
				}),
			],
			linkedJoinUrls: [
				"  HTTPS://TEAMS.MICROSOFT.COM/L/MEETUP-JOIN/AAA  ",
			],
			renderedJoinUrls: [],
		});

		expect(rows.map((r) => r.id)).toEqual(["linked", "mine"]);
		expect(rows.map((r) => r.linkedWithoutTranscript)).toEqual([
			true,
			false,
		]);
	});

	// DEF-0. The dedup above exists to stop a meeting rendering twice — once as a
	// team row, once as a personal row. But buildDigestRows maps over TRANSCRIPTS,
	// so a linked meeting with no synced transcript produces no team row at all.
	// Dropping it here suppressed a duplicate that never existed, and the meeting
	// disappeared from the digest entirely. Observed live: 12 of a user's meetings
	// for one week were linked-but-unsynced and appeared in neither list.
	it("keeps a linked meeting that produced no team row, flagged as unsynced", () => {
		const rows = buildPersonalRows({
			graphMeetings: [
				meeting({ id: "synced" }),
				meeting({
					id: "unsynced",
					joinUrl: "https://teams.microsoft.com/l/meetup-join/BBB",
				}),
			],
			linkedJoinUrls: [
				"https://teams.microsoft.com/l/meetup-join/AAA",
				"https://teams.microsoft.com/l/meetup-join/BBB",
			],
			// Only AAA actually rendered as a team row this window.
			renderedJoinUrls: ["https://teams.microsoft.com/l/meetup-join/AAA"],
		});

		expect(rows.map((r) => r.id)).toEqual(["unsynced"]);
		expect(rows[0].linkedWithoutTranscript).toBe(true);
	});

	it("marks an unlinked personal meeting as not linked", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting({ id: "mine" })],
			linkedJoinUrls: [],
			renderedJoinUrls: [],
		});

		expect(rows[0].linkedWithoutTranscript).toBe(false);
	});

	it("still drops a linked meeting once its team row renders", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting({ id: "dupe" })],
			linkedJoinUrls: ["https://teams.microsoft.com/l/meetup-join/AAA"],
			renderedJoinUrls: [
				"  HTTPS://TEAMS.MICROSOFT.COM/L/MEETUP-JOIN/AAA  ",
			],
		});

		expect(rows).toEqual([]);
	});

	it("falls back for a missing subject, organizer, and start", () => {
		const rows = buildPersonalRows({
			graphMeetings: [
				meeting({
					subject: undefined,
					organizer: undefined,
					start: undefined,
				}),
			],
			linkedJoinUrls: [],
		});

		expect(rows[0]).toMatchObject({
			subject: "Untitled Meeting",
			organizer: "Unknown",
			startTime: null,
		});
	});

	it("returns an empty array when Graph returns nothing", () => {
		expect(
			buildPersonalRows({ graphMeetings: [], linkedJoinUrls: ["x"] }),
		).toEqual([]);
	});

	it("normalises an offset-less Graph start time to UTC (#1899 Fix 3)", () => {
		const rows = buildPersonalRows({
			graphMeetings: [meeting({ start: "2026-07-14T09:00:00.0000000" })],
			linkedJoinUrls: [],
		});

		expect(rows[0].startTime).toBe("2026-07-14T09:00:00.0000000Z");
	});
});

describe("normalizeGraphDateTime", () => {
	it("appends Z to an offset-less date-time string", () => {
		expect(normalizeGraphDateTime("2026-07-14T09:00:00.0000000")).toBe(
			"2026-07-14T09:00:00.0000000Z",
		);
	});

	it("leaves a string already ending in Z unchanged", () => {
		expect(normalizeGraphDateTime("2026-07-14T09:00:00Z")).toBe(
			"2026-07-14T09:00:00Z",
		);
	});

	it("leaves a string with a numeric offset unchanged", () => {
		expect(normalizeGraphDateTime("2026-07-14T09:00:00+02:00")).toBe(
			"2026-07-14T09:00:00+02:00",
		);
	});

	it("returns null for null", () => {
		expect(normalizeGraphDateTime(null)).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(normalizeGraphDateTime(undefined)).toBeNull();
	});
});

describe("listPersonalMeetingsProcedure", () => {
	beforeEach(() => {
		isFeatureEnabled.mockReset();
	});

	// Privacy contract (design doc FR4/AC5): with the flag off, this endpoint
	// must be unreachable, not merely "empty" — it reads the caller's personal
	// Microsoft calendar. The gate is the handler's first statement, so this
	// must reject before any access check or Graph call runs.
	it("rejects with NOT_FOUND when PERSONAL_MEETINGS is off", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		await expect(
			listPersonalMeetingsProcedure["~orpc"].handler({
				input: {
					projectId: "p1",
					organizationId: null,
					from: new Date("2026-07-01T00:00:00Z"),
					to: new Date("2026-07-31T00:00:00Z"),
				},
				context: {},
				errors: {},
			} as never),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(isFeatureEnabled).toHaveBeenCalledWith("PERSONAL_MEETINGS");
	});
});
