import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			registry: {
				get: async () => ({ id: "example-agent", metadata: null }),
			},
		},
	},
}));
vi.mock("../EditRegisteredAgentPage", () => ({
	EditRegisteredAgentPage: () => <div>External agent fields</div>,
}));
vi.mock("@saas/agent-templates/components/AgentInstanceEdit", () => ({
	AgentInstanceEdit: () => <div>Native agent fields</div>,
}));

import { AgentEditRouter } from "../AgentEditRouter";

it("keeps external agent configuration scrollable inside the dedicated shell and provides an exit", async () => {
	const v = render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<AgentEditRouter
				agentId="example-agent"
				organizationId="example-org"
				basePath="/app/example-org"
			/>
		</QueryClientProvider>,
	);
	await v.findByText("External agent fields");
	expect(
		v.getByRole("region", { name: "External agent configuration" }),
	).toHaveClass("overflow-y-auto");
	expect(v.getByRole("link", { name: "Close agent editor" })).toHaveAttribute(
		"href",
		"/app/example-org/agents/example-agent",
	);
});
