import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const fn = (key: string, params?: Record<string, unknown>) =>
			params
				? `${key}(${Object.entries(params)
						.map(([k, v]) => `${k}=${v}`)
						.join(",")})`
				: key;
		(fn as unknown as { rich: typeof fn }).rich = (
			key: string,
			values?: Record<string, () => unknown>,
		) => {
			if (values) {
				for (const cb of Object.values(values)) {
					try {
						cb();
					} catch {
						/* mock-only */
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
	useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

let callOrder: string[] = [];

const signOutMock = vi.fn(
	(opts?: {
		fetchOptions?: { onSuccess?: () => void; onError?: () => void };
	}) => {
		callOrder.push("signOut");
		opts?.fetchOptions?.onSuccess?.();
		return Promise.resolve();
	},
);
vi.mock("@repo/auth/client", () => ({
	authClient: {
		signOut: (...args: unknown[]) =>
			signOutMock(...(args as Parameters<typeof signOutMock>)),
		signIn: {
			email: vi.fn(),
			passkey: vi.fn(),
			magicLink: vi.fn(),
			social: vi.fn(),
		},
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		auth: {
			captcha: { enabled: false, siteKey: "" },
			enableSignup: true,
			enableSocialLogin: true,
			enableMagicLink: true,
			enablePasswordLogin: true,
			enablePasskeys: true,
		},
	},
}));
vi.mock("@saas/projects/lib/project-invitation-actions", () => ({
	signUpForProjectInvitationAction: vi.fn(),
	acceptProjectInvitationAction: vi.fn(),
	declineProjectInvitationAction: vi.fn(),
}));
vi.mock("@saas/auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: (c?: string) => c ?? "err",
	}),
}));
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
vi.mock("@saas/auth/components/PasswordSuggestions", () => ({
	PasswordSuggestions: () => <div data-testid="password-suggestions" />,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectInvitationModal } from "../ProjectInvitationModal";

let hrefValue = "";
beforeEach(() => {
	vi.clearAllMocks();
	callOrder = [];
	hrefValue = "";
	Object.defineProperty(window, "location", {
		writable: true,
		value: {
			origin: "https://app.example.test",
			set href(v: string) {
				callOrder.push("navigate");
				hrefValue = v;
			},
			get href() {
				return hrefValue;
			},
		},
	});
});

describe("ProjectInvitationModal — email_mismatch switch CTA", () => {
	const props = {
		invitationId: "inv-1",
		projectId: "proj-1",
		projectName: "Phoenix",
		organizationSlug: "acme",
		role: "PROJECT_MEMBER",
		state: {
			type: "email_mismatch" as const,
			invitationEmail: "b@x.com",
			currentEmail: "a@x.com",
		},
	};

	it("signs out first, then reloads the project-invitation page", async () => {
		const user = userEvent.setup();
		render(<ProjectInvitationModal {...props} />);

		await user.click(
			screen.getByRole("button", {
				name: /auth\.projectInvitation\.signInWithInvitedEmail/,
			}),
		);

		expect(callOrder).toEqual(["signOut", "navigate"]);
		expect(signOutMock).toHaveBeenCalledTimes(1);
		expect(hrefValue).toBe(
			"https://app.example.test/project-invitation/inv-1",
		);
	});

	it("renders the actionable provider hint", () => {
		render(<ProjectInvitationModal {...props} />);
		expect(
			screen.getByText(/auth\.projectInvitation\.providerHint/),
		).toBeInTheDocument();
	});
});
