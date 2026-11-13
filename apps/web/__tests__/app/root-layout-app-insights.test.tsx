/**
 * The root layout starts App Insights log forwarding only after the response
 * has been sent. Building the client costs 0.4-0.8 s of synchronous start-up,
 * which a cold page used to wait for when the layout module loaded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const afterCallbacks: Array<() => void> = [];
	return { startWebAppInsights: vi.fn(), afterCallbacks };
});

vi.mock("@shared/lib/web-app-insights", () => ({
	startWebAppInsights: mocks.startWebAppInsights,
}));
vi.mock("next/server", () => ({
	after: (callback: () => void) => mocks.afterCallbacks.push(callback),
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
vi.mock("@shared/components/Document", () => ({
	Document: ({ children }: { children: unknown }) => children,
}));
vi.mock("@saas/shared/lib/catalog-request-timing", () => ({
	measureCatalogRequestPhase: (_phase: string, run: () => unknown) => run(),
}));
vi.mock("../../app/globals.css", () => ({}));
vi.mock("../../app/register-ai-usage-threshold-notifier", () => ({}));

describe("root layout App Insights start", () => {
	beforeEach(() => {
		mocks.startWebAppInsights.mockClear();
		mocks.afterCallbacks.length = 0;
	});

	it("does not start App Insights when the layout module loads", async () => {
		// Act
		await import("../../app/layout");

		// Assert
		expect(mocks.startWebAppInsights).not.toHaveBeenCalled();
	});

	it("starts App Insights after the response", async () => {
		// Arrange
		const { default: RootLayout } = await import("../../app/layout");

		// Act
		await RootLayout({ children: null });

		// Assert
		expect(mocks.startWebAppInsights).not.toHaveBeenCalled();
		expect(mocks.afterCallbacks).toContain(mocks.startWebAppInsights);
		for (const callback of mocks.afterCallbacks) {
			callback();
		}
		expect(mocks.startWebAppInsights).toHaveBeenCalledOnce();
	});
});
