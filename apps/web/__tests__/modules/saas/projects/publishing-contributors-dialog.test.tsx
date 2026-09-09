/**
 * ContributorsDialog — the topic contributor picker (Fizzy #1851 follow-up).
 *
 * These pin the defect the PO reported as "same for contributors": the dialog
 * said **"None selected"** over a real selection.
 *
 * The cause was that both the count and Save were computed over VISIBLE ROWS,
 * while the rows were built from `contributors` — the ids a user lookup
 * resolved — and the selection from `userContributorUserIds`, the raw override
 * column. Those two diverge exactly when a contributor cannot be resolved, and
 * `listPublishingTopics`' degrade contract empties `contributors` wholesale
 * while the raw ids survive. So the selection was invisible, uncounted, and
 * silently dropped by the next Save.
 *
 * `AssigneesDialog` was built without this and its tests say so; these are the
 * other half of that pair, so the two dialogs cannot drift apart again.
 */

import { ContributorsDialog } from "@saas/projects/components/publishing-suite/ContributorsDialog";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

function member(userId: string, name: string) {
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

function contributor(id: string, name: string) {
	return { id, name, image: null, username: null };
}

function renderDialog(
	overrides: Partial<React.ComponentProps<typeof ContributorsDialog>> = {},
) {
	const onSubmit = vi.fn();
	const props = {
		topicTitle: "A topic",
		open: true,
		onOpenChange: vi.fn(),
		members: [member("u1", "Ada"), member("u2", "Bob")],
		contributors: [],
		initialSelected: [],
		hasOverride: false,
		viewerUserId: "u1",
		onSubmit,
		membersPending: false,
		membersError: false,
		...overrides,
	} as React.ComponentProps<typeof ContributorsDialog>;
	render(<ContributorsDialog {...props} />);
	return { onSubmit };
}

function count() {
	return screen.getByTestId("contributors-selected-count").textContent;
}

describe("ContributorsDialog selected count", () => {
	it("counts a selection whose handles never resolved", () => {
		// The override names two people; the lookup resolved neither, so
		// `contributors` is empty. Counting rows printed "None selected" here.
		renderDialog({
			contributors: [],
			initialSelected: ["gone-1", "gone-2"],
			hasOverride: true,
		});

		expect(count()).toBe("2 selected");
	});

	it("gives every selected id a row, so it can be removed on purpose", () => {
		renderDialog({
			contributors: [],
			initialSelected: ["gone-1"],
			hasOverride: true,
		});

		expect(
			screen.getByRole("checkbox", { name: /Former member/ }),
		).toBeChecked();
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

	it("keeps a non-member contributor's row after it is unchecked", async () => {
		// The row is seeded from `initialSelected`, not from the live
		// selection: unchecking must not delete the only way back.
		const user = userEvent.setup();
		renderDialog({
			contributors: [contributor("ex", "Cleo")],
			initialSelected: ["ex"],
			hasOverride: true,
		});

		await user.click(screen.getByRole("checkbox", { name: /Cleo/ }));
		expect(count()).toBe("None selected");
		expect(
			screen.getByRole("checkbox", { name: /Cleo/ }),
		).toBeInTheDocument();
	});
});

describe("ContributorsDialog save", () => {
	it("does not silently drop a selected id it could not resolve", async () => {
		const user = userEvent.setup();
		const { onSubmit } = renderDialog({
			contributors: [],
			initialSelected: ["u1", "gone-1"],
			hasOverride: true,
		});

		await user.click(screen.getByRole("button", { name: /^Save$/ }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect([...onSubmit.mock.calls[0][0]].sort()).toEqual(["gone-1", "u1"]);
	});

	it("still submits a deliberate removal", async () => {
		const user = userEvent.setup();
		const { onSubmit } = renderDialog({
			contributors: [],
			initialSelected: ["u1", "gone-1"],
			hasOverride: true,
		});

		await user.click(
			screen.getByRole("checkbox", { name: /Former member/ }),
		);
		await user.click(screen.getByRole("button", { name: /^Save$/ }));

		expect(onSubmit).toHaveBeenCalledWith(["u1"]);
	});
});
