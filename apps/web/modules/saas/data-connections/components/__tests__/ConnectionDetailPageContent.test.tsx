vi.mock("../ResourceManagementPanel", () => ({
	ResourceManagementPanel: () => null,
}));

import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactElement } from "react";

const render = (ui: ReactElement) =>
	baseRender(<NuqsTestingAdapter>{ui}</NuqsTestingAdapter>);

/**
 * Tests for the connection-detail page's not-found card.
 *
 * The card's back button used to be named for Integrations even though its
 * href resolves to the Connections page, so this pins the corrected label.
 * The page composes several unrelated systems (organization context, the
 * connection query, sync progress, mutations), so we mock at the boundary in
 * the same style as the sibling `IntegrationProviderPageContent` test and
 * drive the component straight into its `!connection` branch.
 */

import {
	render as baseRender,
	fireEvent,
	screen,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (path: string) => `/app/example-org/${path}`,
	useOrganizationContext: () => ({ organizationId: null }),
}));

const fixture = vi.hoisted(() => ({
	connection: null as unknown,
	query: {} as { queryFn?: () => unknown },
}));
// No connection and not loading -- the not-found card.
vi.mock("../../hooks/useConnection", () => ({
	useConnection: () => ({
		data: fixture.connection,
		isLoading: false,
		refetch: vi.fn(),
	}),
}));

vi.mock("../../hooks/useSyncProgress", () => ({
	useSyncProgress: () => ({ data: null }),
}));

vi.mock("../../hooks/useConnections", () => ({
	useDeleteConnection: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateConnection: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		dataConnections: {
			resources: { list: vi.fn() },
			linkWorkflow: vi.fn(),
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	keepPreviousData: (previous: unknown) => previous,
	useQuery: (options: { queryFn: () => unknown }) => {
		fixture.query = options;
		return {
			data: {
				resources: [
					{
						id: "example-resource",
						name: "Example resource",
						title: "Example resource",
						syncStatus: "SYNCED",
						resourceType: "DOCUMENT",
						updatedAt: "2026-01-01",
					},
				],
			},
			isLoading: false,
			isError: false,
		};
	},
	useMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn().mockResolvedValue(undefined),
		isPending: false,
		reset: vi.fn(),
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ConnectionDetailPageContent } from "../ConnectionDetailPageContent";

describe("ConnectionDetailPageContent — not-found card", () => {
	it("names the back link for Connections and keeps it routed to settings/integrations", () => {
		render(<ConnectionDetailPageContent connectionId="conn-missing" />);

		const backLink = screen.getByRole("link", {
			name: /Back to Connections/i,
		});
		expect(backLink).toBeInTheDocument();
		// The label was the bug, not the route: `settings/integrations`
		// redirects to `/connections`.
		expect(backLink).toHaveAttribute(
			"href",
			"/app/example-org/settings/integrations",
		);
	});
});

it("jumps to the requested resource offset", () => {
	fixture.connection = {
		id: "example-connection",
		name: "Example connection",
		provider: "NOTION",
		status: "CONNECTED",
		config: {},
		syncJobs: [],
		schedules: [],
		_count: { syncedResources: 35, syncJobs: 0 },
	};
	render(<ConnectionDetailPageContent connectionId="example-connection" />);
	const input = screen.getByRole("spinbutton");
	fireEvent.change(input, { target: { value: "3" } });
	const form = input.closest("form");
	if (!form) {
		throw new Error("Expected pagination form");
	}
	fireEvent.submit(form);
	fixture.query.queryFn?.();
	expect(orpcClient.dataConnections.resources.list).toHaveBeenLastCalledWith(
		expect.objectContaining({ offset: 20, limit: 10 }),
	);
	fixture.connection = null;
});

import { orpcClient } from "@shared/lib/orpc-client";
