import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsMenu, type SettingsMenuSection } from "../SettingsMenu";

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/example-org/settings/general",
}));

const menuItems: SettingsMenuSection[] = [
	{
		title: "Organization",
		items: [
			{ title: "General", href: "/app/example-org/settings/general" },
			{ title: "Members", href: "/app/example-org/settings/members" },
			{
				title: "AI providers",
				href: "/app/example-org/settings/ai-providers",
			},
		],
	},
];

function setScrollMetrics(
	el: HTMLElement,
	{
		scrollHeight,
		clientHeight,
		scrollTop,
	}: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
	Object.defineProperty(el, "scrollHeight", {
		configurable: true,
		value: scrollHeight,
	});
	Object.defineProperty(el, "clientHeight", {
		configurable: true,
		value: clientHeight,
	});
	Object.defineProperty(el, "scrollTop", {
		configurable: true,
		writable: true,
		value: scrollTop,
	});
	act(() => {
		fireEvent.scroll(el);
	});
}

const scrollLabel = "Scroll to more settings";

describe("SettingsMenu scroll hint", () => {
	it("shows a labelled button when the nav overflows", () => {
		render(<SettingsMenu menuItems={menuItems} />);
		const scroller = screen.getByTestId("settings-nav-scroll");

		setScrollMetrics(scroller, {
			scrollHeight: 900,
			clientHeight: 400,
			scrollTop: 0,
		});

		const button = screen.getByRole("button", { name: scrollLabel });
		expect(button).toHaveAttribute("type", "button");
	});

	// A link reached with Tab scrolls into view clear of the fade and button.
	it("keeps room at the bottom for a keyboard-focused last link", () => {
		render(<SettingsMenu menuItems={menuItems} />);
		expect(screen.getByTestId("settings-nav-scroll")).toHaveClass(
			"scroll-pb-14",
		);
	});

	it("hides when the nav does not overflow", () => {
		render(<SettingsMenu menuItems={menuItems} />);
		const scroller = screen.getByTestId("settings-nav-scroll");

		setScrollMetrics(scroller, {
			scrollHeight: 400,
			clientHeight: 400,
			scrollTop: 0,
		});

		expect(
			screen.queryByRole("button", { name: scrollLabel }),
		).not.toBeInTheDocument();
	});

	it("hides once the nav is scrolled to the bottom", () => {
		render(<SettingsMenu menuItems={menuItems} />);
		const scroller = screen.getByTestId("settings-nav-scroll");

		setScrollMetrics(scroller, {
			scrollHeight: 900,
			clientHeight: 400,
			scrollTop: 0,
		});
		expect(
			screen.getByRole("button", { name: scrollLabel }),
		).toBeInTheDocument();

		setScrollMetrics(scroller, {
			scrollHeight: 900,
			clientHeight: 400,
			scrollTop: 500,
		});
		expect(
			screen.queryByRole("button", { name: scrollLabel }),
		).not.toBeInTheDocument();
	});

	it("scrolls the nav down when clicked", () => {
		render(<SettingsMenu menuItems={menuItems} />);
		const scroller = screen.getByTestId("settings-nav-scroll");
		const scrollBy = vi.fn();
		scroller.scrollBy = scrollBy;

		setScrollMetrics(scroller, {
			scrollHeight: 900,
			clientHeight: 400,
			scrollTop: 0,
		});
		fireEvent.click(screen.getByRole("button", { name: scrollLabel }));

		expect(scrollBy).toHaveBeenCalledWith({
			top: 300,
			behavior: "smooth",
		});
	});

	it("scrolls without animation when reduced motion is preferred", () => {
		const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
			(query: string) =>
				({
					matches: query === "(prefers-reduced-motion: reduce)",
					media: query,
				}) as MediaQueryList,
		);
		render(<SettingsMenu menuItems={menuItems} />);
		const scroller = screen.getByTestId("settings-nav-scroll");
		const scrollBy = vi.fn();
		scroller.scrollBy = scrollBy;

		setScrollMetrics(scroller, {
			scrollHeight: 900,
			clientHeight: 400,
			scrollTop: 0,
		});
		fireEvent.click(screen.getByRole("button", { name: scrollLabel }));

		expect(scrollBy).toHaveBeenCalledWith({ top: 300, behavior: "auto" });
		matchMedia.mockRestore();
	});
});
