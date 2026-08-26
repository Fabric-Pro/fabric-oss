/**
 * Unit tests for `ProviderHealthGrid`. criteria:
 *   - 4-column responsive grid renders every registered provider.
 *   - Click handler only fires for cards with an active incident; healthy
 *     cards remain non-interactive (no aria-label).
 *   - Last-poll timestamp is formatted via `formatLastPoll` (mirrors
 *     `formatDistanceToNow`).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseQuery } = vi.hoisted(() => ({
	mockUseQuery: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		integrationHealth: {
			listProviderHealth: vi.fn(),
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
	useMutation: ({ mutationFn }: { mutationFn: () => Promise<unknown> }) => ({
		mutate: mutationFn,
		isPending: false,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// Stub the dialog component so we can observe `open` transitions without
// having to render the real dialog primitives.
const { dialogState } = vi.hoisted(() => ({
	dialogState: { last: null as null | Record<string, unknown> },
}));

vi.mock(
	"../../../../../modules/saas/admin/component/monitoring/IncidentAckResolveDialog",
	() => ({
		IncidentAckResolveDialog: (props: Record<string, unknown>) => {
			dialogState.last = props;
			return null;
		},
		MONITORING_QUERY_KEYS: {
			activeIncidents: ["monitoring", "active-incidents"] as const,
			errorRateList: [
				"monitoring",
				"incidents",
				"error-rate",
				"list",
			] as const,
			integrationProviders: [
				"monitoring",
				"integration-health",
				"providers",
			] as const,
		},
	}),
);

import {
	formatLastPoll,
	ProviderHealthGrid,
} from "../../../../../modules/saas/admin/component/monitoring/ProviderHealthGrid";

const providers = [
	{
		id: "p1",
		providerKey: "openai",
		displayName: "OpenAI",
		currentHealth: "OPERATIONAL",
		lastPolledAt: new Date(Date.now() - 60_000).toISOString(),
		statusPageUrl: "https://status.openai.com",
		affectedFeatures: ["ai_generation"],
		activeIncident: null,
	},
	{
		id: "p2",
		providerKey: "stripe",
		displayName: "Stripe",
		currentHealth: "MAJOR_OUTAGE",
		lastPolledAt: new Date(Date.now() - 120_000).toISOString(),
		statusPageUrl: "https://status.stripe.com",
		affectedFeatures: ["payments"],
		activeIncident: {
			id: "inc1",
			summary: "Card processing degraded",
			severity: "SEV1",
			status: "FIRING",
			startedAt: new Date().toISOString(),
		},
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	dialogState.last = null;
});

afterEach(() => {
	mockUseQuery.mockReset();
});

describe("ProviderHealthGrid", () => {
	it("renders a card per registered provider", () => {
		mockUseQuery.mockReturnValue({
			data: providers,
			isLoading: false,
			isError: false,
		});
		render(<ProviderHealthGrid />);
		expect(screen.getByTestId("provider-card-openai")).toBeInTheDocument();
		expect(screen.getByTestId("provider-card-stripe")).toBeInTheDocument();
		expect(screen.getByText("OpenAI")).toBeInTheDocument();
		expect(screen.getByText("Stripe")).toBeInTheDocument();
	});

	it("marks cards with an active incident as interactive", () => {
		mockUseQuery.mockReturnValue({
			data: providers,
			isLoading: false,
			isError: false,
		});
		render(<ProviderHealthGrid />);

		const stripeCard = screen.getByTestId("provider-card-stripe");
		expect(stripeCard).toHaveAttribute("role", "button");
		expect(stripeCard).toHaveAttribute(
			"aria-label",
			"Open incident actions for Stripe",
		);

		const openaiCard = screen.getByTestId("provider-card-openai");
		expect(openaiCard).not.toHaveAttribute("role", "button");
	});

	it("opens the incident dialog when a card with an active incident is clicked", () => {
		mockUseQuery.mockReturnValue({
			data: providers,
			isLoading: false,
			isError: false,
		});
		render(<ProviderHealthGrid />);
		fireEvent.click(screen.getByTestId("provider-card-stripe"));
		expect(dialogState.last).toMatchObject({
			open: true,
			target: {
				kind: "integration",
				incidentId: "inc1",
				providerName: "Stripe",
				status: "FIRING",
			},
		});
	});

	it("shows a loading message while the query is pending", () => {
		mockUseQuery.mockReturnValue({
			data: undefined,
			isLoading: true,
			isError: false,
		});
		render(<ProviderHealthGrid />);
		expect(
			screen.getByText(/Loading provider health/i),
		).toBeInTheDocument();
	});

	it("shows an error message when the query errors", () => {
		mockUseQuery.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		});
		render(<ProviderHealthGrid />);
		expect(
			screen.getByText(/Failed to load provider health/i),
		).toBeInTheDocument();
	});

	it("shows the empty state when no providers are registered", () => {
		mockUseQuery.mockReturnValue({
			data: [],
			isLoading: false,
			isError: false,
		});
		render(<ProviderHealthGrid />);
		expect(
			screen.getByText(/No providers registered/i),
		).toBeInTheDocument();
	});
});

describe("formatLastPoll", () => {
	it("returns an em dash for null", () => {
		expect(formatLastPoll(null)).toBe("—");
	});

	it("renders a distance for a recent date", () => {
		const result = formatLastPoll(new Date(Date.now() - 60_000));
		expect(result).toMatch(/ago$/);
		expect(result).toMatch(/minute|second/);
	});
});
