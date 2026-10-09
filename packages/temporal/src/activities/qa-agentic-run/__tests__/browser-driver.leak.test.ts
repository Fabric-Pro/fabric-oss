import { beforeEach, describe, expect, it, vi } from "vitest";
import type { handleGuardedRoute } from "../../browser-automation/url-guard";

type Route = Parameters<typeof handleGuardedRoute>[0];
const mocks = vi.hoisted(() => ({
	close: vi.fn(),
	newContext: vi.fn(),
	newPage: vi.fn(),
	route: vi.fn<
		(
			pattern: string,
			handler: (route: Route) => Promise<void>,
		) => Promise<void>
	>(),
	routeWebSocket: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("playwright", () => ({
	chromium: {
		launch: vi.fn(async () => ({
			close: mocks.close,
			newContext: mocks.newContext,
		})),
	},
}));
vi.mock("@repo/utils/url-security", async (original) => ({
	...(await original<typeof import("@repo/utils/url-security")>()),
	safeFetchOutboundPinned: mocks.fetch,
}));

import {
	closeBrowser,
	explainBlockedNavigation,
	openBrowser,
} from "../browser-driver";

const OPTIONS = {
	browser: "chromium",
	resolution: "1920x1080",
	timeoutMs: 30_000,
	targetOrigin: "https://example.com",
};
function request(url = "https://example.com/page", navigation = true): Route {
	return {
		request: () => ({
			url: () => url,
			method: () => "GET",
			resourceType: () => (navigation ? "document" : "font"),
			isNavigationRequest: () => navigation,
			frame: () => ({}),
			allHeaders: async () => ({
				authorization: "old",
				accept: "text/html",
			}),
			postDataBuffer: () => null,
		}),
		abort: vi.fn(),
		fallback: vi.fn(),
		fulfill: vi.fn(),
	};
}
async function handle(route: Route) {
	const handler = mocks.route.mock.calls[0]?.[1];
	if (!handler) {
		throw new Error("No route handler installed");
	}
	await handler(route);
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.close.mockResolvedValue(undefined);
	mocks.newPage.mockResolvedValue({
		setDefaultTimeout: vi.fn(),
		close: vi.fn(),
	});
	mocks.newContext.mockResolvedValue({
		newPage: mocks.newPage,
		route: mocks.route,
		routeWebSocket: mocks.routeWebSocket,
		close: vi.fn(),
	});
	mocks.fetch.mockResolvedValue(new Response("ok"));
});
describe("QA browser containment and cleanup", () => {
	it("does not describe a failed iframe request as a failed page navigation", async () => {
		mocks.fetch.mockRejectedValueOnce(
			Object.assign(new Error("Connection refused"), {
				code: "ECONNREFUSED",
			}),
		);
		const runner = await openBrowser(OPTIONS);
		const route = request();
		const original = route.request();
		route.request = () => ({
			...original,
			frame: () => ({ parentFrame: () => ({}) }),
		});
		await handle(route);
		expect(runner.refusals[0]?.isNavigation).toBe(false);
		expect(explainBlockedNavigation(runner.refusals)).toBeNull();
	});
	it.each(["context", "page", "routes"])(
		"closes the launched browser if %s creation fails",
		async (phase) => {
			const failing =
				phase === "context"
					? mocks.newContext
					: phase === "page"
						? mocks.newPage
						: mocks.route;
			failing.mockRejectedValueOnce(new Error("setup failed"));
			await expect(openBrowser(OPTIONS)).rejects.toThrow("setup failed");
			expect(mocks.close).toHaveBeenCalledTimes(1);
		},
	);
	it("preserves the original setup failure if cleanup also fails", async () => {
		mocks.newContext.mockRejectedValueOnce(new Error("original failure"));
		mocks.close.mockRejectedValueOnce(new Error("close failure"));
		await expect(openBrowser(OPTIONS)).rejects.toThrow("original failure");
	});
	it("blocks service workers and installs a WebSocket guard", async () => {
		await openBrowser(OPTIONS);
		expect(mocks.newContext).toHaveBeenCalledWith(
			expect.objectContaining({ serviceWorkers: "block" }),
		);
		expect(mocks.routeWebSocket).toHaveBeenCalledTimes(1);
		expect(mocks.close).not.toHaveBeenCalled();
	});
	it("refuses off-origin requests without networking or retaining query credentials", async () => {
		const runner = await openBrowser(OPTIONS);
		const route = request(
			"https://sso.example.org/auth?code=secret#token=secret",
		);
		await handle(route);
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(explainBlockedNavigation(runner.refusals)).toContain(
			"check the environment's base URL",
		);
		expect(JSON.stringify(runner.refusals)).not.toContain("secret");
	});
	it.each([
		["ECONNREFUSED", "connection-refused"],
		["ENOTFOUND", "host-not-found"],
		["EAI_AGAIN", "fetch-failed"],
		["CERT_HAS_EXPIRED", "certificate-invalid"],
		["EPROTO", "tls-failed"],
		["UNSAFE_OUTBOUND_URL", "unsafe-address"],
	])("records pinned fetch failure %s as %s", async (code, kind) => {
		mocks.fetch.mockRejectedValueOnce(
			new TypeError("fetch failed", {
				cause: new AggregateError(
					[
						Object.assign(new Error("internal OpenSSL paths"), {
							code,
						}),
					],
					"",
				),
			}),
		);
		const runner = await openBrowser(OPTIONS);
		await handle(request());
		expect(runner.refusals).toEqual([
			expect.objectContaining({ kind, detail: code, isNavigation: true }),
		]);
		expect(explainBlockedNavigation(runner.refusals)).not.toContain(
			"OpenSSL",
		);
	});
	it("scopes headers and replaces names case-insensitively", async () => {
		await openBrowser({
			...OPTIONS,
			scopedHTTPHeaders: {
				origin: OPTIONS.targetOrigin,
				headers: { Authorization: "Bearer fixture" },
			},
		});
		await handle(request());
		expect(mocks.fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: {
					accept: "text/html",
					Authorization: "Bearer fixture",
				},
			}),
			expect.any(Object),
		);
	});
	it("ignores auth headers scoped to another origin", async () => {
		await openBrowser({
			...OPTIONS,
			scopedHTTPHeaders: {
				origin: "https://other.example.com",
				headers: { Authorization: "Bearer fixture" },
			},
		});
		await handle(request());
		expect(mocks.fetch.mock.calls[0]?.[1].headers).toEqual({
			authorization: "old",
			accept: "text/html",
		});
	});
	it("leaves every Set-Cookie to Chromium through fulfillment", async () => {
		const headers = new Headers();
		headers.append("set-cookie", "sid=1; Secure; HttpOnly; Path=/");
		headers.append("set-cookie", "sid=; Max-Age=0; Path=/");
		mocks.fetch.mockResolvedValueOnce(new Response("ok", { headers }));
		await openBrowser(OPTIONS);
		const route = request();
		await handle(route);
		expect(route.fulfill).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({
					"set-cookie":
						"sid=1; Secure; HttpOnly; Path=/\nsid=; Max-Age=0; Path=/",
				}),
			}),
		);
	});
	it("aborts relay work when the case closes or is cancelled", async () => {
		const cancellation = new AbortController();
		const runner = await openBrowser({
			...OPTIONS,
			signal: cancellation.signal,
		});
		await handle(request());
		const signal: AbortSignal = mocks.fetch.mock.calls[0]?.[1].signal;
		expect(signal.aborted).toBe(false);
		cancellation.abort();
		expect(signal.aborted).toBe(true);
		const second = await openBrowser(OPTIONS);
		await closeBrowser(second);
		expect(second.abortController?.signal.aborted).toBe(true);
		await closeBrowser(runner);
	});
	it("records a stalled relay timeout before the page's 30-second timeout", async () => {
		vi.useFakeTimers();
		try {
			const startedAt = Date.now();
			// The route's deadline is the containment boundary. Do not rely on
			// every pinned-fetch implementation respecting the signal it receives.
			mocks.fetch.mockImplementationOnce(
				() => new Promise<Response>(() => {}),
			);
			const runner = await openBrowser(OPTIONS);
			const pending = handle(request());
			await vi.advanceTimersByTimeAsync(25_000);
			await pending;
			expect(runner.refusals).toContainEqual(
				expect.objectContaining({
					kind: "fetch-failed",
					detail: "TIMEOUT: the request timed out",
					isNavigation: true,
				}),
			);
			expect(Date.now() - startedAt).toBe(25_000);
			await closeBrowser(runner);
		} finally {
			vi.useRealTimers();
		}
	});
});
