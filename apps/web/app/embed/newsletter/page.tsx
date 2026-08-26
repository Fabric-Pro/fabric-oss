import { isPublicNewsletterEnabled } from "@marketing/shared/lib/public-newsletter";
import { NewsletterForm } from "@marketing/shared/components/NewsletterForm";
import { resolveEmbedParams } from "@marketing/shared/lib/embed-params";
import { cn } from "@ui/lib";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { notFound } from "next/navigation";

// Public iframe fragment — keep it out of the index.
export const metadata: Metadata = {
	title: "Subscribe to Fabric Release Notes",
	robots: { index: false, follow: false },
};

export default async function NewsletterEmbedPage({
	searchParams,
}: {
	searchParams: Promise<{ theme?: string }>;
}) {
	// Gate the ROUTE (not just the /release-notes snippet): when Fabric-main is
	// unconfigured the subscribe RPC silently returns { success: true }, so an
	// ungated embed could show fake success and capture nothing. 404 instead.
	if (!isPublicNewsletterEnabled()) {
		notFound();
	}

	const { theme } = resolveEmbedParams(await searchParams);
	const [messages, locale] = await Promise.all([getMessages(), getLocale()]);

	// `dark` on the wrapper scopes the dark CSS variables to the iframe subtree,
	// independent of the html-level next-themes class. `min-h-screen` fills the
	// iframe so the chosen surface paints edge-to-edge.
	return (
		<NextIntlClientProvider locale={locale} messages={messages}>
			<div
				className={cn(
					"min-h-screen bg-background p-4 text-foreground",
					theme === "dark" && "dark",
				)}
			>
				<div className="mx-auto max-w-md">
					<NewsletterForm />
				</div>
			</div>
		</NextIntlClientProvider>
	);
}
