/**
 * Unit tests for `useIsOverflowing`.
 *
 * Covers the cases that explain the production bug:
 *   - Initial mount: detection runs as soon as the ref attaches, so the
 *     hook works for elements that materialise after the parent renders
 *     (e.g. inputs portaled into a slot whose target only becomes non-null
 *     after the parent commits).
 *   - `value` change re-measures (text width can flip overflow without the
 *     element's own size changing — ResizeObserver wouldn't fire).
 *   - ResizeObserver fires re-measure when the container resizes.
 *   - Web-font load: `document.fonts.ready` triggers a re-measure so the
 *     initial fallback-font-based decision gets corrected.
 *   - Tearing down the previous observer when the ref switches elements
 *     (e.g. between renders that change the rendered branch).
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIsOverflowing } from "../use-is-overflowing";

type ObserverCallback = ResizeObserverCallback;

// Tracks the most recent ResizeObserver instance so tests can fire its
// callback to simulate a resize.
let lastObserver: {
	cb: ObserverCallback;
	observed: Element[];
	disconnected: boolean;
} | null = null;

class MockResizeObserver implements ResizeObserver {
	private observed: Element[] = [];
	disconnected = false;

	constructor(cb: ObserverCallback) {
		lastObserver = {
			cb,
			observed: this.observed,
			get disconnected() {
				return false;
			},
		};
	}

	observe(target: Element) {
		this.observed.push(target);
	}
	unobserve() {
		// no-op
	}
	disconnect() {
		this.disconnected = true;
	}
}

function makeInputWithMetrics(scrollWidth: number, clientWidth: number) {
	const el = document.createElement("input");
	Object.defineProperty(el, "scrollWidth", {
		configurable: true,
		get: () => scrollWidth,
	});
	Object.defineProperty(el, "clientWidth", {
		configurable: true,
		get: () => clientWidth,
	});
	document.body.appendChild(el);
	return el;
}

beforeEach(() => {
	lastObserver = null;
	// Replace the global ResizeObserver with our mock for each test.
	vi.stubGlobal("ResizeObserver", MockResizeObserver);
	// Default: fonts never resolve during the test, so the font-load effect's
	// `.then(measure)` callback doesn't fire outside of act() and produce a
	// React warning. The dedicated font-load test overrides this with a
	// resolvable promise and awaits it inside act().
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: { ready: new Promise<void>(() => undefined) },
	});
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("useIsOverflowing", () => {
	it("starts as false when no element is attached", () => {
		const { result } = renderHook(() =>
			useIsOverflowing<HTMLInputElement>("anything"),
		);
		const [, isOverflowing] = result.current;
		expect(isOverflowing).toBe(false);
	});

	it("detects overflow as soon as the ref attaches", () => {
		const el = makeInputWithMetrics(400, 100);
		const { result } = renderHook(() =>
			useIsOverflowing<HTMLInputElement>("long text"),
		);
		act(() => {
			const [setRef] = result.current;
			setRef(el);
		});
		expect(result.current[1]).toBe(true);
	});

	it("returns false when content fits", () => {
		const el = makeInputWithMetrics(100, 100);
		const { result } = renderHook(() =>
			useIsOverflowing<HTMLInputElement>("fits"),
		);
		act(() => {
			result.current[0](el);
		});
		expect(result.current[1]).toBe(false);
	});

	it("re-measures when the observed value changes", () => {
		const el = document.createElement("input");
		document.body.appendChild(el);
		// Start fitting.
		let scrollWidth = 100;
		Object.defineProperty(el, "scrollWidth", {
			configurable: true,
			get: () => scrollWidth,
		});
		Object.defineProperty(el, "clientWidth", {
			configurable: true,
			get: () => 100,
		});

		const { result, rerender } = renderHook(
			({ value }) => useIsOverflowing<HTMLInputElement>(value),
			{ initialProps: { value: "short" } },
		);
		act(() => {
			result.current[0](el);
		});
		expect(result.current[1]).toBe(false);

		// Simulate the user typing a longer title that overflows.
		scrollWidth = 600;
		rerender({ value: "a much longer story title" });
		expect(result.current[1]).toBe(true);
	});

	it("re-measures when ResizeObserver fires", () => {
		const el = document.createElement("input");
		document.body.appendChild(el);
		const scrollWidth = 100;
		let clientWidth = 600;
		Object.defineProperty(el, "scrollWidth", {
			configurable: true,
			get: () => scrollWidth,
		});
		Object.defineProperty(el, "clientWidth", {
			configurable: true,
			get: () => clientWidth,
		});

		const { result } = renderHook(() =>
			useIsOverflowing<HTMLInputElement>("fits"),
		);
		act(() => {
			result.current[0](el);
		});
		expect(result.current[1]).toBe(false);

		// Container shrinks past the text width — simulate the observer firing.
		clientWidth = 50;
		act(() => {
			lastObserver?.cb(
				[
					{
						target: el,
						contentRect: el.getBoundingClientRect(),
					} as unknown as ResizeObserverEntry,
				],
				new MockResizeObserver(() => undefined),
			);
		});
		expect(result.current[1]).toBe(true);
	});

	it("re-measures after web fonts finish loading", async () => {
		const el = document.createElement("input");
		document.body.appendChild(el);
		// Start: fallback font reports the text fits.
		let scrollWidth = 100;
		Object.defineProperty(el, "scrollWidth", {
			configurable: true,
			get: () => scrollWidth,
		});
		Object.defineProperty(el, "clientWidth", {
			configurable: true,
			get: () => 100,
		});

		const fontsReady = Promise.resolve();
		Object.defineProperty(document, "fonts", {
			configurable: true,
			value: { ready: fontsReady },
		});

		const { result } = renderHook(() =>
			useIsOverflowing<HTMLInputElement>("title"),
		);
		act(() => {
			result.current[0](el);
		});
		expect(result.current[1]).toBe(false);

		// After webfont swaps in, the real font is wider — text now overflows.
		scrollWidth = 400;
		await act(async () => {
			await fontsReady;
		});
		expect(result.current[1]).toBe(true);
	});

	it("re-attaches the observer when the element changes", () => {
		const elA = makeInputWithMetrics(400, 100);
		const elB = makeInputWithMetrics(100, 100);

		const { result } = renderHook(() =>
			useIsOverflowing<HTMLInputElement>("v"),
		);

		act(() => {
			result.current[0](elA);
		});
		expect(result.current[1]).toBe(true);
		const observerA = lastObserver;
		expect(observerA?.observed).toContain(elA);

		// Switch to a different element (e.g. component re-rendered a
		// different branch). The hook must tear down the previous observer.
		act(() => {
			result.current[0](elB);
		});
		expect(result.current[1]).toBe(false);
		expect(lastObserver).not.toBe(observerA);
		expect(lastObserver?.observed).toContain(elB);
	});

	it("handles unmount by accepting a null ref", () => {
		const el = makeInputWithMetrics(400, 100);
		const { result } = renderHook(() =>
			useIsOverflowing<HTMLInputElement>("v"),
		);
		act(() => {
			result.current[0](el);
		});
		expect(result.current[1]).toBe(true);

		// React calls the ref with null on unmount — the hook should not
		// throw, and should disconnect its observer.
		expect(() => {
			act(() => {
				result.current[0](null);
			});
		}).not.toThrow();
	});
});
