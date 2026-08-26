/**
 * Provider-switch save semantics for ProjectManagementSettings.
 *
 * When a user switches from one PM tool to another (e.g. Fizzy → GitLab REST),
 * the save mutation must send `null` (not `undefined`) for fields that the new
 * provider does not use, so Prisma actually clears the stale columns instead
 * of skipping them.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		}, [selectedMcpServerId, onResolvedSelection]);
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

function renderWithClient(project = fizzyProject) {
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
	availablePmToolsMock.mockResolvedValue([
		{ key: "gitlab-official", available: true, transport: "rest" },
	]);
	listReposMock.mockResolvedValue({
		configured: true,
		groups: [
			{
				name: "myorg",
				repos: [{ fullName: "myorg/repo-a" }],
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

describe("ProjectManagementSettings — provider switch clears stale fields", () => {
	it("sends null (not undefined) for projectManagementMcpConfigId and projectManagementAdditionalContext when switching from Fizzy to GitLab REST", async () => {
		const user = userEvent.setup();
		const { client } = renderWithClient();
		lastClient = client;

		// Enter "change board" mode so the picker renders
		await user.click(
			await screen.findByRole("button", { name: /change board/i }),
		);

		// Pick GitLab REST — this clears the Fizzy MCPConfig in local state
		await user.click(screen.getByTestId("stub-pick-gitlab-rest"));

		// Wait for the codebase repo default to land in the trigger
		await waitFor(() => {
			expect(screen.getByRole("combobox")).toHaveTextContent(
				"myorg/repo-a",
			);
		});

		// Click Save Settings
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

		// The bug: `?? undefined` collapses these to undefined, which Prisma
		// treats as "do not change," so the Fizzy values linger on the row.
		// After the fix, they must arrive at the API as explicit null.
		expect(payload.projectManagementMcpConfigId).toBeNull();
		expect(payload.projectManagementAdditionalContext).toBeNull();
		expect(payload.projectManagementMcpServerId).toBe("gitlab-official");
		expect(payload.projectManagementContainerId).toBe("myorg/repo-a");
	});
});
