/**
 * Renders under a query client of its own, as the app does. The proposal
 * view reads the merge of a re-routed item through React Query, so it needs
 * one even when no item is re-routed. A rerender keeps the same client.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

export function renderWithQueryClient(ui: ReactElement): RenderResult {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(ui, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		),
	});
}
