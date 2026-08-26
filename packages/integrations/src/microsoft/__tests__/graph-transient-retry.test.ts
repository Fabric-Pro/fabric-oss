/**
 * Wiring tests for graphRequest's transient-failure retry, driven through the
 * real Teams tool entry point with `fetch` stubbed.
 *
 * The predicate is unit-tested in graph-throttle-backoff.test.ts; these cover
 * what that cannot — that the loop is actually wired into the request path, that
 * it stops at the retry ceiling, and that a write is not replayed on a gateway
 * error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: vi.mock factories run before module-level consts are initialized.
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@repo/database", () => ({
	db: { workflowIntegration: { findFirst, update: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));
vi.mock("@repo/ai", () => ({ extractRelevantExcerpts: vi.fn() }));

import { executeMicrosoftTeamsTool } from "../index";

/** Graph's 502 body, as captured in the prod log on issue #2859. */
const BAD_GATEWAY_BODY = JSON.stringify({
	error: {
		code: "BadGateway",
		message: "Failed to execute backend request.",
	},
});

const badGateway = () => new Response(BAD_GATEWAY_BODY, { status: 502 });

/**
 * Queue of responses handed out one per `fetch` call, with the last one
 * repeating so a test only has to spell out the attempts it cares about.
 */
function stubFetch(responses: Array<() => Response>) {
	const calls: Array<{ url: string; method: string }> = [];
	const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
		});
		const next =
			responses[Math.min(calls.length - 1, responses.length - 1)];
		return Promise.resolve(next());
	});
	vi.stubGlobal("fetch", fetchMock);
	return calls;
}

beforeEach(() => {
	vi.useFakeTimers();
	findFirst.mockResolvedValue({
		id: "integration_1",
		credentials: JSON.stringify({
			access_token: "access-token",
			refresh_token: "refresh-token",
		}),
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	findFirst.mockReset();
});

describe("graphRequest transient retry (issue #2859)", () => {
	it("recovers a transcript listing from a single 502", async () => {
		const calls = stubFetch([
			badGateway,
			() =>
				new Response(
					JSON.stringify({
						value: [
							{
								id: "transcript_1",
								createdDateTime: "2026-08-17T02:00:00Z",
							},
						],
					}),
					{ status: 200 },
				),
		]);

		const promise = executeMicrosoftTeamsTool(
			"list_meeting_transcripts",
			{ meetingId: "meeting_1" },
			"user_1",
		);
		await vi.runAllTimersAsync();
		const result = (await promise) as {
			transcripts: Array<{ id: string }>;
			count: number;
		};

		expect(calls).toHaveLength(2);
		expect(calls[1].method).toBe("GET");
		expect(result.count).toBe(1);
		expect(result.transcripts[0].id).toBe("transcript_1");
	});

	it("releases the body of the response it drops", async () => {
		// An unread body holds its connection out of the pool across the sleep.
		const cancelled = vi.fn();
		const calls = stubFetch([
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(BAD_GATEWAY_BODY),
							);
						},
						cancel: cancelled,
					}),
					{ status: 502 },
				),
			() => new Response(JSON.stringify({ value: [] }), { status: 200 }),
		]);

		const promise = executeMicrosoftTeamsTool(
			"list_meeting_transcripts",
			{ meetingId: "meeting_1" },
			"user_1",
		);
		await vi.runAllTimersAsync();
		await promise;

		expect(calls).toHaveLength(2);
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	it("gives up after the retry ceiling and throws", async () => {
		const calls = stubFetch([badGateway]);

		const promise = executeMicrosoftTeamsTool(
			"list_meeting_transcripts",
			{ meetingId: "meeting_1" },
			"user_1",
		);
		const assertion = expect(promise).rejects.toThrow(
			/Microsoft Graph API error: 502/,
		);
		await vi.runAllTimersAsync();
		await assertion;

		// One initial attempt plus TRANSIENT_MAX_RETRIES.
		expect(calls).toHaveLength(4);
	});

	it("does not replay a message send on a 502", async () => {
		const calls = stubFetch([badGateway]);

		const promise = executeMicrosoftTeamsTool(
			"send_message",
			{ chatId: "chat_1", text: "hello" },
			"user_1",
		);
		const assertion = expect(promise).rejects.toThrow(
			/Microsoft Graph API error: 502/,
		);
		await vi.runAllTimersAsync();
		await assertion;

		// A gateway error can arrive after the message was posted, so the write
		// is surfaced rather than retried.
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
	});

	it("still retries a throttled write", async () => {
		const calls = stubFetch([
			() =>
				new Response("{}", {
					status: 429,
					headers: { "Retry-After": "1" },
				}),
			() =>
				new Response(JSON.stringify({ id: "message_1" }), {
					status: 201,
				}),
		]);

		const promise = executeMicrosoftTeamsTool(
			"send_message",
			{ chatId: "chat_1", text: "hello" },
			"user_1",
		);
		await vi.runAllTimersAsync();
		const result = (await promise) as {
			success: boolean;
			messageId: string;
		};

		expect(calls).toHaveLength(2);
		expect(result.messageId).toBe("message_1");
	});

	it("leaves the search POST unretried, by the same write rule", async () => {
		// /search/query is read-shaped but uses POST, so it is deliberately out
		// of the GET/HEAD retry contract. Pinned so the exclusion is a decision
		// rather than an oversight.
		const calls = stubFetch([badGateway]);

		const promise = executeMicrosoftTeamsTool(
			"search_messages",
			{ query: "from:Someone" },
			"user_1",
		);
		const assertion = expect(promise).rejects.toThrow(
			/Microsoft Graph API error: 502/,
		);
		await vi.runAllTimersAsync();
		await assertion;

		expect(calls).toHaveLength(1);
	});
});
