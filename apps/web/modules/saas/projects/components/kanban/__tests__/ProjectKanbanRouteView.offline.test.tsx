import messages from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@ui/components/tooltip";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectKanbanRouteView } from "../ProjectKanbanRouteView";

const f = vi.hoisted(() => ({
	prepare: vi.fn(),
	router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => f.router }));
vi.mock("@saas/projects/hooks/use-kanban-status", () => ({
	useKanbanStatus: () => ({ prepareKanbanLaunch: f.prepare }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "example-org" }),
}));
vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useRegisterFabricAgentContext: vi.fn(),
}));
vi.mock("@saas/projects/components/stories/BacklogChatPanel", () => ({
	BacklogChatPanel: () => null,
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));
vi.mock("next-intl", () => ({
	useTranslations: (scope: string) => (key: string) =>
		scope === "projects.remoteAgents.board"
			? messages.projects.remoteAgents.board[
					key as keyof typeof messages.projects.remoteAgents.board
				]
			: key,
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: () => ({
					queryKey: ["example-project"],
					queryFn: async () => ({
						project: {
							name: "Example project",
							engagementProfile: "GOVERNED",
						},
					}),
				}),
			},
			stories: {
				board: {
					queryKey: () => ["example-stories-board"],
					queryOptions: () => ({
						queryKey: ["example-stories-board"],
						queryFn: async () => ({ stories: [] }),
					}),
				},
				list: {
					queryOptions: () => ({
						queryKey: ["example-stories"],
						queryFn: async () => ({ stories: [] }),
					}),
				},
				statuses: {
					list: {
						queryOptions: () => ({
							queryKey: ["example-statuses"],
							queryFn: async () => ({ statuses: [] }),
						}),
					},
				},
			},
		},
	},
}));
beforeEach(() => {
	vi.clearAllMocks();
	f.prepare.mockResolvedValue({ mode: "not-running", url: "" });
});
function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ProjectKanbanRouteView
					projectId="example-project"
					organizationSlug="example-team"
					embedded
				/>
			</TooltipProvider>
		</QueryClientProvider>,
	);
}
it("does not mistake an unavailable legacy board for a stopped Fabric Agents server", async () => {
	show();
	await waitFor(() => expect(f.prepare).toHaveBeenCalled());
	const assign = await screen.findByRole("link", {
		name: "Choose a feature to assign",
	});
	expect(assign).toHaveAttribute(
		"href",
		"/app/example-team/projects/example-project?tab=stories",
	);
	expect(
		screen.queryByText(/Fabric Agents local bridge is not running/),
	).not.toBeInTheDocument();
	expect(
		screen.queryByText(/@fabricorg\/agent-server/),
	).not.toBeInTheDocument();
	expect(screen.queryByText("fabric agents desktop")).not.toBeInTheDocument();
	expect(
		screen.getByRole("link", { name: "Open Fabric Desktop" }),
	).toHaveAttribute(
		"href",
		expect.stringContaining("fabricagents://action/new-chat?"),
	);
});
it("keeps the optional local board check distinct from remote-server readiness", async () => {
	show();
	const retry = await screen.findByRole("button", {
		name: "Check local board",
	});
	fireEvent.click(retry);
	await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
	expect(screen.getByText(/localhost:3484/)).toBeInTheDocument();
});
