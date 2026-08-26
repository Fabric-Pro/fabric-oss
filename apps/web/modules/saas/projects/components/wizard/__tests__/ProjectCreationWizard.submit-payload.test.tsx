/**
 * Submit-handler / payload-mapping tests for the unified `ProjectCreationWizard`
 * (unified-project-setup spec §3 AC#3, §4.3, §4.7, §11; tasks TG1 §1.1, TG3 §3.1).
 *
 * Scope:
 *   (a) Cards untouched → `projects.create` payload carries NO PM block, NO
 *       repo fields, and does NOT force `skipAutoSync`; NO workflow-start call
 *       fires (AC#3).
 *   (b) Backlog validation — a PM tool selected without a container blocks
 *       submit with the specific copy; ADO additionally requires a board/team.
 *   (c) O1 workflow routing (TG3): a connected repo and/or backlog sets
 *       `skipAutoSync: true` on `create` and fires exactly ONE
 *       `existingSetup.start` (never the retired `startCodeSetup`), with the
 *       expected `repoUrls` / doc-gen fields. Fire-and-forget: a rejected start
 *       surfaces a warning toast and still redirects.
 *
 * The wizard's heavy step children are mocked as inert stubs (we don't need the
 * card UI here — these tests drive the form-state + submit handler directly).
 * The cards' own collapsed/expand/picker behavior is covered by the colocated
 * card render tests. oRPC is mocked only at the client boundary.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
	// The wizard calls window.scrollTo on step change; jsdom doesn't implement
	// it. Stub it so the test output stays free of "Not implemented" noise.
	window.scrollTo = (() => undefined) as typeof window.scrollTo;
});

// ── Hoisted mock fns ─────────────────────────────────────────────────────
const {
	createMutationFn,
	startCodeSetupGithubMock,
	startCodeSetupGitlabMock,
	startCodeSetupAzureDevOpsMock,
	connectRepoIntegrationMock,
	startExistingSetupMock,
	pushMock,
	toastErrorMock,
	toastWarningMock,
	createIntegrationContextsMock,
	createBacklogIntegrationContextMock,
} = vi.hoisted(() => ({
	createMutationFn: vi.fn(),
	startCodeSetupGithubMock: vi.fn(),
	startCodeSetupGitlabMock: vi.fn(),
	startCodeSetupAzureDevOpsMock: vi.fn(),
	connectRepoIntegrationMock: vi.fn(),
	startExistingSetupMock: vi.fn(),
	pushMock: vi.fn(),
	toastErrorMock: vi.fn(),
	toastWarningMock: vi.fn(),
	createIntegrationContextsMock: vi.fn(),
	createBacklogIntegrationContextMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: pushMock,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/app/projects/new",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				cancelDraftCrawls: vi.fn(),
			},
			delete: vi.fn(),
			github: {
				startCodeSetup: (input: unknown) =>
					startCodeSetupGithubMock(input),
			},
			gitlab: {
				startCodeSetup: (input: unknown) =>
					startCodeSetupGitlabMock(input),
			},
			// Registered-but-wizard-unused per O1 (the wizard routes ADO
			// through existingSetup.start). Mocked so the "NO startCodeSetup"
			// assertions can also cover ADO.
			azureDevOps: {
				startCodeSetup: (input: unknown) =>
					startCodeSetupAzureDevOpsMock(input),
			},
			// ADO has no OAuth — the unified wizard creates one
			// ProjectRepositoryIntegration per repo via `connect` before
			// existingSetup.start (PR #1219 pre-create path, O1-adapted).
			repositoryIntegrations: {
				connect: (input: unknown) => connectRepoIntegrationMock(input),
			},
			existingSetup: {
				start: (input: unknown) => startExistingSetupMock(input),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			create: {
				mutationOptions: (opts: {
					onSuccess?: (data: {
						project: { id: string };
					}) => void | Promise<void>;
					onError?: (err: { message: string }) => void;
				}) => ({
					mutationFn: async (input: unknown) => {
						createMutationFn(input);
						return { project: { id: "proj_new_1" } };
					},
					onSuccess: opts.onSuccess,
					onError: opts.onError,
				}),
			},
			update: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({ project: { id: "p" } }),
					...opts,
				}),
			},
			saveDraft: {
				mutationOptions: (opts: {
					onSuccess?: (data: {
						created: boolean;
						project: { id: string };
					}) => void;
				}) => ({
					mutationFn: async () => ({
						created: false,
						project: { id: "p" },
					}),
					onSuccess: opts.onSuccess,
				}),
			},
			listDrafts: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.listDrafts", input] as const,
					queryFn: async () => ({ drafts: [] }),
				}),
			},
			get: {
				call: async () => ({ project: null }),
			},
			checkName: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.checkName", input] as const,
					queryFn: async () => ({ available: true }),
				}),
			},
			contexts: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.contexts.list", input] as const,
						queryFn: async () => ({ contexts: [] }),
					}),
				},
			},
		},
		wizard: {
			refineDescription: {
				mutationOptions: () => ({ mutationFn: async () => undefined }),
			},
		},
	},
}));

vi.mock("../../../hooks/use-wizard-session-persistence", () => ({
	useWizardSessionPersistence: () => ({ save: vi.fn(), clear: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: toastErrorMock,
		info: vi.fn(),
		warning: toastWarningMock,
	},
}));

// Heavy dynamic step children → inert stubs. The submit-handler tests drive
// form-state via the BasicInfoStep name input (which the wizard owns) and the
// footer Create button, not the step internals. A few extra buttons drive the
// optional-card form-state directly (the real cards' UI is covered by the
// colocated card render tests; here we only exercise the wizard submit handler
// + onSuccess routing).
vi.mock("next/dynamic", () => ({
	default: (
		_loader: () => Promise<unknown>,
		_opts?: { ssr?: boolean; loading?: () => React.ReactNode },
	) => {
		const Stub = (props: {
			formData?: { name?: string };
			updateFormData?: (u: Record<string, unknown>) => void;
			onAzureDevOpsReposChange?: (
				repos: unknown[],
				creds?: { pat: string; azureOrganization: string },
			) => void;
		}) => {
			if (props.updateFormData && props.formData) {
				const update = props.updateFormData;
				const onAdoChange = props.onAzureDevOpsReposChange;
				return (
					<div data-testid="brief-step-stub">
						<input
							aria-label="Project Name"
							value={props.formData.name ?? ""}
							onChange={(e) => update({ name: e.target.value })}
						/>
						{/* Since Fizzy #2165 step 1 needs a description past the
						    readiness threshold and a phase before the wizard
						    will move on. */}
						<button
							type="button"
							data-testid="fill-project-basics"
							onClick={() =>
								update({
									description:
										"A description comfortably past the fifty-character minimum the readiness checklist asks for.",
									projectPhase: "DEVELOPMENT_EXECUTION",
								})
							}
						>
							Fill basics
						</button>
						{/* Backlog: PM tool selected but no container (invalid). */}
						<button
							type="button"
							data-testid="connect-backlog-no-container"
							onClick={() =>
								update({
									projectManagementMcpConfigId: "cfg-1",
									projectManagementMcpServerId: "srv-1",
									projectManagementContainerId: null,
									projectManagementDetectedType: "jira",
								})
							}
						>
							connect backlog (no container)
						</button>
						{/* Backlog: fully configured (valid). */}
						<button
							type="button"
							data-testid="connect-backlog-complete"
							onClick={() =>
								update({
									projectManagementMcpConfigId: "cfg-1",
									projectManagementMcpServerId: "srv-1",
									projectManagementContainerId: "board-7",
									projectManagementContainerName:
										"Mobile Board",
									projectManagementDetectedType: "jira",
								})
							}
						>
							connect backlog (complete)
						</button>
						{/* Repo: connect a GitHub repo (mirrors the Code Repository
						    section: sets selectedGitHubRepos; buildRepoUrls unions
						    the htmlUrls for existingSetup.start). */}
						<button
							type="button"
							data-testid="connect-github-repo"
							onClick={() =>
								update({
									selectedGitHubRepos: [
										{
											name: "api",
											fullName: "acme/api",
											description: null,
											isPrivate: false,
											htmlUrl:
												"https://github.com/acme/api",
											language: "TypeScript",
											defaultBranch: "main",
											updatedAt: new Date().toISOString(),
											stars: 0,
											isFork: false,
											owner: "acme",
										},
									],
									codebaseRepoUrls: [
										"https://github.com/acme/api",
									],
								})
							}
						>
							connect github repo
						</button>
						{/* Repo: connect a GitLab repo. */}
						<button
							type="button"
							data-testid="connect-gitlab-repo"
							onClick={() =>
								update({
									selectedGitLabRepos: [
										{
											name: "web",
											fullName: "acme/web",
											description: null,
											isPrivate: false,
											htmlUrl:
												"https://gitlab.com/acme/web",
											language: "Vue",
											defaultBranch: "main",
											owner: "acme",
										},
									],
									codebaseRepoUrls: [
										"https://gitlab.com/acme/web",
									],
								})
							}
						>
							connect gitlab repo
						</button>
						{/* Repo: ADO connected via the DRAFT-projectId path — the
						    PAT picker already created the integrations itself, so
						    only the URL lands in codebaseRepoUrls (no creds held,
						    so the wizard makes no in-wizard `connect` call). */}
						<button
							type="button"
							data-testid="connect-ado-repo"
							onClick={() =>
								update({
									codebaseRepoUrls: [
										"https://dev.azure.com/acme/proj/_git/repo",
									],
								})
							}
						>
							connect ado repo
						</button>
						{/* Repo: ADO connected via the PRE-CREATE path — the picker
						    emits repos + a transient PAT through
						    `onAzureDevOpsReposChange`; the wizard then creates one
						    ProjectRepositoryIntegration per repo via `connect`
						    BEFORE existingSetup.start (PR #1219 path, O1-adapted). */}
						<button
							type="button"
							data-testid="connect-ado-repo-with-pat"
							onClick={() =>
								onAdoChange?.(
									[
										{
											name: "repo",
											projectName: "proj",
											fullName:
												"https://dev.azure.com/acme/proj/_git/repo",
											htmlUrl:
												"https://dev.azure.com/acme/proj/_git/repo",
											defaultBranch: "main",
											isPrivate: true,
											language: null,
										},
									],
									{
										pat: "secret-pat-token",
										azureOrganization: "acme",
									},
								)
							}
						>
							connect ado repo (with PAT)
						</button>
						<button
							type="button"
							data-testid="connect-ado-two-repos-with-pat"
							onClick={() =>
								onAdoChange?.(
									[
										{
											name: "repo1",
											projectName: "proj",
											fullName:
												"https://dev.azure.com/acme/proj/_git/repo1",
											htmlUrl:
												"https://dev.azure.com/acme/proj/_git/repo1",
											defaultBranch: "main",
											isPrivate: true,
											language: null,
										},
										{
											name: "repo2",
											projectName: "proj",
											fullName:
												"https://dev.azure.com/acme/proj/_git/repo2",
											htmlUrl:
												"https://dev.azure.com/acme/proj/_git/repo2",
											defaultBranch: "main",
											isPrivate: true,
											language: null,
										},
									],
									{
										pat: "secret-pat-token",
										azureOrganization: "acme",
									},
								)
							}
						>
							connect 2 ado repos (with PAT)
						</button>
						{/* Chip removal invocation: calls onAzureDevOpsReposChange with 1 remaining repo and NO creds arg */}
						<button
							type="button"
							data-testid="remove-ado-chip-no-creds"
							onClick={() =>
								onAdoChange?.([
									{
										name: "repo2",
										projectName: "proj",
										fullName:
											"https://dev.azure.com/acme/proj/_git/repo2",
										htmlUrl:
											"https://dev.azure.com/acme/proj/_git/repo2",
										defaultBranch: "main",
										isPrivate: true,
										language: null,
									},
								])
							}
						>
							remove ado chip (no creds)
						</button>
					</div>
				);
			}
			return <div data-testid="dynamic-step-stub" />;
		};
		Stub.displayName = "DynamicStepStub";
		return Stub;
	},
}));

vi.mock("../../../lib/create-integration-contexts", () => ({
	createIntegrationContexts: (input: unknown) => {
		createIntegrationContextsMock(input);
		return Promise.resolve({ successCount: 0, failCount: 0 });
	},
	createBacklogIntegrationContext: (input: unknown) =>
		createBacklogIntegrationContextMock(input),
}));

// ReviewPromptsStep pulls in PromptSelector (heavy); stub it.
vi.mock("../ReviewPromptsStep", () => ({
	ReviewPromptsStep: () => <div data-testid="review-prompts-stub" />,
}));

import { ProjectCreationWizard } from "../../ProjectCreationWizard";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

/**
 * Type a project name, jump to the Review step via the stepper, and click
 * Create. With no cards touched this is the AC#3 minimal path; tests that need
 * a connected repo/backlog click the relevant stub button before calling this.
 *
 * Both flows expose Review via the "Review" stepper button. The submit button
 * label differs: the standard flow reads "Create Project" while the code-based
 * flow (any repo connected → CODE_BASED_STEPS) reads "Create & Analyze". The
 * regex matches either so this helper works for both routing cases.
 */
async function gotoReviewAndCreate(user: ReturnType<typeof userEvent.setup>) {
	const reviewStepButton = await screen.findByRole("button", {
		name: /Review/i,
	});
	await user.click(reviewStepButton);

	const createButton = await screen.findByRole("button", {
		name: /^(Create Project|Create & Analyze)$/i,
	});
	await user.click(createButton);
}

async function typeName(
	user: ReturnType<typeof userEvent.setup>,
	name: string,
) {
	const nameInput = await screen.findByLabelText(/project name/i);
	await user.type(nameInput, name);
	await user.click(await screen.findByTestId("fill-project-basics"));
}

describe("ProjectCreationWizard — submit payload (AC#3, TG1)", () => {
	beforeEach(() => {
		createMutationFn.mockReset();
		startCodeSetupGithubMock.mockReset();
		startCodeSetupGitlabMock.mockReset();
		startCodeSetupAzureDevOpsMock.mockReset();
		connectRepoIntegrationMock.mockReset();
		connectRepoIntegrationMock.mockResolvedValue(undefined);
		startExistingSetupMock.mockReset();
		startExistingSetupMock.mockResolvedValue(undefined);
		pushMock.mockReset();
		toastErrorMock.mockReset();
		toastWarningMock.mockReset();
		createIntegrationContextsMock.mockReset();
		createBacklogIntegrationContextMock.mockReset();
		createBacklogIntegrationContextMock.mockResolvedValue({
			created: true,
		});
	});

	it("omits the PM block and repo fields and does NOT force skipAutoSync when both cards are untouched", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Brief Only Project");
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});

		const payload = createMutationFn.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;

		// Name is sent; no repo fields.
		expect(payload.name).toBe("Brief Only Project");
		expect(payload.repositoryUrl).toBeUndefined();
		expect(payload.repositoryOwner).toBeUndefined();
		expect(payload.repositoryName).toBeUndefined();

		// No PM block fields (undefined ⇒ omitted by the create procedure).
		expect(payload.projectManagementMcpServerId).toBeUndefined();
		expect(payload.projectManagementMcpConfigId).toBeUndefined();
		expect(payload.projectManagementContainerId).toBeUndefined();
		expect(payload.projectManagementContainerName).toBeUndefined();
		expect(payload.projectManagementAdditionalContext).toBeUndefined();

		// skipAutoSync is NOT forced on the blank-optionals path.
		expect(payload.skipAutoSync).toBeUndefined();
	});

	it("fires NO workflow-start call (no code setup, no existingSetup.start) when both cards are untouched", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Brief Only Project");
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});

		// Give onSuccess a tick to run. The brief-only path lands on the
		// post-create finish-setup step (D4, §4.6) rather than redirecting, so
		// we synchronize on `createIntegrationContexts` (always invoked first in
		// onSuccess) instead of `pushMock` (no longer called on this path).
		await waitFor(() => {
			expect(createIntegrationContextsMock).toHaveBeenCalled();
		});

		// The key invariant: no workflow-start call fires on the blank path.
		expect(startCodeSetupGithubMock).not.toHaveBeenCalled();
		expect(startCodeSetupGitlabMock).not.toHaveBeenCalled();
		expect(startExistingSetupMock).not.toHaveBeenCalled();
		// And the brief-only path does NOT redirect — it lands on finish-setup.
		expect(pushMock).not.toHaveBeenCalled();
	});

	it("blocks submit with a specific toast when a PM tool is connected without a container", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Half-configured Backlog");

		// Connect a PM tool but leave the container unset (the stub drives the
		// form-state the real Backlog card would set).
		await user.click(screen.getByTestId("connect-backlog-no-container"));

		await gotoReviewAndCreate(user);

		// Submit is blocked: no create call, and the specific validation copy
		// is surfaced via toast (never send a half-configured PM block).
		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith(
				"Please select a board to sync stories",
			);
		});
		expect(createMutationFn).not.toHaveBeenCalled();
	});
});

describe("ProjectCreationWizard — O1 post-create workflow routing (TG3)", () => {
	beforeEach(() => {
		createMutationFn.mockReset();
		startCodeSetupGithubMock.mockReset();
		startCodeSetupGitlabMock.mockReset();
		startCodeSetupAzureDevOpsMock.mockReset();
		connectRepoIntegrationMock.mockReset();
		connectRepoIntegrationMock.mockResolvedValue(undefined);
		startExistingSetupMock.mockReset();
		startExistingSetupMock.mockResolvedValue(undefined);
		pushMock.mockReset();
		toastErrorMock.mockReset();
		toastWarningMock.mockReset();
		createIntegrationContextsMock.mockReset();
		createBacklogIntegrationContextMock.mockReset();
		createBacklogIntegrationContextMock.mockResolvedValue({
			created: true,
		});
	});

	// ── Backlog-only ───────────────────────────────────────────────────────
	it("backlog connected → skipAutoSync:true on create, existingSetup.start with EMPTY repoUrls, and the D8 backlog context still fires", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Backlog Only Project");
		await user.click(screen.getByTestId("connect-backlog-complete"));
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});

		// create payload carries the PM block + skipAutoSync (workflow owns sync).
		const payload = createMutationFn.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(payload.skipAutoSync).toBe(true);
		expect(payload.projectManagementMcpServerId).toBe("srv-1");
		expect(payload.projectManagementMcpConfigId).toBe("cfg-1");
		expect(payload.projectManagementContainerId).toBe("board-7");

		// existingSetup.start fired exactly once with EMPTY repoUrls (backlog-only).
		await waitFor(() => {
			expect(startExistingSetupMock).toHaveBeenCalledTimes(1);
		});
		const startArg = startExistingSetupMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(startArg.projectId).toBe("proj_new_1");
		expect(startArg.organizationId).toBeNull();
		expect(startArg.repoUrls).toEqual([]);
		expect(startArg.projectName).toBe("Backlog Only Project");

		// D8 backlog INTEGRATION context still emitted (AC#4).
		await waitFor(() => {
			expect(createBacklogIntegrationContextMock).toHaveBeenCalledTimes(
				1,
			);
		});

		// The retired client code-setup calls never fire.
		expect(startCodeSetupGithubMock).not.toHaveBeenCalled();
		expect(startCodeSetupGitlabMock).not.toHaveBeenCalled();

		// Fire-and-forget: redirect happens.
		await waitFor(() => {
			expect(pushMock).toHaveBeenCalledWith("/app/projects/proj_new_1");
		});
	});

	// ── Repo-only: GitHub ────────────────────────────────────────────────────
	it("GitHub repo connected → skipAutoSync:true, existingSetup.start with populated repoUrls + doc-gen fields, NO startCodeSetup", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "GitHub Repo Project");
		await user.click(screen.getByTestId("connect-github-repo"));
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});
		const payload = createMutationFn.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(payload.skipAutoSync).toBe(true);

		await waitFor(() => {
			expect(startExistingSetupMock).toHaveBeenCalledTimes(1);
		});
		const startArg = startExistingSetupMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(startArg.projectId).toBe("proj_new_1");
		expect(startArg.organizationId).toBeNull();
		expect(startArg.repoUrls).toEqual(["https://github.com/acme/api"]);
		expect(startArg.projectName).toBe("GitHub Repo Project");
		// Doc-gen routing fields are present (arrays, possibly empty).
		expect(Array.isArray(startArg.selectedDocumentTypes)).toBe(true);
		expect(Array.isArray(startArg.projectTypes)).toBe(true);
		expect(startArg).toHaveProperty("documentPrompts");

		// O1: the retired client code-setup path is NOT used.
		expect(startCodeSetupGithubMock).not.toHaveBeenCalled();
		expect(startCodeSetupGitlabMock).not.toHaveBeenCalled();

		await waitFor(() => {
			expect(pushMock).toHaveBeenCalledWith("/app/projects/proj_new_1");
		});
	});

	// ── Repo-only: GitLab ────────────────────────────────────────────────────
	it("GitLab repo connected → skipAutoSync:true, existingSetup.start with the GitLab repoUrl, NO startCodeSetup", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "GitLab Repo Project");
		await user.click(screen.getByTestId("connect-gitlab-repo"));
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});
		const payload = createMutationFn.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(payload.skipAutoSync).toBe(true);

		await waitFor(() => {
			expect(startExistingSetupMock).toHaveBeenCalledTimes(1);
		});
		const startArg = startExistingSetupMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(startArg.repoUrls).toEqual(["https://gitlab.com/acme/web"]);

		expect(startCodeSetupGithubMock).not.toHaveBeenCalled();
		expect(startCodeSetupGitlabMock).not.toHaveBeenCalled();
	});

	// ── Repo-only: Azure DevOps (DRAFT-projectId path) ───────────────────────
	// The PAT picker already created the ProjectRepositoryIntegration(s) itself
	// (a DRAFT projectId existed at confirm time), so no transient PAT is held
	// in the wizard and the wizard makes NO in-wizard `connect` call — only the
	// URL flows through to existingSetup.start.
	it("ADO repo connected via DRAFT path (URL-only) → skipAutoSync:true, existingSetup.start with the ADO repoUrl, NO startCodeSetup, NO in-wizard connect", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "ADO Repo Project");
		await user.click(screen.getByTestId("connect-ado-repo"));
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});
		const payload = createMutationFn.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(payload.skipAutoSync).toBe(true);

		await waitFor(() => {
			expect(startExistingSetupMock).toHaveBeenCalledTimes(1);
		});
		const startArg = startExistingSetupMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(startArg.repoUrls).toEqual([
			"https://dev.azure.com/acme/proj/_git/repo",
		]);

		// No PAT was held → the wizard does not re-connect (the picker did).
		expect(connectRepoIntegrationMock).not.toHaveBeenCalled();
		expect(startCodeSetupGithubMock).not.toHaveBeenCalled();
		expect(startCodeSetupGitlabMock).not.toHaveBeenCalled();
		expect(startCodeSetupAzureDevOpsMock).not.toHaveBeenCalled();
	});

	// ── Repo-only: Azure DevOps (pre-create PAT path) ────────────────────────
	// No DRAFT projectId existed at confirm time, so the picker emitted the
	// selected repos + a transient PAT via `onAzureDevOpsReposChange`. The
	// wizard captures the repos in `selectedAzureDevOpsRepos`, holds the PAT in
	// a ref, and after `projects.create` creates one ProjectRepositoryIntegration
	// per repo via `connect` (PAT included) BEFORE existingSetup.start. O1: the
	// wizard never calls the retired `azureDevOps.startCodeSetup`.
	it("ADO repo connected via pre-create PAT path → connect called per repo with the PAT, THEN existingSetup.start, NO startCodeSetup", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "ADO PAT Project");
		await user.click(screen.getByTestId("connect-ado-repo-with-pat"));
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});
		const payload = createMutationFn.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(payload.skipAutoSync).toBe(true);

		// One connect per selected ADO repo, carrying the encrypted PAT + org.
		await waitFor(() => {
			expect(connectRepoIntegrationMock).toHaveBeenCalledTimes(1);
		});
		const connectArg = connectRepoIntegrationMock.mock
			.calls[0]?.[0] as Record<string, unknown>;
		expect(connectArg.provider).toBe("AZURE_DEVOPS");
		expect(connectArg.authMethod).toBe("PAT");
		expect(connectArg.pat).toBe("secret-pat-token");
		expect(connectArg.azureOrganization).toBe("acme");
		expect(connectArg.repositoryUrl).toBe(
			"https://dev.azure.com/acme/proj/_git/repo",
		);
		expect(connectArg.repositoryName).toBe("repo");

		// existingSetup.start still runs (single owner of analysis), with the
		// ADO URL the picker appended to codebaseRepoUrls.
		await waitFor(() => {
			expect(startExistingSetupMock).toHaveBeenCalledTimes(1);
		});
		const startArg = startExistingSetupMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(startArg.repoUrls).toEqual([
			"https://dev.azure.com/acme/proj/_git/repo",
		]);

		expect(startCodeSetupGithubMock).not.toHaveBeenCalled();
		expect(startCodeSetupGitlabMock).not.toHaveBeenCalled();
		expect(startCodeSetupAzureDevOpsMock).not.toHaveBeenCalled();
	});

	// ── Both repo + backlog ──────────────────────────────────────────────────
	it("repo AND backlog connected → a SINGLE existingSetup.start (Phase 1A code + Phase 1B backlog), no double-sync", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Repo And Backlog Project");
		await user.click(screen.getByTestId("connect-github-repo"));
		await user.click(screen.getByTestId("connect-backlog-complete"));
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});
		const payload = createMutationFn.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		// skipAutoSync makes existingProjectSetupWorkflow the single owner of
		// story sync — create must NOT also kick off storySyncWorkflow.
		expect(payload.skipAutoSync).toBe(true);
		expect(payload.projectManagementContainerId).toBe("board-7");

		// Exactly one start call covers both phases.
		await waitFor(() => {
			expect(startExistingSetupMock).toHaveBeenCalledTimes(1);
		});
		const startArg = startExistingSetupMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(startArg.repoUrls).toEqual(["https://github.com/acme/api"]);

		// The D8 backlog context is still emitted exactly once.
		await waitFor(() => {
			expect(createBacklogIntegrationContextMock).toHaveBeenCalledTimes(
				1,
			);
		});

		expect(startCodeSetupGithubMock).not.toHaveBeenCalled();
		expect(startCodeSetupGitlabMock).not.toHaveBeenCalled();
	});

	// ── Fire-and-forget failure ──────────────────────────────────────────────
	it("existingSetup.start rejection → warning toast and redirect STILL happens (fire-and-forget)", async () => {
		startExistingSetupMock.mockRejectedValue(
			new Error("temporal unreachable"),
		);
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Repo Start Fails Project");
		await user.click(screen.getByTestId("connect-github-repo"));
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(startExistingSetupMock).toHaveBeenCalledTimes(1);
		});

		// The fire-and-forget failure surfaces the spec §4.7 warning copy …
		await waitFor(() => {
			expect(toastWarningMock).toHaveBeenCalledWith(
				"Project created but setup could not start — retry from the project page",
			);
		});

		// … and the redirect to the project page still happens.
		await waitFor(() => {
			expect(pushMock).toHaveBeenCalledWith("/app/projects/proj_new_1");
		});
	});

	it("ADO repos connected pre-create → chip removed → PAT ref is preserved and connect is STILL called on submit for remaining repo", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "ADO Chip Removal Project");
		// 1. User selects 2 repos in the ADO PAT modal (emits repos + creds)
		await user.click(screen.getByTestId("connect-ado-two-repos-with-pat"));

		// 2. User removes 1 repo chip (emits remaining repo with NO creds argument)
		await user.click(screen.getByTestId("remove-ado-chip-no-creds"));

		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});

		// 3. Connect MUST still be called for repo2 carrying the held PAT
		await waitFor(() => {
			expect(connectRepoIntegrationMock).toHaveBeenCalledTimes(1);
		});
		const connectArg = connectRepoIntegrationMock.mock
			.calls[0]?.[0] as Record<string, unknown>;
		expect(connectArg.provider).toBe("AZURE_DEVOPS");
		expect(connectArg.authMethod).toBe("PAT");
		expect(connectArg.pat).toBe("secret-pat-token");
		expect(connectArg.repositoryName).toBe("repo2");
	});

	it("warns the user when existingSetup.start reports skipped repos", async () => {
		startExistingSetupMock.mockResolvedValueOnce({
			workflowId: "wf_123",
			status: "SCANNING",
			skippedRepos: ["GitHub: example-org/example-repo"],
		});
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Skipped Repos Project");
		await user.click(screen.getByTestId("connect-github-repo"));
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(toastWarningMock).toHaveBeenCalledWith(
				expect.stringContaining("GitHub: example-org/example-repo"),
			);
		});
		await waitFor(() => {
			expect(pushMock).toHaveBeenCalledWith("/app/projects/proj_new_1");
		});
	});
});
