/**
 * SnoozeTopicDialog — preset choice, optional rationale, failure keeps text.
 *
 * The dialog is deliberately tested in isolation from the row: its contract is
 * small and exact (which preset name reaches onConfirm), and testing it through
 * the row would make a preset regression look like a row regression.
 */

import { SnoozeTopicDialog } from "@saas/projects/components/publishing-suite/SnoozeTopicDialog";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

function renderDialog(
	props: Partial<React.ComponentProps<typeof SnoozeTopicDialog>> = {},
) {
	const onConfirm = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<SnoozeTopicDialog
			topicTitle="Alpha topic"
			open
			onOpenChange={onOpenChange}
			onConfirm={onConfirm}
			{...props}
		/>,
	);
	return { onConfirm, onOpenChange };
}

describe("SnoozeTopicDialog", () => {
	it("offers exactly the three server-supported durations", () => {
		renderDialog();
		const group = screen.getByRole("radiogroup", {
			name: /snooze duration/i,
		});
		const options = within(group).getAllByRole("radio");
		expect(options).toHaveLength(3);
		expect(options.map((o) => o.textContent)).toEqual([
			"1 week",
			"1 month",
			"3 months",
		]);
	});

	it("sends the PRESET NAME, never a date", async () => {
		const user = userEvent.setup();
		const { onConfirm } = renderDialog();
		await user.click(screen.getByRole("radio", { name: "1 month" }));
		await user.click(screen.getByRole("button", { name: /snooze topic/i }));
		expect(onConfirm).toHaveBeenCalledWith("ONE_MONTH", null);
	});

	it("defaults to one week when the user picks nothing", async () => {
		const user = userEvent.setup();
		const { onConfirm } = renderDialog();
		await user.click(screen.getByRole("button", { name: /snooze topic/i }));
		expect(onConfirm).toHaveBeenCalledWith("ONE_WEEK", null);
	});

	it("trims the rationale and sends null when it is blank", async () => {
		const user = userEvent.setup();
		const { onConfirm } = renderDialog();
		await user.type(
			screen.getByLabelText(/reason \(optional\)/i),
			"   \t  ",
		);
		await user.click(screen.getByRole("button", { name: /snooze topic/i }));
		expect(onConfirm).toHaveBeenCalledWith("ONE_WEEK", null);
	});

	it("passes a real rationale through trimmed", async () => {
		const user = userEvent.setup();
		const { onConfirm } = renderDialog();
		await user.type(
			screen.getByLabelText(/reason \(optional\)/i),
			"  waiting on the release  ",
		);
		await user.click(screen.getByRole("button", { name: /snooze topic/i }));
		expect(onConfirm).toHaveBeenCalledWith(
			"ONE_WEEK",
			"waiting on the release",
		);
	});

	it("disables both buttons while the mutation is in flight", () => {
		renderDialog({ isPending: true });
		expect(
			screen.getByRole("button", { name: /snooze topic/i }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
	});

	it("moves the selection with the arrow key (roving tabindex, WAI-ARIA radio pattern)", async () => {
		const user = userEvent.setup();
		const { onConfirm } = renderDialog();
		const oneWeek = screen.getByRole("radio", { name: "1 week" });
		// Roving tabindex: only the checked option is in the Tab sequence.
		expect(oneWeek).toHaveAttribute("tabindex", "0");
		expect(screen.getByRole("radio", { name: "1 month" })).toHaveAttribute(
			"tabindex",
			"-1",
		);
		oneWeek.focus();
		fireEvent.keyDown(oneWeek, { key: "ArrowRight", code: "ArrowRight" });
		await waitFor(() => {
			expect(
				screen.getByRole("radio", { name: "1 month" }),
			).toHaveAttribute("aria-checked", "true");
		});
		expect(screen.getByRole("radio", { name: "1 month" })).toHaveFocus();
		await user.click(screen.getByRole("button", { name: /snooze topic/i }));
		expect(onConfirm).toHaveBeenCalledWith("ONE_MONTH", null);
	});
});
