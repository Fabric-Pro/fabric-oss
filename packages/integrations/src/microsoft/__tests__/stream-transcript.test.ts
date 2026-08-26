/**
 * Unit tests for the channel-meeting recording fallback.
 *
 * The pure helpers carry the parts most likely to be wrong in a way no type
 * checks: which recording belongs to which occurrence, and how a per-tenant
 * SharePoint URL is taken apart. `listRecordingTranscripts` is exercised against
 * a scripted Graph, so the four-hop resolution walk is covered without a token.
 *
 * The module memoizes resolution per `userId:threadId`, so each test that walks
 * it uses its own userId — otherwise one test's result would answer the next.
 */

import { describe, expect, it, vi } from "vitest";
import {
	extractChannelThreadId,
	type GraphFetch,
	listRecordingTranscripts,
	parseRecordingTimestamp,
	parseSharePointSite,
	selectRecordingForOccurrence,
} from "../stream-transcript";

const THREAD_ID = "19:aBcDeFgHiJkLmNoPqRsTuVwXyZ012345@thread.tacv2";
const CHANNEL_JOIN_URL = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(THREAD_ID)}/1700000000000?context=%7b%22Tid%22%3a%22t%22%7d`;
const ORDINARY_JOIN_URL =
	"https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmFrZQ%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("extractChannelThreadId", () => {
	it("pulls the thread id out of a channel meeting join URL", () => {
		expect(extractChannelThreadId(CHANNEL_JOIN_URL)).toBe(THREAD_ID);
	});

	it("returns null for an ordinary meeting, which Graph serves normally", () => {
		expect(extractChannelThreadId(ORDINARY_JOIN_URL)).toBeNull();
	});

	it("returns null for a URL that is not a meeting join link at all", () => {
		expect(
			extractChannelThreadId("https://example.com/whatever"),
		).toBeNull();
	});
});

describe("parseRecordingTimestamp", () => {
	it("reads the UTC stamp Teams embeds in a recording filename", () => {
		expect(
			parseRecordingTimestamp(
				"Team Sync-20260820_160500UTC-Meeting Recording.mp4",
			),
		).toBe(Date.parse("2026-08-20T16:05:00Z"));
	});

	it("returns null when the filename carries no stamp", () => {
		expect(parseRecordingTimestamp("Some other upload.mp4")).toBeNull();
	});
});

describe("selectRecordingForOccurrence", () => {
	const recordings = [
		{
			id: "rec-19",
			name: "Team Sync-20260819_160500UTC-Meeting Recording.mp4",
			webUrl: "https://example.sharepoint.com/sites/S/rec19.mp4",
		},
		{
			id: "rec-20",
			name: "Team Sync-20260820_160500UTC-Meeting Recording.mp4",
			webUrl: "https://example.sharepoint.com/sites/S/rec20.mp4",
		},
	];

	it("picks the recording belonging to this occurrence, not yesterday's", () => {
		const picked = selectRecordingForOccurrence({
			recordings,
			meetingSubject: "Team Sync",
			occurrenceMs: Date.parse("2026-08-20T16:00:00Z"),
		});
		expect(picked?.id).toBe("rec-20");
	});

	it("prefers the subject match over a closer recording of another meeting", () => {
		const picked = selectRecordingForOccurrence({
			recordings: [
				{
					id: "other",
					name: "Design Review-20260820_160000UTC-Meeting Recording.mp4",
					webUrl: "https://example.sharepoint.com/sites/S/o.mp4",
				},
				{
					id: "ours",
					name: "Team Sync-20260820_163000UTC-Meeting Recording.mp4",
					webUrl: "https://example.sharepoint.com/sites/S/u.mp4",
				},
			],
			meetingSubject: "Team Sync",
			occurrenceMs: Date.parse("2026-08-20T16:00:00Z"),
		});
		expect(picked?.id).toBe("ours");
	});

	it("returns null when nothing falls inside the tolerance window", () => {
		const picked = selectRecordingForOccurrence({
			recordings,
			meetingSubject: "Team Sync",
			occurrenceMs: Date.parse("2026-09-15T16:00:00Z"),
		});
		expect(picked).toBeNull();
	});

	it("still matches on time alone when the meeting was renamed", () => {
		const picked = selectRecordingForOccurrence({
			recordings,
			meetingSubject: "Renamed Standup",
			occurrenceMs: Date.parse("2026-08-20T16:00:00Z"),
		});
		expect(picked?.id).toBe("rec-20");
	});
});

describe("parseSharePointSite", () => {
	it("derives the per-tenant origin and site path from a driveItem URL", () => {
		expect(
			parseSharePointSite(
				"https://example.sharepoint.com/sites/EngTeam/Shared%20Documents/General/Recordings/x.mp4",
			),
		).toEqual({
			origin: "https://example.sharepoint.com",
			sitePath: "/sites/EngTeam",
		});
	});

	it("handles the /teams/ site collection form", () => {
		expect(
			parseSharePointSite(
				"https://example.sharepoint.com/teams/Delivery/Shared%20Documents/x.mp4",
			)?.sitePath,
		).toBe("/teams/Delivery");
	});

	it("returns null for something that is not a URL", () => {
		expect(parseSharePointSite("not a url")).toBeNull();
	});
});

describe("listRecordingTranscripts", () => {
	function scriptGraph(overrides: Record<string, Response> = {}): GraphFetch {
		return vi.fn(async (url: string) => {
			for (const [fragment, response] of Object.entries(overrides)) {
				if (url.includes(fragment)) {
					return response;
				}
			}
			// Graph rejects an unsupported query option with a non-2xx, which this
			// resolution walk reads as "not this team" — so a bad request shape
			// would make the fallback silently never fire. These guards assert
			// the exact options the production call shapes use, so adding one
			// fails the test rather than the tenant.
			if (url.includes("/me/joinedTeams")) {
				if (url.includes("$top")) {
					return jsonResponse(
						{ error: { message: "$top is not supported" } },
						400,
					);
				}
				return jsonResponse({ value: [{ id: "team-1" }] });
			}
			if (url.includes("/filesFolder")) {
				return jsonResponse({
					id: "folder-1",
					parentReference: { driveId: "drive-1" },
				});
			}
			if (url.includes("/channels?")) {
				return jsonResponse({ value: [{ id: THREAD_ID }] });
			}
			if (url.includes("/items/folder-1/children")) {
				return jsonResponse({
					value: [
						{ id: "recordings-1", name: "Recordings", folder: {} },
					],
				});
			}
			if (url.includes("/items/recordings-1/children")) {
				return jsonResponse({
					value: [
						{
							id: "rec-20",
							name: "Team Sync-20260820_160500UTC-Meeting Recording.mp4",
							webUrl: "https://example.sharepoint.com/sites/S/rec20.mp4",
							lastModifiedDateTime: "2026-08-20T17:10:00Z",
						},
					],
				});
			}
			return jsonResponse({}, 404);
		});
	}

	const baseParams = {
		graphBaseUrl: GRAPH_BASE,
		joinUrl: CHANNEL_JOIN_URL,
		meetingSubject: "Team Sync",
		meetingDate: "2026-08-20T16:00:00Z",
	};

	it("walks team → channel → drive → recording and keys the transcript on the recording", async () => {
		const result = await listRecordingTranscripts({
			...baseParams,
			graphFetch: scriptGraph(),
			userId: "user-walk",
		});

		expect(result.transcripts).toHaveLength(1);
		expect(result.transcripts[0]).toMatchObject({
			id: "stream:rec-20",
			driveId: "drive-1",
			recordingItemId: "rec-20",
		});
	});

	it("explains itself when the account cannot see the team behind the channel", async () => {
		const result = await listRecordingTranscripts({
			...baseParams,
			graphFetch: scriptGraph({
				"/channels?": jsonResponse({ value: [{ id: "19:other" }] }),
			}),
			userId: "user-nochannel",
		});

		expect(result.transcripts).toHaveLength(0);
		expect(result.diagnostic).toMatch(/could not resolve/i);
	});

	it("addresses the channel folder without percent-encoding the thread id", async () => {
		const graphFetch = scriptGraph();
		await listRecordingTranscripts({
			...baseParams,
			graphFetch,
			userId: "user-rawid",
		});

		const folderCall = (graphFetch as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => call[0] as string)
			.find((url) => url.includes("/filesFolder"));

		// `get_shared_files` interpolates the channel id raw, and that is the
		// call shape proven in production.
		expect(folderCall).toContain(`/channels/${THREAD_ID}/filesFolder`);
		expect(folderCall).not.toContain("%40thread");
	});

	it("blames the missing Recordings folder, not the account's team membership", async () => {
		const result = await listRecordingTranscripts({
			...baseParams,
			graphFetch: scriptGraph({
				"/items/folder-1/children": jsonResponse({
					value: [{ id: "other-1", name: "Documents", folder: {} }],
				}),
			}),
			userId: "user-norecordingsfolder",
		});

		expect(result.transcripts).toHaveLength(0);
		expect(result.diagnostic).toMatch(/recordings folder/i);
		// The channel resolved fine — saying otherwise sends someone chasing
		// permissions that are working.
		expect(result.diagnostic).not.toMatch(/member of the team/i);
	});

	it("reports an unrecorded occurrence rather than pretending nothing exists", async () => {
		const result = await listRecordingTranscripts({
			...baseParams,
			meetingDate: "2026-07-01T16:00:00Z",
			graphFetch: scriptGraph(),
			userId: "user-norecording",
		});

		expect(result.transcripts).toHaveLength(0);
		expect(result.diagnostic).toMatch(/not recorded/i);
	});

	it("declines an ordinary meeting without touching Graph", async () => {
		const graphFetch = scriptGraph();
		const result = await listRecordingTranscripts({
			...baseParams,
			joinUrl: ORDINARY_JOIN_URL,
			graphFetch,
			userId: "user-ordinary",
		});

		expect(result.transcripts).toHaveLength(0);
		expect(graphFetch).not.toHaveBeenCalled();
	});

	it("resolves once and serves later occurrences of the same meeting from memory", async () => {
		const graphFetch = scriptGraph();
		const first = await listRecordingTranscripts({
			...baseParams,
			graphFetch,
			userId: "user-cached",
		});
		const callsAfterFirst = (graphFetch as ReturnType<typeof vi.fn>).mock
			.calls.length;

		await listRecordingTranscripts({
			...baseParams,
			graphFetch,
			userId: "user-cached",
		});
		const callsAfterSecond = (graphFetch as ReturnType<typeof vi.fn>).mock
			.calls.length;

		expect(first.transcripts).toHaveLength(1);
		// Only the recordings listing repeats; the three resolution hops do not.
		expect(callsAfterSecond - callsAfterFirst).toBe(1);
	});
});
