/**
 * The two pull-request webhook ROUTES, at the HTTP layer.
 *
 * The handlers underneath them are tested in `@repo/api`. What is only visible
 * here is what a sender actually receives — the status code and the body — and
 * for these two routes that is the security-relevant part:
 *
 *  - the retired shared path must answer `410`, not silently accept or 404;
 *  - the per-project path must refuse an oversized body and a flood BEFORE it
 *    reads or authenticates anything, because it is reachable unauthenticated
 *    and the signature cannot be checked without first buffering the body.
 */

import { describe, expect, it, vi } from "vitest";

const { handleProjectPullRequestWebhook, checkRateLimit } = vi.hoisted(() => ({
	handleProjectPullRequestWebhook: vi.fn(),
	checkRateLimit: vi.fn(),
}));

vi.mock(
	"@repo/api/modules/projects/procedures/pr-review/project-pull-request-webhook",
	() => ({
		handleProjectPullRequestWebhook: (...a: unknown[]) =>
			handleProjectPullRequestWebhook(...a),
	}),
);
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
	RATE_LIMIT_PRESETS: { webhook: { limit: 60, windowMs: 60_000 } },
}));

import { POST as projectPost } from "../../app/api/webhooks/github/pull-request/[projectId]/route";
import {
	GET as retiredGet,
	POST as retiredPost,
} from "../../app/api/webhooks/github/pull-request/route";

function request(body: string, headers: Record<string, string> = {}) {
	return new Request(
		"http://localhost/api/webhooks/github/pull-request/proj-1",
		{
			method: "POST",
			body,
			headers: {
				"content-type": "application/json",
				"x-github-event": "pull_request",
				...headers,
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: NextRequest is a Request superset
	) as any;
}

const params = { params: Promise.resolve({ projectId: "proj-1" }) };

describe("the retired shared endpoint", () => {
	it("answers 410 to a POST and names its replacement", async () => {
		const res = await retiredPost();
		const body = await res.json();

		expect(res.status).toBe(410);
		expect(body.handled).toBe(false);
		expect(body.reason).toBe("endpoint-retired");
		// The replacement has to be IN the response: GitHub's deliveries tab is
		// where somebody looks when a webhook starts failing.
		expect(body.replacement).toContain(
			"/api/webhooks/github/pull-request/{projectId}",
		);
	});

	it("answers 410 to the GET probe too", async () => {
		// Services probe with GET before saving a webhook URL. Answering 200 here
		// would let somebody save a URL that can never work.
		const res = await retiredGet();

		expect(res.status).toBe(410);
	});
});

describe("the per-project endpoint's front door", () => {
	it("refuses a flood before reading or authenticating anything", async () => {
		checkRateLimit.mockResolvedValue({
			allowed: false,
			statusCode: 429,
			resetInSeconds: 30,
		});

		const res = await projectPost(request("{}"), params);
		const body = await res.json();

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("30");
		expect(body.reason).toBe("rate-limited");
		expect(handleProjectPullRequestWebhook).not.toHaveBeenCalled();
	});

	it("refuses an oversized body from its declared length, before buffering it", async () => {
		checkRateLimit.mockResolvedValue({ allowed: true });

		const res = await projectPost(
			request("{}", { "content-length": String(2 * 1024 * 1024) }),
			params,
		);

		expect(res.status).toBe(413);
		expect((await res.json()).reason).toBe("payload-too-large");
		expect(handleProjectPullRequestWebhook).not.toHaveBeenCalled();
	});

	it("refuses an oversized body that lied about its length", async () => {
		// A missing or dishonest content-length is why the size is checked twice.
		checkRateLimit.mockResolvedValue({ allowed: true });

		const res = await projectPost(
			request(`{"pad":"${"x".repeat(1024 * 1024 + 10)}"}`),
			params,
		);

		expect(res.status).toBe(413);
		expect(handleProjectPullRequestWebhook).not.toHaveBeenCalled();
	});

	it("answers 400 for a body that is not JSON, without calling the handler", async () => {
		checkRateLimit.mockResolvedValue({ allowed: true });

		const res = await projectPost(request("not json at all"), params);

		expect(res.status).toBe(400);
		expect(handleProjectPullRequestWebhook).not.toHaveBeenCalled();
	});

	it("passes the project id, the raw body and the signature through", async () => {
		checkRateLimit.mockResolvedValue({ allowed: true });
		handleProjectPullRequestWebhook.mockResolvedValue({
			status: 200,
			handled: true,
			projects: 1,
		});
		const raw = '{"action":"opened"}';

		const res = await projectPost(
			request(raw, { "x-hub-signature-256": "sha256=abc" }),
			params,
		);

		expect(await res.json()).toEqual({
			handled: true,
			reason: null,
			projects: 1,
		});
		expect(handleProjectPullRequestWebhook).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				// The RAW bytes, not a re-serialised parse — the signature is over
				// exactly what the sender sent.
				rawBody: raw,
				signatureHeader: "sha256=abc",
				eventName: "pull_request",
			}),
		);
	});

	it("reports zero projects rather than omitting the count", async () => {
		checkRateLimit.mockResolvedValue({ allowed: true });
		handleProjectPullRequestWebhook.mockResolvedValue({
			status: 200,
			handled: false,
			reason: "auto-review-off",
		});

		expect(await (await projectPost(request("{}"), params)).json()).toEqual(
			{
				handled: false,
				reason: "auto-review-off",
				projects: 0,
			},
		);
	});
});
