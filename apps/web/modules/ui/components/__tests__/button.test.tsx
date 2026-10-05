import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../button";

describe("Button async loading", () => {
	it("re-enables after an async click settles under Strict Mode, including repeated clicks", async () => {
		const user = userEvent.setup();
		let resolveClick!: () => void;
		const onClick = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveClick = resolve;
				}),
		);
		render(
			<StrictMode>
				<Button onClick={onClick}>Test Connection</Button>
			</StrictMode>,
		);
		const button = screen.getByRole("button", { name: "Test Connection" });

		for (let attempt = 1; attempt <= 2; attempt++) {
			await user.click(button);
			expect(onClick).toHaveBeenCalledTimes(attempt);
			expect(button).toBeDisabled();
			expect(button.querySelector(".animate-spin")).not.toBeNull();
			await user.click(button);
			expect(onClick).toHaveBeenCalledTimes(attempt);
			await act(async () => resolveClick());
			expect(button).toBeEnabled();
			expect(button.querySelector(".animate-spin")).toBeNull();
		}
	});
});
