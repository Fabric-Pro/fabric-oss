import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMutate = vi.fn();

/**
 * The organization the caller BELONGS to, which is not always the one in the
 * URL — a project-only guest is rendered under the host's slug. `useAccountPath`
 * resolves to theirs; a URL-derived path would send them to the host's settings,
 * which bounces a guest straight back out.
 */
const ownSlug = { current: null as string | null };
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useAccountPath: (path: string) =>
		ownSlug.current ? `/app/${ownSlug.current}/${path}` : `/app/${path}`,
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: vi.fn(),
}));

vi.mock("@saas/auth/lib/api", () => ({
	useUserAccountsQuery: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			mfaPrompt: {
				getState: vi.fn(),
				dismiss: vi.fn(),
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: vi.fn(),
	useMutation: vi.fn(() => ({
		mutate: mockMutate,
		isPending: false,
	})),
	useQueryClient: vi.fn(() => ({
		cancelQueries: vi.fn(),
		getQueryData: vi.fn(),
		setQueryData: vi.fn(),
		invalidateQueries: vi.fn(),
	})),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const map: Record<string, string> = {
			"settings.account.security.mfaPrompt.title":
				"Protect your account with two-factor authentication",
			"settings.account.security.mfaPrompt.description":
				"Add an extra layer of security to your Fabric account. It only takes a minute.",
			"settings.account.security.mfaPrompt.setupCta": "Set up now",
			"settings.account.security.mfaPrompt.snoozeCta": "Remind me later",
			"settings.account.security.mfaPrompt.dismissCta": "Dismiss",
			"settings.account.security.mfaPrompt.ariaLabel":
				"Two-factor authentication setup prompt",
		};
		return map[key] ?? key;
	},
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

import { useSession } from "@saas/auth/hooks/use-session";
import { useUserAccountsQuery } from "@saas/auth/lib/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MfaSetupBanner } from "../MfaSetupBanner";

function setupMocks({
	sessionLoaded = true,
	twoFactorEnabled = false,
	accountsPending = false,
	accounts = [{ providerId: "credential" }],
	promptStatePending = false,
	promptState = { dismissed: false, snoozedUntil: null },
}: {
	sessionLoaded?: boolean;
	twoFactorEnabled?: boolean | null;
	accountsPending?: boolean;
	accounts?: Array<{ providerId: string }>;
	promptStatePending?: boolean;
	promptState?: { dismissed: boolean; snoozedUntil: Date | null } | undefined;
} = {}) {
	vi.mocked(useSession).mockReturnValue({
		user: { twoFactorEnabled } as any,
		loaded: sessionLoaded,
	} as any);

	vi.mocked(useUserAccountsQuery).mockReturnValue({
		data: accounts,
		isPending: accountsPending,
	} as any);

	vi.mocked(useQuery).mockReturnValue({
		data: promptState,
		isPending: promptStatePending,
	} as any);
}

describe("MfaSetupBanner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(useMutation).mockReturnValue({
			mutate: mockMutate,
			isPending: false,
		} as any);
	});

	describe("display logic", () => {
		it("renders banner for eligible user", () => {
			setupMocks();
			render(<MfaSetupBanner />);
			expect(screen.getByText("Secure your account")).toBeInTheDocument();
		});

		it("renders nothing when MFA is already enabled", () => {
			setupMocks({ twoFactorEnabled: true });
			const { container } = render(<MfaSetupBanner />);
			expect(container.firstChild).toBeNull();
		});

		it("renders nothing for OAuth-only user", () => {
			setupMocks({ accounts: [{ providerId: "google" }] });
			const { container } = render(<MfaSetupBanner />);
			expect(container.firstChild).toBeNull();
		});

		it("renders nothing when permanently dismissed", () => {
			setupMocks({
				promptState: { dismissed: true, snoozedUntil: null },
			});
			const { container } = render(<MfaSetupBanner />);
			expect(container.firstChild).toBeNull();
		});

		it("renders nothing when currently snoozed", () => {
			const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
			setupMocks({
				promptState: { dismissed: false, snoozedUntil: future },
			});
			const { container } = render(<MfaSetupBanner />);
			expect(container.firstChild).toBeNull();
		});

		it("renders banner when snooze has expired", () => {
			const past = new Date(Date.now() - 1000);
			setupMocks({
				promptState: { dismissed: false, snoozedUntil: past },
			});
			render(<MfaSetupBanner />);
			expect(screen.getByText("Secure your account")).toBeInTheDocument();
		});

		it("renders nothing during loading (session not loaded)", () => {
			setupMocks({ sessionLoaded: false });
			const { container } = render(<MfaSetupBanner />);
			expect(container.firstChild).toBeNull();
		});

		it("renders nothing during loading (accounts pending)", () => {
			setupMocks({ accountsPending: true });
			const { container } = render(<MfaSetupBanner />);
			expect(container.firstChild).toBeNull();
		});

		it("renders nothing during loading (prompt state pending)", () => {
			setupMocks({ promptStatePending: true });
			const { container } = render(<MfaSetupBanner />);
			expect(container.firstChild).toBeNull();
		});
	});

	describe("behavior", () => {
		it("links to account security inside the caller's own organization", () => {
			// The link was hardcoded at the personal settings tree, which was
			// the only place account security lived. That tree is gone, and the
			// path follows the organization the caller BELONGS to — not the one
			// in the URL, which for a project-only guest is somebody else's and
			// bounces them out.
			ownSlug.current = "example-org";
			setupMocks();
			render(<MfaSetupBanner />);
			const link = screen.getByText("Set up now").closest("a");
			expect(link).toHaveAttribute(
				"href",
				"/app/example-org/settings/account/security",
			);
		});

		it("still resolves outside an organization, where the redirect catches it", () => {
			// Rendered before a context resolves, the path has no slug. The
			// route it lands on is the catch-all left behind by the removed
			// tree, which redirects into the caller's organization rather than
			// answering with a 404.
			ownSlug.current = null;
			setupMocks();
			render(<MfaSetupBanner />);
			const link = screen.getByText("Set up now").closest("a");
			expect(link).toHaveAttribute(
				"href",
				"/app/settings/account/security",
			);
		});

		it("calls dismiss mutation with snooze action", () => {
			setupMocks();
			render(<MfaSetupBanner />);
			fireEvent.click(screen.getByText("Remind me later"));
			expect(mockMutate).toHaveBeenCalledWith("snooze");
		});

		it("calls dismiss mutation with dismiss action", () => {
			setupMocks();
			render(<MfaSetupBanner />);
			fireEvent.click(screen.getByText("Dismiss"));
			expect(mockMutate).toHaveBeenCalledWith("dismiss");
		});
	});
});
