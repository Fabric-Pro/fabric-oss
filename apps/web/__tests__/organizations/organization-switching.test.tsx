import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSetActiveOrganization = vi.fn();
const mockRouterReplace = vi.fn();

vi.mock("@repo/config", () => ({
	config: {
		organizations: {
			requireOrganization: false,
			enableUsersToCreateOrganizations: false,
			enableBilling: false,
		},
		users: {
			enableBilling: false,
		},
	},
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: {
			id: "user-1",
			name: "Test User",
			image: null,
		},
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		setActiveOrganization: mockSetActiveOrganization,
	}),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	// Not a guest here, so the account organization is never consulted.
	useAccountOrganization: () => null,
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "acme",
		organization: {
			id: "org-1",
			name: "Acme",
			logo: null,
		},
	}),
}));

vi.mock("@saas/organizations/lib/api", () => ({
	useOrganizationListQuery: () => ({
		data: [
			{ slug: "acme", name: "Acme", logo: null },
			{ slug: "globex", name: "Globex", logo: null },
		],
	}),
}));

// Member (non-guest) context — the real hook needs a QueryClientProvider.
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => false,
}));

vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({
		replace: mockRouterReplace,
		push: vi.fn(),
	}),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		if (key === "organizations.organizationSelect.ownAccount") {
			return "Personal Account";
		}
		if (key === "organizations.organizationSelect.organizations") {
			return "Organizations";
		}
		return key;
	},
}));

vi.mock("@shared/components/UserAvatar", () => ({
	UserAvatar: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("@saas/organizations/components/OrganizationLogo", () => ({
	OrganizationLogo: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("@saas/payments/components/ActivePlanBadge", () => ({
	ActivePlanBadge: () => <div>Plan</div>,
}));

const RadioGroupContext = React.createContext<((value: string) => void) | null>(
	null,
);

vi.mock("@ui/components/dropdown-menu", () => ({
	DropdownMenu: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuContent: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuGroup: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuItem: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuSeparator: () => <hr />,
	DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	DropdownMenuRadioGroup: ({
		children,
		onValueChange,
	}: {
		children: ReactNode;
		onValueChange?: (value: string) => void;
	}) => (
		<RadioGroupContext.Provider value={onValueChange ?? null}>
			<div>{children}</div>
		</RadioGroupContext.Provider>
	),
	DropdownMenuRadioItem: ({
		children,
		value,
	}: {
		children: ReactNode;
		value: string;
	}) => {
		const onValueChange = React.useContext(RadioGroupContext);
		return (
			<button type="button" onClick={() => onValueChange?.(value)}>
				{children}
			</button>
		);
	},
}));

import { OrganzationSelect } from "@saas/organizations/components/OrganizationSelect";

describe("organization switching regression", () => {
	beforeEach(() => {
		mockSetActiveOrganization.mockReset();
		mockRouterReplace.mockReset();
	});

	it("offers no way back to personal context", async () => {
		// This asserted the opposite until the elimination: the switcher had a
		// personal-account option, and it was the ONLY affordance in the
		// product that set the active organization to null. With context
		// organization-only there is nothing to switch back to, and the guard
		// worth keeping is that the option cannot return — a switcher that
		// quietly regrew it would put users back into a context nothing else
		// supports any more.
		render(<OrganzationSelect />);

		expect(
			screen.queryAllByRole("button", { name: /test user/i }),
		).toHaveLength(0);

		// And nothing else in the rendered switcher clears the tenant.
		for (const button of screen.getAllByRole("button")) {
			await userEvent.click(button);
		}
		expect(mockSetActiveOrganization).not.toHaveBeenCalledWith(null);
	});
});
