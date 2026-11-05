import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	organizationId: "example-org" as string | undefined,
	skills: vi.fn(),
	workspaces: vi.fn(),
	mcp: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: h.organizationId }),
	useContextPath: () => "/app/example-org/agent-templates",
}));
vi.mock("@shared/hooks/use-available-models", () => ({
	useAvailableModels: () => ({
		modelsByProvider: {},
		sortedProviders: [],
		isLoading: false,
	}),
	getProviderDisplayName: (name: string) => name,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		skills: { list: h.skills },
		documentWorkspaces: { list: h.workspaces },
		mcp: { configs: { list: h.mcp } },
	},
}));
vi.mock("../AgentCapabilitiesPickerDialog", () => ({
	AgentCapabilitiesPickerDialog: () => null,
}));
vi.mock("../AgentInsightsSheet", () => ({ AgentInsightsSheet: () => null }));
vi.mock(
	"../../../data-connections/components/RetrievalStrategyCallout",
	() => ({ RetrievalStrategyCallout: () => null }),
);

import { CreateAgentDialog } from "../CreateAgentDialog";

beforeEach(() => {
	vi.clearAllMocks();
	h.organizationId = "example-org";
	h.skills.mockResolvedValue({ skills: [] });
	h.workspaces.mockResolvedValue({ workspaces: [] });
	h.mcp.mockResolvedValue([]);
});
it("mounts and resets the agent dialog using only the actual organization for skill, workspace and MCP catalogs", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = (open: boolean) => (
		<QueryClientProvider client={client}>
			<CreateAgentDialog open={open} onOpenChange={vi.fn()} />
		</QueryClientProvider>
	);
	const v = render(view(true));
	await waitFor(() =>
		expect(h.skills).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "example-org" }),
		),
	);
	expect(h.workspaces).toHaveBeenCalledWith(
		expect.objectContaining({ organizationId: "example-org" }),
	);
	expect(h.mcp).toHaveBeenCalledWith({ organizationId: "example-org" });
	expect(v.queryByText("Personal", { exact: true })).not.toBeInTheDocument();
	v.rerender(view(false));
	v.rerender(view(true));
	await waitFor(() => expect(h.skills.mock.calls.length).toBeGreaterThan(1));
	expect(
		h.skills.mock.calls.every(
			([input]) => input.organizationId === "example-org",
		),
	).toBe(true);
});
it("does not request a personal catalog when organization context is unresolved", () => {
	h.organizationId = undefined;
	render(
		<QueryClientProvider client={new QueryClient()}>
			<CreateAgentDialog open onOpenChange={vi.fn()} />
		</QueryClientProvider>,
	);
	expect(h.skills).not.toHaveBeenCalled();
	expect(h.workspaces).not.toHaveBeenCalled();
	expect(h.mcp).not.toHaveBeenCalled();
});
