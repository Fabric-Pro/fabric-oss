/**
 * Toolbar disabled reasons stay reachable (Fizzy #2204, AC-14).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@ui/components/tooltip";
import { describe, expect, it, vi } from "vitest";
import { EntryPointReasonGuard } from "../entry-point-reason";
import type { EntryPointReason } from "../entry-point-states";

function renderGuard(reason: EntryPointReason | null) {
	const onClick = vi.fn();
	render(
		<TooltipProvider>
			<EntryPointReasonGuard reason={reason} hint="Pull from Jira">
				{(guard) => (
					<button
						{...guard}
						type="button"
						onClick={reason ? undefined : onClick}
					>
						Pull
					</button>
				)}
			</EntryPointReasonGuard>
		</TooltipProvider>,
	);
	return onClick;
}

describe("EntryPointReasonGuard", () => {
	it("a blocked action stays focusable and describes its reason", async () => {
		const user = userEvent.setup();
		const onClick = renderGuard({ kind: "permission" });
		const button = screen.getByRole("button", { name: "Pull" });
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button).not.toBeDisabled();
		await user.tab();
		expect(button).toHaveFocus();
		expect(button).toHaveAccessibleDescription("permission");
		await user.click(button);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("an available action carries no disabled wiring", async () => {
		const user = userEvent.setup();
		const onClick = renderGuard(null);
		const button = screen.getByRole("button", { name: "Pull" });
		expect(button).not.toHaveAttribute("aria-disabled");
		expect(button).not.toHaveAttribute("aria-describedby");
		await user.click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
