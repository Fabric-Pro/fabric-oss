/**
 * Linking or unlinking a chat conversation from Settings refreshes the
 * capability gates (Fizzy #1930).
 *
 * Work Capture's warning is about exactly that — whether any conversation is
 * linked — so a link that left the gates stale would keep the banner up over
 * the channel that just satisfied it.
 *
 * No per-call refresh is wired for these, and deliberately: every link in the
 * three monitor cards runs through its picker's `useMutation`, and every
 * unlink through `useMonitorContextControls`'s, so the app's central "refresh
 * gates after any mutation" hook sees all of them. These tests run on the REAL
 * query client from `createQueryClient` — a mocked react-query would mock away
 * the very mechanism being relied on — so a path that moves to a bare client
 * call fails here rather than going stale in production.
 */

import { createQueryClient } from "@shared/lib/query-client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		listAvailableTeamsChats: vi.fn(),
		listLinkedChats: vi.fn(),
		linkChat: vi.fn(),
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				listAvailableTeamsChats: mocks.listAvailableTeamsChats,
			},
			teamsChatMonitor: {
				listLinkedChats: mocks.listLinkedChats,
				linkChat: mocks.linkChat,
			},
		},
	},
}));

// Confirms at once, so the unlink runs the way the dialog's confirm would.
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({
		confirm: (options: { onConfirm: () => Promise<void> }) => {
			// The provider reports a failed confirm action itself; the hook's
			// own onError has already toasted it.
			options.onConfirm().catch(() => {});
		},
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

import { TeamsChatPickerDialog } from "../TeamsChatPickerDialog";
import { useMonitorContextControls } from "../useMonitorContextControls";

const GATES = { queryKey: ["capability-gates"] };

function withClient() {
	const client = createQueryClient();
	const invalidate = vi.spyOn(client, "invalidateQueries");
	function wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
	}
	return { wrapper, invalidate };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	mocks.listAvailableTeamsChats.mockResolvedValue({
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
		nextChatsCursor: null,
	});
	mocks.listLinkedChats.mockResolvedValue([]);
	mocks.linkChat.mockResolvedValue({ id: "linked_example" });
});

describe("chat monitor links and the capability gates", () => {
	it("refreshes the gates after a chat is linked from its picker", async () => {
		const { wrapper, invalidate } = withClient();
		const user = userEvent.setup();
		render(
			<TeamsChatPickerDialog
				projectId="project_example"
				organizationId="org_example"
				open
				onOpenChange={vi.fn()}
			/>,
			{ wrapper },
		);

		await user.click(await screen.findByRole("checkbox"));
		await user.click(screen.getByRole("button", { name: "Link 1 Chat" }));

		await waitFor(() => expect(mocks.linkChat).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith(GATES));
	});

	it("refreshes the gates after an unlink — the one path all three cards share", async () => {
		const { wrapper, invalidate } = withClient();
		const unlink = vi.fn().mockResolvedValue({});
		const { result } = renderHook(
			() =>
				useMonitorContextControls({
					noun: "channel",
					setActive: vi.fn().mockResolvedValue({}),
					unlink,
					reconnect: vi.fn(),
					invalidate: vi.fn(),
				}),
			{ wrapper },
		);

		act(() => {
			result.current.requestUnlink({
				id: "linked_example",
				label: "#product",
				deactivatedAt: null,
			});
		});

		await waitFor(() => expect(unlink).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith(GATES));
	});
});
