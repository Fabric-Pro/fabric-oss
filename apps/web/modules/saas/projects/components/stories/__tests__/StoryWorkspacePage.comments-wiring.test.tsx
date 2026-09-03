/**
 * Seam test: proves StoryCommentsButton is reachable from the LIVE full-page
 * editor (StoryWorkspacePage) and that the page passes the PROJECT's org id (not
 * ambient) down to CommentsPanel. CommentsPanel is stubbed — page wiring + org id
 * are the subject.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
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

// The now-always-rendered StoryAttachmentsButton eagerly queries the
// attachment list on mount (#1778) — stub it so this file stays focused on
// comments wiring (mirrors StoryWorkspacePage.attachments-wiring.test.tsx).
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments } } },
}));
vi.mock("../StoryDetailsButton", () => ({ StoryDetailsButton: () => null }));
vi.mock("../CommentsPanel", () => ({
	CommentsPanel: (props: {
		storyId: string;
		taskId?: string;
		organizationId?: string | null;
	}) => (
		<div
			data-testid="comments-panel"
			data-story={props.storyId}
			data-task={String(props.taskId)}
			data-org={String(props.organizationId)}
		/>
	),
}));
vi.mock("../../../hooks/useFeatureMaturationV2Enabled", () => ({
	useFeatureMaturationV2Enabled: () => false,
}));
vi.mock("../StoryWorkspace", () => ({
	StoryWorkspace: () => <div data-testid="workspace">workspace</div>,
}));
// `<CopilotChatSessionProvider>` (mounted by the page inside `<CopilotKit>`)
// calls `useCopilotChatInternal()` once for the whole surface, so the mock has
// to expose it. The session object is built inside the factory and returned by
// reference — a fresh literal per call would hand every consumer a new value on
// every render.
vi.mock("@copilotkit/react-core", () => {
	const session = {
		messages: [],
		visibleMessages: [],
		isLoading: false,
		appendMessage: async () => {},
		setMessages: () => {},
		interrupt: null,
		agent: undefined,
	};
	return {
		CopilotKit: ({ children }: { children: ReactNode }) => children,
		useCopilotChatInternal: () => session,
	};
});
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
// Ambient org DELIBERATELY null while the project's org is "org-1".
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
			createdById: "u1",
		}),
		getPriorityLabel: () => "Medium",
	};
});

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
				members: { list: stub({ members: [] }) },
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
					// StoryCommentsButton eagerly queries comments to drive its
					// active-state (#1778) — must be stubbed or the real button
					// throws on render.
					comments: { list: stub({ comments: [] }) },
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
	for (const m of [
		"hasPointerCapture",
		"setPointerCapture",
		"releasePointerCapture",
		"scrollIntoView",
	] as const) {
		if (!(m in Element.prototype)) {
			// @ts-expect-error augment jsdom Element
			Element.prototype[m] = () => false;
		}
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

describe("StoryWorkspacePage — comments wiring", () => {
	it("shows the Comments button and does not mount CommentsPanel until opened", async () => {
		renderPage();
		expect(
			await screen.findByRole("button", { name: "Comments" }),
		).toBeInTheDocument();
		expect(screen.queryByTestId("comments-panel")).not.toBeInTheDocument();
	});

	it("opens the sheet and forwards the project's org id (not ambient) in story scope", async () => {
		renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Comments" }),
		);
		const panel = await screen.findByTestId("comments-panel");
		expect(panel).toHaveAttribute("data-story", "s1");
		expect(panel).toHaveAttribute("data-org", "org-1");
		expect(panel).toHaveAttribute("data-task", "undefined");
	});
});
