import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
});

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const fn = (key: string, params?: Record<string, unknown>) => {
			if (params) {
				const ordered = Object.entries(params).map(
					([k, v]) => `${k}=${v}`,
				);
				return `${key}(${ordered.join(",")})`;
			}
			return key;
		};
		(fn as unknown as { rich: typeof fn }).rich = (
			key: string,
			values?: Record<string, () => unknown>,
		) => {
			if (values) {
				for (const cb of Object.values(values)) {
					try {
						cb();
					} catch {
						// mock-only
					}
				}
			}
			return key;
		};
		return fn;
	},
}));

const replaceMock = vi.fn();
vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
}));

const configMock = {
	auth: {
		captcha: { enabled: false, siteKey: "" },
		enableSignup: true,
		enableSocialLogin: true,
		enableMagicLink: true,
		enablePasswordLogin: true,
		enablePasskeys: true,
	},
};
vi.mock("@repo/config", () => ({
	get config() {
		return configMock;
	},
}));

const signUpActionMock = vi.fn();
const acceptActionMock = vi.fn();
const declineActionMock = vi.fn();
vi.mock("@saas/projects/lib/project-invitation-actions", () => ({
	signUpForProjectInvitationAction: (...args: unknown[]) =>
		signUpActionMock(...args),
	acceptProjectInvitationAction: (...args: unknown[]) =>
		acceptActionMock(...args),
	declineProjectInvitationAction: (...args: unknown[]) =>
		declineActionMock(...args),
}));

const signInEmailMock = vi.fn();
const signInPasskeyMock = vi.fn();
const signInMagicLinkMock = vi.fn();
const signInSocialMock = vi.fn();
vi.mock("@repo/auth/client", () => ({
	authClient: {
		signIn: {
			email: (...args: unknown[]) => signInEmailMock(...args),
			passkey: (...args: unknown[]) => signInPasskeyMock(...args),
			magicLink: (...args: unknown[]) => signInMagicLinkMock(...args),
			social: (...args: unknown[]) => signInSocialMock(...args),
		},
	},
}));

vi.mock("@saas/auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: (code?: string) =>
			code ? `auth.errors.${code}` : "auth.errors.unknown",
	}),
}));

vi.mock("@saas/auth/components/TurnstileWidget", () => ({
	TurnstileWidget: () => <div data-testid="turnstile" />,
}));

vi.mock("@saas/auth/components/EmailNotVerifiedAlert", () => ({
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

vi.mock("@saas/auth/components/SocialSigninButton", () => ({
	SocialSigninButton: ({
		provider,
		callbackURL,
	}: {
		provider: string;
		callbackURL?: string;
	}) => (
		<button
			type="button"
			data-testid={`social-${provider}`}
			data-callback={callbackURL}
		>
			{provider}
		</button>
	),
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

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

import { ProjectInvitationModal } from "../ProjectInvitationModal";

beforeEach(() => {
	vi.clearAllMocks();
	configMock.auth.enableSignup = true;
	configMock.auth.enableSocialLogin = true;
});

describe("ProjectInvitationModal — needs_signup branch", () => {
	const baseProps = {
		invitationId: "inv-1",
		projectId: "proj-1",
		projectName: "Phoenix",
		organizationSlug: "acme",
		role: "PROJECT_MEMBER",
		state: {
			type: "needs_signup" as const,
			invitationId: "inv-1",
			email: "invited@example.test",
		},
	};

	it("renders the signup branch by default with terms checkbox + invitation-aware OAuth buttons", () => {
		render(<ProjectInvitationModal {...baseProps} />);

		expect(
			screen.getByText("auth.projectInvitation.signupTitle"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/auth\.signup\.acceptTermsPrefix/),
		).toBeInTheDocument();
		expect(screen.getByTestId("social-google")).toHaveAttribute(
			"data-callback",
			"/project-invitation/inv-1",
		);
		expect(screen.getByTestId("social-github")).toHaveAttribute(
			"data-callback",
			"/project-invitation/inv-1",
		);
	});

	it("inline-swaps to the login form when the 'Sign in' link is clicked", async () => {
		const user = userEvent.setup();
		render(<ProjectInvitationModal {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: /auth.signup.signIn/ }),
		);

		expect(
			screen.getByText("auth.projectInvitation.loginTitle"),
		).toBeInTheDocument();
	});

	it("renders the email input as read-only with the invitation email pre-filled", () => {
		render(<ProjectInvitationModal {...baseProps} />);

		const emailInput = screen.getByLabelText("auth.signup.email");
		expect(emailInput).toHaveValue("invited@example.test");
		expect(emailInput).toHaveAttribute("readonly");
	});

	it("renders the disabled submit button by default (terms unchecked + empty fields)", () => {
		render(<ProjectInvitationModal {...baseProps} />);

		expect(
			screen.getByRole("button", {
				name: /auth.projectInvitation.createAccountAndJoin/,
			}),
		).toBeDisabled();
	});

	it("renders the terms-of-service + privacy-policy links open in a new tab", () => {
		render(<ProjectInvitationModal {...baseProps} />);

		const tos = screen.getByRole("link", {
			name: /auth.signup.termsOfService/,
		});
		expect(tos).toHaveAttribute("href", "/legal/terms");
		expect(tos).toHaveAttribute("target", "_blank");

		const privacy = screen.getByRole("link", {
			name: /auth.signup.privacyPolicy/,
		});
		expect(privacy).toHaveAttribute("href", "/legal/privacy-policy");
		expect(privacy).toHaveAttribute("target", "_blank");
	});

	it("hides the OAuth row when config.auth.enableSocialLogin is false", () => {
		configMock.auth.enableSocialLogin = false;
		render(<ProjectInvitationModal {...baseProps} />);

		expect(screen.queryByTestId("social-google")).not.toBeInTheDocument();
		expect(screen.queryByTestId("social-github")).not.toBeInTheDocument();
	});

	it("renders the check-your-email state on signup success — no inline sign-in, no accept", async () => {
		signUpActionMock.mockResolvedValueOnce({
			success: true,
			email: "invited@example.test",
			requiresVerification: true,
		});

		const user = userEvent.setup();
		const { container } = render(<ProjectInvitationModal {...baseProps} />);

		await user.type(
			screen.getByLabelText("auth.projectInvitation.fullName"),
			"Ada Lovelace",
		);
		// The password input sits inside a wrapper div under FormControl, so
		// it carries no label association — select it by its autocomplete.
		const passwordInput = container.querySelector(
			'input[autocomplete="new-password"]',
		);
		expect(passwordInput).not.toBeNull();
		await user.type(
			passwordInput as HTMLInputElement,
			"averylongpassword42",
		);
		await user.click(screen.getByRole("checkbox"));
		await user.click(
			screen.getByRole("button", {
				name: /auth.projectInvitation.createAccountAndJoin/,
			}),
		);

		// Verify-first success state: invitation-aware title + message,
		// the standard verify hint, and the spam reminder.
		expect(
			await screen.findByText(
				"auth.projectInvitation.verifyEmailSentTitle",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("auth.projectInvitation.verifyEmailSentMessage"),
		).toBeInTheDocument();
		expect(
			screen.getByText("auth.signup.hints.verifyEmail"),
		).toBeInTheDocument();
		expect(
			screen.getByText("auth.projectInvitation.verifyEmailSentSpamHint"),
		).toBeInTheDocument();

		// The inline resend affordance is mounted beneath the spam hint so
		// users can re-trigger the verification email without leaving the
		// modal.
		const resendAffordance = screen.getByTestId("email-not-verified-alert");
		expect(resendAffordance).toHaveAttribute("data-variant", "inline");
		expect(resendAffordance).toHaveAttribute("data-start-cooldown", "true");
		expect(resendAffordance).toHaveTextContent("invited@example.test");

		expect(signUpActionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				invitationId: "inv-1",
				name: "Ada Lovelace",
				password: "averylongpassword42",
			}),
		);

		// The trust-the-link flow is gone: no second-captcha sign-in step,
		// no client-side accept, no redirect.
		expect(
			screen.queryByRole("button", {
				name: /auth.projectInvitation.signInAndJoin/,
			}),
		).not.toBeInTheDocument();
		expect(signInEmailMock).not.toHaveBeenCalled();
		expect(acceptActionMock).not.toHaveBeenCalled();
		expect(replaceMock).not.toHaveBeenCalled();
	});
});
