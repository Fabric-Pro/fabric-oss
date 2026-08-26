import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LazyDaysSentinel } from "../LazyDaysSentinel";

describe("LazyDaysSentinel (#2106 FR2)", () => {
	it("does not load anything until asked", () => {
		const onLoad = vi.fn();
		render(
			<LazyDaysSentinel
				onLoad={onLoad}
				isLoading={false}
				isError={false}
			/>,
		);

		expect(onLoad).not.toHaveBeenCalled();
	});

	// jsdom ships no IntersectionObserver, so the button IS the trigger here —
	// which is the point: a scroll-only trigger is unreachable by keyboard.
	it("loads when the button is activated", () => {
		const onLoad = vi.fn();
		render(
			<LazyDaysSentinel
				onLoad={onLoad}
				isLoading={false}
				isError={false}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /more days/i }));

		expect(onLoad).toHaveBeenCalledTimes(1);
	});

	it("does not fire twice for a double activation", () => {
		const onLoad = vi.fn();
		render(
			<LazyDaysSentinel
				onLoad={onLoad}
				isLoading={false}
				isError={false}
			/>,
		);

		const button = screen.getByRole("button", { name: /more days/i });
		fireEvent.click(button);
		fireEvent.click(button);

		expect(onLoad).toHaveBeenCalledTimes(1);
	});

	it("shows progress instead of the trigger while loading", () => {
		render(<LazyDaysSentinel onLoad={vi.fn()} isLoading isError={false} />);

		expect(screen.getByText(/loading more days/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /more days/i }),
		).not.toBeInTheDocument();
	});

	it("offers a retry after a failure, and the retry is not blocked by the once-only guard", () => {
		const onLoad = vi.fn();
		render(<LazyDaysSentinel onLoad={onLoad} isLoading={false} isError />);

		expect(
			screen.getByText(/couldn't load the rest of your calendar/i),
		).toBeInTheDocument();

		const retry = screen.getByRole("button", { name: /retry/i });
		fireEvent.click(retry);
		fireEvent.click(retry);

		expect(onLoad).toHaveBeenCalledTimes(2);
	});
});
