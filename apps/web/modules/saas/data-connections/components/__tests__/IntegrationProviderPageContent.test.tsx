/**
 * Tests for the integration-provider detail page (`/app/settings/
 * integrations/providers/[provider]`). Verifies the recently-added
 * `ProviderHealthBadge` is wired into the page header, the
 * "View incident timeline" link surfaces for non-healthy providers, and
 * the existing connection-setup affordances continue to render.
 *
 * The page composes a handful of unrelated systems (organization context,
 * workflow integrations, provider health, incident drawer), so we mock at
 * the boundary: `useOrganizationContext`, `useProviderHealth`, the
 * `useMonitoringFeatureFlag` hook, and `orpcClient` for the workflow
 * integrations list.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockUseOrganizationContext,
	mockUseMonitoringFeatureFlag,
	mockUseProviderHealth,
	mockUseQuery,
} = vi.hoisted(() => ({
	mockUseOrganizationContext: vi.fn(),
	mockUseMonitoringFeatureFlag: vi.fn(),
	mockUseProviderHealth: vi.fn(),
	mockUseQuery: vi.fn(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => mockUseOrganizationContext(),
}));

vi.mock("@saas/shared/lib/use-monitoring-feature-flag", () => ({
	useMonitoringFeatureFlag: (flag: string) =>
		mockUseMonitoringFeatureFlag(flag),
}));

vi.mock("../../hooks/useProviderHealth", () => ({
	useProviderHealth: (...args: unknown[]) => mockUseProviderHealth(...args),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			integrations: {
				list: vi.fn(),
			},
		},
		integrationHealth: {
			getProviderIncidents: vi.fn(),
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
	useMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn().mockResolvedValue(undefined),
		isPending: false,
		reset: vi.fn(),
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// The integration plugins map relies on Node module resolution that can
// trip in jsdom. Stub at the boundary so the component renders.
vi.mock("@saas/workflows/lib/plugins", () => ({
	getIntegration: () => null,
}));

// Stub the brand icon -- the real implementation pulls in
// `IntegrationBrandIcon` which expects MotionConfig. The page only renders
// it when there's an action plugin, but we stub for safety.
vi.mock("@saas/workflows/components/integrations/IntegrationBrandIcon", () => ({
	IntegrationBrandIcon: ({ label }: { label: string }) => (
		<div data-testid="brand-icon">{label}</div>
	),
}));

// Stub the drawer so we don't have to mount a QueryClient for it.
vi.mock("../IntegrationIncidentDrawer", () => ({
	IntegrationIncidentDrawer: ({
		open,
		providerName,
	}: {
		open: boolean;
		providerName: string;
	}) =>
		open ? (
			<div data-testid="incident-drawer">{providerName} drawer</div>
		) : null,
}));

import { IntegrationProviderPageContent } from "../IntegrationProviderPageContent";

const baseHealthRow = {
	id: "h-openai",
	providerKey: "OPENAI",
	displayName: "OpenAI",
	currentHealth: "OPERATIONAL" as const,
	lastPolledAt: new Date().toISOString(),
	statusPageUrl: "https://status.openai.com",
	dataConnectionProvider: "OPENAI",
	activeIncident: null,
};

function renderPage(opts: {
	providerKey?: string;
	healthBadgesEnabled?: boolean;
	health?: typeof baseHealthRow | null;
}): ReactNode {
	const providerKey = opts.providerKey ?? "GOOGLE_DRIVE";
	const healthBadgesEnabled = opts.healthBadgesEnabled ?? true;
	const health = opts.health === undefined ? baseHealthRow : opts.health;

	mockUseOrganizationContext.mockReturnValue({ organizationId: null });
	mockUseMonitoringFeatureFlag.mockImplementation(() => healthBadgesEnabled);
	mockUseProviderHealth.mockReturnValue({
		byProviderKey: health ? { [providerKey]: health } : {},
		rows: health ? [health] : [],
		isLoading: false,
		isError: false,
	});
	mockUseQuery.mockReturnValue({
		data: [],
		isLoading: false,
		isError: false,
	});

	return render(
		<IntegrationProviderPageContent
			provider={providerKey as never}
			settingsBasePath="/app/settings/integrations"
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	mockUseProviderHealth.mockReset();
	mockUseQuery.mockReset();
	mockUseMonitoringFeatureFlag.mockReset();
	mockUseOrganizationContext.mockReset();
});

describe("IntegrationProviderPageContent — health badge wiring", () => {
	it("renders the ProviderHealthBadge in the header when health is available", () => {
		renderPage({ providerKey: "GOOGLE_DRIVE" });
		// The badge renders "Operational" copy on the operational row.
		expect(screen.getByText("Operational")).toBeInTheDocument();
	});

	it("does not render the badge when the feature flag is disabled", () => {
		renderPage({
			providerKey: "GOOGLE_DRIVE",
			healthBadgesEnabled: false,
			health: { ...baseHealthRow, providerKey: "GOOGLE_DRIVE" },
		});
		expect(screen.queryByText("Operational")).not.toBeInTheDocument();
	});

	it("renders the View incident timeline link for non-OPERATIONAL providers", () => {
		renderPage({
			providerKey: "GOOGLE_DRIVE",
			health: {
				...baseHealthRow,
				providerKey: "GOOGLE_DRIVE",
				currentHealth: "MAJOR_OUTAGE",
			},
		});
		expect(
			screen.getByRole("button", {
				name: /View incident timeline/i,
			}),
		).toBeInTheDocument();
	});

	it("hides the timeline link for OPERATIONAL providers", () => {
		renderPage({
			providerKey: "GOOGLE_DRIVE",
			health: {
				...baseHealthRow,
				providerKey: "GOOGLE_DRIVE",
				currentHealth: "OPERATIONAL",
			},
		});
		expect(
			screen.queryByRole("button", {
				name: /View incident timeline/i,
			}),
		).not.toBeInTheDocument();
	});

	it("hides the timeline link for UNKNOWN health (no incident history)", () => {
		renderPage({
			providerKey: "GOOGLE_DRIVE",
			health: {
				...baseHealthRow,
				providerKey: "GOOGLE_DRIVE",
				currentHealth: "UNKNOWN",
			},
		});
		expect(
			screen.queryByRole("button", {
				name: /View incident timeline/i,
			}),
		).not.toBeInTheDocument();
	});

	it("does not render the badge when no health row is available", () => {
		renderPage({ providerKey: "GOOGLE_DRIVE", health: null });
		expect(screen.queryByText("Operational")).not.toBeInTheDocument();
		expect(
			screen.queryByText("Status unavailable"),
		).not.toBeInTheDocument();
	});

	it("keeps the back-to-integrations link in the header", () => {
		renderPage({ providerKey: "GOOGLE_DRIVE" });
		expect(
			screen.getByRole("link", { name: /Back to Integrations/i }),
		).toBeInTheDocument();
	});
});
