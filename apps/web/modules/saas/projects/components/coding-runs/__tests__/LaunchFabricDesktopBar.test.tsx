import messages from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchFabricDesktopBar } from "../LaunchFabricDesktopBar";

const f = vi.hoisted(() => ({
	list: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { codingRuns: { remoteServers: { list: f.list } } },
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		organizationSlug: "example-team",
	}),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		messages.projects.remoteAgents.launcher[
			key as keyof typeof messages.projects.remoteAgents.launcher
		],
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: f.error } }));
vi.mock("../RemoteAgentServerPicker", () => ({
	RemoteAgentServerPicker: (p: {
		onChange: (id: string) => void;
		servers: { id: string; name: string }[];
	}) => (
		<section aria-label="Registered servers">
			{p.servers.map((s) => (
				<button
					type="button"
					key={s.id}
					onClick={() => p.onChange(s.id)}
				>
					{s.name}
				</button>
			))}
		</section>
	),
}));
vi.mock("@saas/projects/components/cli-connection/ConnectCliDialog", () => ({
	ConnectCliDialog: (p: { organizationId: string }) => (
		<div role="dialog">Connect MCP: {p.organizationId}</div>
	),
}));
const server = {
	id: "example-server",
	name: "Example shared server",
	scope: "TEAM",
	url: "https://agents.example.com",
	ownedByCaller: false,
};
function show(
	props: Partial<Parameters<typeof LaunchFabricDesktopBar>[0]> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<LaunchFabricDesktopBar
				projectId="example-project"
				projectName="Example project"
				{...props}
			/>
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	f.list.mockResolvedValue({
		enabled: true,
		canShare: false,
		servers: [server],
	});
});
describe("LaunchFabricDesktopBar", () => {
	it("opens Portal AI settings rather than requiring a desktop protocol handler", () => {
		show();
		expect(
			screen.getByTestId("launch-fabric-desktop-ai-settings"),
		).toHaveAttribute("href", "/app/example-team/settings/ai-providers");
	});
	it("offers desktop launch and installation instructions without invoking an unknown protocol immediately", () => {
		show();
		fireEvent.click(screen.getByTestId("launch-fabric-desktop-button"));
		expect(
			screen.getByRole("link", { name: "Open installed desktop app" }),
		).toHaveAttribute(
			"href",
			expect.stringContaining("fabricagents://action/new-chat?"),
		);
		expect(
			screen.getByRole("link", { name: "Get Fabric Desktop" }),
		).toHaveAttribute("href", "https://agents.fabric.pro");
	});
	it("explains desktop sources and provides a deliberate native link", () => {
		show();
		fireEvent.click(screen.getByTestId("launch-fabric-desktop-sources"));
		expect(
			screen.getByRole("link", { name: "Open installed desktop app" }),
		).toHaveAttribute("href", "fabricagents://sources");
	});
	it("loads registered servers in the explicit organization and retains the selection for real assignments", async () => {
		show();
		fireEvent.click(
			screen.getByTestId("delegate-remote-agent-server-button"),
		);
		await screen.findByText(server.name);
		expect(f.list).toHaveBeenCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
		});
		fireEvent.click(screen.getByText(server.name));
		expect(
			screen.getByRole("link", { name: "Open remote Web UI" }),
		).toHaveAttribute("href", "https://agents.example.com/");
		expect(
			screen.getByRole("link", { name: "Choose a feature to assign" }),
		).toHaveAttribute(
			"href",
			"/app/example-team/projects/example-project?tab=stories",
		);
		expect(
			localStorage.getItem(
				"fabric-project-delegation-prefs-example-project",
			),
		).toBeTruthy();
		expect(
			screen.queryByText(/credits.*verified|credits active/i),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("dispatch-remote-server-button"),
		).not.toBeInTheDocument();
	});
	it("does not show a fabricated remote address or verification when no servers are registered", async () => {
		f.list.mockResolvedValue({
			enabled: true,
			canShare: false,
			servers: [],
		});
		show();
		fireEvent.click(
			screen.getByTestId("delegate-remote-agent-server-button"),
		);
		await screen.findByLabelText("Registered servers");
		expect(
			screen.queryByRole("link", { name: "Open remote Web UI" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/credits.*verified|credits active/i),
		).not.toBeInTheDocument();
	});
	it("shows server load failure and allows retry", async () => {
		f.list.mockRejectedValueOnce(new Error("Example unavailable"));
		show();
		fireEvent.click(
			screen.getByTestId("delegate-remote-agent-server-button"),
		);
		await screen.findByRole("alert");
		f.list.mockResolvedValue({
			enabled: true,
			canShare: false,
			servers: [server],
		});
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByText(server.name);
	});
	it("uses the MCP sign-in dialog with the current organization in compact mode", () => {
		show({ compact: true });
		fireEvent.click(screen.getByTestId("launch-fabric-desktop-sso"));
		expect(screen.getByRole("dialog")).toHaveTextContent("example-org");
	});
	it("fails visibly when clipboard access is unavailable", async () => {
		vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
		show();
		fireEvent.click(screen.getByRole("button", { name: "Copy MCP URL" }));
		await waitFor(() => expect(f.error).toHaveBeenCalled());
		vi.unstubAllGlobals();
	});
});
