"use client";

import { createQueryClient } from "@shared/lib/query-client";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

let clientQueryClientSingleton: QueryClient;
function getQueryClient() {
	if (typeof window === "undefined") {
		return createQueryClient();
	}

	if (!clientQueryClientSingleton) {
		clientQueryClientSingleton = createQueryClient();
	}

	return clientQueryClientSingleton;
}

export function ApiClientProvider({ children }: PropsWithChildren) {
	const queryClient = getQueryClient();

	return (
		<QueryClientProvider client={queryClient}>
			{/*
			 * Global AI-usage-limit toast listener lives inside the
			 * NextIntlClientProvider tree (in the (saas)/auth/etc.
			 * layouts) because it calls useTranslations; mounting it
			 * here would render outside any i18n provider and crash SSR.
			 * See @saas/payments/lib/ai-usage-limit-query-error-listener.
			 */}
			{children}
		</QueryClientProvider>
	);
}
