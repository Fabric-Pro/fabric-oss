/**
 * Connecting and configuring a PM tool was gated on the raw
 * `project.userRole === "owner"` string, so anyone the server authorizes
 * through PROJECT_SETTINGS_EDIT (a project admin or an org admin) got the
 * "Owner access required" notice and no controls to work with (Fizzy #3007).
 * The card now reads the same server-computed `project.canEditSettings` flag
 * as the rest of project settings. The server gates are unchanged.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: () => "/mcp-servers",
	useOrganizationContext: () => ({ organizationName: "Acme" }),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
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

const listMock = vi.fn();
const listReposMock = vi.fn();
const availablePmToolsMock = vi.fn();
const repoIntegrationsListMock = vi.fn();
const updateMock = vi.fn();
const pmCapabilitiesMock = vi.fn();

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

vi.mock("../pm-tool-select", () => ({
	PMToolSelect: () => <div data-testid="stub-pm-tool-select" />,
}));

import { ProjectManagementSettings } from "../ProjectManagementSettings";

// GitLab REST has no MCPConfig — `detectedType` comes from the backend-
// resolved `pmCapabilities` query (mocked below), not from an MCP config
// match. GitLab-connected because the switch under test (Fizzy #1745)
// renders only for GitLab; this file's cases are about AUTHORIZATION, not
// provider gating.
const baseProject = {
	id: "proj_1",
	name: "Demo",
	organizationId: null,
	projectManagementMcpServerId: "gitlab-official",
	projectManagementMcpConfigId: null,
	projectManagementContainerId: "myorg/repo-a",
	projectManagementContainerName: "myorg/repo-a",
	projectManagementAdditionalContext: null,
	autoPushPmSync: false,
	pmAutoCloseEnabled: false,
	syncAttachments: false,
	userRole: "member",
	canEditSettings: undefined as boolean | undefined,
};

function renderWithClient(project: typeof baseProject) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ProjectManagementSettings project={project} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listMock.mockResolvedValue([]);
	availablePmToolsMock.mockResolvedValue([
		{ key: "fizzy", available: true, transport: "mcp" },
	]);
	listReposMock.mockResolvedValue({ configured: false, groups: [] });
	repoIntegrationsListMock.mockResolvedValue({ integrations: [] });
	pmCapabilitiesMock.mockResolvedValue({ detectedType: "gitlab-rest" });
	vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC", "true");
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe("ProjectManagementSettings — admin access to PM setup", () => {
	const admin = { userRole: "project_admin", canEditSettings: true };
	const notConnected = {
		projectManagementMcpServerId: null as unknown as string,
		projectManagementContainerId: null as unknown as string,
		projectManagementContainerName: null as unknown as string,
	};

	it("lets an admin pick a PM tool on an unconnected project", async () => {
		renderWithClient({ ...baseProject, ...notConnected, ...admin });

		expect(await screen.findByTestId("stub-pm-tool-select")).toBeTruthy();
		expect(screen.queryByText(/access required/i)).toBeNull();
	});

	it("offers an admin Test Sync on a connected project", async () => {
		renderWithClient({ ...baseProject, ...admin });

		expect(
			await screen.findByRole("button", { name: /test sync/i }),
		).toBeTruthy();
	});

	it("offers an admin the sync options an owner gets", async () => {
		renderWithClient({ ...baseProject, ...admin });

		expect(await screen.findByLabelText(/auto-push status/i)).toBeTruthy();
		expect(screen.getByTestId("stub-terminal-status-editor")).toBeTruthy();
	});

	it("names admins, not only owners, in the notice for a member", async () => {
		renderWithClient({
			...baseProject,
			...notConnected,
			userRole: "editor",
			canEditSettings: false,
		});

		expect(await screen.findByText(/admin access required/i)).toBeTruthy();
		expect(screen.queryByTestId("stub-pm-tool-select")).toBeNull();
	});

	it("keeps a member out of the sync options", async () => {
		renderWithClient({
			...baseProject,
			userRole: "editor",
			canEditSettings: false,
		});

		await screen.findByText(/admin access required/i);
		expect(screen.queryByRole("button", { name: /test sync/i })).toBeNull();
		expect(screen.queryByLabelText(/auto-push status/i)).toBeNull();
	});

	it("keeps the setup for a project creator the flag does not cover", async () => {
		renderWithClient({
			...baseProject,
			...notConnected,
			userRole: "owner",
			canEditSettings: false,
		});

		expect(await screen.findByTestId("stub-pm-tool-select")).toBeTruthy();
		expect(screen.queryByText(/access required/i)).toBeNull();
	});

	it("still serves an owner on a payload that predates the flag", async () => {
		renderWithClient({
			...baseProject,
			...notConnected,
			userRole: "owner",
			canEditSettings: undefined,
		});

		expect(await screen.findByTestId("stub-pm-tool-select")).toBeTruthy();
	});
});
