/**
 * Optimistic UI for the PM-integration toggles in ProjectManagementSettings.
 *
 * The "Auto-push status changes to PM tool" and "Automatically close work
 * items…" switches must flip IMMEDIATELY on click — before the
 * `projects.update` round-trip resolves — and roll back if the server rejects
 * the change. The component reads the toggle values from the `project` PROP
 * (sourced upstream from a oRPC `projects.get` query, NOT from a local
 * `useQuery` at `["projects", id]`), so a `setQueryData` optimistic patch would
 * never re-render this component. These tests pin the local-optimistic-state
 * behaviour: the Switch's `aria-checked` updates synchronously with the click.
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
	userRole: "owner",
};

function renderWithClient(project = baseProject) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const result = render(
		<QueryClientProvider client={client}>
			<ProjectManagementSettings project={project} />
		</QueryClientProvider>,
	);
	// Re-render with an updated `project` prop while keeping the SAME client, to
	// simulate the upstream `projects.get` refetch landing a new prop value.
	const rerenderProject = (next: typeof baseProject) =>
		result.rerender(
			<QueryClientProvider client={client}>
				<ProjectManagementSettings project={next} />
			</QueryClientProvider>,
		);
	return { ...result, client, rerenderProject };
}

/** A promise whose resolution is controlled by the test. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	listMock.mockResolvedValue([]);
	availablePmToolsMock.mockResolvedValue([
		{ key: "fizzy", available: true, transport: "mcp" },
	]);
	listReposMock.mockResolvedValue({ configured: false, groups: [] });
	repoIntegrationsListMock.mockResolvedValue({ integrations: [] });
});

let lastClient: QueryClient | null = null;

afterEach(() => {
	vi.clearAllMocks();
	lastClient?.clear();
	lastClient = null;
});

describe("ProjectManagementSettings — optimistic PM toggles", () => {
	it("flips the auto-push switch immediately, before projects.update resolves", async () => {
		const user = userEvent.setup();
		const pending = deferred<unknown>();
		updateMock.mockReturnValue(pending.promise);

		const { client } = renderWithClient();
		lastClient = client;

		const toggle = await screen.findByRole("switch", {
			name: /auto-push status changes/i,
		});
		expect(toggle).toHaveAttribute("aria-checked", "false");

		await user.click(toggle);

		// Optimistic: aria-checked is already true while the mutation is in flight.
		expect(updateMock).toHaveBeenCalledWith(
			expect.objectContaining({ autoPushPmSync: true }),
		);
		expect(toggle).toHaveAttribute("aria-checked", "true");

		// Let the deferred mutation settle so React Query doesn't warn.
		pending.resolve({ project: { ...baseProject, autoPushPmSync: true } });
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});
	});

	it("flips the auto-close switch immediately, before projects.update resolves", async () => {
		const user = userEvent.setup();
		const pending = deferred<unknown>();
		updateMock.mockReturnValue(pending.promise);

		const { client } = renderWithClient();
		lastClient = client;

		const toggle = await screen.findByRole("switch", {
			name: /automatically close work items/i,
		});
		expect(toggle).toHaveAttribute("aria-checked", "false");

		await user.click(toggle);

		expect(updateMock).toHaveBeenCalledWith(
			expect.objectContaining({ pmAutoCloseEnabled: true }),
		);
		expect(toggle).toHaveAttribute("aria-checked", "true");

		pending.resolve({
			project: { ...baseProject, pmAutoCloseEnabled: true },
		});
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});
	});

	it("rolls back the auto-push switch when projects.update rejects", async () => {
		const user = userEvent.setup();
		const pending = deferred<unknown>();
		updateMock.mockReturnValue(pending.promise);

		const { client } = renderWithClient();
		lastClient = client;

		const toggle = await screen.findByRole("switch", {
			name: /auto-push status changes/i,
		});

		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-checked", "true");

		pending.reject(new Error("boom"));

		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "false");
		});
	});

	it("invalidates the projects.get key that feeds the prop on success (Finding 1)", async () => {
		const user = userEvent.setup();
		updateMock.mockResolvedValue({
			project: { ...baseProject, autoPushPmSync: true },
		});

		const { client } = renderWithClient();
		lastClient = client;
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");

		const toggle = await screen.findByRole("switch", {
			name: /auto-push status changes/i,
		});
		await user.click(toggle);

		// The success path must invalidate the EXACT oRPC `projects.get` key the
		// prop is sourced from — not the flat `["projects", id]` key, which the
		// prop never reads (Finding 1). organizationId is the explicit personal
		// `null` here, matching ProjectDetails' query input.
		await waitFor(() => {
			expect(invalidateSpy).toHaveBeenCalledWith({
				queryKey: [
					"projects.get",
					{ id: "proj_1", organizationId: null },
				],
			});
		});
		// And never the stale flat key.
		expect(invalidateSpy).not.toHaveBeenCalledWith({
			queryKey: ["projects", "proj_1"],
		});
	});

	it("clears the override once the prop catches up, then follows a later external prop change (Finding 1)", async () => {
		const user = userEvent.setup();
		const pending = deferred<unknown>();
		updateMock.mockReturnValue(pending.promise);

		const { client, rerenderProject } = renderWithClient();
		lastClient = client;

		const toggle = await screen.findByRole("switch", {
			name: /auto-push status changes/i,
		});
		expect(toggle).toHaveAttribute("aria-checked", "false");

		// Optimistic flip.
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-checked", "true");

		// Server resolves; upstream `projects.get` refetch lands the new value as
		// a fresh prop. The override-clearing effect must run so the prop is the
		// single source of truth again.
		pending.resolve({ project: { ...baseProject, autoPushPmSync: true } });
		rerenderProject({ ...baseProject, autoPushPmSync: true });
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});

		// A LATER external change to the opposite value must be reflected — i.e.
		// not masked by a stale override left over from the user's earlier click.
		rerenderProject({ ...baseProject, autoPushPmSync: false });
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "false");
		});
	});

	it("ignores a second click while the auto-push write is in flight (Finding 2 re-entrancy guard)", async () => {
		const user = userEvent.setup();
		const pending = deferred<unknown>();
		updateMock.mockReturnValue(pending.promise);

		const { client } = renderWithClient();
		lastClient = client;

		const toggle = await screen.findByRole("switch", {
			name: /auto-push status changes/i,
		});

		// First click fires one mutation and flips optimistically.
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-checked", "true");
		expect(updateMock).toHaveBeenCalledTimes(1);

		// Second click while pending is ignored — no second PATCH, UI unchanged.
		await user.click(toggle);
		expect(updateMock).toHaveBeenCalledTimes(1);
		expect(toggle).toHaveAttribute("aria-checked", "true");

		// Settle so React Query doesn't warn about an unresolved mutation.
		pending.resolve({ project: { ...baseProject, autoPushPmSync: true } });
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});
	});
});
