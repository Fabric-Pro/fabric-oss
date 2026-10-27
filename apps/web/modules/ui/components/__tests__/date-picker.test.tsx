import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DatePicker } from "../date-picker";

vi.mock("next-intl", () => ({
	useLocale: () => {
		throw new Error("DatePicker must work without an intl provider");
	},
}));
it("works without intl context and includes the visible date in its name", () => {
	render(
		<DatePicker value={new Date(2026, 0, 15)} aria-label="Created from" />,
	);
	const button = screen.getByRole("button", {
		name: "Created from: January 15th, 2026",
	});
	expect(button).toHaveTextContent("January 15th, 2026");
});
it("includes its placeholder in the accessible name", () => {
	render(<DatePicker placeholder="From" aria-label="Created from" />);
	expect(
		screen.getByRole("button", { name: "Created from: From" }),
	).toHaveTextContent("From");
});

it("keeps single-date month arrows inside the calendar and navigates both ways", async () => {
	render(
		<DatePicker value={new Date(2026, 9, 1)} aria-label="Created from" />,
	);
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /^Created from/ }));
	const previous = screen.getByRole("button", { name: /previous month/i });
	const next = screen.getByRole("button", { name: /next month/i });
	expect(next.closest(".relative")).toHaveClass("p-3");
	expect(next.closest(".relative")).toContainElement(
		screen.getByRole("grid"),
	);
	expect(next.parentElement).toHaveClass("inset-x-3", "top-3");
	await user.click(next);
	expect(screen.getByRole("dialog")).toHaveTextContent("November 2026");
	await user.click(previous);
	expect(screen.getByRole("dialog")).toHaveTextContent("October 2026");
});
