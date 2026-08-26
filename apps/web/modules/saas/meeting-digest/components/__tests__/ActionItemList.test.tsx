import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// vi.hoisted: vi.mock's factory is hoisted above regular top-level const
// declarations, so a plain `const setActionItemCompleted = vi.fn()` above it
// would throw "Cannot access before initialization" (matches the pattern
// MeetingDetailSheet.test.tsx already uses for the same reason).
const { setActionItemCompleted, proposeActionItem } = vi.hoisted(() => ({
	setActionItemCompleted: vi
		.fn()
		.mockResolvedValue({ success: true, completedAt: new Date() }),
	proposeActionItem: vi
		.fn()
		.mockResolvedValue({ status: "proposed", proposalId: "pr1" }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { setActionItemCompleted, proposeActionItem },
		},
	},
}));

import { ActionItemList } from "../ActionItemList";

describe("ActionItemList", () => {
	it("renders checkboxes for row-backed items and plain bullets for legacy items", () => {
		render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[
					{
						id: "a1",
						text: "checkable",
						tentativeOwnerName: "Alice",
						dueHint: null,
						completedAt: null,
					},
					{
						id: null,
						text: "legacy",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				]}
				onToggled={() => {}}
			/>,
		);
		expect(screen.getAllByRole("checkbox")).toHaveLength(1);
		expect(screen.getByText(/legacy/)).toBeInTheDocument();
	});

	it("fires the toggle procedure optimistically", async () => {
		render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[
					{
						id: "a1",
						text: "x",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				]}
				onToggled={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox"));
		expect(setActionItemCompleted).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: null,
			actionItemId: "a1",
			completed: true,
		});
	});

	it("rolls the checkbox back when the toggle procedure rejects", async () => {
		setActionItemCompleted.mockRejectedValueOnce(new Error("boom"));
		render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[
					{
						id: "a1",
						text: "x",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				]}
				onToggled={() => {}}
			/>,
		);
		const box = screen.getByRole("checkbox");
		expect(box).toHaveAttribute("data-state", "unchecked");
		// Optimistic flip is synchronous...
		fireEvent.click(box);
		expect(box).toHaveAttribute("data-state", "checked");
		// ...then the rejection settles and the override rolls back.
		await waitFor(() =>
			expect(box).toHaveAttribute("data-state", "unchecked"),
		);
	});

	it("proposes a ticket from an action item and shows the confirmation", async () => {
		proposeActionItem.mockResolvedValue({
			status: "proposed",
			proposalId: "pr1",
		});
		render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[
					{
						id: "a1",
						text: "x",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				]}
				onToggled={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /create ticket/i }));
		expect(proposeActionItem).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: null,
			actionItemId: "a1",
		});
		await screen.findByText(
			/Proposed — approve it in the Proposal Inbox\./,
		);
	});

	it("shows the already-proposed message", async () => {
		proposeActionItem.mockResolvedValue({
			status: "already-proposed",
			proposalId: "pr1",
		});
		render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[
					{
						id: "a1",
						text: "x",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				]}
				onToggled={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /create ticket/i }));
		await screen.findByText(/Already proposed — see the Proposal Inbox\./);
	});

	it("keeps the propose message across refetches (new array, same ids) and resets it when ids change", async () => {
		proposeActionItem.mockResolvedValue({
			status: "proposed",
			proposalId: "pr1",
		});
		const item = (id: string) => ({
			id,
			text: "x",
			tentativeOwnerName: null,
			dueHint: null,
			completedAt: null,
		});
		const { rerender } = render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[item("a1")]}
				onToggled={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /create ticket/i }));
		await screen.findByText(
			/Proposed — approve it in the Proposal Inbox\./,
		);
		// Background refetch/invalidation: react-query hands back a FRESH array
		// instance even when the data is identical — the message must survive.
		rerender(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[item("a1")]}
				onToggled={() => {}}
			/>,
		);
		expect(
			screen.getByText(/Proposed — approve it in the Proposal Inbox\./),
		).toBeInTheDocument();
		// Re-extraction genuinely replaces the ids — the message must reset.
		rerender(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[item("a2")]}
				onToggled={() => {}}
			/>,
		);
		expect(
			screen.queryByText(/Proposed — approve it in the Proposal Inbox\./),
		).toBeNull();
	});

	it("does not strike the propose message through when the item is completed", async () => {
		proposeActionItem.mockResolvedValue({
			status: "proposed",
			proposalId: "pr1",
		});
		render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[
					{
						id: "a1",
						text: "x",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: new Date(),
					},
				]}
				onToggled={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /create ticket/i }));
		const msg = await screen.findByText(
			/Proposed — approve it in the Proposal Inbox\./,
		);
		// The item text is struck through, but the message (and button) must not
		// live inside the line-through span.
		expect(msg.closest(".line-through")).toBeNull();
		expect(
			screen
				.getByRole("button", { name: /create ticket/i })
				.closest(".line-through"),
		).toBeNull();
	});

	it("disables the button while a propose request is in flight and re-enables after it settles", async () => {
		// mockClear (not just relying on defaults): call counts otherwise
		// accumulate across this file's earlier tests since there's no global
		// mock reset, which would make toHaveBeenCalledTimes(1) below flaky.
		proposeActionItem.mockClear();
		let resolveRequest: (value: {
			status: "proposed" | "already-proposed";
			proposalId: string;
		}) => void = () => {};
		proposeActionItem.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveRequest = resolve;
			}),
		);
		render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[
					{
						id: "a1",
						text: "x",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				]}
				onToggled={() => {}}
			/>,
		);
		const button = screen.getByRole("button", { name: /create ticket/i });
		fireEvent.click(button);
		fireEvent.click(button);
		fireEvent.click(button);
		// The backend dedupe (findFirst-then-create) is not atomic, so the
		// client-side in-flight guard must be what keeps this to a single call.
		expect(proposeActionItem).toHaveBeenCalledTimes(1);
		expect(button).toBeDisabled();
		expect(button).toHaveTextContent(/proposing/i);
		resolveRequest({ status: "proposed", proposalId: "pr1" });
		await screen.findByText(
			/Proposed — approve it in the Proposal Inbox\./,
		);
		expect(button).not.toBeDisabled();
	});

	it("legacy items (id null) have no create-ticket button", () => {
		render(
			<ActionItemList
				projectId="p1"
				organizationId={null}
				items={[
					{
						id: null,
						text: "legacy",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				]}
				onToggled={() => {}}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /create ticket/i }),
		).toBeNull();
	});
});
