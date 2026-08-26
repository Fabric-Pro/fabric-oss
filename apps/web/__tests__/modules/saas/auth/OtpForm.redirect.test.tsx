/**
 * `OtpForm` reads its post-verification destination straight off the URL bar.
 *
 * The 2FA challenge that lands users on /auth/verify writes that param
 * server-side and sanitizes it to a relative path first
 * (packages/auth/lib/two-factor-gate.ts). This component is the last hop
 * before `router.replace`, and the value has been through a redirect and a
 * page load by then — so it applies `safeRelativePath` again rather than
 * trusting where it came from. These tests pin that: a hostile destination
 * falls back to the default route, a relative one is honoured, and an
 * invitation id still wins over both.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRouterReplace, mockVerifyTotp, mockSearchParams } = vi.hoisted(
	() => ({
		mockRouterReplace: vi.fn(),
		mockVerifyTotp: vi.fn(),
		mockSearchParams: { current: new URLSearchParams() },
	}),
);

vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ replace: mockRouterReplace, push: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => mockSearchParams.current,
}));

vi.mock("@repo/auth/client", () => ({
	authClient: {
		twoFactor: {
			verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
		},
	},
}));

vi.mock("@saas/auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: () => "Something went wrong",
	}),
}));

import { config } from "@repo/config";
import { OtpForm } from "../../../../modules/saas/auth/components/OtpForm";

const DEFAULT_ROUTE = config.auth.redirectAfterSignIn;

/** Fill the OTP field, which auto-submits on the sixth character. */
async function submitCode(container: HTMLElement) {
	const input = container.querySelector("input");
	expect(input).not.toBeNull();
	fireEvent.change(input as HTMLInputElement, {
		target: { value: "123456" },
	});
	await waitFor(() => expect(mockRouterReplace).toHaveBeenCalled());
}

/**
 * Longest delay input-otp leaves pending, plus a margin.
 *
 * input-otp 1.4.2 fires its caret-sync callback three times per render —
 * `setTimeout(cb, 0)`, `10` and `50` — and returns the handles without ever
 * clearing them, unlike the sibling effect in the same module which clears all
 * four of its own. Unmounting does not cancel them, so each of the renders
 * below leaves a callback armed for up to 50 ms.
 *
 * If the file finishes within that window, the callback lands after the jsdom
 * environment is gone: `dispatchSetState` -> `resolveUpdatePriority` ->
 * "ReferenceError: window is not defined". Vitest reports that as an UNHANDLED
 * error, which fails the run while every assertion still passes and no test is
 * listed as failing — so the summary reads `726 passed | 0 failed` and exits 1.
 *
 * Whether it lands is pure timing, which is why an unrelated PR that only
 * changed how long the suite takes was what surfaced it.
 */
const INPUT_OTP_PENDING_TIMER_MS = 60;

describe("OtpForm — post-verification redirect", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockVerifyTotp.mockResolvedValue({ error: null });
		mockSearchParams.current = new URLSearchParams();
	});

	// Deliberately a real wait rather than fake timers. This hook runs before
	// the setup file's `cleanup()`, so the component is still mounted and the
	// drained callbacks execute in exactly the state they were written for.
	// Faking the clock here would also fake it for `waitFor` and for the
	// component's own 1 s interval, changing the behaviour of thirteen passing
	// assertions to fix something that is not about their semantics at all.
	afterEach(async () => {
		await new Promise((resolve) =>
			setTimeout(resolve, INPUT_OTP_PENDING_TIMER_MS),
		);
	});

	it.each([
		["https://evil.example/steal"],
		["//evil.example"],
		["/\\evil.example"],
		["app/relative-without-slash"],
		// Control-character smuggling: the URL parser strips ASCII tab / LF /
		// CR before resolving, so each of these navigates to evil.example
		// while starting with a single slash followed by a non-slash — every
		// prefix check passes them. Verified:
		//   new URL("/\t/evil.example", origin).href === "https://evil.example/"
		["/\t/evil.example"],
		["/\n/evil.example"],
		["/\r/evil.example"],
		["/\t\\evil.example"],
	])(
		"ignores a hostile redirectTo (%j) and uses the default route",
		async (hostile) => {
			mockSearchParams.current = new URLSearchParams({
				redirectTo: hostile,
			});
			const { container } = render(<OtpForm />);
			await submitCode(container);
			expect(mockRouterReplace).toHaveBeenCalledWith(DEFAULT_ROUTE);
		},
	);

	it("still honours an ordinary relative destination after that hardening", async () => {
		// The companion assertion to the sweep above: rejecting control
		// characters and resolving against a base must not start rejecting the
		// paths the challenge flow actually emits.
		mockSearchParams.current = new URLSearchParams({
			redirectTo: "/app/settings",
		});
		const { container } = render(<OtpForm />);
		await submitCode(container);
		expect(mockRouterReplace).toHaveBeenCalledWith("/app/settings");
	});

	it("honours a relative redirectTo", async () => {
		mockSearchParams.current = new URLSearchParams({
			redirectTo: "/app/projects?tab=open",
		});
		const { container } = render(<OtpForm />);
		await submitCode(container);
		expect(mockRouterReplace).toHaveBeenCalledWith(
			"/app/projects?tab=open",
		);
	});

	it("falls back to the default route when no redirectTo is present", async () => {
		const { container } = render(<OtpForm />);
		await submitCode(container);
		expect(mockRouterReplace).toHaveBeenCalledWith(DEFAULT_ROUTE);
	});

	it("prefers the invitation destination over any redirectTo", async () => {
		mockSearchParams.current = new URLSearchParams({
			invitationId: "inv-1",
			redirectTo: "https://evil.example",
		});
		const { container } = render(<OtpForm />);
		await submitCode(container);
		expect(mockRouterReplace).toHaveBeenCalledWith(
			"/organization-invitation/inv-1",
		);
	});

	it("does not navigate at all when verification fails", async () => {
		mockVerifyTotp.mockResolvedValue({ error: { code: "INVALID_CODE" } });
		mockSearchParams.current = new URLSearchParams({
			redirectTo: "/app/projects",
		});
		const { container } = render(<OtpForm />);
		const input = container.querySelector("input");
		fireEvent.change(input as HTMLInputElement, {
			target: { value: "123456" },
		});
		await screen.findByText("Something went wrong");
		expect(mockRouterReplace).not.toHaveBeenCalled();
	});
});
