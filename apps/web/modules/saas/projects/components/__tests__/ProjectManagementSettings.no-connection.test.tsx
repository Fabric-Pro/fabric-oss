/**
 * PM settings before a PM tool is connected (Fizzy #2204, decided 2026-09-23).
 *
 * The owner still sees the auto-push and auto-close switches and the terminal
 * statuses editor — the settings that decide what counts as done — but they
 * are disabled with "connect a PM tool first", read from the project fields the
 * component already has. A save that connects, disconnects or changes the
 * board also refreshes the capability gates, whose Roadmap PM rules read it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
	TerminalStatusEditor: ({
		disabled,
		describedBy,
	}: {
		disabled?: boolean;
		describedBy?: string;
	}) => (
		<div
			data-testid="stub-terminal-status-editor"
			data-disabled={String(disabled === true)}
			data-described-by={describedBy ?? ""}
		/>
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
import { PM_SETTINGS_ANCHOR_ID } from "../settings-tab-navigation";

const unconnected = {
	id: "proj_1",
	name: "Demo",
	organizationId: null,
	projectManagementMcpServerId: null,
	projectManagementMcpConfigId: null,
	projectManagementContainerId: null,
	projectManagementContainerName: null,
	projectManagementAdditionalContext: null,
	autoPushPmSync: false,
	pmAutoCloseEnabled: false,
	userRole: "owner",
};

const connected = {
	...unconnected,
	projectManagementMcpServerId: "key:fizzy",
	projectManagementMcpConfigId: "fizzy-config-id",
	projectManagementContainerId: "fizzy-board",
	projectManagementContainerName: "Fizzy Board",
	projectManagementAdditionalContext: { name: "Demo Fizzy" },
};

let client: QueryClient;

function renderWith(project: typeof unconnected) {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
	pmCapabilitiesMock.mockResolvedValue({
		configured: false,
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
	client?.clear();
});

describe("ProjectManagementSettings — no PM tool connected", () => {
	it("renders the PM sync, auto-push and auto-close switches disabled, saying why", async () => {
		renderWith(unconnected);

		const autoPush = await screen.findByRole("switch", {
			name: /auto-push status changes/i,
		});
		const autoClose = screen.getByRole("switch", {
			name: /automatically close work items/i,
		});
		const statusSync = screen.getByRole("switch", {
			name: /keep status in sync/i,
		});
		expect(autoPush).toBeDisabled();
		expect(autoClose).toBeDisabled();
		expect(statusSync).toBeDisabled();

		for (const toggle of [autoPush, autoClose, statusSync]) {
			const describedBy = toggle.getAttribute("aria-describedby");
			expect(describedBy).toBeTruthy();
			expect(
				document.getElementById(describedBy as string),
			).toHaveTextContent("connectPmToolFirst");
		}
	});

	it("disables the terminal statuses editor, linked to the same copy", async () => {
		renderWith(unconnected);

		const editor = await screen.findByTestId("stub-terminal-status-editor");
		expect(editor).toHaveAttribute("data-disabled", "true");
		const describedBy = editor.getAttribute("data-described-by");
		expect(
			document.getElementById(describedBy as string),
		).toHaveTextContent("connectPmToolFirst");
	});

	it("enables everything once a PM tool is connected", async () => {
		renderWith(connected);

		const autoPush = await screen.findByRole("switch", {
			name: /auto-push status changes/i,
		});
		expect(autoPush).toBeEnabled();
		expect(autoPush).not.toHaveAttribute("aria-describedby");
		expect(
			screen.getByRole("switch", {
				name: /automatically close work items/i,
			}),
		).toBeEnabled();
		expect(
			screen.getByTestId("stub-terminal-status-editor"),
		).toHaveAttribute("data-disabled", "false");
		expect(
			screen.queryByText("connectPmToolFirst"),
		).not.toBeInTheDocument();
	});

	it("hides them from a non-owner, as before", async () => {
		renderWith({ ...unconnected, userRole: "member" });
		await screen.findByText("Project Management Integration");
		expect(
			screen.queryByRole("switch", { name: /auto-push status changes/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("stub-terminal-status-editor"),
		).not.toBeInTheDocument();
	});

	it("carries the PM settings anchor the gate remedy scrolls to", () => {
		const { container } = renderWith(unconnected);
		expect(
			container.querySelector(`#${PM_SETTINGS_ANCHOR_ID}`),
		).not.toBeNull();
	});
});

describe("ProjectManagementSettings — a saved connection refreshes the gates", () => {
	it("invalidates capability-gates after the board is saved", async () => {
		const user = userEvent.setup();
		updateMock.mockResolvedValue({ project: connected });
		listMock.mockResolvedValue([
			{
				id: "fizzy-config-id",
				enabled: true,
				organizationId: null,
				displayName: "Fizzy",
				mcpServer: {
					id: "key:fizzy",
					key: "fizzy",
					name: "Fizzy",
					category: "Project Management",
				},
			},
		]);
		renderWith(connected);
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await user.click(
			await screen.findByRole("button", { name: /change board/i }),
		);
		await user.click(
			await screen.findByRole("button", { name: /save settings/i }),
		);

		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["capability-gates"],
			}),
		);
		expect(updateMock).toHaveBeenCalledTimes(1);
	});
});
