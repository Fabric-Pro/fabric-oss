/**
 * The "Sync attachments with…" switch (Fizzy #1745/#1746) is gated two ways:
 *
 *   1. An opt-in build-time flag, NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC.
 *   2. The connected PM tool being GitLab. The GitLab REST push path
 *      (`gitlab-rest-story-sync.ts`) is the ONLY reader of
 *      `Project.syncAttachments` — every other PM tool's sync path ignores
 *      the column, so the switch would be a silent no-op for them. Only the
 *      push half has shipped: attachments go TO the linked GitLab issue;
 *      nothing is imported back.
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

const baseProject = {
	id: "proj_1",
	name: "Demo",
	organizationId: null,
	projectManagementMcpServerId: "key:fizzy",
	projectManagementMcpConfigId: "fizzy-config-id",
	projectManagementContainerId: "fizzy-board",
	projectManagementContainerName: "Fizzy Board",
	projectManagementAdditionalContext: { name: "Demo Fizzy" },
	autoPushPmSync: false,
	pmAutoCloseEnabled: false,
	syncAttachments: false,
	userRole: "member",
	canEditSettings: undefined as boolean | undefined,
};

// GitLab REST has no MCPConfig — `detectedType` comes from the backend-
// resolved `pmCapabilities` query instead (see `pmCapabilitiesMock` below).
const gitlabProject = {
	...baseProject,
	projectManagementMcpServerId: "gitlab-official",
	projectManagementMcpConfigId: null,
	projectManagementContainerId: "myorg/repo-a",
	projectManagementContainerName: "myorg/repo-a",
	projectManagementAdditionalContext: null,
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
	// Default: not GitLab (matches `baseProject`, a Fizzy connection).
	pmCapabilitiesMock.mockResolvedValue({
		configured: true,
		capabilities: null,
		containerName: null,
		detectedType: null,
		mcpConfigId: null,
		containerId: null,
		additionalContext: null,
		error: null,
	});
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

const FLAG = "NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC";

describe("ProjectManagementSettings — attachment-sync switch feature gate", () => {
	it("hides the switch when the flag is unset, even for the project owner", async () => {
		vi.stubEnv(FLAG, undefined);
		renderWithClient({ ...baseProject, userRole: "owner" });
		// Wait for the PM-configured content to settle before asserting absence.
		await screen.findByText(/connected to fizzy board/i);
		expect(
			screen.queryByRole("switch", { name: /sync attachments/i }),
		).toBeNull();
	});

	it("hides the switch when the flag is set to a non-enabling value", async () => {
		vi.stubEnv(FLAG, "false");
		renderWithClient({ ...baseProject, userRole: "owner" });
		await screen.findByText(/connected to fizzy board/i);
		expect(
			screen.queryByRole("switch", { name: /sync attachments/i }),
		).toBeNull();
	});

	it("shows the switch when the flag is enabled for a GitLab-connected project", async () => {
		vi.stubEnv(FLAG, "true");
		pmCapabilitiesMock.mockResolvedValue({
			configured: true,
			capabilities: null,
			containerName: "myorg/repo-a",
			detectedType: "gitlab-rest",
			mcpConfigId: null,
			containerId: "myorg/repo-a",
			additionalContext: null,
			error: null,
		});
		renderWithClient({ ...gitlabProject, userRole: "owner" });
		expect(
			await screen.findByRole("switch", { name: /sync attachments/i }),
		).toBeInTheDocument();
	});

	it("hides the switch when the flag is enabled but the connected PM tool is not GitLab (Fizzy #1745 — the only reader is the GitLab REST push path)", async () => {
		vi.stubEnv(FLAG, "true");
		renderWithClient({ ...baseProject, userRole: "owner" });
		// Wait for the PM-configured content to settle before asserting absence.
		await screen.findByText(/connected to fizzy board/i);
		expect(
			screen.queryByRole("switch", { name: /sync attachments/i }),
		).toBeNull();
	});

	it("hides the switch when the flag is enabled but no PM tool is configured", async () => {
		vi.stubEnv(FLAG, "true");
		renderWithClient({
			...baseProject,
			userRole: "owner",
			projectManagementMcpServerId: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		// Wait for the "no PM tool configured" content to settle before
		// asserting absence — the flag alone isn't enough; `isPMConfigured`
		// is a separate leg of the same AND-gate.
		await screen.findByText(/no project management tools configured/i);
		expect(
			screen.queryByRole("switch", { name: /sync attachments/i }),
		).toBeNull();
	});
});
