/**
 * useDuplicateCheckPrefetch — the roadmap "Add" dialog's duplicate-check
 * prefetch (Fizzy #2180 latency follow-up). Mocks `@shared/lib/orpc-client`
 * like `DocumentDecisionPrecheckBanner.test.tsx` and controls each call's
 * settlement manually via a deferred promise, so the tests can assert on
 * in-flight vs. settled vs. rejected state without real network timing.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckDuplicateResult } from "../CreateStoryDuplicateWarning";
import {
	PREFETCH_DEBOUNCE_MS,
	PREFETCH_MIN_LENGTH,
	useDuplicateCheckPrefetch,
} from "../useDuplicateCheckPrefetch";

const mockCheckDuplicate = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				checkDuplicate: (...args: unknown[]) =>
					mockCheckDuplicate(...args),
			},
		},
	},
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type TrackedCall = {
	options: { signal?: AbortSignal };
	deferred: ReturnType<typeof deferred<CheckDuplicateResult>>;
};

let calls: TrackedCall[] = [];

function arrangeCheckDuplicate() {
	calls = [];
	mockCheckDuplicate.mockImplementation(
		(_input: unknown, options: { signal?: AbortSignal }) => {
			const d = deferred<CheckDuplicateResult>();
			calls.push({ options, deferred: d });
			return d.promise;
		},
	);
}

const CREATE_RESULT: CheckDuplicateResult = {
	decision: "create",
	confidence: 1,
	alternatives: [],
};

function renderPrefetch() {
	return renderHook(() =>
		useDuplicateCheckPrefetch({
			projectId: "proj-1",
			organizationId: null,
		}),
	);
}

// Comfortably clears PREFETCH_MIN_LENGTH (20).
const LONG_TEXT_A = "A description long enough to prefetch";
const LONG_TEXT_B = "A different description, also long enough";
const SHORT_TEXT = "too short";

beforeEach(() => {
	mockCheckDuplicate.mockReset();
	arrangeCheckDuplicate();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useDuplicateCheckPrefetch", () => {
	it("prefetches once, after the debounce pause — not on every keystroke", () => {
		vi.useFakeTimers();
		const { result } = renderPrefetch();

		act(() => {
			result.current.onDescriptionChange(LONG_TEXT_A);
		});
		expect(mockCheckDuplicate).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS - 1);
		});
		expect(mockCheckDuplicate).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);
	});

	it("prefetches immediately on blur, with no debounce", () => {
		const { result } = renderPrefetch();

		act(() => {
			result.current.onDescriptionBlur(LONG_TEXT_A);
		});

		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);
	});

	it("aborts the in-flight request when the text changes, and never reuses its result", () => {
		vi.useFakeTimers();
		const { result } = renderPrefetch();

		act(() => {
			result.current.onDescriptionBlur(LONG_TEXT_A);
		});
		const first = calls[0];
		expect(first.options.signal?.aborted).toBe(false);

		act(() => {
			result.current.onDescriptionChange(LONG_TEXT_B);
		});
		expect(first.options.signal?.aborted).toBe(true);

		act(() => {
			vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS);
		});
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(2);

		// Back to the FIRST text: its own prefetch was aborted and dropped, so
		// this must be a fresh call, never the aborted one's result.
		const run = result.current.getCheckRun(LONG_TEXT_A);
		run();
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(3);
	});

	it("submit reuses a settled prefetch result for the same text, without a second call", async () => {
		const { result } = renderPrefetch();

		act(() => {
			result.current.onDescriptionBlur(LONG_TEXT_A);
		});
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);

		await act(async () => {
			calls[0].deferred.resolve(CREATE_RESULT);
			await calls[0].deferred.promise;
		});

		const value = await result.current.getCheckRun(LONG_TEXT_A)();

		expect(value).toBe(CREATE_RESULT);
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);
	});

	it("submit awaits an in-flight prefetch for the same text, rather than issuing a second call", async () => {
		const { result } = renderPrefetch();

		act(() => {
			result.current.onDescriptionBlur(LONG_TEXT_A);
		});
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);

		const runPromise = result.current.getCheckRun(LONG_TEXT_A)();
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);

		calls[0].deferred.resolve(CREATE_RESULT);
		const value = await runPromise;

		expect(value).toBe(CREATE_RESULT);
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);
	});

	it("a rejected prefetch leads to a fresh call on submit, not its own stale failure", async () => {
		const { result } = renderPrefetch();

		act(() => {
			result.current.onDescriptionBlur(LONG_TEXT_A);
		});
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);

		calls[0].deferred.reject(new Error("network error"));
		await calls[0].deferred.promise.catch(() => {});
		await Promise.resolve();

		const runPromise = result.current.getCheckRun(LONG_TEXT_A)();
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(2);

		calls[1].deferred.resolve(CREATE_RESULT);
		const value = await runPromise;
		expect(value).toBe(CREATE_RESULT);
	});

	it("does nothing below the length threshold, on change or blur", () => {
		vi.useFakeTimers();
		expect(SHORT_TEXT.length).toBeLessThan(PREFETCH_MIN_LENGTH);
		const { result } = renderPrefetch();

		act(() => {
			result.current.onDescriptionChange(SHORT_TEXT);
		});
		act(() => {
			vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS);
		});
		act(() => {
			result.current.onDescriptionBlur(SHORT_TEXT);
		});

		expect(mockCheckDuplicate).not.toHaveBeenCalled();
	});

	it("resets on close: aborts the in-flight request and a later submit issues a fresh call", () => {
		const { result } = renderPrefetch();

		act(() => {
			result.current.onDescriptionBlur(LONG_TEXT_A);
		});
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(1);

		act(() => {
			result.current.reset();
		});
		expect(calls[0].options.signal?.aborted).toBe(true);

		result.current.getCheckRun(LONG_TEXT_A)();
		expect(mockCheckDuplicate).toHaveBeenCalledTimes(2);
	});
});
