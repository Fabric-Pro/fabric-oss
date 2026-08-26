import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import type { PropsWithChildren } from "react";

// Public route — lives OUTSIDE the (saas) layout so unauthenticated recipients
// can reach the unsubscribe confirm without being redirected to /auth/login.
export default async function UnsubscribeLayout({
	children,
}: PropsWithChildren) {
	const [messages, locale] = await Promise.all([getMessages(), getLocale()]);
	return (
		<NextIntlClientProvider locale={locale} messages={messages}>
			<div className="mx-auto max-w-md p-10">{children}</div>
		</NextIntlClientProvider>
	);
}
