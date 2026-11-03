import { isRetiredSystemAgent } from "@repo/agent-types";
import { OrganizationAgentChatView as ChatPage } from "@saas/agents/components/OrganizationAgentChatView";
import { RegisteredAgentTryWorkspace } from "@saas/agents/components/RegisteredAgentTryWorkspace";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CugaPage from "@/app/(saas)/app/(organizations)/[organizationSlug]/agents/cuga-generalist/page";

const m = vi.hoisted(() => ({
	agent: {
		agentId: "cuga_generalist",
		scope: "SYSTEM",
		displayName: "Example retired agent",
		deploymentUrl: "https://example.com",
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: m.agent, isLoading: false }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { registry: { get: vi.fn() } } },
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ agentId: "cexampleregistered00000001" }),
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/example-org" }),
}));
vi.mock("@saas/agents/components/AgentChatCopilotKit", () => ({
	AgentChatCopilotKit: () => <div data-testid="chat" />,
}));
vi.mock(
	"@saas/agents/components/FabricChat/FabricTemporalOrchestratorChat",
	() => ({
		FabricTemporalOrchestratorChat: () => <div data-testid="chat" />,
	}),
);
afterEach(cleanup);

describe("retired agent navigation", () => {
	it.each(["chat", "try"])(
		"does not mount a chat on a stale registered CUID %s link",
		(route) => {
			render(
				route === "chat" ? (
					<ChatPage
						agentId="cexampleregistered00000001"
						organization={{
							id: "example-org-id",
							slug: "example-org",
							name: "Example",
						}}
					/>
				) : (
					<RegisteredAgentTryWorkspace
						agentId="cexampleregistered00000001"
						basePath="/app/example-org"
						organizationId="example-org-id"
					/>
				),
			);
			expect(
				screen.getByRole("heading", { name: "Agent unavailable" }),
			).toBeDefined();
			expect(screen.queryByTestId("chat")).toBeNull();
		},
	);
	it("replaces the legacy showcase with an unavailable notice and Agents link", async () => {
		render(
			await CugaPage({
				params: Promise.resolve({ organizationSlug: "example-org" }),
			}),
		);
		expect(
			screen.getByRole("heading", { name: "Agent unavailable" }),
		).toBeDefined();
		expect(
			screen
				.getByRole("link", { name: "Back to Agents" })
				.getAttribute("href"),
		).toBe("/app/example-org/agents");
		expect(screen.queryByText("Try CUGA")).toBeNull();
	});
	it.each(["USER", "ORGANIZATION"])(
		"preserves %s custom agent identity",
		(scope) => {
			expect(
				isRetiredSystemAgent({ agentId: "cuga_generalist", scope }),
			).toBe(false);
			expect(
				isRetiredSystemAgent({
					agentId: "custom-cuga",
					scope: "SYSTEM",
				}),
			).toBe(false);
		},
	);
});
