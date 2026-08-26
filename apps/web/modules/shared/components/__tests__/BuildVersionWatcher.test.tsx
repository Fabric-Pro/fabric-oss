import {
	BACKSTOP_COUNTDOWN_SECONDS,
	STALE_BANNER_AFTER_MS,
} from "@shared/lib/app-version";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildVersionMock = vi.fn();
vi.mock("@shared/hooks/use-build-version", () => ({
	useBuildVersion: () => buildVersionMock(),
}));

const pathnameMock = vi.fn();
vi.mock("next/navigation", () => ({
	usePathname: () => pathnameMock(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${key} ${JSON.stringify(vars)}` : key,
}));

import { BuildVersionWatcher } from "../BuildVersionWatcher";

const reload = vi.fn();
const assign = vi.fn();
let originalLocation: Location;

function stale() {
	return { isStale: true, checkNow: vi.fn().mockResolvedValue(null) };
}

beforeEach(() => {
	originalLocation = window.location;
	Object.defineProperty(window, "location", {
		configurable: true,
		value: {
			href: "http://localhost/app/foo",
			origin: "http://localhost",
			pathname: "/app/foo",
			search: "",
			reload,
			assign,
		},
	});
	pathnameMock.mockReturnValue("/app/foo");
	buildVersionMock.mockReturnValue({
		isStale: false,
		checkNow: vi.fn().mockResolvedValue(null),
	});
});

afterEach(() => {
	Object.defineProperty(window, "location", {
		configurable: true,
		value: originalLocation,
	});
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("BuildVersionWatcher", () => {
	it("renders nothing when the build is fresh", () => {
		const { container } = render(<BuildVersionWatcher />);
		expect(container.firstChild).toBeNull();
	});

	it("renders no banner for a stale build before the backstop delay (silent, seamless)", () => {
		buildVersionMock.mockReturnValue(stale());
		const { container } = render(<BuildVersionWatcher />);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("turns an internal link click into a full navigation on a stale build", () => {
		buildVersionMock.mockReturnValue(stale());
		render(<BuildVersionWatcher />);

		const link = document.createElement("a");
		link.setAttribute("href", "/app/bar");
		document.body.appendChild(link);
		link.dispatchEvent(
			new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				button: 0,
			}),
		);

		expect(assign).toHaveBeenCalledWith("http://localhost/app/bar");
		document.body.removeChild(link);
	});

	it("leaves same-page (query/hash) clicks to the SPA", () => {
		buildVersionMock.mockReturnValue(stale());
		render(<BuildVersionWatcher />);

		const link = document.createElement("a");
		link.setAttribute("href", "/app/foo?tab=2");
		// The SPA itself preventDefaults same-page clicks; mirror that so jsdom
		// doesn't attempt a real (unimplemented) navigation.
		link.addEventListener("click", (event) => event.preventDefault());
		document.body.appendChild(link);
		link.dispatchEvent(
			new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				button: 0,
			}),
		);

		expect(assign).not.toHaveBeenCalled();
		document.body.removeChild(link);
	});

	it("after a long stale period with no seam, shows a countdown banner then refreshes", () => {
		vi.useFakeTimers();
		buildVersionMock.mockReturnValue(stale());
		render(<BuildVersionWatcher />);

		// Silent until the backstop delay elapses.
		expect(screen.queryByText("appUpdate.banner.title")).toBeNull();
		act(() => {
			vi.advanceTimersByTime(STALE_BANNER_AFTER_MS + 100);
		});
		expect(screen.getByText("appUpdate.banner.title")).toBeInTheDocument();

		// Countdown then auto-refresh.
		for (let i = 0; i < BACKSTOP_COUNTDOWN_SECONDS + 1; i++) {
			act(() => {
				vi.advanceTimersByTime(1000);
			});
		}
		expect(reload).toHaveBeenCalled();
	});

	it("renders the backstop banner in flow rather than as a fixed overlay", () => {
		// jsdom computes no CSS, so class tokens are the only anchor a unit
		// test has for a layout contract.
		vi.useFakeTimers();
		buildVersionMock.mockReturnValue(stale());
		const { container } = render(<BuildVersionWatcher />);
		act(() => {
			vi.advanceTimersByTime(STALE_BANNER_AFTER_MS + 100);
		});

		expect(container.querySelector(".fixed")).toBeNull();

		const wrapper = screen.getByRole("alert").parentElement as HTMLElement;
		// Sticky, not static: the banner is the only warning before a forced
		// reload, and it fires on someone scrolled down. Static flow would
		// mount it off-screen and reload with no warning ever seen.
		expect(wrapper).toHaveClass("sticky");
		expect(wrapper).toHaveClass("shrink-0");
		// Centres the max-w-2xl alert without the Alert needing `mx-auto`.
		expect(wrapper).toHaveClass("justify-center");

		// The slide encoded a fixed-top origin that no longer exists.
		expect(wrapper).toHaveClass("motion-safe:fade-in");
		expect(wrapper).not.toHaveClass("motion-safe:slide-in-from-top-2");

		// `shadow-lg` was elevation for a floating overlay; in flow it would
		// read as a panel hovering over the page, unlike the sibling
		// AiUsageLimitBanner rows.
		expect(screen.getByRole("alert")).not.toHaveClass("shadow-lg");
	});
});
