import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// next-intl: echo keys with params so assertions can match on key + values.
vi.mock("next-intl", () => ({
	useTranslations: () => {
		const fn = (key: string, params?: Record<string, unknown>) =>
			params
				? `${key}(${Object.entries(params)
						.map(([k, v]) => `${k}=${v}`)
						.join(",")})`
				: key;
		return fn;
	},
}));

const replaceMock = vi.fn();
vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
}));

// Session is driven per-test via this mock.
const useSessionMock = vi.fn();
vi.mock("../../hooks/use-session", () => ({
	useSession: () => useSessionMock(),
}));

const signOutMock = vi.fn();
vi.mock("@repo/auth/client", () => ({
	authClient: {
		signOut: (...args: unknown[]) => signOutMock(...args),
		signIn: { email: vi.fn(), magicLink: vi.fn(), passkey: vi.fn() },
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		auth: {
			redirectAfterSignIn: "/app",
			enablePasswordLogin: true,
			enableMagicLink: true,
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

vi.mock("@saas/organizations/components/OrganizationInvitationAlert", () => ({
	OrganizationInvitationAlert: () => <div data-testid="org-invite-alert" />,
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@saas/auth/lib/api", () => ({ sessionQueryKey: ["session"] }));

vi.mock("@saas/auth/components/SocialSigninButton", () => ({
	SocialSigninButton: ({ provider }: { provider: string }) => (
		<button type="button">{provider}</button>
	),
}));
vi.mock("@saas/auth/components/LoginModeSwitch", () => ({
	LoginModeSwitch: () => <div data-testid="mode-switch" />,
}));
vi.mock("@saas/auth/components/TurnstileWidget", () => ({
	TurnstileWidget: () => <div data-testid="turnstile" />,
}));
vi.mock("@saas/auth/components/EmailNotVerifiedAlert", () => ({
	EmailNotVerifiedAlert: () => <div data-testid="email-not-verified" />,
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => args,
		error: (...args: unknown[]) => toastErrorMock(...args),
	},
}));

import { LoginForm } from "../LoginForm";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("LoginForm — invite account mismatch guard", () => {
	it("does NOT auto-redirect and shows the switch panel when signed in as a different account", async () => {
		useSessionMock.mockReturnValue({
			user: { email: "a@x.com" },
			loaded: true,
		});

		render(<LoginForm invitationId="inv-1" email="b@x.com" />);

		// The blind redirect to /organization-invitation/inv-1 must not fire.
		expect(replaceMock).not.toHaveBeenCalled();
		// The explicit switch panel renders (key echoed by the i18n mock).
		expect(
			screen.getByText(/auth\.login\.accountMismatch\.title/),
		).toBeInTheDocument();
		// Grab the button BEFORE clicking — its label flips to "switching" after.
		const switchButton = screen.getByRole("button", {
			name: /auth\.login\.accountMismatch\.switchAccount/,
		});
		expect(switchButton).toBeInTheDocument();

		const user = userEvent.setup();
		await user.click(switchButton);
		expect(signOutMock).toHaveBeenCalled();
	});

	it("re-enables the switch button and does NOT reload when sign-out fails", async () => {
		useSessionMock.mockReturnValue({
			user: { email: "a@x.com" },
			loaded: true,
		});

		const reloadMock = vi.fn();
		Object.defineProperty(window, "location", {
			writable: true,
			value: { reload: reloadMock },
		});

		// Drive the signOut error path: invoke the onError callback.
		signOutMock.mockImplementation(
			(opts: { fetchOptions?: { onError?: () => void } }) => {
				opts.fetchOptions?.onError?.();
			},
		);

		render(<LoginForm invitationId="inv-1" email="b@x.com" />);

		const switchButton = screen.getByRole("button", {
			name: /auth\.login\.accountMismatch\.switchAccount/,
		});

		const user = userEvent.setup();
		await user.click(switchButton);

		expect(signOutMock).toHaveBeenCalledTimes(1);
		// onError ran setIsSwitching(false) → button is enabled again.
		expect(switchButton).not.toBeDisabled();
		// An error toast surfaces instead of a silent reload.
		expect(toastErrorMock).toHaveBeenCalledTimes(1);
		expect(reloadMock).not.toHaveBeenCalled();
	});

	it("auto-redirects (no regression) when signed in as the invited account", () => {
		useSessionMock.mockReturnValue({
			user: { email: "b@x.com" },
			loaded: true,
		});

		render(<LoginForm invitationId="inv-1" email="b@x.com" />);

		expect(replaceMock).toHaveBeenCalledWith(
			"/organization-invitation/inv-1",
		);
		expect(
			screen.queryByText(/auth\.login\.accountMismatch\.title/),
		).not.toBeInTheDocument();
	});

	it("auto-redirects to the default target when authenticated with no invite email", () => {
		useSessionMock.mockReturnValue({
			user: { email: "a@x.com" },
			loaded: true,
		});

		render(<LoginForm />);

		expect(replaceMock).toHaveBeenCalledWith("/app");
	});
});
