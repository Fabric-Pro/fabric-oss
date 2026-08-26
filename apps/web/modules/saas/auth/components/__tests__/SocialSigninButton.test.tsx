import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth/client", () => ({
	authClient: {
		signIn: {
			social: vi.fn(),
		},
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		auth: {
			redirectAfterSignIn: "/app",
		},
	},
}));

vi.mock("nuqs", () => ({
	parseAsString: {},
	useQueryState: vi.fn(() => [null, vi.fn()]),
}));

vi.mock("../../constants/oauth-providers", () => ({
	oAuthProviders: {
		google: {
			name: "Google",
			icon: ({ className }: { className?: string }) => (
				<span data-testid="google-icon" className={className} />
			),
		},
		github: {
			name: "GitHub",
			icon: ({ className }: { className?: string }) => (
				<span data-testid="github-icon" className={className} />
			),
		},
	},
}));

import { authClient } from "@repo/auth/client";
import { useQueryState } from "nuqs";
import { SocialSigninButton } from "../SocialSigninButton";

const socialMock = authClient.signIn.social as unknown as ReturnType<
	typeof vi.fn
>;
const useQueryStateMock = useQueryState as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	useQueryStateMock.mockReturnValue([null, vi.fn()]);
	Object.defineProperty(window, "location", {
		writable: true,
		value: { origin: "https://app.example.test" },
	});
});

describe("SocialSigninButton", () => {
	it("uses the default redirect when no callbackURL prop and no invitationId query param is present", async () => {
		const user = userEvent.setup();
		render(<SocialSigninButton provider="google" />);

		await user.click(screen.getByRole("button", { name: /Google/i }));

		expect(socialMock).toHaveBeenCalledTimes(1);
		expect(socialMock).toHaveBeenCalledWith({
			provider: "google",
			callbackURL: "https://app.example.test/app",
		});
	});

	it("uses the invitationId-derived org-invitation redirect when the prop is omitted but a query param exists", async () => {
		useQueryStateMock.mockReturnValue(["inv-xyz", vi.fn()]);
		const user = userEvent.setup();
		render(<SocialSigninButton provider="google" />);

		await user.click(screen.getByRole("button", { name: /Google/i }));

		expect(socialMock).toHaveBeenCalledWith({
			provider: "google",
			callbackURL:
				"https://app.example.test/organization-invitation/inv-xyz",
		});
	});

	it("uses the explicit callbackURL prop verbatim when provided, overriding query-param fallback", async () => {
		useQueryStateMock.mockReturnValue(["inv-xyz", vi.fn()]);
		const user = userEvent.setup();
		render(
			<SocialSigninButton
				provider="github"
				callbackURL="/project-invitation/abc"
			/>,
		);

		await user.click(screen.getByRole("button", { name: /GitHub/i }));

		expect(socialMock).toHaveBeenCalledWith({
			provider: "github",
			callbackURL: "https://app.example.test/project-invitation/abc",
		});
	});

	it("does not call signIn.social when disabled is true", async () => {
		const user = userEvent.setup();
		render(<SocialSigninButton provider="google" disabled />);

		await user.click(screen.getByRole("button", { name: /Google/i }));

		expect(socialMock).not.toHaveBeenCalled();
	});
});
