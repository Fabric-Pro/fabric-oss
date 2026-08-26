import { useIsOverflowing } from "@shared/hooks/use-is-overflowing";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { TruncatedText } from "../TruncatedText";

// jsdom doesn't lay out text, so `scrollWidth`/`clientWidth` are always 0 and
// real overflow can never be detected. Mock the measurement hook so each test
// can assert the primitive's wiring against a known overflow state, per the
// component's only branch point.
vi.mock("@shared/hooks/use-is-overflowing", () => ({
	useIsOverflowing: vi.fn(() => [vi.fn(), false] as const),
}));

const mockedUseIsOverflowing = vi.mocked(useIsOverflowing);

function setOverflow(isOverflowing: boolean) {
	mockedUseIsOverflowing.mockReturnValue([vi.fn(), isOverflowing] as const);
}

function getTooltipContent(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

// Radix Tooltip internals use ResizeObserver + pointer capture; jsdom provides
// neither. Mirror the polyfills the other tooltip tests rely on.
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => {};
	}
});

beforeEach(() => {
	setOverflow(false);
	vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("TruncatedText", () => {
	it("renders the full text", () => {
		render(<TruncatedText text="Short label" />);

		expect(screen.getByText("Short label")).toBeInTheDocument();
	});

	it("shows no tooltip and is not a tab stop when the text fits", async () => {
		setOverflow(false);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(<TruncatedText text="Fits fine" />);

		const el = screen.getByText("Fits fine");
		expect(el).not.toHaveAttribute("tabindex");

		await user.hover(el);
		act(() => {
			vi.advanceTimersByTime(1000);
		});

		// open={false} keeps the tooltip hard-disabled — content never mounts.
		expect(getTooltipContent()).toBeNull();
	});

	it("reveals the full text in a tooltip on hover when the text overflows", async () => {
		setOverflow(true);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const longText =
			"https://dev.azure.com/contoso/Project/_git/very-long-repo-name/src/path";
		render(<TruncatedText text={longText} />);

		await user.hover(screen.getByText(longText));
		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getTooltipContent()).not.toBeNull();
		});
		expect(getTooltipContent()?.textContent).toContain(longText);
	});

	it("is keyboard-focusable only when the text overflows", () => {
		setOverflow(true);
		const overflowing = render(<TruncatedText text="Long value" />);
		expect(screen.getByText("Long value")).toHaveAttribute("tabindex", "0");
		overflowing.unmount();

		setOverflow(false);
		render(<TruncatedText text="Long value" />);
		expect(screen.getByText("Long value")).not.toHaveAttribute("tabindex");
	});

	it("exposes the full text as the accessible name in both overflow states", () => {
		setOverflow(false);
		const fits = render(<TruncatedText text="Full accessible value" />);
		expect(screen.getByText("Full accessible value")).toHaveAttribute(
			"aria-label",
			"Full accessible value",
		);
		fits.unmount();

		setOverflow(true);
		render(<TruncatedText text="Full accessible value" />);
		expect(screen.getByText("Full accessible value")).toHaveAttribute(
			"aria-label",
			"Full accessible value",
		);
	});

	it("renders the requested element tag and merges truncate with caller classes", () => {
		render(
			<TruncatedText
				as="h3"
				className="font-semibold text-sm"
				text="Heading title"
			/>,
		);

		const el = screen.getByText("Heading title");
		expect(el.tagName).toBe("H3");
		// `min-w-0` must always be present so `truncate` engages when the
		// element is a flex/grid child (otherwise a long unbroken string
		// expands the element instead of clipping).
		expect(el).toHaveClass(
			"min-w-0",
			"truncate",
			"font-semibold",
			"text-sm",
		);
	});

	it("shows rich children but uses text for the accessible name and tooltip", async () => {
		setOverflow(true);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const full = "Alice: are we still on for the 3pm sync?";
		render(
			<TruncatedText as="p" text={full}>
				<span className="font-medium">Alice:</span> are we still on for
				the 3pm sync?
			</TruncatedText>,
		);

		// The bold sender (rich child) is the visible content.
		expect(screen.getByText("Alice:")).toBeInTheDocument();

		// The accessible name is the full plain string, not the rich markup.
		const trigger = document.querySelector<HTMLElement>(
			`[aria-label="${full}"]`,
		);
		expect(trigger).not.toBeNull();
		expect(trigger?.tagName).toBe("P");

		// The tooltip reveals the full plain value on hover.
		await user.hover(trigger as HTMLElement);
		act(() => {
			vi.advanceTimersByTime(500);
		});
		await waitFor(() => {
			expect(getTooltipContent()).not.toBeNull();
		});
		expect(getTooltipContent()?.textContent).toContain(full);
	});
});
