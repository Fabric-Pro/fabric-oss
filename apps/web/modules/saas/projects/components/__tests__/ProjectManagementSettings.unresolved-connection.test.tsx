/**
 * Fizzy #1884 — the connected-config card claimed "Connected to {board}" while
 * the caller had no usable PM connection at all, and every sync attempt then
 * failed with "You have not connected your account to the project management
 * tool."
 *
 * The card gated purely on persisted `Project` columns
 * (`isPMConfigured && savedContainerName`), which say what was *once* saved —
 * never whether the MCP config those columns point at still resolves for the
 * person looking at the page. `getPMCapabilities` already answers exactly that
 * question per-user (`resolvePMConfigForUser` → `error`), and this component
 * already runs that query for `detectedType`; the health card simply ignored
 * the `error` field.
 *
 * These tests pin the card to that authoritative signal:
 *   - a non-null `error` must NOT render as connected, and must surface the
 *     backend's own actionable message (the same one the failing sync throws),
 *   - `Test Sync` must not be offered for a connection that cannot succeed,
 *   - a healthy connection must still render green with `Test Sync` (AC4),
 *   - an in-flight / failed capabilities query must not flash a false problem.
 *
 * The card is shared by every PM provider (Fizzy, GitLab, Jira, Azure DevOps),
 * so one fix covers AC5 — the Azure DevOps case is pinned below.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Faithful to the real hooks: `useContextPath(p)` returns `${basePath}/${p}`
// and `useOrganizationContext()` supplies the same `basePath`. Stubbing either
// away leaves the card rendering hrefs like "undefined/projects/…", which is
// exactly the shape a broken link would have — an unrepresentative fixture
// cannot catch a regression in the very links this card exists to offer.
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (path: string) =>
		`/app/${path.startsWith("/") ? path.slice(1) : path}`,
	useOrganizationContext: () => ({
		organizationName: "Acme",
		basePath: "/app",
	}),
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

/** The reported case: a Fizzy-connected project whose MCP is not set up. */
const baseProject = {
	id: "proj_1",
	name: "Demo",
	organizationId: null,
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

/** The message `getPMCapabilities` returns when `resolvePMConfigForUser` finds
 *  nothing for the caller — the same failure the sync path throws. */
const NO_CONNECTION_ERROR =
	"You have not connected your account to the project management tool. Please configure your MCP connection in Settings.";

const HEALTHY_CAPABILITIES = {
	configured: true,
	capabilities: {
		hasPMCapabilities: true,
		canCreate: true,
		canUpdate: true,
		canGet: true,
		canList: true,
		supportsPush: true,
		supportsPull: true,
		supportsTaskSync: true,
	},
	containerName: "Fizzy Board",
	detectedType: "fizzy",
	mcpConfigId: "fizzy-config-id",
	containerId: "fizzy-board",
	additionalContext: null,
	error: null,
};

function unresolvedCapabilities(error: string, detectedType = "fizzy") {
	return {
		configured: true,
		capabilities: null,
		containerName: "Fizzy Board",
		detectedType,
		mcpConfigId: null,
		containerId: "fizzy-board",
		additionalContext: null,
		error,
	};
}

function renderWithClient(project: typeof baseProject = baseProject) {
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
	pmCapabilitiesMock.mockResolvedValue(HEALTHY_CAPABILITIES);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("ProjectManagementSettings — unresolved PM connection (Fizzy #1884)", () => {
	it("does not claim 'Connected to …' when the caller has no usable MCP connection", async () => {
		pmCapabilitiesMock.mockResolvedValue(
			unresolvedCapabilities(NO_CONNECTION_ERROR),
		);
		renderWithClient();

		// The honest state must appear …
		expect(
			await screen.findByText(
				/Project management connection needs setup/i,
			),
		).toBeInTheDocument();
		// … and the optimistic one must not.
		expect(screen.queryByText("Connected to Fizzy Board")).toBeNull();
	});

	it("surfaces the backend's own reason so the user knows what to fix", async () => {
		pmCapabilitiesMock.mockResolvedValue(
			unresolvedCapabilities(NO_CONNECTION_ERROR),
		);
		renderWithClient();

		expect(
			await screen.findByText(NO_CONNECTION_ERROR),
		).toBeInTheDocument();
	});

	it("points the reader at the page that fixes it", async () => {
		pmCapabilitiesMock.mockResolvedValue(
			unresolvedCapabilities(NO_CONNECTION_ERROR),
		);
		renderWithClient();

		expect(
			await screen.findByRole("link", {
				name: /Configure it in MCP Servers/i,
			}),
		).toHaveAttribute("href", "/app/mcp-servers");
	});

	it("does not offer Test Sync for a connection that cannot succeed", async () => {
		pmCapabilitiesMock.mockResolvedValue(
			unresolvedCapabilities(NO_CONNECTION_ERROR),
		);
		renderWithClient();

		await screen.findByText(/Project management connection needs setup/i);
		expect(screen.queryByRole("button", { name: "Test Sync" })).toBeNull();
	});

	it("still lets the owner reach the picker to repair the connection", async () => {
		pmCapabilitiesMock.mockResolvedValue(
			unresolvedCapabilities(NO_CONNECTION_ERROR),
		);
		renderWithClient();

		await screen.findByText(/Project management connection needs setup/i);
		expect(
			screen.getByRole("button", { name: "Change board" }),
		).toBeInTheDocument();
	});

	it("reports a disabled connection rather than a healthy one", async () => {
		pmCapabilitiesMock.mockResolvedValue(
			unresolvedCapabilities(
				"Your project management connection is disabled. Please enable it in Settings.",
			),
		);
		renderWithClient();

		expect(
			await screen.findByText(
				"Your project management connection is disabled. Please enable it in Settings.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Connected to Fizzy Board")).toBeNull();
	});

	// AC5 — the card is shared across providers, so the fix must hold for a
	// non-Fizzy tool too.
	it("applies to every PM provider sharing this card", async () => {
		pmCapabilitiesMock.mockResolvedValue(
			unresolvedCapabilities(NO_CONNECTION_ERROR, "azure-devops"),
		);
		renderWithClient();

		expect(
			await screen.findByText(
				/Project management connection needs setup/i,
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Connected to Fizzy Board")).toBeNull();
	});

	// AC4 — a genuinely healthy connection is untouched.
	it("still shows the connected card when the connection resolves", async () => {
		renderWithClient();

		expect(
			await screen.findByText("Connected to Fizzy Board"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Test Sync" }),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/Project management connection needs setup/i),
		).toBeNull();
	});

	// Tri-state: an unresolved query is not evidence of a problem. Flashing a
	// red state on every page load would be its own trust bug.
	it("does not flash a problem while capabilities are still loading", async () => {
		pmCapabilitiesMock.mockImplementation(() => new Promise(() => {}));
		renderWithClient();

		expect(
			await screen.findByText("Connected to Fizzy Board"),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/Project management connection needs setup/i),
		).toBeNull();
	});

	// A settled failure of the health query is not evidence of a broken
	// connection — but it is not evidence of a working one either. It must not
	// invent a configuration problem, and it must not let the green card imply
	// a check that never came back.
	it("does not invent a problem when the capabilities query fails", async () => {
		pmCapabilitiesMock.mockRejectedValue(new Error("network down"));
		renderWithClient();

		await waitFor(() => expect(pmCapabilitiesMock).toHaveBeenCalled());
		expect(
			await screen.findByText("Connected to Fizzy Board"),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/Project management connection needs setup/i),
		).toBeNull();
	});

	it("marks the status unverified when the capabilities query fails", async () => {
		pmCapabilitiesMock.mockRejectedValue(new Error("network down"));
		renderWithClient();

		expect(
			await screen.findByText(/Couldn’t check the connection status/i),
		).toBeInTheDocument();
		// Test Sync is the on-demand verification — it must stay reachable.
		expect(
			screen.getByRole("button", { name: "Test Sync" }),
		).toBeInTheDocument();
	});

	it("does not mark a successfully-checked connection as unverified", async () => {
		renderWithClient();

		await screen.findByText("Connected to Fizzy Board");
		expect(
			screen.queryByText(/Couldn’t check the connection status/i),
		).toBeNull();
	});

	// The card reads a query cached for 60s. Saving is the one moment that
	// answer is guaranteed to have changed, so the save must invalidate it —
	// otherwise a just-repaired connection keeps showing its pre-repair problem
	// and Test Sync stays withheld until the cache happens to go stale.
	it("re-checks the connection when the settings are saved", async () => {
		pmCapabilitiesMock.mockResolvedValue(
			unresolvedCapabilities(NO_CONNECTION_ERROR),
		);
		// A resolvable tenant config is what makes the Save button render.
		listMock.mockResolvedValue([
			{
				id: "fizzy-config-id",
				enabled: true,
				organizationId: null,
				displayName: "Fizzy",
				mcpServer: {
					id: "cmjmsyw7x0018r0m645dtohzr",
					name: "Fizzy",
					category: "Project Management",
				},
			},
		]);

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");
		render(
			<QueryClientProvider client={client}>
				<ProjectManagementSettings project={baseProject} />
			</QueryClientProvider>,
		);

		await screen.findByText(/Project management connection needs setup/i);
		// Open the picker, then save — the repair path a user actually walks.
		fireEvent.click(screen.getByRole("button", { name: "Change board" }));
		fireEvent.click(await screen.findByRole("button", { name: /Save/ }));

		await waitFor(() => {
			expect(
				invalidateSpy.mock.calls.some(
					([arg]) =>
						Array.isArray(arg?.queryKey) &&
						arg.queryKey[0] === "pmCapabilities",
				),
			).toBe(true);
		});
	});
});
