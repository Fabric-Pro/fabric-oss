"use client";

import { AnalyticsScript } from "@analytics";
import { ProgressProvider } from "@bprogress/next/app";
import { config } from "@repo/config";
import { ApiClientProvider } from "@shared/components/ApiClientProvider";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { shouldLoadAnalytics } from "@shared/lib/should-load-analytics";
import { Toaster } from "@ui/components/toast";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider } from "next-themes";
import type { PropsWithChildren } from "react";

export function ClientProviders({
	children,
	isEmbed = false,
}: PropsWithChildren<{ isEmbed?: boolean }>) {
	const { hasResponded, preferences } = useCookieConsent();
	const loadAnalytics = shouldLoadAnalytics(
		hasResponded && preferences.analytics,
		isEmbed,
	);

	return (
		<ApiClientProvider>
			<ProgressProvider
				height="4px"
				color="var(--color-primary)"
				options={{ showSpinner: false }}
				shallowRouting
				delay={250}
			>
				<ThemeProvider
					attribute="class"
					disableTransitionOnChange
					enableSystem
					defaultTheme={config.ui.defaultTheme}
					themes={config.ui.enabledThemes}
					storageKey="fabric-theme"
				>
					{children}

					<Toaster position="top-right" />
					{loadAnalytics ? <AnalyticsScript /> : null}
					{loadAnalytics ? <SpeedInsights /> : null}
				</ThemeProvider>
			</ProgressProvider>
		</ApiClientProvider>
	);
}
