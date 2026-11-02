/**
 * Fizzy #2221: the "Set password" control on Settings ▸ Security goes through
 * the reset flow, and a successful reset revokes every session of the account.
 * The form kept navigating softly into the app on the session it still held in
 * cache, and the login page sent that stale user straight back, in a loop.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resetPassword, signOut, session } = vi.hoisted(() => ({
	resetPassword: vi.fn(),
	signOut: vi.fn(),
	session: { user: null as { id: string } | null },
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams("token=example-token"),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: session.user, loaded: true }),
}));

vi.mock("@saas/auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: (code?: string) => code ?? "err",
	}),
}));

vi.mock("@repo/auth/client", () => ({
	authClient: { resetPassword, signOut },
}));

import { ResetPasswordForm } from "../ResetPasswordForm";

const PASSWORD = "a-long-enough-example-password";

async function submit() {
	render(<ResetPasswordForm />);
	const input = document.querySelector("input[type=password]");
	if (!input) {
		throw new Error("password input not rendered");
	}
	fireEvent.change(input, { target: { value: PASSWORD } });
	fireEvent.click(screen.getByRole("button", { name: /submit/i }));
	await waitFor(() => expect(resetPassword).toHaveBeenCalled());
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.clearAllMocks();
	session.user = null;
	resetPassword.mockResolvedValue({ error: null });
	signOut.mockResolvedValue({ error: null });
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { href: "https://app.example.com/auth/reset-password" },
	});
});

describe("ResetPasswordForm", () => {
	it("signs a signed-in user out and leaves the app on the login page", async () => {
		session.user = { id: "user_example" };

		await submit();

		await waitFor(() =>
			expect(window.location.href).toBe("/auth/login?passwordSet=1"),
		);
		expect(signOut).toHaveBeenCalledTimes(1);
	});

	it("still reaches the login page when clearing the session fails", async () => {
		session.user = { id: "user_example" };
		signOut.mockRejectedValue(new Error("offline"));

		await submit();

		await waitFor(() =>
			expect(window.location.href).toBe("/auth/login?passwordSet=1"),
		);
		// The password was saved: the sign-out failure must not read as a failure.
		await screen.findByText("auth.resetPassword.hints.success");
	});

	it("leaves a signed-out visitor on the form's success message", async () => {
		await submit();

		await screen.findByText("auth.resetPassword.hints.success");
		expect(signOut).not.toHaveBeenCalled();
		expect(window.location.href).toContain("/auth/reset-password");
	});

	it("does not sign anyone out when the reset fails", async () => {
		session.user = { id: "user_example" };
		resetPassword.mockResolvedValue({
			error: { code: "INVALID_TOKEN" },
		});

		await submit();

		await screen.findByText("INVALID_TOKEN");
		expect(signOut).not.toHaveBeenCalled();
		expect(window.location.href).toContain("/auth/reset-password");
	});
});
