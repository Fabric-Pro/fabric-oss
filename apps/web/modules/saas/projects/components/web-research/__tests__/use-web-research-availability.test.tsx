/**
 * The availability hook's mapping from the server's answer, and the one
 * helper every surface uses to decide whether a request carries
 * `allowWebResearch: true`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const availabilityQuery = vi.hoisted(() => vi.fn());

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				webResearchAvailability: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: [
							"projects.documents.webResearchAvailability",
							input,
						],
						queryFn: () => availabilityQuery(input),
					}),
				},
			},
		},
	},
}));

import {
	useWebResearchAvailability,
	type WebResearchAvailability,
	webResearchToSend,
} from "../use-web-research-availability";

function renderAvailability(enabled = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return renderHook(
		(props: { enabled: boolean }) =>
			useWebResearchAvailability({
				projectId: "project-1",
				enabled: props.enabled,
			}),
		{ wrapper, initialProps: { enabled } },
	);
}

beforeEach(() => {
	availabilityQuery.mockReset();
});

describe("useWebResearchAvailability", () => {
	it("does not ask while the surface is closed, and reads as loading", () => {
		const { result } = renderAvailability(false);

		expect(result.current).toEqual({ status: "loading" });
		expect(availabilityQuery).not.toHaveBeenCalled();
	});

	it("sends only the project id once the surface opens", async () => {
		availabilityQuery.mockResolvedValue({ available: true, missing: [] });
		const { result, rerender } = renderAvailability(false);

		rerender({ enabled: true });

		await waitFor(() =>
			expect(result.current).toEqual({ status: "available" }),
		);
		expect(availabilityQuery).toHaveBeenCalledWith({
			projectId: "project-1",
		});
	});

	it("reads as loading until the server answers", () => {
		availabilityQuery.mockReturnValue(new Promise(() => {}));
		const { result } = renderAvailability();

		expect(result.current).toEqual({ status: "loading" });
	});

	it("passes on what the organization is missing", async () => {
		availabilityQuery.mockResolvedValue({
			available: false,
			missing: ["read"],
		});
		const { result } = renderAvailability();

		await waitFor(() =>
			expect(result.current).toEqual({
				status: "unavailable",
				missing: ["read"],
			}),
		);
	});

	it("reads an answer without a missing list as unavailable on both halves", async () => {
		availabilityQuery.mockResolvedValue({});
		const { result } = renderAvailability();

		await waitFor(() =>
			expect(result.current).toEqual({
				status: "unavailable",
				missing: ["search", "read"],
			}),
		);
	});

	it("reads a failed check as an error, not as available", async () => {
		availabilityQuery.mockRejectedValue(new Error("network"));
		const { result } = renderAvailability();

		await waitFor(() =>
			expect(result.current).toEqual({ status: "error" }),
		);
	});
});

describe("webResearchToSend", () => {
	const notAvailable: WebResearchAvailability[] = [
		{ status: "loading" },
		{ status: "error" },
		{ status: "unavailable", missing: ["search"] },
		{ status: "unavailable", missing: ["read"] },
		{ status: "unavailable", missing: ["search", "read"] },
	];

	it("sends only a tick made while research is available", () => {
		expect(webResearchToSend(true, { status: "available" })).toBe(true);
	});

	it.each(notAvailable)("never sends a tick while %o", (availability) => {
		expect(webResearchToSend(true, availability)).toBe(false);
	});

	it.each([{ status: "available" } as const, ...notAvailable])(
		"never sends without a tick while %o",
		(availability) => {
			expect(webResearchToSend(false, availability)).toBe(false);
		},
	);
});
