/**
 * Publishing Suite project-tab wiring.
 *
 * The old client env-flag gate (`NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE`)
 * was retired into project-tab customization (card #1837): a deployment that
 * offers the tab shows it to everyone, and a project admin's `tabVisibility`
 * override (`{ overrides: { "publishing-suite": false } }`, served by the
 * mocked `projects.tabVisibility.get`) is what takes it away. Layer 0 did not
 * go away — it moved: the `PUBLISHING_SUITE` flag is now resolved per
 * organization at request time and read from the nearest
 * `FeatureFlagProvider`, mocked below off a mutable `flagState` so both
 * directions of that ceiling are exercised here. These tests pin both halves
 * as ProjectDetails wires them:
 *
 *   1. No saved config — the "Publishing Suite" tab button renders.
 *   2. Admin override hides it — the tab button is gone.
 *   3. Clicking it mounts `PublishingSuiteList` (the content branch follows
 *      visibility, not a build-time constant).
 *   4. The ceiling itself: with the organization's gate OFF, not even an
 *      admin override that force-shows the tab brings it back.
 *
 * All of ProjectDetails' other tab bodies are loaded via `next/dynamic`;
 * mocking that module out entirely (a generic stub, ignoring the loader)
 * means none of those tabs' real implementations — and their own heavy
 * dependency trees — are ever exercised here. That keeps this test scoped to
 * the one thing under test: the visibility-driven tab-bar + content branch.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the (dynamic, per-test) import of ProjectDetails.
// ----------------------------------------------------------------------------

// `next/dynamic` wraps every tab body (ProjectOverview, TestCasesList,
// PublishingSuiteList, …). Replacing it with a generic stub avoids pulling in
// any of those components' real dependency trees — only the tab bar and the
// content-branch gate (both owned by ProjectDetails itself) are under test.
// Each stub's `data-testid` is derived from the loader's own source text
// (`.then((m) => m.PublishingSuiteList)` -> "PublishingSuiteList") so a test
// can assert which specific dynamic tab mounted, not just "some dynamic tab
// mounted" — which would pass vacuously since ProjectOverview (the default
// "overview" tab) is dynamic too.
vi.mock("next/dynamic", () => ({
	default: (loader: () => Promise<unknown>) => {
		const match = loader
			.toString()
			.match(/\(\s*\w+\s*\)\s*=>\s*\w+\.(\w+)/);
		const name = match?.[1] ?? "Unknown";
		function DynamicTabStub() {
			return <div data-testid={`dynamic-tab-stub-${name}`} />;
		}
		DynamicTabStub.displayName = `DynamicTabStub(${name})`;
		return DynamicTabStub;
	},
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "test-user-id", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

// This suite is about tabs. The role prompt decides for itself whether to
// open and is covered by its own tests; stubbing it here is smaller than
// wrapping these renders in a FeatureFlagProvider, which would also make the
// tests depend on flag state they do not care about.
vi.mock("@saas/get-started/components/ProjectRoleConfirmationPrompt", () => ({
	ProjectRoleConfirmationPrompt: () => null,
}));

// Publishing Suite's Layer 0 ceiling is now resolved at runtime from the
// nearest FeatureFlagProvider, which the organization layout mounts. Mutable
// (same shape as `tabConfigState` below) so one case can drive the OFF
// direction — otherwise every rendered case pins the gate on, and a component
// that hardcoded `{ publishingSuiteEnabled: true }` instead of calling
// `useProjectTabGates()` would still pass. Keyed on the flag name rather than
// a blanket `() => true`: this component reads other flags too, and switching
// all of them on would exercise branches this file does not describe.
const { flagState } = vi.hoisted(() => ({
	flagState: { publishingSuiteEnabled: true },
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "PUBLISHING_SUITE" ? flagState.publishingSuiteEnabled : false,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		organizationName: null,
		basePath: "/app",
		isOrgContext: false,
		isPersonalContext: true,
		isOrganizationAdmin: false,
		userRole: null,
		loaded: true,
		organization: null,
	}),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: () => <nav data-testid="breadcrumbs-stub" />,
}));

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useRegisterFabricAgentContext: vi.fn(),
}));

// ProjectDetails.tsx imports "../hooks" (it lives in components/); this test
// file is nested one level deeper (components/__tests__/), so the equivalent
// specifier that resolves to the same module is "../../hooks".
vi.mock("../../hooks", () => ({
	useProjectPresence: vi.fn(),
}));

vi.mock("../ProjectHeader", () => ({
	ProjectHeader: () => <div data-testid="project-header-stub" />,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			github: { setupStatus: vi.fn() },
			restore: vi.fn(),
			permanentDelete: vi.fn(),
			// #1694 — fired once from ProjectDetails when a project resolves.
			recordVisit: vi.fn().mockResolvedValue({ recorded: true }),
		},
	},
}));

/** Minimal fields ProjectDetails itself reads off `data.project`. */
const TEST_PROJECT = {
	id: "proj-1",
	name: "Test Project",
	userRole: "owner",
	canEditSettings: true,
	canPublish: true,
	deletedAt: null,
	codeAnalysisStatus: "COMPLETED",
	repositoryUrl: null,
	repositoryOwner: null,
	repositoryName: null,
	scheduledPermanentDeleteAt: null,
};

// Mutable per-test state the mocked tab-visibility query reads back.
const { tabConfigState } = vi.hoisted(() => ({
	tabConfigState: { config: null as unknown },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.get", input],
					queryFn: async () => ({ project: TEST_PROJECT }),
				}),
			},
			testCases: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.testCases.list", input],
						queryFn: async () => ({ items: [], total: 0 }),
					}),
				},
			},
			tabVisibility: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabVisibility.get", input],
						queryFn: async () => ({
							config: tabConfigState.config,
						}),
					}),
				},
			},
			tabPreferences: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabPreferences.get", input],
						queryFn: async () => ({ prefs: null }),
					}),
				},
			},
			publishingSuite: {
				listTopics: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: [
							"projects.publishingSuite.listTopics",
							input,
						],
						queryFn: async () => ({ items: [] }),
					}),
				},
				latestCycle: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: [
							"projects.publishingSuite.latestCycle",
							input,
						],
						queryFn: async () => ({ cycle: null }),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

// ----------------------------------------------------------------------------
// Render helpers
// ----------------------------------------------------------------------------

function renderWithClient(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

beforeEach(() => {
	tabConfigState.config = null;
	// Default: an enrolled organization, which is what cases 1-3 assume.
	flagState.publishingSuiteEnabled = true;
	window.sessionStorage.clear();
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("ProjectDetails — Publishing Suite tab (visibility-driven)", () => {
	it("shows the Publishing Suite tab button when no config hides it", async () => {
		const { ProjectDetails } = await import("../ProjectDetails");

		renderWithClient(<ProjectDetails projectId="proj-1" />);

		expect(
			await screen.findByRole("button", { name: /publishing suite/i }),
		).toBeInTheDocument();
	});

	it("hides the Publishing Suite tab button when an admin override turns it off", async () => {
		tabConfigState.config = { overrides: { "publishing-suite": false } };
		const { ProjectDetails } = await import("../ProjectDetails");

		renderWithClient(<ProjectDetails projectId="proj-1" />);

		// Wait for the tab bar to actually render (Overview always exists)
		// before asserting the hidden tab's absence — otherwise a "hidden"
		// tab could just mean the component hasn't finished loading yet.
		await screen.findByRole("button", { name: /^overview$/i });

		expect(
			screen.queryByRole("button", { name: /publishing suite/i }),
		).toBeNull();
	});

	it("clicking the visible tab mounts PublishingSuiteList (content branch follows visibility)", async () => {
		const { ProjectDetails } = await import("../ProjectDetails");
		const user = userEvent.setup();

		renderWithClient(<ProjectDetails projectId="proj-1" />);

		const tabButton = await screen.findByRole("button", {
			name: /publishing suite/i,
		});
		await user.click(tabButton);

		// Specifically the PublishingSuiteList-loader stub, not just any
		// dynamic tab (ProjectOverview, the default "overview" tab, is also
		// dynamic and would otherwise make this assertion pass vacuously).
		expect(
			await screen.findByTestId("dynamic-tab-stub-PublishingSuiteList"),
		).toBeInTheDocument();
	});

	it("keeps the tab hidden when the organization's gate is off, admin override notwithstanding", async () => {
		// The OFF direction of the Layer 0 ceiling. Since #1837's follow-up an
		// offered tab renders by default, which makes this a real control: with
		// the gate ON this exact config renders the tab (the first case in this
		// file). The admin override is left explicitly true to make the
		// strongest version of the claim — not even a deliberate force-show
		// survives Layer 0. What it pins is that ProjectDetails asks
		// `useProjectTabGates()` rather than assuming an answer; the failure it
		// guards is a tab appearing for an organization never enrolled.
		flagState.publishingSuiteEnabled = false;
		tabConfigState.config = { overrides: { "publishing-suite": true } };
		const { ProjectDetails } = await import("../ProjectDetails");

		renderWithClient(<ProjectDetails projectId="proj-1" />);

		// Wait for the tab bar before asserting the absence, so "hidden" cannot
		// just mean "not rendered yet" (same guard as case 1).
		await screen.findByRole("button", { name: /^overview$/i });

		expect(
			screen.queryByRole("button", { name: /publishing suite/i }),
		).toBeNull();
	});
});
