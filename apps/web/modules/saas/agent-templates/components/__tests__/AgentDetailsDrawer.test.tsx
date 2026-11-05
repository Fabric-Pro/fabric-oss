import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	params: "agentId=example-agent&q=report&scope=ORGANIZATION&view=grid",
	replace: vi.fn(),
	instance: {} as Record<string, unknown>,
	history: vi.fn(),
	session: vi.fn(),
	get: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: h.replace }),
	usePathname: () => "/app/example-org/agents",
	useSearchParams: () => new URLSearchParams(h.params),
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "example-owner" } }),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		agentTemplates: {
			instances: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["instance", input],
						queryFn: () => {
							h.get(input);
							return { instance: h.instance };
						},
					}),
				},
			},
		},
	},
}));
vi.mock("../AgentRunHistory", () => ({
	AgentRunHistory: (props: unknown) => {
		h.history(props);
		return <div>Recent execution metadata</div>;
	},
}));
vi.mock("../AgentRunSession", () => ({
	AgentRunSession: (props: unknown) => {
		h.session(props);
		return <div>Execution session</div>;
	},
}));
vi.mock("../AgentDefinitionDialog", () => ({
	AgentDefinitionExportDialog: () => (
		<button type="button">Export agent</button>
	),
}));
vi.mock("../AgentImplementationNotice", () => ({
	AgentImplementationNotice: () => <div>Implementation unavailable</div>,
}));

import { AgentDetailsDrawer } from "../AgentDetailsDrawer";

function mount() {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false, gcTime: 0 } },
				})
			}
		>
			<AgentDetailsDrawer
				organizationId="example-org"
				instanceId="example-agent"
				basePath="/app/example-org"
			/>
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	h.params = "agentId=example-agent&q=report&scope=ORGANIZATION&view=grid";
	h.instance = {
		id: "example-agent",
		name: "Example reporter",
		userId: "example-owner",
		status: "ACTIVE",
		version: 1,
		workspaceIds: [],
		executionMode: "single_turn",
		customInstructions: { additionalContext: "Use project evidence." },
		toolConnections: {},
		template: { displayName: "Example template" },
	};
});
describe("saved agent drawer", () => {
	it("loads the definition without history or execution sessions and retains full-page editing", async () => {
		mount();
		const dialog = await screen.findByRole("dialog", {
			name: "Example reporter",
		});
		expect(dialog).toHaveTextContent("Use project evidence.");
		expect(
			screen.getByRole("link", { name: "Edit", exact: true }),
		).toHaveAttribute("href", "/app/example-org/agents/example-agent/edit");
		expect(h.history).not.toHaveBeenCalled();
		expect(h.session).not.toHaveBeenCalled();
		expect(h.get).toHaveBeenCalledWith({
			organizationId: "example-org",
			id: "example-agent",
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Run agent", exact: true }),
		);
		expect(h.replace).toHaveBeenCalledWith(
			"/app/example-org/agents?agentId=example-agent&q=report&scope=ORGANIZATION&view=grid&agentView=new",
			{ scroll: false },
		);
		expect(h.session).not.toHaveBeenCalled();
	});
	it("opens run metadata only on the Runs tab", async () => {
		h.params += "&agentView=runs";
		mount();
		await screen.findByText("Recent execution metadata");
		expect(h.history).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "example-org",
				instanceId: "example-agent",
				compact: true,
			}),
		);
		expect(h.session).not.toHaveBeenCalled();
	});
	it("opens only the selected execution", async () => {
		h.params += "&agentView=runs&runId=example-run";
		mount();
		await screen.findByText("Execution session");
		expect(h.session).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "result",
				executionId: "example-run",
			}),
		);
		expect(h.history).not.toHaveBeenCalled();
	});
	it("does not mount credential-backed run controls for another owner", async () => {
		h.instance.userId = "example-other";
		h.params += "&agentView=runs";
		mount();
		await screen.findByText(/Only the agent owner/);
		expect(
			screen.queryByRole("button", { name: "Run agent", exact: true }),
		).not.toBeInTheDocument();
		expect(h.history).not.toHaveBeenCalled();
		expect(h.session).not.toHaveBeenCalled();
	});
	it("closing removes only drawer state", async () => {
		h.params += "&agentView=runs&runId=example-run";
		mount();
		await screen.findByRole("dialog", { name: "Example reporter" });
		fireEvent.click(
			screen.getByRole("button", { name: "Close", exact: true }),
		);
		await waitFor(() =>
			expect(h.replace).toHaveBeenCalledWith(
				"/app/example-org/agents?q=report&scope=ORGANIZATION&view=grid",
				{ scroll: false },
			),
		);
	});
	it("only opens a schedule session when explicitly selected", async () => {
		h.params += "&agentView=schedule";
		mount();
		await screen.findByText("Execution session");
		expect(h.session).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "schedule" }),
		);
		expect(h.history).not.toHaveBeenCalled();
	});
});
