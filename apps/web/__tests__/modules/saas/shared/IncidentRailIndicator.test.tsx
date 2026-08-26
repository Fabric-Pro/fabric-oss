/**
 * Tests for `IncidentRailIndicator` — the sidebar-footer triangle.
 *
 * It shares the gate / data / colour logic with `IncidentChip` via
 * `useIncidentSummary`, so coverage here focuses on the rail-specific surface:
 *   - role + flag + empty + SEV-3-only gating (returns null → no pixels)
 *   - severity tone (destructive for SEV-1, warning for SEV-2-only)
 *   - icon-only: no painted count, but the aria-label carries the breakdown
 *   - click → router.push("/app/admin/monitoring")
 *   - descriptive aria-label
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockListActiveIncidents,
	mockUseFeatureFlag,
	mockUseSession,
	mockUseActiveOrganization,
	mockRouterPush,
} = vi.hoisted(() => ({
	mockListActiveIncidents: vi.fn(),
	mockUseFeatureFlag: vi.fn(),
	mockUseSession: vi.fn(),
	mockUseActiveOrganization: vi.fn(),
	mockRouterPush: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		integrationHealth: {
			listActiveIncidents: (input: unknown) =>
				mockListActiveIncidents(input),
		},
	},
}));

vi.mock("@saas/shared/lib/use-monitoring-feature-flag", () => ({
	useMonitoringFeatureFlag: (flag: string) => mockUseFeatureFlag(flag),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => mockUseSession(),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => mockUseActiveOrganization(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mockRouterPush }),
}));

const mockUseQuery = vi.fn();
vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

import { IncidentRailIndicator } from "../../../../modules/saas/shared/components/IncidentRailIndicator";

function setQueryData(data: unknown) {
	mockUseQuery.mockReturnValue({ data, isPending: false });
}

const SEV1_OPENAI = {
	errorRate: [],
	integration: [
		{
			id: "i1",
			severity: "SEV1" as const,
			status: "FIRING",
			providerKey: "openai",
			providerName: "OpenAI",
			summary: null,
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mockUseFeatureFlag.mockReturnValue(true);
	mockUseSession.mockReturnValue({ user: { role: "admin" } });
	mockUseActiveOrganization.mockReturnValue({
		activeOrganizationUserRole: null,
	});
});

afterEach(() => {
	mockUseQuery.mockReset();
});

describe("IncidentRailIndicator — gating", () => {
	it("renders for system admins with an active SEV-1", () => {
		setQueryData(SEV1_OPENAI);
		render(<IncidentRailIndicator />);
		expect(
			screen.getByTestId("incident-rail-indicator"),
		).toBeInTheDocument();
	});

	it("renders nothing for org owners who are not system admins", () => {
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		mockUseActiveOrganization.mockReturnValue({
			activeOrganizationUserRole: "owner",
		});
		setQueryData(SEV1_OPENAI);
		const { container } = render(<IncidentRailIndicator />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when the feature flag is OFF", () => {
		mockUseFeatureFlag.mockReturnValue(false);
		setQueryData(SEV1_OPENAI);
		const { container } = render(<IncidentRailIndicator />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when both streams are empty", () => {
		setQueryData({ errorRate: [], integration: [] });
		const { container } = render(<IncidentRailIndicator />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing for SEV-3-only incidents", () => {
		setQueryData({
			errorRate: [
				{
					id: "e1",
					severity: "SEV3",
					status: "FIRING",
					service: "api",
					feature: "low_traffic",
				},
			],
			integration: [],
		});
		const { container } = render(<IncidentRailIndicator />);
		expect(container.firstChild).toBeNull();
	});
});

describe("IncidentRailIndicator — severity tone", () => {
	it("uses destructive tone for any active SEV-1", () => {
		setQueryData(SEV1_OPENAI);
		render(<IncidentRailIndicator />);
		expect(screen.getByTestId("incident-rail-indicator")).toHaveAttribute(
			"data-tone",
			"destructive",
		);
	});

	it("uses warning tone for SEV-2-only incidents", () => {
		setQueryData({
			errorRate: [],
			integration: [
				{
					id: "i2",
					severity: "SEV2",
					status: "FIRING",
					providerKey: "stripe",
					providerName: "Stripe",
					summary: null,
				},
			],
		});
		render(<IncidentRailIndicator />);
		expect(screen.getByTestId("incident-rail-indicator")).toHaveAttribute(
			"data-tone",
			"warning",
		);
	});
});

describe("IncidentRailIndicator — count badge", () => {
	it("paints the SEV-1 + SEV-2 count (SEV-3 excluded) and keeps the breakdown in aria-label", () => {
		setQueryData({
			errorRate: [
				{
					id: "e1",
					severity: "SEV1",
					status: "FIRING",
					service: "api",
					feature: "ai_generation",
				},
				{
					id: "e3",
					severity: "SEV3",
					status: "FIRING",
					service: "api",
					feature: "low_traffic",
				},
			],
			integration: [
				{
					id: "i1",
					severity: "SEV2",
					status: "FIRING",
					providerKey: "openai",
					providerName: "OpenAI",
					summary: null,
				},
			],
		});
		render(<IncidentRailIndicator />);
		const btn = screen.getByTestId("incident-rail-indicator");
		// Visible count badge mirrors the notification bell: SEV-1 + SEV-2 = 2,
		// the SEV-3 row is excluded from the count.
		expect(btn).toHaveTextContent("2");
		// The accessible name still carries the full severity breakdown.
		expect(btn.getAttribute("aria-label")).toMatch(/1 SEV-1/);
		expect(btn.getAttribute("aria-label")).toMatch(/1 SEV-2/);
	});
});

describe("IncidentRailIndicator — click + accessibility", () => {
	beforeEach(() => {
		setQueryData(SEV1_OPENAI);
	});

	it("navigates to the monitoring dashboard on click", () => {
		render(<IncidentRailIndicator />);
		fireEvent.click(screen.getByTestId("incident-rail-indicator"));
		expect(mockRouterPush).toHaveBeenCalledWith("/app/admin/monitoring");
	});

	it("preserves the org workspace by keeping the slug in the path", () => {
		// From an org workspace the active-org slug is present, so the click must
		// keep the slug in the URL (the workspace selector is derived purely from
		// it) rather than dropping to the slug-less personal path that flipped the
		// selector to "Personal".
		mockUseActiveOrganization.mockReturnValue({
			activeOrganizationUserRole: "owner",
			activeOrganization: { slug: "acme" },
		});
		render(<IncidentRailIndicator />);
		fireEvent.click(screen.getByTestId("incident-rail-indicator"));
		expect(mockRouterPush).toHaveBeenCalledWith(
			"/app/acme/admin/monitoring",
		);
	});

	it("exposes a descriptive aria-label", () => {
		render(<IncidentRailIndicator />);
		const label = screen
			.getByTestId("incident-rail-indicator")
			.getAttribute("aria-label");
		expect(label).toMatch(/1 SEV-1 incident/);
		expect(label).toMatch(/View the monitoring dashboard/);
	});

	it("renders the entrance fade behind a motion-safe variant", () => {
		render(<IncidentRailIndicator />);
		const btn = screen.getByTestId("incident-rail-indicator");
		expect(btn.className).toContain("motion-safe:animate-in");
		expect(btn.className).toContain("motion-safe:fade-in");
	});
});
