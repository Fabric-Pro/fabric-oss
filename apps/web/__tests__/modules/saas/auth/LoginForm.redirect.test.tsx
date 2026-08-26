/**
 * `LoginForm` reads its post-sign-in destination straight off the URL bar
 * (GitHub issue #2854).
 *
 * Unlike the 2FA hop in `OtpForm`, nothing upstream writes this param: the
 * login URL is whatever the visitor clicked. So `/auth/login?redirectTo=
 * https://evil.example` used to turn a successful sign-in ON THE REAL ORIGIN
 * into a navigation to an attacker page — the credentials were typed on the
 * legitimate site, which is exactly what makes the pattern a phishing
 * amplifier rather than an ordinary bad link.
 *
 * Every NAVIGATING sink derives from one sanitized `redirectPath`: three
 * `router.replace` calls (already-signed-in effect, password success, passkey
 * success), the `/auth/verify` handoff, and the magic-link `callbackURL`.
 * Sanitizing once at the read site therefore covers all of them, so these
 * tests pin the already-signed-in effect (the shortest path from hostile link
 * to navigation) and the `/auth/verify` handoff (the one sink where the raw
 * param gets a second chance — see below), and rely on the shared derivation
 * for the rest.
 *
 * The raw param does survive in one place, deliberately: `forwardedParams`
 * copies the whole query string onto the `/auth/signup` link so the visitor
 * keeps their context when they switch forms. That is inert — the path is a
 * fixed literal and the value rides along as encoded query data, never as the
 * navigation target — and `SignupForm` sanitizes it before it can reach a
 * callback. So "derives from `redirectPath`" is a claim about redirects, not
 * about every read of the param.
 *
 * The hostile-value sweep is deliberately the same table as
 * `OtpForm.redirect.test.tsx`: both components lean on the one
 * `safeRelativePath` helper, and a regression in it must fail loudly at
 * every hop rather than at whichever one happened to be tested harder.
 */

import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRouterReplace, mockSearchParams, mockSession, mockSignInEmail } =
	vi.hoisted(() => ({
		mockRouterReplace: vi.fn(),
		mockSearchParams: { current: new URLSearchParams() },
		mockSession: {
			current: { user: null as unknown, loaded: false },
		},
		mockSignInEmail: vi.fn(),
	}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ replace: mockRouterReplace, push: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => mockSearchParams.current,
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => mockSession.current,
}));

vi.mock("@repo/auth/client", () => ({
	authClient: {
		signIn: {
			email: (...args: unknown[]) => mockSignInEmail(...args),
			magicLink: vi.fn(),
			passkey: vi.fn(),
		},
		signOut: vi.fn(),
	},
}));

vi.mock("@saas/auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: () => "Something went wrong",
	}),
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@saas/auth/lib/api", () => ({ sessionQueryKey: ["session"] }));

// Child components are irrelevant to the redirect decision and drag in
// Turnstile / OAuth provider config that has nothing to do with it.
vi.mock("@saas/organizations/components/OrganizationInvitationAlert", () => ({
	OrganizationInvitationAlert: () => null,
}));
vi.mock("@saas/auth/components/EmailNotVerifiedAlert", () => ({
	EmailNotVerifiedAlert: () => null,
}));
vi.mock("@saas/auth/components/LoginModeSwitch", () => ({
	LoginModeSwitch: () => null,
}));
vi.mock("@saas/auth/components/SocialSigninButton", () => ({
	SocialSigninButton: () => null,
}));
vi.mock("@saas/auth/components/TurnstileWidget", () => ({
	TurnstileWidget: () => null,
}));

import { config } from "@repo/config";
import { LoginForm } from "@saas/auth/components/LoginForm";

const DEFAULT_ROUTE = config.auth.redirectAfterSignIn;

/**
 * Values that must never reach a navigation. Identical to the OtpForm table:
 * absolute and protocol-relative URLs, the backslash variant, a path that
 * does not start with `/` at all, and the control-character smuggling class —
 * WHATWG URL parsing strips ASCII tab / LF / CR before resolving, so
 * `"/\t/evil.example"` parses exactly as `"//evil.example"` while passing
 * every naive prefix check.
 */
const HOSTILE_DESTINATIONS = [
	"https://evil.example/steal",
	"//evil.example",
	"/\\evil.example",
	"app/relative-without-slash",
	"/\t/evil.example",
	"/\n/evil.example",
	"/\r/evil.example",
	"/\t\\evil.example",
];

describe("LoginForm — post-sign-in redirect", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSearchParams.current = new URLSearchParams();
		mockSession.current = { user: null, loaded: false };
		mockSignInEmail.mockResolvedValue({ data: {}, error: null });
	});

	describe("already-signed-in redirect", () => {
		// Visiting a crafted login link while a session is already live
		// navigates immediately, with no interaction at all — the shortest
		// path from hostile link to off-origin navigation.
		beforeEach(() => {
			mockSession.current = {
				user: { id: "u-1", email: "dev@example.com" },
				loaded: true,
			};
		});

		it.each(HOSTILE_DESTINATIONS)(
			"ignores a hostile redirectTo (%j) and uses the default route",
			async (hostile) => {
				mockSearchParams.current = new URLSearchParams({
					redirectTo: hostile,
				});
				render(<LoginForm />);
				await waitFor(() =>
					expect(mockRouterReplace).toHaveBeenCalledWith(
						DEFAULT_ROUTE,
					),
				);
			},
		);

		it("honours an ordinary relative destination", async () => {
			// The companion assertion to the sweep: rejecting control
			// characters and resolving against a base must not start
			// rejecting the paths the product actually emits.
			mockSearchParams.current = new URLSearchParams({
				redirectTo: "/app/projects?tab=open",
			});
			render(<LoginForm />);
			await waitFor(() =>
				expect(mockRouterReplace).toHaveBeenCalledWith(
					"/app/projects?tab=open",
				),
			);
		});

		it("falls back to the default route when no redirectTo is present", async () => {
			render(<LoginForm />);
			await waitFor(() =>
				expect(mockRouterReplace).toHaveBeenCalledWith(DEFAULT_ROUTE),
			);
		});

		it("prefers the invitation destination over any redirectTo", async () => {
			mockSearchParams.current = new URLSearchParams({
				invitationId: "inv-1",
				redirectTo: "https://evil.example",
			});
			render(<LoginForm />);
			await waitFor(() =>
				expect(mockRouterReplace).toHaveBeenCalledWith(
					"/organization-invitation/inv-1",
				),
			);
		});
	});

	describe("2FA handoff to /auth/verify", () => {
		/**
		 * This sink is not merely derived from `redirectPath` — it is the one
		 * place the RAW param gets a second chance. The handoff URL is built
		 * as `withQuery("/auth/verify", { ...forwardedParams, redirectTo })`,
		 * and `forwardedParams` is a copy of every search param, hostile
		 * `redirectTo` included. Only the explicit key AFTER the spread keeps
		 * the sanitized value on top. Reorder those two lines and the fix is
		 * silently undone for every 2FA user, so it gets its own assertion.
		 */
		it("carries the sanitized destination, not the raw param", async () => {
			mockSignInEmail.mockResolvedValue({
				data: { twoFactorRedirect: true },
				error: null,
			});
			mockSearchParams.current = new URLSearchParams({
				redirectTo: "https://evil.example/steal",
			});

			const { container } = render(<LoginForm />);

			const emailInput = await waitFor(() => {
				const found = container.querySelector('input[type="email"]');
				expect(found).not.toBeNull();
				return found as HTMLInputElement;
			});
			fireEvent.change(emailInput, {
				target: { value: "dev@example.com" },
			});
			fireEvent.change(
				container.querySelector(
					'input[type="password"]',
				) as HTMLInputElement,
				{ target: { value: "correct-horse" } },
			);
			fireEvent.submit(
				container.querySelector("form") as HTMLFormElement,
			);

			await waitFor(() => expect(mockRouterReplace).toHaveBeenCalled());

			const target = new URL(
				mockRouterReplace.mock.calls[0][0],
				"https://app.example.com",
			);
			expect(target.pathname).toBe("/auth/verify");
			expect(target.searchParams.get("redirectTo")).toBe(DEFAULT_ROUTE);
			expect(mockRouterReplace.mock.calls[0][0]).not.toContain(
				"evil.example",
			);
		});
	});
});
