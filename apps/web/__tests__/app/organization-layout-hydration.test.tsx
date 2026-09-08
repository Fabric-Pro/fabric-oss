/**
 * The organization layout prefetches the active organization on the server, but
 * a prefetch is only half of the handover: what reaches the browser is the
 * snapshot a `<HydrationBoundary>` takes, not the request-scoped cache itself.
 *
 * `(saas)/layout.tsx` builds its snapshot when it returns its JSX — before this
 * layout has run — so a prefetch made here lands in the shared cache AFTER that
 * snapshot was taken. Without a boundary of its own, the organization the server
 * already resolved never ships, and every client consumer starts cold and
 * refetches it. The switcher's fallback then names a personal account for as
 * long as that round-trip takes.
 *
 * So this asserts the handover, not the prefetch: a client component reading the
 * active-organization key must have it on FIRST render, with no fetch.
 */

import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../modules/shared/lib/query-client";

vi.mock("@repo/database", () => ({
	getAllFlagsForOrganization: vi.fn(async () => ({})),
	getOrganizationRequireTwoFactor: vi.fn(async () => false),
}));

const ORGANIZATION = {
	id: "org-1",
	slug: "example-org",
	name: "Example Org",
	logo: null,
	metadata: null,
};

vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: vi.fn(async () => ORGANIZATION),
	getSession: vi.fn(async () => ({
		user: { id: "user-1", twoFactorEnabled: true },
	})),
	isGuestInOrg: vi.fn(async () => false),
}));

// Presentation-only wrappers between the layout root and `children`, stubbed to
// passthroughs so this test exercises the data handover and nothing else.
vi.mock("@saas/organizations/components/OrganizationThemeProvider", () => ({
	OrganizationThemeProvider: ({
		children,
	}: {
		children: React.ReactNode;
	}) => <>{children}</>,
}));
vi.mock("@saas/organizations/lib/organization-guest-context", () => ({
	OrganizationGuestProvider: ({
		children,
	}: {
		children: React.ReactNode;
	}) => <>{children}</>,
}));
vi.mock("@saas/shared/components/AppWrapper", () => ({
	AppWrapper: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@saas/shared/components/MfaSetupBanner", () => ({
	MfaSetupBanner: () => null,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	FeatureFlagProvider: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
}));

// The real request-scoped client, so what the layout prefetches is what this
// test dehydrates — a stub would make the assertion vacuous.
let serverQueryClient: ReturnType<typeof createQueryClient>;
vi.mock("@shared/lib/server", () => ({
	getServerQueryClient: () => serverQueryClient,
}));

import { activeOrganizationQueryKey } from "../../modules/saas/organizations/lib/api";

const queryFn = vi.fn(async () => {
	throw new Error("must not fetch — the server already resolved this");
});

function ActiveOrganizationProbe() {
	const { data } = useQuery({
		queryKey: activeOrganizationQueryKey("example-org"),
		queryFn,
	});
	return <span data-testid="probe">{data?.name ?? "not-seeded"}</span>;
}

async function renderLayout() {
	const { default: OrganizationLayout } = await import(
		"../../app/(saas)/app/(organizations)/[organizationSlug]/layout"
	);
	const tree = await OrganizationLayout({
		children: <ActiveOrganizationProbe />,
		params: Promise.resolve({ organizationSlug: "example-org" }),
	});

	// A fresh browser-side client: it starts empty, exactly as it does on a
	// real page load, so anything the probe sees came from the layout. Built by
	// the app's own factory rather than a bare `new QueryClient()` — the default
	// `staleTime` of 0 would mark the freshly hydrated entry stale on arrival and
	// refetch it, which is an artefact of the bare client and not what ships.
	render(
		<QueryClientProvider client={createQueryClient()}>
			{tree}
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	serverQueryClient = createQueryClient();
});

describe("organization layout — server-resolved organization reaches the client", () => {
	it("seeds the active organization so a client consumer has it on first render", async () => {
		await renderLayout();

		expect(screen.getByTestId("probe")).toHaveTextContent("Example Org");
	});

	it("does not make the client refetch what the server already resolved", async () => {
		await renderLayout();

		expect(queryFn).not.toHaveBeenCalled();
	});
});
