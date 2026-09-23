/**
 * Shared doubles for the AI-recommended lifecycle suites (Fizzy #2211): the
 * four `projects.aiRecommended` procedures as spies, `orpc-query-utils`
 * answering any path with keys the tests can match, and the real English
 * translator (each suite also re-mocks `next-intl` to its actual module).
 */

import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { vi } from "vitest";

export const aiApi = {
	protect: vi.fn(),
	listBatches: vi.fn(),
	previewBatch: vi.fn(),
	removeBatch: vi.fn(),
};

const QUERY_PROCEDURES: Record<string, (input: unknown) => unknown> = {
	"projects.aiRecommended.listBatches": (input) => aiApi.listBatches(input),
	"projects.aiRecommended.previewBatch": (input) => aiApi.previewBatch(input),
};

type AnyRecord = Record<string, unknown>;

function makeNode(path: string[]): AnyRecord {
	return new Proxy(
		{},
		{
			get(_target, prop: string | symbol) {
				if (typeof prop !== "string") {
					return undefined;
				}
				const name = path.join(".");
				if (prop === "key") {
					return () => [name];
				}
				if (prop === "queryOptions") {
					return (options?: { input?: unknown }) => ({
						queryKey: [name, options?.input ?? {}],
						queryFn: async () =>
							QUERY_PROCEDURES[name]?.(options?.input) ?? null,
					});
				}
				return makeNode([...path, prop]);
			},
		},
	);
}

export function orpcQueryUtilsMock() {
	return { orpc: makeNode([]) };
}

export function orpcClientMock() {
	return {
		orpcClient: {
			projects: {
				aiRecommended: {
					protect: (input: unknown) => aiApi.protect(input),
					removeBatch: (input: unknown) => aiApi.removeBatch(input),
				},
			},
		},
	};
}

export function renderable(ui: ReactNode, queryClient?: QueryClient) {
	const client =
		queryClient ??
		new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={client}>
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				{ui}
			</NextIntlClientProvider>
		</QueryClientProvider>
	);
}
