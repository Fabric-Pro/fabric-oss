import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AgentModelPicker } from "../AgentModelPicker";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { registry: { list: async () => ({ agents: [] }) } },
		aiConfig: { models: { listAvailable: async () => ({ models: [] }) } },
		agentTemplates: {
			instances: {
				list: async () => ({
					instances: [
						{
							id: "example-agent",
							name: "Example Agent",
							toolConnections: {
								"project-context": {
									enabled: true,
									projectId: "example-project",
								},
							},
						},
					],
				}),
			},
		},
	},
}));
vi.mock("../AgentIdentity", () => ({
	AgentAvatar: () => null,
	VendorLogo: () => null,
}));

it("preserves configured Project Context when selecting an instance in the shared picker", async () => {
	const picked = vi.fn();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<AgentModelPicker
				organizationId="example-org"
				selectedAgents={[]}
				onToggleAgent={picked}
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Agents" }));
	fireEvent.click(
		await screen.findByRole("button", { name: /Example Agent/ }),
	);
	expect(picked).toHaveBeenCalledWith(
		expect.objectContaining({
			instanceId: "example-agent",
			boundProjectId: "example-project",
			enabledFabricToolIds: expect.arrayContaining([
				"project_rag_query",
				"fabric_list_project_sources",
			]),
		}),
	);
});
