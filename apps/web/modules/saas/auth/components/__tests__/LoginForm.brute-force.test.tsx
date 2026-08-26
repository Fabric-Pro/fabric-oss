import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockSignInEmail = vi.fn();
const mockSignInMagicLink = vi.fn();
const mockSignInPasskey = vi.fn();

vi.mock("@repo/auth/client", () => ({
	authClient: {
		signIn: {
			email: (...args: unknown[]) => mockSignInEmail(...args),
			magicLink: (...args: unknown[]) => mockSignInMagicLink(...args),
			passkey: (...args: unknown[]) => mockSignInPasskey(...args),
		},
	},
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, params?: Record<string, unknown>) => {
			if (params) {
				let result = key;
				for (const [k, v] of Object.entries(params)) {
					result = result.replace(`{${k}}`, String(v));
				}
				return result;
			}
			return key;
		};
		return t;
	},
}));

const mockRouterReplace = vi.fn();
vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: mockRouterReplace,
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
		pathname: "/",
		query: {},
	}),
	usePathname: () => "/auth/login",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@repo/config", () => ({
	config: {
		auth: {
			enablePasswordLogin: true,
			enableMagicLink: false,
			enableSocialLogin: false,
			enablePasskeys: false,
			enableSignup: false,
			redirectAfterSignIn: "/app",
			captcha: {
				enabled: false,
				siteKey: "",
			},
		},
	},
}));

const mockInvalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({
		invalidateQueries: mockInvalidateQueries,
	}),
}));

vi.mock("@saas/auth/lib/api", () => ({
	sessionQueryKey: ["session"],
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: null,
		session: null,
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

vi.mock("../LoginModeSwitch", () => ({
	LoginModeSwitch: () => null,
}));

vi.mock("../SocialSigninButton", () => ({
	SocialSigninButton: () => null,
}));

vi.mock("../TurnstileWidget", () => ({
	TurnstileWidget: () => null,
}));

vi.mock("@saas/organizations/components/OrganizationInvitationAlert", () => ({
	OrganizationInvitationAlert: () => null,
}));

vi.mock("../../constants/oauth-providers", () => ({
	oAuthProviders: {},
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: React.ReactNode;
		href: string;
		[key: string]: unknown;
	}) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

// --- Helpers ---

import { LoginForm } from "../LoginForm";

async function fillAndSubmitLoginForm(
	user: ReturnType<typeof userEvent.setup>,
) {
	const emailInput = screen.getByRole("textbox", {
		name: "auth.signup.email",
	});
	const passwordInput = document.querySelector(
		'input[type="password"], input[autocomplete="current-password"]',
	) as HTMLInputElement;
	const submitButton = screen.getByRole("button", {
		name: "auth.login.submit",
	});

	await user.clear(emailInput);
	await user.type(emailInput, "test@example.com");
	await user.clear(passwordInput);
	await user.type(passwordInput, "wrongpassword");
	await user.click(submitButton);
}

// --- Tests ---

describe("LoginForm brute force protection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows lockout alert on ACCOUNT_LOCKED error", async () => {
		const user = userEvent.setup();
		mockSignInEmail.mockResolvedValue({
			data: null,
			error: { code: "ACCOUNT_LOCKED" },
		});

		render(<LoginForm />);
		await fillAndSubmitLoginForm(user);

		await waitFor(() => {
			expect(
				screen.getByText("auth.errors.accountLocked"),
			).toBeInTheDocument();
		});
	});

	it("disables submit button while locked out", async () => {
		const user = userEvent.setup();
		mockSignInEmail.mockResolvedValue({
			data: null,
			error: { code: "ACCOUNT_LOCKED" },
		});

		render(<LoginForm />);
		await fillAndSubmitLoginForm(user);

		await waitFor(() => {
			const submitButton = screen.getByRole("button", {
				name: "auth.login.submit",
			});
			expect(submitButton).toBeDisabled();
		});
	});

	it("shows password reset link in lockout alert", async () => {
		const user = userEvent.setup();
		mockSignInEmail.mockResolvedValue({
			data: null,
			error: { code: "ACCOUNT_LOCKED" },
		});

		render(<LoginForm />);
		await fillAndSubmitLoginForm(user);

		await waitFor(() => {
			const resetLink = screen.getByText("auth.login.resetToUnlock");
			expect(resetLink).toBeInTheDocument();
			expect(resetLink.closest("a")).toHaveAttribute(
				"href",
				"/auth/forgot-password",
			);
		});
	});

	it("shows error message on invalid credentials", async () => {
		const user = userEvent.setup();
		mockSignInEmail.mockResolvedValue({
			data: null,
			error: { code: "INVALID_EMAIL_OR_PASSWORD" },
		});

		render(<LoginForm />);
		await fillAndSubmitLoginForm(user);

		await waitFor(() => {
			expect(
				screen.getByText("auth.errors.invalidEmailOrPassword"),
			).toBeInTheDocument();
		});
	});
});
