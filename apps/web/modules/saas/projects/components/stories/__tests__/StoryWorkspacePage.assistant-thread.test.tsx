/**
 * The feature assistant's `<CopilotKit>` runs on the persisted conversation's
 * id (`assistant-thread.tsx`): the page's conversation id is the thread id,
 * the workspace below sees the same thread, a re-render keeps it, and only
 * "New conversation" moves it. Mounts the real page with the attachments
 * wiring test's harness.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { copilotKitProps } = vi.hoisted(() => ({
	copilotKitProps: [] as Array<{ threadId?: string; agent?: string }>,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				listAttachments: async () => ({ attachments: [] }),
			},
		},
	},
}));
vi.mock("../../../hooks/useFeatureMaturationV2Enabled", () => ({
	useFeatureMaturationV2Enabled: () => false,
}));
// The workspace below the provider: shows the thread it sees and offers the
// "New conversation" action the real workspace wires to `startNewThread`.
vi.mock("../StoryWorkspace", async () => {
	const { useAssistantThread } = await import(
		"@saas/shared/components/copilot/assistant-thread"
	);
	return {
		StoryWorkspace: () => {
			const thread = useAssistantThread();
			return (
				<button type="button" onClick={() => thread?.startNewThread()}>
					{`thread:${thread?.threadId ?? "none"}`}
				</button>
			);
		},
	};
});
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
		CopilotKit: ({
			children,
			threadId,
			agent,
		}: {
			children: ReactNode;
			threadId?: string;
			agent?: string;
		}) => {
			copilotKitProps.push({ threadId, agent });
			return children;
		},
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
vi.mock("../StoryDetailsButton", () => ({ StoryDetailsButton: () => null }));
vi.mock("../StoryCommentsButton", () => ({ StoryCommentsButton: () => null }));
vi.mock("../StoryAttachmentsButton", () => ({
	StoryAttachmentsButton: () => null,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/example-org",
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
			title: "Thread test feature",
			kind: "STORY",
			priority: "MEDIUM",
			identifier: "F-1",
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

import { StoryWorkspacePage } from "../StoryWorkspacePage";

const CONVERSATION = "conv-example-0001";

const client = () =>
	new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});

function page(
	queryClient: QueryClient,
	initialAssistantConversationId: string | null,
) {
	return (
		<QueryClientProvider client={queryClient}>
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="example-org"
				initialAssistantConversationId={initialAssistantConversationId}
			/>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	copilotKitProps.length = 0;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
});

describe("StoryWorkspacePage — assistant thread", () => {
	it("runs the assistant on the persisted conversation's id and keeps it", async () => {
		const queryClient = client();
		const { rerender } = render(page(queryClient, CONVERSATION));

		await screen.findByRole("button", { name: `thread:${CONVERSATION}` });
		rerender(page(queryClient, CONVERSATION));

		expect(copilotKitProps.length).toBeGreaterThan(0);
		expect(copilotKitProps).toContainEqual({
			threadId: CONVERSATION,
			agent: "project_document_generator",
		});
		expect(
			copilotKitProps.every(({ threadId }) => threadId === CONVERSATION),
		).toBe(true);
	});

	it("moves to a fresh thread on a new conversation", async () => {
		render(page(client(), CONVERSATION));

		fireEvent.click(
			await screen.findByRole("button", {
				name: `thread:${CONVERSATION}`,
			}),
		);

		const fresh = copilotKitProps.at(-1)?.threadId;
		expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
		expect(
			screen.getByRole("button", { name: `thread:${fresh}` }),
		).toBeInTheDocument();
	});
});
