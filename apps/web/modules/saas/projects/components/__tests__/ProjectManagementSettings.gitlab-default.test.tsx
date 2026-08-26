/**
 * Integration test for ProjectManagementSettings — GitLab container defaulting.
 *
 * Verifies that when GitLab REST is selected as the PM tool:
 *   1. The codebase repo (from repository integrations) is pre-selected.
 *   2. A notice is shown when the codebase repo isn't visible in GitLab.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next-intl is mocked globally in vitest.setup.ts

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: () => "/mcp-servers",
	useOrganizationContext: () => ({ organizationName: "Acme" }),
}));

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
	},
}));

// Stub heavy sub-components that are not under test
vi.mock("../pm-integration/GitLabLabelStatusMapEditor", () => ({
	GitLabLabelStatusMapEditor: () => (
		<div data-testid="stub-label-map-editor" />
	),
}));

vi.mock("../pm-integration/PmToolConnectedBanner", () => ({
	PmToolConnectedBanner: () => <div data-testid="stub-pm-connected-banner" />,
}));

// Mock pm-tool-analyzer — the component uses it only for MCP (non-REST) paths
vi.mock("../lib/pm-tool-analyzer", () => ({
	analyzePMToolCapabilities: vi.fn(() => ({
		hasPMCapabilities: false,
		containerHierarchy: [],
		detectedType: null,
	})),
	fetchContainersWithHierarchy: vi.fn(async () => ({
		containers: [],
		additionalContext: {},
	})),
	containerIdFieldHint: vi.fn(() => undefined),
}));

const listMock = vi.fn();
const listReposMock = vi.fn();
const availablePmToolsMock = vi.fn();
const repoIntegrationsListMock = vi.fn();
const pmCapabilitiesMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			configs: { list: (...a: unknown[]) => listMock(...a) },
			availablePmTools: {
				list: (...a: unknown[]) => availablePmToolsMock(...a),
			},
			tools: {
				list: vi.fn(async () => ({ tools: [] })),
			},
		},
		projects: {
			gitlab: { listRepos: (...a: unknown[]) => listReposMock(...a) },
			repositoryIntegrations: {
				list: (...a: unknown[]) => repoIntegrationsListMock(...a),
			},
			stories: {
				pmCapabilities: (...a: unknown[]) => pmCapabilitiesMock(...a),
				testPMSync: vi.fn(async () => ({
					success: false,
					message: "",
				})),
				listProjectTeams: vi.fn(async () => ({
					teams: [],
					error: null,
				})),
				listProjectWorkItemTypes: vi.fn(async () => ({
					workItemTypes: [],
					error: null,
				})),
				getTeamFieldValues: vi.fn(async () => ({ defaultArea: null })),
				statuses: {
					list: vi.fn(async () => ({ statuses: [] })),
				},
			},
			update: vi.fn(async (d: unknown) => d),
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryKey: (args: { input: unknown }) => [
					"projects.get",
					args.input,
				],
			},
		},
	},
}));

// Stub PMToolSelect — isolates this test from the picker's own query graph.
// We only care about what happens in ProjectManagementSettings after GitLab
// REST has been chosen, so the stub fires the onChange immediately on click.
// The stub also simulates the real component's "resolve already-persisted PM
// tool on mount" behavior via a useEffect so initial-load tests can exercise
// the preserveSelection=true path.
vi.mock("../pm-tool-select", () => ({
	PMToolSelect: ({
		onChange,
		onResolvedSelection,
		selectedMcpServerId,
	}: {
		onChange: (next: {
			mcpConfigId: string | null;
			mcpServerId: string | null;
			isDefault: boolean;
			isConfigured: boolean;
			transport: "rest" | "mcp" | null;
		}) => void;
		onResolvedSelection?: (info: {
			transport: "mcp" | "rest" | null;
			mcpServerId: string | null;
			mcpConfigId: string | null;
		}) => void;
		selectedMcpServerId?: string | null;
		[key: string]: unknown;
	}) => {
		// Simulate the real component's "resolve already-persisted PM tool on mount"
		// behavior so initial-load tests can exercise the preserveSelection=true path.
		// ProjectManagementSettings initialises selectedMcpServerId from
		// project.projectManagementMcpServerId and passes it down as a prop.
		useEffect(() => {
			if (
				selectedMcpServerId === "gitlab-official" &&
				onResolvedSelection
			) {
				onResolvedSelection({
					mcpConfigId: null,
					mcpServerId: "gitlab-official",
					transport: "rest",
				});
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [selectedMcpServerId]);
		return (
			<button
				type="button"
				data-testid="stub-pick-gitlab-rest"
				onClick={() =>
					onChange({
						mcpConfigId: null,
						mcpServerId: "gitlab-official",
						isDefault: true,
						isConfigured: false,
						transport: "rest",
					})
				}
			>
				pick gitlab
			</button>
		);
	},
}));

import { ProjectManagementSettings } from "../ProjectManagementSettings";

const baseProject = {
	id: "proj_1",
	name: "Demo",
	organizationId: null,
	projectManagementMcpServerId: null,
	projectManagementMcpConfigId: null,
	projectManagementContainerId: null,
	projectManagementContainerName: null,
	projectManagementAdditionalContext: null,
	autoPushPmSync: false,
	userRole: "owner",
};

function renderWithClient(project = baseProject) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const result = render(
		<QueryClientProvider client={client}>
			<ProjectManagementSettings project={project} />
		</QueryClientProvider>,
	);
	return { ...result, client };
}

beforeEach(() => {
	listMock.mockResolvedValue([]);
	pmCapabilitiesMock.mockResolvedValue({
		configured: true,
		capabilities: null,
		containerName: null,
		detectedType: "gitlab-rest",
		mcpConfigId: null,
		containerId: null,
		additionalContext: null,
		error: null,
	});
	availablePmToolsMock.mockResolvedValue([
		{ key: "gitlab-official", available: true, transport: "rest" },
	]);
	listReposMock.mockResolvedValue({
		configured: true,
		groups: [
			{
				name: "myorg",
				repos: [
					{ fullName: "myorg/repo-a" },
					{ fullName: "myorg/repo-b" },
				],
			},
		],
	});
	repoIntegrationsListMock.mockResolvedValue({
		integrations: [
			{
				provider: "GITLAB",
				repositoryOwner: "myorg",
				repositoryName: "repo-a",
			},
		],
	});
});

let lastClient: QueryClient | null = null;

afterEach(() => {
	vi.clearAllMocks();
	lastClient?.clear();
	lastClient = null;
});

describe("ProjectManagementSettings — GitLab container default", () => {
	it("pre-selects the codebase repo as the GitLab container", async () => {
		const user = userEvent.setup();
		const { client } = renderWithClient();
		lastClient = client;

		await user.click(screen.getByTestId("stub-pick-gitlab-rest"));

		// After both the repoIntegrations query AND the GitLab repos query have
		// resolved and state has committed, the SelectTrigger (role="combobox")
		// must display the pre-selected "myorg/repo-a" as its text content.
		// This assertion is stronger than queryByText — it only matches the
		// trigger's rendered selected value, not hidden SelectItem options.
		await waitFor(() => {
			expect(screen.getByRole("combobox")).toHaveTextContent(
				"myorg/repo-a",
			);
		});

		expect(screen.queryByTestId("gitlab-pm-container-notice")).toBeNull();
	});

	it("shows a notice when the codebase repo is not visible in GitLab", async () => {
		repoIntegrationsListMock.mockResolvedValue({
			integrations: [
				{
					provider: "GITLAB",
					repositoryOwner: "other-org",
					repositoryName: "missing-repo",
				},
			],
		});

		const user = userEvent.setup();
		const { client } = renderWithClient();
		lastClient = client;

		await user.click(screen.getByTestId("stub-pick-gitlab-rest"));

		// After both queries resolve and state commits, the notice element must
		// be present and mention the codebase repo path.
		await waitFor(() => {
			const notice = screen.queryByTestId("gitlab-pm-container-notice");
			expect(notice).not.toBeNull();
			expect(notice?.textContent ?? "").toContain(
				"other-org/missing-repo",
			);
		});
	});

	it("defaults the codebase repo on initial load when the saved container id is numeric (legacy auto-wire format)", async () => {
		// Staging scenario: project was auto-wired with a numeric GitLab project id.
		// On initial mount the stub fires onResolvedSelection (simulating the real
		// PMToolSelect resolving the persisted "gitlab-official" server id), which
		// triggers fetchGitLabRestContainers(preserveSelection=true).  Because the
		// saved numeric id ("12345") is not in the fetched repo list, the
		// preserveSelection guard falls through to pickDefaultGitLabContainer which
		// recovers via the codebase repo path.
		const projectWithNumericSavedId = {
			...baseProject,
			projectManagementMcpServerId: "gitlab-official",
			projectManagementContainerId: "12345",
		};

		const { client } = renderWithClient(projectWithNumericSavedId);
		lastClient = client;

		await waitFor(() => {
			expect(screen.getByRole("combobox")).toHaveTextContent(
				"myorg/repo-a",
			);
		});

		expect(screen.queryByTestId("gitlab-pm-container-notice")).toBeNull();
	});

	it("preserves a saved container id on initial load when it still maps to a fetched repo (does not clobber with codebase default)", async () => {
		// The project has a saved container id that IS present in the fetched list
		// ("myorg/repo-b"). Even though the codebase repo is "myorg/repo-a", the
		// picker must keep the user's explicit saved choice.
		const projectWithValidSavedId = {
			...baseProject,
			projectManagementMcpServerId: "gitlab-official",
			projectManagementContainerId: "myorg/repo-b",
		};

		const { client } = renderWithClient(projectWithValidSavedId);
		lastClient = client;

		await waitFor(() => {
			expect(screen.getByRole("combobox")).toHaveTextContent(
				"myorg/repo-b",
			);
		});
	});

	it("does not render the notice when the GitLab repos query errors out", async () => {
		// Codebase pointer is set, but listRepos fails — the catch sets `error`
		// which must suppress the notice (notice renders only when !error).
		repoIntegrationsListMock.mockResolvedValue({
			integrations: [
				{
					provider: "GITLAB",
					repositoryOwner: "other-org",
					repositoryName: "missing-repo",
				},
			],
		});
		listReposMock.mockRejectedValue(new Error("GitLab REST 500"));

		const { client, getByTestId } = renderWithClient();
		lastClient = client;
		getByTestId("stub-pick-gitlab-rest").click();

		await waitFor(() => {
			expect(screen.queryByText("GitLab REST 500")).not.toBeNull();
		});

		expect(screen.queryByTestId("gitlab-pm-container-notice")).toBeNull();
	});

	it("defaults to the most-recently-added GitLab integration row when a project has multiple GitLab repos connected", async () => {
		// listProjectRepoIntegrations uses orderBy: { createdAt: "desc" }, so the
		// first element in the returned array is the most-recently-added row.
		// pickDefaultGitLabContainer uses .find() which returns the first match,
		// so "myorg/repo-a" (index 0) wins even though "myorg/repo-b" is also present.
		repoIntegrationsListMock.mockResolvedValue({
			integrations: [
				{
					provider: "GITLAB",
					repositoryOwner: "myorg",
					repositoryName: "repo-a",
				},
				{
					provider: "GITLAB",
					repositoryOwner: "myorg",
					repositoryName: "repo-b",
				},
			],
		});

		const user = userEvent.setup();
		const { client } = renderWithClient();
		lastClient = client;

		await user.click(screen.getByTestId("stub-pick-gitlab-rest"));

		await waitFor(() => {
			expect(screen.getByRole("combobox")).toHaveTextContent(
				"myorg/repo-a",
			);
		});
	});

	it("labels the connected-config card 'via GitLab' for a GitLab REST project (no MCPConfig)", async () => {
		// GitLab REST has no MCPConfig, so the card's MCP-server-name subtitle is
		// null. The provider-name fallback must still render "via GitLab" so the
		// card doesn't show "Connected to {board}" with a blank subtitle.
		const connectedRestProject = {
			...baseProject,
			projectManagementMcpServerId: "gitlab-official",
			projectManagementContainerId: "myorg/repo-a",
			projectManagementContainerName: "myorg/repo-a",
		};

		const { client } = renderWithClient(connectedRestProject);
		lastClient = client;

		await waitFor(() => {
			expect(screen.getByText("Connected to myorg/repo-a")).toBeTruthy();
			expect(screen.getByText("via GitLab")).toBeTruthy();
		});
	});

	it("announces the not-visible notice as a polite live region", async () => {
		repoIntegrationsListMock.mockResolvedValue({
			integrations: [
				{
					provider: "GITLAB",
					repositoryOwner: "other-org",
					repositoryName: "missing-repo",
				},
			],
		});

		const user = userEvent.setup();
		const { client } = renderWithClient();
		lastClient = client;

		await user.click(screen.getByTestId("stub-pick-gitlab-rest"));

		const notice = await screen.findByTestId("gitlab-pm-container-notice");
		expect(notice.getAttribute("role")).toBe("status");
		expect(notice.getAttribute("aria-live")).toBe("polite");
	});
});
