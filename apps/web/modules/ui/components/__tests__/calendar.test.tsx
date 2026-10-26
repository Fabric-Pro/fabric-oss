import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Calendar } from "../calendar";

it.each([1, 2])(
	"keeps navigation in the caption area for %s month(s)",
	async (numberOfMonths) => {
		render(
			<Calendar
				mode="single"
				defaultMonth={new Date(2026, 9, 1)}
				numberOfMonths={numberOfMonths}
				data-testid="calendar"
			/>,
		);
		const calendar = screen.getByTestId("calendar");
		expect(calendar).toHaveClass("relative");
		const next = screen.getByRole("button", { name: /next month/i });
		const previous = screen.getByRole("button", {
			name: /previous month/i,
		});
		expect(next.parentElement).toHaveClass(
			"absolute",
			"inset-x-3",
			"top-3",
		);
		expect(next).not.toHaveClass("absolute");
		expect(previous).not.toHaveClass("absolute");
		const user = userEvent.setup();
		await user.click(next);
		expect(calendar).toHaveTextContent("November 2026");
		await user.click(previous);
		expect(calendar).toHaveTextContent("October 2026");
		expect(screen.getAllByRole("grid")).toHaveLength(numberOfMonths);
	},
);
