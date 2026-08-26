/**
 * Round-trip regression test for the verification-link destination
 * (GitHub issue #2805).
 *
 * This starts from a link the APPLICATION generates — `@repo/auth`'s real
 * `withEmailVerificationCallback`, the same function that writes the URL into
 * the outgoing email — rather than a hand-written URL. That is the whole
 * point: the destination was being lost at the seam between the two halves,
 * so a test that hardcodes the URL shape on either side proves nothing.
 *
 * What was broken: `buildEmailVerificationCallbackUrl` returned an ABSOLUTE
 * URL, and `ConfirmEmailForm` runs the `callbackURL` param through
 * `safeRelativePath()`, which rejects anything not starting with a single
 * `/`. So the param always evaluated to `null` and every nested destination —
 * invitation deep links included — was silently dropped. The 2FA handoff
 * added for #2805 inherited the same loss, navigating to a bare
 * `/auth/verify`.
 *
 * Both destinations are asserted here — the 2FA handoff and the ordinary
 * verified-user redirect — because a regression in the shared
 * `safeRelativePath` hop would break them together.
 */

import { withEmailVerificationCallback } from "@repo/auth/lib/email-verification-callback";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmEmailForm } from "../ConfirmEmailForm";

const APP_URL = "https://app.example.com";
const DEFAULT_REDIRECT = "/app";
const INVITATION_PATH = "/organization-invitation/inv-123";
const TOKEN = "verification-token";

// --- Mocks ---

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const mockVerifyEmail = vi.fn();
vi.mock("@repo/auth/client", () => ({
	authClient: {
		verifyEmail: (...args: unknown[]) => mockVerifyEmail(...args),
	},
}));

const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

let currentSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
	useSearchParams: () => currentSearchParams,
}));

/**
 * Reproduce the exact link that reaches a user's inbox for an invited signup:
 * Better Auth hands our `sendVerificationEmail` callback a `/verify-email`
 * API URL carrying the caller's `callbackURL`, and the app rewrites it to the
 * confirm-email page.
 */
function emailedConfirmUrl(destination: string): string {
	const betterAuthUrl = `${APP_URL}/api/auth/verify-email?token=${TOKEN}&callbackURL=${encodeURIComponent(
		destination,
	)}`;
	return withEmailVerificationCallback(betterAuthUrl, {
		appUrl: APP_URL,
		defaultRedirect: DEFAULT_REDIRECT,
	});
}

/** Point the component at the query string of an emailed confirm-email link. */
function renderFromEmailedLink(destination: string) {
	const url = new URL(emailedConfirmUrl(destination));
	currentSearchParams = url.searchParams;
	render(<ConfirmEmailForm token={TOKEN} />);
	return url;
}

async function clickConfirm() {
	await userEvent.click(
		screen.getByRole("button", { name: "auth.confirmEmail.confirmButton" }),
	);
}

describe("ConfirmEmailForm — verification link destination", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("carries an application-generated callbackURL as a relative path, so safeRelativePath accepts it", () => {
		const url = new URL(emailedConfirmUrl(INVITATION_PATH));

		expect(url.pathname).toBe("/auth/confirm-email");
		// Relative — an absolute URL here is what safeRelativePath rejects.
		expect(url.searchParams.get("callbackURL")).toBe(
			`/auth/email-verified?redirectTo=${encodeURIComponent(INVITATION_PATH)}`,
		);
	});

	it("hands the nested destination to /auth/verify when the server answers with a 2FA challenge", async () => {
		mockVerifyEmail.mockResolvedValue({
			data: { twoFactorRedirect: true },
			error: null,
		});
		renderFromEmailedLink(INVITATION_PATH);

		await clickConfirm();

		expect(mockReplace).toHaveBeenCalledTimes(1);
		const target = new URL(mockReplace.mock.calls[0][0], APP_URL);
		expect(target.pathname).toBe("/auth/verify");
		// Asserted by parsing rather than string-matching, so the test pins
		// the destination rather than one library's percent-encoding choices.
		// OtpForm reads `redirectTo`; EmailVerificationRedirect then reads the
		// invitation path nested inside it.
		const redirectTo = target.searchParams.get("redirectTo");
		expect(redirectTo).toBe(
			`/auth/email-verified?redirectTo=${encodeURIComponent(INVITATION_PATH)}`,
		);
		const nested = new URL(redirectTo as string, APP_URL);
		expect(nested.searchParams.get("redirectTo")).toBe(INVITATION_PATH);
		expect(mockPush).not.toHaveBeenCalled();
	});

	it("sends a verified user without 2FA to that same destination", async () => {
		mockVerifyEmail.mockResolvedValue({
			data: { status: true, user: null },
			error: null,
		});
		renderFromEmailedLink(INVITATION_PATH);

		await clickConfirm();

		expect(mockReplace).not.toHaveBeenCalled();
		expect(mockPush).toHaveBeenCalledTimes(1);
		const target = new URL(mockPush.mock.calls[0][0], APP_URL);
		expect(target.pathname).toBe("/auth/email-verified");
		expect(target.searchParams.get("redirectTo")).toBe(INVITATION_PATH);
	});

	it("falls back to the default landing path when the link carries no destination", async () => {
		mockVerifyEmail.mockResolvedValue({
			data: { twoFactorRedirect: true },
			error: null,
		});
		// Better Auth substitutes "/" when a caller passes no callbackURL.
		renderFromEmailedLink("/");

		await clickConfirm();

		const target = new URL(mockReplace.mock.calls[0][0], APP_URL);
		const nested = new URL(
			target.searchParams.get("redirectTo") as string,
			APP_URL,
		);
		expect(nested.searchParams.get("redirectTo")).toBe(DEFAULT_REDIRECT);
	});
});
