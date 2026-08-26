/**
 * Unit tests for the centralised AI-error-toast helper shared by
 * `CopilotFetchErrorInterceptor` and `useCopilotErrorHandler`.
 *
 * Contract:
 *   - persistent toasts never auto-dismiss (`duration: Infinity`), carry a
 *     close button, and reuse a stable id so a repeat replaces rather than
 *     stacks;
 *   - transient toasts keep their finite duration and get no close button / id;
 *   - both share a dedup window so an identical error within 3s shows once.
 */

import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resetAiErrorToastDedupForTests,
	resolveAiErrorToast,
	showPersistentAiErrorToast,
	showTransientAiErrorToast,
} from "../copilot-error-toast";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() },
}));

const errorMock = toast.error as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
	resetAiErrorToastDedupForTests();
	vi.clearAllMocks();
});

describe("showPersistentAiErrorToast", () => {
	it("renders with Infinity duration, a close button, and a stable id", () => {
		showPersistentAiErrorToast("Server error", "It broke.", 1_000);

		expect(errorMock).toHaveBeenCalledTimes(1);
		expect(errorMock).toHaveBeenCalledWith(
			"Server error",
			expect.objectContaining({
				description: "It broke.",
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
				// Stable id derived from title+description (separator is an impl
				// detail; the dedup test below pins the stability guarantee).
				id: expect.stringContaining("Server error"),
			}),
		);
	});

	it("suppresses an identical toast inside the dedup window", () => {
		showPersistentAiErrorToast("Server error", "It broke.", 1_000);
		showPersistentAiErrorToast("Server error", "It broke.", 1_500); // +500ms

		expect(errorMock).toHaveBeenCalledTimes(1);
	});

	it("re-toasts the same error once the dedup window has elapsed", () => {
		showPersistentAiErrorToast("Server error", "It broke.", 1_000);
		showPersistentAiErrorToast("Server error", "It broke.", 4_100); // +3.1s

		expect(errorMock).toHaveBeenCalledTimes(2);
		// Same stable id both times → sonner replaces rather than stacks.
		expect(errorMock.mock.calls[0][1].id).toBe(
			errorMock.mock.calls[1][1].id,
		);
	});

	it("treats different copy as different toasts", () => {
		showPersistentAiErrorToast("Server error", "A", 1_000);
		showPersistentAiErrorToast("Session expired", "B", 1_000);

		expect(errorMock).toHaveBeenCalledTimes(2);
	});
});

describe("showTransientAiErrorToast", () => {
	it("keeps a finite duration and gets no close button or id", () => {
		showTransientAiErrorToast(
			"AI service is busy",
			"Retrying…",
			5_000,
			1_000,
		);

		expect(errorMock).toHaveBeenCalledTimes(1);
		const opts = errorMock.mock.calls[0][1];
		expect(opts.duration).toBe(5_000);
		expect(Number.isFinite(opts.duration)).toBe(true);
		expect(opts.closeButton).toBeUndefined();
		expect(opts.id).toBeUndefined();
	});
});

/**
 * Retracting a notice that resolved itself has to SAY so.
 *
 * sonner's live region is `aria-relevant="additions text"`, so a toast leaving
 * the DOM is never announced. A sighted user reads the disappearance as "that
 * resolved"; a screen-reader user is left holding the last thing they were
 * told, which was that the assistant had stopped responding.
 */
describe("resolveAiErrorToast", () => {
	it("dismisses the stale notice and announces the resolution as an addition", () => {
		resolveAiErrorToast("Gone quiet", "It may be stuck", {
			title: "Responding again",
			description: "Not stuck after all",
		});

		expect(toast.dismiss).toHaveBeenCalledWith(
			"Gone quiet\u0000It may be stuck",
		);
		expect(toast.success).toHaveBeenCalledWith(
			"Responding again",
			expect.objectContaining({
				description: "Not stuck after all",
				duration: expect.any(Number),
			}),
		);
	});

	it("clears the dedup entry so a second genuine stall is not swallowed", () => {
		showPersistentAiErrorToast("Gone quiet", "It may be stuck");
		resolveAiErrorToast("Gone quiet", "It may be stuck", {
			title: "Responding again",
			description: "Not stuck after all",
		});
		(toast.error as unknown as { mockClear: () => void }).mockClear();

		// Immediately again — inside the 3s dedup window. Without the delete in
		// dismissAiErrorToast this would be suppressed and the user would get
		// the silence back.
		showPersistentAiErrorToast("Gone quiet", "It may be stuck");

		expect(toast.error).toHaveBeenCalledTimes(1);
	});
});
