/**
 * Stored PAT reuse when connecting additional repositories via the picker.
 *
 * When a user adds a subsequent repository via the GitHub repository picker in project
 * settings where a PAT was previously stored, Fabric reuses that stored token
 * rather than prompting for OAuth credentials again or opening an OAuth popup.
 *
 * The manual "Connect with a token (PAT)" area remains unaffected and requires explicit PAT input.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listFn = vi.fn();
const connectFn = vi.fn();
const githubStatusFn = vi.fn();
const gitlabStatusFn = vi.fn();
const githubStartFn = vi.fn();
const githubListReposFn = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			repositoryIntegrations: {
				list: (...a: unknown[]) => listFn(...a),
				connect: (...a: unknown[]) => connectFn(...a),
				updateBranch: vi.fn().mockResolvedValue({}),
			},
			github: {
				listRepos: (...a: unknown[]) => githubListReposFn(...a),
			},
			gitlab: {
				listRepos: vi.fn().mockResolvedValue({ groups: [] }),
			},
			ragSettings: { update: vi.fn().mockResolvedValue({}) },
		},
		integrations: {
			github: {
				status: (...a: unknown[]) => githubStatusFn(...a),
				start: (...a: unknown[]) => githubStartFn(...a),
			},
			gitlab: {
				status: (...a: unknown[]) => gitlabStatusFn(...a),
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

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
	},
}));

import { toast } from "sonner";
import { ProjectRepositoryIntegrationSettings } from "../ProjectRepositoryIntegrationSettings";

const project = {
	id: "proj-1",
	organizationId: "org-1",
	canEditSettings: true,
	repositoryUrl: null,
	repositoryOwner: null,
	repositoryName: null,
	repositoryIntegrations: [],
} as unknown as React.ComponentProps<
	typeof ProjectRepositoryIntegrationSettings
>["project"];

const defaultIntegrations = [
	{
		id: "int-1",
		provider: "GITHUB",
		authMethod: "PAT",
		status: "ACTIVE",
		repositoryOwner: "acme",
		repositoryName: "first-repo",
		repositoryUrl: "https://github.com/acme/first-repo",
	},
];

const defaultReposFixture = {
	configured: true,
	source: "pat" as const,
	groups: [
		{
			owner: "acme",
			repos: [
				{
					id: "repo-2",
					name: "second-repo",
					fullName: "acme/second-repo",
					owner: "acme",
					isPrivate: false,
					defaultBranch: "main",
					htmlUrl: "https://github.com/acme/second-repo",
				},
			],
		},
	],
};

beforeEach(() => {
	listFn.mockReset();
	connectFn.mockReset();
	githubStartFn.mockReset();
	githubListReposFn.mockReset();
	vi.mocked(toast.success).mockReset();
	vi.mocked(toast.error).mockReset();
	githubStatusFn.mockResolvedValue({ connected: false });
	gitlabStatusFn.mockResolvedValue({ connected: false });
	listFn.mockResolvedValue({ integrations: defaultIntegrations });
	githubListReposFn.mockResolvedValue(defaultReposFixture);
	githubStartFn.mockResolvedValue({
		authorizationUrl:
			"https://github.com/login/oauth/authorize?client_id=123",
	});
	connectFn.mockResolvedValue({ id: "new-int-id" });
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
			<ProjectRepositoryIntegrationSettings
				project={project}
				currentUserId="user-1"
			/>
		</QueryClientProvider>,
	);
}

async function openAddPanel(user: ReturnType<typeof userEvent.setup>) {
	const [addButton] = await screen.findAllByRole("button", {
		name: /add repository/i,
	});
	await user.click(addButton);
}

function getBrowseAddButton(trigger: HTMLElement) {
	const container = trigger.closest("div");
	if (!container) {
		throw new Error("Browse select container not found");
	}
	return within(container).getByRole("button", { name: /^add$/i });
}

async function selectRepoAndAdd(
	user: ReturnType<typeof userEvent.setup>,
	repoPattern: RegExp = /acme\/second-repo/i,
) {
	const trigger = await screen.findByRole("combobox");
	await user.click(trigger);
	const option = await screen.findByRole("option", { name: repoPattern });
	await user.click(option);
	await user.click(getBrowseAddButton(trigger));
}

describe("ProjectRepositoryIntegrationSettings — GitHub picker PAT reuse", () => {
	it("reuses active stored GitHub PAT when connecting via GitHub browse picker without OAuth popup", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalledWith({
				projectId: "proj-1",
				organizationId: "org-1",
				provider: "GITHUB",
				authMethod: "PAT",
				repositoryUrl: "https://github.com/acme/second-repo",
				repositoryOwner: "acme",
				repositoryName: "second-repo",
				defaultBranch: "main",
				roleTag: undefined,
				sourceIntegrationId: undefined,
			});
		});

		expect(githubStartFn).not.toHaveBeenCalled();
		expect(window.open).not.toHaveBeenCalled();
	});

	it("uses OAuth flow directly when user has GitHub OAuth connected", async () => {
		githubStatusFn.mockResolvedValue({ connected: true });
		githubListReposFn.mockResolvedValue({
			...defaultReposFixture,
			source: "oauth",
		});

		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(githubStartFn).toHaveBeenCalled();
			expect(window.open).toHaveBeenCalledWith(
				"https://github.com/login/oauth/authorize?client_id=123",
				"github-oauth-project",
				expect.any(String),
			);
		});
		expect(connectFn).not.toHaveBeenCalled();
	});

	it("falls through to OAuth sign-in flow when stored PAT cannot access selected repo", async () => {
		connectFn.mockRejectedValueOnce(
			new Error("Invalid PAT or insufficient permissions"),
		);

		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalled();
		});

		// Verify that upon PAT connect failure, it fell through to OAuth popup flow
		await waitFor(() => {
			expect(window.open).toHaveBeenCalledWith(
				"https://github.com/login/oauth/authorize?client_id=123",
				"github-oauth-project",
				expect.any(String),
			);
		});
	});

	it("falls through to OAuth sign-in flow during rolling deploy when backend returns 'PAT is required'", async () => {
		connectFn.mockRejectedValueOnce(
			new Error("PAT is required for PAT authentication"),
		);

		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalled();
		});

		await waitFor(() => {
			expect(window.open).toHaveBeenCalledWith(
				"https://github.com/login/oauth/authorize?client_id=123",
				"github-oauth-project",
				expect.any(String),
			);
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("reuses stored GitHub PAT when repos were served via PAT even if githubStatus.connected is true", async () => {
		githubStatusFn.mockResolvedValue({ connected: true });
		githubListReposFn.mockResolvedValue({
			...defaultReposFixture,
			sourceIntegrationId: "int-1",
		});

		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					provider: "GITHUB",
					authMethod: "PAT",
					repositoryUrl: "https://github.com/acme/second-repo",
					sourceIntegrationId: "int-1",
				}),
			);
		});

		expect(githubStartFn).not.toHaveBeenCalled();
		expect(window.open).not.toHaveBeenCalled();
	});

	it("stops and displays error toast on CONFLICT error without falling through to OAuth popup", async () => {
		connectFn.mockRejectedValueOnce(
			Object.assign(new Error("Repository is already connected"), {
				code: "CONFLICT",
				status: 409,
			}),
		);

		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalled();
		});

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"Repository is already connected",
			);
		});

		expect(githubStartFn).not.toHaveBeenCalled();
		expect(window.open).not.toHaveBeenCalled();
	});

	it("stops and displays error toast on non-credential error without falling through to OAuth popup", async () => {
		connectFn.mockRejectedValueOnce(
			Object.assign(new Error("Internal server error"), {
				code: "INTERNAL_SERVER_ERROR",
				status: 500,
			}),
		);

		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalled();
		});

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("Internal server error");
		});

		expect(githubStartFn).not.toHaveBeenCalled();
		expect(window.open).not.toHaveBeenCalled();
	});

	it("stops and displays error toast on input validation error (400) without falling through to OAuth popup", async () => {
		connectFn.mockRejectedValueOnce(
			Object.assign(
				new Error(
					"Role tag can only contain letters, numbers, spaces, hyphens, underscores, dots, and slashes (and cannot contain '---')",
				),
				{
					code: "BAD_REQUEST",
					status: 400,
				},
			),
		);

		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalled();
		});

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"Role tag can only contain letters, numbers, spaces, hyphens, underscores, dots, and slashes (and cannot contain '---')",
			);
		});

		expect(githubStartFn).not.toHaveBeenCalled();
		expect(window.open).not.toHaveBeenCalled();
	});

	it("stops and displays error toast on 403 FORBIDDEN (missing project permission) without falling through to OAuth popup", async () => {
		connectFn.mockRejectedValueOnce(
			Object.assign(
				new Error("Missing required permission: PROJECT_SETTINGS_EDIT"),
				{
					code: "FORBIDDEN",
					status: 403,
				},
			),
		);

		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);
		await selectRepoAndAdd(user);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalled();
		});

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"Missing required permission: PROJECT_SETTINGS_EDIT",
			);
		});

		expect(githubStartFn).not.toHaveBeenCalled();
		expect(window.open).not.toHaveBeenCalled();
	});

	it("keeps the 'Connect with a token (PAT)' area unaffected, requiring explicit PAT input", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openAddPanel(user);

		const patToggleButton = screen.getByRole("button", {
			name: /connect with a token \(pat\)/i,
		});
		await user.click(patToggleButton);

		expect(
			screen.queryByText(/optional — leave blank to reuse stored token/i),
		).not.toBeInTheDocument();

		const patRepoUrlInput = screen.getByPlaceholderText(
			/https:\/\/github\.com\/org\/repo, https:\/\/gitlab\.com\/group\/repo/i,
		);
		await user.type(patRepoUrlInput, "https://github.com/acme/third-repo");

		const testAndConnectButton = screen.getByRole("button", {
			name: /test & connect/i,
		});
		expect(testAndConnectButton).toBeDisabled();

		const patInput = screen.getByPlaceholderText("Paste your token here");
		await user.type(patInput, "ghp_newmanualtoken");

		expect(testAndConnectButton).not.toBeDisabled();
		await user.click(testAndConnectButton);

		await waitFor(() => {
			expect(connectFn).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					organizationId: "org-1",
					provider: "GITHUB",
					authMethod: "PAT",
					repositoryUrl: "https://github.com/acme/third-repo",
					repositoryOwner: "acme",
					repositoryName: "third-repo",
					pat: "ghp_newmanualtoken",
				}),
			);
		});
	});
});
