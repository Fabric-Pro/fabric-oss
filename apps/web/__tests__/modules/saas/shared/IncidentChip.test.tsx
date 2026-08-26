/**
 * Tests for the `IncidentChip` component (replaces `IncidentBanner`).
 *
 * Coverage:
 *   - role-gate: admin / org-owner / regular-member / personal-only
 *   - feature flag off → returns null
 *   - empty incident list → returns null
 *   - SEV-3-only → returns null (chip is SEV-1 / SEV-2 only)
 *   - SEV-1 active → destructive tone (red), count reflects SEV-1 + SEV-2
 *   - SEV-2-only → warning tone (amber)
 *   - SEV-1 + SEV-2 mix → destructive tone (highest severity wins)
 *   - chip click → `router.push("/app/admin/monitoring")`
 *   - tooltip surfaces "Active incidents" header + incident titles
 *   - aria-label includes severity breakdown
 *   - motion-safe entrance class present
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

import {
	canViewIncidentChip,
	IncidentChip,
} from "../../../../modules/saas/shared/components/IncidentChip";

function setQueryData(data: unknown) {
	mockUseQuery.mockReturnValue({ data, isPending: false });
}

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

describe("canViewIncidentChip — role-based visibility rule", () => {
	it("allows system admins regardless of org role", () => {
		expect(canViewIncidentChip("admin", null)).toBe(true);
		expect(canViewIncidentChip("admin", "member")).toBe(true);
		expect(canViewIncidentChip("admin", "owner")).toBe(true);
	});

	// v3 admin-incidents pass: org owners are no longer privileged for the
	// platform-wide incident chip. Their per-org integration banner stays.
	it("blocks org owners who are not system admins", () => {
		expect(canViewIncidentChip("user", "owner")).toBe(false);
		expect(canViewIncidentChip(null, "owner")).toBe(false);
	});

	it("blocks regular members and personal-only users", () => {
		expect(canViewIncidentChip("user", "member")).toBe(false);
		expect(canViewIncidentChip("user", null)).toBe(false);
		expect(canViewIncidentChip(null, null)).toBe(false);
		expect(canViewIncidentChip(undefined, undefined)).toBe(false);
	});
});

describe("IncidentChip — role-based visibility", () => {
	const sev1Payload = {
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

	it("renders for system admins", () => {
		mockUseSession.mockReturnValue({ user: { role: "admin" } });
		mockUseActiveOrganization.mockReturnValue({
			activeOrganizationUserRole: null,
		});
		setQueryData(sev1Payload);

		render(<IncidentChip />);
		expect(screen.getByTestId("incident-chip")).toBeInTheDocument();
	});

	// v3 admin-incidents pass: org owners no longer see the platform-wide
	// incident chip. This is the regression-guard test the spec calls out.
	it("renders nothing for org owners who are not system admins", () => {
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		mockUseActiveOrganization.mockReturnValue({
			activeOrganizationUserRole: "owner",
		});
		setQueryData(sev1Payload);

		const { container } = render(<IncidentChip />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing for regular org members", () => {
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		mockUseActiveOrganization.mockReturnValue({
			activeOrganizationUserRole: "member",
		});
		setQueryData(sev1Payload);

		const { container } = render(<IncidentChip />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing for personal-only users with no active org", () => {
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		mockUseActiveOrganization.mockReturnValue({
			activeOrganizationUserRole: null,
		});
		setQueryData(sev1Payload);

		const { container } = render(<IncidentChip />);
		expect(container.firstChild).toBeNull();
	});
});

describe("IncidentChip — feature flag gating", () => {
	it("renders nothing when the feature flag is OFF", () => {
		mockUseFeatureFlag.mockReturnValue(false);
		setQueryData({
			errorRate: [],
			integration: [
				{
					id: "i1",
					severity: "SEV1",
					status: "FIRING",
					providerKey: "openai",
					providerName: "OpenAI",
					summary: "Outage",
				},
			],
		});

		const { container } = render(<IncidentChip />);
		expect(container.firstChild).toBeNull();
	});
});

describe("IncidentChip — empty / no-data states", () => {
	it("renders nothing when both streams are empty", () => {
		setQueryData({ errorRate: [], integration: [] });

		const { container } = render(<IncidentChip />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when the query has not returned yet (loading)", () => {
		setQueryData(undefined);

		const { container } = render(<IncidentChip />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when only SEV-3 incidents are active", () => {
		setQueryData({
			errorRate: [
				{
					id: "e1",
					severity: "SEV3",
					status: "FIRING",
					service: "api",
					feature: "ai_generation",
				},
			],
			integration: [],
		});

		const { container } = render(<IncidentChip />);
		expect(container.firstChild).toBeNull();
	});
});

describe("IncidentChip — severity tone", () => {
	it("renders with destructive tone for any active SEV-1", () => {
		setQueryData({
			errorRate: [],
			integration: [
				{
					id: "i1",
					severity: "SEV1",
					status: "FIRING",
					providerKey: "openai",
					providerName: "OpenAI",
					summary: null,
				},
			],
		});

		render(<IncidentChip />);

		const chip = screen.getByTestId("incident-chip");
		expect(chip).toHaveAttribute("data-tone", "destructive");
	});

	it("renders with warning tone for SEV-2-only incidents", () => {
		setQueryData({
			errorRate: [],
			integration: [
				{
					id: "i2",
					severity: "SEV2",
					status: "ACKNOWLEDGED",
					providerKey: "stripe",
					providerName: "Stripe",
					summary: "Partial outage",
				},
			],
		});

		render(<IncidentChip />);

		const chip = screen.getByTestId("incident-chip");
		expect(chip).toHaveAttribute("data-tone", "warning");
	});

	it("prefers destructive tone when SEV-1 and SEV-2 are both active", () => {
		setQueryData({
			errorRate: [],
			integration: [
				{
					id: "i-sev2",
					severity: "SEV2",
					status: "ACKNOWLEDGED",
					providerKey: "stripe",
					providerName: "Stripe",
					summary: null,
				},
				{
					id: "i-sev1",
					severity: "SEV1",
					status: "FIRING",
					providerKey: "openai",
					providerName: "OpenAI",
					summary: null,
				},
			],
		});

		render(<IncidentChip />);

		const chip = screen.getByTestId("incident-chip");
		expect(chip).toHaveAttribute("data-tone", "destructive");
	});
});

describe("IncidentChip — count text", () => {
	it("renders the SEV-1 + SEV-2 count (excluding SEV-3)", () => {
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

		render(<IncidentChip />);

		// SEV-1 + SEV-2 = 2; SEV-3 is not counted.
		const chip = screen.getByTestId("incident-chip");
		expect(chip).toHaveTextContent("2");
		// The aria-label spells out the breakdown.
		expect(chip.getAttribute("aria-label")).toMatch(/1 SEV-1/);
		expect(chip.getAttribute("aria-label")).toMatch(/1 SEV-2/);
	});
});

describe("IncidentChip — click behaviour", () => {
	it("navigates to /app/admin/monitoring on click", () => {
		setQueryData({
			errorRate: [],
			integration: [
				{
					id: "i1",
					severity: "SEV1",
					status: "FIRING",
					providerKey: "openai",
					providerName: "OpenAI",
					summary: null,
				},
			],
		});

		render(<IncidentChip />);

		fireEvent.click(screen.getByTestId("incident-chip"));
		expect(mockRouterPush).toHaveBeenCalledWith("/app/admin/monitoring");
	});

	it("keeps the org workspace by navigating within the org base path", () => {
		// In an org workspace the active-org slug is present, so the click must
		// keep the slug in the URL (the workspace selector is derived purely
		// from it) instead of dropping to the slug-less personal path — which is
		// what used to flip the selector to "Personal".
		mockUseActiveOrganization.mockReturnValue({
			activeOrganizationUserRole: "owner",
			activeOrganization: { slug: "acme" },
		});
		setQueryData({
			errorRate: [],
			integration: [
				{
					id: "i1",
					severity: "SEV1",
					status: "FIRING",
					providerKey: "openai",
					providerName: "OpenAI",
					summary: null,
				},
			],
		});

		render(<IncidentChip />);

		fireEvent.click(screen.getByTestId("incident-chip"));
		expect(mockRouterPush).toHaveBeenCalledWith(
			"/app/acme/admin/monitoring",
		);
	});
});

describe("IncidentChip — accessibility & motion", () => {
	beforeEach(() => {
		setQueryData({
			errorRate: [],
			integration: [
				{
					id: "i1",
					severity: "SEV1",
					status: "FIRING",
					providerKey: "openai",
					providerName: "OpenAI",
					summary: null,
				},
			],
		});
	});

	it("exposes a descriptive aria-label that announces severity and intent", () => {
		render(<IncidentChip />);

		const chip = screen.getByTestId("incident-chip");
		const label = chip.getAttribute("aria-label");
		expect(label).toMatch(/1 SEV-1 incident/);
		expect(label).toMatch(/Click to view the monitoring dashboard/);
	});

	it("renders the entrance fade behind a motion-safe variant", () => {
		render(<IncidentChip />);

		const chip = screen.getByTestId("incident-chip");
		expect(chip.className).toContain("motion-safe:animate-in");
		expect(chip.className).toContain("motion-safe:fade-in");
	});
});
