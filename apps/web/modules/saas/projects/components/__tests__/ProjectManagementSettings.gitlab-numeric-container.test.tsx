/**
 * D1.1b (Fizzy #2304): the GitLab REST picker keeps a container saved as
 * GitLab's numeric project id. Keeping that repo selected saves the numeric id
 * unchanged — so the save is not read as a container change that switches the
 * hourly poll off — another repo saves its own path, and a numeric id the
 * listing does not include stays selectable instead of being replaced by the
 * codebase repo.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: () => "/mcp-servers",
	useOrganizationContext: () => ({ organizationName: "Example Org" }),
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../pm-integration/GitLabLabelStatusMapEditor", () => ({
	GitLabLabelStatusMapEditor: () => (
		<div data-testid="stub-label-map-editor" />
	),
}));

vi.mock("../pm-integration/PmToolConnectedBanner", () => ({
	PmToolConnectedBanner: () => <div data-testid="stub-pm-connected-banner" />,
}));

vi.mock("../pm-integration/TerminalStatusEditor", () => ({
	TerminalStatusEditor: () => (
		<div data-testid="stub-terminal-status-editor" />
	),
}));

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

const listReposMock = vi.fn();
const repoIntegrationsListMock = vi.fn();
const pmCapabilitiesMock = vi.fn();
const updateMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			configs: { list: vi.fn(async () => []) },
			availablePmTools: {
				list: vi.fn(async () => [
					{
						key: "gitlab-official",
						available: true,
						transport: "rest",
					},
				]),
			},
			tools: { list: vi.fn(async () => ({ tools: [] })) },
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
				statuses: { list: vi.fn(async () => ({ statuses: [] })) },
			},
			update: (d: unknown) => updateMock(d),
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

// Mirrors the real picker resolving the persisted tool on mount, which is what
// sends the settings card down the preserveSelection=true path.
vi.mock("../pm-tool-select", () => ({
	PMToolSelect: ({
		onResolvedSelection,
		selectedMcpServerId,
	}: {
		onResolvedSelection?: (info: {
			transport: "mcp" | "rest" | null;
			mcpServerId: string | null;
			mcpConfigId: string | null;
		}) => void;
		selectedMcpServerId?: string | null;
		[key: string]: unknown;
	}) => {
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
		return <div data-testid="stub-pm-tool-select" />;
	},
}));

import { ProjectManagementSettings } from "../ProjectManagementSettings";

const savedNumericProject = {
	id: "proj_1",
	name: "Demo",
	organizationId: null,
	projectManagementMcpServerId: "gitlab-official",
	projectManagementMcpConfigId: null,
	projectManagementContainerId: "12345",
	projectManagementContainerName: "myorg/repo-b",
	projectManagementAdditionalContext: null,
	autoPushPmSync: false,
	userRole: "owner",
};

let lastClient: QueryClient | null = null;

function renderSettings(project = savedNumericProject) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	lastClient = client;
	return render(
		<QueryClientProvider client={client}>
			<ProjectManagementSettings project={project} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	pmCapabilitiesMock.mockResolvedValue({
		configured: true,
		capabilities: null,
		containerName: "myorg/repo-b",
		detectedType: "gitlab-rest",
		mcpConfigId: null,
		containerId: "12345",
		additionalContext: null,
		error: null,
	});
	listReposMock.mockResolvedValue({
		configured: true,
		groups: [
			{
				owner: "myorg",
				ownerType: "org",
				repos: [
					{ fullName: "myorg/repo-a", numericId: 11111 },
					{ fullName: "myorg/repo-b", numericId: 12345 },
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
	updateMock.mockResolvedValue({ project: savedNumericProject });
});

afterEach(() => {
	vi.clearAllMocks();
	lastClient?.clear();
	lastClient = null;
});

describe("ProjectManagementSettings — numeric GitLab container (D1.1b)", () => {
	it("saves the numeric id unchanged when the same repo stays selected", async () => {
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			await screen.findByRole("button", { name: "Change board" }),
		);
		await waitFor(() => {
			expect(screen.getByRole("combobox")).toHaveTextContent(
				"myorg/repo-b",
			);
		});
		await user.click(screen.getByRole("button", { name: "Save Settings" }));

		await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
		expect(updateMock.mock.calls[0][0]).toMatchObject({
			projectManagementMcpServerId: "gitlab-official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "12345",
			projectManagementContainerName: "myorg/repo-b",
		});
	});

	it("saves another repo's own path when the user picks it", async () => {
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			await screen.findByRole("button", { name: "Change board" }),
		);
		await waitFor(() => {
			expect(screen.getByRole("combobox")).toHaveTextContent(
				"myorg/repo-b",
			);
		});
		await user.click(screen.getByRole("combobox"));
		await user.click(
			await screen.findByRole("option", { name: "myorg/repo-a" }),
		);
		expect(screen.getByRole("combobox")).toHaveTextContent("myorg/repo-a");
		await user.click(screen.getByRole("button", { name: "Save Settings" }));

		await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
		expect(updateMock.mock.calls[0][0]).toMatchObject({
			projectManagementContainerId: "myorg/repo-a",
			projectManagementContainerName: "myorg/repo-a",
		});
	});

	it("keeps a numeric id the listing does not include as 'Current project' instead of the codebase repo", async () => {
		const user = userEvent.setup();
		renderSettings({
			...savedNumericProject,
			projectManagementContainerId: "99999",
			projectManagementContainerName: "legacy-group/legacy-project",
		});

		await user.click(
			await screen.findByRole("button", { name: "Change board" }),
		);
		await waitFor(() => {
			expect(screen.getByRole("combobox")).toHaveTextContent(
				"Current project (legacy-group/legacy-project)",
			);
		});
		// Positive control: the codebase repo WAS listed, so it could have been
		// preselected — and was not.
		await user.click(screen.getByRole("combobox"));
		expect(
			await screen.findByRole("option", { name: "myorg/repo-a" }),
		).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(screen.getByRole("combobox")).toHaveTextContent(
			"Current project (legacy-group/legacy-project)",
		);

		await user.click(screen.getByRole("button", { name: "Save Settings" }));
		await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
		expect(updateMock.mock.calls[0][0]).toMatchObject({
			projectManagementContainerId: "99999",
			projectManagementContainerName: "legacy-group/legacy-project",
		});
	});

	it("shows a short label-map description on the card, not 'first matching label' (D1.8)", async () => {
		// The detailed matching/application rules live once, in the editor's
		// own help copy (`GitLabLabelStatusMapEditor`'s `LABEL_MAP_RULES`,
		// pinned by its own test) — not repeated on this card.
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			await screen.findByRole("button", { name: "Change board" }),
		);
		expect(
			await screen.findByText(
				/Map GitLab issue labels to the Kanban status they represent\./,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/first matching label/)).toBeNull();
	});
});
