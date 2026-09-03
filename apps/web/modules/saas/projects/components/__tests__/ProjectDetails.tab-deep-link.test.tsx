/**
 * `?tab=` deep-link WIRING regression test (Fizzy #2138).
 *
 * `use-project-tab-deep-link.test.tsx` covers the hook in isolation. This file
 * covers the thing the bug actually lived in: how `ProjectDetails` consumes it.
 * The defect was an effect keyed on `[searchParams]` that re-applied `?tab=`
 * on ANY query write, so restoring that effect must turn this file red — the
 * hook's own suite would stay green, since the hook file would be untouched.
 *
 * The mocked router REWRITES the search string on `replace`, so the strip is
 * real rather than assumed, and the roadmap search step copies whatever is in
 * the URL before adding `q` — exactly what nuqs does when it preserves params
 * it does not own. Those two together are what make the regression reachable:
 * without the strip, `tab=documents` is still there for the search write to
 * carry back in.
 *
 * Tab bodies are `next/dynamic`, stubbed to a testid derived from the loader
 * source (same technique as `ProjectDetails.publishing-suite-tab.test.tsx`),
 * so "which tab is on screen" is asserted by which body mounted. The tab
 * buttons themselves carry no aria-selected — only styling — so the body is
 * the honest signal.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// This suite is about tabs. The role prompt decides for itself whether to
// open and is covered by its own tests; stubbing it here is smaller than
// wrapping these renders in a FeatureFlagProvider, which would also make the
// tests depend on flag state they do not care about.
vi.mock("@saas/get-started/components/ProjectRoleConfirmationPrompt", () => ({
	ProjectRoleConfirmationPrompt: () => null,
}));

// ----------------------------------------------------------------------------
// next/navigation — overrides the global stub in vitest.setup.ts, which hands
// back a FRESH router object per call and an always-empty search.
// ----------------------------------------------------------------------------

const { nav } = vi.hoisted(() => {
	const state = { search: "" };
	// Writing the query back means the component's own strip is what clears
	// the param — the test never fakes it.
	const replace = vi.fn((url: string) => {
		const q = url.indexOf("?");
		state.search = q === -1 ? "" : url.slice(q + 1);
	});
	return {
		nav: {
			state,
			replace,
			// Stable reference: the hook's effect lists `router` as a
			// dependency, so a fresh object per render would re-run it every
			// render.
			router: {
				replace,
				push: vi.fn(),
				prefetch: vi.fn(),
				back: vi.fn(),
			},
		},
	};
});

vi.mock("next/navigation", () => ({
	useRouter: () => nav.router,
	usePathname: () => "/app/projects/proj-1",
	useSearchParams: () => new URLSearchParams(nav.state.search),
}));

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

// The tab bar's Layer 0 ceiling reads `PUBLISHING_SUITE` from the nearest
// FeatureFlagProvider, and these renders wrap only `QueryClientProvider`
// (see the comment on `renderWithClient`) — without this the real hook throws.
// Keyed on the flag name rather than a blanket `() => true`: this tree reads
// other flags too, and switching all of them on would exercise branches this
// file does not describe.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => key === "PUBLISHING_SUITE",
}));

vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: () => <nav data-testid="breadcrumbs-stub" />,
}));

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useRegisterFabricAgentContext: vi.fn(),
}));

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
			recordVisit: vi.fn().mockResolvedValue({ recorded: true }),
		},
	},
}));

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
			// Tab customization (card #1837): nothing configured in these tests.
			tabVisibility: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabVisibility.get", input],
						queryFn: async () => ({ config: null }),
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
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProjectDetails } from "../ProjectDetails";

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

function renderWithClient(ui: ReactNode, client: QueryClient = makeClient()) {
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

/** What an in-page query writer (nuqs, the Testing view) does: keep every
 *  param it does not own, then add its own. */
function writeSearchPreservingExisting(key: string, value: string) {
	const params = new URLSearchParams(nav.state.search);
	params.set(key, value);
	nav.state.search = params.toString();
}

beforeEach(() => {
	nav.state.search = "";
	nav.replace.mockClear();
	nav.router.push.mockClear();
	window.sessionStorage.clear();
});

describe("ProjectDetails — ?tab= deep link wiring", () => {
	it("lands on the deep-linked tab and strips the param from the URL", async () => {
		nav.state.search = "tab=documents";

		renderWithClient(<ProjectDetails projectId="proj-1" />);

		expect(
			await screen.findByTestId("dynamic-tab-stub-DocumentsList"),
		).toBeInTheDocument();
		expect(nav.state.search).toBe("");
	});

	it("keeps params it does not own when stripping", async () => {
		nav.state.search = "tab=documents&storyId=story-1";

		renderWithClient(<ProjectDetails projectId="proj-1" />);

		await screen.findByTestId("dynamic-tab-stub-DocumentsList");
		expect(nav.state.search).toBe("storyId=story-1");
	});

	it("does not yank the user back to a consumed tab when the roadmap search writes ?q=", async () => {
		// The reported bug: arrive from the document editor's back arrow,
		// switch to the Roadmap, type one character in its search box.
		const user = userEvent.setup();
		nav.state.search = "tab=documents";

		const client = makeClient();
		const { rerender } = renderWithClient(
			<ProjectDetails projectId="proj-1" />,
			client,
		);
		await screen.findByTestId("dynamic-tab-stub-DocumentsList");

		await user.click(
			await screen.findByRole("button", { name: /roadmap/i }),
		);
		expect(
			await screen.findByTestId("dynamic-tab-stub-StoriesRoadmap"),
		).toBeInTheDocument();

		// The debounced search commit. Without the strip above, this carries
		// `tab=documents` back into the URL and the old effect re-applied it.
		writeSearchPreservingExisting("q", "F-123");
		rerender(
			<QueryClientProvider client={client}>
				<ProjectDetails projectId="proj-1" />
			</QueryClientProvider>,
		);

		expect(
			await screen.findByTestId("dynamic-tab-stub-StoriesRoadmap"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("dynamic-tab-stub-DocumentsList"),
		).toBeNull();
	});

	it("leaves an unrecognized tab value in the URL and switches nothing", async () => {
		nav.state.search = "tab=bogus";

		renderWithClient(<ProjectDetails projectId="proj-1" />);

		expect(
			await screen.findByTestId("dynamic-tab-stub-ProjectOverview"),
		).toBeInTheDocument();
		expect(nav.state.search).toBe("tab=bogus");
		expect(nav.replace).not.toHaveBeenCalled();
	});
});
