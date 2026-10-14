/**
 * Fizzy #3036: the login page is reached with `redirectTo` set to the link
 * the visitor opened — for `fabric connect chatgpt`, a path whose query holds
 * the CLI's port and state. Every way of signing in must return there.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LINK =
	"/connect/chatgpt?port=54321&state=state-example&shared=1&org=example-org";

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
	useSearchParams: () => new URLSearchParams({ redirectTo: LINK }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LoginForm } from "../LoginForm";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("LoginForm returns to redirectTo (Fizzy #3036)", () => {
	it("hands the link, query and all, to every social provider", () => {
		render(<LoginForm />);
		const providers = screen
			.getAllByRole("button")
			.filter((button) => button.hasAttribute("data-callback-url"));
		expect(providers.length).toBeGreaterThan(0);
		for (const provider of providers) {
			expect(provider).toHaveAttribute("data-callback-url", LINK);
		}
	});

	it("returns to the link after a password sign-in", async () => {
		signInEmail.mockResolvedValue({ data: {}, error: null });
		const user = userEvent.setup();
		render(<LoginForm />);
		await user.type(
			screen.getByRole("textbox", { name: "auth.signup.email" }),
			"dev@example.com",
		);
		await user.type(
			document.querySelector(
				'input[type="password"]',
			) as HTMLInputElement,
			"example-password",
		);
		await user.click(
			screen.getByRole("button", { name: "auth.login.submit" }),
		);
		await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(LINK));
	});

	it("returns to the link after a passkey sign-in", async () => {
		signInPasskey.mockResolvedValue({ data: {}, error: null });
		const user = userEvent.setup();
		render(<LoginForm />);
		await user.click(
			screen.getByRole("button", {
				name: /auth\.login\.loginWithPasskey/,
			}),
		);
		await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(LINK));
	});
});
