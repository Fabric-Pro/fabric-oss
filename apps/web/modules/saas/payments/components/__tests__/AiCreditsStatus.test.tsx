/**
 * Unit tests for the AiCreditsBanner tenant scoping at the API boundary.
 *
 * Contract under test (gap-closure for guest 403s in the app shell):
 * - The org layout passes `organizationId={null}` for project-scoped
 *   guests; the banner must forward an EXPLICIT `organizationId: null`
 *   (multi-tenant XOR — personal scope) to `payments.getAiCreditStatus`,
 *   so the guest sees THEIR credits and no org-scoped 403 fires.
 * - Org members keep the org-scoped call unchanged.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/payments/components/__tests__/AiCreditsStatus.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiCreditsBanner } from "../AiCreditsStatus";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
});

const getAiCreditStatusMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		payments: {
			getAiCreditStatus: (input: unknown) => getAiCreditStatusMock(input),
			getAiUsageBreakdown: vi.fn(),
			createPaymentMethodSetupLink: vi.fn(),
			createCustomerPortalLink: vi.fn(),
		},
	},
}));

function renderWithClient(ui: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	// `hasPaymentMethod: true` keeps the banner chrome hidden — these
	// tests assert the API-call scoping, not the banner visuals.
	getAiCreditStatusMock.mockResolvedValue({
		hasPaymentMethod: true,
		hasConfiguredProvider: false,
		isLimitReached: false,
		remainingCreditUsd: 5,
		usedCreditUsd: 0,
		creditLimitUsd: 5,
		canManageBilling: true,
		customerId: null,
	});
});

describe("AiCreditsBanner tenant scoping", () => {
	it("guest (layout passes null) → getAiCreditStatus receives explicit organizationId: null", async () => {
		renderWithClient(<AiCreditsBanner organizationId={null} />);

		await waitFor(() =>
			expect(getAiCreditStatusMock).toHaveBeenCalledWith({
				organizationId: null,
			}),
		);
	});

	it("org member → getAiCreditStatus receives the org id", async () => {
		renderWithClient(<AiCreditsBanner organizationId="org-1" />);

		await waitFor(() =>
			expect(getAiCreditStatusMock).toHaveBeenCalledWith({
				organizationId: "org-1",
			}),
		);
	});

	it("personal layout (no prop) → normalizes undefined to explicit null", async () => {
		renderWithClient(<AiCreditsBanner />);

		await waitFor(() =>
			expect(getAiCreditStatusMock).toHaveBeenCalledWith({
				organizationId: null,
			}),
		);
	});
});
