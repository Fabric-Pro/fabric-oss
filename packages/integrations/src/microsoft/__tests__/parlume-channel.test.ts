import { describe, expect, it, vi } from "vitest";
import {
	executeParlumeChannelOperation,
	isShortTeamsMeetingUrl,
	parseChannelMeetingUrl,
} from "../parlume-channel";

const channelId = "19:example@thread.tacv2";
const meetingUrl = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(channelId)}/1700000000000`;
const shortUrl = "https://teams.microsoft.com/meet/1234567890123?p=example";
const destination = {
	teamId: "example-team",
	channelId,
	rootMessageId: "1700000000000",
	tenantId: "example-tenant",
};
const root = {
	id: destination.rootMessageId,
	replyToId: null,
	createdDateTime: "2026-11-02T10:00:00Z",
	channelIdentity: { teamId: destination.teamId, channelId },
	body: { contentType: "text", content: "Meeting" },
};
const onlineMeeting = {
	joinWebUrl: meetingUrl,
	joinMeetingIdSettings: { joinMeetingId: "1234567890123" },
};
const ok = (value: unknown) => Response.json(value);
const resolve = { kind: "resolve", meetingUrl };

function resolvingFetch(result: unknown = { value: [onlineMeeting] }) {
	return vi.fn(async (url: string) => {
		if (url.includes("/onlineMeetings?")) {
			return ok(result);
		}
		if (url.includes("/joinedTeams?")) {
			return ok({ value: [{ id: destination.teamId }] });
		}
		if (url.endsWith("/channels?$select=id,displayName")) {
			return ok({ value: [{ id: channelId }] });
		}
		if (url.includes("?$select=id,tenantId")) {
			return ok({ id: channelId, tenantId: destination.tenantId });
		}
		return ok(root);
	});
}

describe("Parlume exact Teams channel binding", () => {
	it("parses channel/root candidates only on the exact Teams HTTPS join path", () => {
		expect(parseChannelMeetingUrl(meetingUrl)).toEqual({
			channelId,
			rootMessageId: destination.rootMessageId,
		});
		for (const invalid of [
			meetingUrl.replace("https:", "http:"),
			meetingUrl.replace("teams.microsoft.com", "example.com"),
			meetingUrl.replace("thread.tacv2", "thread.v2"),
			`${meetingUrl}/other`,
			meetingUrl.replace("1700000000000", "not-a-root"),
			shortUrl,
		]) {
			expect(parseChannelMeetingUrl(invalid)).toBeNull();
		}
		for (const suffix of ["suffix", "/other"]) {
			expect(
				isShortTeamsMeetingUrl(
					`https://teams.microsoft.com/meet/1234567890123${suffix}`,
				),
			).toBe(false);
		}
	});
	it("proves a numeric root with an exact authenticated GET and never visits files or lists history", async () => {
		const fetch = resolvingFetch();
		expect(await executeParlumeChannelOperation(fetch, resolve)).toEqual(
			destination,
		);
		expect(fetch.mock.calls.at(-1)?.[0]).toBe(
			`https://graph.microsoft.com/v1.0/teams/example-team/channels/${encodeURIComponent(channelId)}/messages/1700000000000`,
		);
		expect(
			fetch.mock.calls.some(([url]) =>
				/files|replies\?|messages\?/.test(url),
			),
		).toBe(false);
	});
	it("refuses a missing candidate numeric root or one that is a reply", async () => {
		const fetch = resolvingFetch();
		fetch.mockImplementation(async (url) =>
			url.endsWith("/messages/1700000000000")
				? new Response(null, { status: 404 })
				: resolvingFetch()(url),
		);
		await expect(
			executeParlumeChannelOperation(fetch, resolve),
		).rejects.toThrow("HTTP 404");
		fetch.mockImplementation(async (url) =>
			url.endsWith("/messages/1700000000000")
				? ok({ ...root, replyToId: "another-root" })
				: resolvingFetch()(url),
		);
		await expect(
			executeParlumeChannelOperation(fetch, resolve),
		).rejects.toThrow("bound meeting thread");
	});
	it("resolves a short URL by its authorized numeric meeting ID without reading calendar bodies or passcodes", async () => {
		const fetch = resolvingFetch();
		expect(
			await executeParlumeChannelOperation(fetch, {
				...resolve,
				meetingUrl: shortUrl,
			}),
		).toEqual(destination);
		const query = new URL(fetch.mock.calls[0][0]);
		expect(query.pathname).toBe("/v1.0/me/onlineMeetings");
		expect(query.searchParams.get("$filter")).toBe(
			"joinMeetingIdSettings/joinMeetingId eq '1234567890123'",
		);
		expect(
			fetch.mock.calls.some(([url]) =>
				/calendar|example|passcode/.test(new URL(url).search),
			),
		).toBe(false);
	});
	it("positively resolves an ordinary short meeting to Attendee", async () => {
		const fetch = resolvingFetch({
			value: [
				{
					...onlineMeeting,
					joinWebUrl: meetingUrl.replace("thread.tacv2", "thread.v2"),
				},
			],
		});
		expect(
			await executeParlumeChannelOperation(fetch, {
				...resolve,
				meetingUrl: shortUrl,
			}),
		).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ value: [] },
		{
			value: [
				{
					...onlineMeeting,
					joinMeetingIdSettings: { joinMeetingId: "9999999999999" },
				},
			],
		},
		{
			value: [
				onlineMeeting,
				{
					...onlineMeeting,
					joinWebUrl: meetingUrl.replace(
						"1700000000000",
						"1700000000001",
					),
				},
			],
		},
		{
			value: [
				{
					...onlineMeeting,
					joinWebUrl: meetingUrl.replace("thread.tacv2", "thread.v2"),
				},
				{
					...onlineMeeting,
					joinWebUrl: meetingUrl
						.replace("thread.tacv2", "thread.v2")
						.replace("example", "another"),
				},
			],
		},
		{ value: [{ ...onlineMeeting, joinWebUrl: shortUrl }] },
		{
			value: [onlineMeeting],
			"@odata.nextLink": "https://example.com/untrusted",
		},
	])(
		"fails closed for missing, mismatched, ambiguous, recursive or paged identity %j",
		async (result) => {
			const fetch = resolvingFetch(result);
			await expect(
				executeParlumeChannelOperation(fetch, {
					...resolve,
					meetingUrl: shortUrl,
				}),
			).rejects.toThrow("Channel chat unresolved");
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it("does not infer identity after a permission failure", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 403 }));
		await expect(
			executeParlumeChannelOperation(fetch, {
				...resolve,
				meetingUrl: shortUrl,
			}),
		).rejects.toThrow("HTTP 403");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("creates only a channel subscription with explicit delegated-resource scope", async () => {
		const fetch = vi.fn().mockResolvedValue(
			ok({
				id: "subscription",
				expirationDateTime: "2026-11-02T10:45:00Z",
			}),
		);
		await executeParlumeChannelOperation(fetch, {
			kind: "subscribe",
			destination,
			notificationUrl:
				"https://example.com/api/webhooks/parlume-channel?session=example",
			clientState: "x".repeat(43),
			expiresAt: "2026-11-02T10:45:00Z",
		});
		expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
			changeType: "created",
			includeResourceData: false,
			resource: `/teams/example-team/channels/${channelId}/messages`,
			expirationDateTime: "2026-11-02T10:45:00Z",
		});
	});
});
