import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const consent = vi.hoisted(() => ({
	hasResponded: true,
	preferences: { analytics: true },
}));

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
	ThemeProvider: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@ui/components/toast", () => ({ Toaster: () => null }));
vi.mock("@repo/config", () => ({
	config: { ui: { defaultTheme: "light", enabledThemes: ["light", "dark"] } },
}));
vi.mock("@shared/hooks/cookie-consent", () => ({
	useCookieConsent: () => consent,
}));

import { ClientProviders } from "./ClientProviders";

describe("ClientProviders analytics gating", () => {
	beforeEach(() => {
		consent.hasResponded = true;
		consent.preferences.analytics = true;
	});

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
