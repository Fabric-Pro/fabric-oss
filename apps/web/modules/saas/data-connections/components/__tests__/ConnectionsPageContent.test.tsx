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
 * - List-level copy (loading, error, empty state, search placeholder) names
 *   the mixed catalogue "connections", not "integrations" — the list holds
 *   both integration providers and MCP registry tiles. The
 *   `data-onboarding-target="integrations-*"` anchors keep their frozen
 *   identifiers, so one test pins the search anchor against a tidy-up rename.
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
		mcp: {
			registry: {
				list: vi.fn(),
			},
		},
	},
}));

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { ConnectionsPageContent } from "../ConnectionsPageContent";

const listIntegrationsMock = orpcClient.workflows.integrations
	.listStatus as unknown as ReturnType<typeof vi.fn>;
const listMcpRegistryMock = orpcClient.mcp.registry
	.list as unknown as ReturnType<typeof vi.fn>;

function renderWithClient(
	ui: ReactNode,
	flags: Partial<Record<FeatureFlagKey, boolean>> = {
		LINEAR_INTEGRATION: false,
	},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<FeatureFlagProvider
				value={flags as Record<FeatureFlagKey, boolean>}
			>
				{ui}
			</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

/**
 * Renders the real component with a marked `toolbarStart`, so the half of the
 * ordering claim a stubbed child cannot make — that this component puts the
 * toolbar above its provider grid — is pinned against real markup.
 */
function renderPageWithToolbar() {
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
	listIntegrationsMock.mockResolvedValue({ integrations: [] });

	return renderWithClient(
		<ConnectionsPageContent
			addHref="/app/settings/integrations/add"
			settingsBasePath="/app/settings/integrations"
			toolbarStart={<div data-testid="toolbar-slot" />}
		/>,
	);
}

function renderPage(
	integrations: Array<{ provider: string; hasCredentials: boolean }> = [],
	connectionsState: {
		data: unknown[];
		isLoading: boolean;
		error: unknown;
	} = { data: [], isLoading: false, error: null },
	flags: Partial<Record<FeatureFlagKey, boolean>> = {
		LINEAR_INTEGRATION: false,
	},
) {
	mockUseOrganizationContext.mockReturnValue({ organizationId: null });
	mockUseMonitoringFeatureFlag.mockReturnValue(false);
	mockUseProviderHealth.mockReturnValue({
		byProviderKey: {},
		rows: [],
		isLoading: false,
		isError: false,
	});
	mockUseConnections.mockReturnValue(connectionsState);
	listIntegrationsMock.mockResolvedValue({ integrations });

	return renderWithClient(
		<ConnectionsPageContent
			addHref="/app/settings/integrations/add"
			settingsBasePath="/app/settings/integrations"
		/>,
		flags,
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
			screen.getByPlaceholderText("Search connections"),
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
			screen.getByPlaceholderText("Search connections"),
			"zzzz",
		);

		expect(
			screen.getByText("No connections match your current filters."),
		).toBeInTheDocument();
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

describe("ConnectionsPageContent — list-level copy names connections", () => {
	it("names the catalogue 'connections' while loading", async () => {
		renderPage([], { data: [], isLoading: true, error: null });

		expect(
			await screen.findByText("Loading connections…"),
		).toBeInTheDocument();
	});

	it("names the catalogue 'connections' when the load fails", async () => {
		renderPage([], {
			data: [],
			isLoading: false,
			error: new Error("connections request failed"),
		});

		expect(
			await screen.findByText("Failed to load connections."),
		).toBeInTheDocument();
	});

	it("names the catalogue 'connections' in the no-match empty state", async () => {
		const user = userEvent.setup();
		renderPage();

		await screen.findByRole("link", { name: /Databricks Vector Search/i });

		await user.type(
			screen.getByPlaceholderText("Search connections"),
			"zzzz",
		);

		expect(
			screen.getByText("No connections match your current filters."),
		).toBeInTheDocument();
	});

	it("labels the search box 'Search connections'", async () => {
		renderPage();

		await screen.findByRole("link", { name: /Databricks Vector Search/i });

		expect(
			screen.getByPlaceholderText("Search connections"),
		).toBeInTheDocument();
	});

	it("keeps the integrations-search onboarding anchor on the search wrapper", async () => {
		const { container } = renderPage();

		await screen.findByRole("link", { name: /Databricks Vector Search/i });

		const anchor = container.querySelector<HTMLElement>(
			'[data-onboarding-target="integrations-search"]',
		);
		expect(anchor).not.toBeNull();
		expect(
			within(anchor as HTMLElement).getByPlaceholderText(
				"Search connections",
			),
		).toBeInTheDocument();
	});
});

describe("ConnectionsPageContent — toolbar placement", () => {
	it("renders toolbarStart above the provider catalogue", async () => {
		renderPageWithToolbar();

		const slot = await screen.findByTestId("toolbar-slot");
		const search = await screen.findByPlaceholderText("Search connections");

		expect(
			slot.compareDocumentPosition(search) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});

describe("ConnectionsPageContent — Linear visibility", () => {
	const TEST_REGISTRY_SERVERS = [
		{
			id: "srv-example",
			key: "example-remote",
			name: "Example MCP",
			category: "Project Management",
		},
		{
			id: "srv-linear",
			key: "linear-remote",
			name: "Linear Remote",
			category: "Project Management",
		},
	];

	it("hides Linear from the connections grid when LINEAR_INTEGRATION is false", async () => {
		listMcpRegistryMock.mockResolvedValue(TEST_REGISTRY_SERVERS);

		renderPage(
			[],
			{ data: [], isLoading: false, error: null },
			{
				LINEAR_INTEGRATION: false,
			},
		);

		await screen.findByRole("link", { name: /GitHub/i });
		await screen.findByText("Example MCP");
		expect(
			screen.queryByRole("link", { name: /Linear/i }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Linear Remote")).not.toBeInTheDocument();
	});

	it("shows Linear in the connections grid when LINEAR_INTEGRATION is true", async () => {
		listMcpRegistryMock.mockResolvedValue(TEST_REGISTRY_SERVERS);

		renderPage(
			[],
			{ data: [], isLoading: false, error: null },
			{
				LINEAR_INTEGRATION: true,
			},
		);

		await screen.findByRole("link", {
			name: /Linear/i,
		});
		await screen.findByText("Linear Remote");
	});
});
