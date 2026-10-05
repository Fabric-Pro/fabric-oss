/**
 * The GitLab provider page reads the person's one GitLab connection state
 * (`gitlab.status().state`, the same state every other GitLab screen shows)
 * and lists the organization's project repository links separately, each
 * disconnected through the project's own repository disconnect.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { gitlabStatus, listIntegrations, listRepositoryLinks, disconnectLink } =
	vi.hoisted(() => ({
		gitlabStatus: vi.fn(),
		listIntegrations: vi.fn(),
		listRepositoryLinks: vi.fn(),
		disconnectLink: vi.fn(),
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
vi.mock("@saas/workflows/lib/plugins", () => ({
	getIntegration: () => ({
		type: "GITLAB",
		label: "GitLab",
		actions: [
			{
				slug: "create-issue",
				label: "Create issue",
				description: "Create an issue",
				category: "issues",
			},
		],
	}),
}));
vi.mock("@saas/workflows/components/integrations/IntegrationBrandIcon", () => ({
	IntegrationBrandIcon: () => null,
}));
vi.mock(
	"@saas/workflows/components/integrations/IntegrationSharingControls",
	() => ({ IntegrationSharingControls: () => null }),
);
vi.mock("../IntegrationIncidentDrawer", () => ({
	IntegrationIncidentDrawer: () => null,
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: { integrations: { list: listIntegrations } },
		integrations: {
			gitlab: {
				status: gitlabStatus,
				listRepositoryLinks,
				recheckCapabilities: vi.fn(),
			},
		},
		projects: { repositoryIntegrations: { disconnect: disconnectLink } },
	},
}));

import { IntegrationProviderPageContent } from "../IntegrationProviderPageContent";

function personalRow(hasCredentials: boolean) {
	return {
		id: "wi-example",
		provider: "GITLAB",
		name: "GitLab",
		hasCredentials,
	};
}

function renderGitLabPage() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<IntegrationProviderPageContent
				provider="GITLAB"
				settingsBasePath="/app/example/settings/integrations"
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	listRepositoryLinks.mockResolvedValue({ links: [] });
	disconnectLink.mockResolvedValue({ success: true });
});

describe("IntegrationProviderPageContent — GitLab connection state", () => {
	it("is not configured when the service says not connected, even if the list row still has a credential", async () => {
		listIntegrations.mockResolvedValue({
			integrations: [personalRow(true)],
		});
		gitlabStatus.mockResolvedValue({
			connected: false,
			state: "not-connected",
		});

		renderGitLabPage();

		await waitFor(() => expect(gitlabStatus).toHaveBeenCalled());
		await screen.findByText(
			"Set up runtime credentials if you want Fabric to call this provider live.",
		);
		expect(screen.queryByText("Configured")).not.toBeInTheDocument();
		expect(
			screen.queryByText("Reconnect required"),
		).not.toBeInTheDocument();
	});

	it("asks to reconnect when the service says the connection needs reconnecting", async () => {
		listIntegrations.mockResolvedValue({
			integrations: [personalRow(false)],
		});
		gitlabStatus.mockResolvedValue({
			connected: true,
			needsReauth: true,
			state: "needs-reconnect",
		});

		renderGitLabPage();

		expect(
			await screen.findByText("Reconnect required"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Reconnect GitLab" }),
		).toBeInTheDocument();
		expect(screen.queryByText("Configured")).not.toBeInTheDocument();
	});

	it("is configured when the service says connected", async () => {
		listIntegrations.mockResolvedValue({
			integrations: [personalRow(true)],
		});
		gitlabStatus.mockResolvedValue({
			connected: true,
			needsReauth: false,
			state: "connected",
		});

		renderGitLabPage();

		expect(await screen.findByText("Configured")).toBeInTheDocument();
	});
});

describe("IntegrationProviderPageContent — GitLab project repository links", () => {
	beforeEach(() => {
		listIntegrations.mockResolvedValue({ integrations: [] });
		gitlabStatus.mockResolvedValue({
			connected: false,
			state: "not-connected",
		});
	});

	it("lists the links separately from the personal connection and disconnects one through the project route", async () => {
		listRepositoryLinks.mockResolvedValue({
			links: [
				{
					id: "pri-editable",
					projectId: "project-a",
					projectName: "Example Project A",
					repositoryOwner: "example-group",
					repositoryName: "service-a",
					repositoryUrl:
						"https://gitlab.example.com/example-group/service-a",
					authMethod: "OAUTH",
					status: "ACTIVE",
					canDisconnect: true,
				},
				{
					id: "pri-readonly",
					projectId: "project-b",
					projectName: "Example Project B",
					repositoryOwner: "example-group",
					repositoryName: "service-b",
					repositoryUrl:
						"https://gitlab.example.com/example-group/service-b",
					authMethod: "OAUTH",
					status: "ACTIVE",
					canDisconnect: false,
				},
			],
		});

		renderGitLabPage();

		const list = await screen.findByRole("list", {
			name: "GitLab project repository links",
		});
		expect(list).toHaveTextContent("example-group/service-a");
		expect(list).toHaveTextContent("example-group/service-b");
		expect(listRepositoryLinks).toHaveBeenCalledWith({
			organizationId: "org-example",
		});
		expect(
			screen.getByText(/separate from your personal GitLab connection/),
		).toBeInTheDocument();
		// Only the link the person may edit offers a disconnect.
		expect(
			screen.queryByRole("button", {
				name: "Disconnect example-group/service-b from Example Project B",
			}),
		).not.toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Disconnect example-group/service-a from Example Project A",
			}),
		);
		expect(
			await screen.findByText(
				/Your own GitLab connection is not affected\./,
			),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

		await waitFor(() =>
			expect(disconnectLink).toHaveBeenCalledWith({
				projectId: "project-a",
				integrationId: "pri-editable",
				organizationId: "org-example",
			}),
		);
	});

	it("says so when no accessible project has a link", async () => {
		renderGitLabPage();

		expect(
			await screen.findByText(
				"No project you can access has a GitLab repository link.",
			),
		).toBeInTheDocument();
	});
});
