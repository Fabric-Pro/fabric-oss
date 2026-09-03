import { FocusModeToggle } from "@saas/shared/components/FocusModeToggle";
import { FocusModeProvider } from "@saas/shared/contexts/FocusModeContext";
import { SidebarCollapseProvider } from "@saas/shared/contexts/SidebarCollapseContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren, ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments: vi.fn() } } },
}));
vi.mock("../editor/ProvenanceSection", () => ({
	ProvenanceSection: () => <div data-testid="provenance">prov</div>,
}));
vi.mock("../../../hooks/useFeatureMaturationV2Enabled", () => ({
	useFeatureMaturationV2Enabled: () => false,
}));
vi.mock("../StoryWorkspace", () => ({
	StoryWorkspace: () => (
		<div data-testid="workspace">
			<FocusModeToggle />
		</div>
	),
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
vi.mock("../StoryCommentsButton", () => ({ StoryCommentsButton: () => null }));
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
	usePathname: () => "/app/acme/projects/p1/stories/s1",
}));

vi.mock("../../../lib/stories/types", async (importActual) => {
	const actual = await importActual<Record<string, unknown>>();
	return {
		...actual,
		transformStory: (s: { id: string }) => ({
			id: s.id,
			title: "Focus mode test feature",
			kind: "STORY",
			priority: "MEDIUM",
			identifier: "F-100",
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
						name: "Foundry Test Bench",
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
					statuses: { list: stub({ statuses: [] }) },
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

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const dict: Record<string, string> = {
			enterFocusMode: "Focus Mode",
			enterFocusModeHint: "Hide surrounding headers (F)",
			exitFocusMode: "Exit Focus Mode",
			exitFocusModeHint: "Restore standard header (F)",
		};
		return dict[key] ?? key;
	},
}));

import { StoryWorkspacePage } from "../StoryWorkspacePage";

describe("StoryWorkspacePage Focus Mode Integration", () => {
	let queryClient: QueryClient;

	beforeAll(() => {
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	});

	function Wrapper({ children }: PropsWithChildren) {
		return (
			<QueryClientProvider client={queryClient}>
				<SidebarCollapseProvider>
					<FocusModeProvider>{children}</FocusModeProvider>
				</SidebarCollapseProvider>
			</QueryClientProvider>
		);
	}

	it("hides header chrome when Focus Mode is activated and restores it on exit", async () => {
		const user = userEvent.setup();
		render(
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>,
			{ wrapper: Wrapper },
		);

		// Initially, the breadcrumb trail is visible in the header
		expect(
			await screen.findByText("Foundry Test Bench"),
		).toBeInTheDocument();

		// Focus Mode toggle is available in workspace
		const focusToggle = screen.getByRole("button", { name: "Focus Mode" });
		expect(focusToggle).toBeInTheDocument();

		// Activate Focus Mode
		await user.click(focusToggle);

		// Header breadcrumb "Foundry Test Bench" should be hidden
		expect(
			screen.queryByText("Foundry Test Bench"),
		).not.toBeInTheDocument();

		// Exit Focus Mode
		const exitToggle = screen.getByRole("button", {
			name: "Exit Focus Mode",
		});
		await user.click(exitToggle);

		// Header breadcrumb restores
		expect(
			await screen.findByText("Foundry Test Bench"),
		).toBeInTheDocument();
	});
});
