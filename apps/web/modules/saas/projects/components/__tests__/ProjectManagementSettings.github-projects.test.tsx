/**
 * GitHub Projects in Project Settings: choosing it lists the caller's boards,
 * the chosen board's Status options are mapped to Fabric statuses by name,
 * and Save stores the board, the target repository and the map — and nothing
 * the previous tool left in the PM context.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: () => "/mcp-servers",
	useOrganizationContext: () => ({ organizationName: "Acme" }),
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
const listBoardsMock = vi.fn();
const getBoardMock = vi.fn();
const listReposMock = vi.fn();
const availablePmToolsMock = vi.fn();
const repoIntegrationsListMock = vi.fn();
const updateMock = vi.fn(async (d: unknown) => d);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			configs: { list: (...a: unknown[]) => listMock(...a) },
			availablePmTools: {
				list: (...a: unknown[]) => availablePmToolsMock(...a),
			},
			tools: { list: vi.fn(async () => ({ tools: [] })) },
		},
		projects: {
			gitlab: { listRepos: (...a: unknown[]) => listReposMock(...a) },
			github: {
				listProjectBoards: (...a: unknown[]) => listBoardsMock(...a),
				getProjectBoard: (...a: unknown[]) => getBoardMock(...a),
			},
			repositoryIntegrations: {
				list: (...a: unknown[]) => repoIntegrationsListMock(...a),
			},
			stories: {
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
					list: vi.fn(async () => ({
						statuses: [
							{ id: "st_todo", name: "Todo" },
							{ id: "st_progress", name: "In Progress" },
							{ id: "st_done", name: "Done" },
						],
					})),
				},
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

vi.mock("../pm-tool-select", () => ({
	PMToolSelect: ({
		onChange,
	}: {
		onChange: (next: {
			key: string | null;
			mcpConfigId: string | null;
			mcpServerId: string | null;
			isDefault: boolean;
			isConfigured: boolean;
			transport: "rest" | "mcp" | null;
		}) => void;
		[key: string]: unknown;
	}) => (
		<button
			type="button"
			data-testid="stub-pick-github"
			onClick={() =>
				onChange({
					key: "github-remote",
					mcpConfigId: null,
					mcpServerId: "srv_github",
					isDefault: true,
					isConfigured: true,
					transport: "rest",
				})
			}
		>
			pick github
		</button>
	),
}));

import { ProjectManagementSettings } from "../ProjectManagementSettings";

const fizzyProject = {
	id: "proj_1",
	name: "Demo",
	organizationId: null,
	projectManagementMcpServerId: "key:fizzy",
	projectManagementMcpConfigId: "fizzy-config-id",
	projectManagementContainerId: "old-fizzy-board",
	projectManagementContainerName: "Old Fizzy Board",
	projectManagementAdditionalContext: {
		name: "Example Workspace",
		account_slug: "/000000",
	},
	autoPushPmSync: false,
	userRole: "owner",
};

let lastClient: QueryClient | null = null;

beforeEach(() => {
	listMock.mockResolvedValue([]);
	availablePmToolsMock.mockResolvedValue([]);
	repoIntegrationsListMock.mockResolvedValue({ integrations: [] });
	listBoardsMock.mockResolvedValue({
		boards: [
			{
				id: "PVT_board",
				number: 3,
				title: "Roadmap",
				url: "https://github.com/orgs/example-org/projects/3",
				ownerLogin: "example-org",
				ownerType: "Organization",
				closed: false,
			},
		],
		readsPersonalBoards: true,
	});
	getBoardMock.mockResolvedValue({
		board: {
			id: "PVT_board",
			number: 3,
			title: "Roadmap",
			url: "https://github.com/orgs/example-org/projects/3",
			ownerLogin: "example-org",
			ownerType: "Organization",
			closed: false,
		},
		statusOptions: [
			{ label: "Status::Todo", optionName: "Todo" },
			{ label: "Status::In Progress", optionName: "In Progress" },
			{ label: "Status::Done", optionName: "Done" },
			{ label: "Status::Blocked", optionName: "Blocked" },
		],
		repositories: ["example-org/app"],
		issueTypes: [],
	});
});

afterEach(() => {
	vi.clearAllMocks();
	lastClient?.clear();
	lastClient = null;
});

describe("ProjectManagementSettings — GitHub Projects", () => {
	it("saves the board, its repository and the name-seeded Status map", async () => {
		const user = userEvent.setup();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		lastClient = client;
		render(
			<QueryClientProvider client={client}>
				<ProjectManagementSettings project={fizzyProject} />
			</QueryClientProvider>,
		);

		await user.click(
			await screen.findByRole("button", { name: /change board/i }),
		);
		await user.click(screen.getByTestId("stub-pick-github"));

		await waitFor(() => {
			expect(listBoardsMock).toHaveBeenCalledWith({
				organizationId: null,
				// No saved credential chosen: the person's own connection.
				credentialId: null,
			});
		});
		await user.click(await screen.findByRole("combobox"));
		await user.click(
			await screen.findByRole("option", {
				name: "example-org / Roadmap (#3)",
			}),
		);

		await waitFor(() => {
			expect(
				screen.getByLabelText(/repository for new issues/i),
			).toHaveTextContent("example-org/app");
		});

		await user.click(
			screen.getByRole("button", { name: /save settings/i }),
		);
		await waitFor(() => {
			expect(updateMock).toHaveBeenCalled();
		});

		const payload = updateMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(payload.projectManagementMcpServerId).toBe("srv_github");
		expect(payload.projectManagementMcpConfigId).toBeNull();
		expect(payload.projectManagementContainerId).toBe("PVT_board");
		// The Fizzy account context is gone; Blocked has no namesake.
		expect(payload.projectManagementAdditionalContext).toEqual({
			githubRepository: "example-org/app",
			labelStatusMap: {
				"Status::Todo": "st_todo",
				"Status::In Progress": "st_progress",
				"Status::Done": "st_done",
			},
		});
	});
	it.each([
		[true, /Create a board in GitHub Projects/],
		[false, /Connect a classic token with the repo and project scopes/],
	])(
		"says why no board is listed (token reads personal boards: %s)",
		async (readsPersonalBoards, message) => {
			listBoardsMock.mockResolvedValueOnce({
				boards: [],
				readsPersonalBoards,
			});
			const user = userEvent.setup();
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			lastClient = client;
			render(
				<QueryClientProvider client={client}>
					<ProjectManagementSettings project={fizzyProject} />
				</QueryClientProvider>,
			);

			await user.click(
				await screen.findByRole("button", { name: /change board/i }),
			);
			await user.click(screen.getByTestId("stub-pick-github"));

			expect(await screen.findByText(message)).toBeInTheDocument();
		},
	);
});
