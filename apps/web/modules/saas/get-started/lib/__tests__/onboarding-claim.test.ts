/**
 * The onboarding claim ledger (Fizzy #2457, R23).
 *
 * The reason this is a ledger and not a boolean is the only thing worth
 * pinning: several surfaces publish through it now, and the first release must
 * not report "clear" while a second surface is still on screen. Everything else
 * here — the payload shape, the idempotent release — protects the listener that
 * has read this wire since before the ledger existed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	claimOnboardingView,
	isOnboardingViewClaimed,
} from "../onboarding-claim";
import { GET_STARTED_SURFACE_EVENT } from "../tour-steps";

function captureSurfaceEvents() {
	const seen: boolean[] = [];
	const listener = (event: Event) => {
		seen.push((event as CustomEvent<{ open: boolean }>).detail.open);
	};
	window.addEventListener(GET_STARTED_SURFACE_EVENT, listener);
	return {
		seen,
		stop: () =>
			window.removeEventListener(GET_STARTED_SURFACE_EVENT, listener),
	};
}

/** Nothing may leak between tests: the ledger is module scope by design. */
const held: Array<() => void> = [];
function claim() {
	const release = claimOnboardingView();
	held.push(release);
	return release;
}

afterEach(() => {
	while (held.length > 0) {
		held.pop()?.();
	}
	vi.restoreAllMocks();
});

describe("onboarding claim ledger", () => {
	it("reports open on the first claim and closed on the last release", () => {
		const surface = captureSurfaceEvents();

		const release = claim();
		expect(isOnboardingViewClaimed()).toBe(true);
		expect(surface.seen).toEqual([true]);

		release();
		expect(isOnboardingViewClaimed()).toBe(false);
		expect(surface.seen).toEqual([true, false]);

		surface.stop();
	});

	/**
	 * The whole reason for a counter. Two surfaces can be up at once — the
	 * blocking account gate over an already-open drawer is the real case — and
	 * a boolean would have let the first one to close cancel the other, putting
	 * a banner back under a modal.
	 */
	it("stays open until every claim is released", () => {
		const surface = captureSurfaceEvents();

		const first = claim();
		const second = claim();
		first();

		expect(isOnboardingViewClaimed()).toBe(true);
		expect(surface.seen).toEqual([true, true, true]);

		second();
		expect(isOnboardingViewClaimed()).toBe(false);
		expect(surface.seen[surface.seen.length - 1]).toBe(false);

		surface.stop();
	});

	it("ignores a repeated release rather than double-decrementing", () => {
		const outer = claim();
		const release = claimOnboardingView();

		release();
		release();

		expect(isOnboardingViewClaimed()).toBe(true);
		outer();
		expect(isOnboardingViewClaimed()).toBe(false);
	});
});
