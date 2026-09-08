import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const consent = vi.hoisted(() => ({
	hasResponded: true,
	preferences: { analytics: true },
}));

/**
 * Captures the props `ThemeProvider` is handed, so the forwarding can be
 * asserted (Fizzy #2359).
 *
 * A spy rather than an accumulating object: `mock.lastCall` scopes each
 * assertion to its own render, so a later test that renders with different
 * theme props cannot leak into this one.
 */
const themeProviderSpy = vi.hoisted(() => vi.fn());

/**
 * Deliberately NOT the shipped configuration. The point of this file is to
 * prove the provider forwards whatever config says — and comparing a forwarded
 * value against the same module it came from cannot do that: replacing
 * `defaultTheme={config.ui.defaultTheme}` with a hardcoded `"light"` would keep
 * both sides equal and the test green. Sentinel values that differ from the
 * shipped ones make that substitution fail. The shipped value itself is pinned
 * separately, against the real module, in `apps/web/__tests__/default-theme.test.ts`.
 */
const SENTINEL_UI = vi.hoisted(
	() =>
		({
			defaultTheme: "dark",
			enabledThemes: ["dark", "light"],
		}) as const,
);

vi.mock("@analytics", () => ({
	AnalyticsScript: () => <div data-testid="analytics" />,
}));
vi.mock("@vercel/speed-insights/next", () => ({
	SpeedInsights: () => <div data-testid="speed-insights" />,
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
vi.mock("next-themes", () => ({
	ThemeProvider: ({
		children,
		...props
	}: { children: React.ReactNode } & Record<string, unknown>) => {
		themeProviderSpy(props);
		return <>{children}</>;
	},
}));
vi.mock("@repo/config", () => ({
	config: { ui: SENTINEL_UI },
}));
vi.mock("@ui/components/toast", () => ({ Toaster: () => null }));
vi.mock("@shared/hooks/cookie-consent", () => ({
	useCookieConsent: () => consent,
}));

import { ClientProviders } from "./ClientProviders";

// File-scoped: the theme-wiring block below renders too, and inheriting
// whatever consent state the last analytics test left would couple the two.
beforeEach(() => {
	consent.hasResponded = true;
	consent.preferences.analytics = true;
	themeProviderSpy.mockClear();
});

describe("ClientProviders analytics gating", () => {
	it("loads analytics on a normal route when consented", () => {
		const { queryByTestId } = render(
			<ClientProviders isEmbed={false}>x</ClientProviders>,
		);
		expect(queryByTestId("analytics")).toBeInTheDocument();
		expect(queryByTestId("speed-insights")).toBeInTheDocument();
	});

	it("suppresses analytics on an embed route even when consented", () => {
		const { queryByTestId } = render(
			<ClientProviders isEmbed>x</ClientProviders>,
		);
		expect(queryByTestId("analytics")).not.toBeInTheDocument();
		expect(queryByTestId("speed-insights")).not.toBeInTheDocument();
	});

	it("does not load analytics before the visitor responds", () => {
		consent.hasResponded = false;
		const { queryByTestId } = render(
			<ClientProviders isEmbed={false}>x</ClientProviders>,
		);
		expect(queryByTestId("analytics")).not.toBeInTheDocument();
		expect(queryByTestId("speed-insights")).not.toBeInTheDocument();
	});
});

describe("ClientProviders theme wiring", () => {
	it("forwards the configured theme values rather than hardcoding them", () => {
		render(<ClientProviders isEmbed={false}>x</ClientProviders>);

		const props = themeProviderSpy.mock.lastCall?.[0];
		expect(props?.defaultTheme).toBe(SENTINEL_UI.defaultTheme);
		expect(props?.themes).toEqual(SENTINEL_UI.enabledThemes);
	});

	it("reads and writes the browser preference under the fabric-theme key", () => {
		render(<ClientProviders isEmbed={false}>x</ClientProviders>);

		// The end-to-end suite seeds this exact literal to force a theme, and a
		// rename would silently move every existing chooser's stored preference
		// out from under them. Nothing else in the suite pins it.
		expect(themeProviderSpy.mock.lastCall?.[0]?.storageKey).toBe(
			"fabric-theme",
		);
	});
});
