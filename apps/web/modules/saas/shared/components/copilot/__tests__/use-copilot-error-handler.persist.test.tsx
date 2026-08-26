/**
 * Regression test for the CopilotKit `onError` path (Codex adversarial-review
 * finding): errors raised through `useCopilotErrorHandler` must persist until
 * the user dismisses them, exactly like the fetch-interceptor path — otherwise
 * an assistant error delivered via CopilotKit's `onError` would still vanish
 * after a few seconds.
 *
 * Asserts the handler routes through the shared persistent-toast helper
 * (duration: Infinity + closeButton + stable id) for both known and unknown
 * error types, and that the AI_USAGE_LIMIT_EXCEEDED short-circuit is preserved.
 */

import { renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAiErrorToastDedupForTests } from "../copilot-error-toast";
import { useCopilotErrorHandler } from "../use-copilot-error-handler";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() },
}));

const showAiUsageLimitToast = vi.fn();
vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	// Treat any object carrying a `dimension` field as a usage-limit payload.
	isAiUsageLimitExceededPayload: (v: unknown): boolean =>
		typeof v === "object" && v !== null && "dimension" in v,
	useShowAiUsageLimitToast: () => showAiUsageLimitToast,
}));

const errorMock = toast.error as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	// Silence the handler's diagnostic console.error noise.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	resetAiErrorToastDedupForTests();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

function fire(event: unknown): void {
	const { result } = renderHook(() => useCopilotErrorHandler());
	result.current(event);
}

describe("useCopilotErrorHandler — error toasts persist until dismissed", () => {
	it("a known error type persists with a close button and stable id", () => {
		fire({ type: "network" });

		expect(errorMock).toHaveBeenCalledWith(
			"Connection failed",
			expect.objectContaining({
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
				id: expect.stringContaining("Connection failed"),
			}),
		);
	});

	it("an unknown error type persists with a close button and stable id", () => {
		fire({ type: "totally_unknown_event" });

		expect(errorMock).toHaveBeenCalledWith(
			"Something went wrong",
			expect.objectContaining({
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
				id: expect.stringContaining("Something went wrong"),
			}),
		);
	});

	it("an AI usage-limit payload short-circuits to the shared limit toast", () => {
		fire({ error: { dimension: "credits", limitId: "abc" } });

		expect(showAiUsageLimitToast).toHaveBeenCalledTimes(1);
		expect(errorMock).not.toHaveBeenCalled();
	});
});
