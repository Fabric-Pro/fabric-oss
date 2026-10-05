import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AgentModelPicker } from "../AgentModelPicker";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	registry: vi.fn(),
	models: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { registry: { list: api.registry } },
		aiConfig: { models: { listAvailable: api.models } },
		agentTemplates: { instances: { list: api.list, get: api.get } },
	},
}));
vi.mock("@shared/lib/orpc-query-utils", async () => {
	const { createGeneralUtils } = await import("@orpc/tanstack-query");
	return {
		orpc: {
			agentTemplates: {
				instances: createGeneralUtils(["agentTemplates", "instances"]),
			},
		},
	};
});
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id: string) => id,
}));
vi.mock("../AgentIdentity", () => ({
	AgentAvatar: () => null,
	VendorLogo: () => null,
}));
it("renders authorized catalog versions without per-row instance reads", async () => {
	const instances = Array.from({ length: 100 }, (_, index) => ({
		id: `example-agent-${index}`,
		sId: `example-stable-${index}`,
		name: `Example Agent ${index}`,
		version: index + 2,
		organizationId: "example-org",
		status: "ACTIVE",
	}));
	api.list.mockResolvedValue({ instances });
	api.registry.mockResolvedValue({
		agents: [
			{ agentId: "registered-agent", displayName: "Registered Agent" },
		],
	});
	api.models.mockResolvedValue({ models: [] });
	api.get.mockImplementation(
		async ({ id, sId }: { id?: string; sId?: string }) => ({
			instance: {
				...instances.find((row) => row.id === id || row.sId === sId),
				version: 1,
			},
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<AgentModelPicker
				organizationId="example-org"
				selectedAgents={[]}
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Agents" }));
	await screen.findByRole("button", { name: /Example Agent 99/ });
	await waitFor(() => expect(client.isFetching()).toBe(0));
	expect(api.get).not.toHaveBeenCalled();
	expect(api.list).toHaveBeenCalledTimes(1);
	expect(api.registry).toHaveBeenCalledTimes(1);
	expect(api.models).toHaveBeenCalledTimes(1);
	expect(
		screen.getByRole("button", { name: "Example Agent 0 · v2" }),
	).toBeTruthy();
	expect(
		screen.getByRole("button", { name: "Example Agent 99 · v101" }),
	).toBeTruthy();
	expect(
		screen.getByRole("button", { name: "Registered Agent" }),
	).toBeTruthy();
	expect(screen.queryByText(/Registered Agent · v/)).toBeNull();
});
