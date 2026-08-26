import { ClientProviders } from "@shared/components/ClientProviders";
import { ConsentProvider } from "@shared/components/ConsentProvider";
import {
	CONSENT_COOKIE_NAME,
	CONSENT_PREFERENCES_COOKIE_NAME,
	FABRIC_ANALYTICS_CONSENT_COOKIE_NAME,
} from "@shared/lib/consent";
import { cn } from "@ui/lib";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { PropsWithChildren } from "react";

const sansFont = Inter({
	weight: ["300", "400", "500", "600", "700"],
	subsets: ["latin"],
	variable: "--font-sans",
	display: "swap",
});

const displayFont = Inter({
	weight: ["300", "400", "500", "600", "700"],
	subsets: ["latin"],
	variable: "--font-display",
	display: "swap",
});

const monoFont = JetBrains_Mono({
	weight: ["400", "500", "600", "700"],
	subsets: ["latin"],
	variable: "--font-mono",
	display: "swap",
});

export async function Document({
	children,
	locale,
}: PropsWithChildren<{ locale: string }>) {
	const cookieStore = await cookies();
	const consentCookie = cookieStore.get(CONSENT_COOKIE_NAME);
	const preferencesCookie = cookieStore.get(CONSENT_PREFERENCES_COOKIE_NAME);
	const fabricAnalyticsConsent = cookieStore.get(
		FABRIC_ANALYTICS_CONSENT_COOKIE_NAME,
	)?.value;
	const initialConsent =
		consentCookie?.value ??
		(fabricAnalyticsConsent === "granted"
			? "customized"
			: fabricAnalyticsConsent === "denied"
				? "declined"
				: undefined);
	const initialPreferences =
		preferencesCookie?.value ??
		(fabricAnalyticsConsent === "granted"
			? JSON.stringify({ analytics: true, marketing: false })
			: fabricAnalyticsConsent === "denied"
				? JSON.stringify({ analytics: false, marketing: false })
				: undefined);
	const headersList = await headers();
	const isEmbed = headersList.get("x-embed-route") === "1";

	return (
		<html
			lang={locale}
			suppressHydrationWarning
			className={cn(
				sansFont.variable,
				displayFont.variable,
				monoFont.variable,
				"overflow-x-hidden",
			)}
		>
			<body
				className={cn(
					"min-h-screen bg-background text-foreground antialiased font-sans overflow-x-clip",
				)}
			>
				<NuqsAdapter>
					<ConsentProvider
						initialConsent={initialConsent}
						initialPreferences={initialPreferences}
						isEmbed={isEmbed}
					>
						<ClientProviders isEmbed={isEmbed}>
							{children}
						</ClientProviders>
					</ConsentProvider>
				</NuqsAdapter>
			</body>
		</html>
	);
}
