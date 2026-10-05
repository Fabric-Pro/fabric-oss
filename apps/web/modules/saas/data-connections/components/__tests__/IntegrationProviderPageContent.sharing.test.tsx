import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { listSharing, setUsageScope } = vi.hoisted(() => ({
	listSharing: vi.fn(),
	setUsageScope: vi.fn(),
}));
vi.mock("@saas/auth/lib/server", () => ({
	getSession: async () => ({ user: { id: "example-admin" } }),
	getActiveOrganization: async () => ({ id: "org-example" }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-example" }),
}));
vi.mock("@saas/shared/lib/use-monitoring-feature-flag", () => ({
	useMonitoringFeatureFlag: () => false,
}));
vi.mock("../../hooks/useProviderHealth", () => ({
	useProviderHealth: () => ({ byProviderKey: {} }),
}));
// Gmail has no action plugin in the current registry. The provider route must still manage its grant.
vi.mock("@saas/workflows/lib/plugins", () => ({ getIntegration: () => null }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			integrations: {
				list: async () => ({ integrations: [] }),
				listSharing,
				setUsageScope,
			},
		},
		integrations: {
			gitlab: { status: async () => ({ connected: false }) },
		},
	},
}));
vi.mock("../IntegrationIncidentDrawer", () => ({
	IntegrationIncidentDrawer: () => null,
}));

import Page from "../../../../../app/(saas)/app/(organizations)/[organizationSlug]/settings/integrations/providers/[provider]/page";

beforeEach(() => {
	vi.clearAllMocks();
	listSharing.mockResolvedValue({
		connections: [
			{
				id: "gmail-example",
				name: "Example Gmail",
				usageScope: "OWNER_ONLY",
				ownedByCaller: true,
				canShare: true,
				canRevoke: true,
			},
		],
	});
	setUsageScope.mockImplementation(async ({ usageScope }) => {
		listSharing.mockResolvedValue({
			connections: [
				{
					id: "gmail-example",
					name: "Example Gmail",
					usageScope,
					ownedByCaller: true,
					canShare: true,
					canRevoke: true,
				},
			],
		});
		return { success: true };
	});
});
it("renders the navigable Gmail provider route and shares/revokes its exact OAuth connection without an action plugin", async () => {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const page = await Page({
		params: Promise.resolve({
			organizationSlug: "example",
			provider: "GMAIL",
		}),
	});
	render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
	fireEvent.click(
		await screen.findByRole("button", {
			name: "Share Example Gmail with organization",
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "Share connection" }));
	await waitFor(() =>
		expect(setUsageScope).toHaveBeenCalledWith({
			organizationId: "org-example",
			integrationId: "gmail-example",
			usageScope: "ORGANIZATION_SHARED",
		}),
	);
	fireEvent.click(
		await screen.findByRole("button", {
			name: "Stop sharing Example Gmail",
		}),
	);
	await waitFor(() =>
		expect(setUsageScope).toHaveBeenLastCalledWith({
			organizationId: "org-example",
			integrationId: "gmail-example",
			usageScope: "OWNER_ONLY",
		}),
	);
	expect(
		screen.getByRole("link", { name: "Back to Connections" }),
	).toHaveAttribute("href", "/app/example/settings/integrations");
});
