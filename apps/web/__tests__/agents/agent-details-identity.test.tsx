import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetailsPage from "@/app/(saas)/app/(organizations)/[organizationSlug]/agents/[agentId]/page";

const m = vi.hoisted(() => ({
	id: "example-agent",
	get: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ agentId: m.id }),
	useRouter: () => ({ push: m.push, replace: m.replace }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { registry: { get: m.get } } },
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		basePath: "/app/example-org",
		organizationId: "example-org",
	}),
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
	m.id = "example-agent";
});
afterEach(cleanup);

describe("agent details identity", () => {
	it("shows a deliberate retired notice for retired SYSTEM CUGA slugs", async () => {
		m.id = "cuga_generalist";
		m.get.mockResolvedValue({
			id: "cexampleregistered00000001",
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
		expect(m.replace).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: /Try/ })).toBeNull();
	});
	it("resolves slug registry IDs before redirecting to the directory drawer", async () => {
		m.id = "example-agent";
		m.get.mockResolvedValue({
			id: "cexampleregistered00000001",
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
		expect(m.get).toHaveBeenCalledWith({ id: "example-agent" });
		expect(m.replace).not.toHaveBeenCalled();
	});
	it("redirects template instance CUIDs immediately without querying the registry", async () => {
		m.id = "cexampleregistered00000001";
		mount();
		await waitFor(() =>
			expect(m.replace).toHaveBeenCalledWith(
				"/app/example-org/agents?agentId=cexampleregistered00000001",
				{ scroll: false },
			),
		);
		expect(m.get).not.toHaveBeenCalled();
	});
	it("redirects to the directory drawer after a registry miss on a slug", async () => {
		m.id = "example-agent";
		m.get.mockRejectedValue(new Error("Not found"));
		mount();
		await waitFor(() =>
			expect(m.replace).toHaveBeenCalledWith(
				"/app/example-org/agents?agentId=example-agent",
				{ scroll: false },
			),
		);
		expect(m.get).toHaveBeenCalledWith({ id: "example-agent" });
	});
});
