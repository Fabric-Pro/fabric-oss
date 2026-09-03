import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	downloadTeamsHostedContent,
	extractHostedContentRefsFromHtml,
} from "../hosted-content";
import { DownloadFailedError } from "../hosted-content.errors";

/**
 * Build a `Response`-shaped object that the helper can consume. Mirrors the
 * `mockResponse` helper used in the Slack download-file tests so the two
 * sides stay structurally similar.
 */
interface MockResponseInit {
	status: number;
	contentType?: string;
	contentDisposition?: string;
	retryAfter?: string;
	binaryChunks?: Uint8Array[];
	empty?: boolean;
}

function mockResponse(init: MockResponseInit): Response {
	const headers = new Headers();
	if (init.contentType) {
		headers.set("content-type", init.contentType);
	}
	if (init.contentDisposition) {
		headers.set("content-disposition", init.contentDisposition);
	}
	if (init.retryAfter) {
		headers.set("retry-after", init.retryAfter);
	}

	if (init.empty) {
		return new Response(null, {
			status: init.status,
			headers,
		});
	}

	const chunks = init.binaryChunks ?? [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
	];
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) {
				controller.enqueue(c);
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: init.status,
		headers,
	});
}

const MESSAGE_URL =
	"https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages/msg-1";
const MAX_BYTES = 5 * 1024 * 1024;

describe("extractHostedContentRefsFromHtml", () => {
	it("returns one ref per <img> tag pointing at hostedContents — preserving the verbatim Graph src URL", () => {
		const html = `
			<p>See screenshots below:</p>
			<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/abc123/$value" alt="First screenshot" />
			<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/def456/$value" alt="Second screenshot" />
			<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/ghi789/$value" alt="" />
		`;

		const refs = extractHostedContentRefsFromHtml(html, "msg-1");

		expect(refs).toHaveLength(3);
		expect(refs[0]).toEqual({
			id: "abc123",
			messageId: "msg-1",
			contentType: "application/octet-stream",
			srcUrl: "https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/abc123/$value",
			altText: "First screenshot",
		});
		expect(refs[1]).toEqual({
			id: "def456",
			messageId: "msg-1",
			contentType: "application/octet-stream",
			srcUrl: "https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/def456/$value",
			altText: "Second screenshot",
		});
		// Empty alt → omitted from the ref (clean shape).
		expect(refs[2]).toEqual({
			id: "ghi789",
			messageId: "msg-1",
			contentType: "application/octet-stream",
			srcUrl: "https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/ghi789/$value",
		});
	});

	it("returns an empty array for empty / whitespace-only HTML", () => {
		expect(extractHostedContentRefsFromHtml("", "msg-1")).toEqual([]);
		expect(extractHostedContentRefsFromHtml("    ", "msg-1")).toEqual([]);
	});

	it("captures the verbatim reply-scoped Graph URL on srcUrl AND tags the ref with parentMessageId for legacy-fallback compat (bug_002)", () => {
		// Bug-triage threads typically have the screenshot pasted in a
		// reply, not the root. Teams writes a reply-scoped Graph URL into
		// the `<img src>` — `srcUrl` preserves that verbatim so the
		// downloader doesn't have to guess the URL shape. `parentMessageId`
		// is kept on the ref for the legacy reconstruction fallback when
		// processing pending proposals stored before `srcUrl` existed.
		const replyBody = `
			<p>Here's my repro:</p>
			<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/replies/M-reply/hostedContents/reply-img-1/$value" alt="repro" />
		`;

		// Root extraction — no parentMessageId arg. The captured srcUrl is
		// the root-scoped URL Teams wrote.
		const rootRefs = extractHostedContentRefsFromHtml(
			'<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/hostedContents/root-img-1/$value" alt="">',
			"M-root",
		);
		expect(rootRefs).toEqual([
			{
				id: "root-img-1",
				messageId: "M-root",
				contentType: "application/octet-stream",
				srcUrl: "https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/hostedContents/root-img-1/$value",
			},
		]);
		// `parentMessageId` is absent on root refs (clean shape).
		expect(rootRefs[0]).not.toHaveProperty("parentMessageId");

		// Reply extraction — `srcUrl` carries the reply-scoped path verbatim,
		// `parentMessageId` is set for legacy-fallback compat.
		const replyRefs = extractHostedContentRefsFromHtml(
			replyBody,
			"M-reply",
			"M-root",
		);
		expect(replyRefs).toEqual([
			{
				id: "reply-img-1",
				messageId: "M-reply",
				parentMessageId: "M-root",
				contentType: "application/octet-stream",
				srcUrl: "https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/replies/M-reply/hostedContents/reply-img-1/$value",
				altText: "repro",
			},
		]);
	});

	it("decodes &amp; in the src attribute so srcUrl is fetch-ready", () => {
		// Teams emits HTML-encoded `&` in URLs (the `<img src>` is part of
		// an HTML document). If we hand the raw string to `fetch`, the
		// second query-string key becomes `amp;…` and Graph 400s the
		// request. Decoding common entities at the parser keeps the
		// downloader free of HTML concerns.
		const html =
			'<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/abc&amp;def/$value" alt="encoded">';

		const refs = extractHostedContentRefsFromHtml(html, "msg-1");

		expect(refs).toHaveLength(1);
		// The id pattern stops at `/`, so `&` is fine inside the id.
		expect(refs[0]?.id).toBe("abc&def");
		expect(refs[0]?.srcUrl).toBe(
			"https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/abc&def/$value",
		);
	});

	it("omits srcUrl for non-Graph hosts so the downloader falls back to messageUrl reconstruction", () => {
		// A non-Graph host (regional, Skype CMS, an external avatar) needs
		// auth we don't carry today, so we drop `srcUrl` and let the legacy
		// reconstruction path try the canonical Graph URL with the standard
		// Bearer token. The ref still surfaces because the id was parseable.
		const html =
			'<img src="https://us-api.asm.skype.com/v1/objects/0-eus-d20-xxx/views/imgo/hostedContents/skype-id/$value" alt="from skype">';

		const refs = extractHostedContentRefsFromHtml(html, "msg-1");

		expect(refs).toHaveLength(1);
		expect(refs[0]?.id).toBe("skype-id");
		expect(refs[0]).not.toHaveProperty("srcUrl");
	});

	it("tolerates malformed HTML — never throws", () => {
		// Mix of unclosed tags, missing quotes, garbage interleaved. The
		// parser should pick up the well-formed <img> and ignore the rest.
		const html =
			'<p>unclosed <em>section<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/good-id/$value" alt="ok">' +
			"<img src=bad-without-quotes>" +
			"<img>" +
			'<img src="" alt="empty src">' +
			'<img src="data:image/png;base64,iVBORw0KGgo=" alt="data uri to skip">';

		const refs = extractHostedContentRefsFromHtml(html, "msg-2");

		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({
			id: "good-id",
			messageId: "msg-2",
			altText: "ok",
		});
	});

	it("dedups by hostedContent.id within one message", () => {
		const html =
			'<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/same-id/$value" alt="first">' +
			'<img src="https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/same-id/$value" alt="duplicate">';

		const refs = extractHostedContentRefsFromHtml(html, "msg-3");

		expect(refs).toHaveLength(1);
		expect(refs[0].altText).toBe("first");
	});
});

describe("downloadTeamsHostedContent", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
	});

	it("returns { buffer, mime, size, contentDisposition } on a 200 image/png response", async () => {
		const chunk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 200,
				contentType: "image/png",
				contentDisposition: 'inline; filename="screenshot.png"',
				binaryChunks: [chunk],
			}),
		);

		const result = await downloadTeamsHostedContent(
			{
				id: "abc",
				messageId: "msg-1",
				contentType: "application/octet-stream",
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: MESSAGE_URL },
		);

		expect(result.mime).toBe("image/png");
		expect(result.size).toBe(chunk.byteLength);
		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.contentDisposition).toBe(
			'inline; filename="screenshot.png"',
		);
		expect(Buffer.from(chunk).equals(result.buffer)).toBe(true);

		// Auth header is set; URL is the message URL + /hostedContents/.../$value.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(url).toBe(`${MESSAGE_URL}/hostedContents/abc/$value`);
		expect(init.headers.Authorization).toBe("Bearer graph-test-token");
	});

	it("throws DownloadFailedError with status: 401 on HTTP 401", async () => {
		fetchMock.mockResolvedValue(mockResponse({ status: 401, empty: true }));

		const err = await downloadTeamsHostedContent(
			{
				id: "abc",
				messageId: "msg-1",
				contentType: "application/octet-stream",
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: MESSAGE_URL },
		).catch((e) => e);

		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as DownloadFailedError).status).toBe(401);
		// Helper must NEVER leak the URL or token into the message.
		expect((err as Error).message).not.toContain("graph-test-token");
		expect((err as Error).message).not.toContain("hostedContents");
	});

	it("throws DownloadFailedError with status: 403 on HTTP 403", async () => {
		fetchMock.mockResolvedValue(mockResponse({ status: 403, empty: true }));

		const err = await downloadTeamsHostedContent(
			{
				id: "abc",
				messageId: "msg-1",
				contentType: "application/octet-stream",
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: MESSAGE_URL },
		).catch((e) => e);

		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as DownloadFailedError).status).toBe(403);
	});

	it("retries 429 three times (1s / 2s / 4s backoff) then throws", async () => {
		vi.useFakeTimers();

		// Return 429 for every call. The helper retries 3 times after the
		// initial attempt → 4 total fetches, then a 429-rate-limited throw.
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 429,
				retryAfter: "1",
				empty: true,
			}),
		);

		// Attach the catch handler synchronously BEFORE draining fake
		// timers, otherwise the rejection from the helper fires before any
		// observer is registered and vitest flags an unhandled rejection.
		const errPromise = downloadTeamsHostedContent(
			{
				id: "abc",
				messageId: "msg-1",
				contentType: "application/octet-stream",
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: MESSAGE_URL },
		).catch((e: unknown) => e);

		// Drive the fake timers forward through each backoff window. We
		// give each retry the maximum window the helper might pick — 4s is
		// the upper bound from the fallback schedule when there's no
		// `Retry-After`. Calling `runAllTimersAsync` cleanly drains the
		// chain of pending timers + microtasks.
		await vi.runAllTimersAsync();

		const err = await errPromise;

		// 1 initial attempt + 3 retries = 4 total calls.
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as DownloadFailedError).status).toBe(429);
		expect((err as Error).message).toBe("rate_limited");
	});

	it("rejects non-https message URLs at the boundary", async () => {
		await expect(
			downloadTeamsHostedContent(
				{
					id: "abc",
					messageId: "msg-1",
					contentType: "application/octet-stream",
				},
				"graph-test-token",
				{
					maxBytes: MAX_BYTES,
					messageUrl:
						"http://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M",
				},
			),
		).rejects.toBeInstanceOf(DownloadFailedError);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses ref.srcUrl verbatim when present and ignores the messageUrl-reconstructed URL", async () => {
		// The whole point of `srcUrl` is to skip URL reconstruction — when
		// Teams gives us a reply-scoped Graph URL, we use that one rather
		// than gluing one together from `messageUrl + /hostedContents/{id}`.
		// This test pins that contract: if both are present, `srcUrl` wins.
		const chunk = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 200,
				contentType: "image/png",
				binaryChunks: [chunk],
			}),
		);

		const srcUrl =
			"https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/replies/M-reply/hostedContents/reply-img/$value";

		await downloadTeamsHostedContent(
			{
				id: "reply-img",
				messageId: "M-reply",
				parentMessageId: "M-root",
				contentType: "application/octet-stream",
				srcUrl,
			},
			"graph-test-token",
			// `messageUrl` is a deliberately-wrong "what reconstruction would
			// produce" value — the assertion below proves the helper ignored
			// it in favor of `srcUrl`.
			{
				maxBytes: MAX_BYTES,
				messageUrl:
					"https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/wrong-msg",
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [calledUrl] = fetchMock.mock.calls[0] as [string, unknown];
		expect(calledUrl).toBe(srcUrl);
		expect(calledUrl).not.toContain("wrong-msg");
	});

	it("falls back to messageUrl reconstruction when ref.srcUrl is absent (legacy refs)", async () => {
		// Pending proposals stored before `srcUrl` existed lack the field.
		// The downloader has to keep working for those — exercises the
		// legacy reconstruction path: `${messageUrl}/hostedContents/${id}/$value`.
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 200,
				contentType: "image/png",
				binaryChunks: [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
			}),
		);

		await downloadTeamsHostedContent(
			{
				id: "legacy-id",
				messageId: "msg-1",
				contentType: "application/octet-stream",
				// srcUrl deliberately omitted — legacy ref.
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: MESSAGE_URL },
		);

		const [calledUrl] = fetchMock.mock.calls[0] as [string, unknown];
		expect(calledUrl).toBe(
			`${MESSAGE_URL}/hostedContents/legacy-id/$value`,
		);
	});

	it("rejects non-https srcUrl at the HTTPS boundary (no network IO)", async () => {
		// The HTTPS-only guard must apply to srcUrl too, not just messageUrl —
		// otherwise a maliciously-crafted ref could downgrade to http://.
		await expect(
			downloadTeamsHostedContent(
				{
					id: "abc",
					messageId: "msg-1",
					contentType: "application/octet-stream",
					srcUrl: "http://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M/hostedContents/abc/$value",
				},
				"graph-test-token",
				{ maxBytes: MAX_BYTES, messageUrl: MESSAGE_URL },
			),
		).rejects.toBeInstanceOf(DownloadFailedError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("retries on 404 up to 2 times then succeeds (Microsoft Q&A 707816 timing-issue workaround)", async () => {
		vi.useFakeTimers();

		const chunk = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		// Sequence: 404 → 404 → 200. Helper should sleep between retries.
		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "NotFound",
							message: "Not Found",
							innerError: { "request-id": "req-1" },
						},
					}),
					{
						status: 404,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "NotFound",
							innerError: { "request-id": "req-2" },
						},
					}),
					{
						status: 404,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				mockResponse({
					status: 200,
					contentType: "image/png",
					binaryChunks: [chunk],
				}),
			);

		// Use a NON-reply URL so the helper has no fallback queue, only retries.
		const messageUrl =
			"https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root";

		const resultPromise = downloadTeamsHostedContent(
			{
				id: "abc",
				messageId: "M-root",
				contentType: "application/octet-stream",
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl },
		);

		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result.mime).toBe("image/png");
		// 1 initial + 2 retries = 3 total calls on the SAME URL.
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const urls = fetchMock.mock.calls.map(
			(c) => (c as [string, unknown])[0],
		);
		expect(new Set(urls).size).toBe(1);
	});

	it("falls back to the root URL when reply-scoped URL keeps 404ing (drops /replies/ segment)", async () => {
		vi.useFakeTimers();

		const chunk = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		// Sequence: 3× 404 on the reply URL (initial + 2 retries), then 200
		// on the root-URL fallback. Helper should not retry the fallback URL.
		const notFoundResp = () =>
			new Response(
				JSON.stringify({
					error: {
						code: "NotFound",
						innerError: { "request-id": "graph-req-id-xyz" },
					},
				}),
				{
					status: 404,
					headers: { "content-type": "application/json" },
				},
			);
		fetchMock
			.mockResolvedValueOnce(notFoundResp())
			.mockResolvedValueOnce(notFoundResp())
			.mockResolvedValueOnce(notFoundResp())
			.mockResolvedValueOnce(
				mockResponse({
					status: 200,
					contentType: "image/png",
					binaryChunks: [chunk],
				}),
			);

		const replySrcUrl =
			"https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/replies/M-reply/hostedContents/img-1/$value";
		const expectedRootFallback =
			"https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/hostedContents/img-1/$value";

		const resultPromise = downloadTeamsHostedContent(
			{
				id: "img-1",
				messageId: "M-reply",
				parentMessageId: "M-root",
				contentType: "application/octet-stream",
				srcUrl: replySrcUrl,
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: "ignored-when-srcUrl-set" },
		);

		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result.mime).toBe("image/png");
		expect(fetchMock).toHaveBeenCalledTimes(4);
		const urls = fetchMock.mock.calls.map(
			(c) => (c as [string, unknown])[0],
		);
		// First 3 calls were on the reply URL, 4th on the root-fallback URL.
		expect(urls[0]).toBe(replySrcUrl);
		expect(urls[1]).toBe(replySrcUrl);
		expect(urls[2]).toBe(replySrcUrl);
		expect(urls[3]).toBe(expectedRootFallback);
	});

	it("throws with Graph error.code and request-id in detail when 404s exhaust on both URLs", async () => {
		vi.useFakeTimers();

		const notFoundResp = () =>
			new Response(
				JSON.stringify({
					error: {
						code: "NotFound",
						message: "Not Found",
						innerError: { "request-id": "final-req-id" },
					},
				}),
				{
					status: 404,
					headers: { "content-type": "application/json" },
				},
			);
		// 3× 404 on reply URL + 3× 404 on root URL = 6 calls then throw.
		fetchMock.mockResolvedValue(notFoundResp());

		const errPromise = downloadTeamsHostedContent(
			{
				id: "img-1",
				messageId: "M-reply",
				parentMessageId: "M-root",
				contentType: "application/octet-stream",
				srcUrl: "https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/replies/M-reply/hostedContents/img-1/$value",
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: "ignored" },
		).catch((e: unknown) => e);

		await vi.runAllTimersAsync();
		const err = await errPromise;

		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as DownloadFailedError).status).toBe(404);
		expect((err as Error).message).toContain("404");
		expect((err as Error).message).toContain("code=NotFound");
		expect((err as Error).message).toContain("requestId=final-req-id");
		// Must NOT leak the URL or token.
		expect((err as Error).message).not.toContain("graph-test-token");
		expect((err as Error).message).not.toContain("hostedContents");
		// Total: 3 (primary URL) + 3 (root fallback URL) = 6 calls.
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("does NOT attempt the root-URL fallback when the primary URL is a root message (no /replies/ segment)", async () => {
		vi.useFakeTimers();

		const notFoundResp = () =>
			new Response(
				JSON.stringify({
					error: {
						code: "NotFound",
						innerError: { "request-id": "root-req-id" },
					},
				}),
				{
					status: 404,
					headers: { "content-type": "application/json" },
				},
			);
		fetchMock.mockResolvedValue(notFoundResp());

		const errPromise = downloadTeamsHostedContent(
			{
				id: "img-1",
				messageId: "M-root",
				contentType: "application/octet-stream",
				srcUrl: "https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/hostedContents/img-1/$value",
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: "ignored" },
		).catch((e: unknown) => e);

		await vi.runAllTimersAsync();
		const err = await errPromise;

		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as DownloadFailedError).status).toBe(404);
		// 1 initial + 2 retries = 3 total. No fallback URL exists.
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does NOT attempt the root-URL fallback when the primary URL exceeds the redos length bound, even though it is reply-scoped", async () => {
		vi.useFakeTimers();

		const notFoundResp = () =>
			new Response(
				JSON.stringify({
					error: {
						code: "NotFound",
						innerError: { "request-id": "oversized-req-id" },
					},
				}),
				{
					status: 404,
					headers: { "content-type": "application/json" },
				},
			);
		fetchMock.mockResolvedValue(notFoundResp());

		// Reply-scoped shape (would normally derive a root fallback), but
		// padded past the 2048-char bound `deriveRootFallbackUrl` enforces.
		const padding = "a".repeat(2200);
		const oversizedReplySrcUrl = `https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M-root/replies/M-reply/hostedContents/img-1/$value?pad=${padding}`;
		expect(oversizedReplySrcUrl.length).toBeGreaterThan(2048);

		const errPromise = downloadTeamsHostedContent(
			{
				id: "img-1",
				messageId: "M-reply",
				parentMessageId: "M-root",
				contentType: "application/octet-stream",
				srcUrl: oversizedReplySrcUrl,
			},
			"graph-test-token",
			{ maxBytes: MAX_BYTES, messageUrl: "ignored" },
		).catch((e: unknown) => e);

		await vi.runAllTimersAsync();
		const err = await errPromise;

		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as DownloadFailedError).status).toBe(404);
		// 1 initial + 2 retries = 3 total — the length cap suppresses the
		// fallback URL that would otherwise have been derived and tried.
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("throws DownloadFailedError('image_too_large') when maxBytes is exceeded", async () => {
		// Stream three 2KB chunks for a 6KB total; cap at 4KB.
		const chunk = new Uint8Array(2048);
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 200,
				contentType: "image/png",
				binaryChunks: [chunk, chunk, chunk],
			}),
		);

		const err = await downloadTeamsHostedContent(
			{
				id: "abc",
				messageId: "msg-1",
				contentType: "application/octet-stream",
			},
			"graph-test-token",
			{ maxBytes: 4 * 1024, messageUrl: MESSAGE_URL },
		).catch((e) => e);

		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as Error).message).toBe("image_too_large");
	});
});
