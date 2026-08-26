/**
 * `OnboardingForm` is the second live open-redirect site found while fixing
 * GitHub issue #2854 — the login form was the reported one.
 *
 * It reads `redirectTo` off the query string and hands it straight to
 * `router.replace(redirectTo ?? "/app")` once the final step completes, so a
 * crafted `/onboarding?redirectTo=https://evil.example` lands the user
 * off-origin at the end of a flow they entered legitimately. Same class as
 * login, one step later, and reached by a freshly signed-up user.
 *
 * Kept separate from `LoginForm.redirect.test.tsx` because the two components
 * share nothing but the helper: deleting `safeRelativePath` from this file
 * alone must fail something, and before this test it did not.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRouterReplace, mockSearchParams, mockUpdateUser, mockClearCache } =
	vi.hoisted(() => ({
		mockRouterReplace: vi.fn(),
		mockSearchParams: { current: new URLSearchParams() },
		mockUpdateUser: vi.fn(),
		mockClearCache: vi.fn(),
	}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ replace: mockRouterReplace, push: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => mockSearchParams.current,
}));

vi.mock("@repo/auth/client", () => ({
	authClient: {
		updateUser: (...args: unknown[]) => mockUpdateUser(...args),
	},
}));

vi.mock("@shared/lib/cache", () => ({
	clearCache: (...args: unknown[]) => mockClearCache(...args),
}));

// The real step renders the organization/profile form; all this test needs is
// a way to fire its `onCompleted` callback, which is what triggers the
// redirect under test.
vi.mock("@saas/onboarding/components/OnboardingStep1", () => ({
	OnboardingStep1: ({ onCompleted }: { onCompleted: () => void }) => (
		<button type="button" onClick={onCompleted}>
			finish
		</button>
	),
}));

import { OnboardingForm } from "@saas/onboarding/components/OnboardingForm";

/** Same table as the login and OTP redirect tests — one shared helper. */
const HOSTILE_DESTINATIONS = [
	"https://evil.example/steal",
	"//evil.example",
	"/\\evil.example",
	"app/relative-without-slash",
	"/\t/evil.example",
	"/\n/evil.example",
	"/\r/evil.example",
	"/\t\\evil.example",
];

async function completeOnboarding() {
	fireEvent.click(screen.getByText("finish"));
	await waitFor(() => expect(mockRouterReplace).toHaveBeenCalled());
}

describe("OnboardingForm — post-onboarding redirect", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSearchParams.current = new URLSearchParams();
		mockUpdateUser.mockResolvedValue({ error: null });
		mockClearCache.mockResolvedValue(undefined);
	});

	it.each(HOSTILE_DESTINATIONS)(
		"ignores a hostile redirectTo (%j) and falls back to /app",
		async (hostile) => {
			mockSearchParams.current = new URLSearchParams({
				redirectTo: hostile,
			});
			render(<OnboardingForm />);
			await completeOnboarding();
			expect(mockRouterReplace).toHaveBeenCalledWith("/app");
		},
	);

	it("honours an ordinary relative destination", async () => {
		mockSearchParams.current = new URLSearchParams({
			redirectTo: "/app/projects?tab=open",
		});
		render(<OnboardingForm />);
		await completeOnboarding();
		expect(mockRouterReplace).toHaveBeenCalledWith(
			"/app/projects?tab=open",
		);
	});

	it("falls back to /app when no redirectTo is present", async () => {
		render(<OnboardingForm />);
		await completeOnboarding();
		expect(mockRouterReplace).toHaveBeenCalledWith("/app");
	});
});
