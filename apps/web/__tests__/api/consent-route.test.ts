/**
 * `/api/consent` — the no-JavaScript path for the privacy banner.
 *
 * The banner's buttons are a real form submit. When the client bundle never
 * hydrates (blocked script, extension interference, a crashed provider), the
 * browser posts the form natively and this route records the decision, so the
 * banner is dismissible with no working client-side JavaScript at all.
 */

import { describe, expect, it } from "vitest";
import { POST } from "../../app/api/consent/route";

function consentRequest(
	body: Record<string, string>,
	init: {
		referer?: string;
		host?: string;
		proto?: string;
		origin?: string;
	} = {},
) {
	const form = new FormData();
	for (const [key, value] of Object.entries(body)) {
		form.append(key, value);
	}

	const headers = new Headers();
	headers.set("host", init.host ?? "staging.fabric.pro");
	if (init.referer) {
		headers.set("referer", init.referer);
	}
	if (init.proto) {
		headers.set("x-forwarded-proto", init.proto);
	}
	if (init.origin) {
		headers.set("origin", init.origin);
	}

	return new Request("https://staging.fabric.pro/api/consent", {
		method: "POST",
		body: form,
		headers,
	});
}

function setCookies(response: Response) {
	const raw = response.headers.getSetCookie?.() ?? [];
	return Object.fromEntries(
		raw.map((entry) => {
			const [pair] = entry.split(";");
			const separator = pair.indexOf("=");
			return [
				pair.slice(0, separator),
				decodeURIComponent(pair.slice(separator + 1)),
			];
		}),
	) as Record<string, string>;
}

describe("POST /api/consent", () => {
	it("records an analytics opt-in and redirects back to the page", async () => {
		const response = await POST(
			consentRequest({ decision: "analytics", returnTo: "/docs" }),
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(
			"https://staging.fabric.pro/docs",
		);

		const cookies = setCookies(response);
		expect(cookies.cookie_consent).toBe("customized");
		expect(JSON.parse(cookies.cookie_preferences)).toEqual({
			essential: true,
			analytics: true,
			marketing: false,
		});
		expect(cookies.fabric_analytics_consent).toBe("granted");
	});

	it("records a decline with every optional category denied", async () => {
		const response = await POST(
			consentRequest({ decision: "decline", returnTo: "/" }),
		);

		const cookies = setCookies(response);
		expect(cookies.cookie_consent).toBe("declined");
		expect(JSON.parse(cookies.cookie_preferences)).toEqual({
			essential: true,
			analytics: false,
			marketing: false,
		});
		expect(cookies.fabric_analytics_consent).toBe("denied");
	});

	it("scopes the cookies to the shared Fabric domain", async () => {
		const response = await POST(
			consentRequest(
				{ decision: "decline" },
				{ host: "docs.fabric.pro" },
			),
		);

		const raw = response.headers.getSetCookie();
		expect(raw.every((entry) => entry.includes("Domain=.fabric.pro"))).toBe(
			true,
		);
		expect(raw.every((entry) => entry.includes("Path=/"))).toBe(true);
		expect(raw.every((entry) => entry.includes("Max-Age=31536000"))).toBe(
			true,
		);
	});

	it("falls back to the referring page when no returnTo is posted", async () => {
		const response = await POST(
			consentRequest(
				{ decision: "decline" },
				{ referer: "https://staging.fabric.pro/blog?page=2" },
			),
		);

		expect(response.headers.get("location")).toBe(
			"https://staging.fabric.pro/blog?page=2",
		);
	});

	it("refuses an off-site redirect target", async () => {
		const response = await POST(
			consentRequest(
				{ decision: "decline", returnTo: "https://evil.example/steal" },
				{ referer: "https://evil.example/steal" },
			),
		);

		expect(response.headers.get("location")).toBe(
			"https://staging.fabric.pro/",
		);
	});

	it("keeps the query string the referring page carried", async () => {
		// usePathname() cannot see the query, so the posted field is only a
		// path; the same-page referer is what still knows about ?page=2.
		const response = await POST(
			consentRequest(
				{ decision: "decline", returnTo: "/en/blog" },
				{ referer: "https://staging.fabric.pro/en/blog?page=2" },
			),
		);

		expect(response.headers.get("location")).toBe(
			"https://staging.fabric.pro/en/blog?page=2",
		);
	});

	it("returns to a locale-prefixed page", async () => {
		const response = await POST(
			consentRequest(
				{ decision: "decline" },
				{ referer: "https://staging.fabric.pro/en/pricing" },
			),
		);

		expect(response.headers.get("location")).toBe(
			"https://staging.fabric.pro/en/pricing",
		);
	});

	it("refuses a redirect target that smuggles an authority past the prefix checks", async () => {
		// URL parsing strips the tab, so this would resolve to
		// https://evil.example/ if only the leading characters were checked.
		const response = await POST(
			consentRequest({
				decision: "decline",
				returnTo: "/\t/evil.example",
			}),
		);

		expect(response.headers.get("location")).toBe(
			"https://staging.fabric.pro/",
		);
	});

	it("sets cookies the client provider can read, over https only", async () => {
		const raw = (
			await POST(consentRequest({ decision: "decline" }))
		).headers.getSetCookie();

		// httpOnly would silently cut the client provider off from its own
		// cookies: it would stop seeing the decision and keep re-asking.
		expect(raw.every((entry) => !/httponly/i.test(entry))).toBe(true);
		// Case-insensitive: the attribute value is case-insensitive per
		// RFC 6265bis, and js-cookie writes the same lowercase form.
		expect(raw.every((entry) => /samesite=lax/i.test(entry))).toBe(true);
		expect(raw.every((entry) => /(^|;\s*)secure(;|$)/i.test(entry))).toBe(
			true,
		);
	});

	it("rejects a cross-site post instead of recording consent", async () => {
		// The endpoint takes no session and no token, so without this check any
		// page could silently opt a visitor into analytics they never accepted.
		const response = await POST(
			consentRequest(
				{ decision: "analytics" },
				{ origin: "https://evil.example" },
			),
		);

		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toHaveLength(0);
	});

	it("accepts a same-origin post", async () => {
		const response = await POST(
			consentRequest(
				{ decision: "analytics" },
				{ origin: "https://staging.fabric.pro" },
			),
		);

		expect(response.status).toBe(303);
		expect(setCookies(response).cookie_consent).toBe("customized");
	});
});
