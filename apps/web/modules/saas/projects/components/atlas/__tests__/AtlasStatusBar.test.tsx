/**
 * Component tests for `<AtlasStatusBar />`.
 *
 * Coverage:
 *   - Credential state machine: chip / Reconnect / Re-analyse enablement per
 *     `repositoryStatus` + `canAutoRefreshCredentials` + `authMethod`
 *   - Reconnect writes the settings sub-tab to localStorage AND dispatches the
 *     settings navigation event
 *   - Commit-indicator slot shows "monitoring paused" (never a stale count)
 *     while credentials are dead
 *   - Branch editor popover: open/prefill, save mutation, the four inline
 *     validation errors, FORBIDDEN toast, success invalidation + toast
 *   - "Re-analyse to switch to {branch}" hint shown exactly when the monitored
 *     branch differs from the analysed one
 */

import type { AtlasStatus } from "@repo/atlas/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATE_TO_SETTINGS_TAB_EVENT } from "../../settings-tab-navigation";

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the component import per Vitest hoisting rules.
// ----------------------------------------------------------------------------

const updateBranchFn = vi.fn();
const branchesListFn = vi.fn();
const setPinnedFn = vi.fn();
const statusKey = vi.fn(() => ["atlas", "status"]);
const listRepositoriesKey = vi.fn(() => ["atlas", "listRepositories"]);
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			repositoryIntegrations: {
				updateBranch: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationFn: (input: unknown) => updateBranchFn(input),
						...opts,
					}),
				},
			},
		},
		atlas: {
			status: { key: () => statusKey() },
			listRepositories: { key: () => listRepositoriesKey() },
			branches: {
				list: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["atlas", "branches", "list", opts.input],
						queryFn: () => branchesListFn(opts.input),
					}),
					queryKey: (opts: { input: unknown }) => [
						"atlas",
						"branches",
						"list",
						opts.input,
					],
					key: () => ["atlas", "branches", "list"],
				},
				setPinned: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationFn: (input: unknown) => setPinnedFn(input),
						...opts,
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
		loaded: true,
	}),
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: (...args: unknown[]) => toastSuccess(...args),
		error: (...args: unknown[]) => toastError(...args),
		warning: vi.fn(),
	}),
}));

// Key-passthrough that also surfaces interpolation values, so assertions can
// check both the key and its params (e.g. branchErrorNotFound + branch name).
vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values ? `${key}:${JSON.stringify(values)}` : key;
		return t;
	},
}));

// Import AFTER mocks so the component picks up the stubs.
import { AtlasStatusBar } from "../AtlasStatusBar";

// ----------------------------------------------------------------------------
// Fixtures / render helpers
// ----------------------------------------------------------------------------

type RepoOverrides = Partial<
	NonNullable<AtlasStatus["repository"]> & { authMethod: string }
>;

function buildStatus(
	overrides: Partial<AtlasStatus> & {
		canAutoRefreshCredentials?: boolean;
	} = {},
	repoOverrides: RepoOverrides = {},
): AtlasStatus {
	const repository = {
		repositoryIntegrationId: "integration-1",
		provider: "GITHUB",
		repositoryName: "acme/repo",
		repositoryUrl: "https://github.com/acme/repo",
		defaultBranch: "main",
		status: "ACTIVE",
		isDefault: true,
		authMethod: "OAUTH",
		...repoOverrides,
	};
	return {
		analysisId: "analysis-1",
		status: "READY",
		repository,
		hasRepository: true,
		repositoryStatus: "ACTIVE",
		canReanalyze: true,
		canAutoRefreshCredentials: false,
		analyzedCommitSha: "abc123f0000000000000000000000000000000ff",
		analyzedShortSha: "abc123f",
		analyzedAt: new Date().toISOString(),
		analyzedCommitAt: new Date().toISOString(),
		branch: "main",
		newCommitCount: 0,
		behindCommitCount: null,
		commitsComparable: true,
		headSha: null,
		nodeCount: 12,
		edgeCount: 9,
		filesAnalyzed: 30,
		techStack: null,
		businessTour: null,
		error: null,
		inFlightSince: null,
		...overrides,
	} as unknown as AtlasStatus;
}

function buildRepo(
	overrides: Partial<NonNullable<AtlasStatus["repository"]>> = {},
): NonNullable<AtlasStatus["repository"]> {
	return {
		repositoryIntegrationId: "integration-1",
		provider: "GITHUB",
		authMethod: "OAUTH",
		repositoryName: "acme/repo",
		repositoryUrl: "https://github.com/acme/repo",
		defaultBranch: "main",
		status: "ACTIVE",
		isDefault: true,
		...overrides,
	} as NonNullable<AtlasStatus["repository"]>;
}

function renderBar(
	status: AtlasStatus,
	extra?: {
		repositories?: NonNullable<AtlasStatus["repository"]>[];
		repositoryIntegrationId?: string | null;
		onRepoChange?: (id: string | null) => void;
	},
) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
	const onAnalyze = vi.fn();
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<AtlasStatusBar
				projectId="proj-1"
				status={status}
				onAnalyze={onAnalyze}
				isAnalyzing={false}
				repositories={extra?.repositories}
				repositoryIntegrationId={extra?.repositoryIntegrationId}
				onRepoChange={extra?.onRepoChange}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, queryClient, invalidateSpy, onAnalyze };
}

/** Assert each element appears strictly before the next in document order. */
function expectDomOrder(elements: HTMLElement[]) {
	for (let i = 0; i < elements.length - 1; i++) {
		const relation = elements[i].compareDocumentPosition(elements[i + 1]);
		expect(
			relation & Node.DOCUMENT_POSITION_FOLLOWING,
			`element ${i + 1} should follow element ${i}`,
		).toBeTruthy();
	}
}

beforeEach(() => {
	updateBranchFn.mockReset();
	updateBranchFn.mockResolvedValue({
		integration: { id: "integration-1", defaultBranch: "main" },
	});
	branchesListFn.mockReset();
	// main = default, develop = pinned, feature/x = plain.
	branchesListFn.mockResolvedValue({
		branches: [
			{ name: "main", isDefault: true, isPinned: false },
			{ name: "develop", isDefault: false, isPinned: true },
			{ name: "feature/x", isDefault: false, isPinned: false },
		],
	});
	setPinnedFn.mockReset();
	setPinnedFn.mockResolvedValue({ pinnedBranches: ["develop"] });
	toastSuccess.mockClear();
	toastError.mockClear();
	localStorage.clear();
});

// ----------------------------------------------------------------------------
// Credential state machine
// ----------------------------------------------------------------------------

describe("AtlasStatusBar — credential states", () => {
	it("ACTIVE: no credential chip, no Reconnect, Re-analyse enabled", () => {
		renderBar(buildStatus());

		expect(screen.queryByText("reconnectNeeded")).toBeNull();
		expect(screen.queryByText("patExpired")).toBeNull();
		expect(screen.queryByText("monitoringPaused")).toBeNull();
		expect(screen.queryByRole("button", { name: "reconnect" })).toBeNull();
		expect(screen.getByRole("button", { name: /reanalyze/ })).toBeEnabled();
	});

	it("non-ACTIVE + canAutoRefreshCredentials: reconnect chip + Reconnect button, Re-analyse stays ENABLED", () => {
		const { onAnalyze } = renderBar(
			buildStatus({
				repositoryStatus: "TOKEN_EXPIRED",
				canAutoRefreshCredentials: true,
			}),
		);

		expect(screen.getByText("reconnectNeeded")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "reconnect" }),
		).toBeInTheDocument();
		// The click path retries the refresh server-side, so the button must
		// not be disabled in this state.
		const reanalyze = screen.getByRole("button", { name: /reanalyze/ });
		expect(reanalyze).toBeEnabled();
		reanalyze.click();
		expect(onAnalyze).toHaveBeenCalledTimes(1);
	});

	it("REPO_UNAVAILABLE: repoUnavailable chip, NO Reconnect button, Re-analyse disabled with the grant-remedy tooltip", async () => {
		// The credential is fine — reconnecting cannot grant access to this
		// repository, so the bar must not offer it (Fizzy #2252).
		const user = userEvent.setup();
		renderBar(
			buildStatus({
				repositoryStatus: "REPO_UNAVAILABLE",
				canAutoRefreshCredentials: true,
			}),
		);

		expect(screen.getByText("repoUnavailable")).toBeInTheDocument();
		expect(screen.queryByText("reconnectNeeded")).toBeNull();
		expect(screen.queryByRole("button", { name: "reconnect" })).toBeNull();

		const reanalyze = screen.getByRole("button", { name: /reanalyze/ });
		expect(reanalyze).toBeDisabled();
		await user.hover(reanalyze.closest("span") as HTMLElement);
		const tips = await screen.findAllByText("reanalyzeDisabledRepo");
		expect(tips.length).toBeGreaterThan(0);
	});

	it("non-ACTIVE PAT provider: patExpired chip, Reconnect button, Re-analyse disabled with PAT tooltip", async () => {
		const user = userEvent.setup();
		renderBar(
			buildStatus(
				{
					repositoryStatus: "TOKEN_EXPIRED",
					canAutoRefreshCredentials: false,
				},
				{ provider: "AZURE_DEVOPS", authMethod: "PAT" },
			),
		);

		expect(screen.getByText("patExpired")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "reconnect" }),
		).toBeInTheDocument();
		const reanalyze = screen.getByRole("button", { name: /reanalyze/ });
		expect(reanalyze).toBeDisabled();

		// The explanatory tooltip sits on the wrapper span (a disabled button
		// emits no pointer events).
		const wrapper = reanalyze.closest("span");
		expect(wrapper).not.toBeNull();
		await user.hover(wrapper as HTMLElement);
		const tips = await screen.findAllByText("reanalyzeDisabledPat");
		expect(tips.length).toBeGreaterThan(0);
	});

	it("non-ACTIVE OAuth without refresh path: reconnectNeeded chip, Re-analyse disabled with reconnect tooltip", async () => {
		const user = userEvent.setup();
		renderBar(
			buildStatus(
				{
					repositoryStatus: "TOKEN_EXPIRED",
					canAutoRefreshCredentials: false,
				},
				{ provider: "GITLAB", authMethod: "OAUTH" },
			),
		);

		expect(screen.getByText("reconnectNeeded")).toBeInTheDocument();
		const reanalyze = screen.getByRole("button", { name: /reanalyze/ });
		expect(reanalyze).toBeDisabled();

		await user.hover(reanalyze.closest("span") as HTMLElement);
		const tips = await screen.findAllByText("reanalyzeDisabledReconnect");
		expect(tips.length).toBeGreaterThan(0);
	});

	it("DISCONNECTED: no reconnect chip, no Reconnect button, no paused slot, Re-analyse disabled", () => {
		renderBar(
			buildStatus({
				repositoryStatus: "DISCONNECTED",
				canAutoRefreshCredentials: false,
			}),
		);

		expect(screen.queryByText("reconnectNeeded")).toBeNull();
		expect(screen.queryByText("patExpired")).toBeNull();
		expect(screen.queryByText("monitoringPaused")).toBeNull();
		expect(screen.queryByRole("button", { name: "reconnect" })).toBeNull();
		expect(
			screen.getByRole("button", { name: /reanalyze/ }),
		).toBeDisabled();
	});

	it("never renders the stale reanalyse-recommended chip while credentials are dead", () => {
		renderBar(
			buildStatus({
				repositoryStatus: "TOKEN_EXPIRED",
				canAutoRefreshCredentials: true,
				commitsComparable: false,
			}),
		);

		expect(screen.queryByText("reanalyzeRecommended")).toBeNull();
	});
});

// ----------------------------------------------------------------------------
// Monitoring-paused slot (commit indicator)
// ----------------------------------------------------------------------------

describe("AtlasStatusBar — commit monitoring slot", () => {
	it("shows the paused notice instead of a stale commit-diff indicator while credentials are dead", () => {
		renderBar(
			buildStatus({
				repositoryStatus: "TOKEN_EXPIRED",
				canAutoRefreshCredentials: true,
				newCommitCount: 5,
				behindCommitCount: 2,
			}),
		);

		expect(screen.getByText("monitoringPaused")).toBeInTheDocument();
		// No fake/stale counts.
		expect(screen.queryByText("+5")).toBeNull();
		expect(screen.queryByText("−2")).toBeNull();
	});
});

// ----------------------------------------------------------------------------
// Commit-diff indicator (+N −M)
// ----------------------------------------------------------------------------

describe("AtlasStatusBar — commit diff indicator", () => {
	it("shows +N only when ahead > 0 and behind is 0", () => {
		renderBar(buildStatus({ newCommitCount: 51, behindCommitCount: 0 }));

		expect(screen.getByText("+51")).toBeInTheDocument();
		// Never −0.
		expect(screen.queryByText(/^−/)).toBeNull();
		expect(screen.queryByText("monitoringPaused")).toBeNull();
	});

	it("shows +N only when behind is null (provider can't compute it)", () => {
		renderBar(buildStatus({ newCommitCount: 4, behindCommitCount: null }));

		expect(screen.getByText("+4")).toBeInTheDocument();
		expect(screen.queryByText(/^−/)).toBeNull();
	});

	it("shows +N −M with the proper minus sign when both counts are positive", () => {
		renderBar(buildStatus({ newCommitCount: 51, behindCommitCount: 2 }));

		expect(screen.getByText("+51")).toBeInTheDocument();
		// U+2212 minus, matching diff aesthetics — not the ASCII hyphen.
		expect(screen.getByText("−2")).toBeInTheDocument();
		expect(screen.queryByText("-2")).toBeNull();
	});

	it("shows −M only when behind > 0 and ahead is 0", () => {
		renderBar(buildStatus({ newCommitCount: 0, behindCommitCount: 3 }));

		expect(screen.getByText("−3")).toBeInTheDocument();
		expect(screen.queryByText(/^\+/)).toBeNull();
	});

	it("renders nothing when both counts are 0", () => {
		renderBar(buildStatus({ newCommitCount: 0, behindCommitCount: 0 }));

		expect(screen.queryByText(/^\+/)).toBeNull();
		expect(screen.queryByText(/^−/)).toBeNull();
	});

	it("renders nothing while the history is incomparable", () => {
		renderBar(
			buildStatus({
				newCommitCount: 3,
				behindCommitCount: 1,
				commitsComparable: false,
			}),
		);

		expect(screen.queryByText("+3")).toBeNull();
		expect(screen.queryByText("−1")).toBeNull();
		// The recommendation chip still explains the situation.
		expect(screen.getByText("reanalyzeRecommended")).toBeInTheDocument();
	});

	it("carries a summarising aria-label and explains both numbers in the tooltip", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus({ newCommitCount: 51, behindCommitCount: 2 }));

		const indicator = screen.getByLabelText(
			'commitDiffAriaAhead:{"count":51}, commitDiffAriaBehind:{"count":2}',
		);
		expect(indicator).toBeInTheDocument();

		await user.hover(indicator);
		const ahead = await screen.findAllByText(
			'commitDiffTooltipAhead:{"count":51,"branch":"main"}',
		);
		expect(ahead.length).toBeGreaterThan(0);
		expect(
			screen.getAllByText('commitDiffTooltipBehind:{"count":2}').length,
		).toBeGreaterThan(0);
	});

	it("keeps the re-analyse recommended chip for ahead-only drift (new-commits reason)", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus({ newCommitCount: 5, behindCommitCount: 0 }));

		const chip = screen.getByText("reanalyzeRecommended");
		expect(chip).toBeInTheDocument();
		await user.hover(chip);
		const reason = await screen.findAllByText(
			'reanalyzeReasonNewCommits:{"count":5,"branch":"main"}',
		);
		expect(reason.length).toBeGreaterThan(0);
	});

	it("keeps the re-analyse recommended chip for behind drift (history-changed reason)", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus({ newCommitCount: 5, behindCommitCount: 2 }));

		const chip = screen.getByText("reanalyzeRecommended");
		expect(chip).toBeInTheDocument();
		// Removed snapshot commits mean the history changed — the incomparable
		// wording wins over the plain new-commits reason.
		await user.hover(chip);
		const reason = await screen.findAllByText(
			"reanalyzeReasonIncomparable",
		);
		expect(reason.length).toBeGreaterThan(0);
	});
});

// ----------------------------------------------------------------------------
// Reconnect deep-link
// ----------------------------------------------------------------------------

describe("AtlasStatusBar — Reconnect", () => {
	it("writes the development sub-tab to sessionStorage and dispatches the settings navigation event", async () => {
		const user = userEvent.setup();
		const received: CustomEvent[] = [];
		const handler = (event: Event) => {
			received.push(event as CustomEvent);
		};
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);

		try {
			renderBar(
				buildStatus({
					repositoryStatus: "TOKEN_EXPIRED",
					canAutoRefreshCredentials: true,
				}),
			);

			await user.click(screen.getByRole("button", { name: "reconnect" }));

			expect(
				sessionStorage.getItem("fabric-project-settings-tab-proj-1"),
			).toBe("development");
			expect(received).toHaveLength(1);
			expect(received[0].detail).toEqual({
				projectId: "proj-1",
				settingsTab: "development",
			});
		} finally {
			window.removeEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);
		}
	});
});

// ----------------------------------------------------------------------------
// Branch editor popover
// ----------------------------------------------------------------------------

async function openBranchPicker(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "editBranch" }));
	// Wait for the lazily-loaded branch list to render.
	return screen.findByRole("option", { name: /main/ });
}

// Force the live branch list to fail so the free-text fallback renders.
async function openBranchFallback(user: ReturnType<typeof userEvent.setup>) {
	branchesListFn.mockReset();
	branchesListFn.mockRejectedValue(new Error("list unavailable"));
	await user.click(screen.getByRole("button", { name: "editBranch" }));
	return screen.findByLabelText("branchInputLabel");
}

describe("AtlasStatusBar — branch picker", () => {
	it("opens a searchable list of branches (default-badged) on open", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus());

		await openBranchPicker(user);
		expect(
			screen.getByPlaceholderText("branchSearchPlaceholder"),
		).toBeInTheDocument();
		// All three remote branches are listed…
		expect(
			screen.getByRole("option", { name: /main/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: /develop/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: /feature\/x/ }),
		).toBeInTheDocument();
		// …and the repo default carries the "default" badge.
		expect(screen.getByText("branchDefaultBadge")).toBeInTheDocument();
		// The list is fetched scoped to the project + repo.
		expect(branchesListFn).toHaveBeenCalledWith({
			projectId: "proj-1",
			repositoryIntegrationId: "integration-1",
			organizationId: null,
		});
	});

	it("hides the edit affordance when there is no repository integration", () => {
		renderBar(buildStatus({}, { repositoryIntegrationId: null }));

		expect(screen.queryByRole("button", { name: "editBranch" })).toBeNull();
	});

	it("selecting a listed branch sets it via the tenant-scoped updateBranch", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus());

		await openBranchPicker(user);
		await user.click(screen.getByRole("option", { name: /develop/ }));

		await waitFor(() => {
			expect(updateBranchFn).toHaveBeenCalledTimes(1);
		});
		expect(updateBranchFn).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			integrationId: "integration-1",
			branch: "develop",
		});
	});

	it("typing an unlisted branch offers a 'use this' entry that sets it", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus());

		await openBranchPicker(user);
		await user.type(
			screen.getByPlaceholderText("branchSearchPlaceholder"),
			"release/9.9",
		);
		await user.click(
			await screen.findByRole("option", { name: /branchUseCustom/ }),
		);

		await waitFor(() => {
			expect(updateBranchFn).toHaveBeenCalledWith({
				projectId: "proj-1",
				organizationId: null,
				integrationId: "integration-1",
				branch: "release/9.9",
			});
		});
	});

	it("pinning an unpinned branch sends the full pins set (current + this)", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus());

		await openBranchPicker(user);
		await user.click(
			screen.getByRole("button", {
				name: 'pinBranch:{"branch":"feature/x"}',
			}),
		);

		await waitFor(() => {
			expect(setPinnedFn).toHaveBeenCalledTimes(1);
		});
		expect(setPinnedFn).toHaveBeenCalledWith({
			projectId: "proj-1",
			repositoryIntegrationId: "integration-1",
			branches: ["develop", "feature/x"],
			organizationId: null,
		});
		// Pinning never selects the branch.
		expect(updateBranchFn).not.toHaveBeenCalled();
	});

	it("unpinning a pinned branch removes it from the pins set", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus());

		await openBranchPicker(user);
		await user.click(
			screen.getByRole("button", {
				name: 'unpinBranch:{"branch":"develop"}',
			}),
		);

		await waitFor(() => {
			expect(setPinnedFn).toHaveBeenCalledWith({
				projectId: "proj-1",
				repositoryIntegrationId: "integration-1",
				branches: [],
				organizationId: null,
			});
		});
	});

	it("on a successful save: invalidates status + repositories, closes, toasts", async () => {
		const user = userEvent.setup();
		const { invalidateSpy } = renderBar(buildStatus());

		await openBranchPicker(user);
		await user.click(screen.getByRole("option", { name: /develop/ }));

		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith("branchSaved");
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["atlas", "status"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["atlas", "listRepositories"],
		});
		await waitFor(() => {
			expect(
				screen.queryByRole("option", { name: /develop/ }),
			).toBeNull();
		});
	});
});

describe("AtlasStatusBar — branch picker free-text fallback", () => {
	it("falls back to a free-text input when the branch list fails to load", async () => {
		const user = userEvent.setup();
		renderBar(
			buildStatus({ branch: "main" }, { defaultBranch: "develop" }),
		);

		const input = await openBranchFallback(user);
		// Prefilled with the monitored branch.
		expect(input).toHaveValue("develop");
		expect(screen.getByText("branchListError")).toBeInTheDocument();
	});

	it("saves the branch with the full tenant-scoped input", async () => {
		const user = userEvent.setup();
		renderBar(buildStatus());

		const input = await openBranchFallback(user);
		await user.clear(input);
		await user.type(input, "release/1.2");
		await user.click(screen.getByRole("button", { name: "branchSave" }));

		await waitFor(() => {
			expect(updateBranchFn).toHaveBeenCalledTimes(1);
		});
		expect(updateBranchFn).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			integrationId: "integration-1",
			branch: "release/1.2",
		});
	});

	it.each([
		[
			"branch not found → branchErrorNotFound with the branch name",
			{
				code: "BAD_REQUEST",
				message: 'Branch "ghost" wasn\'t found on the remote.',
			},
			'branchErrorNotFound:{"branch":"ghost"}',
		],
		[
			"expired credentials → branchErrorCredentials",
			{
				code: "BAD_REQUEST",
				message:
					"Repository credentials have expired — reconnect the repository to change the branch.",
			},
			"branchErrorCredentials",
		],
		[
			"remote unreachable → branchErrorNetwork",
			{
				code: "INTERNAL_SERVER_ERROR",
				message:
					"Couldn't reach the repository to verify the branch. Try again in a moment.",
			},
			"branchErrorNetwork",
		],
		[
			"unrecognised error → branchErrorGeneric",
			{ code: "CONFLICT", message: "something odd happened" },
			"branchErrorGeneric",
		],
		// Structured server markers win even when the message is opaque.
		[
			"data.code BRANCH_NOT_FOUND → branchErrorNotFound",
			{
				code: "BAD_REQUEST",
				message: "Bad request",
				data: { code: "BRANCH_NOT_FOUND" },
			},
			'branchErrorNotFound:{"branch":"ghost"}',
		],
		[
			"data.code REPOSITORY_CREDENTIALS_EXPIRED → branchErrorCredentials",
			{
				code: "BAD_REQUEST",
				message: "Bad request",
				data: { code: "REPOSITORY_CREDENTIALS_EXPIRED" },
			},
			"branchErrorCredentials",
		],
		[
			"data.code REPOSITORY_DISCONNECTED → branchErrorCredentials",
			{
				code: "BAD_REQUEST",
				message: "Bad request",
				data: { code: "REPOSITORY_DISCONNECTED" },
			},
			"branchErrorCredentials",
		],
		[
			"data.code REPOSITORY_UNREACHABLE → branchErrorNetwork",
			{
				code: "INTERNAL_SERVER_ERROR",
				message: "Server error",
				data: { code: "REPOSITORY_UNREACHABLE" },
			},
			"branchErrorNetwork",
		],
	])("renders the inline error: %s", async (_label, errorShape, expected) => {
		const user = userEvent.setup();
		const { data } = errorShape as { data?: { code: string } };
		updateBranchFn.mockRejectedValueOnce(
			Object.assign(new Error(errorShape.message), {
				code: errorShape.code,
				...(data ? { data } : {}),
			}),
		);
		renderBar(buildStatus());

		const input = await openBranchFallback(user);
		await user.clear(input);
		await user.type(input, "ghost");
		await user.click(screen.getByRole("button", { name: "branchSave" }));

		expect(await screen.findByText(expected)).toBeInTheDocument();
		// Inline errors never toast (the popover stays open for a retry).
		expect(toastError).not.toHaveBeenCalled();
		expect(screen.getByLabelText("branchInputLabel")).toBeInTheDocument();
	});

	it("FORBIDDEN surfaces as a calm toast, not an inline error", async () => {
		const user = userEvent.setup();
		updateBranchFn.mockRejectedValueOnce(
			Object.assign(new Error("Missing permission"), {
				code: "FORBIDDEN",
			}),
		);
		renderBar(buildStatus());

		const input = await openBranchFallback(user);
		await user.clear(input);
		await user.type(input, "develop");
		await user.click(screen.getByRole("button", { name: "branchSave" }));

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith(
				"branchErrorGeneric",
				expect.objectContaining({ description: "Missing permission" }),
			);
		});
		expect(screen.queryByText("branchErrorCredentials")).toBeNull();
		expect(screen.queryByText("branchErrorGeneric")).toBeNull();
	});
});

// ----------------------------------------------------------------------------
// Re-analyse-to-apply hint
// ----------------------------------------------------------------------------

describe("AtlasStatusBar — re-analyse hint", () => {
	it("shows the hint when the monitored branch differs from the analysed branch", () => {
		renderBar(
			buildStatus({ branch: "main" }, { defaultBranch: "develop" }),
		);

		expect(
			screen.getByText('reanalyzeToApply:{"branch":"develop"}'),
		).toBeInTheDocument();
	});

	it("hides the hint when monitored and analysed branches match", () => {
		renderBar(buildStatus({ branch: "main" }, { defaultBranch: "main" }));

		expect(screen.queryByText(/^reanalyzeToApply/)).toBeNull();
	});
});

// ----------------------------------------------------------------------------
// Left-cluster order + repository dropdown relocation
// ----------------------------------------------------------------------------

describe("AtlasStatusBar — left-cluster order", () => {
	it("orders the left cluster: repository → branch → commit → last update → message", () => {
		renderBar(
			// Ahead-only drift → a `+N` indicator on the commit chip + the
			// re-analyse-recommended message chip at the end.
			buildStatus({ newCommitCount: 5, behindCommitCount: 0 }),
			{
				repositories: [
					buildRepo(),
					buildRepo({
						repositoryIntegrationId: "integration-2",
						repositoryName: "acme/other",
						isDefault: false,
					}),
				],
				repositoryIntegrationId: "integration-1",
				onRepoChange: vi.fn(),
			},
		);

		const repo = screen.getByRole("combobox");
		const branch = screen.getByText("main");
		const commit = screen.getByText("abc123f");
		const lastUpdate = screen.getByText("just now");
		const message = screen.getByText("reanalyzeRecommended");

		expectDomOrder([repo, branch, commit, lastUpdate, message]);
	});

	it("renders the repository dropdown as the FIRST item, even for a single repo", () => {
		renderBar(buildStatus(), {
			repositories: [buildRepo()],
			repositoryIntegrationId: "integration-1",
			onRepoChange: vi.fn(),
		});

		const repo = screen.getByRole("combobox");
		// The analysed-commit chip sits after the relocated repo dropdown.
		const commit = screen.getByText("abc123f");
		expectDomOrder([repo, commit]);
	});

	it("falls back to status.repository when no repositories list is provided", () => {
		// The bar still surfaces the source as a dropdown (single fallback repo).
		renderBar(buildStatus());

		expect(screen.getByRole("combobox")).toBeInTheDocument();
	});
});

// ----------------------------------------------------------------------------
// Re-analyse split button (default vs from-fresh)
// ----------------------------------------------------------------------------

describe("AtlasStatusBar — re-analyse split button", () => {
	it("primary click re-analyses respecting manual edits (fresh:false)", async () => {
		const user = userEvent.setup();
		const { onAnalyze } = renderBar(buildStatus());

		await user.click(screen.getByRole("button", { name: /reanalyze/ }));
		expect(onAnalyze).toHaveBeenCalledTimes(1);
		expect(onAnalyze).toHaveBeenCalledWith({ fresh: false });
	});

	it("the chevron opens a menu whose 'from fresh' item re-analyses with fresh:true", async () => {
		const user = userEvent.setup();
		const { onAnalyze } = renderBar(buildStatus());

		await user.click(
			screen.getByRole("button", { name: "analyzeOptions" }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: /reanalyzeFresh/ }),
		);

		expect(onAnalyze).toHaveBeenCalledWith({ fresh: true });
	});

	it("the not-yet-analysed state is a single plain Analyse button (no fresh option)", () => {
		renderBar(
			buildStatus({ status: "NOT_ANALYZED", analyzedShortSha: null }),
		);

		expect(
			screen.getByRole("button", { name: "analyze" }),
		).toBeInTheDocument();
		// No split — the fresh-options chevron only exists once analysed.
		expect(
			screen.queryByRole("button", { name: "analyzeOptions" }),
		).toBeNull();
	});
});

// ----------------------------------------------------------------------------
// Non-blocking background re-analysis indicator (activeRun)
// ----------------------------------------------------------------------------

describe("AtlasStatusBar — background re-analysis", () => {
	it("shows a background indicator + disables both re-analyse controls while activeRun is set", () => {
		renderBar(
			buildStatus({
				// A drift that would otherwise raise "re-analyse recommended"…
				newCommitCount: 5,
				behindCommitCount: 0,
				// …but a background run is already addressing it.
				activeRun: {
					status: "ANALYZING",
					startedAt: new Date().toISOString(),
				},
			}),
		);

		// Non-blocking indicator in the bar (the graph itself stays mounted
		// upstream — status is still READY).
		expect(screen.getByText("analyzingInBackground")).toBeInTheDocument();
		// The primary control reads "Analysing…" and is disabled, as is the
		// fresh-options chevron.
		expect(
			screen.getByRole("button", { name: "analyzing" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "analyzeOptions" }),
		).toBeDisabled();
		// The stale-drift chip is suppressed while a run is in flight.
		expect(screen.queryByText("reanalyzeRecommended")).toBeNull();
	});

	it("announces the result once a background run advances the analysed commit", async () => {
		const { rerender, queryClient } = renderBar(
			buildStatus({
				analyzedCommitSha: "old000000000000000000000000000000000000f",
				analyzedShortSha: "old0000",
				activeRun: {
					status: "ANALYZING",
					startedAt: new Date().toISOString(),
				},
			}),
		);

		// The run clears and the served commit advances → calm "updated" toast.
		rerender(
			<QueryClientProvider client={queryClient}>
				<AtlasStatusBar
					projectId="proj-1"
					status={buildStatus({
						analyzedCommitSha:
							"new000000000000000000000000000000000000f",
						analyzedShortSha: "new0000",
						activeRun: null,
					})}
					onAnalyze={vi.fn()}
					isAnalyzing={false}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith(
				'backgroundRunUpdated:{"sha":"new0000"}',
			);
		});
	});
});
