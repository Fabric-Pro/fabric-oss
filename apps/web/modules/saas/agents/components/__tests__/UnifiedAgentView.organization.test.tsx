import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	organizationId: "example-org" as string | undefined,
	registry: vi.fn(),
	instances: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: h.organizationId,
		basePath: "/app/example-org",
		isOrgContext: !!h.organizationId,
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { registry: { list: h.registry } },
		agentTemplates: { instances: { list: h.instances, delete: h.remove } },
	},
}));
vi.mock("@shared/lib/orpc-query-utils", async () => {
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const { orpcClient } = await import("@shared/lib/orpc-client");
	return { orpc: createTanstackQueryUtils(orpcClient) };
});
vi.mock("../AgentsHero", () => ({ AgentsHero: () => <h1>Agents</h1> }));
vi.mock("../FeaturedAgentCard", () => ({ FeaturedAgentCard: () => null }));
vi.mock("../AgentCard", () => ({ AgentCard: () => null }));
vi.mock("../InstanceAgentCard", () => ({ InstanceAgentCard: () => null }));
vi.mock("../UnifiedAgentListView", () => ({
	UnifiedAgentListView: ({
		items,
		onDeleteInstance,
	}: {
		items: Array<{ id: string; name: string }>;
		onDeleteInstance: (id: string) => void;
	}) => (
		<ul>
			{items.map((item) => (
				<li key={item.id}>
					{item.name}
					<button
						type="button"
						onClick={() => onDeleteInstance(item.id)}
					>
						Delete {item.name}
					</button>
				</li>
			))}
		</ul>
	),
}));

import { UnifiedAgentView } from "../UnifiedAgentView";

function page() {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<UnifiedAgentView />
		</QueryClientProvider>
	);
}
beforeEach(() => {
	h.remove.mockReset();
	h.organizationId = "example-org";
	h.registry.mockReset().mockResolvedValue({ agents: [] });
	h.instances.mockReset().mockResolvedValue({
		instances: [
			{
				id: "example-active",
				name: "Organization agent",
				organizationId: "example-org",
			},
			{
				id: "example-legacy",
				name: "Legacy personal agent",
				organizationId: null,
			},
			{
				id: "example-other",
				name: "Other organization agent",
				organizationId: "example-other-org",
			},
		],
	});
});
describe("organization-only agents catalog", () => {
	it("refreshes the real list query after deletion without requiring a reload", async () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		h.remove.mockImplementation(async () => {
			h.instances.mockResolvedValue({ instances: [] });
			return { success: true };
		});
		const view = render(page());
		await view.findByText("Organization agent");
		fireEvent.click(
			view.getByRole("button", { name: "Delete Organization agent" }),
		);
		await waitFor(() =>
			expect(
				view.queryByText("Organization agent"),
			).not.toBeInTheDocument(),
		);
		expect(h.remove).toHaveBeenCalledWith(
			{ id: "example-active", organizationId: "example-org" },
			expect.anything(),
		);
		confirm.mockRestore();
	});
	it("shows only current organization instances even if a response contains legacy or other organization data", async () => {
		const view = render(page());
		await view.findByText("Organization agent");
		expect(
			view.queryByText("Legacy personal agent"),
		).not.toBeInTheDocument();
		expect(
			view.queryByText("Other organization agent"),
		).not.toBeInTheDocument();
		expect(
			view.queryByRole("button", { name: /Personal/ }),
		).not.toBeInTheDocument();
		fireEvent.click(view.getByRole("button", { name: /^All / }));
		expect(view.getByText("Organization agent")).toBeInTheDocument();
		expect(
			view.queryByText("Legacy personal agent"),
		).not.toBeInTheDocument();
	});
	it("waits for the organization before fetching agents", async () => {
		h.organizationId = undefined;
		const view = render(page());
		await waitFor(() =>
			expect(
				view.getByRole("heading", { name: "Agents" }),
			).toBeInTheDocument(),
		);
		expect(h.registry).not.toHaveBeenCalled();
		expect(h.instances).not.toHaveBeenCalled();
		h.organizationId = "example-org";
		view.rerender(page());
		await view.findByText("Organization agent");
		expect(h.registry).toHaveBeenCalledTimes(1);
		expect(h.instances).toHaveBeenCalledTimes(1);
	});
});
