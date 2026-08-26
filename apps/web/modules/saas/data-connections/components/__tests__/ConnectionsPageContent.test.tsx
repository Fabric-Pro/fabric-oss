/**
 * Tests for the integrations catalog page (`ConnectionsPageContent`).
 *
 * Coverage
 * --------
 * - The Databricks Vector Search card (an action-only plugin with no
 *   `DataConnectionProvider` enum value) renders in the grid and deep-links
 *   to the actions setup page.
 * - Connected state reflects `workflows.integrations.listStatus` credentials.
 * - Text search and the capability filter chips narrow the grid down to
 *   (or away from) the Databricks card, same as the data-provider cards.
 * - The "actions connected" count badge includes action-only providers.
 *
 * The page composes several unrelated systems (organization context,
 * connections, workflow integrations, provider health), so we mock at the
 * boundary: `useOrganizationContext`, `useConnections`, `useProviderHealth`,
 * `useMonitoringFeatureFlag`, and `orpcClient.workflows.integrations.listStatus`.
 * `@tanstack/react-query` is left real (wrapped in a `QueryClientProvider`)
 * so the workflow-integration-status query resolves asynchronously like it
 * does in the app.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockUseOrganizationContext,
	mockUseMonitoringFeatureFlag,
	mockUseProviderHealth,
	mockUseConnections,
} = vi.hoisted(() => ({
	mockUseOrganizationContext: vi.fn(),
	mockUseMonitoringFeatureFlag: vi.fn(),
	mockUseProviderHealth: vi.fn(),
	mockUseConnections: vi.fn(),
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

vi.mock("../../hooks/useConnections", () => ({
	useConnections: (...args: unknown[]) => mockUseConnections(...args),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			integrations: {
				listStatus: vi.fn(),
			},
		},
	},
}));

import { orpcClient } from "@shared/lib/orpc-client";
import { ConnectionsPageContent } from "../ConnectionsPageContent";

const listIntegrationsMock = orpcClient.workflows.integrations
	.listStatus as unknown as ReturnType<typeof vi.fn>;

function renderWithClient(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function renderPage(
	integrations: Array<{ provider: string; hasCredentials: boolean }> = [],
) {
	mockUseOrganizationContext.mockReturnValue({ organizationId: null });
	mockUseMonitoringFeatureFlag.mockReturnValue(false);
	mockUseProviderHealth.mockReturnValue({
		byProviderKey: {},
		rows: [],
		isLoading: false,
		isError: false,
	});
	mockUseConnections.mockReturnValue({
		data: [],
		isLoading: false,
		error: null,
	});
	listIntegrationsMock.mockResolvedValue({ integrations });

	return renderWithClient(
		<ConnectionsPageContent
			addHref="/app/settings/integrations/add"
			settingsBasePath="/app/settings/integrations"
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ConnectionsPageContent — Databricks Vector Search catalog card", () => {
	it("renders the Databricks card deep-linking to the actions setup page", async () => {
		renderPage();

		const link = await screen.findByRole("link", {
			name: /Databricks Vector Search/i,
		});
		expect(link).toHaveAttribute(
			"href",
			expect.stringContaining("/actions/DATABRICKS_VECTOR_SEARCH"),
		);
	});

	it("shows Not connected when no Databricks credentials exist", async () => {
		renderPage();

		const link = await screen.findByRole("link", {
			name: /Databricks Vector Search/i,
		});
		expect(within(link).getByText("Not connected")).toBeInTheDocument();
	});

	it("shows Connected when the Databricks integration has credentials", async () => {
		renderPage([
			{ provider: "DATABRICKS_VECTOR_SEARCH", hasCredentials: true },
		]);

		await waitFor(() => {
			expect(screen.getByText("Connected")).toBeInTheDocument();
		});
	});

	it("filters the grid to the Databricks card when searching 'databricks'", async () => {
		const user = userEvent.setup();
		renderPage();

		await screen.findByRole("link", { name: /Databricks Vector Search/i });

		await user.type(
			screen.getByPlaceholderText("Search integrations"),
			"databricks",
		);

		expect(
			screen.getByRole("link", { name: /Databricks Vector Search/i }),
		).toBeInTheDocument();
	});

	it("shows the empty state for a query that matches nothing", async () => {
		const user = userEvent.setup();
		renderPage();

		await screen.findByRole("link", { name: /Databricks Vector Search/i });

		await user.type(
			screen.getByPlaceholderText("Search integrations"),
			"zzzz",
		);

		expect(screen.getByText(/No integrations match/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /Databricks Vector Search/i }),
		).not.toBeInTheDocument();
	});

	it("hides the Databricks card under the Search capability filter", async () => {
		const user = userEvent.setup();
		renderPage();

		await screen.findByRole("link", { name: /Databricks Vector Search/i });

		await user.click(screen.getByRole("button", { name: "Search" }));

		expect(
			screen.queryByRole("link", { name: /Databricks Vector Search/i }),
		).not.toBeInTheDocument();
	});

	it("shows the Databricks card under Actions only when connected", async () => {
		const user = userEvent.setup();
		renderPage();

		await screen.findByRole("link", { name: /Databricks Vector Search/i });

		await user.click(screen.getByRole("button", { name: "Actions" }));

		expect(
			screen.queryByRole("link", { name: /Databricks Vector Search/i }),
		).not.toBeInTheDocument();
	});

	it("shows the Databricks card under Actions when connected", async () => {
		const user = userEvent.setup();
		renderPage([
			{ provider: "DATABRICKS_VECTOR_SEARCH", hasCredentials: true },
		]);

		await waitFor(() => {
			expect(screen.getByText("Connected")).toBeInTheDocument();
		});

		await user.click(screen.getByRole("button", { name: "Actions" }));

		expect(
			screen.getByRole("link", { name: /Databricks Vector Search/i }),
		).toBeInTheDocument();
	});

	it("counts Databricks in the 'actions connected' badge when connected", async () => {
		renderPage([
			{ provider: "DATABRICKS_VECTOR_SEARCH", hasCredentials: true },
		]);

		await waitFor(() => {
			expect(screen.getByText("1 actions connected")).toBeInTheDocument();
		});
	});
});
