/**
 * Seam test: proves the dedicated AttachmentsTab is actually reachable from the
 * LIVE full-page editor (StoryWorkspacePage), not just that the button component
 * exists. Mounts the real page with the maturation-routing mock harness plus the
 * orpc-client.listAttachments spy.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const { listAttachments } = vi.hoisted(() => ({
	listAttachments: vi.fn(),
}));

// The attachment list call lives in AttachmentsTab via orpcClient.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments } } },
}));

vi.mock("../../../hooks/useFeatureMaturationV2Enabled", () => ({
	useFeatureMaturationV2Enabled: () => false,
}));
vi.mock("../StoryWorkspace", () => ({
	StoryWorkspace: () => <div data-testid="workspace">workspace</div>,
}));
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@saas/agents/components/AgentErrorBoundary", () => ({
	AgentErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../pm-sync/PmSyncChip", () => ({ PmSyncChip: () => null }));
vi.mock("../StartWorkButton", () => ({ StartWorkButton: () => null }));
vi.mock("../StoryDownloadDropdown", () => ({
	StoryDownloadDropdown: () => null,
}));
vi.mock("../NeedsMoreInfoBadge", () => ({ NeedsMoreInfoBadge: () => null }));
vi.mock("../StoryKindIcon", () => ({ StoryKindIcon: () => null }));
vi.mock("../StoryDetailsButton", () => ({ StoryDetailsButton: () => null }));
vi.mock("../StoryCommentsButton", () => ({ StoryCommentsButton: () => null }));
// Ambient org context is DELIBERATELY DISTINCT from the project's tenant
// (null here, project is "org-1"). This is what makes the org-id assertion
// meaningful: a buggy impl that passes the ambient `organizationId ?? null`
// would send `null`, failing the `organizationId: "org-1"` assertion. Only an
// impl that reads `project.organizationId` passes. Models the transient-null
// org-route failure mode from the spec's tenant-context caveat.
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app/acme",
	}),
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ setIsFullscreen: vi.fn() }),
}));
vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("../../../lib/stories/types", async (importActual) => {
	const actual = await importActual<Record<string, unknown>>();
	return {
		...actual,
		transformStory: (s: { id: string }) => ({
			id: s.id,
			title: "Wiring test feature",
			kind: "STORY",
			priority: "MEDIUM",
			identifier: "F-1",
		}),
		getPriorityLabel: () => "Medium",
	};
});

// Project carries organizationId so the org-id assertion is meaningful.
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
				get: stub({
					project: {
						id: "p1",
						name: "Proj",
						organizationId: "org-1",
					},
				}),
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
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
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
	listAttachments.mockReset().mockResolvedValue({ attachments: [] });
});
afterEach(() => vi.clearAllMocks());

describe("StoryWorkspacePage — dedicated attachments wiring", () => {
	it("shows the Attachments button and eagerly fetches the count for the badge (#1778)", async () => {
		renderPage();
		expect(
			await screen.findByRole("button", { name: "Attachments" }),
		).toBeInTheDocument();
		// StoryAttachmentsButton eagerly fetches on mount to drive its count
		// badge (#1778) — it no longer waits for the sheet to open.
		await waitFor(() => expect(listAttachments).toHaveBeenCalled());
	});

	it("opens the panel and fetches with the project's org id (not ambient) on click", async () => {
		renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Attachments" }),
		);
		// Panel opened (title rendered).
		expect(
			await screen.findByText("Attachments — F-1"),
		).toBeInTheDocument();
		// Wait on the settled spy. The org id must be the project's "org-1",
		// NOT the ambient null — proving the wire reads project.organizationId.
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				projectId: "p1",
				userStoryId: "s1",
				organizationId: "org-1",
			}),
		);
		expect(listAttachments).toHaveBeenCalledTimes(1);
	});
});
