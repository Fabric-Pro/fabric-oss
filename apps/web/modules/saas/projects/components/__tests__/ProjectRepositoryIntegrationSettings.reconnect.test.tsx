import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listFn = vi.fn();
const githubStatusFn = vi.fn();
const gitlabStatusFn = vi.fn();
const githubStartFn = vi.fn();

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
			ragSettings: { update: vi.fn().mockResolvedValue({}) },
		},
		integrations: {
			github: {
				status: (...a: unknown[]) => githubStatusFn(...a),
				start: (...a: unknown[]) => githubStartFn(...a),
			},
			gitlab: { status: (...a: unknown[]) => gitlabStatusFn(...a) },
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
	// The row now shows Job Hub progress, whose query resolves the active
	// org through this hook.
	useOrganizationId: () => "org-1",
	useContextPath: () => "/app/members",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
	githubStartFn.mockReset();
	githubStatusFn.mockResolvedValue({ connected: false });
	gitlabStatusFn.mockResolvedValue({ connected: false });
	githubStartFn.mockResolvedValue({
		authorizationUrl: "https://github.test/oauth",
	});
	listFn.mockResolvedValue({
		integrations: [
			{
				id: "int-1",
				provider: "GITHUB",
				authMethod: "OAUTH",
				repositoryUrl: "https://github.com/acme/app",
				repositoryOwner: "acme",
				repositoryName: "app",
				defaultBranch: "develop",
				status: "TOKEN_EXPIRED",
			},
		],
	});
	vi.stubGlobal("open", vi.fn());
});

function renderSettings(
	projectOverride: React.ComponentProps<
		typeof ProjectRepositoryIntegrationSettings
	>["project"] = project,
) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<ProjectRepositoryIntegrationSettings project={projectOverride} />
		</QueryClientProvider>,
	);
}

describe("ProjectRepositoryIntegrationSettings — Reconnect preserves config", () => {
	it("Reconnect re-runs github.start with the row's existing defaultBranch", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();

		await user.click(
			await screen.findByRole("button", { name: /manage acme\/app/i }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: /reconnect/i }),
		);

		await waitFor(() => expect(githubStartFn).toHaveBeenCalledTimes(1));
		expect(githubStartFn).toHaveBeenCalledWith(
			expect.objectContaining({
				targetType: "project",
				projectId: "proj-1",
				repositoryOwner: "acme",
				repositoryName: "app",
				defaultBranch: "develop",
				// Regression guard (#1822): returnUrl must be a same-origin RELATIVE
				// path, never an absolute URL, or github.start rejects it with
				// "Input validation failed" and reconnect breaks.
				returnUrl: expect.stringMatching(/^\/(?!\/)/),
			}),
		);
	});

	it("Edit branch opens the dialog pre-populated with the current branch", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();

		await user.click(
			await screen.findByRole("button", { name: /manage acme\/app/i }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: /edit branch/i }),
		);

		expect(await screen.findByLabelText(/monitored branch/i)).toHaveValue(
			"develop",
		);
	});

	// Regression (Codex review): when the canonical list query is unavailable, rows
	// render from project.repositoryIntegrations — a payload shape that lacks
	// defaultBranch. Edit/Reconnect MUST be hidden for such rows so we can never
	// silently reset the monitored branch to "main" (FR-5). Disconnect stays.
	it("hides Reconnect and Edit for a fallback row that has no defaultBranch", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		// Canonical list is down — component falls back to project.repositoryIntegrations.
		listFn.mockRejectedValue(new Error("list down"));
		const fallbackProject = {
			id: "proj-1",
			organizationId: null,
			canEditSettings: true,
			repositoryUrl: null,
			repositoryOwner: null,
			repositoryName: null,
			repositoryIntegrations: [
				{
					id: "int-1",
					status: "TOKEN_EXPIRED",
					provider: "GITHUB",
					repositoryOwner: "acme",
					repositoryName: "app",
					// NOTE: no defaultBranch — this is the bug-triggering shape.
				},
			],
		} as unknown as React.ComponentProps<
			typeof ProjectRepositoryIntegrationSettings
		>["project"];

		renderSettings(fallbackProject);

		await user.click(
			await screen.findByRole("button", { name: /manage acme\/app/i }),
		);

		expect(
			screen.queryByRole("menuitem", { name: /reconnect/i }),
		).toBeNull();
		expect(
			screen.queryByRole("menuitem", { name: /edit branch/i }),
		).toBeNull();
		expect(
			screen.getByRole("menuitem", { name: /disconnect/i }),
		).toBeInTheDocument();
	});
});
