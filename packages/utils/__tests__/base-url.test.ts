import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBaseUrl, toAbsoluteUrl } from "../lib/base-url";

/**
 * `getBaseUrl()` precedence: window.location.origin > NEXT_PUBLIC_SITE_URL >
 * APP_URL > NEXT_PUBLIC_VERCEL_URL > http://localhost:${PORT ?? 3000}.
 *
 * Tests pin the worker-env shape (APP_URL set, NEXT_PUBLIC_* unset) — the
 * scenario that previously leaked http://localhost:3000/... URLs into Slack
 * messages from the Temporal worker container before APP_URL was added to the
 * precedence chain.
 */
describe("getBaseUrl()", () => {
	beforeEach(() => {
		// Each test starts from a clean env slate so the precedence chain is
		// exercised explicitly, not implicitly by whatever the worker env
		// happens to leak in. PORT is intentionally not pre-stubbed: the
		// production code uses `?? 3000`, which only kicks in when PORT is
		// undefined — stubbing it to "" would defeat the nullish-coalesce.
		vi.unstubAllEnvs();
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
		vi.stubEnv("APP_URL", "");
		vi.stubEnv("NEXT_PUBLIC_VERCEL_URL", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns https://fabric.pro when APP_URL is set and NEXT_PUBLIC_* URL vars are unset", () => {
		vi.stubEnv("APP_URL", "https://fabric.pro");

		expect(getBaseUrl()).toBe("https://fabric.pro");
	});

	it("prefers NEXT_PUBLIC_SITE_URL over APP_URL when both are set", () => {
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://override.fabric.pro");
		vi.stubEnv("APP_URL", "https://fabric.pro");

		expect(getBaseUrl()).toBe("https://override.fabric.pro");
	});

	it("falls back to NEXT_PUBLIC_VERCEL_URL when SITE_URL and APP_URL are unset", () => {
		vi.stubEnv("NEXT_PUBLIC_VERCEL_URL", "preview-foo.vercel.app");

		expect(getBaseUrl()).toBe("https://preview-foo.vercel.app");
	});

	it("returns http://localhost:3000 when nothing is set", () => {
		expect(getBaseUrl()).toBe("http://localhost:3000");
	});

	it("respects PORT when nothing else is set", () => {
		vi.stubEnv("PORT", "4000");

		expect(getBaseUrl()).toBe("http://localhost:4000");
	});

	it("never returns a localhost URL when APP_URL is set", () => {
		vi.stubEnv("APP_URL", "https://fabric.pro");

		const url = getBaseUrl();

		expect(url).not.toContain("localhost");
		expect(url).not.toContain("127.0.0.1");
	});
});

/**
 * `toAbsoluteUrl()` exists for off-app consumers — email, Slack, webhooks —
 * which get handed the same relative link the in-app inbox uses and have no
 * base to resolve it against. A relative href in an email is simply dead.
 */
describe("toAbsoluteUrl()", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://fabric.pro");
		vi.stubEnv("APP_URL", "");
		vi.stubEnv("NEXT_PUBLIC_VERCEL_URL", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("prefixes a root-relative path with the base URL", () => {
		expect(toAbsoluteUrl("/app/settings/usage?limitId=lim_1")).toBe(
			"https://fabric.pro/app/settings/usage?limitId=lim_1",
		);
	});

	it("inserts the missing separator for a path without a leading slash", () => {
		expect(toAbsoluteUrl("app/settings/usage")).toBe(
			"https://fabric.pro/app/settings/usage",
		);
	});

	it("leaves an already-absolute URL untouched", () => {
		expect(toAbsoluteUrl("https://elsewhere.example/x")).toBe(
			"https://elsewhere.example/x",
		);
		expect(toAbsoluteUrl("HTTP://Elsewhere.example/x")).toBe(
			"HTTP://Elsewhere.example/x",
		);
	});

	it("does not double the slash when the base URL carries a trailing one", () => {
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://fabric.pro/");

		expect(toAbsoluteUrl("/app/settings/usage")).toBe(
			"https://fabric.pro/app/settings/usage",
		);
	});
});
