import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadSlackFile } from "../download-file";
import {
	AuthFailedError,
	DownloadFailedError,
	ExternalWorkspaceError,
	ScopeMissingError,
} from "../download-file.errors";

/**
 * Build a `Response`-shaped object that the helper can consume. Vitest's
 * default `Response` is the platform implementation which supports
 * `headers.get` + `body.getReader` + `clone().json` — we mirror just enough
 * here to drive the success and error paths without pulling in undici.
 */
interface MockResponseInit {
	status: number;
	contentType?: string;
	jsonBody?: unknown;
	binaryChunks?: Uint8Array[];
	empty?: boolean;
}

function mockResponse(init: MockResponseInit): Response {
	const headers = new Headers();
	if (init.contentType) {
		headers.set("content-type", init.contentType);
	}

	if (init.empty) {
		return new Response(null, {
			status: init.status,
			headers,
		});
	}

	if (init.jsonBody !== undefined) {
		// Slack returns 200 + JSON body with ok=false for some auth failures.
		return new Response(JSON.stringify(init.jsonBody), {
			status: init.status,
			headers,
		});
	}

	// Binary body: combine the chunks into one ReadableStream so the helper's
	// streaming-read loop sees a realistic multi-chunk read.
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

describe("downloadSlackFile", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;
	const MAX_BYTES = 5 * 1024 * 1024;

	beforeEach(() => {
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns { buffer, mime, size } on a 200 image/png response", async () => {
		const chunk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 200,
				contentType: "image/png",
				binaryChunks: [chunk],
			}),
		);

		const result = await downloadSlackFile(
			"https://files.slack.com/files-pri/T1-F1/screenshot.png",
			"xoxb-test",
			{ maxBytes: MAX_BYTES },
		);

		expect(result.mime).toBe("image/png");
		expect(result.size).toBe(chunk.byteLength);
		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(Buffer.from(chunk).equals(result.buffer)).toBe(true);
	});

	it("sends Authorization: Bearer <token> header", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 200,
				contentType: "image/png",
				binaryChunks: [new Uint8Array([0xff])],
			}),
		);

		await downloadSlackFile(
			"https://files.slack.com/files-pri/T1-F1/x.png",
			"xoxb-secret",
			{ maxBytes: MAX_BYTES },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(url).toBe("https://files.slack.com/files-pri/T1-F1/x.png");
		expect(init.headers.Authorization).toBe("Bearer xoxb-secret");
	});

	it("throws ScopeMissingError on 200 + JSON ok:false missing_scope", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 200,
				contentType: "application/json; charset=utf-8",
				jsonBody: { ok: false, error: "missing_scope" },
			}),
		);

		await expect(
			downloadSlackFile("https://files.slack.com/x", "xoxb-test", {
				maxBytes: MAX_BYTES,
			}),
		).rejects.toBeInstanceOf(ScopeMissingError);
	});

	it("throws AuthFailedError on HTTP 401 (token-level failure, NOT scope)", async () => {
		// Slack 401 is `invalid_auth` / `token_revoked` / `token_expired` /
		// `account_inactive` / `not_authed` — all token-level failures, not
		// scope. The genuine scope failure is HTTP 200 + `missing_scope` body
		// (see the earlier test). Routing 401 → AuthFailedError gives ops a
		// distinct "re-authorize the workspace" signal vs the scope label.
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 401,
				contentType: "application/json",
				jsonBody: { ok: false, error: "not_authed" },
			}),
		);

		await expect(
			downloadSlackFile("https://files.slack.com/x", "xoxb-test", {
				maxBytes: MAX_BYTES,
			}),
		).rejects.toBeInstanceOf(AuthFailedError);
	});

	it("throws ExternalWorkspaceError on HTTP 403", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 403,
				empty: true,
			}),
		);

		await expect(
			downloadSlackFile("https://files.slack.com/x", "xoxb-test", {
				maxBytes: MAX_BYTES,
			}),
		).rejects.toBeInstanceOf(ExternalWorkspaceError);
	});

	it("throws DownloadFailedError on 5xx", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 503,
				empty: true,
			}),
		);

		const err = await downloadSlackFile(
			"https://files.slack.com/x",
			"xoxb-test",
			{ maxBytes: MAX_BYTES },
		).catch((e) => e);
		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as DownloadFailedError).status).toBe(503);
	});

	it("surfaces an aborted fetch as DownloadFailedError (not a raw DOMException)", async () => {
		const controller = new AbortController();
		fetchMock.mockImplementation(
			(_url: string, init?: { signal?: AbortSignal }) => {
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"));
					});
				});
			},
		);

		const promise = downloadSlackFile(
			"https://files.slack.com/x",
			"xoxb-test",
			{ maxBytes: MAX_BYTES, signal: controller.signal },
		);

		controller.abort();

		const err = await promise.catch((e) => e);
		expect(err).toBeInstanceOf(DownloadFailedError);
		// Helper must NEVER leak the URL or token into the message.
		expect((err as Error).message).not.toContain("xoxb-test");
		expect((err as Error).message).not.toContain("files.slack.com");
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

		const err = await downloadSlackFile(
			"https://files.slack.com/big.png",
			"xoxb-test",
			{ maxBytes: 4 * 1024 },
		).catch((e) => e);

		expect(err).toBeInstanceOf(DownloadFailedError);
		expect((err as Error).message).toBe("image_too_large");
	});

	it("rejects non-https URLs at the boundary (no fetch attempted)", async () => {
		await expect(
			downloadSlackFile("http://files.slack.com/x", "xoxb-test", {
				maxBytes: MAX_BYTES,
			}),
		).rejects.toBeInstanceOf(DownloadFailedError);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
