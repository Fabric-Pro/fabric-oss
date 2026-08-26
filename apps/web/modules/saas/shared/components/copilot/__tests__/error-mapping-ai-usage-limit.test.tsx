/**
 * Regression coverage for:
 * the shared destructive `AI_USAGE_LIMIT_EXCEEDED` toast must fire
 * exactly once and the generic CopilotKit-error fallback must NOT fire
 * for an oRPC-shaped AI-usage-limit error.
 * The brief asked for a test under
 * `apps/web/modules/saas/shared/components/copilot/__tests__/` so it
 * lives next to the existing CopilotKit error-handler unit tests; the
 * actual handler under test is `useCopilotErrorHandler`, the one Group
 * 12 modified to detect the structured payload.
 * Mocking strategy: only the boundary — `@saas/payments/lib/ai-usage-limit-toast`
 * — is mocked. The hook under test, the type guard, and `sonner.toast`
 * are exercised end-to-end so the assertion really proves the new
 * branch swallowed the error and the fallback path stayed quiet.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showAiUsageLimitToastMock = vi.fn();

// Mock the boundary helper exports. The hook imports
// `useShowAiUsageLimitToast` (returns the toast function) and the type
// guard; both stay stable across renders so we use a single shared mock.
vi.mock("@saas/payments/lib/ai-usage-limit-toast", async () => {
	const actual = await vi.importActual<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>("@saas/payments/lib/ai-usage-limit-toast");
	return {
		...actual,
		useShowAiUsageLimitToast: () => showAiUsageLimitToastMock,
	};
});

// Sonner: capture generic-fallback `toast.error` calls so we can prove
// the new branch returned early without falling through.
const sonnerErrorMock = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		error: (...args: unknown[]) => sonnerErrorMock(...args),
		success: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
		message: vi.fn(),
	},
}));

beforeEach(() => {
	showAiUsageLimitToastMock.mockClear();
	sonnerErrorMock.mockClear();
	// Helper dedup is module-global; clear it so a persisted key from a prior
	// test can't suppress the generic-fallback toast under assertion here.
	resetAiErrorToastDedupForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// Import under test after mocks.
import { resetAiErrorToastDedupForTests } from "../copilot-error-toast";
import { useCopilotErrorHandler } from "../use-copilot-error-handler";

const VALID_PAYLOAD = {
	limitId: "ailim_test_001",
	dimension: "TOKENS" as const,
	window: "MONTHLY" as const,
	used: "100000",
	max: "100000",
	manageLimitsUrl: "/app/settings/ai-usage",
};

describe("useCopilotErrorHandler — AI_USAGE_LIMIT_EXCEEDED branch", () => {
	it("fires the shared destructive toast exactly once and skips the generic fallback when the payload is nested at error.data (oRPC envelope shape)", () => {
		const { result } = renderHook(() => useCopilotErrorHandler());

		result.current({
			type: "error",
			error: {
				code: "AI_USAGE_LIMIT_EXCEEDED",
				message: "AI is paused — usage limit reached",
				data: VALID_PAYLOAD,
			},
		});

		expect(showAiUsageLimitToastMock).toHaveBeenCalledTimes(1);
		expect(showAiUsageLimitToastMock).toHaveBeenCalledWith(VALID_PAYLOAD);
		expect(sonnerErrorMock).not.toHaveBeenCalled();
	});

	it("fires the shared toast when the structured payload is at the top level of `error` (raw thrown class instance)", () => {
		const { result } = renderHook(() => useCopilotErrorHandler());

		result.current({
			type: "error",
			error: {
				code: "AI_USAGE_LIMIT_EXCEEDED",
				...VALID_PAYLOAD,
			},
		});

		expect(showAiUsageLimitToastMock).toHaveBeenCalledTimes(1);
		expect(showAiUsageLimitToastMock).toHaveBeenCalledWith(
			expect.objectContaining({
				limitId: VALID_PAYLOAD.limitId,
				dimension: "TOKENS",
				window: "MONTHLY",
				manageLimitsUrl: VALID_PAYLOAD.manageLimitsUrl,
			}),
		);
		expect(sonnerErrorMock).not.toHaveBeenCalled();
	});

	it("falls through to the generic toast for any error event NOT carrying the AI_USAGE_LIMIT_EXCEEDED code (proves the branch is selective)", () => {
		const { result } = renderHook(() => useCopilotErrorHandler());

		result.current({
			type: "error",
			error: {
				code: "INTERNAL_SERVER_ERROR",
				message: "boom",
			},
		});

		expect(showAiUsageLimitToastMock).not.toHaveBeenCalled();
		// Generic CopilotKit `error`-type fallback maps to the
		// "Request failed" toast.
		expect(sonnerErrorMock).toHaveBeenCalledTimes(1);
		expect(sonnerErrorMock).toHaveBeenCalledWith(
			"Request failed",
			expect.objectContaining({
				description: expect.stringContaining("could not process"),
				// Persist-until-dismissed: the generic CopilotKit error fallback
				// no longer auto-dismisses (was `duration: 8000`); it stays until
				// the user clicks the close button. See `copilot-error-toast`.
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
			}),
		);
	});

	it("does NOT fire the AI-usage-limit toast for a code match with a malformed payload (defence-in-depth — the type guard rejects partial shapes)", () => {
		const { result } = renderHook(() => useCopilotErrorHandler());

		result.current({
			type: "error",
			error: {
				code: "AI_USAGE_LIMIT_EXCEEDED",
				// Intentionally missing required fields — the type
				// guard must reject this and the handler must NOT
				// invoke the toast helper with a half-formed payload.
				data: { limitId: "x" },
			},
		});

		expect(showAiUsageLimitToastMock).not.toHaveBeenCalled();
	});
});
