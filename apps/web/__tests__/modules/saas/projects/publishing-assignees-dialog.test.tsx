/**
 * AssigneesDialog — the topic assignee picker (Fizzy #1851, A8).
 *
 * Rendered directly rather than through a mount, because what these pin is the
 * component's own contract and both mounts (`TopicRow`, `TopicItemPage`) pass
 * it the same four things.
 *
 * The headline case is the COUNT. `ContributorsDialog` computes its "N
 * selected" over VISIBLE ROWS, so a selection whose rows are not rendered —
 * a members list still loading, or an assignee who has since left the project —
 * reads as "None selected" while three people are selected. The PO hit exactly
 * that and reported the dialog as broken. This dialog counts the SELECTION, and
 * these tests exist so nobody "harmonises" it back to the row count.
 */

import { AssigneesDialog } from "@saas/projects/components/publishing-suite/AssigneesDialog";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

type Member = {
	userId: string;
	user: {
		id: string;
		name: string | null;
		email: string;
		image: string | null;
	};
};

function member(userId: string, name: string): Member {
	return {
		userId,
		user: {
			id: userId,
			name,
			email: `${userId}@example.com`,
			image: null,
		},
	};
}

function assignee(id: string, name: string) {
	return { id, name, image: null, username: null };
}

function renderDialog(
	overrides: Partial<React.ComponentProps<typeof AssigneesDialog>> = {},
) {
	const onSubmit = vi.fn();
	const props: React.ComponentProps<typeof AssigneesDialog> = {
		topicTitle: "A topic",
		open: true,
		onOpenChange: vi.fn(),
		members: [member("u1", "Ada"), member("u2", "Bob")],
		assignees: [],
		initialSelected: [],
		viewerUserId: "u1",
		onSubmit,
		membersPending: false,
		membersError: false,
		...overrides,
	};
	render(<AssigneesDialog {...props} />);
	return { onSubmit };
}

function count() {
	return screen.getByTestId("assignees-selected-count").textContent;
}

describe("AssigneesDialog selected count", () => {
	it("counts a selection it cannot currently render — the defect ContributorsDialog still has", () => {
		// Members have not loaded, so there are NO rows to count. The topic
		// nonetheless has two assignees. Counting rows would print "None
		// selected" here, which is what the PO reported.
		renderDialog({
			members: [],
			membersPending: true,
			assignees: [assignee("u1", "Ada"), assignee("u2", "Bob")],
			initialSelected: ["u1", "u2"],
		});

		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(count()).toBe("2 selected");
	});

	it("keeps counting the selection when a selected id resolves to no handle at all", () => {
		// A deleted account: the id survives in `assigneeUserIds` but has no
		// entry in the resolved `assignees`. It still gets a row (so it can be
		// unchecked) and it still counts.
		renderDialog({
			assignees: [],
			initialSelected: ["u1", "ghost"],
		});

		expect(count()).toBe("2 selected");
	});

	it("carries no 'of N' denominator — the framing that made the row count look necessary", () => {
		renderDialog({ initialSelected: ["u1"] });

		expect(count()).toBe("1 selected");
		expect(count()).not.toMatch(/of/);
	});

	it("says 'None selected' only when the selection is genuinely empty", () => {
		renderDialog({ initialSelected: [] });

		expect(count()).toBe("None selected");
	});

	it("tracks the count as the user checks and unchecks", async () => {
		const user = userEvent.setup();
		renderDialog({ initialSelected: [] });

		await user.click(screen.getByRole("checkbox", { name: /Bob/ }));
		expect(count()).toBe("1 selected");

		await user.click(screen.getByRole("checkbox", { name: /Bob/ }));
		expect(count()).toBe("None selected");
	});
});

describe("AssigneesDialog behaviour", () => {
	it("lets the viewer assign themselves, and lets them take themselves off", async () => {
		const user = userEvent.setup();
		const { onSubmit } = renderDialog({ initialSelected: [] });

		// The ask was to be able to EXCLUDE yourself, not to be unable to
		// include yourself — so the viewer's own row is a normal, checkable row
		// that merely says "(You)".
		const own = screen.getByRole("checkbox", { name: /Ada \(You\)/ });
		await user.click(own);
		expect(own).toBeChecked();

		await user.click(own);
		expect(own).not.toBeChecked();

		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(onSubmit).toHaveBeenCalledWith([]);
	});

	it("submits the whole selection, in one plain array — there is no null reset arm", async () => {
		const user = userEvent.setup();
		const { onSubmit } = renderDialog({ initialSelected: ["u1"] });

		await user.click(screen.getByRole("checkbox", { name: /Bob/ }));
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(onSubmit).toHaveBeenCalledWith(["u1", "u2"]);
		expect(
			screen.queryByRole("button", { name: /Reset to AI suggestion/ }),
		).not.toBeInTheDocument();
	});

	it("blocks Save on an assignee who has left the project, and says which one", async () => {
		// The server refuses a non-member id outright (no grandfathering), so
		// the dialog must not let the user hit that as a raw 400.
		renderDialog({
			members: [member("u1", "Ada")],
			assignees: [assignee("u1", "Ada"), assignee("u9", "Charlie")],
			initialSelected: ["u1", "u9"],
		});

		expect(screen.getByRole("checkbox", { name: /Charlie/ })).toBeChecked();
		expect(
			screen.getByText("No longer a project member"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(screen.getByRole("alert").textContent).toMatch(
			/No longer a project member/,
		);
	});

	it("re-enables Save once the departed assignee is unchecked", async () => {
		const user = userEvent.setup();
		const { onSubmit } = renderDialog({
			members: [member("u1", "Ada")],
			assignees: [assignee("u1", "Ada"), assignee("u9", "Charlie")],
			initialSelected: ["u1", "u9"],
		});

		await user.click(screen.getByRole("checkbox", { name: /Charlie/ }));

		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeEnabled();
		await user.click(save);
		expect(onSubmit).toHaveBeenCalledWith(["u1"]);
	});

	it("disables Save while the members list has not loaded, so a stale roster cannot produce an accidental empty save", () => {
		renderDialog({
			members: [],
			membersPending: true,
			initialSelected: ["u1"],
		});

		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("disables Save and explains when the members query failed", () => {
		renderDialog({ members: [], membersError: true, initialSelected: [] });

		expect(screen.getByRole("alert").textContent).toMatch(
			/couldn't load this project's members/i,
		);
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("says out loud that assigning is not a permission", () => {
		renderDialog();

		expect(
			within(screen.getByRole("dialog")).getByText(
				/Everyone on the project can still see and edit this topic/i,
			),
		).toBeInTheDocument();
	});
});
