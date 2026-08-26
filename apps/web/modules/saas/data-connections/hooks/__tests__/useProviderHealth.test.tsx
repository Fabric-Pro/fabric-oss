/**
 * Tests for useProviderHealth.
 *
 * Coverage
 * --------
 * - Returns an empty lookup when the query has not resolved.
 * - Builds a `byProviderKey` map keyed by the registry key.
 * - When `enabled: false`, the underlying oRPC call is skipped.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		integrationHealth: {
			listProviderHealth: vi.fn(),
		},
	},
}));

import { orpcClient } from "@shared/lib/orpc-client";
import { useProviderHealth } from "../useProviderHealth";

const listProviderHealthMock = orpcClient.integrationHealth
	.listProviderHealth as unknown as ReturnType<typeof vi.fn>;

function wrapper(props: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
	return (
		<QueryClientProvider client={client}>
			{props.children}
		</QueryClientProvider>
	);
}

describe("useProviderHealth", () => {
	it("returns an empty lookup before the query resolves", () => {
		listProviderHealthMock.mockReturnValue(new Promise(() => {}));
		const { result } = renderHook(() => useProviderHealth(), { wrapper });
		expect(result.current.isLoading).toBe(true);
		expect(result.current.byProviderKey).toEqual({});
		expect(result.current.rows).toEqual([]);
	});

	it("indexes the providers by providerKey on success", async () => {
		listProviderHealthMock.mockResolvedValueOnce({
			providers: [
				{
					id: "row-1",
					providerKey: "openai",
					displayName: "OpenAI",
					currentHealth: "OPERATIONAL",
					lastPolledAt: new Date().toISOString(),
					statusPageUrl: "https://status.openai.com",
					dataConnectionProvider: null,
					activeIncident: null,
				},
				{
					id: "row-2",
					providerKey: "GOOGLE_DRIVE",
					displayName: "Google Drive",
					currentHealth: "DEGRADED",
					lastPolledAt: new Date().toISOString(),
					statusPageUrl: null,
					dataConnectionProvider: "GOOGLE_DRIVE",
					activeIncident: null,
				},
			],
		});

		const { result } = renderHook(() => useProviderHealth(), { wrapper });

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		expect(Object.keys(result.current.byProviderKey).sort()).toEqual([
			"GOOGLE_DRIVE",
			"openai",
		]);
		expect(result.current.byProviderKey.openai?.currentHealth).toBe(
			"OPERATIONAL",
		);
		expect(result.current.byProviderKey.GOOGLE_DRIVE?.currentHealth).toBe(
			"DEGRADED",
		);
		expect(result.current.rows).toHaveLength(2);
	});

	it("does not call the oRPC client when disabled", () => {
		listProviderHealthMock.mockClear();
		renderHook(() => useProviderHealth({ enabled: false }), { wrapper });
		expect(listProviderHealthMock).not.toHaveBeenCalled();
	});
});
