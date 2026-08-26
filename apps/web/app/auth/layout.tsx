import { SessionProvider } from "@saas/auth/components/SessionProvider";
import { AuthWrapper } from "@saas/shared/components/AuthWrapper";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import type { PropsWithChildren } from "react";

export default async function AuthLayout({ children }: PropsWithChildren) {
	const [messages, locale] = await Promise.all([getMessages(), getLocale()]);

	return (
		<NextIntlClientProvider locale={locale} messages={messages}>
			<SessionProvider>
				<AuthWrapper>{children}</AuthWrapper>
			</SessionProvider>
		</NextIntlClientProvider>
	);
}
