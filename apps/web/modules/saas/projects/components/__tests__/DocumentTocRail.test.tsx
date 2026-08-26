import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DOCUMENT_TOC_STORAGE_KEY,
	type DocumentTocItem,
} from "../../lib/document-toc";
import { DocumentTocRail } from "../DocumentTocRail";

// The rail's job is to turn a navigation result into live-region copy, so the
// hook is stubbed and the assertions are about what gets announced.
// next-intl is globally mocked (t echoes the key), so the interpolated
// announcement surfaces as its key.

const { navigateToHeading, tocItems } = vi.hoisted(() => ({
	navigateToHeading: vi.fn(),
	tocItems: {
		current: [] as DocumentTocItem[],
	},
}));

vi.mock("../../hooks/use-document-toc", () => ({
	useDocumentToc: () => ({
		items: tocItems.current,
		navigateToHeading,
	}),
}));

const items: DocumentTocItem[] = [
	{ id: "overview", text: "Overview", level: 1, pos: 0 },
];

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	tocItems.current = items;
	navigateToHeading.mockReset();
	localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");
});

afterEach(() => {
	vi.useRealTimers();
	localStorage.clear();
});

describe("DocumentTocRail", () => {
	it("announces the section it jumped to", () => {
		navigateToHeading.mockReturnValue(true);
		const onAnnounce = vi.fn();
		render(<DocumentTocRail editor={null} onAnnounce={onAnnounce} />);

		fireEvent.click(screen.getByText("Overview", { selector: "button" }));

		expect(navigateToHeading).toHaveBeenCalledWith(items[0]);
		expect(onAnnounce).toHaveBeenCalledWith("announcementJumped");
	});

	it("tells the reader when the heading is gone instead of failing silently", () => {
		navigateToHeading.mockReturnValue(false);
		const onAnnounce = vi.fn();
		render(<DocumentTocRail editor={null} onAnnounce={onAnnounce} />);

		fireEvent.click(screen.getByText("Overview", { selector: "button" }));

		expect(onAnnounce).toHaveBeenCalledWith("announcementMissing");
	});

	it("clears the live region after the announcement window", () => {
		navigateToHeading.mockReturnValue(true);
		const onAnnounce = vi.fn();
		render(<DocumentTocRail editor={null} onAnnounce={onAnnounce} />);

		fireEvent.click(screen.getByText("Overview", { selector: "button" }));
		onAnnounce.mockClear();
		vi.advanceTimersByTime(3000);

		expect(onAnnounce).toHaveBeenCalledWith("");
	});

	it("does not clear the live region after unmount", () => {
		navigateToHeading.mockReturnValue(true);
		const onAnnounce = vi.fn();
		const { unmount } = render(
			<DocumentTocRail editor={null} onAnnounce={onAnnounce} />,
		);

		fireEvent.click(screen.getByText("Overview", { selector: "button" }));
		unmount();
		onAnnounce.mockClear();
		vi.advanceTimersByTime(3000);

		expect(onAnnounce).not.toHaveBeenCalled();
	});

	it("renders nothing when the document has no headings", () => {
		tocItems.current = [];
		const { container } = render(
			<DocumentTocRail editor={null} onAnnounce={vi.fn()} />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("shows no rail without headings, keeping only the hidden live region", () => {
		tocItems.current = [];
		render(<DocumentTocRail editor={null} />);

		// No panel, no edge handle, no empty state...
		expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		// ...but the region survives, so deleting the last heading can still
		// announce that the section is gone.
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("does not render its own live region when the host provides one", () => {
		render(<DocumentTocRail editor={null} onAnnounce={vi.fn()} />);

		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("announces through its own polite region when no host region is wired", () => {
		navigateToHeading.mockReturnValue(true);
		render(<DocumentTocRail editor={null} />);

		const region = screen.getByRole("status");
		expect(region).toBeEmptyDOMElement();
		expect(region).toHaveAttribute("aria-live", "polite");
		expect(region).toHaveClass("sr-only");

		fireEvent.click(screen.getByText("Overview", { selector: "button" }));
		expect(region).toHaveTextContent("announcementJumped");

		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(region).toBeEmptyDOMElement();
	});

	it("still announces a vanished heading when it was the last one", () => {
		// The region must outlive the panel: the recompute that empties the
		// list lands right after the click that found nothing to jump to.
		navigateToHeading.mockReturnValue(false);
		const { rerender } = render(<DocumentTocRail editor={null} />);

		fireEvent.click(screen.getByText("Overview", { selector: "button" }));
		tocItems.current = [];
		rerender(<DocumentTocRail editor={null} />);

		expect(screen.getByRole("status")).toHaveTextContent(
			"announcementMissing",
		);
	});

	it("passes the host's breakpoint through to the panel", () => {
		const { container } = render(
			<DocumentTocRail editor={null} breakpoint="xl" />,
		);

		const rail = container.querySelector("div");
		expect(rail?.className).toContain("xl:flex");
		expect(rail?.className).not.toContain("lg:flex");
	});
});
