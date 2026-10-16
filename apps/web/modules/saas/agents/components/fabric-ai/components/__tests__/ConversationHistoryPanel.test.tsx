/**
 * Fabric Agent's conversation history as a person uses it: which conversations
 * to list, searching by title, a page at a time, and the changes a person makes
 * to their own conversations. Listing, renaming, archiving and deleting go
 * through the real list hook against a stand-in for the procedures.
 */
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import { FabricToolError } from "@saas/mcp/lib/fabric-tool-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	conversations: {
		list: vi.fn(),
		update: vi.fn(),
		archive: vi.fn(),
		togglePin: vi.fn(),
		delete: vi.fn(),
		setVisibility: vi.fn(),
	},
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { conversations: mocks.conversations } },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { ConversationHistoryPanel } from "../ConversationHistoryPanel";

const item = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	agentId: FABRIC_AGENT_ID,
	title: `Conversation ${id}`,
	messageCount: 2,
	pinned: false,
	status: "ACTIVE",
	createdAt: "2026-10-14T09:00:00.000Z",
	updatedAt: "2026-10-14T10:00:00.000Z",
	lastMessage: `last of ${id}`,
	metadata: { mode: "direct" },
	visibility: "PRIVATE",
	isOwn: true,
	owner: { id: "u1", name: "Alex Example" },
	...overrides,
});

function renderPanel(
	props: Partial<React.ComponentProps<typeof ConversationHistoryPanel>> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const handlers = { onSelect: vi.fn(), onDeleted: vi.fn() };
	render(
		<QueryClientProvider client={client}>
			<ConversationHistoryPanel
				organizationId="org-1"
				activeConversationId={null}
				{...handlers}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return handlers;
}

const lastRequest = () =>
	mocks.conversations.list.mock.calls.at(-1)?.[0] as Record<string, unknown>;

async function openMenuFor(title: string) {
	await userEvent.click(
		await screen.findByRole("button", {
			name: `More actions for ${title}`,
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.conversations.list.mockResolvedValue({
		conversations: [item("1")],
	});
});

describe("which conversations are listed", () => {
	it("lists the viewer's own active conversations first", async () => {
		renderPanel();

		expect(await screen.findByText("Conversation 1")).toBeInTheDocument();
		expect(lastRequest()).toMatchObject({
			scope: "mine",
			status: "ACTIVE",
			agentId: FABRIC_AGENT_ID,
			organizationId: "org-1",
		});
		expect(screen.getByRole("button", { name: "Mine" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("switches to the conversations shared with the organization, and to the archived ones", async () => {
		renderPanel();
		await screen.findByText("Conversation 1");

		await userEvent.click(
			screen.getByRole("button", {
				name: "Shared with your organization",
			}),
		);
		await waitFor(() =>
			expect(lastRequest()).toMatchObject({
				scope: "shared",
				status: "ACTIVE",
			}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Archived" }));
		await waitFor(() =>
			expect(lastRequest()).toMatchObject({
				scope: "mine",
				status: "ARCHIVED",
			}),
		);
	});

	it("says what an empty view is for, as a status the screen reader announces", async () => {
		mocks.conversations.list.mockResolvedValue({ conversations: [] });
		renderPanel();

		expect(
			await screen.findByText("No conversations yet"),
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			"No conversations yet",
		);
		await userEvent.click(
			screen.getByRole("button", {
				name: "Shared with your organization",
			}),
		);
		expect(
			await screen.findByText("Nothing is shared yet"),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Archived" }));
		expect(
			await screen.findByText("No archived conversations"),
		).toBeInTheDocument();
	});

	it("searches titles once the person has stopped typing, and says so when nothing matches", async () => {
		renderPanel();
		await screen.findByText("Conversation 1");
		mocks.conversations.list.mockResolvedValue({ conversations: [] });

		await userEvent.type(
			screen.getByRole("searchbox", {
				name: "Search conversations by title",
			}),
			"plan",
		);

		await waitFor(() =>
			expect(lastRequest()).toMatchObject({ search: "plan" }),
		);
		expect(
			mocks.conversations.list.mock.calls.filter(
				([request]) => (request as { search?: string }).search,
			),
		).toHaveLength(1);
		expect(
			await screen.findByText('No conversations match "plan"'),
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			'No conversations match "plan"',
		);
	});

	it("loads the next page on request and hides the button at the end", async () => {
		mocks.conversations.list
			.mockResolvedValueOnce({
				conversations: [item("1")],
				hasMore: true,
				nextCursor: "cursor-1",
			})
			.mockResolvedValueOnce({
				conversations: [item("2")],
				hasMore: false,
			});
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: "Load more" }),
		);

		expect(await screen.findByText("Conversation 2")).toBeInTheDocument();
		expect(lastRequest()).toMatchObject({ cursor: "cursor-1" });
		expect(screen.getByText("Conversation 1")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("says it could not load the list, and tries again on request", async () => {
		mocks.conversations.list.mockRejectedValueOnce(new Error("offline"));
		renderPanel();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The history could not be loaded.",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Try again" }),
		);

		expect(await screen.findByText("Conversation 1")).toBeInTheDocument();
	});
});

describe("a read that fails with conversations already on screen", () => {
	it("keeps the conversations and says the next page could not be loaded, with a way to try that page again", async () => {
		mocks.conversations.list
			.mockResolvedValueOnce({
				conversations: [item("1")],
				hasMore: true,
				nextCursor: "cursor-1",
			})
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({
				conversations: [item("2")],
				hasMore: false,
			});
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: "Load more" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"More conversations could not be loaded.",
		);
		expect(screen.getByText("Conversation 1")).toBeInTheDocument();
		expect(
			screen.queryByText("The history could not be loaded."),
		).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: "Try again" }),
		);

		expect(await screen.findByText("Conversation 2")).toBeInTheDocument();
		expect(screen.getByText("Conversation 1")).toBeInTheDocument();
		expect(lastRequest()).toMatchObject({ cursor: "cursor-1" });
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("keeps the conversations and says the history could not be refreshed when a refresh fails", async () => {
		renderPanel();
		await screen.findByText("Conversation 1");
		mocks.conversations.archive.mockResolvedValue({ id: "1" });
		mocks.conversations.list.mockRejectedValue(new Error("offline"));

		await openMenuFor("Conversation 1");
		await userEvent.click(
			screen.getByRole("menuitem", { name: "Archive" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The history could not be refreshed.",
		);
		expect(screen.getByText("Conversation 1")).toBeInTheDocument();
		mocks.conversations.list.mockResolvedValue({
			conversations: [item("1"), item("3")],
		});
		await userEvent.click(
			screen.getByRole("button", { name: "Try again" }),
		);

		expect(await screen.findByText("Conversation 3")).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});
});

describe("opening a conversation", () => {
	it("hands the whole conversation to whoever shows the panel", async () => {
		const { onSelect } = renderPanel({ activeConversationId: "1" });

		await userEvent.click(
			await screen.findByRole("button", { name: /^Conversation 1/ }),
		);

		expect(onSelect).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "1",
				engine: "direct",
				isOwn: true,
			}),
		);
	});
});

describe("pinning a conversation", () => {
	it("has one label that does not change, and says whether it is pinned with aria-pressed", async () => {
		mocks.conversations.list.mockResolvedValue({
			conversations: [item("1"), item("2", { pinned: true })],
		});
		renderPanel();

		const first = await screen.findByRole("button", {
			name: "Pin Conversation 1",
		});
		const second = screen.getByRole("button", {
			name: "Pin Conversation 2",
		});

		expect(first).toHaveAttribute("aria-pressed", "false");
		expect(second).toHaveAttribute("aria-pressed", "true");
	});

	it("says Pinned when it pins and Unpinned when it unpins", async () => {
		mocks.conversations.list.mockResolvedValue({
			conversations: [item("1"), item("2", { pinned: true })],
		});
		mocks.conversations.togglePin.mockResolvedValue({ id: "1" });
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: "Pin Conversation 1" }),
		);
		await waitFor(() =>
			expect(mocks.toast.success).toHaveBeenCalledWith("Pinned"),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Pin Conversation 2" }),
		);

		await waitFor(() =>
			expect(mocks.toast.success).toHaveBeenCalledWith("Unpinned"),
		);
		expect(mocks.conversations.togglePin).toHaveBeenCalledWith({ id: "2" });
	});

	it("says it could not pin, and not that it could not change", async () => {
		mocks.conversations.togglePin.mockRejectedValue(new Error("nope"));
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: "Pin Conversation 1" }),
		);

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Could not pin this conversation",
				{ description: "Please try again." },
			),
		);
	});
});

describe("changing a conversation", () => {
	it("renames it", async () => {
		mocks.conversations.update.mockResolvedValue({ id: "1" });
		renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		const dialog = await screen.findByRole("dialog");
		const input = within(dialog).getByPlaceholderText("Conversation title");
		await userEvent.clear(input);
		await userEvent.type(input, "Quarterly plan");
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Rename" }),
		);

		await waitFor(() =>
			expect(mocks.conversations.update).toHaveBeenCalledWith({
				id: "1",
				title: "Quarterly plan",
			}),
		);
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Conversation renamed",
		);
	});

	it("archives it, and says so", async () => {
		mocks.conversations.archive.mockResolvedValue({ id: "1" });
		renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(
			screen.getByRole("menuitem", { name: "Archive" }),
		);

		await waitFor(() =>
			expect(mocks.conversations.archive).toHaveBeenCalledWith({
				id: "1",
			}),
		);
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Conversation archived",
		);
	});

	it("restores an archived conversation", async () => {
		mocks.conversations.list.mockResolvedValue({
			conversations: [item("9", { status: "ARCHIVED" })],
		});
		mocks.conversations.update.mockResolvedValue({ id: "9" });
		renderPanel();
		await userEvent.click(screen.getByRole("button", { name: "Archived" }));

		await openMenuFor("Conversation 9");
		await userEvent.click(
			screen.getByRole("menuitem", { name: "Restore" }),
		);

		await waitFor(() =>
			expect(mocks.conversations.update).toHaveBeenCalledWith({
				id: "9",
				status: "ACTIVE",
			}),
		);
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Conversation restored",
		);
	});

	it("says it could not be done, without the server's words, and changes nothing else", async () => {
		mocks.conversations.archive.mockRejectedValue(new Error("not yours"));
		renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(
			screen.getByRole("menuitem", { name: "Archive" }),
		);

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Could not archive this conversation",
				{ description: "Please try again." },
			),
		);
		expect(mocks.toast.success).not.toHaveBeenCalled();
	});

	it("says what a tool said when it refused for a reason meant for the person", async () => {
		mocks.conversations.archive.mockRejectedValue(
			new FabricToolError(
				"Too many changes. Try again in 20 seconds.",
				"fabric_archive",
				{ reason: "rate_limited" },
			),
		);
		renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(
			screen.getByRole("menuitem", { name: "Archive" }),
		);

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Could not archive this conversation",
				{ description: "Too many changes. Try again in 20 seconds." },
			),
		);
	});

	it("deletes it only after asking, then lets go of it", async () => {
		mocks.conversations.delete.mockResolvedValue({ id: "1" });
		const { onDeleted } = renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Delete this conversation?");
		expect(dialog).toHaveTextContent("Conversation 1");
		expect(dialog).toHaveTextContent("Archive it instead");
		expect(mocks.conversations.delete).not.toHaveBeenCalled();
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Delete" }),
		);

		await waitFor(() =>
			expect(mocks.conversations.delete).toHaveBeenCalledWith({
				id: "1",
			}),
		);
		await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("1"));
	});

	it("keeps the conversation when the person backs out of deleting it", async () => {
		const { onDeleted } = renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		await userEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: "Cancel",
			}),
		);

		expect(mocks.conversations.delete).not.toHaveBeenCalled();
		expect(onDeleted).not.toHaveBeenCalled();
	});

	it("does not tell whoever has it open that it is gone when the delete failed", async () => {
		mocks.conversations.delete.mockRejectedValue(new Error("busy"));
		const { onDeleted } = renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		await userEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: "Delete",
			}),
		);

		await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
		expect(onDeleted).not.toHaveBeenCalled();
	});
});

describe("sharing a conversation", () => {
	it("offers a conversation of the viewer's own for sharing, and a shared one for its settings", async () => {
		mocks.conversations.list.mockResolvedValue({
			conversations: [
				item("1"),
				item("2", { visibility: "ORGANIZATION" }),
			],
		});
		renderPanel();

		await openMenuFor("Conversation 1");
		expect(
			screen.getByRole("menuitem", {
				name: "Share with your organization",
			}),
		).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		await openMenuFor("Conversation 2");

		expect(
			screen.getByRole("menuitem", { name: "Sharing settings" }),
		).toBeInTheDocument();
	});

	it("says one thing of a conversation shared by its owner and another of one the viewer shared", async () => {
		mocks.conversations.list.mockResolvedValue({
			conversations: [
				item("1", { visibility: "ORGANIZATION" }),
				item("2", {
					visibility: "ORGANIZATION",
					isOwn: false,
					owner: { id: "u2", name: "Sam Example" },
				}),
			],
		});
		renderPanel();

		const theirs = (await screen.findByText("Conversation 2")).closest(
			"li",
		);
		const mine = screen.getByText("Conversation 1").closest("li");

		expect(theirs).toHaveTextContent("Shared by Sam Example");
		expect(theirs).not.toHaveTextContent("Shared with your organization");
		expect(mine).toHaveTextContent("Shared with your organization");
		expect(mine).not.toHaveTextContent("Shared by");
	});

	it("shares it with the organization after the warning, and closes", async () => {
		mocks.conversations.setVisibility.mockResolvedValue({ id: "1" });
		renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(
			screen.getByRole("menuitem", {
				name: "Share with your organization",
			}),
		);
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(
			within(dialog).getByRole("radio", {
				name: /Shared with your organization/,
			}),
		);
		expect(within(dialog).getByRole("alert")).toHaveTextContent(
			/connected servers/,
		);
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Share" }),
		);

		await waitFor(() =>
			expect(mocks.conversations.setVisibility).toHaveBeenCalledWith({
				id: "1",
				visibility: "ORGANIZATION",
				organizationId: "org-1",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Shared with your organization",
		);
	});

	it("stays open and says it could not be saved when the change failed", async () => {
		mocks.conversations.setVisibility.mockRejectedValue(
			new Error("not yours"),
		);
		renderPanel();

		await openMenuFor("Conversation 1");
		await userEvent.click(
			screen.getByRole("menuitem", {
				name: "Share with your organization",
			}),
		);
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(
			within(dialog).getByRole("radio", {
				name: /Shared with your organization/,
			}),
		);
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Share" }),
		);

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Could not change who can read this conversation",
				{ description: "Please try again." },
			),
		);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});

describe("the words", () => {
	it("say conversation, never session, wherever the panel speaks", async () => {
		mocks.conversations.list.mockResolvedValue({ conversations: [] });
		renderPanel();
		await screen.findByText("No conversations yet");

		for (const view of ["Shared with your organization", "Archived"]) {
			await userEvent.click(screen.getByRole("button", { name: view }));
			await screen.findByRole("status");
			expect(document.body.textContent).not.toMatch(/session/i);
		}

		expect(document.body.innerHTML).not.toMatch(
			/aria-label="[^"]*session/i,
		);
	});
});
