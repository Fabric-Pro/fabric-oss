import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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

const sessionMock = vi.fn();
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => sessionMock(),
}));

const orgContextMock = vi.fn();
const accountOrgMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
	useAccountOrganization: () => accountOrgMock(),
}));

const guestMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => guestMock(),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		setActiveOrganization: vi.fn(),
	}),
}));

vi.mock("@saas/organizations/lib/api", () => ({
	useOrganizationListQuery: () => ({ data: [], isPending: false }),
}));

vi.mock("@saas/payments/components/ActivePlanBadge", () => ({
	ActivePlanBadge: () => null,
}));

vi.mock("@shared/components/UserAvatar", () => ({
	UserAvatar: ({ name }: { name: string }) => (
		<span data-testid="user-avatar">{name}</span>
	),
}));

vi.mock("@saas/organizations/components/OrganizationLogo", () => ({
	// Carry the name as a data attribute (not text content) so text
	// queries target the trigger label exclusively.
	OrganizationLogo: ({ name }: { name: string }) => (
		<span data-testid="organization-logo" data-name={name} />
	),
}));

vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
}));

vi.mock("@repo/config", () => ({
	config: {
		organizations: {
			enableBilling: false,
			requireOrganization: false,
			enableUsersToCreateOrganizations: false,
		},
		users: { enableBilling: false },
	},
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

import { OrganzationSelect } from "../OrganizationSelect";

const OWN_ACCOUNT_KEY = "organizations.organizationSelect.ownAccount";

function setupOrgContext({ isGuest }: { isGuest: boolean }) {
	sessionMock.mockReturnValue({
		user: {
			id: "u-1",
			name: "Pat Guest",
			email: "pat@example.test",
			image: null,
		},
	});
	orgContextMock.mockReturnValue({
		organizationId: "org-1",
		organizationSlug: "acme",
		organization: {
			id: "org-1",
			slug: "acme",
			name: "Acme Corp",
			logo: null,
		},
	});
	guestMock.mockReturnValue(isGuest);
	// A guest is by definition not a member of the host, so the organization
	// they are rooted in is always a different one.
	accountOrgMock.mockReturnValue({
		id: "org-own",
		slug: "pats-workspace",
		name: "Pat's workspace",
		logo: null,
	});
}

function setupNoOrgContext() {
	sessionMock.mockReturnValue({
		user: {
			id: "u-1",
			name: "Pat Solo",
			email: "pat@example.test",
			image: null,
		},
	});
	orgContextMock.mockReturnValue({
		organizationId: null,
		organizationSlug: null,
		organization: null,
	});
	guestMock.mockReturnValue(false);
	accountOrgMock.mockReturnValue(null);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("OrganzationSelect — guest org concealment", () => {
	it("shows the guest's OWN org (not the host) for project-only guests", () => {
		setupOrgContext({ isGuest: true });
		render(<OrganzationSelect />);

		// The guest is somewhere real — their own workspace, named.
		expect(screen.getByText("Pat's workspace")).toBeInTheDocument();
		expect(screen.getByTestId("organization-logo")).toHaveAttribute(
			"data-name",
			"Pat's workspace",
		);

		// The host org's identity must not appear anywhere in the closed
		// switcher — the guarantee this branch exists for, unchanged.
		expect(screen.queryByText("Acme Corp")).not.toBeInTheDocument();
		// And they are no longer told they are in a personal account.
		expect(screen.queryByText(OWN_ACCOUNT_KEY)).not.toBeInTheDocument();
	});

	it("keeps the org presentation for real members in an org (regression guard)", () => {
		setupOrgContext({ isGuest: false });
		render(<OrganzationSelect />);

		expect(screen.getByText("Acme Corp")).toBeInTheDocument();
		expect(screen.getByTestId("organization-logo")).toBeInTheDocument();

		// Closed dropdown: the personal-account label only lives in the menu
		// content, so it must not render on the trigger for members.
		expect(screen.queryByText(OWN_ACCOUNT_KEY)).not.toBeInTheDocument();
	});

	it("falls back to the account presentation when no org is in context", () => {
		setupNoOrgContext();
		render(<OrganzationSelect />);

		expect(screen.getByText(OWN_ACCOUNT_KEY)).toBeInTheDocument();
		expect(screen.getByTestId("user-avatar")).toBeInTheDocument();
		expect(
			screen.queryByTestId("organization-logo"),
		).not.toBeInTheDocument();
	});
});

describe("OrganzationSelect — collapsed rail variant", () => {
	// When the sidebar is collapsed the workspace switcher shrinks to a single
	// circular avatar so the user can still tell (and switch) which workspace
	// they're in. The trigger carries the workspace as an accessible label
	// rather than visible text.
	it("renders the org avatar (no visible text label) for members when collapsed", () => {
		setupOrgContext({ isGuest: false });
		render(<OrganzationSelect collapsed />);

		const logo = screen.getByTestId("organization-logo");
		expect(logo).toBeInTheDocument();
		expect(logo).toHaveAttribute("data-name", "Acme Corp");
		// No visible org name text in the rail — it's an icon-only trigger.
		expect(screen.queryByText("Acme Corp")).not.toBeInTheDocument();
	});

	it("renders the guest's OWN org avatar (not the host's) when collapsed", () => {
		setupOrgContext({ isGuest: true });
		render(<OrganzationSelect collapsed />);

		const logo = screen.getByTestId("organization-logo");
		expect(logo).toHaveAttribute("data-name", "Pat's workspace");
		expect(logo).not.toHaveAttribute("data-name", "Acme Corp");
	});

	it("renders the account avatar when no org is in context, collapsed", () => {
		setupNoOrgContext();
		render(<OrganzationSelect collapsed />);

		expect(screen.getByTestId("user-avatar")).toBeInTheDocument();
		expect(
			screen.queryByTestId("organization-logo"),
		).not.toBeInTheDocument();
	});
});
