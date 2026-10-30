import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Pagination } from "../Pagination";

afterEach(cleanup);
function show(currentPage: number, pages = 24) {
	const onChangeCurrentPage = vi.fn();
	render(
		<Pagination
			currentPage={currentPage}
			totalItems={pages * 10}
			itemsPerPage={10}
			onChangeCurrentPage={onChangeCurrentPage}
		/>,
	);
	return onChangeCurrentPage;
}
it.each([
	[1, 24, [1, 2, 24], 1],
	[5, 24, [1, 4, 5, 6, 24], 2],
	[24, 24, [1, 23, 24], 1],
	[2, 4, [1, 2, 3, 4], 0],
	[3, 5, [1, 2, 3, 4, 5], 0],
	[4, 7, [1, 2, 3, 4, 5, 6, 7], 0],
] as const)(
	"page %i of %i has the expected window and gaps",
	(current, pages, expected, gaps) => {
		show(current, pages);
		expect(
			screen
				.getAllByRole("button", { name: /^Page \d+$/ })
				.map((button) => Number(button.textContent)),
		).toEqual(expected);
		expect(screen.queryAllByText("…")).toHaveLength(gaps);
		for (const gap of screen.queryAllByText("…")) {
			expect(gap).toHaveAttribute("aria-hidden", "true");
		}
		expect(
			screen.getByRole("navigation", { name: "Pagination" }),
		).toBeInTheDocument();
	},
);
it("marks the current page, keeps the range, and selects a numbered page", () => {
	const onChange = show(5);
	expect(screen.getByRole("button", { name: "Page 5" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	expect(
		screen
			.getAllByRole("button")
			.filter((button) => button.getAttribute("aria-current") === "page"),
	).toHaveLength(1);
	expect(screen.getByText("41 - 50 of 240")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Page 6" }));
	expect(onChange).toHaveBeenCalledExactlyOnceWith(6);
});
it.each([0, 1])("shows no numbered buttons for %i pages", (pages) => {
	show(1, pages);
	expect(
		screen.queryByRole("button", { name: /^Page \d+$/ }),
	).not.toBeInTheDocument();
	expect(screen.getAllByRole("button")).toHaveLength(2);
});
it("clamps an out-of-range page in numbered mode", () => {
	show(999);
	expect(screen.getByRole("button", { name: "Page 24" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
	expect(screen.getByText("231 - 240 of 240")).toBeInTheDocument();
});

it("allows distinct navigation labels for multiple pagers", () => {
	render(
		<>
			<Pagination
				currentPage={1}
				totalItems={30}
				itemsPerPage={10}
				onChangeCurrentPage={vi.fn()}
				{...{ navigationLabel: "Active subscribers pagination" }}
			/>
			<Pagination
				currentPage={1}
				totalItems={30}
				itemsPerPage={10}
				onChangeCurrentPage={vi.fn()}
				{...{ navigationLabel: "Unsubscribed subscribers pagination" }}
			/>
		</>,
	);
	expect(
		screen.getByRole("navigation", {
			name: "Active subscribers pagination",
		}),
	).toBeInTheDocument();
	expect(
		screen.getByRole("navigation", {
			name: "Unsubscribed subscribers pagination",
		}),
	).toBeInTheDocument();
});

it("submits a typed page on Enter", async () => {
	const user = userEvent.setup();
	const onChange = show(5);
	const input = screen.getByRole("spinbutton", {
		name: "Go to page, Pagination",
	});
	expect(input).toHaveAttribute("min", "1");
	expect(input).toHaveAttribute("max", "24");
	await user.type(input, "12{Enter}");
	expect(onChange).toHaveBeenCalledExactlyOnceWith(12);
});
it.each(["0", "25", "1.5"])(
	"rejects invalid page %s accessibly",
	async (value) => {
		const user = userEvent.setup();
		const onChange = show(5);
		const input = screen.getByRole("spinbutton", {
			name: "Go to page, Pagination",
		});
		await user.type(input, value);
		await user.click(
			screen.getByRole("button", { name: "Go, Pagination" }),
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(input).toHaveAccessibleDescription("Enter a page from 1 to 24");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Enter a page from 1 to 24",
		);
	},
);
it("does nothing for an empty page", async () => {
	const user = userEvent.setup();
	const onChange = show(5);
	await user.click(screen.getByRole("button", { name: "Go, Pagination" }));
	expect(onChange).not.toHaveBeenCalled();
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("clears the input and validation when the current page changes externally", async () => {
	const user = userEvent.setup();
	const props = {
		totalItems: 240,
		itemsPerPage: 10,
		onChangeCurrentPage: vi.fn(),
	};
	const { rerender } = render(<Pagination {...props} currentPage={1} />);
	const input = screen.getByRole("spinbutton", {
		name: "Go to page, Pagination",
	});
	await user.type(input, "25{Enter}");
	expect(input).toHaveAttribute("aria-invalid", "true");
	rerender(<Pagination {...props} currentPage={2} />);
	expect(input).toHaveValue(null);
	expect(input).not.toHaveAttribute("aria-invalid", "true");
});
it.each([0, 1])("hides go-to-page for %i pages", (pages) => {
	show(1, pages);
	expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: /^Go,/ }),
	).not.toBeInTheDocument();
});
it("gives simultaneous pager inputs distinct labels and ids", () => {
	render(
		<>
			<Pagination
				currentPage={1}
				totalItems={240}
				itemsPerPage={10}
				onChangeCurrentPage={vi.fn()}
				navigationLabel="Active incidents pagination"
			/>
			<Pagination
				currentPage={1}
				totalItems={240}
				itemsPerPage={10}
				onChangeCurrentPage={vi.fn()}
				navigationLabel="Incident timeline pagination"
			/>
		</>,
	);
	const active = screen.getByRole("spinbutton", {
		name: "Go to page, Active incidents pagination",
	});
	const timeline = screen.getByRole("spinbutton", {
		name: "Go to page, Incident timeline pagination",
	});
	expect(active.id).not.toBe(timeline.id);
	expect(active.id).not.toBe("");
	expect(timeline.id).not.toBe("");
});

it("reports browser badInput even when the number input value is empty", async () => {
	const user = userEvent.setup();
	const onChange = show(5);
	const input = screen.getByRole("spinbutton", {
		name: "Go to page, Pagination",
	});
	Object.defineProperty(input, "validity", {
		configurable: true,
		value: { badInput: true },
	});
	expect(input).toHaveValue(null);
	await user.click(screen.getByRole("button", { name: "Go, Pagination" }));
	expect(onChange).not.toHaveBeenCalled();
	expect(input).toHaveAttribute("aria-invalid", "true");
	expect(input).toHaveAccessibleDescription("Enter a page from 1 to 24");
	expect(screen.getByRole("alert")).toBeInTheDocument();
});

it.each([5, 30])("supports translated ranges for %i items", (totalItems) => {
	render(
		<Pagination
			currentPage={1}
			totalItems={totalItems}
			itemsPerPage={10}
			onChangeCurrentPage={vi.fn()}
			formatRange={(from, to, total) => `${from}–${to} / ${total}`}
			pageLabel={(page) => `Seite ${page}`}
		/>,
	);
	expect(
		screen.getByText(`1–${Math.min(10, totalItems)} / ${totalItems}`),
	).toBeInTheDocument();
	if (totalItems > 10) {
		expect(
			screen.getByRole("button", { name: "Seite 2" }),
		).toBeInTheDocument();
	}
});
