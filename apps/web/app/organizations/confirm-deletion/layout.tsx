import { SessionProvider } from "@saas/auth/components/SessionProvider";
import { AuthWrapper } from "@saas/shared/components/AuthWrapper";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import type { PropsWithChildren } from "react";

/**
 * The emailed deletion link lands here, so this page sits OUTSIDE the `(saas)`
 * route group on purpose (Fizzy #2462).
 *
 * `(saas)/layout.tsx` redirects a visitor with no session to a bare
 * `/auth/login`, which discards the `?token=` the link carries — and it runs
 * before the page, so the page's own redirect (which preserves the token) could
 * never fire. Someone opening the link on a device they are not signed in on
 * could therefore never confirm a deletion.
 *
 * This mirrors `organization-invitation/[invitationId]/layout.tsx`: every other
 * emailed landing page (`project-invitation`, `unsubscribe`,
 * `newsletter/confirm`) is top-level for the same reason. The query client is
 * provided globally by the root layout, so only intl and session are needed here.
 */
export default async function ConfirmOrganizationDeletionLayout({
	children,
}: PropsWithChildren) {
	const [messages, locale] = await Promise.all([getMessages(), getLocale()]);

	return (
		<NextIntlClientProvider locale={locale} messages={messages}>
			<SessionProvider>
				<AuthWrapper>{children}</AuthWrapper>
			</SessionProvider>
		</NextIntlClientProvider>
	);
}
