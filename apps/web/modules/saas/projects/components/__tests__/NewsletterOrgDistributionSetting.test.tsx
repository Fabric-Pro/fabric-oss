/**
 * Turning this on mails everyone in the organization at the next send, and
 * turning it off removes the people it added, so both ask first (Fizzy #1986,
 * FR8, FR14, FR17).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewsletterOrgDistributionSetting } from "../NewsletterOrgDistributionSetting";

const onChange = vi.fn();

function setup(props: {
	checked: boolean;
	syncError?: string | null;
	disabled?: boolean;
}) {
	render(
		<NewsletterOrgDistributionSetting
			checked={props.checked}
			disabled={props.disabled ?? false}
			syncError={props.syncError ?? null}
			onChange={onChange}
		/>,
	);
	return screen.getByRole("switch", { name: "Send to entire organization" });
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("NewsletterOrgDistributionSetting", () => {
	it("asks before turning on, and does nothing until confirmed", () => {
		fireEvent.click(setup({ checked: false }));

		expect(screen.getByRole("alertdialog").textContent).toContain(
			"everyone in this organization",
		);
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Turn on" }));

		expect(onChange).toHaveBeenCalledWith(true);
	});

	it("asks before turning off, and says who is removed", () => {
		fireEvent.click(setup({ checked: true }));

		expect(screen.getByRole("alertdialog").textContent).toContain(
			"removes everyone it added",
		);

		fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

		expect(onChange).toHaveBeenCalledWith(false);
	});

	it("changes nothing when the confirmation is cancelled", () => {
		fireEvent.click(setup({ checked: false }));

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("shows a failed sync so the list is not trusted blindly", () => {
		setup({ checked: true, syncError: "database unavailable" });

		expect(screen.getByRole("alert").textContent).toContain(
			"database unavailable",
		);
	});

	it("has nothing to warn about after a good sync", () => {
		setup({ checked: true });

		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("respects a read-only viewer", () => {
		const toggle = setup({ checked: false, disabled: true });

		expect((toggle as HTMLButtonElement).disabled).toBe(true);
	});
});
