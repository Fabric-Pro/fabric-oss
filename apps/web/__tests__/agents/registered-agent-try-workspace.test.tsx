import { RegisteredAgentTryWorkspace } from "@saas/agents/components/RegisteredAgentTryWorkspace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getAgent: vi.fn() }));

vi.mock("@repo/config", () => ({
	config: { ui: { saas: { useSidebarLayout: true } } },
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { registry: { get: m.getAgent } } },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock(
	"@saas/agents/components/FabricChat/FabricTemporalOrchestratorChat",
	() => ({
		FabricTemporalOrchestratorChat: ({
			organizationId,
			enabledAgentIds,
		}: {
			organizationId?: string;
			enabledAgentIds: string[];
		}) => (
			<div
				data-testid="focused-workspace"
				data-organization-id={organizationId}
			>
				{enabledAgentIds.join(",")}
			</div>
		),
	}),
);

let queryClient: QueryClient;

function workspace(organizationId?: string | null) {
	return (
		<QueryClientProvider client={queryClient}>
			<RegisteredAgentTryWorkspace
				agentId="example-agent"
				basePath="/app/example-org"
				organizationId={organizationId}
			/>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	m.getAgent.mockReset();
	m.getAgent.mockResolvedValue({
		agentId: "data_analyst",
		scope: "SYSTEM",
		displayName: "Example analyst",
		deploymentUrl: "https://example.com",
	});
});

afterEach(() => {
	cleanup();
	queryClient.clear();
});

describe("registered agent Try organization readiness", () => {
	it.each([null, undefined])(
		"waits for an organization before fetching from %s context",
		async (organizationId) => {
			const view = render(workspace(organizationId));
			await act(async () => {
				await Promise.resolve();
			});

			expect(m.getAgent).not.toHaveBeenCalled();
			expect(screen.getByText("Loading agent...")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).toBeNull();
			expect(screen.queryByTestId("focused-workspace")).toBeNull();

			view.rerender(workspace("example-org-id"));

			expect(
				await screen.findByTestId("focused-workspace"),
			).toHaveAttribute("data-organization-id", "example-org-id");
			expect(screen.getByTestId("focused-workspace")).toHaveTextContent(
				"data_analyst",
			);
			expect(m.getAgent).toHaveBeenCalledExactlyOnceWith({
				id: "example-agent",
				organizationId: "example-org-id",
			});

			view.rerender(workspace(null));
			expect(screen.getByText("Loading agent...")).toBeInTheDocument();
			expect(screen.queryByTestId("focused-workspace")).toBeNull();
			expect(m.getAgent).toHaveBeenCalledTimes(1);
		},
	);

	it("shows a scoped fetch failure instead of mounting the chat", async () => {
		m.getAgent.mockRejectedValue(new Error("Agent access denied"));

		render(workspace("example-org-id"));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Agent access denied",
		);
		expect(screen.queryByTestId("focused-workspace")).toBeNull();
		expect(m.getAgent).toHaveBeenCalledExactlyOnceWith({
			id: "example-agent",
			organizationId: "example-org-id",
		});
	});
});
