import { OrganizationAgentChatView } from "@saas/agents/components/OrganizationAgentChatView";
import { RegisteredAgentTryWorkspace } from "@saas/agents/components/RegisteredAgentTryWorkspace";
import {
	FullscreenProvider,
	useFullscreen,
} from "@saas/shared/contexts/FullscreenContext";
import {
	SidebarCollapseProvider,
	useSidebarCollapse,
} from "@saas/shared/contexts/SidebarCollapseContext";
import {
	SHELL_LAUNCHER_CLEARANCE_CLASS,
	shellDockOffsetClass,
} from "@saas/shared/lib/shell-layout";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ useSidebarLayout: true }));

vi.mock("@repo/config", () => ({
	config: { ui: { saas: settings } },
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: {
			agentId: "data_analyst",
			scope: "SYSTEM",
			displayName: "Example analyst",
			deploymentUrl: "https://example.com",
		},
		isLoading: false,
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { registry: { get: vi.fn() } } },
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ agentId: "example-agent" }),
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/example-org" }),
}));
vi.mock("@saas/agents/components/AgentChatCopilotKit", () => ({
	AgentChatCopilotKit: () => <div>Chat content</div>,
}));
vi.mock(
	"@saas/agents/components/FabricChat/FabricTemporalOrchestratorChat",
	() => ({
		FabricTemporalOrchestratorChat: () => <div>Chat content</div>,
	}),
);

function ShellControls() {
	const { toggleCollapsed } = useSidebarCollapse();
	const { isFullscreen, setIsFullscreen } = useFullscreen();
	return (
		<>
			<button type="button" onClick={toggleCollapsed}>
				Toggle sidebar
			</button>
			<button
				type="button"
				onClick={() => setIsFullscreen(!isFullscreen)}
			>
				Toggle fullscreen
			</button>
		</>
	);
}

beforeEach(() => {
	localStorage.clear();
	settings.useSidebarLayout = true;
});
afterEach(cleanup);

describe.each([
	[
		"chat",
		<OrganizationAgentChatView
			key="chat"
			agentId="example-agent"
			organization={{
				id: "example-org-id",
				slug: "example-org",
				name: "Example",
			}}
		/>,
	],
	[
		"try",
		<RegisteredAgentTryWorkspace
			key="try"
			agentId="example-agent"
			basePath="/app/example-org"
			organizationId="example-org-id"
		/>,
	],
])("%s workspace shell", (_route, workspace) => {
	it("follows sidebar changes and keeps the fullscreen compact rail clear", () => {
		const { container } = render(
			<SidebarCollapseProvider>
				<FullscreenProvider>
					{workspace}
					<ShellControls />
				</FullscreenProvider>
			</SidebarCollapseProvider>,
		);
		const frame = container.firstElementChild;
		expect(frame).toHaveClass(shellDockOffsetClass(false));

		fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
		expect(frame).toHaveClass(shellDockOffsetClass(true));
		fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
		expect(frame).toHaveClass(shellDockOffsetClass(false));

		fireEvent.click(
			screen.getByRole("button", { name: "Toggle fullscreen" }),
		);
		expect(frame).toHaveClass(shellDockOffsetClass(true));
		fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
		expect(frame).toHaveClass(shellDockOffsetClass(true));
		fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
		expect(frame).toHaveClass(shellDockOffsetClass(true));
		fireEvent.click(
			screen.getByRole("button", { name: "Toggle fullscreen" }),
		);
		expect(frame).toHaveClass(shellDockOffsetClass(false));
	});

	it("does not reserve sidebar space when the shell has no sidebar", () => {
		settings.useSidebarLayout = false;
		const { container } = render(workspace);
		expect(container.firstElementChild).not.toHaveClass(
			shellDockOffsetClass(false),
		);
		expect(container.firstElementChild).not.toHaveClass(
			shellDockOffsetClass(true),
		);
		expect(container.firstElementChild).not.toHaveClass("top-16");
	});

	it.each([true, false])(
		"keeps content clear of the launcher with sidebar layout %s",
		(useSidebarLayout) => {
			settings.useSidebarLayout = useSidebarLayout;
			const { container } = render(workspace);
			expect(container.firstElementChild).toHaveClass(
				SHELL_LAUNCHER_CLEARANCE_CLASS,
			);
		},
	);
});
