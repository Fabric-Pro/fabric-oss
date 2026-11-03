import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, expect, it, vi } from "vitest";
import { LaunchFabricDesktopBar } from "../LaunchFabricDesktopBar";

const f = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { codingRuns: { remoteServers: { list: f.list } } },
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "example-org" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
	localStorage.clear();
	vi.clearAllMocks();
});
function mount(enabled = true, team = true) {
	f.list.mockResolvedValue({
		enabled,
		servers: team
			? [
					{
						id: "example-team",
						name: "Team server",
						scope: "TEAM",
						url: "https://team.example.com",
					},
				]
			: [],
	});
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<LaunchFabricDesktopBar
				projectId="example-project"
				projectName="Example"
				webUiUrl="https://private.example.com"
			/>
		</QueryClientProvider>,
	);
}
it("uses the registered team URL without claiming verified credits and toasts only after opening", async () => {
	mount();
	fireEvent.click(
		await screen.findByTestId("delegate-remote-agent-server-button"),
	);
	expect(
		screen.queryByText(/Credits (Verified|Active)/i),
	).not.toBeInTheDocument();
	expect(screen.getByTestId("open-remote-server-webui-link")).toHaveAttribute(
		"href",
		expect.stringContaining("https://team.example.com/?"),
	);
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	fireEvent.click(screen.getByTestId("dispatch-remote-server-button"));
	expect(toast.success).not.toHaveBeenCalled();
	open.mockReturnValue({ opener: window } as Window);
	fireEvent.click(screen.getByTestId("dispatch-remote-server-button"));
	expect(toast.success).toHaveBeenCalledWith(
		"Opened Team server in a new tab",
	);
	open.mockRestore();
});
it("uses PRIVATE effectively without overwriting TEAM preference when no team server exists", async () => {
	const {
		saveProjectDelegationPreferences,
		DEFAULT_PROJECT_DELEGATION_PREFERENCES,
	} = await import("../../../lib/implementation-session-labels");
	saveProjectDelegationPreferences("example-project", {
		...DEFAULT_PROJECT_DELEGATION_PREFERENCES,
		preferredServerScope: "TEAM",
	});
	const storedPreference = localStorage.getItem(
		"fabric-project-delegation-prefs-example-project",
	);
	mount(true, false);
	fireEvent.click(
		await screen.findByTestId("delegate-remote-agent-server-button"),
	);
	expect(
		screen.getByRole("button", { name: "Company Server" }),
	).toBeDisabled();
	expect(screen.getByTestId("dispatch-remote-server-button")).toBeEnabled();
	expect(
		screen.getByRole("button", { name: "Local Server" }),
	).toHaveAttribute("aria-pressed", "true");
	expect(
		screen.getByRole("button", { name: "Company Server" }),
	).toHaveAttribute("aria-pressed", "false");
	expect(
		screen.getByText(/Company Server needs a registered team server/),
	).toBeVisible();
	expect(
		localStorage.getItem("fabric-project-delegation-prefs-example-project"),
	).toBe(storedPreference);
	expect(screen.getByTestId("open-remote-server-webui-link")).toHaveAttribute(
		"href",
		expect.stringContaining("https://private.example.com/?"),
	);
});
it("hides the launcher when the bridge is disabled", async () => {
	mount(false);
	await waitFor(() => expect(f.list).toHaveBeenCalled());
	expect(
		screen.queryByTestId("launch-fabric-desktop-bar"),
	).not.toBeInTheDocument();
});
it("embeds the live Remote Server Web UI inside the Fabric Portal and links documentation", async () => {
	mount();
	fireEvent.click(
		await screen.findByTestId("delegate-remote-agent-server-button"),
	);
	expect(screen.getByTestId("launch-desktop-bar-docs-link")).toHaveAttribute(
		"href",
		"/docs/features/projects#delegating-coding-runs-to-fabric-agents",
	);
	fireEvent.click(screen.getByTestId("toggle-embedded-remote-webui-button"));
	expect(
		screen.getByTestId("embedded-remote-server-webui"),
	).toBeInTheDocument();
	expect(
		screen.getByTitle("Fabric Agents Remote Server Web UI"),
	).toHaveAttribute(
		"src",
		expect.stringContaining("https://team.example.com/?"),
	);
});
