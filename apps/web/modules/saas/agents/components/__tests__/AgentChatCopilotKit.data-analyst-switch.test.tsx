import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatCopilotKit } from "../AgentChatCopilotKit";

const m = vi.hoisted(() => ({
	enabled: false,
	agentId: "data_analyst",
	configured: true,
	apiLoad: vi.fn(),
	documentLoad: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example-1",
		basePath: "/app/example-org",
		organizationName: "Example",
		isOrgContext: true,
	}),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => m.enabled,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { registry: { get: vi.fn() } } },
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) =>
		queryKey[0] === "aiConfigStatus"
			? { data: { isConfigured: m.configured }, isLoading: false }
			: {
					data: {
						agentId: m.agentId,
						displayName: "Example agent",
						metadata: null,
					},
					isLoading: false,
				},
}));
vi.mock("../AgentChatAPI", () => {
	m.apiLoad();
	return { AgentChatAPI: () => <div>API chat</div> };
});
vi.mock("../AgentChatCode", () => ({
	AgentChatCode: () => <div>Code chat</div>,
}));
vi.mock("../AgentChatDocument", () => {
	m.documentLoad();
	return { AgentChatDocument: () => <div>Document chat</div> };
});
vi.mock("../AgentChatGeneral", () => ({
	AgentChatGeneral: ({ runtimeUrl }: { runtimeUrl: string }) => (
		<div data-testid="legacy">{runtimeUrl}</div>
	),
}));
vi.mock("../data-analyst/DataAnalystChat", () => ({
	DataAnalystChat: ({ organizationId }: { organizationId: string }) => (
		<div data-testid="runtime">{organizationId}</div>
	),
}));
beforeEach(() => {
	m.enabled = false;
	m.agentId = "data_analyst";
	m.configured = true;
});

describe("Data Analyst chat rollout", () => {
	it("keeps the existing CopilotKit mount when off", async () => {
		render(<AgentChatCopilotKit agentId="registered-example" />);
		expect(await screen.findByTestId("legacy")).toHaveTextContent(
			"/api/copilotkit?organizationId=org-example-1",
		);
		expect(screen.queryByTestId("runtime")).toBeNull();
	});
	it("uses the runtime for Data Analyst only, with the organization on screen", async () => {
		m.enabled = true;
		const { rerender } = render(
			<AgentChatCopilotKit agentId="registered-example" />,
		);
		expect(screen.getByTestId("runtime")).toHaveTextContent(
			"org-example-1",
		);
		expect(m.apiLoad).not.toHaveBeenCalled();
		expect(m.documentLoad).not.toHaveBeenCalled();
		m.agentId = "another_agent";
		rerender(<AgentChatCopilotKit agentId="registered-other" />);
		expect(await screen.findByTestId("legacy")).toBeInTheDocument();
	});
	it("freezes the switch at mount", async () => {
		const { rerender } = render(
			<AgentChatCopilotKit agentId="registered-example" />,
		);
		m.enabled = true;
		rerender(<AgentChatCopilotKit agentId="registered-example" />);
		expect(await screen.findByTestId("legacy")).toBeInTheDocument();
	});
	it("retains the provider-not-configured state", () => {
		m.enabled = true;
		m.configured = false;
		render(<AgentChatCopilotKit agentId="registered-example" />);
		expect(
			screen.getByText("AI Provider Not Configured"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("runtime")).toBeNull();
	});
});
