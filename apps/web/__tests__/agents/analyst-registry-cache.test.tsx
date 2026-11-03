import { OrganizationAgentChatView } from "@saas/agents/components/OrganizationAgentChatView";
import { createQueryClient } from "@shared/lib/query-client";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getAgent: vi.fn(async (input: { id: string }) => ({
		id: input.id,
		agentId: "data_analyst",
		scope: "SYSTEM",
		displayName: "Example analyst",
		metadata: null,
	})),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { registry: { get: m.getAgent } },
		aiConfig: {
			resolution: { getStatus: async () => ({ isConfigured: true }) },
		},
	},
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id?: string | null) =>
		id === undefined ? "org-example" : id,
	useOrganizationContext: () => ({
		organizationId: "org-example",
		organizationName: "Example",
		basePath: "/app/example",
		isOrgContext: true,
	}),
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ isFullscreen: false }),
}));
vi.mock("@saas/shared/contexts/SidebarCollapseContext", () => ({
	useSidebarCollapse: () => ({ isCollapsed: false }),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));
vi.mock("@saas/agents/components/AgentChatAPI", () => ({
	AgentChatAPI: () => null,
}));
vi.mock("@saas/agents/components/AgentChatDocument", () => ({
	AgentChatDocument: () => null,
}));
vi.mock("@saas/agents/components/AgentChatGeneral", () => ({
	AgentChatGeneral: () => null,
}));
vi.mock("@saas/agents/components/data-analyst/DataAnalystChat", () => ({
	DataAnalystChat: () => <div>Analyst runtime ready</div>,
}));

afterEach(cleanup);

describe("Analyst registry cache", () => {
	it("reuses the view's completed registry read when its chat mounts", async () => {
		const queryClient = createQueryClient();
		const view = render(
			<QueryClientProvider client={queryClient}>
				<OrganizationAgentChatView
					agentId="registered-analyst"
					organization={{
						id: "org-example",
						slug: "example",
						name: "Example",
					}}
				/>
			</QueryClientProvider>,
		);
		try {
			await screen.findByText("Analyst runtime ready");
			await waitFor(() => expect(queryClient.isFetching()).toBe(0));
			expect(m.getAgent).toHaveBeenCalledTimes(1);
			expect(m.getAgent.mock.calls[0]?.[0]).toMatchObject({
				id: "registered-analyst",
				organizationId: "org-example",
			});
			view.rerender(
				<QueryClientProvider client={queryClient}>
					<OrganizationAgentChatView
						agentId="registered-analyst"
						organization={{
							id: "org-example",
							slug: "example",
							name: "Example",
						}}
					/>
				</QueryClientProvider>,
			);
			expect(
				screen.getByText("Analyst runtime ready"),
			).toBeInTheDocument();
			expect(m.getAgent).toHaveBeenCalledTimes(1);
		} finally {
			view.unmount();
			queryClient.clear();
		}
	});
});
