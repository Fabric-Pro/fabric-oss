/**
 * The rows of the conversation history: what each says about a conversation,
 * and which changes a row offers. A conversation someone else shared offers
 * none.
 */
import type { ConversationListItem } from "@saas/agents/lib/conversation-list";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HistoryTabContent } from "../HistoryTabContent";

function session(
	overrides: Partial<ConversationListItem> = {},
): ConversationListItem {
	return {
		id: "c1",
		agentId: "fabric-workspace-assistant",
		title: "Quarterly plan",
		messageCount: 4,
		pinned: false,
		status: "ACTIVE",
		createdAt: "2026-10-14T09:00:00.000Z",
		updatedAt: "2026-10-14T10:00:00.000Z",
		lastMessage: "Here is the plan.",
		engine: "orchestrator",
		metadata: { mode: "orchestrator" },
		visibility: "PRIVATE",
		isOwn: true,
		owner: { id: "u1", name: "Alex Example" },
		...overrides,
	};
}

function renderRows(
	conversations: ConversationListItem[],
	props: Partial<React.ComponentProps<typeof HistoryTabContent>> = {},
) {
	const handlers = {
		onSelectConversation: vi.fn(),
		onTogglePin: vi.fn(),
		onRenameConversation: vi.fn(),
		onShareConversation: vi.fn(),
		onArchiveConversation: vi.fn(),
		onRestoreConversation: vi.fn(),
		onDeleteConversation: vi.fn(),
	};
	render(
		<HistoryTabContent
			conversations={conversations}
			activeConversationId={null}
			{...handlers}
			{...props}
		/>,
	);
	return handlers;
}

describe("what a row says", () => {
	it("shows the title, the engine, how long ago it changed and the last message", () => {
		renderRows([session()]);

		expect(screen.getByText("Quarterly plan")).toBeInTheDocument();
		expect(screen.getByText("Orchestrator")).toBeInTheDocument();
		expect(screen.getByText(/ago$/)).toBeInTheDocument();
		expect(screen.getByText("Here is the plan.")).toBeInTheDocument();
	});

	it.each([
		["direct", "Direct"],
		["research", "Research"],
	] as const)("names a %s session's engine %s", (engine, label) => {
		renderRows([session({ engine })]);

		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it("falls back to a title and a line for a session with neither", () => {
		renderRows([session({ title: null, lastMessage: null })]);

		expect(screen.getByText("Untitled conversation")).toBeInTheDocument();
		expect(screen.getByText(/Open this run/)).toBeInTheDocument();
	});

	it("marks a pinned session, and the one that is open", () => {
		renderRows([session({ pinned: true })], { activeConversationId: "c1" });

		expect(screen.getByText("Pinned")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^Quarterly plan/ }),
		).toHaveAttribute("aria-current", "true");
	});

	it("says a session of the viewer's own is shared, and says whose a shared one is", () => {
		renderRows([
			session({ id: "own", visibility: "ORGANIZATION" }),
			session({
				id: "theirs",
				title: "Their notes",
				visibility: "ORGANIZATION",
				isOwn: false,
				owner: { id: "u2", name: "Sam Example" },
			}),
		]);

		expect(
			screen.getByText("Shared with your organization"),
		).toBeInTheDocument();
		expect(screen.getByText("Shared by Sam Example")).toBeInTheDocument();
	});

	it("says nothing of sharing for a private session of the viewer's own", () => {
		renderRows([session()]);

		expect(screen.queryByText(/Shared/)).toBeNull();
	});

	it("says what is missing when there are no conversations, as a status", () => {
		renderRows([], {
			emptyTitle: "Nothing is shared yet",
			emptyHint: "Soon.",
		});

		expect(screen.getByText("Nothing is shared yet")).toBeInTheDocument();
		expect(screen.getByText("Soon.")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Nothing is shared yet",
		);
	});

	it("says whether a conversation is pinned with one pin button whose label does not change", () => {
		renderRows([
			session({ id: "a", title: "Plain" }),
			session({ id: "b", title: "Pinned one", pinned: true }),
		]);

		expect(
			screen.getByRole("button", { name: "Pin Plain" }),
		).toHaveAttribute("aria-pressed", "false");
		expect(
			screen.getByRole("button", { name: "Pin Pinned one" }),
		).toHaveAttribute("aria-pressed", "true");
		expect(
			screen.queryByRole("button", { name: /Unpin|Unsave|Save/ }),
		).toBeNull();
	});
});

describe("opening a session", () => {
	it("hands over the whole session, not just its id", async () => {
		const row = session();
		const { onSelectConversation } = renderRows([row]);

		await userEvent.click(
			screen.getByRole("button", { name: /^Quarterly plan/ }),
		);

		expect(onSelectConversation).toHaveBeenCalledWith(row);
	});
});

describe("the changes a row offers", () => {
	async function openMenu(title = "Quarterly plan") {
		await userEvent.click(
			screen.getByRole("button", { name: `More actions for ${title}` }),
		);
	}

	it("offers a session of the viewer's own: save, rename, share, archive and delete", async () => {
		const row = session();
		const handlers = renderRows([row]);

		await userEvent.click(
			screen.getByRole("button", { name: "Pin Quarterly plan" }),
		);
		await openMenu();
		await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		await openMenu();
		await userEvent.click(
			screen.getByRole("menuitem", {
				name: "Share with your organization",
			}),
		);
		await openMenu();
		await userEvent.click(
			screen.getByRole("menuitem", { name: "Archive" }),
		);
		await openMenu();
		await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

		expect(handlers.onTogglePin).toHaveBeenCalledWith("c1");
		expect(handlers.onRenameConversation).toHaveBeenCalledWith(row);
		expect(handlers.onShareConversation).toHaveBeenCalledWith(row);
		expect(handlers.onArchiveConversation).toHaveBeenCalledWith(row);
		expect(handlers.onDeleteConversation).toHaveBeenCalledWith(row);
		expect(handlers.onSelectConversation).not.toHaveBeenCalled();
	});

	it("calls the sharing of a session already shared its settings", async () => {
		renderRows([session({ visibility: "ORGANIZATION" })]);

		await openMenu();

		expect(
			screen.getByRole("menuitem", { name: "Sharing settings" }),
		).toBeInTheDocument();
	});

	it("offers an archived session to be restored, not archived, and not saved", async () => {
		const row = session({ status: "ARCHIVED" });
		const handlers = renderRows([row]);

		expect(screen.queryByRole("button", { name: /^Pin / })).toBeNull();
		await openMenu();
		expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
		await userEvent.click(
			screen.getByRole("menuitem", { name: "Restore" }),
		);

		expect(handlers.onRestoreConversation).toHaveBeenCalledWith(row);
	});

	it("offers a session someone else shared nothing to change", () => {
		renderRows([
			session({
				isOwn: false,
				visibility: "ORGANIZATION",
				owner: { id: "u2", name: "Sam Example" },
			}),
		]);

		expect(screen.queryByRole("button", { name: /^Pin / })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /More actions/ }),
		).toBeNull();
	});

	it("offers only the changes it was given handlers for", async () => {
		render(
			<HistoryTabContent
				conversations={[session()]}
				activeConversationId={null}
				onSelectConversation={vi.fn()}
				onRenameConversation={vi.fn()}
			/>,
		);

		await openMenu();

		expect(screen.getAllByRole("menuitem")).toHaveLength(1);
		expect(
			screen.getByRole("menuitem", { name: "Rename" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Pin / })).toBeNull();
	});

	it("shows no menu at all when it was given no handler for one", () => {
		render(
			<HistoryTabContent
				conversations={[session()]}
				activeConversationId={null}
				onSelectConversation={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /More actions/ }),
		).toBeNull();
	});
});
