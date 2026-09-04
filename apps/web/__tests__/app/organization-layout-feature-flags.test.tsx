/**
 * The organization layout mounts a SECOND FeatureFlagProvider whose values are
 * resolved for that organization. `useFeatureFlag` reads the nearest context,
 * so this one shadows the account-wide provider in `(saas)/app/layout.tsx` for
 * everything rendered under `/app/{slug}`.
 *
 * The test renders a probe through the real layout rather than asserting on the
 * returned element tree: walking `props.children` would pass against a provider
 * mounted in the wrong place, and nesting order is the whole point here.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeatureFlag } from "../../modules/saas/shared/components/FeatureFlagProvider";

const getAllFlagsForOrganization = vi.fn();

vi.mock("@repo/database", () => ({
	getAllFlagsForOrganization: (...args: unknown[]) =>
		getAllFlagsForOrganization(...args),
	getOrganizationRequireTwoFactor: vi.fn(async () => false),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getActiveOrganization: vi.fn(async () => ({
		id: "org-1",
		slug: "example-org",
		metadata: null,
	})),
	getSession: vi.fn(async () => ({
		user: { id: "user-1", twoFactorEnabled: true },
	})),
	isGuestInOrg: vi.fn(async () => false),
}));

// Presentation-only wrappers between the layout root and `children`. Stubbed to
// passthroughs so this test exercises provider nesting, not the app shell.
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
	// Not a null stub: this banner is a sibling ABOVE {children}, so it is the
	// only probe that can tell "provider wraps the whole tree" apart from
	// "provider wraps only children". A provider narrowed to {children} leaves
	// this component with no context at all, and useFeatureFlag throws.
	//
	// It carries the probe because it is the banner left in that slot — the
	// credits banner that used to hold it is gone. Whatever occupies the slot
	// next inherits the probe; the slot must never go unprobed.
	MfaSetupBanner: () => (
		<span data-testid="banner-probe">
			{useFeatureFlag("PUBLISHING_SUITE") ? "on" : "off"}
		</span>
	),
}));
vi.mock("@shared/lib/server", () => ({
	getServerQueryClient: () => ({
		prefetchQuery: vi.fn(async () => undefined),
		removeQueries: vi.fn(),
	}),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			listPurchases: {
				queryOptions: () => ({ queryKey: ["purchases"] }),
			},
		},
	},
}));
vi.mock("@saas/organizations/lib/api", () => ({
	activeOrganizationQueryKey: (slug: string) =>
		["user", "activeOrganization", slug] as const,
}));

function Probe() {
	return (
		<span data-testid="probe">
			{useFeatureFlag("PUBLISHING_SUITE") ? "on" : "off"}
		</span>
	);
}

async function renderLayout() {
	const { default: OrganizationLayout } = await import(
		"../../app/(saas)/app/(organizations)/[organizationSlug]/layout"
	);
	const tree = await OrganizationLayout({
		children: <Probe />,
		params: Promise.resolve({ organizationSlug: "example-org" }),
	});
	render(tree);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("organization layout feature flags", () => {
	it("an enrolled organization sees the flag ON", async () => {
		getAllFlagsForOrganization.mockResolvedValue({
			PUBLISHING_SUITE: true,
		});

		await renderLayout();

		expect(screen.getByTestId("probe")).toHaveTextContent("on");
		// The banner sits ABOVE {children} as a sibling — asserting it here
		// proves the provider wraps the whole tree, not just {children}.
		expect(screen.getByTestId("banner-probe")).toHaveTextContent("on");
	});

	it("a non-enrolled organization sees the flag OFF", async () => {
		getAllFlagsForOrganization.mockResolvedValue({
			PUBLISHING_SUITE: false,
		});

		await renderLayout();

		expect(screen.getByTestId("probe")).toHaveTextContent("off");
		expect(screen.getByTestId("banner-probe")).toHaveTextContent("off");
	});

	it("resolves against the organization ID, never the slug", async () => {
		// The slug is what the URL carries and the id is what the override
		// table keys on. Passing the slug would resolve nothing and quietly
		// fall through to the global value for every organization.
		getAllFlagsForOrganization.mockResolvedValue({
			PUBLISHING_SUITE: true,
		});

		await renderLayout();

		expect(getAllFlagsForOrganization).toHaveBeenCalledWith("org-1");
	});
});
