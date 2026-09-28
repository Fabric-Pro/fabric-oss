import { config } from "@repo/config";
import { measureCatalogRequestPhase } from "@saas/shared/lib/catalog-request-timing";
import { Document } from "@shared/components/Document";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import type { PropsWithChildren } from "react";
import "./globals.css";
import "./register-ai-usage-threshold-notifier";

export const metadata: Metadata = {
	title: {
		absolute: config.appName,
		default: config.appName,
		template: `%s | ${config.appName}`,
	},
	// Search engine verification — replace with real tokens when registered
	// verification: {
	// 	google: "your-google-verification-token",
	// 	yandex: "your-yandex-verification-token",
	// 	other: { "msvalidate.01": "your-bing-verification-token" },
	// },
	icons: {
		icon: [
			{
				url: "/images/favicon.svg",
				type: "image/svg+xml",
			},
			{
				url: "/images/favicon-32x32.png",
				sizes: "32x32",
				type: "image/png",
			},
		],
		apple: "/images/apple-touch-icon.png",
	},
	manifest: "/manifest.json",
	other: {
		"mobile-web-app-capable": "yes",
		"apple-mobile-web-app-capable": "yes",
		"apple-mobile-web-app-status-bar-style": "default",
	},
};

export const viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 5,
};

export default async function RootLayout({ children }: PropsWithChildren) {
	const locale = await measureCatalogRequestPhase("root_locale", getLocale);
	return <Document locale={locale}>{children}</Document>;
}
