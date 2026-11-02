import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetailsPage from "@/app/(saas)/app/(organizations)/[organizationSlug]/agents/[agentId]/page";

const m = vi.hoisted(() => ({
	id: "cexampleregistered00000001",
	get: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ agentId: m.id }),
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { registry: { get: m.get } } },
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/example-org" }),
}));
vi.mock("@saas/agent-templates/components/AgentInstanceDetail", () => ({
	AgentInstanceDetail: ({ instanceId }: { instanceId: string }) => (
		<div data-testid="instance">{instanceId}</div>
	),
}));
vi.mock("@saas/shared/utils/generateHeroImage", () => ({
	generateHeroImage: () => "",
}));
vi.mock("@saas/workflows/lib/plugins/registry", () => ({
	getIntegration: () => null,
}));
vi.mock("@saas/agents/lib/builtin-capabilities", () => ({
	getAgentSelectionSummary: () => ({ skillDetails: [], capabilityIds: [] }),
	getBuiltInCapability: () => null,
	getCapabilityIcon: () => null,
}));

function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<AgentDetailsPage />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	m.id = "cexampleregistered00000001";
});
afterEach(cleanup);

describe("agent details identity", () => {
	it("shows a deliberate retired notice for stale registered SYSTEM CUGA CUIDs", async () => {
		m.get.mockResolvedValue({
			id: m.id,
			agentId: "cuga_generalist",
			scope: "SYSTEM",
		});
		mount();
		await screen.findByRole("heading", { name: "Agent unavailable" });
		expect(
			screen
				.getByRole("link", { name: "Back to Agents" })
				.getAttribute("href"),
		).toBe("/app/example-org/agents");
		expect(screen.queryByTestId("instance")).toBeNull();
		expect(screen.queryByRole("button", { name: /Try/ })).toBeNull();
	});
	it.each(["cexampleregistered00000001", "example-agent"])(
		"resolves registry ID %s before considering template instances",
		async (id) => {
			m.id = id;
			m.get.mockResolvedValue({
				id,
				agentId: "example-agent",
				name: "example-agent",
				displayName: "Example Registered Agent",
				framework: "A2A",
				status: "ACTIVE",
				scope: "SYSTEM",
				metadata: null,
			});
			mount();
			await screen.findByRole("heading", {
				name: "Example Registered Agent",
			});
			expect(m.get).toHaveBeenCalledWith({ id });
			expect(screen.queryByTestId("instance")).toBeNull();
		},
	);
	it("falls back to the actual instance resolver only after a registry miss", async () => {
		m.get.mockRejectedValue(new Error("Not found"));
		mount();
		await waitFor(() =>
			expect(screen.getByTestId("instance").textContent).toBe(m.id),
		);
		expect(m.get).toHaveBeenCalledWith({ id: m.id });
	});
});
