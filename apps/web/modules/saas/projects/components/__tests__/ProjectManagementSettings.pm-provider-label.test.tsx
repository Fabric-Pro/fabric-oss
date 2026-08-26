/**
 * The two PM toggles ("Automatically close work items…" and "Sync attachments
 * with…", Fizzy #1746) named their provider via
 * `getPmProviderLabel(project.projectManagementMcpServerId)`. That column holds
 * the MCP *server id* — a CUID for a normal connection — not a provider key, so
 * the lookup always returned null and both labels silently fell through to the
 * generic "the PM tool", even on a page that says "Connected to … via Fizzy"
 * two rows above.
 *
 * The provider name is already resolved in this component for the connected
 * banner: `pmDetectedTypeDisplayName(pmCapabilities?.detectedType)`, which
 * `getPMCapabilities` normalises across the server-id / sentinel / stale-config
 * id forms. These tests pin both labels to that source, and pin the generic
 * fallback for the case where the provider genuinely cannot be resolved.
 *
 * The attachment-sync row is behind
 * NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC AND (Fizzy #1745) requires
 * the connected tool to be GitLab — it is the only PM tool whose sync path
 * reads `Project.syncAttachments`. The provider-label resolution itself
 * (`pmDetectedTypeDisplayName(pmCapabilities?.detectedType)`) is the same
 * shared logic behind both the attachment-sync AND auto-close labels, so
 * the "unrecognised server id" / "cannot be resolved" cases are pinned via
 * the auto-close label, which is not GitLab-gated; the attachment-sync
 * label itself is pinned separately with a GitLab-connected fixture.
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
			update: vi.fn(),
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
	// A real connection stores the MCP server's CUID here, NOT a provider key.
	// This is exactly the shape that made the old lookup return null.
	projectManagementMcpServerId: "cmjmsyw7x0018r0m645dtohzr",
	projectManagementMcpConfigId: "fizzy-config-id",
	projectManagementContainerId: "fizzy-board",
	projectManagementContainerName: "Fizzy Board",
	projectManagementAdditionalContext: { name: "Demo Fizzy" },
	autoPushPmSync: false,
	pmAutoCloseEnabled: false,
	syncAttachments: false,
	userRole: "owner",
	canEditSettings: true,
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
	pmCapabilitiesMock.mockResolvedValue({ detectedType: "fizzy" });
	vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC", "true");
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe("ProjectManagementSettings — PM provider label (Fizzy #1746)", () => {
	it("names the connected provider in the attachment-sync label", async () => {
		// The attachment-sync switch renders only for GitLab (Fizzy #1745) —
		// unlike the other cases in this file, this fixture must resolve as
		// GitLab for the row to appear at all.
		pmCapabilitiesMock.mockResolvedValue({ detectedType: "gitlab-rest" });
		renderWithClient({
			...baseProject,
			projectManagementMcpServerId: "gitlab-official",
		});
		expect(
			await screen.findByText("Sync attachments with GitLab"),
		).toBeInTheDocument();
	});

	it("names the connected provider in the auto-close label", async () => {
		renderWithClient(baseProject);
		expect(
			await screen.findByText(
				"Automatically close work items that have reached a terminal state in Fizzy",
			),
		).toBeInTheDocument();
	});

	it("resolves the provider from capabilities even for an unrecognised server id", async () => {
		// Pinned via the auto-close label: it shares the same
		// `pmDetectedTypeDisplayName(pmCapabilities?.detectedType)` resolution
		// as the attachment-sync label, but is not GitLab-gated, so an
		// Azure DevOps fixture can still exercise the resolution here.
		pmCapabilitiesMock.mockResolvedValue({ detectedType: "azure-devops" });
		renderWithClient({
			...baseProject,
			projectManagementMcpServerId: "some-unrecognised-sentinel",
		});
		expect(
			await screen.findByText(
				"Automatically close work items that have reached a terminal state in Azure DevOps",
			),
		).toBeInTheDocument();
	});

	it("falls back to the generic wording when the provider cannot be resolved", async () => {
		// Same rationale as above: pinned via the auto-close label so the
		// fallback-to-generic-wording case doesn't require a GitLab fixture.
		pmCapabilitiesMock.mockResolvedValue({ detectedType: null });
		renderWithClient(baseProject);
		expect(
			await screen.findByText(
				"Automatically close work items that have reached a terminal state in the PM tool",
			),
		).toBeInTheDocument();
	});
});
