import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const orgContextMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
}));

const guestMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => guestMock(),
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

import { PageBreadcrumbs } from "../PageBreadcrumbs";

function setupOrgContext({ isGuest }: { isGuest: boolean }) {
	orgContextMock.mockReturnValue({ basePath: "/app/org-1" });
	guestMock.mockReturnValue(isGuest);
}

function setupPersonalContext() {
	orgContextMock.mockReturnValue({ basePath: "/app" });
	guestMock.mockReturnValue(false);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("PageBreadcrumbs — home href resolution", () => {
	it("points Home at the org base path for members in an org", () => {
		setupOrgContext({ isGuest: false });
		render(<PageBreadcrumbs items={[{ label: "Projects" }]} />);

		expect(screen.getByRole("link", { name: /Home/ })).toHaveAttribute(
			"href",
			"/app/org-1",
		);
	});

	it("falls back to the personal dashboard for project-only guests in an org", () => {
		setupOrgContext({ isGuest: true });
		render(<PageBreadcrumbs items={[{ label: "Projects" }]} />);

		expect(screen.getByRole("link", { name: /Home/ })).toHaveAttribute(
			"href",
			"/app",
		);
	});

	it("points Home at the personal base path in personal context", () => {
		setupPersonalContext();
		render(<PageBreadcrumbs items={[{ label: "Projects" }]} />);

		expect(screen.getByRole("link", { name: /Home/ })).toHaveAttribute(
			"href",
			"/app",
		);
	});

	it("lets an explicit homeHref prop win over the context fallback", () => {
		setupOrgContext({ isGuest: false });
		render(
			<PageBreadcrumbs
				homeHref="/custom-home"
				items={[{ label: "Projects" }]}
			/>,
		);

		expect(screen.getByRole("link", { name: /Home/ })).toHaveAttribute(
			"href",
			"/custom-home",
		);
	});

	it("renders intermediate items as links and the last item as the current page", () => {
		setupOrgContext({ isGuest: false });
		render(
			<PageBreadcrumbs
				items={[
					{ label: "Acme Corp", href: "/app/org-1" },
					{ label: "Projects" },
				]}
			/>,
		);

		expect(screen.getByRole("link", { name: "Acme Corp" })).toHaveAttribute(
			"href",
			"/app/org-1",
		);
		const current = screen.getByText("Projects");
		expect(current).toHaveAttribute("aria-current", "page");
	});
});
