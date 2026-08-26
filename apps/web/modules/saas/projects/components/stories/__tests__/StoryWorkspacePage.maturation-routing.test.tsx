/**
 * Feature Maturation V2 flag/toggle routing on `StoryWorkspacePage` (TG5).
 *
 * Behavior from the user's perspective:
 *   - `StoryWorkspace` is ALWAYS rendered (both modes) so the maturation stage
 *     dropdown, Enhance, Start work, etc. stay intact.
 *   - Non-flagged org → `maturationV2={false}`; NO editor-version toggle.
 *   - Flagged org → `maturationV2={true}` (defaults to v2); NO editor-version
 *     toggle (Classic Editor retired).
 *
 * Boundary: this test covers ONLY the page-level routing contract (flag → prop).
 * It mounts the REAL page and stubs `StoryWorkspace` as a sentinel that echoes
 * its `maturationV2` prop. The three-tab behaviour that now lives inside
 * `StoryWorkspace` (tab switching, the answer flow, seeding) is NOT exercised
 * here; the presentational panels have their own unit tests
 * (`maturation/__tests__/{SummaryQuestionsPanel,DecisionLogPanel}.test.tsx`).
 * Stub CopilotKit, the action-bar leaves, and the chrome hooks. next-intl is
 * globally key-mocked in vitest.setup.ts.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// --- Flag hook: drive per test ------------------------------------------
const { mockUseFeatureMaturationV2Enabled } = vi.hoisted(() => ({
	mockUseFeatureMaturationV2Enabled: vi.fn(),
}));
vi.mock("../../../hooks/useFeatureMaturationV2Enabled", () => ({
	useFeatureMaturationV2Enabled: () => mockUseFeatureMaturationV2Enabled(),
}));

// --- StoryWorkspace → sentinel that echoes the maturationV2 prop ---------
vi.mock("../StoryWorkspace", () => ({
	StoryWorkspace: ({ maturationV2 }: { maturationV2?: boolean }) => (
		<div
			data-testid="workspace"
			data-maturation-v2={String(!!maturationV2)}
		>
			workspace
		</div>
	),
}));

// --- CopilotKit (the page wraps both modes in it) -----------------------
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));

// --- AgentErrorBoundary → pass-through ----------------------------------
vi.mock("@saas/agents/components/AgentErrorBoundary", () => ({
	AgentErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

// --- Action-bar leaves → null sentinels ---------------------------------
vi.mock("../pm-sync/PmSyncChip", () => ({ PmSyncChip: () => null }));
vi.mock("../StartWorkButton", () => ({ StartWorkButton: () => null }));
vi.mock("../StoryDownloadDropdown", () => ({
	StoryDownloadDropdown: () => null,
}));
vi.mock("../NeedsMoreInfoBadge", () => ({ NeedsMoreInfoBadge: () => null }));
vi.mock("../StoryKindIcon", () => ({ StoryKindIcon: () => null }));
vi.mock("../StoryDetailsButton", () => ({ StoryDetailsButton: () => null }));
vi.mock("../StoryCommentsButton", () => ({ StoryCommentsButton: () => null }));

// --- Chrome / context ----------------------------------------------------
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ setIsFullscreen: vi.fn() }),
}));
vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

// --- transformStory → minimal renderable story --------------------------
vi.mock("../../../lib/stories/types", async (importActual) => {
	const actual = await importActual<Record<string, unknown>>();
	return {
		...actual,
		transformStory: (s: { id: string }) => ({
			id: s.id,
			title: "Routing test feature",
			kind: "STORY",
			priority: "MEDIUM",
			identifier: "F-1",
		}),
		getPriorityLabel: () => "Medium",
	};
});

// --- orpc query surface: page queries only (tabs are inside StoryWorkspace
//     which is stubbed, so no maturation mutation surface is needed here) --
vi.mock("@shared/lib/orpc-query-utils", () => {
	const stub = (data: unknown) => ({
		queryOptions: (opts: { input: unknown }) => ({
			queryKey: ["stub", opts.input],
			queryFn: async () => data,
		}),
	});
	return {
		orpc: {
			projects: {
				get: stub({ project: { id: "p1", name: "Proj" } }),
				stories: {
					get: stub({
						story: { id: "s1" },
						canEdit: true,
						canAddTags: true,
						canManageAllTags: true,
					}),
					pmCapabilities: stub({ configured: false }),
					// useAiReassessEligibility (metadata-form sparkle) reads
					// the status list at render; empty = nothing is final.
					statuses: { list: stub({ statuses: [] }) },
					// New: the detail header's editable priority chip
					// (StoryPriorityControl) reads this at render.
					priorityHistory: stub({
						items: [],
						nextCursor: null,
						initialPriority: null,
						totalCount: 0,
					}),
				},
			},
		},
	};
});

import { StoryWorkspacePage } from "../StoryWorkspacePage";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
});

function renderPage() {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
			},
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	mockUseFeatureMaturationV2Enabled.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("StoryWorkspacePage — Feature Maturation V2 routing", () => {
	it("renders StoryWorkspace with maturationV2=false (no toggle) for a non-flagged org", async () => {
		mockUseFeatureMaturationV2Enabled.mockReturnValue(false);
		renderPage();

		const ws = await screen.findByTestId("workspace");
		expect(ws).toHaveAttribute("data-maturation-v2", "false");
		// The editor-version toggle is gated on the flag — absent for v1-only orgs.
		expect(
			screen.queryByRole("group", { name: "label" }),
		).not.toBeInTheDocument();
	});

	it("renders StoryWorkspace with maturationV2=true and NO toggle for a flagged org (Classic Editor retired)", async () => {
		mockUseFeatureMaturationV2Enabled.mockReturnValue(true);
		renderPage();

		const ws = await screen.findByTestId("workspace");
		expect(ws).toHaveAttribute("data-maturation-v2", "true");
		expect(
			screen.queryByRole("group", { name: "label" }),
		).not.toBeInTheDocument();
	});
});
