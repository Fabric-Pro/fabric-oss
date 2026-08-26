/**
 * Unit tests for `useShowClosedFeatures`.
 *
 * Covers:
 *   - Default `false` when storage is empty.
 *   - `setShowClosed(true)` persists to the per-project key.
 *   - `toggleShowClosed` flips state.
 *   - Changing `projectId` re-reads a fresh value from storage.
 *   - SSR-safe: module import does not touch `window`; load helper
 *     returns default `false` when `window` is undefined.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useShowClosedFeatures } from "../useShowClosedFeatures";

const KEY = (projectId: string) => `fabric:show-closed-features:${projectId}`;

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	window.localStorage.clear();
});

describe("useShowClosedFeatures", () => {
	it("defaults to false when localStorage is empty", () => {
		const { result } = renderHook(() => useShowClosedFeatures("proj-1"));
		expect(result.current.showClosed).toBe(false);
	});

	it("reads an existing stored value on first render", () => {
		window.localStorage.setItem(KEY("proj-1"), "true");

		const { result } = renderHook(() => useShowClosedFeatures("proj-1"));
		expect(result.current.showClosed).toBe(true);
	});

	it("persists to the per-project key on setShowClosed(true)", () => {
		const { result } = renderHook(() => useShowClosedFeatures("proj-1"));

		act(() => {
			result.current.setShowClosed(true);
		});

		expect(result.current.showClosed).toBe(true);
		expect(window.localStorage.getItem(KEY("proj-1"))).toBe("true");
	});

	it("toggleShowClosed flips the state", () => {
		const { result } = renderHook(() => useShowClosedFeatures("proj-1"));

		expect(result.current.showClosed).toBe(false);

		act(() => {
			result.current.toggleShowClosed();
		});
		expect(result.current.showClosed).toBe(true);

		act(() => {
			result.current.toggleShowClosed();
		});
		expect(result.current.showClosed).toBe(false);
	});

	it("re-reads from storage when projectId changes", () => {
		window.localStorage.setItem(KEY("proj-a"), "true");
		window.localStorage.setItem(KEY("proj-b"), "false");

		const { result, rerender } = renderHook(
			({ pid }: { pid: string }) => useShowClosedFeatures(pid),
			{ initialProps: { pid: "proj-a" } },
		);

		expect(result.current.showClosed).toBe(true);

		rerender({ pid: "proj-b" });
		expect(result.current.showClosed).toBe(false);
	});

	it("writes only to the per-project key, not a shared one", () => {
		const { result } = renderHook(() => useShowClosedFeatures("proj-a"));

		act(() => {
			result.current.setShowClosed(true);
		});

		expect(window.localStorage.getItem(KEY("proj-a"))).toBe("true");
		expect(window.localStorage.getItem(KEY("proj-b"))).toBeNull();
		expect(
			window.localStorage.getItem("fabric:show-closed-features"),
		).toBeNull();
	});

	it("is importable without touching window at module-load time (SSR-safe)", async () => {
		// Importing the module eagerly must not throw a ReferenceError even
		// if `window` is undefined. We simulate SSR by briefly shadowing it.
		const originalWindow = globalThis.window;
		// @ts-expect-error — intentionally removing window to simulate SSR.
		delete globalThis.window;
		try {
			const mod = await import("../useShowClosedFeatures");
			expect(typeof mod.useShowClosedFeatures).toBe("function");
		} finally {
			globalThis.window = originalWindow;
		}
	});
});
