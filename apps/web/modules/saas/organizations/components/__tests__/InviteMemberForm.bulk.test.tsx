/**
 * The form is rendered for organization admins only, which is what keeps the
 * bulk invitation out of reach for anyone else in the UI (Fizzy #1986, AC4).
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@repo/auth/client", () => ({
	authClient: { organization: { inviteMember: vi.fn() } },
}));
vi.mock("@saas/organizations/lib/api", () => ({
	fullOrganizationQueryKey: () => ["organization"],
	orgInvitationsQueryKey: () => ["invitations"],
}));
vi.mock("@saas/shared/components/SettingsItem", () => ({
	SettingsItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@saas/organizations/components/OrganizationRoleSelect", () => ({
	OrganizationRoleSelect: () => null,
}));
vi.mock("@saas/organizations/components/BulkInviteMembersDialog", () => ({
	BulkInviteMembersDialog: ({
		organizationId,
	}: {
		organizationId: string;
	}) => <div data-testid="bulk-invite">{organizationId}</div>,
}));

import { InviteMemberForm } from "../InviteMemberForm";

describe("InviteMemberForm", () => {
	it("offers the bulk invitation for this organization", () => {
		render(<InviteMemberForm organizationId="org_example" />);

		expect(screen.getByTestId("bulk-invite").textContent).toBe(
			"org_example",
		);
	});
});
