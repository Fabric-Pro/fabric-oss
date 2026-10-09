import { GET_STARTED_PROJECT_TAB_EVENT } from "@saas/get-started/lib/tour-steps";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectReadinessProvider } from "../ProjectReadinessProvider";

const { get, organization } = vi.hoisted(() => ({
	get: vi.fn(),
	organization: {
		organizationId: null as string | null,
		isResolvingOrganization: false,
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { readiness: { get, markSeen: vi.fn() } },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ ...organization }),
}));

vi.mock("next/navigation", () => ({
	useParams: () => ({ organizationSlug: "example-org", id: "project-1" }),
}));

const payload = {
	enabled: false,
	level: "READY",
	items: [],
	attention: { levelDropped: false, changes: [], autoExpandedAt: null },
};

function view(client: QueryClient) {
	return (
		<QueryClientProvider client={client}>
			<ProjectReadinessProvider projectId="project-1">
				<div />
			</ProjectReadinessProvider>
		</QueryClientProvider>
	);
}

describe("ProjectReadinessProvider reads", () => {
	it("reads once, for the organization, when the organization is still resolving at mount", async () => {
		get.mockReset();
		get.mockResolvedValue(payload);
		organization.organizationId = null;
		organization.isResolvingOrganization = true;
		const client = new QueryClient();
		const { rerender } = render(view(client));

		// A tab announcement in that window must not read either: `refetch()`
		// would otherwise bypass the query's `enabled`.
		act(() => {
			window.dispatchEvent(
				new CustomEvent(GET_STARTED_PROJECT_TAB_EVENT, {
					detail: { projectId: "project-1", tab: "overview" },
				}),
			);
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(get).not.toHaveBeenCalled();

		organization.organizationId = "org-1";
		organization.isResolvingOrganization = false;
		rerender(view(client));

		await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
		expect(get).toHaveBeenCalledWith({
			projectId: "project-1",
			organizationId: "org-1",
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("still re-reads when the page announces a tab change for this project, and not for another", async () => {
		get.mockReset();
		get.mockResolvedValue(payload);
		organization.organizationId = "org-1";
		organization.isResolvingOrganization = false;
		const client = new QueryClient();
		render(view(client));
		await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

		act(() => {
			window.dispatchEvent(
				new CustomEvent(GET_STARTED_PROJECT_TAB_EVENT, {
					detail: { projectId: "another-project", tab: "overview" },
				}),
			);
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(get).toHaveBeenCalledTimes(1);

		act(() => {
			window.dispatchEvent(
				new CustomEvent(GET_STARTED_PROJECT_TAB_EVENT, {
					detail: { projectId: "project-1", tab: "overview" },
				}),
			);
		});
		await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
	});
});
