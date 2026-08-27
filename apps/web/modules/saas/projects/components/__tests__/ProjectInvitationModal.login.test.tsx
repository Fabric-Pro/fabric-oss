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
	EmailNotVerifiedAlert: ({ email }: { email: string }) => (
		<div data-testid="email-not-verified-alert">{email}</div>
	),
}));

vi.mock("@saas/auth/components/LoginModeSwitch", () => ({
	LoginModeSwitch: ({
		activeMode,
		onChange,
	}: {
		activeMode: string;
		onChange: (mode: string) => void;
	}) => (
		<div data-testid="login-mode-switch" data-active={activeMode}>
			<button type="button" onClick={() => onChange("password")}>
				password
			</button>
			<button type="button" onClick={() => onChange("magic-link")}>
				magic-link
			</button>
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

let hrefValue = "";
beforeEach(() => {
	vi.clearAllMocks();
	configMock.auth.enableSignup = true;
	configMock.auth.enableSocialLogin = true;
	configMock.auth.enableMagicLink = true;
	configMock.auth.enablePasswordLogin = true;
	configMock.auth.enablePasskeys = true;
	hrefValue = "";
	Object.defineProperty(window, "location", {
		writable: true,
		value: {
			origin: "https://app.example.test",
			set href(v: string) {
				hrefValue = v;
			},
			get href() {
				return hrefValue;
			},
		},
	});
});

describe("ProjectInvitationModal — needs_login branch", () => {
	const baseProps = {
		invitationId: "inv-1",
		projectId: "proj-1",
		projectName: "Phoenix",
		organizationSlug: "acme",
		role: "PROJECT_MEMBER",
		state: {
			type: "needs_login" as const,
			invitationId: "inv-1",
			email: "user@example.com",
		},
	};

	it("renders the login branch with email + password inputs, mode switch, forgot-password, OAuth, and passkey", () => {
		render(<ProjectInvitationModal {...baseProps} />);

		expect(
			screen.getByText("auth.projectInvitation.loginTitle"),
		).toBeInTheDocument();
		expect(screen.getByTestId("login-mode-switch")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /auth.login.forgotPassword/ }),
		).toHaveAttribute("href", "/auth/forgot-password");
		expect(screen.getByTestId("social-google")).toHaveAttribute(
			"data-callback",
			"/project-invitation/inv-1",
		);
		expect(screen.getByTestId("social-github")).toHaveAttribute(
			"data-callback",
			"/project-invitation/inv-1",
		);
		expect(
			screen.getByRole("button", { name: /auth.login.loginWithPasskey/ }),
		).toBeInTheDocument();
	});

	it("hides LoginModeSwitch when enableMagicLink is false", () => {
		configMock.auth.enableMagicLink = false;
		render(<ProjectInvitationModal {...baseProps} />);
		expect(
			screen.queryByTestId("login-mode-switch"),
		).not.toBeInTheDocument();
	});

	it("hides LoginModeSwitch when enablePasswordLogin is false", () => {
		configMock.auth.enablePasswordLogin = false;
		render(<ProjectInvitationModal {...baseProps} />);
		expect(
			screen.queryByTestId("login-mode-switch"),
		).not.toBeInTheDocument();
	});

	it("hides the OAuth row when either enableSignup or enableSocialLogin is false", () => {
		configMock.auth.enableSocialLogin = false;
		render(<ProjectInvitationModal {...baseProps} />);
		expect(screen.queryByTestId("social-google")).not.toBeInTheDocument();
		expect(screen.queryByTestId("social-github")).not.toBeInTheDocument();
	});

	it("hides the passkey button when enablePasskeys is false", () => {
		configMock.auth.enablePasskeys = false;
		render(<ProjectInvitationModal {...baseProps} />);
		expect(
			screen.queryByRole("button", {
				name: /auth.login.loginWithPasskey/,
			}),
		).not.toBeInTheDocument();
	});

	it("calls acceptProjectInvitationAction + replaces to the project URL on successful passkey sign-in", async () => {
		signInPasskeyMock.mockResolvedValueOnce({ user: { id: "u-1" } });
		acceptActionMock.mockResolvedValueOnce({ success: true });

		const user = userEvent.setup();
		render(<ProjectInvitationModal {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: /auth.login.loginWithPasskey/ }),
		);

		// wait for both promises
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(acceptActionMock).toHaveBeenCalledWith("inv-1");
		expect(replaceMock).toHaveBeenCalledWith("/app/acme/projects/proj-1");
	});

	it("reloads the invite page when passkey sign-in authenticates a different account (accept fails)", async () => {
		signInPasskeyMock.mockResolvedValueOnce({ user: { id: "u-2" } });
		acceptActionMock.mockResolvedValueOnce({
			success: false,
			code: "INVITATION_NOT_FOUND",
		});

		const user = userEvent.setup();
		render(<ProjectInvitationModal {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: /auth.login.loginWithPasskey/ }),
		);

		// wait for both promises
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(acceptActionMock).toHaveBeenCalledWith("inv-1");
		// Server re-evaluates the (wrong) session and renders email_mismatch.
		expect(hrefValue).toBe(
			"https://app.example.test/project-invitation/inv-1",
		);
		// Must NOT route into the project as the wrong account.
		expect(replaceMock).not.toHaveBeenCalledWith(
			"/app/acme/projects/proj-1",
		);
	});

	it("inline-swaps back to the signup form when the 'Sign up' link is clicked", async () => {
		const user = userEvent.setup();
		render(<ProjectInvitationModal {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: /auth.login.createAnAccount/ }),
		);

		expect(
			screen.getByText("auth.projectInvitation.signupTitle"),
		).toBeInTheDocument();
	});

	it("renders the password form labelled 'Sign in and join' (parity copy)", () => {
		render(<ProjectInvitationModal {...baseProps} />);

		expect(
			screen.getByRole("button", {
				name: /auth.projectInvitation.signInAndJoin/,
			}),
		).toBeInTheDocument();
	});

	it("prefills the invited email on the login form (post-switch parity)", () => {
		render(
			<ProjectInvitationModal
				{...baseProps}
				state={{
					type: "needs_login",
					invitationId: "inv-1",
					email: "b@example.com",
				}}
			/>,
		);

		expect(screen.getByDisplayValue("b@example.com")).toBeInTheDocument();
	});
});
