import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSetActiveOrganization = vi.fn();
let activeOrgState: {
	setActiveOrganization: typeof mockSetActiveOrganization;
	isSwitching: boolean;
	switchingToSlug: string | null;
};

vi.mock("@repo/config", () => ({
	config: {
		organizations: {
			requireOrganization: false,
			enableUsersToCreateOrganizations: false,
			enableBilling: false,
		},
		users: { enableBilling: false },
	},
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user-1", name: "Test User", image: null },
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => activeOrgState,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "acme",
		organization: { id: "org-1", slug: "acme", name: "Acme", logo: null },
	}),
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => false,
}));

vi.mock("@saas/organizations/lib/api", () => ({
	useOrganizationListQuery: () => ({
		data: [
			{ slug: "acme", name: "Acme", logo: null },
			{ slug: "globex", name: "Globex", logo: null },
		],
	}),
}));

vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const map: Record<string, string> = {
			"organizations.organizationSelect.personalAccount":
				"Personal Account",
			"organizations.organizationSelect.organizations": "Organizations",
			"organizations.organizationSelect.switching":
				"Switching workspace…",
		};
		return map[key] ?? key;
	},
}));

vi.mock("@shared/components/UserAvatar", () => ({
	UserAvatar: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("@saas/organizations/components/OrganizationLogo", () => ({
	OrganizationLogo: ({ name }: { name: string }) => (
		<span data-testid="organization-logo" data-name={name} />
	),
}));

vi.mock("@saas/payments/components/ActivePlanBadge", () => ({
	ActivePlanBadge: () => null,
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
	DropdownMenuTrigger: ({
		children,
		...props
	}: { children: ReactNode } & Record<string, unknown>) => (
		<button type="button" {...props}>
			{children}
		</button>
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
		disabled,
	}: {
		children: ReactNode;
		value: string;
		disabled?: boolean;
	}) => {
		const onValueChange = React.useContext(RadioGroupContext);
		return (
			<button
				type="button"
				disabled={disabled}
				onClick={() => onValueChange?.(value)}
			>
				{children}
			</button>
		);
	},
}));

import { OrganzationSelect } from "@saas/organizations/components/OrganizationSelect";

beforeEach(() => {
	mockSetActiveOrganization.mockReset();
	activeOrgState = {
		setActiveOrganization: mockSetActiveOrganization,
		isSwitching: false,
		switchingToSlug: null,
	};
});

describe("OrganzationSelect — switching feedback", () => {
	it("shows an inline status with an accessible label while switching (AC2)", () => {
		activeOrgState.isSwitching = true;
		activeOrgState.switchingToSlug = "globex";
		render(<OrganzationSelect />);

		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("Switching workspace…");
	});

	it("optimistically presents the target workspace on a busy trigger while switching", () => {
		activeOrgState.isSwitching = true;
		activeOrgState.switchingToSlug = "globex";
		render(<OrganzationSelect />);

		// The trigger is marked busy...
		const busy = document.querySelector('[aria-busy="true"]');
		expect(busy).not.toBeNull();
		// ...and optimistically shows the target org (Globex), not Acme.
		expect(screen.getAllByText("Globex").length).toBeGreaterThan(0);
	});

	it("disables every workspace option while switching so repeat clicks are ignored (AC3)", () => {
		activeOrgState.isSwitching = true;
		activeOrgState.switchingToSlug = "globex";
		render(<OrganzationSelect />);

		expect(
			screen.getByRole("button", { name: /test user/i }),
		).toBeDisabled();
		const globexButtons = screen.getAllByRole("button", {
			name: /globex/i,
		});
		expect(
			globexButtons.some((b) => (b as HTMLButtonElement).disabled),
		).toBe(true);
	});

	it("keeps the status region empty and nothing busy when idle (regression guard)", () => {
		render(<OrganzationSelect />);
		// The persistent live region exists but carries no text when idle.
		expect(screen.getByRole("status")).toHaveTextContent("");
		// No control is marked busy when idle.
		expect(document.querySelector('[aria-busy="true"]')).toBeNull();
	});
});
