import { Footer } from "@marketing/shared/components/Footer";
import { NavBar } from "@marketing/shared/components/NavBar";
import { config } from "@repo/config";
import { SessionProvider } from "@saas/auth/components/SessionProvider";
import { NextProvider as FumadocsNextProvider } from "fumadocs-core/framework/next";
import { RootProvider as FumadocsRootProvider } from "fumadocs-ui/provider/next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import type { PropsWithChildren } from "react";

const locales = Object.keys(config.i18n.locales);

export function generateStaticParams() {
	return locales.map((locale) => ({ locale }));
}

export default async function MarketingLayout({
	children,
	params,
}: PropsWithChildren<{ params: Promise<{ locale: string }> }>) {
	const { locale } = await params;

	setRequestLocale(locale);

	if (!locales.includes(locale as any)) {
		notFound();
	}

	const messages = await getMessages();

	return (
		<FumadocsNextProvider>
			<FumadocsRootProvider
				search={{
					enabled: true,
					options: {
						api: "/api/docs-search",
					},
				}}
				i18n={{
					locale,
				}}
				// Fumadocs ships its own next-themes provider defaulting to
				// "system" under the storage key "theme". It is inert only while
				// fumadocs-ui and apps/web resolve to one physical copy of
				// next-themes, because a nested provider that sees an outer one
				// through the shared context collapses to a pass-through. A
				// version bump that installs a second copy would break that
				// context match and hand the whole marketing subtree back to the
				// OS preference under a key nothing else reads. Disabling it
				// outright makes ClientProviders the only theme *writer* by
				// declaration rather than by dependency resolution.
				//
				// It does not give fumadocs' own readers a fallback: under that
				// same second-copy scenario its components would call useTheme
				// against the duplicate and get next-themes' no-op default
				// context. Nothing depends on that today — the docs layout
				// already passes themeSwitch={{ enabled: false }}, and the
				// navbar supplies Fabric's own control.
				//
				// Pinned by apps/web/__tests__/default-theme.test.ts.
				theme={{
					enabled: false,
				}}
			>
				<NextIntlClientProvider locale={locale} messages={messages}>
					<SessionProvider>
						<NavBar />
						<main className="min-h-screen">{children}</main>
						<Footer />
					</SessionProvider>
				</NextIntlClientProvider>
			</FumadocsRootProvider>
		</FumadocsNextProvider>
	);
}
