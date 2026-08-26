/**
 * Unit tests for `CopilotFetchErrorInterceptor` — the `window.fetch` wrapper that
 * surfaces AI-assistant HTTP failures as sonner toasts.
 *
 * Behavior under test (Fizzy follow-up): the error message that previously
 * flashed for a few seconds and auto-vanished must now stay on screen until the
 * user explicitly dismisses it. In sonner 2.x that maps to
 * `duration: Number.POSITIVE_INFINITY` (no auto-close) + `closeButton: true`
 * (the click-to-dismiss affordance — sonner exposes no whole-body onClick).
 *
 * Scope guard: transient 429 rate-limit toasts carry a live "Retrying in Ns…"
 * countdown and self-resolve, so they MUST keep a finite duration and no
 * persistent close button (otherwise a stale countdown would linger forever).
 *
 * Mocking strategy: only the boundaries are mocked — `sonner` (to assert toast
 * options without rendering a Toaster) and the `ai-usage-limit-toast` module
 * (whose hook the component calls at render). The fetch interception itself is
 * exercised end-to-end by installing a stub "original" fetch, mounting the
 * component (which wraps it), and firing a request through `window.fetch`.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotFetchErrorInterceptor } from "../CopilotFetchErrorInterceptor";
import { resetAiErrorToastDedupForTests } from "../copilot-error-toast";

// --- Mocks ------------------------------------------------------------------

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() },
}));

vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	isAiUsageLimitExceededPayload: () => false,
	useShowAiUsageLimitToast: () => vi.fn(),
}));

const COPILOT_URL = "/api/copilotkit";
const originalWindowFetch = window.fetch;

afterEach(() => {
	cleanup();
	window.fetch = originalWindowFetch;
	resetAiErrorToastDedupForTests();
	vi.clearAllMocks();
});

/**
 * Install a stub "original" fetch, mount the interceptor (which captures and
 * wraps it on mount), then fire a single request through the patched
 * `window.fetch`. `expectReject` is for the network-failure path where the
 * interceptor re-throws after toasting.
 */
async function fireThroughInterceptor(
	makeResponse: () => Response | Promise<Response>,
	{ expectReject = false }: { expectReject?: boolean } = {},
) {
	window.fetch = vi.fn(makeResponse) as unknown as typeof window.fetch;
	render(<CopilotFetchErrorInterceptor />);

	const call = window.fetch(COPILOT_URL, { method: "POST" });
	if (expectReject) {
		await expect(call).rejects.toBeDefined();
	} else {
		await call;
	}
}

/** Extract the options object from the most recent `toast.error(title, opts)` call. */
function lastToastOpts(): {
	description: string;
	duration: number;
	closeButton?: boolean;
	id?: string | number;
} {
	const mock = toast.error as unknown as ReturnType<typeof vi.fn>;
	const calls = mock.mock.calls;
	return calls[calls.length - 1]?.[1];
}

describe("CopilotFetchErrorInterceptor — error toasts persist until dismissed", () => {
	it("a 5xx server error persists (duration: Infinity) with a close button", async () => {
		await fireThroughInterceptor(
			() => new Response("kaboom", { status: 500 }),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"Server error",
			expect.objectContaining({
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
				// Stable id (derived from title+description) so a repeated identical
				// persistent error replaces the toast instead of stacking a new one.
				id: expect.stringContaining("Server error"),
			}),
		);
	});

	it("a 503 unavailable error persists with a close button", async () => {
		await fireThroughInterceptor(() => new Response(null, { status: 503 }));

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"AI service unavailable",
			expect.objectContaining({
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
			}),
		);
	});

	it("a 401 session-expired error persists with a close button", async () => {
		await fireThroughInterceptor(() => new Response(null, { status: 401 }));

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"Session expired",
			expect.objectContaining({
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
			}),
		);
	});

	it("a network failure persists with a close button", async () => {
		await fireThroughInterceptor(
			() => Promise.reject(new TypeError("Failed to fetch")),
			{ expectReject: true },
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith(
			"Connection failed",
			expect.objectContaining({
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
			}),
		);
	});

	it("a 429 rate-limit toast keeps its finite countdown and does NOT persist", async () => {
		await fireThroughInterceptor(
			() =>
				new Response(null, {
					status: 429,
					headers: { "Retry-After": "5" },
				}),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		const opts = lastToastOpts();
		expect(Number.isFinite(opts.duration)).toBe(true);
		expect(opts.duration).toBe(5000);
		expect(opts.closeButton).toBeFalsy();
		// Transient toasts self-close, so they keep auto-generated ids (no stable
		// id) — the anti-stacking replacement only applies to persistent errors.
		expect(opts.id).toBeUndefined();
	});
});
