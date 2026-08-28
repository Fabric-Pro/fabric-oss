/**
 * Regression tests for the resource named when redeeming a Microsoft refresh
 * token (Fizzy #2311).
 *
 * A refresh token here is multi-resource, and a redemption that omits `scope`
 * is issued against whichever resource was redeemed last. Once the
 * channel-recording fallback takes a SharePoint token, every later Graph
 * refresh silently came back with `aud` = SharePoint and Graph answered 401
 * "Invalid audience" — and because the retry re-minted the same wrong token,
 * the connection never recovered.
 *
 * These assert the outgoing token request, not internals: the defect was
 * invisible in behaviour until a live token was decoded, so the request body is
 * the only thing worth pinning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: vi.mock factories run before module-level consts are initialized.
const { findFirst, update } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { workflowIntegration: { findFirst, update } },
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));
vi.mock("@repo/ai", () => ({ extractRelevantExcerpts: vi.fn() }));

import { executeMicrosoftTeamsTool } from "../index";

const TOKEN_ENDPOINT =
	"https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

/** The exact 401 Graph returned in prod for a SharePoint-audience token. */
const invalidAudience = () =>
	new Response(
		JSON.stringify({
			error: {
				code: "InvalidAuthenticationToken",
				message: "Access token validation failure. Invalid audience.",
			},
		}),
		{ status: 401 },
	);

const refreshed = () =>
	new Response(
		JSON.stringify({
			access_token: "graph-access-token",
			refresh_token: "rotated-refresh-token",
			expires_in: 3599,
			token_type: "Bearer",
		}),
		{ status: 200 },
	);

interface RecordedCall {
	url: string;
	method: string;
	body: string;
	authorization: string;
}

/**
 * Queue of responses handed out one per `fetch` call, with the last one
 * repeating. Records the body and Authorization header so the token request
 * itself can be asserted.
 */
function stubFetch(responses: Array<() => Response>) {
	const calls: RecordedCall[] = [];
	const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			body:
				typeof init?.body === "string"
					? init.body
					: String(init?.body ?? ""),
			authorization: headers.Authorization ?? "",
		});
		const next =
			responses[Math.min(calls.length - 1, responses.length - 1)];
		return Promise.resolve(next());
	});
	vi.stubGlobal("fetch", fetchMock);
	return calls;
}

const tokenCalls = (calls: RecordedCall[]) =>
	calls.filter((c) => c.url === TOKEN_ENDPOINT);

beforeEach(() => {
	vi.useFakeTimers();
	process.env.MICROSOFT_GRAPH_CLIENT_ID = "test-client-id";
	process.env.MICROSOFT_GRAPH_CLIENT_SECRET = "test-client-secret";
	findFirst.mockResolvedValue({
		id: "integration_1",
		credentials: JSON.stringify({
			access_token: "sharepoint-audience-token",
			refresh_token: "refresh-token",
		}),
	});
	update.mockResolvedValue({});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	findFirst.mockReset();
	update.mockReset();
});

describe("Microsoft token refresh names the Graph resource (Fizzy #2311)", () => {
	it("sends the Graph scope when refreshing after an Invalid audience 401", async () => {
		const calls = stubFetch([
			invalidAudience,
			refreshed,
			() => new Response(JSON.stringify({ value: [] }), { status: 200 }),
		]);

		const promise = executeMicrosoftTeamsTool(
			"list_meeting_transcripts",
			{ meetingId: "meeting_1" },
			"user_1",
		);
		await vi.runAllTimersAsync();
		await promise;

		const token = tokenCalls(calls);
		expect(token).toHaveLength(1);

		const body = new URLSearchParams(token[0].body);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("scope")).toBe(GRAPH_DEFAULT_SCOPE);
	});

	it("never redeems a refresh token without a scope", async () => {
		// The regression itself: a scopeless body inherits the last-redeemed
		// resource, which is how a SharePoint token reached the Graph client.
		const calls = stubFetch([
			invalidAudience,
			refreshed,
			() => new Response(JSON.stringify({ value: [] }), { status: 200 }),
		]);

		const promise = executeMicrosoftTeamsTool(
			"list_meeting_transcripts",
			{ meetingId: "meeting_1" },
			"user_1",
		);
		await vi.runAllTimersAsync();
		await promise;

		for (const call of tokenCalls(calls)) {
			expect(new URLSearchParams(call.body).get("scope")).toBeTruthy();
		}
	});

	it("retries the Graph request with the refreshed token", async () => {
		const calls = stubFetch([
			invalidAudience,
			refreshed,
			() => new Response(JSON.stringify({ value: [] }), { status: 200 }),
		]);

		const promise = executeMicrosoftTeamsTool(
			"list_meeting_transcripts",
			{ meetingId: "meeting_1" },
			"user_1",
		);
		await vi.runAllTimersAsync();
		await promise;

		const graphCalls = calls.filter((c) => c.url !== TOKEN_ENDPOINT);
		expect(graphCalls).toHaveLength(2);
		expect(graphCalls[0].authorization).toBe(
			"Bearer sharepoint-audience-token",
		);
		expect(graphCalls[1].authorization).toBe("Bearer graph-access-token");
	});
});
