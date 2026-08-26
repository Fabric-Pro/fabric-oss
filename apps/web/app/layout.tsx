import { Document } from "@shared/components/Document";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import type { PropsWithChildren } from "react";
import "./globals.css";
import "cropperjs/dist/cropper.css";
// Eager-load the notification-service so its
// `setAiUsageThresholdNotifier(fanOut.aiUsageThreshold)` self-registration
// runs at app boot. Without this, the very first AI call after server start
// could race against lazy loading and silently drop the threshold fan-out
// (counters still increment, log still fires, but no email/inbox dispatch).
import "@repo/api/lib/notification-service";
import { config } from "@repo/config";

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
	const locale = await getLocale();
	return <Document locale={locale}>{children}</Document>;
}
