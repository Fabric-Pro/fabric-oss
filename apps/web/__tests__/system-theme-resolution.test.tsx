/**
 * Proves the app *follows* the system preference, not merely that the config
 * says "system".
 *
 * Two guards already surround this value and neither can make this assertion.
 * `apps/web/__tests__/default-theme.test.ts` pins the configured literal, and
 * `apps/web/modules/shared/components/ClientProviders.test.tsx` replaces
 * `next-themes` with a spy to prove the provider forwards config rather than
 * hardcoding it. Both stay green if `"system"` is configured, forwarded, and
 * then not honoured — because neither ever lets the library resolve anything.
 * So this file deliberately does NOT mock `next-themes` and does NOT mock
 * `@repo/config`: it renders the real provider against the real shipped
 * configuration and asserts the class that actually lands on `<html>`.
 *
 * Only the providers that have nothing to do with theming are mocked — the
 * analytics scripts, the API client, and the progress bar would otherwise drag
 * network and router concerns into a test about a CSS class.
 *
 * Scope caveat, stated rather than implied: jsdom does not execute a script
 * inserted through `dangerouslySetInnerHTML`, which is how `next-themes`
 * delivers its pre-hydration resolver. What runs here is the provider's mount
 * effect, which applies the same resolution one paint later. This file
 * therefore proves *which theme is chosen*, not that it is chosen before first
 * paint. The no-flash property belongs to the inline script and is verified in
 * a real browser, not here.
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@analytics", () => ({
	AnalyticsScript: () => null,
}));
vi.mock("@vercel/speed-insights/next", () => ({
	SpeedInsights: () => null,
}));
vi.mock("@shared/components/ApiClientProvider", () => ({
	ApiClientProvider: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@bprogress/next/app", () => ({
	ProgressProvider: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@ui/components/toast", () => ({ Toaster: () => null }));
vi.mock("@shared/hooks/cookie-consent", () => ({
	useCookieConsent: () => ({
		hasResponded: false,
		preferences: { analytics: false },
	}),
}));

import { ClientProviders } from "@shared/components/ClientProviders";

const STORAGE_KEY = "fabric-theme";

/**
 * Replaces the suite-wide `matchMedia` stub (which always reports no match)
 * with one that answers the single query `next-themes` asks. `addListener` and
 * `removeListener` are the deprecated pair the library still calls; omitting
 * them throws on mount.
 */
function setSystemPrefersDark(prefersDark: boolean) {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: query === "(prefers-color-scheme: dark)" && prefersDark,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
	window.localStorage.clear();
	document.documentElement.className = "";
	document.documentElement.style.colorScheme = "";
});

describe("theme resolution for a browser with no stored preference", () => {
	it("renders dark when the operating system asks for dark", () => {
		setSystemPrefersDark(true);

		render(<ClientProviders>x</ClientProviders>);

		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(document.documentElement.style.colorScheme).toBe("dark");
	});

	it("renders light when the operating system asks for light", () => {
		setSystemPrefersDark(false);

		render(<ClientProviders>x</ClientProviders>);

		expect(document.documentElement.classList.contains("light")).toBe(true);
		expect(document.documentElement.classList.contains("dark")).toBe(false);
		expect(document.documentElement.style.colorScheme).toBe("light");
	});

	it("does not persist the theme it merely inferred", () => {
		setSystemPrefersDark(true);

		render(<ClientProviders>x</ClientProviders>);

		// Nothing was chosen, so nothing is stored — which is what keeps a
		// later change of operating-system preference (or of this default)
		// reaching the same browser again.
		expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
	});
});

describe("theme resolution for a browser with a stored preference", () => {
	it("keeps an explicit light choice on a dark operating system", () => {
		window.localStorage.setItem(STORAGE_KEY, "light");
		setSystemPrefersDark(true);

		render(<ClientProviders>x</ClientProviders>);

		expect(document.documentElement.classList.contains("light")).toBe(true);
		expect(document.documentElement.classList.contains("dark")).toBe(false);
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe("light");
	});

	it("keeps an explicit dark choice on a light operating system", () => {
		window.localStorage.setItem(STORAGE_KEY, "dark");
		setSystemPrefersDark(false);

		render(<ClientProviders>x</ClientProviders>);

		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
	});
});
