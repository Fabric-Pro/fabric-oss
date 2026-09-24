/**
 * Fizzy #2662 Codex round-3 follow-up.
 *
 * The GitLab picker's "already connected" filter used to compare the
 * picker's `repo.name` (GitLab's `path_with_namespace`, e.g.
 * "group/subgroup/repo") against a connected integration's
 * `repositoryName` — which, since the server-side canonicalisation fix,
 * is now the bare project slug (e.g. "repo"). That mismatch made every
 * already-connected GitLab repo look "fresh" again, offering to
 * reconnect it. This locks in the fix: the filter must recognise a match
 * against either the bare name or the owner-prefixed legacy shape.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listFn = vi.fn();
const githubStatusFn = vi.fn();
const gitlabStatusFn = vi.fn();
const gitlabStartFn = vi.fn();

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
				start: (...a: unknown[]) => gitlabStartFn(...a),
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

const toastError = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: (...a: unknown[]) => toastError(...a),
		info: vi.fn(),
	},
}));

// The real picker fetches and renders GitLab's own group/repo tree, which
// this test has no need to drive through checkboxes — only
// `handleGitLabPickerConfirm`'s dedup filter, given a fixed selection, is
// under test. Stubbed to a single button that fires `onConfirm` with a
// picker-shaped result (full-path `name`, matching what
// `list-projects.ts`'s `transformProject` actually returns).
vi.mock("../wizard/GitLabProjectPicker", () => ({
	GitLabProjectPicker: ({
		open,
		onConfirm,
	}: {
		open: boolean;
		onConfirm: (
			repos: Array<{
				name: string;
				fullName: string;
				owner: string;
				htmlUrl: string;
				defaultBranch: string;
				description: string | null;
				isPrivate: boolean;
				language: string | null;
				updatedAt: string;
				stars: number;
				isFork: boolean;
				roleTag?: string | null;
			}>,
		) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onConfirm([
						{
							name: "group/subgroup/repo",
							fullName: "group/subgroup/repo",
							owner: "group/subgroup",
							htmlUrl: "https://gitlab.com/group/subgroup/repo",
							defaultBranch: "main",
							description: null,
							isPrivate: false,
							language: null,
							updatedAt: new Date().toISOString(),
							stars: 0,
							isFork: false,
						},
					])
				}
			>
				confirm-gitlab-picker-selection
			</button>
		) : null,
}));

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
	toastError.mockReset();
	gitlabStartFn.mockReset().mockResolvedValue({ authorizationUrl: "u" });
	githubStatusFn.mockResolvedValue({ connected: false });
	gitlabStatusFn.mockResolvedValue({ connected: true });
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

async function openGitLabPicker(user: ReturnType<typeof userEvent.setup>) {
	const [addButton] = await screen.findAllByRole("button", {
		name: /add repository/i,
	});
	await user.click(addButton);
	// The "Browse GitLab Repositories" label and its "Browse" button are
	// siblings inside the same row; scope to that row so this doesn't collide
	// with the Azure DevOps picker's own "Browse" button elsewhere on the panel.
	const label = await screen.findByText(/browse gitlab repositories/i);
	const row = label.closest("div")?.parentElement as HTMLElement;
	const browseButton = within(row).getByRole("button", { name: "Browse" });
	await user.click(browseButton);
}

describe("ProjectRepositoryIntegrationSettings — GitLab picker dedup against a canonical stored row (Fizzy #2662)", () => {
	it("treats a picker result as already connected when the stored row's repositoryName is the bare slug", async () => {
		listFn.mockResolvedValue({
			integrations: [
				{
					id: "pri-1",
					provider: "GITLAB",
					status: "ACTIVE",
					repositoryOwner: "group/subgroup",
					// Canonical, bare form — what a row created after the
					// server-side normalization fix stores.
					repositoryName: "repo",
					authMethod: "OAUTH",
				},
			],
		});
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openGitLabPicker(user);

		const confirmButton = await screen.findByText(
			"confirm-gitlab-picker-selection",
		);
		await user.click(confirmButton);

		expect(toastError).toHaveBeenCalledWith(
			expect.stringMatching(/already connected/i),
		);
		expect(gitlabStartFn).not.toHaveBeenCalled();
	});

	it("still treats a picker result as already connected when a historical stored row's repositoryName is the legacy full path", async () => {
		listFn.mockResolvedValue({
			integrations: [
				{
					id: "pri-1",
					provider: "GITLAB",
					status: "ACTIVE",
					repositoryOwner: "group/subgroup",
					// Legacy, owner-doubled form — what a row created before the
					// fix (or before this round's migrate-in-place fix ran)
					// might still have stored.
					repositoryName: "group/subgroup/repo",
					authMethod: "OAUTH",
				},
			],
		});
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openGitLabPicker(user);

		const confirmButton = await screen.findByText(
			"confirm-gitlab-picker-selection",
		);
		await user.click(confirmButton);

		expect(toastError).toHaveBeenCalledWith(
			expect.stringMatching(/already connected/i),
		);
		expect(gitlabStartFn).not.toHaveBeenCalled();
	});
});
