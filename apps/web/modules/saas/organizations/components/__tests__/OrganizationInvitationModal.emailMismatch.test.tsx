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
	authClient: { signOut: (...args: unknown[]) => signOutMock(...args) },
}));

vi.mock("@saas/organizations/lib/api", () => ({
	organizationListQueryKey: ["organizations"],
}));
vi.mock("@saas/organizations/lib/invitation-actions", () => ({
	acceptOrganizationInvitation: vi.fn(),
	rejectOrganizationInvitation: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@saas/organizations/components/OrganizationLogo", () => ({
	OrganizationLogo: () => <div data-testid="org-logo" />,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OrganizationInvitationModal } from "../OrganizationInvitationModal";

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

describe("OrganizationInvitationModal — email_mismatch switch CTA", () => {
	const props = {
		invitationId: "inv-1",
		organizationName: "Acme",
		organizationSlug: "acme",
		state: {
			type: "email_mismatch" as const,
			invitationEmail: "b@example.com",
			currentEmail: "a@example.com",
		},
	};

	it("signs out, then navigates to /auth/login with invitationId+email", async () => {
		const user = userEvent.setup();
		render(<OrganizationInvitationModal {...props} />);

		await user.click(
			screen.getByRole("button", {
				name: /organizations\.invitationModal\.signInWithDifferentAccount/,
			}),
		);

		expect(signOutMock).toHaveBeenCalledTimes(1);
		expect(hrefValue).toBe(
			"https://app.example.test/auth/login?invitationId=inv-1&email=b%40example.com",
		);
		expect(callOrder).toEqual(["signOut", "navigate"]);
	});

	it("renders the actionable provider hint", () => {
		render(<OrganizationInvitationModal {...props} />);
		expect(
			screen.getByText(/organizations\.invitationModal\.providerHint/),
		).toBeInTheDocument();
	});
});
