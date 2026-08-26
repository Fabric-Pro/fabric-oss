import { config } from "@repo/config";
import { SessionProvider } from "@saas/auth/components/SessionProvider";
import { sessionQueryKey } from "@saas/auth/lib/api";
import { getOrganizationList, getSession } from "@saas/auth/lib/server";
import { ActiveOrganizationProvider } from "@saas/organizations/components/ActiveOrganizationProvider";
import { organizationListQueryKey } from "@saas/organizations/lib/api";
import { AiUsageLimitQueryErrorListener } from "@saas/payments/lib/ai-usage-limit-query-error-listener";
import { ConfirmationAlertProvider } from "@saas/shared/components/ConfirmationAlertProvider";
import { CopilotFetchErrorInterceptor } from "@saas/shared/components/copilot/CopilotFetchErrorInterceptor";
import { orpc } from "@shared/lib/orpc-query-utils";
import { getServerQueryClient } from "@shared/lib/server";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import type { PropsWithChildren } from "react";

export default async function SaaSLayout({ children }: PropsWithChildren) {
	const [messages, locale] = await Promise.all([getMessages(), getLocale()]);
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const queryClient = getServerQueryClient();

	// Parallelize independent prefetch queries for better performance
	// See: async-parallel rule from Vercel React Best Practices
	const prefetchPromises: Promise<void>[] = [
		queryClient.prefetchQuery({
			queryKey: sessionQueryKey,
			queryFn: () => session,
		}),
	];

	if (config.organizations.enable) {
		prefetchPromises.push(
			queryClient.prefetchQuery({
				queryKey: organizationListQueryKey,
				queryFn: getOrganizationList,
			}),
		);
	}

	if (config.users.enableBilling) {
		const purchasesQueryOptions = orpc.payments.listPurchases.queryOptions({
			input: {},
		});
		prefetchPromises.push(
			queryClient.prefetchQuery(purchasesQueryOptions).catch((error) => {
				// Don't fail the layout. Drop the failed query from the cache
				// so dehydrate doesn't serialize it to the client (which
				// would surface as "dehydrated as pending ended up rejecting"
				// for any consumer that reads this query key).
				console.warn(
					"[SaaSLayout] Skipping purchases prefetch:",
					error,
				);
				queryClient.removeQueries({
					queryKey: purchasesQueryOptions.queryKey,
				});
			}),
		);
	}

	await Promise.all(prefetchPromises);

	return (
		<NextIntlClientProvider locale={locale} messages={messages}>
			<HydrationBoundary state={dehydrate(queryClient)}>
				<SessionProvider>
					<ActiveOrganizationProvider>
						<ConfirmationAlertProvider>
							<CopilotFetchErrorInterceptor />
							{/*
							 * Global AI-usage-limit toast listener — must
							 * sit inside NextIntlClientProvider because it
							 * calls useTranslations. Subscribes to
							 * QueryCache + MutationCache `error` events
							 * across every oRPC-mediated AI surface
							 */}
							<AiUsageLimitQueryErrorListener />
							{/*
							 * The persistent AI-usage-limit warning banner
							 * is mounted INSIDE `AppWrapper` (modules/saas/
							 * shared/components/AppWrapper.tsx) so it sits
							 * in the sidebar-offset content area instead of
							 * overlapping the fixed NavBar — keep the toast
							 * listener at the layout level (no offset
							 * needed) but the banner lives one layer in.
							 */}
							{children}
						</ConfirmationAlertProvider>
					</ActiveOrganizationProvider>
				</SessionProvider>
			</HydrationBoundary>
		</NextIntlClientProvider>
	);
}
