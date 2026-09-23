/**
 * Adding Teams chats refreshes the capability gates (Fizzy #1930).
 *
 * The dialog adds each conversation through a direct client call rather than a
 * `useMutation`, so the app's central "refresh gates after any mutation" hook
 * never sees it. Each add links the conversation, which is what Work Capture
 * and document auto-refresh gate on — without its own refresh, both kept
 * describing the project as it was before the chat arrived. The Slack
 * counterpart is pinned by `SlackChannelSelectorDialog.capability-gates.test`.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, existingContexts } = vi.hoisted(() => ({
	mocks: {
		invalidateQueries: vi.fn(),
		create: vi.fn(),
		enableChatMonitor: vi.fn(),
		enableChannelMonitor: vi.fn(),
	},
	// Stable across renders, as react-query's own data is: the dialog keys a
	// selection effect on it, and a fresh object each render loops forever.
	existingContexts: { data: { contexts: [] } },
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
	useQuery: () => existingContexts,
	useInfiniteQuery: () => ({
		data: {
			pages: [
				{
					chats: [
						{
							id: "chat_example",
							topic: "Product sync",
							type: "group",
							memberCount: 3,
						},
					],
					channels: [],
					isConnected: true,
				},
			],
		},
		isLoading: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
	}),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org_example" }),
	useContextPath: (path: string) => `/app/example-org/${path}`,
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (url: string) => url,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryOptions: () => ({}),
					queryKey: () => ["contexts"],
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				create: mocks.create,
				listAvailableTeamsChats: vi.fn(),
			},
			teamsChatMonitor: { enable: mocks.enableChatMonitor },
			teamsChannelMonitor: { enable: mocks.enableChannelMonitor },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

import { TeamsChatSelectorDialog } from "../TeamsChatSelectorDialog";

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	mocks.create.mockResolvedValue({ id: "context_example" });
	mocks.enableChatMonitor.mockResolvedValue({});
	mocks.enableChannelMonitor.mockResolvedValue({});
});

describe("TeamsChatSelectorDialog — capability gates", () => {
	it("refreshes the gates after adding a chat", async () => {
		const user = userEvent.setup();
		render(
			<TeamsChatSelectorDialog
				projectId="project_example"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(await screen.findByRole("checkbox"));
		await user.click(screen.getByRole("button", { name: /add 1 source/i }));

		await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(mocks.invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["capability-gates"],
			}),
		);
	});
});
