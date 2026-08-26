import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResendCountdown } from "../use-resend-countdown";

const TEST_EMAIL = "Test@Example.com";
const STORAGE_KEY = "fabric:verify-resend:test@example.com";

describe("useResendCountdown", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localStorage.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns secondsLeft: 0 and isActive: false when no localStorage entry exists", () => {
		const { result } = renderHook(() => useResendCountdown(TEST_EMAIL));

		expect(result.current.secondsLeft).toBe(0);
		expect(result.current.isActive).toBe(false);
	});

	it("resumes countdown from localStorage if resendAllowedAt is in the future", () => {
		const futureTime = Date.now() + 30_000; // 30 seconds from now
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ resendAllowedAt: futureTime }),
		);

		const { result } = renderHook(() => useResendCountdown(TEST_EMAIL));

		expect(result.current.secondsLeft).toBe(30);
		expect(result.current.isActive).toBe(true);
	});

	it("clears localStorage entry when resendAllowedAt is in the past", () => {
		const pastTime = Date.now() - 5_000;
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ resendAllowedAt: pastTime }),
		);

		renderHook(() => useResendCountdown(TEST_EMAIL));

		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	it("startCountdown sets secondsLeft and writes to localStorage", () => {
		const { result } = renderHook(() => useResendCountdown(TEST_EMAIL));

		act(() => {
			result.current.startCountdown(60);
		});

		expect(result.current.secondsLeft).toBe(60);
		expect(result.current.isActive).toBe(true);

		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
		expect(stored.resendAllowedAt).toBeGreaterThan(Date.now());
	});

	it("decrements countdown each second", () => {
		const { result } = renderHook(() => useResendCountdown(TEST_EMAIL));

		act(() => {
			result.current.startCountdown(5);
		});

		expect(result.current.secondsLeft).toBe(5);

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(result.current.secondsLeft).toBe(4);

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(result.current.secondsLeft).toBe(3);
	});

	it("stops at 0 and removes localStorage key", () => {
		const { result } = renderHook(() => useResendCountdown(TEST_EMAIL));

		act(() => {
			result.current.startCountdown(3);
		});

		act(() => {
			vi.advanceTimersByTime(3000);
		});

		expect(result.current.secondsLeft).toBe(0);
		expect(result.current.isActive).toBe(false);
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	it("cleans up interval on unmount (no memory leak)", () => {
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

		const { result, unmount } = renderHook(() =>
			useResendCountdown(TEST_EMAIL),
		);

		act(() => {
			result.current.startCountdown(60);
		});

		unmount();

		expect(clearIntervalSpy).toHaveBeenCalled();
	});

	it("handles localStorage errors gracefully", () => {
		const getItemSpy = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("localStorage unavailable");
			});
		const setItemSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("localStorage unavailable");
			});

		const { result } = renderHook(() => useResendCountdown(TEST_EMAIL));

		// Should not throw, just default to 0
		expect(result.current.secondsLeft).toBe(0);
		expect(result.current.isActive).toBe(false);

		// startCountdown should still work for the session even if localStorage fails
		act(() => {
			result.current.startCountdown(10);
		});

		expect(result.current.secondsLeft).toBe(10);
		expect(result.current.isActive).toBe(true);

		getItemSpy.mockRestore();
		setItemSpy.mockRestore();
	});
});
