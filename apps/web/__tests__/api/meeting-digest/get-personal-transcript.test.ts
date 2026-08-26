import { beforeEach, describe, expect, it, vi } from "vitest";

const { isFeatureEnabled, hasProjectAccess, executeMicrosoftTeamsTool } =
	vi.hoisted(() => ({
		isFeatureEnabled: vi.fn(),
		hasProjectAccess: vi.fn(),
		executeMicrosoftTeamsTool: vi.fn(),
	}));

// Spread-the-actual so every other @repo/database export stays real; only the
// feature-gate and project-access reads are swapped for controllable mocks.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		isFeatureEnabled,
		hasProjectAccess,
	};
});

// The barrel is mocked for `executeMicrosoftTeamsTool`, but the code under test
// also classifies errors with `isMicrosoftNotConnectedError`. Pull the real one
// in from its dependency-free module rather than stubbing it, so the mock can't
// drift from production behaviour.
vi.mock("@repo/integrations/microsoft", async () => {
	const { isMicrosoftNotConnectedError } = await vi.importActual<
		typeof import("@repo/integrations/microsoft/connection-errors")
	>("@repo/integrations/microsoft/connection-errors");

	return { executeMicrosoftTeamsTool, isMicrosoftNotConnectedError };
});

import {
	formatTranscript,
	getPersonalTranscriptProcedure,
	selectTranscriptId,
} from "@repo/api/modules/projects/procedures/meeting-digest/get-personal-transcript";

describe("selectTranscriptId", () => {
	it("returns null when there are no transcripts", () => {
		expect(selectTranscriptId([], "2026-07-14T09:00:00Z")).toBeNull();
	});

	it("returns the only transcript when no start time narrows it", () => {
		expect(
			selectTranscriptId([
				{ id: "t1", createdDateTime: "2020-01-01T00:00:00Z" },
			]),
		).toBe("t1");
	});

	/**
	 * A recurring series shares one onlineMeeting id, so `list_meeting_transcripts`
	 * answers for the WHOLE series. Nearest-wins with no bound therefore hands back
	 * some other occurrence's conversation whenever the clicked one was never
	 * recorded — and the import stores it under the clicked occurrence's date, so
	 * the project ends up holding one meeting's words labelled as another's.
	 *
	 * Observed on staging: five occurrences of one series spanning December to
	 * February all resolved to the same transcript id.
	 */
	it("refuses a transcript that belongs to a different occurrence", () => {
		expect(
			selectTranscriptId(
				[{ id: "february", createdDateTime: "2026-02-16T11:40:00Z" }],
				"2025-12-22T11:30:00Z",
			),
		).toBeNull();
	});

	it("refuses the nearest transcript when even the nearest misses the occurrence", () => {
		expect(
			selectTranscriptId(
				[
					{
						id: "week-before",
						createdDateTime: "2026-07-07T09:40:00Z",
					},
					{
						id: "week-after",
						createdDateTime: "2026-07-21T09:40:00Z",
					},
				],
				"2026-07-14T09:00:00Z",
			),
		).toBeNull();
	});

	it("accepts a transcript produced later the same day as the occurrence", () => {
		expect(
			selectTranscriptId(
				[{ id: "same-day", createdDateTime: "2026-07-14T11:05:00Z" }],
				"2026-07-14T09:00:00Z",
			),
		).toBe("same-day");
	});

	// A meeting running past midnight UTC produces its transcript on the next
	// calendar day. Within 24h and after the start, so still this occurrence's.
	it("accepts a transcript produced within a day of a meeting that crossed midnight", () => {
		expect(
			selectTranscriptId(
				[
					{
						id: "past-midnight",
						createdDateTime: "2026-07-15T00:30:00Z",
					},
				],
				"2026-07-14T23:30:00Z",
			),
		).toBe("past-midnight");
	});

	// Nothing to compare against, so nothing to disprove. Undated transcripts
	// already rank last, so this only decides the case where it is all there is.
	it("accepts an undated transcript rather than discarding it", () => {
		expect(
			selectTranscriptId([{ id: "undated" }], "2026-07-14T09:00:00Z"),
		).toBe("undated");
	});

	it("picks the transcript created nearest the meeting start", () => {
		const picked = selectTranscriptId(
			[
				{ id: "far", createdDateTime: "2026-07-14T18:00:00Z" },
				{ id: "near", createdDateTime: "2026-07-14T09:40:00Z" },
				{ id: "earlier", createdDateTime: "2026-07-13T09:00:00Z" },
			],
			"2026-07-14T09:00:00Z",
		);

		expect(picked).toBe("near");
	});

	it("falls back to the first transcript when startTime is absent", () => {
		expect(
			selectTranscriptId([
				{ id: "first", createdDateTime: "2026-07-14T18:00:00Z" },
				{ id: "second", createdDateTime: "2026-07-14T09:00:00Z" },
			]),
		).toBe("first");
	});

	it("falls back to the first transcript when startTime is unparseable", () => {
		// One dated, one undated: with the Number.isNaN(target) guard removed,
		// Math.abs(dated - NaN) is NaN and the comparator goes unstable, so this
		// fixture genuinely pins the guard. Two undated transcripts would NOT —
		// they both score Infinity and the stable sort returns "a" either way.
		expect(
			selectTranscriptId(
				[
					{ id: "a", createdDateTime: "2026-07-14T09:05:00Z" },
					{ id: "b" },
				],
				"not-a-date",
			),
		).toBe("a");
	});

	it("ranks transcripts missing createdDateTime last rather than randomly", () => {
		const picked = selectTranscriptId(
			[
				{ id: "undated" },
				{ id: "dated", createdDateTime: "2026-07-14T09:05:00Z" },
			],
			"2026-07-14T09:00:00Z",
		);

		expect(picked).toBe("dated");
	});
});

describe("formatTranscript", () => {
	it("renders speaker entries as 'Speaker: text' lines", () => {
		expect(
			formatTranscript({
				entries: [
					{ speaker: "Ann", text: "Morning." },
					{ speaker: "Bob", text: "Morning!" },
				],
			}),
		).toBe("Ann: Morning.\nBob: Morning!");
	});

	it("falls back to raw content when there are no entries", () => {
		expect(formatTranscript({ content: "WEBVTT\n\nraw" })).toBe(
			"WEBVTT\n\nraw",
		);
	});

	it("returns an empty string when the payload is empty", () => {
		expect(formatTranscript({})).toBe("");
		expect(formatTranscript({ entries: [] })).toBe("");
	});
});

describe("getPersonalTranscriptProcedure", () => {
	beforeEach(() => {
		isFeatureEnabled.mockReset();
	});

	// Privacy contract (design doc FR4/AC5): with the flag off, this endpoint
	// must be unreachable, not merely "empty" — it reads the caller's personal
	// Microsoft transcript. The gate is the handler's first statement, so this
	// must reject before any access check or Graph call runs.
	it("rejects with NOT_FOUND when PERSONAL_MEETINGS is off", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		await expect(
			getPersonalTranscriptProcedure["~orpc"].handler({
				input: {
					projectId: "p1",
					organizationId: null,
					joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
					startTime: "2026-07-14T09:00:00Z",
				},
				context: {},
				errors: {},
			} as never),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(isFeatureEnabled).toHaveBeenCalledWith("PERSONAL_MEETINGS");
	});

	// DEF-6. Graph refuses the /me/onlineMeetings lookup for meetings the caller
	// cannot resolve — routinely, ones a colleague organised. Since #2226 made
	// linked-but-unsynced meetings visible, those rows are now clickable, so this
	// path went from unreachable to ordinary. It must read as a state, not a
	// crash: throwing produced a 500 and a bare "Failed to load transcript".
	it("reports no-access instead of throwing when Graph forbids the lookup", async () => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		executeMicrosoftTeamsTool.mockRejectedValue(
			new Error(
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"3003: User does not have access to lookup meeting"}}',
			),
		);

		const result = await getPersonalTranscriptProcedure["~orpc"].handler({
			input: {
				projectId: "p1",
				organizationId: null,
				joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
				startTime: "2026-07-14T09:00:00Z",
			},
			context: { user: { id: "u1" }, session: {} },
			errors: {},
		} as never);

		expect(result).toEqual({ content: null, reason: "no-access" });
	});

	/**
	 * QA on #2170. Graph answers 404/3004 for a join URL it cannot resolve at
	 * all — a different population from the 403/3003 above, and by far the
	 * larger one on a real calendar. It rethrew, so the sheet showed a 500 and
	 * the import offered "Try again" for a state retrying cannot change.
	 */
	it("reports meeting-not-found instead of throwing when Graph cannot resolve the join URL", async () => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		executeMicrosoftTeamsTool.mockRejectedValue(
			new Error(
				'Microsoft Graph API error: 404 Not Found - {"error":{"code":"NotFound","message":"3004: Specified meeting is not found"}}',
			),
		);

		const result = await getPersonalTranscriptProcedure["~orpc"].handler({
			input: {
				projectId: "p1",
				organizationId: null,
				joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
				startTime: "2026-07-14T09:00:00Z",
			},
			context: { user: { id: "u1" }, session: {} },
			errors: {},
		} as never);

		expect(result).toEqual({ content: null, reason: "meeting-not-found" });
	});

	/**
	 * Both transcript-permission payloads carry a helpUrl, so both used to land
	 * on "admin-consent-required" and told the user to chase an app-registration
	 * grant. When the block is the Teams tenant setting (#2553) that advice sends
	 * them to the wrong admin surface entirely, so the two must stay distinct.
	 */
	const runTranscriptChain = (
		listResult: Record<string, unknown>,
		contentResult: Record<string, unknown> = { entries: [] },
	) => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		executeMicrosoftTeamsTool.mockImplementation(
			async (methodName: string) => {
				if (methodName === "get_meeting_by_join_url") {
					return { meeting: { id: "meeting-1" } };
				}
				if (methodName === "list_meeting_transcripts") {
					return listResult;
				}
				return contentResult;
			},
		);

		return getPersonalTranscriptProcedure["~orpc"].handler({
			input: {
				projectId: "p1",
				organizationId: null,
				joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
				startTime: "2026-07-14T09:00:00Z",
			},
			context: { user: { id: "u1" }, session: {} },
			errors: {},
		} as never);
	};

	it("reports transcript-access-disabled when the tenant has Graph transcript access switched off", async () => {
		const result = await runTranscriptChain({
			error: "Microsoft Graph access to meeting transcripts is disabled for this tenant",
			message:
				"A Teams administrator must enable 'Transcript API access > Microsoft Graph access'…",
			helpUrl:
				"https://learn.microsoft.com/microsoftteams/meeting-transcript-api-access",
			transcripts: [],
			count: 0,
		});

		expect(result).toEqual({
			content: null,
			reason: "transcript-access-disabled",
		});
	});

	it("still reports admin-consent-required for a missing app permission", async () => {
		const result = await runTranscriptChain({
			error: "Missing required permission: OnlineMeetingTranscript.Read.All",
			message:
				"A tenant administrator must grant the 'OnlineMeetingTranscript.Read.All' permission…",
			helpUrl:
				"https://learn.microsoft.com/graph/cloud-communication-online-meeting-application-access-policy",
			transcripts: [],
			count: 0,
		});

		expect(result).toEqual({
			content: null,
			reason: "admin-consent-required",
		});
	});

	// The content step classifies independently of the list step — a tenant can
	// list transcripts and still be refused their bodies.
	it("classifies the tenant setting on the transcript-content step too", async () => {
		const result = await runTranscriptChain(
			{
				transcripts: [
					{ id: "t1", createdDateTime: "2026-07-14T09:00:00Z" },
				],
			},
			{
				error: "Microsoft Graph access to meeting transcripts is disabled for this tenant",
				helpUrl:
					"https://learn.microsoft.com/microsoftteams/meeting-transcript-api-access",
			},
		);

		expect(result).toEqual({
			content: null,
			reason: "transcript-access-disabled",
		});
	});

	it("still throws for a Graph failure that is genuinely unexpected", async () => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		executeMicrosoftTeamsTool.mockRejectedValue(
			new Error(
				"Microsoft Graph API error: 500 Internal Server Error - {}",
			),
		);

		await expect(
			getPersonalTranscriptProcedure["~orpc"].handler({
				input: {
					projectId: "p1",
					organizationId: null,
					joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
					startTime: "2026-07-14T09:00:00Z",
				},
				context: { user: { id: "u1" }, session: {} },
				errors: {},
			} as never),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
	});
});
