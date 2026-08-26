import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	ExpandButton,
	ExpandedContentDialog,
	PanelExpandButton,
	panelWidthClass,
} from "../ExpandedContentDialog";

describe("ExpandButton", () => {
	it("renders an icon button with the given accessible name", () => {
		const onClick = vi.fn();
		render(<ExpandButton label="Expand summary" onClick={onClick} />);
		fireEvent.click(screen.getByRole("button", { name: "Expand summary" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("ExpandedContentDialog", () => {
	it("renders nothing when closed", () => {
		render(
			<ExpandedContentDialog
				open={false}
				onOpenChange={() => {}}
				title="Summary — Sprint Review"
			>
				<p>Body text</p>
			</ExpandedContentDialog>,
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("shows title and children when open, and closes via the close button", () => {
		const onOpenChange = vi.fn();
		render(
			<ExpandedContentDialog
				open={true}
				onOpenChange={onOpenChange}
				title="Summary — Sprint Review"
			>
				<p>Body text</p>
			</ExpandedContentDialog>,
		);
		const dialog = screen.getByRole("dialog", {
			name: "Summary — Sprint Review",
		});
		expect(dialog).toBeInTheDocument();
		expect(screen.getByText("Body text")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("closes on Escape", () => {
		const onOpenChange = vi.fn();
		render(
			<ExpandedContentDialog
				open={true}
				onOpenChange={onOpenChange}
				title="Transcript"
			>
				<p>Body text</p>
			</ExpandedContentDialog>,
		);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

describe("panelWidthClass (#2108 follow-up)", () => {
	// The 384px bug: `w-*` and `max-w-*` are different tailwind-merge groups,
	// so a bare `w-[480px]` never displaces the sheet variant's `sm:max-w-sm`.
	// Both branches must emit a `sm:max-w-*` or the panel silently shrinks.
	it("emits a sm:max-w override in both states", () => {
		expect(panelWidthClass(false)).toContain("sm:max-w-[480px]");
		expect(panelWidthClass(true)).toContain(
			"sm:max-w-[clamp(480px,65vw,1000px)]",
		);
	});

	it("is full width below the sm breakpoint in both states", () => {
		expect(panelWidthClass(false)).toContain("w-full");
		expect(panelWidthClass(true)).toContain("w-full");
	});

	it("sets a matching sm width alongside each max width", () => {
		expect(panelWidthClass(false)).toContain("sm:w-[480px]");
		expect(panelWidthClass(true)).toContain(
			"sm:w-[clamp(480px,65vw,1000px)]",
		);
	});
});

describe("PanelExpandButton (#2108 follow-up)", () => {
	it("labels itself Expand panel and reports aria-expanded=false when collapsed", () => {
		render(<PanelExpandButton expanded={false} onToggle={() => {}} />);
		const button = screen.getByRole("button", { name: "Expand panel" });
		expect(button).toHaveAttribute("aria-expanded", "false");
	});

	it("labels itself Collapse panel and reports aria-expanded=true when expanded", () => {
		render(<PanelExpandButton expanded={true} onToggle={() => {}} />);
		const button = screen.getByRole("button", { name: "Collapse panel" });
		expect(button).toHaveAttribute("aria-expanded", "true");
	});

	it("calls onToggle when clicked", () => {
		const onToggle = vi.fn();
		render(<PanelExpandButton expanded={false} onToggle={onToggle} />);
		fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
		expect(onToggle).toHaveBeenCalledTimes(1);
	});
});
