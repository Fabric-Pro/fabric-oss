/**
 * The coverage gate refuses the move to Done and offers two ways forward: add
 * cases, or record why. Only the first was reachable from the product — the
 * override existed for API callers alone, so the documented escape hatch was a
 * dead end in the UI.
 *
 * These assert the parts that made it a dead end: that a reason is required
 * before the retry can be sent, and that the numbers the refusal reported are
 * the numbers the user is shown.
 */

import { CoverageOverrideDialog } from "@saas/projects/components/stories/CoverageOverrideDialog";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const DETAIL = {
	percent: 40,
	target: 80,
	coveredCriteria: 2,
	totalCriteria: 5,
};

function setup(
	overrides: Partial<Parameters<typeof CoverageOverrideDialog>[0]>,
) {
	const onConfirm = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<CoverageOverrideDialog
			detail={DETAIL}
			isPending={false}
			onConfirm={onConfirm}
			onOpenChange={onOpenChange}
			{...overrides}
		/>,
	);
	return { onConfirm, onOpenChange };
}

describe("CoverageOverrideDialog", () => {
	it("stays closed when nothing is blocked", () => {
		setup({ detail: null });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("restates the numbers the refusal reported", () => {
		setup({});
		expect(
			screen.getByText("40% covered, and this project asks for 80%"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/2 of\s+5 acceptance criteria have a\s+test case behind them\./,
			),
		).toBeInTheDocument();
	});

	it("will not send an empty or whitespace-only reason", async () => {
		const user = userEvent.setup();
		const { onConfirm } = setup({});

		const confirm = screen.getByRole("button", {
			name: "Mark done anyway",
		});
		expect(confirm).toBeDisabled();

		// Whitespace is not a reason. The API trims and rejects it too, but a
		// disabled button says so before the round trip.
		await user.type(screen.getByLabelText(/reason/i), "   ");
		expect(confirm).toBeDisabled();
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("sends the trimmed reason once one is given", async () => {
		const user = userEvent.setup();
		const { onConfirm } = setup({});

		await user.type(
			screen.getByLabelText(/reason/i),
			"  Config-only change behind an existing flag.  ",
		);
		await user.click(
			screen.getByRole("button", { name: "Mark done anyway" }),
		);

		expect(onConfirm).toHaveBeenCalledWith(
			"Config-only change behind an existing flag.",
		);
	});

	it("blocks a second submit while the retry is in flight", () => {
		setup({ isPending: true });
		expect(
			screen.getByRole("button", { name: "Marking done…" }),
		).toBeDisabled();
	});
});
