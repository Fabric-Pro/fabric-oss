import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RevokeApiKeyButton } from "../RevokeApiKeyButton";

function renderButton(onConfirm = vi.fn(), disabled = false) {
	render(
		<RevokeApiKeyButton
			keyName="ci-runner"
			action="Delete"
			title='Delete API key "ci-runner"?'
			description="This cannot be undone."
			disabled={disabled}
			onConfirm={onConfirm}
		/>,
	);
	return onConfirm;
}

describe("RevokeApiKeyButton", () => {
	it("names the key it acts on for screen readers", () => {
		renderButton();

		expect(
			screen.getByRole("button", { name: "Delete ci-runner" }),
		).toBeTruthy();
	});

	it("asks in the app's dialog and revokes only after confirming", () => {
		const onConfirm = renderButton();

		fireEvent.click(
			screen.getByRole("button", { name: "Delete ci-runner" }),
		);
		const dialog = screen.getByRole("alertdialog");

		expect(dialog.textContent).toContain('Delete API key "ci-runner"?');
		expect(dialog.textContent).toContain("This cannot be undone.");
		expect(onConfirm).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("keeps the key when the dialog is cancelled", () => {
		const onConfirm = renderButton();

		fireEvent.click(
			screen.getByRole("button", { name: "Delete ci-runner" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onConfirm).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("cannot be opened while a revoke is in flight", () => {
		renderButton(vi.fn(), true);

		fireEvent.click(
			screen.getByRole("button", { name: "Delete ci-runner" }),
		);

		expect(screen.queryByRole("alertdialog")).toBeNull();
	});
});
