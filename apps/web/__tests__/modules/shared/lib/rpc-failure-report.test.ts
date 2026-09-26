/**
 * `queueRpcFailureReport`/`maskRoute` — queuing, dedupe, the 20-per-session
 * cap, and the beacon-first/fetch-fallback flush. Sent always, never gated
 * on consent (see the module's own doc comment for why).
 */

import {
	__flushRpcFailureReportsForTests,
	__resetRpcFailureReportsForTests,
	maskRoute,
	queueRpcFailureReport,
} from "@shared/lib/rpc-failure-report";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("maskRoute", () => {
	it("masks a UUID segment", () => {
		expect(
			maskRoute("/app/projects/8f14e45f-ceea-467e-adde-8c6f2c1c8d3e"),
		).toBe("/app/projects/:id");
	});

	it("masks a prefixed id segment (org_, req_, ...)", () => {
		expect(maskRoute("/app/org_a1b2c3d4e5/settings")).toBe(
			"/app/:id/settings",
		);
	});

	it("masks a bare numeric segment", () => {
		expect(maskRoute("/app/projects/48291/stories/7")).toBe(
			"/app/projects/:id/stories/:id",
		);
	});

	it("masks a long opaque token (this repo's Prisma cuids)", () => {
		expect(maskRoute("/app/prompts/clh3x9k2p0000qzrmn831i7a1")).toBe(
			"/app/prompts/:id",
		);
	});

	it("leaves a human-readable route and an org/project slug alone", () => {
		expect(maskRoute("/app/acme-corp/prompts/catalog")).toBe(
			"/app/acme-corp/prompts/catalog",
		);
	});

	it("leaves the root path alone", () => {
		expect(maskRoute("/")).toBe("/");
	});
});

describe("queueRpcFailureReport", () => {
	let sendBeacon: ReturnType<typeof vi.fn>;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		__resetRpcFailureReportsForTests();
		sendBeacon = vi.fn().mockReturnValue(true);
		Object.defineProperty(navigator, "sendBeacon", {
			value: sendBeacon,
			configurable: true,
		});
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 204 }));
	});

	afterEach(() => {
		__resetRpcFailureReportsForTests();
		fetchSpy.mockRestore();
		// @ts-expect-error — test-only cleanup of the property we defined above.
		delete navigator.sendBeacon;
	});

	it("flushes a queued report via sendBeacon", () => {
		queueRpcFailureReport({
			procedure: "prompts/list",
			kind: "transport",
			route: "/app/prompts",
		});
		__flushRpcFailureReportsForTests();

		expect(sendBeacon).toHaveBeenCalledTimes(1);
		const [url, body] = sendBeacon.mock.calls[0] ?? [];
		expect(url).toBe("/api/client-errors");
		expect(body).toBeInstanceOf(Blob);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("falls back to fetch with keepalive when sendBeacon is unavailable", () => {
		// @ts-expect-error — simulating an environment without the Beacon API.
		delete navigator.sendBeacon;

		queueRpcFailureReport({
			procedure: "prompts/list",
			kind: "transport",
			route: "/app/prompts",
		});
		__flushRpcFailureReportsForTests();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] ?? [];
		expect(url).toBe("/api/client-errors");
		expect(init).toMatchObject({ method: "POST", keepalive: true });
	});

	it("falls back to fetch when sendBeacon reports failure", () => {
		sendBeacon.mockReturnValue(false);

		queueRpcFailureReport({
			procedure: "prompts/list",
			kind: "transport",
			route: "/app/prompts",
		});
		__flushRpcFailureReportsForTests();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("does not flush an empty queue", () => {
		__flushRpcFailureReportsForTests();
		expect(sendBeacon).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("batches every queued report into one send", () => {
		queueRpcFailureReport({
			procedure: "a",
			kind: "transport",
			route: "/a",
		});
		queueRpcFailureReport({
			procedure: "b",
			kind: "error-page",
			route: "/b",
			status: 502,
			code: "BAD_GATEWAY",
		});
		__flushRpcFailureReportsForTests();

		expect(sendBeacon).toHaveBeenCalledTimes(1);
	});

	it("dedupes an identical report within the same session", async () => {
		const report = {
			procedure: "prompts/list",
			kind: "transport" as const,
			route: "/app/prompts",
		};
		queueRpcFailureReport(report);
		queueRpcFailureReport(report);
		queueRpcFailureReport({ ...report });
		__flushRpcFailureReportsForTests();

		// One flush call alone does not prove dedup — a single flush call
		// still batches every queued report into one beacon regardless of
		// duplicates, so the actual count inside that one beacon is what
		// matters here.
		expect(sendBeacon).toHaveBeenCalledTimes(1);
		const [, body] = sendBeacon.mock.calls[0] ?? [];
		const parsed = JSON.parse(await (body as Blob).text()) as {
			reports: unknown[];
		};
		expect(parsed.reports).toHaveLength(1);

		__flushRpcFailureReportsForTests();
		expect(sendBeacon).toHaveBeenCalledTimes(1);
	});

	it("treats reports differing only in status/code as distinct", () => {
		queueRpcFailureReport({
			procedure: "prompts/list",
			kind: "error-page",
			route: "/app/prompts",
			status: 502,
			code: "BAD_GATEWAY",
		});
		queueRpcFailureReport({
			procedure: "prompts/list",
			kind: "error-page",
			route: "/app/prompts",
			status: 504,
			code: "GATEWAY_TIMEOUT",
		});
		__flushRpcFailureReportsForTests();

		expect(sendBeacon).toHaveBeenCalledTimes(1);
		const [, body] = sendBeacon.mock.calls[0] ?? [];
		// Confirm the single beacon actually batched both distinct reports
		// (Blob content is read back to check the count, not the shape).
		return (body as Blob).text().then((text) => {
			const parsed = JSON.parse(text) as { reports: unknown[] };
			expect(parsed.reports).toHaveLength(2);
		});
	});

	it("caps at 20 reports per session, dropping the rest silently", () => {
		for (let i = 0; i < 25; i++) {
			queueRpcFailureReport({
				procedure: `proc-${i}`,
				kind: "transport",
				route: `/route-${i}`,
			});
		}
		__flushRpcFailureReportsForTests();

		const [, body] = sendBeacon.mock.calls[0] ?? [];
		return (body as Blob).text().then((text) => {
			const parsed = JSON.parse(text) as { reports: unknown[] };
			expect(parsed.reports).toHaveLength(20);
		});
	});

	it("flushes on pagehide", () => {
		queueRpcFailureReport({
			procedure: "prompts/list",
			kind: "transport",
			route: "/app/prompts",
		});
		window.dispatchEvent(new Event("pagehide"));

		expect(sendBeacon).toHaveBeenCalledTimes(1);
	});

	it("flushes on visibilitychange only when the page becomes hidden", () => {
		queueRpcFailureReport({
			procedure: "prompts/list",
			kind: "transport",
			route: "/app/prompts",
		});

		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));
		expect(sendBeacon).not.toHaveBeenCalled();

		Object.defineProperty(document, "visibilityState", {
			value: "hidden",
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));
		expect(sendBeacon).toHaveBeenCalledTimes(1);
	});

	it("does nothing outside the browser (no window)", () => {
		const originalWindow = globalThis.window;
		// @ts-expect-error — simulating an SSR/non-browser context.
		delete globalThis.window;
		try {
			expect(() =>
				queueRpcFailureReport({
					procedure: "prompts/list",
					kind: "transport",
					route: "/app/prompts",
				}),
			).not.toThrow();
		} finally {
			globalThis.window = originalWindow;
		}
		__flushRpcFailureReportsForTests();
		expect(sendBeacon).not.toHaveBeenCalled();
	});
});
