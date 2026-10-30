/**
 * The document assistant's `<CopilotKit>` runs on the persisted conversation's
 * id (`assistant-thread.tsx`), so the agent's prompt-cache session and the
 * durable runner's reattach key stay one id across turns and reloads:
 *
 *   - the page's conversation id is the thread id;
 *   - the editor below sees the same thread through `useAssistantThread`;
 *   - a re-render keeps the thread; "New conversation" moves it to a fresh id.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { copilotKitProps } = vi.hoisted(() => ({
	copilotKitProps: [] as Array<{ threadId?: string; agent?: string }>,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: (opts: unknown) => ({
					queryKey: ["projects.get", opts],
				}),
			},
			documents: {
				get: {
					queryOptions: (opts: unknown) => ({
						queryKey: ["documents.get", opts],
					}),
				},
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	skipToken: Symbol("skipToken"),
	useQuery: ({ queryKey }: { queryKey: [string, unknown] }) => {
		if (queryKey[0] === "documents.get") {
			return {
				isLoading: false,
				data: {
					document: {
						id: "doc-1",
						title: "Release plan",
						type: "PRD",
						content: "# Release plan",
					},
				},
			};
		}
		return {
			isLoading: false,
			data: {
				project: {
					id: "proj-1",
					name: "Example project",
					organizationId: "org-example",
				},
			},
		};
	},
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => false,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example",
		isLoading: false,
	}),
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ setIsFullscreen: vi.fn() }),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));
vi.mock("@saas/shared/components/copilot/ai-sidebar-layout", () => ({
	AI_SIDEBAR_CONTENT_SHIFT_CLASS: "",
	useAiSidebarExpanded: () => false,
}));
vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	CopilotChatSessionProvider: ({ children }: { children: ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@saas/projects/hooks", () => ({
	useProjectPresence: () => ({ activeUsers: [], isConnected: false }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@saas/subscriptions/components/SubscribeToggle", () => ({
	SubscribeToggle: () => null,
}));
vi.mock("@saas/projects/components/DocumentAutoRefreshToggle", () => ({
	DocumentAutoRefreshToggle: () => null,
}));
vi.mock("@saas/projects/components/DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: () => null,
}));

vi.mock("@copilotkit/react-core", () => ({
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
		return <>{children}</>;
	},
}));

// The editor below the provider: shows the thread it sees and offers the
// "New conversation" action the real editor wires to `startNewThread`.
vi.mock("@saas/projects/components/DocumentEditor", async () => {
	const { useAssistantThread } = await import(
		"@saas/shared/components/copilot/assistant-thread"
	);
	return {
		DocumentEditor: () => {
			const thread = useAssistantThread();
			return (
				<button type="button" onClick={() => thread?.startNewThread()}>
					{`thread:${thread?.threadId ?? "none"}`}
				</button>
			);
		},
		getDocumentTypeLabel: () => "PRD",
	};
});

import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";

const CONVERSATION = "conv-example-0001";

function page(initialAssistantConversationId: string | null) {
	return (
		<DocumentEditorPage
			projectId="proj-1"
			documentId="doc-1"
			organizationSlug="example-org"
			initialAssistantConversationId={initialAssistantConversationId}
		/>
	);
}

const lastThread = () => copilotKitProps.at(-1)?.threadId;

describe("DocumentEditorPage — assistant thread", () => {
	beforeEach(() => {
		copilotKitProps.length = 0;
	});

	it("runs the assistant on the persisted conversation's id", () => {
		const { rerender } = render(page(CONVERSATION));

		expect(copilotKitProps[0]).toEqual({
			threadId: CONVERSATION,
			agent: "project_document_generator",
		});
		expect(
			screen.getByRole("button", { name: `thread:${CONVERSATION}` }),
		).toBeInTheDocument();

		rerender(page(CONVERSATION));

		expect(
			copilotKitProps.every(({ threadId }) => threadId === CONVERSATION),
		).toBe(true);
	});

	it("mints one thread for a page without a conversation", () => {
		const { rerender } = render(page(null));
		const minted = lastThread();

		rerender(page(null));

		expect(minted).toMatch(/^[0-9a-f-]{36}$/);
		expect(lastThread()).toBe(minted);
		expect(
			screen.getByRole("button", { name: `thread:${minted}` }),
		).toBeInTheDocument();
	});

	it("moves to a fresh thread on a new conversation", () => {
		render(page(CONVERSATION));

		fireEvent.click(
			screen.getByRole("button", { name: `thread:${CONVERSATION}` }),
		);

		const fresh = lastThread();
		expect(fresh).not.toBe(CONVERSATION);
		expect(
			screen.getByRole("button", { name: `thread:${fresh}` }),
		).toBeInTheDocument();
	});
});
