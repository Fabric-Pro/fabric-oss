import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DateRangePicker, type DateRangeValue } from "../date-range-picker";

const labels = {
	any: "Any",
	clear: "Clear",
	from: (date: string) => `from ${date}`,
	until: (date: string) => `until ${date}`,
	lastDays: (days: number) => `Last ${days} days`,
	thisMonth: "This month",
};
beforeEach(() => {
	vi.spyOn(window, "matchMedia").mockImplementation(
		(query) =>
			({
				matches: query === "(min-width: 768px)",
				media: query,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			}) as unknown as MediaQueryList,
	);
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 9, 20, 12));
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
function picker(value: DateRangeValue = {}) {
	const onChange = vi.fn();

	function Controlled() {
		const [range, setRange] = useState<DateRangeValue>(value);
		return (
			<DateRangePicker
				value={range}
				onChange={(next) => {
					onChange(next);
					setRange(next);
				}}
				label="Created"
				labels={labels}
			/>
		);
	}
	render(<Controlled />);
	return onChange;
}
async function open() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /^Created:/ }));
	return user;
}
function day(date: string) {
	return within(screen.getByRole("dialog")).getByRole("button", {
		name: new RegExp(date),
	});
}
it("commits the start immediately, then the end, and returns focus", async () => {
	const onChange = picker();
	const user = await open();
	await user.click(day("October 1st, 2026"));
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 1),
		to: undefined,
	});
	await user.click(day("October 15th, 2026"));
	expect(onChange).toHaveBeenCalledTimes(2);
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 1),
		to: new Date(2026, 9, 15),
	});
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Created: Oct 1 – Oct 15, 2026" }),
	).toHaveFocus();
});
it("starts a fresh range after a completed one, including a same-day range", async () => {
	const onChange = vi.fn();
	function Controlled() {
		const [value, setValue] = useState<DateRangeValue>({
			from: new Date(2026, 9, 1),
			to: new Date(2026, 9, 15),
		});
		return (
			<DateRangePicker
				value={value}
				onChange={(next) => {
					setValue(next);
					onChange(next);
				}}
				label="Created"
				labels={labels}
			/>
		);
	}
	render(<Controlled />);
	const user = await open();
	await user.click(day("October 5th, 2026"));
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 5),
		to: undefined,
	});
	await user.click(day("October 5th, 2026"));
	expect(onChange).toHaveBeenCalledTimes(2);
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 5),
		to: new Date(2026, 9, 5),
	});
});
it.each([
	[7, new Date(2026, 9, 14)],
	[30, new Date(2026, 8, 21)],
	[90, new Date(2026, 6, 23)],
] as const)(
	"applies an inclusive Last %s days preset immediately",
	async (days, from) => {
		const onChange = picker();
		const user = await open();
		await user.click(
			screen.getByRole("button", { name: `Last ${days} days` }),
		);
		expect(onChange).toHaveBeenCalledExactlyOnceWith({
			from,
			to: new Date(2026, 9, 20),
		});
	},
);
it("applies This month through today", async () => {
	const onChange = picker();
	const user = await open();
	await user.click(screen.getByRole("button", { name: "This month" }));
	expect(onChange).toHaveBeenCalledExactlyOnceWith({
		from: new Date(2026, 9, 1),
		to: new Date(2026, 9, 20),
	});
});
it("clears both ends", async () => {
	const onChange = picker({ from: "2026-10-01", to: "2026-10-15" });
	const user = await open();
	await user.click(screen.getByRole("button", { name: "Clear" }));
	expect(onChange).toHaveBeenCalledExactlyOnceWith({
		from: undefined,
		to: undefined,
	});
});
it.each([
	[{}, "Any"],
	[
		{ from: new Date(2026, 9, 1), to: new Date(2026, 9, 15) },
		"Oct 1 – Oct 15, 2026",
	],
	[{ from: new Date(2026, 9, 1) }, "from Oct 1, 2026"],
	[{ to: new Date(2026, 9, 15) }, "until Oct 15, 2026"],
	[{ from: "2026-10-01", to: "2026-10-15" }, "Oct 1 – Oct 15, 2026"],
] as const)(
	"uses visible text as its accessible name for %j",
	(value, text) => {
		picker(value);
		expect(
			screen.getByRole("button", { name: `Created: ${text}` }),
		).toHaveTextContent(`Created: ${text}`);
	},
);
it("uses one month on narrow screens", async () => {
	vi.spyOn(window, "matchMedia").mockReturnValue({
		matches: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	} as unknown as MediaQueryList);
	picker();
	await open();
	expect(screen.getAllByRole("grid")).toHaveLength(1);
});
it("uses two months otherwise", async () => {
	picker();
	await open();
	expect(screen.getAllByRole("grid")).toHaveLength(2);
});
it("supports grid selection and preserves an applied start on Escape", async () => {
	const onChange = picker();
	const user = await open();
	const first = day("October 1st, 2026");
	first.focus();
	await user.keyboard("{ArrowRight}{Enter}");
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 2),
		to: undefined,
	});
	await user.keyboard("{ArrowRight}{Enter}");
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 2),
		to: new Date(2026, 9, 3),
	});
	await open();
	await user.click(day("October 10th, 2026"));
	await user.keyboard("{Escape}");
	expect(onChange).toHaveBeenCalledTimes(3);
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 10),
		to: undefined,
	});
	expect(
		screen.getByRole("button", { name: "Created: from Oct 10, 2026" }),
	).toHaveFocus();
});
it("accepts custom presets and disables the trigger", async () => {
	const onChange = vi.fn();
	const { rerender } = render(
		<DateRangePicker
			value={{}}
			onChange={onChange}
			label="Created"
			labels={labels}
			presets={[
				{
					label: "Release window",
					getRange: () => ({ from: "2026-10-02", to: "2026-10-04" }),
				},
			]}
		/>,
	);
	const user = await open();
	await user.click(screen.getByRole("button", { name: "Release window" }));
	expect(onChange).toHaveBeenCalledExactlyOnceWith({
		from: new Date(2026, 9, 2),
		to: new Date(2026, 9, 4),
	});
	rerender(
		<DateRangePicker
			value={{}}
			onChange={onChange}
			label="Created"
			labels={labels}
			disabled
		/>,
	);
	expect(screen.getByRole("button", { name: "Created: Any" })).toBeDisabled();
});

it("applies a start-only range on the first click without closing", async () => {
	const onChange = picker();
	const user = await open();
	await user.click(day("October 5th, 2026"));
	expect(onChange).toHaveBeenCalledExactlyOnceWith({
		from: new Date(2026, 9, 5),
		to: undefined,
	});
	expect(screen.getByRole("dialog")).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Created: from Oct 5, 2026" }),
	).toBeInTheDocument();
});
it("treats an earlier second click as the new start, then completes from that date", async () => {
	const onChange = picker();
	const user = await open();
	await user.click(day("October 10th, 2026"));
	await user.click(day("October 5th, 2026"));
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 5),
		to: undefined,
	});
	expect(screen.getByRole("dialog")).toBeInTheDocument();
	await user.click(day("October 8th, 2026"));
	expect(onChange).toHaveBeenCalledTimes(3);
	expect(onChange).toHaveBeenLastCalledWith({
		from: new Date(2026, 9, 5),
		to: new Date(2026, 9, 8),
	});
});

it("portals the dialog outside its rendering container and focuses without scrolling", async () => {
	const { container } = render(
		<DateRangePicker
			value={{}}
			onChange={vi.fn()}
			label="Created"
			labels={labels}
		/>,
	);
	const focus = vi.spyOn(HTMLElement.prototype, "focus");
	await open();
	const dialog = screen.getByRole("dialog");
	expect(document.body).toContainElement(dialog);
	expect(container).not.toContainElement(dialog);
	const calls = focus.mock.calls.filter((_, index) =>
		dialog.contains(focus.mock.instances[index]),
	);
	expect(calls.length).toBeGreaterThan(0);
	expect(calls.every(([options]) => options?.preventScroll === true)).toBe(
		true,
	);
});

it("suppresses the native trigger tooltip while the range popover is open", async () => {
	picker();
	const trigger = screen.getByRole("button", { name: "Created: Any" });
	expect(trigger).toHaveAttribute("title", "Created: Any");
	const user = await open();
	expect(trigger).not.toHaveAttribute("title");
	await user.tab();
	expect(screen.getByRole("dialog")).toContainElement(
		document.activeElement as HTMLElement,
	);
	expect(trigger).not.toHaveAttribute("title");
	await user.keyboard("{Escape}");
	expect(trigger).toHaveAttribute("title", "Created: Any");
});
