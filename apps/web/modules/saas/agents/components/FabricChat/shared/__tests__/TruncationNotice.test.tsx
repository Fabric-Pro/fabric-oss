import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TruncationNotice } from "../TruncationNotice";

describe("TruncationNotice (review F25)", () => {
	it("says the answer was cut at the length limit, and continues on click", () => {
		const onContinue = vi.fn();
		render(
			<TruncationNotice
				truncated="output_limit"
				onContinue={onContinue}
			/>,
		);

		expect(
			screen.getByText(
				"This answer was cut off at the length limit — ask me to continue.",
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(onContinue).toHaveBeenCalledWith(
			"Continue from where you stopped.",
		);
	});

	it("says the turn ran out of steps", () => {
		render(
			<TruncationNotice truncated="step_limit" onContinue={vi.fn()} />,
		);
		expect(
			screen.getByText(
				"I ran out of steps — ask me to continue or narrow the question.",
			),
		).toBeTruthy();
	});

	it("offers no Continue on an older turn", () => {
		render(<TruncationNotice truncated="step_limit" />);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("disables Continue while a turn is running", () => {
		render(
			<TruncationNotice
				truncated="output_limit"
				onContinue={vi.fn()}
				disabled
			/>,
		);
		expect(
			(
				screen.getByRole("button", {
					name: "Continue",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});
});
