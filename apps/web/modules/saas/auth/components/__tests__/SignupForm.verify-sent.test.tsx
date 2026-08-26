import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, params?: Record<string, unknown>) => {
			if (params) {
				let result = key;
				for (const [k, v] of Object.entries(params)) {
					result = `${result}:${k}=${v}`;
				}
				return result;
			}
			return key;
		};
		return t;
	},
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
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

vi.mock("@repo/config", () => ({
	config: {
		auth: {
			enablePasswordLogin: true,
			enableMagicLink: false,
			enableSocialLogin: false,
			enablePasskeys: false,
			enableSignup: true,
			redirectAfterSignIn: "/app",
			captcha: {
				enabled: false,
				siteKey: "",
			},
		},
	},
}));

const mockSignUpEmail = vi.fn();
const mockSignInMagicLink = vi.fn();
vi.mock("@repo/auth/client", () => ({
	authClient: {
		signUp: {
			email: (...args: unknown[]) => mockSignUpEmail(...args),
		},
		signIn: {
			magicLink: (...args: unknown[]) => mockSignInMagicLink(...args),
		},
	},
}));

vi.mock("@saas/auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: (code?: string) =>
			code ? `auth.errors.${code}` : "auth.errors.unknown",
	}),
}));

vi.mock("@saas/organizations/components/OrganizationInvitationAlert", () => ({
	OrganizationInvitationAlert: () => null,
}));

vi.mock("../TurnstileWidget", () => ({
	TurnstileWidget: () => <div data-testid="turnstile" />,
}));

vi.mock("../EmailNotVerifiedAlert", () => ({
	EmailNotVerifiedAlert: ({
		email,
		variant,
		startCooldownOnMount,
	}: {
		email: string;
		variant?: string;
		startCooldownOnMount?: boolean;
	}) => (
		<div
			data-testid="email-not-verified-alert"
			data-variant={variant}
			data-start-cooldown={startCooldownOnMount ? "true" : undefined}
		>
			{email}
		</div>
	),
}));

vi.mock("../SocialSigninButton", () => ({
	SocialSigninButton: () => null,
}));

vi.mock("../../constants/oauth-providers", () => ({
	oAuthProviders: {},
}));

vi.mock("@ui/components/checkbox", () => ({
	Checkbox: (props: {
		checked?: boolean;
		onCheckedChange?: (value: boolean) => void;
	}) => {
		const { checked, onCheckedChange, ...rest } = props;
		return (
			<input
				{...rest}
				type="checkbox"
				checked={!!checked}
				onChange={(e) => onCheckedChange?.(e.target.checked)}
			/>
		);
	},
}));

import { SignupForm } from "../SignupForm";

// --- Helpers ---

async function fillAndSubmitSignupForm(
	user: ReturnType<typeof userEvent.setup>,
	container: HTMLElement,
) {
	await user.type(screen.getByLabelText("auth.signup.name"), "Ada Lovelace");
	await user.type(
		screen.getByLabelText("auth.signup.email"),
		"ada@example.test",
	);
	// The password input sits inside a wrapper div under FormControl, so
	// it carries no label association — select it by its autocomplete.
	const passwordInput = container.querySelector(
		'input[autocomplete="new-password"]',
	);
	expect(passwordInput).not.toBeNull();
	await user.type(passwordInput as HTMLInputElement, "averylongpassword42");
	await user.click(screen.getByRole("checkbox"));
	await user.click(
		screen.getByRole("button", { name: "auth.signup.submit" }),
	);
}

// --- Tests ---

describe("SignupForm — verification-sent state", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows the check-your-email hint WITH the inline resend affordance after successful signup", async () => {
		mockSignUpEmail.mockResolvedValue({ error: null });

		const user = userEvent.setup();
		const { container } = render(<SignupForm />);

		await fillAndSubmitSignupForm(user, container);

		expect(
			await screen.findByText("auth.signup.hints.verifyEmail"),
		).toBeInTheDocument();

		const resendAffordance = screen.getByTestId("email-not-verified-alert");
		expect(resendAffordance).toHaveAttribute("data-variant", "inline");
		expect(resendAffordance).toHaveAttribute("data-start-cooldown", "true");
		expect(resendAffordance).toHaveTextContent("ada@example.test");

		expect(mockSignUpEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "ada@example.test",
				name: "Ada Lovelace",
			}),
		);
	});

	it("shows the resend affordance on the silent duplicate-email success path too", async () => {
		mockSignUpEmail.mockResolvedValue({
			error: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
		});

		const user = userEvent.setup();
		const { container } = render(<SignupForm />);

		await fillAndSubmitSignupForm(user, container);

		expect(
			await screen.findByText("auth.signup.hints.verifyEmail"),
		).toBeInTheDocument();

		const resendAffordance = screen.getByTestId("email-not-verified-alert");
		expect(resendAffordance).toHaveAttribute("data-variant", "inline");
		expect(resendAffordance).toHaveAttribute("data-start-cooldown", "true");
		expect(resendAffordance).toHaveTextContent("ada@example.test");
	});
});
