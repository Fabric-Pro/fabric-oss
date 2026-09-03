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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractChannelThreadId,
	type GraphFetch,
	getRecordingTranscriptContent,
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

/**
 * The connected account's own tenant, as `GET /sites/root` reports it. Every
 * host check in this module is measured against this and nothing else — a
 * `.sharepoint.com` suffix is not a tenant.
 */
const TENANT_ROOT = "https://example.sharepoint.com";

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
				TENANT_ROOT,
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
				TENANT_ROOT,
			)?.sitePath,
		).toBe("/teams/Delivery");
	});

	it("accepts the tenant's OneDrive host, where a private meeting's recording lands", () => {
		expect(
			parseSharePointSite(
				"https://example-my.sharepoint.com/personal/dev_example_com/Documents/Recordings/x.mp4",
				TENANT_ROOT,
			)?.origin,
		).toBe("https://example-my.sharepoint.com");
	});

	it("returns null for something that is not a URL", () => {
		expect(parseSharePointSite("not a url", TENANT_ROOT)).toBeNull();
	});

	it("rejects a host outside sharepoint.com, which would be handed the token", () => {
		expect(
			parseSharePointSite(
				"https://example.com/sites/EngTeam/Shared%20Documents/x.mp4",
				TENANT_ROOT,
			),
		).toBeNull();
		expect(
			parseSharePointSite(
				"https://evil-sharepoint.com/sites/EngTeam/x.mp4",
				TENANT_ROOT,
			),
		).toBeNull();
	});

	it("rejects another tenant's SharePoint host — every tenant is *.sharepoint.com", () => {
		expect(
			parseSharePointSite(
				"https://attacker.sharepoint.com/sites/EngTeam/x.mp4",
				TENANT_ROOT,
			),
		).toBeNull();
		// A prefix of the real tenant is still not the real tenant.
		expect(
			parseSharePointSite(
				"https://example.attacker.sharepoint.com/sites/EngTeam/x.mp4",
				TENANT_ROOT,
			),
		).toBeNull();
		expect(
			parseSharePointSite(
				"https://example-attacker.sharepoint.com/sites/EngTeam/x.mp4",
				TENANT_ROOT,
			),
		).toBeNull();
	});

	it("rejects a non-https SharePoint URL", () => {
		expect(
			parseSharePointSite(
				"http://example.sharepoint.com/sites/EngTeam/x.mp4",
				TENANT_ROOT,
			),
		).toBeNull();
	});

	it("refuses to pin against a root site it cannot read as one tenant", () => {
		expect(
			parseSharePointSite(
				"https://example.sharepoint.com/sites/EngTeam/x.mp4",
				"not a url",
			),
		).toBeNull();
		expect(
			parseSharePointSite(
				"https://example.sharepoint.com/sites/EngTeam/x.mp4",
				"https://example.com",
			),
		).toBeNull();
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

/**
 * The host pin, from the outside.
 *
 * Two bearer tokens leave this function — one minted for the recording's origin
 * and one sent to the download URL — so every rejection here is asserted twice:
 * that it threw, and that nothing was minted for or sent to the rejected host.
 * A check that fires after the request is not a fix.
 */
describe("getRecordingTranscriptContent", () => {
	const TEAM_SITE_RECORDING =
		"https://example.sharepoint.com/sites/EngTeam/Shared%20Documents/General/Recordings/rec.mp4";

	function graphWithRoot(webUrl: string | null = TENANT_ROOT): GraphFetch {
		return vi.fn(async (url: string) => {
			if (url.endsWith("/sites/root")) {
				return webUrl === null
					? jsonResponse({ error: { message: "denied" } }, 403)
					: jsonResponse({ webUrl });
			}
			return jsonResponse({}, 404);
		});
	}

	/** Stands in for the Entra token exchange, the media listing and the download. */
	function scriptFetch(
		downloadUrl = "https://example.sharepoint.com/_layouts/download.aspx?t=abc",
	) {
		return vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = String(input);
				if (url.startsWith("https://login.microsoftonline.com")) {
					return jsonResponse({
						access_token: "sharepoint-token",
						expires_in: 3600,
					});
				}
				if (url.includes("/_api/v2.1/drives/")) {
					return jsonResponse({
						value: [
							{
								id: "transcript-1",
								size: 4096,
								temporaryDownloadUrl: downloadUrl,
							},
						],
					});
				}
				if (url.includes("format=json")) {
					return jsonResponse({
						entries: [
							{ text: "Morning.", speakerDisplayName: "Ada" },
							{ text: "Morning.", speakerDisplayName: "Grace" },
						],
					});
				}
				return jsonResponse({}, 404);
			});
	}

	function requestedUrls(spy: ReturnType<typeof scriptFetch>): string[] {
		return spy.mock.calls.map((call) => String(call[0]));
	}

	const baseParams = {
		graphBaseUrl: GRAPH_BASE,
		driveId: "drive-1",
		recordingItemId: "rec-20",
		refreshToken: "refresh-1",
		onRefreshTokenRotated: async () => {},
	};

	beforeEach(() => {
		vi.stubEnv("MICROSOFT_GRAPH_CLIENT_ID", "client-id");
		vi.stubEnv("MICROSOFT_GRAPH_CLIENT_SECRET", "client-secret");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("reads a recording on the caller's own tenant", async () => {
		const fetchSpy = scriptFetch();

		const result = await getRecordingTranscriptContent({
			...baseParams,
			graphFetch: graphWithRoot(),
			integrationId: "int-happy",
			recordingWebUrl: TEAM_SITE_RECORDING,
		});

		expect(result.entries).toHaveLength(2);
		expect(result.speakerCount).toBe(2);
		expect(
			requestedUrls(fetchSpy).some((url) =>
				url.startsWith(
					"https://example.sharepoint.com/sites/EngTeam/_api/v2.1/drives/drive-1/items/rec-20/media/transcripts",
				),
			),
		).toBe(true);
	});

	it("reads a recording on the tenant's own OneDrive host", async () => {
		const fetchSpy = scriptFetch(
			"https://example-my.sharepoint.com/_layouts/download.aspx?t=abc",
		);

		const result = await getRecordingTranscriptContent({
			...baseParams,
			graphFetch: graphWithRoot(),
			integrationId: "int-onedrive",
			recordingWebUrl:
				"https://example-my.sharepoint.com/personal/dev_example_com/Documents/Recordings/rec.mp4",
		});

		expect(result.entries).toHaveLength(2);
		expect(
			requestedUrls(fetchSpy).some((url) =>
				url.startsWith("https://example-my.sharepoint.com/_api/v2.1/"),
			),
		).toBe(true);
	});

	it("refuses another tenant's SharePoint host, and mints no token for it", async () => {
		const fetchSpy = scriptFetch();

		await expect(
			getRecordingTranscriptContent({
				...baseParams,
				graphFetch: graphWithRoot(),
				integrationId: "int-attacker",
				recordingWebUrl:
					"https://attacker.sharepoint.com/sites/EngTeam/Shared%20Documents/rec.mp4",
			}),
		).rejects.toThrow(/could not derive the sharepoint site/i);

		// `${origin}/.default` would have made the attacker's host the audience
		// of the caller's delegated token, and the very next call would have
		// sent it there.
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refuses a non-https recording URL", async () => {
		const fetchSpy = scriptFetch();

		await expect(
			getRecordingTranscriptContent({
				...baseParams,
				graphFetch: graphWithRoot(),
				integrationId: "int-plaintext",
				recordingWebUrl:
					"http://example.sharepoint.com/sites/EngTeam/rec.mp4",
			}),
		).rejects.toThrow(/could not derive the sharepoint site/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refuses a download URL on a different tenant, before sending the token", async () => {
		const fetchSpy = scriptFetch(
			"https://attacker.sharepoint.com/_layouts/download.aspx?t=abc",
		);

		await expect(
			getRecordingTranscriptContent({
				...baseParams,
				graphFetch: graphWithRoot(),
				integrationId: "int-baddownload",
				recordingWebUrl: TEAM_SITE_RECORDING,
			}),
		).rejects.toThrow(/other than the recording's own SharePoint site/i);

		expect(
			requestedUrls(fetchSpy).some((url) => url.includes("attacker")),
		).toBe(false);
	});

	it("refuses a download URL that leaves the validated origin for a sibling host", async () => {
		// Same tenant, still not this site: the transcript of an item on this
		// site is served by this site.
		const fetchSpy = scriptFetch(
			"https://example-my.sharepoint.com/_layouts/download.aspx?t=abc",
		);

		await expect(
			getRecordingTranscriptContent({
				...baseParams,
				graphFetch: graphWithRoot(),
				integrationId: "int-siblinghost",
				recordingWebUrl: TEAM_SITE_RECORDING,
			}),
		).rejects.toThrow(/other than the recording's own SharePoint site/i);

		expect(
			requestedUrls(fetchSpy).some((url) =>
				url.includes("example-my.sharepoint.com"),
			),
		).toBe(false);
	});

	it("fails closed when the tenant's root site cannot be resolved", async () => {
		const fetchSpy = scriptFetch();

		await expect(
			getRecordingTranscriptContent({
				...baseParams,
				graphFetch: graphWithRoot(null),
				integrationId: "int-noroot",
				recordingWebUrl: TEAM_SITE_RECORDING,
			}),
		).rejects.toThrow(/could not derive the sharepoint site/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
