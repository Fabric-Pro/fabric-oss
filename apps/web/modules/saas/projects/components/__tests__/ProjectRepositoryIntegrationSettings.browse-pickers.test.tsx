/**
 * Repo discovery parity in project Settings (Fizzy #2196).
 *
 * Project setup lets you pick a GitLab or Azure DevOps repository from a list.
 * Settings only ever offered that for GitHub — GitLab and Azure DevOps were
 * paste-the-URL — so the capability existed only inside the flow that the
 * simplified-creation work removes.
 *
 * Worse, the GitLab affordance that DID exist was a dead end: a "Connect GitLab
 * to browse repositories" prompt rendered only while GitLab was disconnected,
 * with nothing behind it once you connected. `gitlabStatus` was read at exactly
 * one site, on the `!== true` branch.
 *
 * These tests lock in both halves: a browse entry point for each provider, and
 * the connected-state GitLab branch that used to be missing entirely.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listFn = vi.fn();
const githubStatusFn = vi.fn();
const gitlabStatusFn = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			repositoryIntegrations: {
				list: (...a: unknown[]) => listFn(...a),
				updateBranch: vi.fn().mockResolvedValue({}),
			},
			github: {
				listRepos: vi.fn().mockResolvedValue({ configured: false }),
			},
			gitlab: {
				listRepos: vi.fn().mockResolvedValue({ groups: [] }),
			},
			ragSettings: { update: vi.fn().mockResolvedValue({}) },
		},
		integrations: {
			github: {
				status: (...a: unknown[]) => githubStatusFn(...a),
				start: vi.fn().mockResolvedValue({ authorizationUrl: "u" }),
			},
			gitlab: {
				status: (...a: unknown[]) => gitlabStatusFn(...a),
				start: vi.fn().mockResolvedValue({ authorizationUrl: "u" }),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: { queryKey: () => ["projects", "get"] },
			ragSettings: {
				get: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["rag-settings", opts?.input],
						queryFn: async () => ({
							settings: {
								codeSearchEnabled: false,
								codeSearchProvider: null,
							},
							featureCodeIndexingEnabled: false,
						}),
					}),
				},
			},
		},
		agents: {
			codeIndex: {
				status: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["code-index-status", opts?.input],
						queryFn: async () => ({
							status: "MISSING",
							indexedAt: null,
							filesIndexed: 0,
							chunksCreated: 0,
							error: null,
						}),
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-1",
	useContextPath: () => "/app/members",
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import userEvent from "@testing-library/user-event";
import { ProjectRepositoryIntegrationSettings } from "../ProjectRepositoryIntegrationSettings";

const project = {
	id: "proj-1",
	organizationId: null,
	canEditSettings: true,
	repositoryUrl: null,
	repositoryOwner: null,
	repositoryName: null,
	repositoryIntegrations: [],
} as unknown as React.ComponentProps<
	typeof ProjectRepositoryIntegrationSettings
>["project"];

beforeEach(() => {
	listFn.mockReset();
	githubStatusFn.mockResolvedValue({ connected: false });
	gitlabStatusFn.mockResolvedValue({ connected: false });
	listFn.mockResolvedValue({ integrations: [] });
	vi.stubGlobal("open", vi.fn());
});

function renderSettings() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<ProjectRepositoryIntegrationSettings project={project} />
		</QueryClientProvider>,
	);
}

/** Reveal the add-repository panel, which hosts every browse entry point. */
async function openAddPanel(user: ReturnType<typeof userEvent.setup>) {
	const [addButton] = await screen.findAllByRole("button", {
		name: /add repository/i,
	});
	await user.click(addButton);
}

describe("ProjectRepositoryIntegrationSettings — repo browse parity (#2196)", () => {
	it("offers an Azure DevOps browse entry point (the picker collects its own PAT)", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);

		expect(
			screen.getByText(/browse azure devops repositories/i),
		).toBeInTheDocument();
	});

	it("offers a GitLab browse entry point once GitLab is connected", async () => {
		gitlabStatusFn.mockResolvedValue({ connected: true });
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);

		expect(
			await screen.findByText(/browse gitlab repositories/i),
		).toBeInTheDocument();
		// The connect prompt is the disconnected-state affordance only.
		expect(
			screen.queryByText(/connect gitlab to browse repositories/i),
		).not.toBeInTheDocument();
	});

	it("still prompts to connect GitLab when it is not connected", async () => {
		gitlabStatusFn.mockResolvedValue({ connected: false });
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);

		expect(
			await screen.findByText(/connect gitlab to browse repositories/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/browse gitlab repositories/i),
		).not.toBeInTheDocument();
	});
});
