import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const orgContextMock = vi.fn();
const accountBasePathMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
	useAccountBasePath: () => accountBasePathMock(),
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

function setupOrgContext({
	isGuest,
	ownBasePath = "/app/own-org",
}: {
	isGuest: boolean;
	ownBasePath?: string;
}) {
	orgContextMock.mockReturnValue({ basePath: "/app/org-1" });
	guestMock.mockReturnValue(isGuest);
	accountBasePathMock.mockReturnValue(ownBasePath);
}

function setupNoOrgContext() {
	orgContextMock.mockReturnValue({ basePath: "/app" });
	guestMock.mockReturnValue(false);
	accountBasePathMock.mockReturnValue("/app");
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

	// A guest browses under the HOST's slug, so `basePath` names an
	// organization they are not in. Home must reach one they are — their own,
	// never the host's, whose identity their chrome does not carry.
	it("points Home at their OWN org for project-only guests in an org", () => {
		setupOrgContext({ isGuest: true });
		render(<PageBreadcrumbs items={[{ label: "Projects" }]} />);

		const home = screen.getByRole("link", { name: /Home/ });
		expect(home).toHaveAttribute("href", "/app/own-org");
		expect(home).not.toHaveAttribute("href", "/app/org-1");
	});

	// The membership list is fetched on the client, so a guest's own slug is
	// briefly unknown. `/app` resolves the same question server-side — a
	// slower answer, not a wrong one, and still not the host's.
	it("sends a guest to /app while their own org is still unknown", () => {
		setupOrgContext({ isGuest: true, ownBasePath: "/app" });
		render(<PageBreadcrumbs items={[{ label: "Projects" }]} />);

		expect(screen.getByRole("link", { name: /Home/ })).toHaveAttribute(
			"href",
			"/app",
		);
	});

	// Twenty-three pages open their trail with the host org's NAME linked to
	// its root. A guest must read none of them, and the rule lives here rather
	// than in each page, so it is asserted here.
	it("drops the host-org crumb for a guest", () => {
		setupOrgContext({ isGuest: true });
		render(
			<PageBreadcrumbs
				items={[
					{ label: "Acme Corp", href: "/app/org-1" },
					{ label: "Agents" },
				]}
			/>,
		);

		expect(screen.queryByText("Acme Corp")).not.toBeInTheDocument();
		// The rest of the trail survives, and its last item is still the
		// current page rather than a link.
		expect(screen.getByText("Agents")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Agents" }),
		).not.toBeInTheDocument();
	});

	it("keeps the org crumb for a member", () => {
		setupOrgContext({ isGuest: false });
		render(
			<PageBreadcrumbs
				items={[
					{ label: "Acme Corp", href: "/app/org-1" },
					{ label: "Agents" },
				]}
			/>,
		);

		expect(screen.getByRole("link", { name: "Acme Corp" })).toHaveAttribute(
			"href",
			"/app/org-1",
		);
	});

	// The crumb is matched by where it points, so a guest keeps every crumb
	// that points somewhere else — including one that happens to share a label.
	it("drops only the crumb pointing at the host org root", () => {
		setupOrgContext({ isGuest: true });
		render(
			<PageBreadcrumbs
				items={[
					{ label: "Acme Corp", href: "/app/org-1" },
					{ label: "Acme Corp", href: "/app/org-1/projects" },
					{ label: "Agents" },
				]}
			/>,
		);

		expect(screen.getByRole("link", { name: "Acme Corp" })).toHaveAttribute(
			"href",
			"/app/org-1/projects",
		);
	});

	it("passes the context base path through when there is no org in the URL", () => {
		setupNoOrgContext();
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
