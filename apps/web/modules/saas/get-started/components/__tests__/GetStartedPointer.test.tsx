/**
 * "Get started" launcher pointer — visibility and suppression.
 *
 * Covers the two-layer behavior: a once-per-tab-session callout plus a static
 * marker that survives it, and the three paths that end eligibility (explicit
 * dismiss, launcher click, tour engagement via the server flag).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	GET_STARTED_OPEN_EVENT,
	GET_STARTED_SURFACE_EVENT,
} from "../../lib/tour-steps";

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user-1", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

const getState = vi.fn();
const update = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			onboarding: {
				getState: (...args: unknown[]) => getState(...args),
				update: (...args: unknown[]) => update(...args),
			},
		},
	},
}));

import {
	DEFAULT_TOUR_STATE,
	makeOnboardingStateData,
} from "../../lib/__tests__/onboarding-state-fixtures";
import { GetStartedPointer } from "../GetStartedPointer";

const MARKER = "onboarding.tour.pointer.badge";
const TITLE = "onboarding.tour.pointer.title";
const CTA = "onboarding.tour.pointer.cta";
const DONT_SHOW = "onboarding.tour.pointer.dontShowAgain";

function renderPointer() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<GetStartedPointer>
				{(marker, markerLabel) => (
					<button type="button" data-testid="launcher">
						Get started
						{marker}
						{markerLabel && (
							<span className="sr-only">{markerLabel}</span>
						)}
					</button>
				)}
			</GetStartedPointer>
		</QueryClientProvider>,
	);
}

async function dispatchSurface(open: boolean) {
	await act(async () => {
		window.dispatchEvent(
			new CustomEvent(GET_STARTED_SURFACE_EVENT, { detail: { open } }),
		);
	});
}

// jsdom has no layout engine, so `getClientRects()` is always empty and
// `checkVisibility` does not exist — `isAnchorOnScreen` would report every
// anchor off screen. Model "on screen" explicitly; the off-screen cases
// override this per test.
function stubOnScreen() {
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
		{ width: 120, height: 24 },
	] as unknown as DOMRectList);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		top: 100,
		left: 0,
		right: 120,
		bottom: 124,
		width: 120,
		height: 24,
	} as DOMRect);
}

/** Rendered, but scrolled entirely below its clipping container's fold. */
function stubClippedByScroll() {
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
		{ width: 120, height: 24 },
	] as unknown as DOMRectList);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		top: 5000,
		left: 0,
		right: 120,
		bottom: 5024,
		width: 120,
		height: 24,
	} as DOMRect);
}

beforeEach(() => {
	getState.mockReset();
	update.mockReset();
	update.mockResolvedValue({ state: DEFAULT_TOUR_STATE });
	sessionStorage.clear();
	stubOnScreen();
});

describe("GetStartedPointer visibility", () => {
	it("shows the callout and the marker to an eligible user (AE1)", async () => {
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(screen.getByText(MARKER)).toBeInTheDocument();
	});

	it("shows only the marker when the callout already fired this session (AE2)", async () => {
		sessionStorage.setItem("fabric:get-started-pointer-shown:user-1", "1");
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();

		expect(await screen.findByText(MARKER)).toBeInTheDocument();
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
	});

	it("suppresses the callout for the session that owns the first-login drawer (AE3)", async () => {
		getState.mockResolvedValue(
			makeOnboardingStateData({
				eligibleForPointer: true,
				eligibleForAutoLaunch: true,
				autoLaunchCohort: true,
			}),
		);
		renderPointer();

		expect(await screen.findByText(MARKER)).toBeInTheDocument();
		// Even once the drawer closes, this session belongs to the drawer.
		await dispatchSurface(false);
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
	});

	it("renders nothing at all for an ineligible user (AE6)", async () => {
		getState.mockResolvedValue(
			makeOnboardingStateData({
				state: { status: "completed" },
				eligibleForPointer: false,
			}),
		);
		renderPointer();

		expect(await screen.findByTestId("launcher")).toBeInTheDocument();
		expect(screen.queryByText(MARKER)).not.toBeInTheDocument();
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
	});

	it("is NOT suppressed by no-tags eligibility — only by a surface actually on screen", async () => {
		// Regression guard. `eligibleForFunctionTagsPrompt` is server-computed
		// and stays true for as long as the user has no function tags, so
		// gating on it suppressed this callout permanently for exactly the
		// users it targets. Yielding is the surface event's job, and that one
		// clears.
		getState.mockResolvedValue(
			makeOnboardingStateData({
				eligibleForPointer: true,
				eligibleForFunctionTagsPrompt: true,
			}),
		);
		renderPointer();

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
	});

	it("does not open a callout from a launcher copy that is off screen", async () => {
		// The desktop rail stays mounted and `display:none` below `md`, and
		// popover content portals to body — so an unguarded hidden copy would
		// float a callout at the origin.
		// jsdom has no layout engine and does not implement `checkVisibility`,
		// so define it for this case rather than spying on a missing property.
		Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
			value: () => false,
			configurable: true,
			writable: true,
		});
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();

		expect(await screen.findByText(MARKER)).toBeInTheDocument();
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
		// The session flag stays unclaimed so the visible copy can still open.
		expect(
			sessionStorage.getItem("fabric:get-started-pointer-shown:user-1"),
		).toBeNull();
		delete (HTMLElement.prototype as Partial<HTMLElement>).checkVisibility;
	});

	it("does not open a callout anchored to a launcher clipped below the sidebar's fold", async () => {
		// Found on staging at a 698px-tall window: the launcher is rendered and
		// `checkVisibility()` reports true, but it sits past its own scroll
		// container's fold, so the portalled callout drew beside the content
		// area pointing at nothing. Rendered is not the same as visible.
		stubClippedByScroll();
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();

		expect(await screen.findByText(MARKER)).toBeInTheDocument();
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
		// Nothing was spent — scrolling the launcher into view still earns it.
		expect(
			sessionStorage.getItem("fabric:get-started-pointer-shown:user-1"),
		).toBeNull();
	});

	it("closes the callout when another onboarding surface opens, and does not reopen", async () => {
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		await dispatchSurface(true);
		await waitFor(() =>
			expect(screen.queryByText(TITLE)).not.toBeInTheDocument(),
		);

		await dispatchSurface(false);
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
		expect(screen.getByText(MARKER)).toBeInTheDocument();
	});
});

describe("GetStartedPointer suppression", () => {
	it("persists a permanent dismissal from 'Don't show again' (AE5)", async () => {
		const user = userEvent.setup();
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: DONT_SHOW }));

		await waitFor(() =>
			expect(update).toHaveBeenCalledWith({
				action: { type: "dismissPointer" },
			}),
		);
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
		expect(screen.queryByText(MARKER)).not.toBeInTheDocument();
	});

	it("ends eligibility when the drawer is opened from the launcher (AE4)", async () => {
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		await act(async () => {
			window.dispatchEvent(new CustomEvent(GET_STARTED_OPEN_EVENT));
		});

		await waitFor(() =>
			expect(update).toHaveBeenCalledWith({
				action: { type: "dismissPointer" },
			}),
		);
		expect(screen.queryByText(MARKER)).not.toBeInTheDocument();
	});

	it("sends the dismissal exactly once even when both paths fire", async () => {
		const user = userEvent.setup();
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: DONT_SHOW }));
		await act(async () => {
			window.dispatchEvent(new CustomEvent(GET_STARTED_OPEN_EVENT));
		});

		await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
	});

	it("keeps the pointer hidden when the dismissal write fails", async () => {
		const user = userEvent.setup();
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		update.mockRejectedValue(new Error("network"));
		renderPointer();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: DONT_SHOW }));

		await waitFor(() =>
			expect(screen.queryByText(MARKER)).not.toBeInTheDocument(),
		);
	});

	it("opens the drawer from the callout's primary action", async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		window.addEventListener(GET_STARTED_OPEN_EVENT, onOpen);
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPointer();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: CTA }));

		expect(onOpen).toHaveBeenCalled();
		window.removeEventListener(GET_STARTED_OPEN_EVENT, onOpen);
	});
});

describe("GetStartedPointer resilience", () => {
	it("still renders when sessionStorage is unavailable", async () => {
		const spy = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("blocked");
			});
		const setSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("blocked");
			});
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);

		renderPointer();
		expect(await screen.findByText(MARKER)).toBeInTheDocument();

		spy.mockRestore();
		setSpy.mockRestore();
	});
});

/**
 * The navigation mounts this component twice — an always-mounted desktop rail
 * that CSS-hides below `md`, and the mobile sheet's own copy. Every guard in
 * the component exists for that pair, yet nothing exercised them together.
 */
describe("GetStartedPointer — two mounted copies", () => {
	function renderPair() {
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		return render(
			<QueryClientProvider client={client}>
				<div data-testid="hidden-copy">
					<GetStartedPointer>
						{(marker) => (
							<button type="button" data-hidden-launcher>
								Get started
								{marker}
							</button>
						)}
					</GetStartedPointer>
				</div>
				<div data-testid="visible-copy">
					<GetStartedPointer>
						{(marker) => (
							<button type="button" data-visible-launcher>
								Get started
								{marker}
							</button>
						)}
					</GetStartedPointer>
				</div>
			</QueryClientProvider>,
		);
	}

	/** Only the anchor inside the visible wrapper reports as on screen. */
	function stubPerCopyVisibility() {
		vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
			function (this: HTMLElement) {
				const inHidden = this.closest('[data-testid="hidden-copy"]');
				return (inHidden
					? []
					: [{ width: 120, height: 24 }]) as unknown as DOMRectList;
			},
		);
	}

	it("opens exactly one callout — the hidden copy stays quiet and leaves the flag unclaimed", async () => {
		stubPerCopyVisibility();
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPair();

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		// One callout, not two.
		expect(screen.getAllByText(TITLE)).toHaveLength(1);
	});

	it("answers one launcher click with exactly one suppression write", async () => {
		stubPerCopyVisibility();
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPair();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		await act(async () => {
			window.dispatchEvent(new CustomEvent(GET_STARTED_OPEN_EVENT));
		});

		// Both copies hear the event; only the on-screen one may act on it.
		await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
	});

	it("does not let a second copy reopen the callout after the first claimed the session", async () => {
		stubPerCopyVisibility();
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderPair();
		expect(await screen.findByText(TITLE)).toBeInTheDocument();

		// A surface opening and closing re-runs both copies' open effects.
		await dispatchSurface(true);
		await dispatchSurface(false);

		// The flag is read from storage at decision time, so neither copy
		// reopens on stale per-instance state (R4).
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
	});
});

describe("GetStartedPointer — callout disabled (mobile sheet copy)", () => {
	it("shows the marker but never opens a callout", async () => {
		getState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<GetStartedPointer calloutEnabled={false}>
					{(marker, markerLabel) => (
						<button type="button" data-testid="launcher">
							Get started
							{marker}
							{markerLabel && (
								<span className="sr-only">{markerLabel}</span>
							)}
						</button>
					)}
				</GetStartedPointer>
			</QueryClientProvider>,
		);

		expect(await screen.findByText(MARKER)).toBeInTheDocument();
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
		// The nudge is not burned — the persistent copy can still spend it.
		expect(
			sessionStorage.getItem("fabric:get-started-pointer-shown:user-1"),
		).toBeNull();
	});
});
