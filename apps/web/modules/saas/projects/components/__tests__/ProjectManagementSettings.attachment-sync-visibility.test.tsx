/**
 * The "Sync attachments with…" switch (Fizzy #1746) used to render only for
 * `project.userRole === "owner"`. The server's PROJECT_UPDATE gate on this
 * mutation accepts owner OR PROJECT_SETTINGS_EDIT, so a project admin or org
 * admin the server authorizes to flip this setting got no control at all to
 * do it with. The fix reads the same server-computed `project.canEditSettings`
 * flag the adjacent read-only-mode setting (ProjectSettings.tsx) already uses.
 *
 * These cases are about AUTHORIZATION, so each one enables
 * NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC first — the switch is
 * otherwise hidden in every environment while the sync engine is unbuilt.
 * The gate itself is covered in ProjectManagementSettings.attachment-sync-flag.test.tsx.
 *
 * The switch also requires the connected PM tool to be GitLab (Fizzy #1745
 * — the GitLab REST push path is the only reader of
 * `Project.syncAttachments`), so `baseProject` here is GitLab-connected —
 * this file is testing authorization, not provider gating, which has its
 * own coverage in ProjectManagementSettings.attachment-sync-flag.test.tsx.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

describe("ProjectManagementSettings — attachment-sync switch visibility (Finding 3)", () => {
	it("shows the switch for the project owner", async () => {
		renderWithClient({ ...baseProject, userRole: "owner" });
		expect(
			await screen.findByRole("switch", { name: /sync attachments/i }),
		).toBeInTheDocument();
	});

	it("hides the switch for a non-owner with no canEditSettings flag (legacy payload)", async () => {
		renderWithClient({
			...baseProject,
			userRole: "member",
			canEditSettings: undefined,
		});
		// Wait for the PM-configured content to settle before asserting absence.
		await screen.findByText(/connected to myorg\/repo-a/i);
		expect(
			screen.queryByRole("switch", { name: /sync attachments/i }),
		).toBeNull();
	});

	it("shows the switch for a non-owner project/org admin the server authorizes (canEditSettings: true)", async () => {
		renderWithClient({
			...baseProject,
			userRole: "member",
			canEditSettings: true,
		});
		expect(
			await screen.findByRole("switch", { name: /sync attachments/i }),
		).toBeInTheDocument();
	});

	it("hides the switch when the server explicitly denies edit access (canEditSettings: false), even if userRole looks elevated", async () => {
		renderWithClient({
			...baseProject,
			userRole: "owner",
			canEditSettings: false,
		});
		expect(
			screen.queryByRole("switch", { name: /sync attachments/i }),
		).toBeNull();
	});
});
