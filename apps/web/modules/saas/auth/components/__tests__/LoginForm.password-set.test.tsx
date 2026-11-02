/**
 * Fizzy #2221: setting a first password signs the user out, so the login page
 * has to say why they are there and which password to use.
 */
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchParams, toastSuccess } = vi.hoisted(() => ({
	searchParams: { query: "" },
	toastSuccess: vi.fn(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

const replaceMock = vi.fn();
vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
}));

vi.mock("../../hooks/use-session", () => ({
	useSession: () => ({ user: null, loaded: true }),
}));

const { signInEmail, signInMagicLink, signInPasskey } = vi.hoisted(() => ({
	signInEmail: vi.fn(),
	signInMagicLink: vi.fn(),
	signInPasskey: vi.fn(),
}));
vi.mock("@repo/auth/client", () => ({
	authClient: {
		signOut: vi.fn(),
		signIn: {
			email: signInEmail,
			magicLink: signInMagicLink,
			passkey: signInPasskey,
		},
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		auth: {
			redirectAfterSignIn: "/app",
			enablePasswordLogin: true,
			enableMagicLink: false,
			enableSignup: true,
			enableSocialLogin: true,
			enablePasskeys: true,
			captcha: { enabled: false, siteKey: "" },
		},
	},
}));

vi.mock("@saas/auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: (c?: string) => c ?? "err",
	}),
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@saas/auth/lib/api", () => ({ sessionQueryKey: ["session"] }));

vi.mock("@saas/auth/components/SocialSigninButton", () => ({
	SocialSigninButton: ({
		provider,
		callbackURL,
	}: {
		provider: string;
		callbackURL?: string;
	}) => (
		<button data-callback-url={callbackURL} type="button">
			{provider}
		</button>
	),
}));
vi.mock("@saas/auth/components/TurnstileWidget", () => ({
	TurnstileWidget: () => null,
}));
vi.mock("@saas/auth/components/EmailNotVerifiedAlert", () => ({
	EmailNotVerifiedAlert: () => null,
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(searchParams.query),
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: vi.fn() },
}));

import { LoginForm } from "../LoginForm";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("LoginForm after a password was set (Fizzy #2221)", () => {
	it("tells the user to sign in with the new password", () => {
		searchParams.query = "passwordSet=1";

		render(<LoginForm />);

		expect(toastSuccess).toHaveBeenCalledTimes(1);
		expect(toastSuccess).toHaveBeenCalledWith(
			"auth.login.hints.passwordSet",
		);
	});

	it("says nothing on an ordinary visit", () => {
		searchParams.query = "";

		render(<LoginForm />);

		expect(toastSuccess).not.toHaveBeenCalled();
	});
});
