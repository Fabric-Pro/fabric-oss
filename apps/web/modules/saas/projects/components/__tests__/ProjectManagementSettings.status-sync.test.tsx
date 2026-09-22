/**
 * "Keep status in sync with the PM tool" (Fizzy #2304, spec AC1 / AC13 / D1.8):
 * when the switch is shown, who can change it, what it says for each tool, and
 * the "Last status sync" line it carries.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const listMock = vi.fn();
const pmCapabilitiesMock = vi.fn();
const updateMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			configs: { list: (...a: unknown[]) => listMock(...a) },
			availablePmTools: { list: vi.fn(async () => []) },
			tools: { list: vi.fn(async () => ({ tools: [] })) },
		},
		projects: {
			gitlab: {
				listRepos: vi.fn(async () => ({
					configured: false,
					groups: [],
				})),
			},
			repositoryIntegrations: {
				list: vi.fn(async () => ({ integrations: [] })),
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

type TestProject = Parameters<typeof ProjectManagementSettings>[0]["project"];

const fizzyProject: TestProject = {
	id: "proj_1",
	name: "Demo",
	organizationId: null,
	projectManagementMcpServerId: "key:fizzy",
	projectManagementMcpConfigId: "fizzy-config-id",
	projectManagementContainerId: "fizzy-board",
	projectManagementContainerName: "Fizzy Board",
	projectManagementAdditionalContext: null,
	autoPushPmSync: false,
	pmAutoCloseEnabled: false,
	pmStatusSyncEnabled: false,
	userRole: "owner",
	canEditSettings: true,
};

const restGitLabProject: TestProject = {
	...fizzyProject,
	projectManagementMcpServerId: "gitlab-official",
	projectManagementMcpConfigId: null,
	projectManagementContainerId: "4711",
	projectManagementContainerName: "example-group/example-project",
};

function capabilities(detectedType: string) {
	return {
		configured: true,
		capabilities: null,
		containerName: "board",
		detectedType,
		mcpConfigId: null,
		containerId: "board",
		additionalContext: null,
		error: null,
	};
}

const minutesAgo = (minutes: number) =>
	new Date(Date.now() - minutes * 60_000).toISOString();

const allOutcomes = (overrides: Record<string, number> = {}) => ({
	moved: 0,
	unchanged: 0,
	"fabric-ahead": 0,
	"not-mapped": 0,
	ambiguous: 0,
	unverified: 0,
	stale: 0,
	"skipped-conflict": 0,
	raced: 0,
	...overrides,
});

let lastClient: QueryClient | null = null;

function renderSettings(project: TestProject) {
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

const findStatusSyncSwitch = () =>
	screen.findByRole("switch", {
		name: /keep status in sync with the pm tool/i,
	});
const queryStatusSyncSwitch = () =>
	screen.queryByRole("switch", {
		name: /keep status in sync with the pm tool/i,
	});

beforeEach(() => {
	listMock.mockResolvedValue([]);
	pmCapabilitiesMock.mockResolvedValue(capabilities("fizzy"));
	updateMock.mockResolvedValue({ project: fizzyProject });
});

afterEach(() => {
	vi.clearAllMocks();
	lastClient?.clear();
	lastClient = null;
});

describe("status-sync switch — visibility, copy and permission (AC1)", () => {
	it("shows the switch off by default with the status-name rule for an MCP tool", async () => {
		renderSettings(fizzyProject);

		const toggle = await findStatusSyncSwitch();
		expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(toggle).toBeEnabled();
		expect(
			screen.getByText(
				/whose name matches a Fabric status, ignoring case/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/if both change between two checks, the ticket wins/i,
			),
		).toBeInTheDocument();
		// Positive control above; the REST-only disclosure stays off MCP tools.
		expect(screen.queryByText(/replaces its status labels/i)).toBeNull();
	});

	it("shows the label-map rule and the three REST disclosures for REST GitLab", async () => {
		pmCapabilitiesMock.mockResolvedValue(capabilities("gitlab-rest"));
		renderSettings(restGitLabProject);

		await findStatusSyncSwitch();
		await waitFor(() => {
			expect(
				screen.getByText(/from this project's GitLab label map/i),
			).toBeInTheDocument();
		});
		expect(
			screen.getByText(
				/replaces its status labels with the labels mapped to its Fabric status/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/also runs terminal-status handling, drift detection and missing-ticket checks/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(/turning it off does not stop that hourly check/i),
		).toBeInTheDocument();
	});

	it("hides the switch for GitLab over MCP", async () => {
		pmCapabilitiesMock.mockResolvedValue(capabilities("gitlab"));
		renderSettings({
			...fizzyProject,
			projectManagementMcpServerId: "gitlab-official",
			projectManagementMcpConfigId: "gitlab-mcp-config",
		});

		// Positive control: the capabilities answer landed (the card names the
		// tool) and the sibling toggles rendered.
		expect(await screen.findByText("via GitLab")).toBeInTheDocument();
		expect(
			screen.getByRole("switch", { name: /auto-push status changes/i }),
		).toBeInTheDocument();
		// Every switch on the card, by id: no status-sync switch under ANY label.
		expect(screen.getAllByRole("switch").map((s) => s.id)).toEqual([
			"auto-push-pm-sync",
			"pm-auto-close",
		]);
		expect(queryStatusSyncSwitch()).toBeNull();
	});

	it("hides the switch until a board is saved", async () => {
		renderSettings({
			...fizzyProject,
			projectManagementContainerId: null,
			projectManagementContainerName: null,
		});

		// Positive control: PM is configured and the capabilities answer landed.
		expect(
			await screen.findByText(/terminal state in Fizzy/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("switch", { name: /auto-push status changes/i }),
		).toBeInTheDocument();
		// Every switch on the card, by id: no status-sync switch under ANY label.
		expect(screen.getAllByRole("switch").map((s) => s.id)).toEqual([
			"auto-push-pm-sync",
			"pm-auto-close",
		]);
		expect(queryStatusSyncSwitch()).toBeNull();
	});

	it("is read-only without PROJECT_SETTINGS_EDIT and editable with it (D1.6)", async () => {
		const user = userEvent.setup();

		// Positive control: a non-owner who holds the grant can change it.
		const first = renderSettings({
			...fizzyProject,
			userRole: "member",
			canEditSettings: true,
		});
		expect(await findStatusSyncSwitch()).toBeEnabled();
		first.unmount();
		lastClient?.clear();

		renderSettings({
			...fizzyProject,
			userRole: "member",
			canEditSettings: false,
		});
		const toggle = await findStatusSyncSwitch();
		expect(toggle).toBeDisabled();
		expect(
			screen.getByText("Only project admins or owners can change this."),
		).toBeInTheDocument();
		await user.click(toggle);
		expect(updateMock).not.toHaveBeenCalled();
		expect(toggle).toHaveAttribute("aria-checked", "false");
	});

	it("hides the switch while the PM-capabilities query is still pending", async () => {
		pmCapabilitiesMock.mockReturnValue(new Promise(() => {}));
		renderSettings(fizzyProject);

		// Positive control: the card rendered and the sibling switches, which
		// do not wait on capabilities, are already visible — so a missing
		// status-sync switch here is the settling gate, not a render failure.
		expect(
			await screen.findByRole("switch", {
				name: /auto-push status changes/i,
			}),
		).toBeInTheDocument();
		expect(queryStatusSyncSwitch()).toBeNull();
	});

	it("shows the switch once the PM-capabilities query fails, backstopped by the server (D1.4/D1.6)", async () => {
		// Positive control: the same project with capabilities resolving
		// normally shows the switch.
		const ok = renderSettings(fizzyProject);
		expect(await findStatusSyncSwitch()).toBeInTheDocument();
		ok.unmount();
		lastClient?.clear();

		pmCapabilitiesMock.mockRejectedValue(new Error("network error"));
		renderSettings(fizzyProject);
		expect(await findStatusSyncSwitch()).toBeInTheDocument();
	});
});

describe("Last status sync line (AC13)", () => {
	it("renders a healthy run with every fetch and outcome count", async () => {
		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncSessionAt: minutesAgo(180),
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(180),
				fetch: {
					at: minutesAgo(6),
					linked: 12,
					fetched: 12,
					failed: 0,
					notFound: 0,
					complete: true,
				},
				outcome: {
					at: minutesAgo(5),
					counts: allOutcomes({
						moved: 2,
						unchanged: 8,
						"fabric-ahead": 1,
					}),
				},
			},
		});

		expect(
			await screen.findByText(/^Last status sync \d+ minutes ago$/),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"12 linked · 12 fetched · 0 failed · 0 not found · 0 not fetched",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"2 moved · 8 unchanged · 1 Fabric ahead · 0 not mapped · 0 ambiguous · 0 unverified · 0 stale · 0 skipped (conflict) · 0 raced",
			),
		).toBeInTheDocument();
	});

	it("renders a failed fetch as failed, never as a healthy empty run", async () => {
		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(180),
				fetch: {
					at: minutesAgo(70),
					linked: 12,
					fetched: 12,
					failed: 0,
					notFound: 0,
					complete: true,
				},
				failure: {
					at: minutesAgo(10),
					kind: "fetch-failed",
					error: "GitLab returned 503",
				},
			},
		});

		expect(
			await screen.findByText(
				/^Last status sync failed \d+ minutes ago: the ticket fetch failed\.$/,
			),
		).toBeInTheDocument();
		expect(screen.getByText("GitLab returned 503")).toBeInTheDocument();
		expect(screen.queryByText(/12 linked/)).toBeNull();
	});

	it("renders a run older than two poll intervals as overdue", async () => {
		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(600),
				fetch: {
					at: minutesAgo(190),
					linked: 12,
					fetched: 12,
					failed: 0,
					notFound: 0,
					complete: true,
				},
				outcome: {
					at: minutesAgo(185),
					counts: allOutcomes({ unchanged: 12 }),
				},
			},
		});

		expect(
			await screen.findByText(
				/^Last status sync about 3 hours ago — overdue$/,
			),
		).toBeInTheDocument();
	});

	it("renders a fetch whose outcome never arrived as not applied, never healthy", async () => {
		const fetch = (at: string) => ({
			at,
			linked: 12,
			fetched: 12,
			failed: 0,
			notFound: 0,
			complete: true,
		});
		// Positive control: a fetch 5 minutes old with no outcome yet —
		// reconcile may still be running — reads as a healthy run.
		const fresh = renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(180),
				fetch: fetch(minutesAgo(5)),
			},
		});
		expect(
			await screen.findByText(/^Last status sync 5 minutes ago$/),
		).toBeInTheDocument();
		fresh.unmount();
		lastClient?.clear();

		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(180),
				fetch: fetch(minutesAgo(16)),
			},
		});

		expect(
			await screen.findByText(
				/^Status sync fetched tickets 16 minutes ago but has not applied them yet\.$/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"12 linked · 12 fetched · 0 failed · 0 not found · 0 not fetched",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/^Last status sync \d+ minutes ago$/),
		).toBeNull();
	});

	it("renders an unparseable summary as unreadable", async () => {
		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncLastRun: { sessionAt: "not a date", fetch: "garbage" },
		});

		expect(
			await screen.findByText(/^Last status sync: unreadable/),
		).toBeInTheDocument();
	});

	it("shows no last-run line while the switch is off", async () => {
		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: false,
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(180),
				outcome: {
					at: minutesAgo(5),
					counts: allOutcomes({ moved: 1 }),
				},
			},
		});

		// Positive control: the switch itself rendered.
		expect(await findStatusSyncSwitch()).toHaveAttribute(
			"aria-checked",
			"false",
		);
		expect(screen.queryByText(/Last status sync/)).toBeNull();
	});

	it("renders a run with unread tickets as a warning, never healthy", async () => {
		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncSessionAt: minutesAgo(180),
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(180),
				fetch: {
					at: minutesAgo(6),
					linked: 11,
					fetched: 9,
					failed: 2,
					notFound: 0,
					complete: false,
				},
				outcome: {
					at: minutesAgo(5),
					counts: allOutcomes({ unchanged: 9 }),
				},
			},
		});

		expect(
			await screen.findByText(
				/^Last status sync \d+ minutes ago: 2 of 11 tickets could not be read\.$/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"11 linked · 9 fetched · 2 failed · 0 not found · 0 not fetched (incomplete — the rest is checked on the next run)",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/^Last status sync \d+ minutes ago$/),
		).toBeNull();
	});

	it("renders a run that read nothing as a failure line", async () => {
		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncSessionAt: minutesAgo(180),
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(180),
				fetch: {
					at: minutesAgo(6),
					linked: 11,
					fetched: 0,
					failed: 11,
					notFound: 0,
					complete: false,
				},
				outcome: { at: minutesAgo(5), counts: allOutcomes({}) },
			},
		});

		const line = await screen.findByText(
			/^Last status sync \d+ minutes ago: no ticket could be read\.$/,
		);
		expect(line.closest("div")?.className).toContain("text-destructive");
	});

	it("renders a run where every ticket was deferred (never attempted, not failed) as the same failure line", async () => {
		renderSettings({
			...fizzyProject,
			pmStatusSyncEnabled: true,
			pmStatusSyncSessionAt: minutesAgo(180),
			pmStatusSyncLastRun: {
				sessionAt: minutesAgo(180),
				fetch: {
					at: minutesAgo(6),
					linked: 11,
					fetched: 0,
					failed: 0,
					notFound: 0,
					complete: false,
				},
				outcome: { at: minutesAgo(5), counts: allOutcomes({}) },
			},
		});

		const line = await screen.findByText(
			/^Last status sync \d+ minutes ago: no ticket could be read\.$/,
		);
		expect(line.closest("div")?.className).toContain("text-destructive");
		expect(
			screen.getByText(
				"11 linked · 0 fetched · 0 failed · 0 not found · 11 not fetched (incomplete — the rest is checked on the next run)",
			),
		).toBeInTheDocument();
	});
});
