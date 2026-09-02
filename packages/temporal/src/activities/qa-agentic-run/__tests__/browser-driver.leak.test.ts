/**
 * `openBrowser` must not orphan a browser it already launched.
 *
 * The caller does the right thing —
 * `try { runner = await openBrowser() } finally { if (runner) closeBrowser(runner) }`
 * — and that is exactly why this needs its own test: when `newContext` or
 * `newPage` throws, `openBrowser` never RETURNS, so `runner` is still null and
 * the finally has nothing to close. The browser that did launch stays alive
 * until its process ends, and retries repeat that condition.
 *
 * Context and page creation are fallible after the browser process exists, so
 * both paths must close the process before propagating the original error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const close = vi.fn(async () => {});
const newContext = vi.fn();
const newPage = vi.fn();
const route = vi.fn(async (_pattern: string, _handler: unknown) => {});
const addCookies = vi.fn(async (_cookies: unknown[]) => {});
const launch = vi.fn(async () => ({ close, newContext }));
const safeFetchOutbound = vi.fn();

vi.mock("playwright", () => ({
	chromium: { launch: (...a: unknown[]) => launch(...(a as [])) },
	firefox: { launch: (...a: unknown[]) => launch(...(a as [])) },
	webkit: { launch: (...a: unknown[]) => launch(...(a as [])) },
}));
vi.mock("@repo/utils/url-security", () => ({
	safeFetchOutbound: (...args: unknown[]) => safeFetchOutbound(...args),
}));

import { openBrowser } from "../browser-driver";

const OPTIONS = {
	browser: "chromium",
	resolution: "1920x1080",
	timeoutMs: 30_000,
	targetOrigin: "https://example.com",
};

beforeEach(() => {
	vi.clearAllMocks();
	newPage.mockResolvedValue({ setDefaultTimeout: vi.fn() });
	newContext.mockResolvedValue({ addCookies, newPage, route });
	safeFetchOutbound.mockResolvedValue(
		new Response("ok", {
			status: 200,
			headers: { "content-type": "text/plain" },
		}),
	);
});

describe("openBrowser cleans up after itself", () => {
	it("closes the browser when creating the context fails", async () => {
		newContext.mockRejectedValueOnce(new Error("Invalid header name"));

		await expect(openBrowser(OPTIONS)).rejects.toThrow(
			"Invalid header name",
		);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes the browser when opening the page fails", async () => {
		newPage.mockRejectedValueOnce(new Error("Target closed"));

		await expect(openBrowser(OPTIONS)).rejects.toThrow("Target closed");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes the browser when request containment cannot be installed", async () => {
		route.mockRejectedValueOnce(new Error("route setup failed"));

		await expect(openBrowser(OPTIONS)).rejects.toThrow(
			"route setup failed",
		);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("propagates the ORIGINAL failure, not a close failure", async () => {
		// The caller needs to know why the browser could not be prepared. A
		// secondary failure while tidying up must not overwrite that.
		newContext.mockRejectedValueOnce(new Error("Invalid header name"));
		close.mockRejectedValueOnce(new Error("browser already gone"));

		await expect(openBrowser(OPTIONS)).rejects.toThrow(
			"Invalid header name",
		);
	});

	it("does not close the browser on the success path", async () => {
		// The runner needs it alive; closing here would be the opposite bug.
		const runner = await openBrowser(OPTIONS);

		expect(close).not.toHaveBeenCalled();
		expect(runner.page).toBeDefined();
	});

	it("aborts off-origin requests before network access", async () => {
		await openBrowser({
			...OPTIONS,
			scopedHTTPHeaders: {
				origin: "https://example.com",
				headers: { Authorization: "Bearer secret" },
			},
		});
		const handler = route.mock.calls[0]?.[1] as
			| ((routeValue: {
					request: () => { url: () => string };
					abort: (reason: string) => Promise<void>;
			  }) => Promise<void>)
			| undefined;
		const abort = vi.fn(async () => {});

		await handler?.({
			request: () => ({ url: () => "https://evil.test/collect" }),
			abort,
		});

		expect(abort).toHaveBeenCalledWith("blockedbyclient");
		expect(safeFetchOutbound).not.toHaveBeenCalled();
	});

	it("routes target-origin traffic through the DNS-pinned safe fetch", async () => {
		await openBrowser({
			...OPTIONS,
			scopedHTTPHeaders: {
				origin: "https://example.com",
				headers: { Authorization: "Bearer secret" },
			},
		});
		const handler = route.mock.calls[0]?.[1] as
			| ((routeValue: {
					request: () => {
						url: () => string;
						method: () => string;
						headers: () => Record<string, string>;
						postData: () => string | null;
					};
					abort: (reason: string) => Promise<void>;
					fulfill: (response: unknown) => Promise<void>;
			  }) => Promise<void>)
			| undefined;
		const fulfill = vi.fn(async () => {});

		await handler?.({
			request: () => ({
				url: () => "https://example.com/api/me",
				method: () => "GET",
				headers: () => ({ accept: "application/json" }),
				postData: () => null,
			}),
			abort: vi.fn(async () => {}),
			fulfill,
		});

		expect(safeFetchOutbound).toHaveBeenCalledWith(
			"https://example.com/api/me",
			expect.objectContaining({
				redirect: "manual",
				headers: expect.objectContaining({
					Authorization: "Bearer secret",
				}),
			}),
		);
		expect(fulfill).toHaveBeenCalledWith(
			expect.objectContaining({ status: 200 }),
		);
	});

	it("installs every Set-Cookie header before fulfilling a proxied response", async () => {
		const responseHeaders = new Headers();
		responseHeaders.append(
			"set-cookie",
			"__Secure-fabric.session_token=token-one; Path=/; HttpOnly; Secure; SameSite=Lax",
		);
		responseHeaders.append(
			"set-cookie",
			"__Secure-fabric.dont_remember=1; Path=/; Secure; SameSite=Lax",
		);
		responseHeaders.append(
			"set-cookie",
			"__Secure-fabric.session_data=data; Path=/; HttpOnly; Secure; SameSite=Lax",
		);
		responseHeaders.append("set-cookie", "scoped=value; Secure");
		responseHeaders.append(
			"set-cookie",
			"network_path=value; Path=//evil.test/session; Secure",
		);
		responseHeaders.append(
			"set-cookie",
			"unrelated_domain=value; Domain=evil.test; Path=/; Secure",
		);
		safeFetchOutbound.mockResolvedValueOnce(
			new Response("ok", { status: 200, headers: responseHeaders }),
		);
		await openBrowser(OPTIONS);
		const handler = route.mock.calls[0]?.[1] as
			| ((routeValue: {
					request: () => {
						url: () => string;
						method: () => string;
						headers: () => Record<string, string>;
						postData: () => string | null;
					};
					abort: (reason: string) => Promise<void>;
					fulfill: (response: unknown) => Promise<void>;
			  }) => Promise<void>)
			| undefined;
		const fulfill = vi.fn(async (_response: unknown) => {});

		await handler?.({
			request: () => ({
				url: () => "https://example.com/api/auth/sign-in/email",
				method: () => "POST",
				headers: () => ({ "content-type": "application/json" }),
				postData: () => "{}",
			}),
			abort: vi.fn(async () => {}),
			fulfill,
		});

		expect(addCookies).toHaveBeenCalledTimes(1);
		expect(addCookies).toHaveBeenCalledWith([
			expect.objectContaining({
				name: "__Secure-fabric.session_token",
				value: "token-one",
				domain: "example.com",
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
			}),
			expect.objectContaining({
				name: "__Secure-fabric.dont_remember",
				value: "1",
				domain: "example.com",
				path: "/",
				secure: true,
				sameSite: "Lax",
			}),
			expect.objectContaining({
				name: "__Secure-fabric.session_data",
				value: "data",
				domain: "example.com",
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
			}),
			expect.objectContaining({
				name: "scoped",
				value: "value",
				domain: "example.com",
				path: "/api/auth/sign-in",
			}),
			expect.objectContaining({
				name: "network_path",
				value: "value",
				domain: "example.com",
				path: "//evil.test/session",
			}),
		]);
		expect(addCookies.mock.invocationCallOrder[0]).toBeLessThan(
			fulfill.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		const fulfilledHeaders = fulfill.mock.calls[0]?.[0] as
			| { headers?: Record<string, string> }
			| undefined;
		expect(fulfilledHeaders?.headers).not.toHaveProperty("set-cookie");
	});
});
