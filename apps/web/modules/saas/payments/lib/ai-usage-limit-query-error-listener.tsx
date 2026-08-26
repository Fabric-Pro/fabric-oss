"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "./ai-usage-limit-toast";

/**
 * Global TanStack Query / Mutation cache listener for the
 * `AI_USAGE_LIMIT_EXCEEDED` error code.
 * Subscribes to the active QueryClient's QueryCache + MutationCache and
 * fires the shared destructive toast for every `query` / `mutation`
 * failure whose error payload matches the AI-usage-limit shape. Renders
 * nothing.
 * Why this lives at the QueryClient layer rather than per-call:
 * - The chokepoint can be hit from any oRPC procedure that resolves an
 * AI model. Trying to wire the toast in every individual hook would
 * miss surfaces (e.g., a query consumed only via `useQuery` with no
 * `onError` callback) and double-fire on others.
 * - One centralized handler matches the contract: "exactly one
 * client-side handler maps the code to the toast across all surfaces".
 * The matching rules:
 * - We accept either the `code === "AI_USAGE_LIMIT_EXCEEDED"` form (oRPC
 * server-side mapper output, see
 * `packages/api/orpc/procedures.ts: domainErrorMapper`) or a raw
 * `AiUsageLimitExceededError`-shaped payload (defence-in-depth so a
 * non-oRPC fetch path that happens to surface the same error class
 * still surfaces the toast).
 * - We extract `error.data` first because that's where the structured
 * payload lives in the oRPC envelope; we fall back to `error` itself
 * so a raw thrown instance (browser fetch interceptor, manual catch
 * block) is also handled.
 * Place once, inside the `<QueryClientProvider>` subtree (see
 * `apps/web/modules/shared/components/ApiClientProvider.tsx`). Mounting
 * multiple instances is a no-op aside from extra subscription churn.
 */
export function AiUsageLimitQueryErrorListener(): null {
	const queryClient = useQueryClient();
	const showToast = useShowAiUsageLimitToast();

	useEffect(() => {
		const matchAndToast = (error: unknown) => {
			// oRPC envelope: { code, status, message, data: {.. } }.
			// Manual throws: a plain `AiUsageLimitExceededError` instance.
			const code = (error as { code?: unknown } | undefined)?.code;
			const data = (error as { data?: unknown } | undefined)?.data;

			if (code === "AI_USAGE_LIMIT_EXCEEDED") {
				if (isAiUsageLimitExceededPayload(data)) {
					showToast(data);
					return;
				}
				// Fallback: code matches but data shape is unexpected.
				// `error` itself sometimes carries the structured fields
				// at the top level (manual throws of the lib's class) so
				// try that as a defence-in-depth before giving up.
				if (isAiUsageLimitExceededPayload(error)) {
					showToast(error);
				}
				return;
			}

			// Defence-in-depth: bare `AiUsageLimitExceededError` instance
			// thrown straight from a non-oRPC catch site.
			if (isAiUsageLimitExceededPayload(error)) {
				showToast(error);
			}
		};

		const unsubscribeQueries = queryClient
			.getQueryCache()
			.subscribe((event) => {
				if (event.type === "updated" && event.action.type === "error") {
					matchAndToast(event.action.error);
				}
			});

		const unsubscribeMutations = queryClient
			.getMutationCache()
			.subscribe((event) => {
				if (event.type === "updated" && event.action.type === "error") {
					matchAndToast(event.action.error);
				}
			});

		return () => {
			unsubscribeQueries();
			unsubscribeMutations();
		};
	}, [queryClient, showToast]);

	return null;
}
