import { afterEach, describe, expect, it, vi } from "vitest";
import {
	handleGuardedRoute,
	type OutboundRefusalCode,
} from "../src/activities/browser-automation/url-guard";
import { refusalKindForGuardCode } from "../src/activities/qa-agentic-run/browser-driver";

type Route = Parameters<typeof handleGuardedRoute>[0];
const origin = "https://app.example.com";
function route(url: string, method = "GET", navigation = true): Route {
	return {
		request: () => ({
			url: () => url,
			method: () => method,
			resourceType: () => (navigation ? "document" : "script"),
			isNavigationRequest: () => navigation,
			frame: () => ({ parentFrame: () => null }),
			allHeaders: async () => ({}),
			postDataBuffer: () => null,
		}),
		abort: vi.fn(async () => {}),
		fallback: vi.fn(async () => {}),
		fulfill: vi.fn(async () => {}),
	};
}
afterEach(() => vi.restoreAllMocks());

describe("unsupported 3xx responses", () => {
	it.each([300, 304, 305, 306, 399])(
		"never fulfills HTTP %s for navigation or subresources",
		async (status) => {
			for (const navigation of [true, false]) {
				const request = route(`${origin}/`, "GET", navigation);
				const blocked = vi.fn();
				await handleGuardedRoute(
					request,
					async () => new Response(null, { status }),
					{ allowedOrigin: origin, onBlocked: blocked },
				);
				expect(request.fulfill).not.toHaveBeenCalled();
				expect(request.abort).toHaveBeenCalledWith("failed");
				expect(blocked).toHaveBeenCalledWith(
					expect.objectContaining({
						code: "unsupported-response",
						isNavigation: navigation,
					}),
				);
			}
		},
	);
	it("refuses a bodyless 304 reached after a screened subresource redirect", async () => {
		const request = route(`${origin}/asset.js`, "GET", false);
		const blocked = vi.fn();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "/cached.js" },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 304 }));
		await handleGuardedRoute(request, fetch, {
			allowedOrigin: origin,
			onBlocked: blocked,
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(request.fulfill).not.toHaveBeenCalled();
		expect(request.abort).toHaveBeenCalledWith("failed");
		expect(blocked).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "unsupported-response",
				url: `${origin}/cached.js`,
				isNavigation: false,
			}),
		);
	});
});

describe("relay error log privacy", () => {
	const secretUrl =
		"https://user:fixture-secret@app.example.com/auth?code=fixture-token#fixture-fragment";
	it.each([
		() => new TypeError(`Cannot construct ${secretUrl}`),
		() => Object.assign(new TypeError(secretUrl), { name: secretUrl }),
		() =>
			Object.assign(new Error(secretUrl), {
				code: `EFAIL\n${secretUrl}`,
			}),
		() =>
			Object.assign(new Error(secretUrl), {
				code: "UNSAFE_OUTBOUND_URL",
			}),
		() => new DOMException(secretUrl, secretUrl),
		() => secretUrl,
	])(
		"keeps credential-bearing error fields out of warnings: %#",
		async (failure) => {
			const warning = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});
			const request = route(secretUrl);
			await handleGuardedRoute(
				request,
				async () => {
					throw failure();
				},
				{ allowedOrigin: origin },
			);
			const output = warning.mock.calls.flat().map(String).join("\n");
			expect(output).toContain(`${origin}/auth`);
			expect(output).not.toContain("fixture-secret");
			expect(output).not.toContain("fixture-token");
			expect(output).not.toContain("fixture-fragment");
			expect(request.abort).toHaveBeenCalledOnce();
		},
	);
});

describe("typed guard refusal diagnostics", () => {
	it.each([
		["off-origin", "off-origin"],
		["destination-refused", "unsafe-address"],
		["invalid-url", "fetch-failed"],
		["unsupported-scheme", "fetch-failed"],
		["unsupported-response", "fetch-failed"],
		["missing-location", "fetch-failed"],
		["redirect-replay", "fetch-failed"],
		["redirect-limit", "fetch-failed"],
		["direct-connection", "fetch-failed"],
	] satisfies [OutboundRefusalCode, string][])(
		"maps %s independently of explanatory text",
		(code, kind) => {
			expect(refusalKindForGuardCode(code)).toBe(kind);
		},
	);
	it.each([
		["off-origin", "https://other.example.com/", 200, null, "GET"],
		["invalid-url", "not a URL", 200, null, "GET"],
		["unsupported-scheme", `${origin}/`, 302, "javascript:alert(1)", "GET"],
		["missing-location", `${origin}/`, 302, null, "GET"],
		["redirect-replay", `${origin}/`, 307, "/next", "POST"],
	] satisfies [OutboundRefusalCode, string, number, string | null, string][])(
		"reports %s from the real route handler",
		async (code, url, status, location, method) => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const blocked = vi.fn();
			const headers = location ? { location } : undefined;
			await handleGuardedRoute(
				route(url, method),
				async () => new Response(null, { status, headers }),
				{
					allowedOrigin: origin,
					onBlocked: blocked,
				},
			);
			expect(blocked).toHaveBeenCalledWith(
				expect.objectContaining({ code, isNavigation: true }),
			);
		},
	);
});
