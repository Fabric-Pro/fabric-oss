/**
 * Component tests for the unified wizard's Backlog + Code Repository SECTIONS
 * mounted inside `BasicInfoStep` (unified-project-setup spec §3 AC#1/AC#2,
 * §4.3, §4.4).
 *
 * After the 2026-05-27 follow-up these are PLAIN SECTIONS (not accordions) —
 * like the rest of the Brief step:
 *   (a) The Backlog section shows the PM config (PMToolSelect) inline — no
 *       expand step, no disclosure trigger;
 *   (b) The Code Repository section exposes ALL THREE provider cards —
 *       GitHub, GitLab, Azure DevOps (AC#2) — each with an "Add" action;
 *   (c) There is no free-text repository-URL field.
 *
 * Heavy children (pickers, PMToolSelect, ContextUploaderDialog) are mocked at
 * the module boundary so the test focuses on the section wiring.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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
});

// ── Module mocks ─────────────────────────────────────────────────────────
const { checkNameMock } = vi.hoisted(() => ({ checkNameMock: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			checkName: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.checkName", input] as const,
					queryFn: () => checkNameMock(input),
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
				mutationOptions: () => ({ mutationFn: vi.fn() }),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationName: null,
		basePath: "/app",
	}),
	useContextPath: () => "/app/settings/mcp",
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (href: string) => href,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Inert stubs for the dialog + pending list (covered by their own tests).
vi.mock("../../ContextUploaderDialog", () => ({
	ContextUploaderDialog: () => null,
}));
vi.mock("../ContextPendingItemsList", () => ({
	ContextPendingItemsList: () => null,
}));

// PMToolSelect → tagged stub so we can assert it appears once the Backlog card
// is expanded. `WizardBacklogCard` (at components/wizard/) imports it from
// `../pm-tool-select` (= components/pm-tool-select); from this test file that
// module is `../../pm-tool-select`.
vi.mock("../../pm-tool-select", () => ({
	PMToolSelect: () => <div data-testid="pm-tool-select-stub" />,
}));

// The three repo pickers → tagged stubs. They render nothing unless `open`,
// but their mount (as children of the expanded Repository card) is what AC#2
// asserts. We expose a marker per provider regardless of `open`.
vi.mock("../GitHubRepoPicker", () => ({
	GitHubRepoPicker: () => <div data-testid="github-repo-picker-mounted" />,
}));
vi.mock("../GitLabProjectPicker", () => ({
	GitLabProjectPicker: () => (
		<div data-testid="gitlab-project-picker-mounted" />
	),
}));
vi.mock("../AzureDevOpsPatRepoPicker", () => ({
	AzureDevOpsPatRepoPicker: () => (
		<div data-testid="ado-repo-picker-mounted" />
	),
}));

import { BasicInfoStep } from "../BasicInfoStep";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const baseFormData = {
	name: "My Project",
	description: "",
	projectTypes: [] as string[],
	icon: "",
	color: "",
	tags: [] as string[],
	techStack: [] as string[],
	features: [] as string[],
	customRequirements: "",
	documents: [] as string[],
	previousDescription: null as string | null,
	tempContextIds: [] as string[],
	selectedTeamsChats: [] as unknown[],
	selectedNotionPages: [] as unknown[],
	selectedGitHubRepos: [] as unknown[],
	selectedGitLabRepos: [] as unknown[],
	selectedAzureDevOpsRepos: [] as unknown[],
	selectedSlackChannels: [] as unknown[],
	codebaseRepoUrls: [] as string[],
	primaryWebsiteUrl: "",
	additionalWebsiteUrls: [] as string[],
	projectManagementMcpConfigId: null as string | null,
	projectManagementMcpServerId: null as string | null,
	projectManagementContainerId: null as string | null,
	projectManagementContainerName: null as string | null,
	projectManagementAdditionalContext: null as Record<string, unknown> | null,
	projectManagementDetectedType: null as string | null,
	documentPrompts: {} as Record<string, unknown>,
};

function renderStep() {
	return wrap(
		<BasicInfoStep
			// biome-ignore lint/suspicious/noExplicitAny: test-time form shape mirrors prod
			formData={{ ...baseFormData } as any}
			updateFormData={vi.fn()}
			wizardSessionId="wiz_test_1"
			organizationId={undefined}
			projectId="proj_draft_1"
			onAzureDevOpsReposChange={vi.fn()}
		/>,
	);
}

describe("BasicInfoStep — Backlog + Code Repository sections (TG1)", () => {
	beforeEach(() => {
		checkNameMock.mockReset();
		checkNameMock.mockResolvedValue({ available: true });
	});

	// ── Both are plain sections (no accordion / disclosure trigger) ─────────
	it("renders both as plain sections — no disclosure triggers", () => {
		renderStep();

		expect(screen.getByTestId("backlog-card")).toBeInTheDocument();
		expect(screen.getByTestId("repository-section")).toBeInTheDocument();
		expect(
			screen.queryByTestId("backlog-card-trigger"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("repository-card-trigger"),
		).not.toBeInTheDocument();
	});

	// ── (a) Backlog shows the PM config inline (no expand) ──────────────────
	it("shows the Backlog PMToolSelect config inline", () => {
		renderStep();
		expect(screen.getByTestId("pm-tool-select-stub")).toBeInTheDocument();
	});

	// ── (b) Code Repository exposes GitHub + GitLab + Azure DevOps (AC#2) ────
	it("exposes GitHub, GitLab, AND Azure DevOps provider cards inline", () => {
		renderStep();

		const repoSection = screen.getByTestId("repository-section");

		// All three provider pickers are mounted inline (no expand needed).
		expect(
			within(repoSection).getByTestId("github-repo-picker-mounted"),
		).toBeInTheDocument();
		expect(
			within(repoSection).getByTestId("gitlab-project-picker-mounted"),
		).toBeInTheDocument();
		expect(
			within(repoSection).getByTestId("ado-repo-picker-mounted"),
		).toBeInTheDocument();

		// Each provider card is labelled and offers an "Add" action.
		expect(within(repoSection).getByText("GitHub")).toBeInTheDocument();
		expect(within(repoSection).getByText("GitLab")).toBeInTheDocument();
		expect(
			within(repoSection).getByText("Azure DevOps"),
		).toBeInTheDocument();
		expect(
			within(repoSection).getAllByRole("button", { name: /add/i }).length,
		).toBeGreaterThanOrEqual(3);
	});

	// ── (c) No free-text repository-URL field (removed in the follow-up) ────
	it("does not render a free-text repository URL input", () => {
		renderStep();
		const repoSection = screen.getByTestId("repository-section");
		expect(
			within(repoSection).queryByPlaceholderText(
				/github\.com\/org\/repo/i,
			),
		).not.toBeInTheDocument();
	});
});
