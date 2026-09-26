/**
 * `/api/client-errors` — the ingest for `rpc-failure-report.ts`, the two
 * oRPC failure shapes (transport, rewrapped error page) the API's own
 * `rpc.error` log line never saw. Modeled on the CSP report route, plus a
 * required session and a per-user rate limit (see the route's doc comment).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/client-errors/route";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	checkRateLimit: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
}));

const { logger } = vi.hoisted(() => ({
	logger: { warn: vi.fn() },
}));
vi.mock("@repo/logs", () => ({ logger }));

function request(
	body: unknown,
	init: {
		host?: string;
		origin?: string;
		contentType?: string;
		contentLength?: string;
	} = {},
) {
	const headers = new Headers();
	headers.set("host", init.host ?? "app.fabric.pro");
	headers.set("content-type", init.contentType ?? "application/json");
	if (init.origin !== undefined) {
		headers.set("origin", init.origin);
	} else {
		headers.set("origin", `https://${init.host ?? "app.fabric.pro"}`);
	}
	if (init.contentLength !== undefined) {
		headers.set("content-length", init.contentLength);
	}
	return new Request("https://app.fabric.pro/api/client-errors", {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const validReport = {
	procedure: "prompts/list",
	kind: "transport" as const,
	route: "/app/prompts",
};

beforeEach(() => {
	mocks.getSession.mockReset();
	mocks.checkRateLimit.mockReset();
	logger.warn.mockReset();
	mocks.getSession.mockResolvedValue({ user: { id: "user_1" } });
	mocks.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 29,
		resetInSeconds: 60,
	});
});

describe("POST /api/client-errors", () => {
	it("returns 401 without a session", async () => {
		mocks.getSession.mockResolvedValue(null);

		const res = await POST(request({ reports: [validReport] }));

		expect(res.status).toBe(401);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("returns 403 for a cross-site origin", async () => {
		const res = await POST(
			request(
				{ reports: [validReport] },
				{ origin: "https://evil.example.com" },
			),
		);

		expect(res.status).toBe(403);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("accepts a request with no Origin header (same-site form-style posts)", async () => {
		const req = request({ reports: [validReport] });
		req.headers.delete("origin");

		const res = await POST(req);

		expect(res.status).toBe(204);
	});

	it("returns 400 for a non-JSON content type", async () => {
		const res = await POST(
			request("reports=1", { contentType: "text/plain" }),
		);

		expect(res.status).toBe(400);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("returns 413 for an oversized body (post-read byte check)", async () => {
		const hugeRoute = "x".repeat(20 * 1024);
		const res = await POST(
			request({ reports: [{ ...validReport, route: hugeRoute }] }),
		);

		expect(res.status).toBe(413);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("returns 413 from a declared Content-Length alone, before reading the body", async () => {
		// The body itself is tiny and valid — only the declared header is
		// over budget. A route that read the body first regardless would
		// still 204 this; the pre-read check must reject it first.
		const res = await POST(
			request({ reports: [validReport] }, { contentLength: "999999" }),
		);

		expect(res.status).toBe(413);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("measures the post-read cap in UTF-8 bytes, not UTF-16 code units", async () => {
		// Each 😀 is 2 UTF-16 code units (4 bytes UTF-8). At 8192 repeats,
		// `.length` is exactly 16384 (at the old, wrong budget) while the
		// real UTF-8 byte length is 32768 — well over. Proves the fix: a
		// `.length`-based check would have let this through.
		const emojiRoute = "😀".repeat(8192);
		const res = await POST(
			request({ reports: [{ ...validReport, route: emojiRoute }] }),
		);

		expect(res.status).toBe(413);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("returns 400 for malformed JSON", async () => {
		const res = await POST(request("{not valid json"));

		expect(res.status).toBe(400);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("returns 400 for a batch failing schema validation", async () => {
		const res = await POST(
			request({
				reports: [
					{ procedure: "x", kind: "not-a-real-kind", route: "/x" },
				],
			}),
		);

		expect(res.status).toBe(400);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("returns 400 for a batch over 20 items", async () => {
		const reports = Array.from({ length: 21 }, (_, i) => ({
			...validReport,
			procedure: `proc-${i}`,
		}));

		const res = await POST(request({ reports }));

		expect(res.status).toBe(400);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("returns 429 with Retry-After when the rate limit is exceeded", async () => {
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 42,
		});

		const res = await POST(request({ reports: [validReport] }));

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("42");
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("rate-limits per user", async () => {
		await POST(request({ reports: [validReport] }));
		expect(mocks.checkRateLimit).toHaveBeenCalledWith(
			"client-errors:user_1",
			30,
			60_000,
		);
	});

	it("logs each report and returns 204 on a valid batch", async () => {
		const secondReport = {
			procedure: "prompts/catalog/list",
			kind: "error-page" as const,
			status: 502,
			code: "BAD_GATEWAY",
			route: "/app/prompts/:id",
		};

		const res = await POST(
			request({ reports: [validReport, secondReport] }),
		);

		expect(res.status).toBe(204);
		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenNthCalledWith(
			1,
			{ event: "client.rpc_failure", ...validReport },
			expect.any(String),
		);
		expect(logger.warn).toHaveBeenNthCalledWith(
			2,
			{ event: "client.rpc_failure", ...secondReport },
			expect.any(String),
		);
	});
});
