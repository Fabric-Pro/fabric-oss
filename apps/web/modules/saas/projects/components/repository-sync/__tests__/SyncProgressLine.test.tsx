import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SyncProgressLine } from "../SyncProgressLine";

describe("SyncProgressLine", () => {
	it("announces the phase and hides the visible count from assistive technology", () => {
		render(
			<SyncProgressLine
				phase="Copying files"
				text="Copying 3 of 8 files"
				done={3}
				total={8}
			/>,
		);

		expect(screen.getByText("Copying files")).toHaveClass("sr-only");
		expect(screen.getByText("Copying 3 of 8 files")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});

	it("draws a bar only when the total is known and the count adds up", () => {
		const { rerender } = render(
			<SyncProgressLine phase="p" text="t" done={1} total={4} />,
		);
		expect(screen.getByTestId("sync-progress-bar")).toBeInTheDocument();

		for (const props of [
			{},
			{ done: 1, total: null },
			{ done: null, total: 4 },
			{ done: 1, total: 0 },
			{ done: 5, total: 4 },
		]) {
			rerender(<SyncProgressLine phase="p" text="t" {...props} />);
			expect(screen.queryByTestId("sync-progress-bar")).toBeNull();
		}
	});

	it("shows no percentage anywhere", () => {
		const { container } = render(
			<SyncProgressLine phase="p" text="3 of 8" done={3} total={8} />,
		);

		expect(container.textContent).not.toContain("%");
	});

	it("can leave out its spinner for a caller that draws its own", () => {
		const { container } = render(
			<SyncProgressLine phase="p" text="t" showSpinner={false} />,
		);

		expect(container.querySelector("svg")).toBeNull();
	});
});
