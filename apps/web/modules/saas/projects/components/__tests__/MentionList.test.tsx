import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MentionList } from "../MentionList";

const items = [
	{
		kind: "user" as const,
		id: "u_1",
		name: "Alice",
		email: "a@x",
		avatarUrl: null,
	},
	{
		kind: "user" as const,
		id: "u_2",
		name: "Bob",
		email: "b@x",
		avatarUrl: null,
	},
];

describe("MentionList", () => {
	it("renders all items", () => {
		render(
			<MentionList
				items={items}
				command={vi.fn()}
				listboxId="lb"
				setActiveDescendant={() => {}}
			/>,
		);
		expect(screen.getByText("Alice")).toBeInTheDocument();
		expect(screen.getByText("Bob")).toBeInTheDocument();
	});

	it("clicking an item invokes command with the right payload", () => {
		const command = vi.fn();
		render(
			<MentionList
				items={items}
				command={command}
				listboxId="lb"
				setActiveDescendant={() => {}}
			/>,
		);
		fireEvent.click(screen.getByText("Bob"));
		expect(command).toHaveBeenCalledWith({
			kind: "user",
			id: "u_2",
			label: "Bob",
		});
	});

	it("shows empty state when items is empty", () => {
		render(
			<MentionList
				items={[]}
				command={vi.fn()}
				listboxId="lb"
				setActiveDescendant={() => {}}
			/>,
		);
		expect(screen.getByText(/no matching members/i)).toBeInTheDocument();
	});

	it("exposes listbox semantics with stable option ids", () => {
		render(
			<MentionList
				items={items}
				command={() => {}}
				listboxId="mention-listbox-test"
				setActiveDescendant={() => {}}
			/>,
		);
		const listbox = screen.getByRole("listbox", {
			name: /mention suggestions/i,
		});
		expect(listbox.id).toBe("mention-listbox-test");
		const options = within(listbox).getAllByRole("option");
		expect(options).toHaveLength(2);
		expect(options[0]).toHaveAttribute("aria-selected", "true");
		expect(options[1]).toHaveAttribute("aria-selected", "false");
		expect(options[0].id).toBe("mention-listbox-test-opt-0");
		expect(options[1].id).toBe("mention-listbox-test-opt-1");
	});

	it("announces result count via polite live region", async () => {
		const { rerender } = render(
			<MentionList
				items={[]}
				command={() => {}}
				listboxId="lb1"
				setActiveDescendant={() => {}}
			/>,
		);
		const status = screen.getByRole("status");
		expect(status).toHaveAttribute("aria-live", "polite");

		rerender(
			<MentionList
				items={[
					{
						kind: "user",
						id: "u_1",
						name: "Alice",
						email: "a@x",
						avatarUrl: null,
					},
				]}
				command={() => {}}
				listboxId="lb1"
				setActiveDescendant={() => {}}
			/>,
		);
		await waitFor(() => expect(status).toHaveTextContent(/1 suggestion/));
	});

	it("calls setActiveDescendant when active index initializes", () => {
		const setActiveDescendant = vi.fn();
		render(
			<MentionList
				items={[
					{
						kind: "user",
						id: "u_1",
						name: "Alice",
						email: "a@x",
						avatarUrl: null,
					},
				]}
				command={() => {}}
				listboxId="lb1"
				setActiveDescendant={setActiveDescendant}
			/>,
		);
		expect(setActiveDescendant).toHaveBeenCalledWith(0);
	});

	it("renders group rows with label, member count, and the group glyph", () => {
		const command = vi.fn();
		const { container } = render(
			<MentionList
				items={[
					...items,
					{
						kind: "group",
						tag: "DEVELOPER",
						label: "Developers",
						memberCount: 5,
					},
				]}
				command={command}
				listboxId="lb"
				setActiveDescendant={() => {}}
			/>,
		);
		// Exact single-node assertion: the label and count render as one
		// interpolated string ("Developers · 5"), not just "5" somewhere.
		const row = screen.getByText("Developers · 5");
		expect(row).toBeInTheDocument();
		// The group row is distinguished by the Users glyph (lucide svg).
		expect(container.querySelector("svg.lucide-users")).toBeInTheDocument();

		fireEvent.click(row);
		expect(command).toHaveBeenCalledWith({
			kind: "group",
			groupTag: "DEVELOPER",
			label: "Developers",
		});
	});
});
