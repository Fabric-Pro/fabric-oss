/**
 * Who can read a conversation. Sharing warns first: the transcript can hold
 * what the agent read from the owner's own connected servers.
 */
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import type { ConversationListItem } from "@saas/agents/lib/conversation-list";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationVisibilityDialog } from "../ConversationVisibilityDialog";

function conversationRow(
	overrides: Partial<ConversationListItem> = {},
): ConversationListItem {
	return {
		id: "c1",
		agentId: FABRIC_AGENT_ID,
		title: "Quarterly plan",
		messageCount: 4,
		pinned: false,
		status: "ACTIVE",
		createdAt: "2026-10-14T09:00:00.000Z",
		updatedAt: "2026-10-14T10:00:00.000Z",
		lastMessage: null,
		engine: "direct",
		metadata: null,
		visibility: "PRIVATE",
		isOwn: true,
		owner: { id: "u1", name: "Alex Example" },
		...overrides,
	};
}

function renderDialog(conversation: ConversationListItem | null) {
	const onOpenChange = vi.fn();
	const onConfirm = vi.fn().mockResolvedValue(undefined);
	const view = render(
		<ConversationVisibilityDialog
			conversation={conversation}
			onOpenChange={onOpenChange}
			onConfirm={onConfirm}
		/>,
	);
	const rerender = (next: ConversationListItem | null) =>
		view.rerender(
			<ConversationVisibilityDialog
				conversation={next}
				onOpenChange={onOpenChange}
				onConfirm={onConfirm}
			/>,
		);
	return { onOpenChange, onConfirm, rerender };
}

describe("the visibility dialog", () => {
	it("is closed while there is no conversation to change", () => {
		renderDialog(null);

		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens on the conversation's present choice, with nothing to save yet and no warning", () => {
		renderDialog(conversationRow());

		expect(screen.getByRole("dialog")).toHaveTextContent("Quarterly plan");
		expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked();
		expect(
			screen.getByRole("button", { name: "Make private" }),
		).toBeDisabled();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("warns that the transcript can include the owner's connected-server results once sharing is chosen", async () => {
		renderDialog(conversationRow());

		await userEvent.click(
			screen.getByRole("radio", {
				name: /Shared with your organization/,
			}),
		);

		expect(screen.getByRole("alert")).toHaveTextContent(
			/results the agent read from your own connected servers/,
		);
		expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();
	});

	it("shares the conversation once confirmed, and tells the caller which", async () => {
		const row = conversationRow();
		const { onConfirm } = renderDialog(row);

		await userEvent.click(
			screen.getByRole("radio", {
				name: /Shared with your organization/,
			}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Share" }));

		await waitFor(() =>
			expect(onConfirm).toHaveBeenCalledWith(row, "ORGANIZATION"),
		);
	});

	it("makes a shared conversation private again, without a warning", async () => {
		const row = conversationRow({ visibility: "ORGANIZATION" });
		const { onConfirm } = renderDialog(row);

		expect(
			screen.getByRole("radio", {
				name: /Shared with your organization/,
			}),
		).toBeChecked();
		expect(screen.getByRole("alert")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("radio", { name: /Private/ }));
		expect(screen.queryByRole("alert")).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: "Make private" }),
		);

		await waitFor(() =>
			expect(onConfirm).toHaveBeenCalledWith(row, "PRIVATE"),
		);
	});

	it("saves nothing when cancelled", async () => {
		const { onConfirm, onOpenChange } = renderDialog(conversationRow());

		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("says conversation, never session", () => {
		renderDialog(conversationRow());

		expect(screen.getByRole("dialog").textContent).not.toMatch(/session/i);
	});
});

describe("a choice that was not saved", () => {
	it("does not carry over to the next conversation that is opened", async () => {
		const first = conversationRow({ id: "c1", visibility: "PRIVATE" });
		const second = conversationRow({
			id: "c2",
			title: "Roadmap",
			visibility: "PRIVATE",
		});
		const { rerender } = renderDialog(first);
		await userEvent.click(
			screen.getByRole("radio", {
				name: /Shared with your organization/,
			}),
		);
		expect(screen.getByRole("alert")).toBeInTheDocument();

		rerender(second);

		expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("dialog")).toHaveTextContent("Roadmap");
	});

	it("starts from the next conversation's own choice when the dialog switches straight to it", () => {
		const { rerender } = renderDialog(conversationRow({ id: "c1" }));

		rerender(
			conversationRow({
				id: "c2",
				title: "Roadmap",
				visibility: "ORGANIZATION",
			}),
		);

		expect(
			screen.getByRole("radio", {
				name: /Shared with your organization/,
			}),
		).toBeChecked();
	});
});
