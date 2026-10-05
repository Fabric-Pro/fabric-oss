import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentInstanceChatHref } from "../../../agents/lib/fabric-agent-links";

const h = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	push: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agentTemplates: {
			instances: { list: h.list, create: h.create, update: h.update },
		},
		workflows: {
			integrations: { list: async () => ({ integrations: [] }) },
		},
		documentWorkspaces: { list: async () => ({ workspaces: [] }) },
		mcp: { configs: { list: async () => ({ configs: [] }) } },
		skills: { list: async () => ({ skills: [] }) },
	},
}));
// Use the real oRPC utility: mocking flat keys would conceal this regression.
vi.mock("@shared/lib/orpc-query-utils", async () => {
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const { orpcClient } = await import("@shared/lib/orpc-client");
	return { orpc: createTanstackQueryUtils(orpcClient) };
});
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: h.push, back: vi.fn() }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (path: string) => `/app/example-org/${path}`,
}));
vi.mock("@saas/workflows/lib/plugins", () => ({
	getAllIntegrations: () => [],
	getIntegrationTypes: () => [],
	getIntegration: () => undefined,
}));
vi.mock("@saas/agents/sidekick/AgentBuilderSidekick", () => ({
	AgentBuilderSidekick: () => null,
}));
vi.mock("@saas/agents/sidekick/SidekickFormContext", () => ({
	SidekickFormProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@saas/agents/sidekick/SidekickSuggestionsContext", () => ({
	SidekickSuggestionsProvider: ({ children }: { children: ReactNode }) =>
		children,
}));
vi.mock("../DataSourcesSheet", () => ({ DataSourcesSheet: () => null }));
vi.mock("../ToolsSheet", () => ({ ToolsSheet: () => null }));
vi.mock("../TriggersSheet", () => ({ TriggersSheet: () => null }));
vi.mock("../WorkspacesSheet", () => ({ WorkspacesSheet: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { orpc } from "@shared/lib/orpc-query-utils";
import { TooltipProvider } from "@ui/components/tooltip";
import { CreateAgentPage } from "../CreateAgentPage";

const oldInstance = {
	id: "example-old-agent",
	name: "Example Agent",
	version: 1,
	status: "ACTIVE",
};
const savedInstance = { ...oldInstance, id: "example-saved-agent", version: 2 };
const createdInstance = {
	...oldInstance,
	id: "example-created-agent",
	name: "Example Created Agent",
};
const listOptions = () =>
	orpc.agentTemplates.instances.list.queryOptions({
		input: {
			organizationId: "example-org",
			status: "ACTIVE",
			latestVersionOnly: true,
			limit: 100,
			offset: 0,
		},
	});

function CachedAgentList() {
	const { data } = useQuery(listOptions());
	return (
		<>
			{data?.instances.map((instance) => (
				<a
					key={instance.id}
					href={buildAgentInstanceChatHref({
						basePath: "/app/example-org",
						instance,
						unifiedAgentInterface: true,
					})}
				>
					Start Chat {instance.name} v{instance.version}
				</a>
			))}
		</>
	);
}

beforeEach(() => {
	h.list.mockReset().mockResolvedValue({ instances: [oldInstance] });
	h.push.mockReset();
	h.update.mockReset().mockImplementation(async () => {
		h.list.mockResolvedValue({ instances: [savedInstance] });
		return { instance: savedInstance };
	});
	h.create.mockReset().mockImplementation(async () => {
		h.list.mockResolvedValue({ instances: [oldInstance, createdInstance] });
		return { instance: createdInstance };
	});
});

describe("agent builder save refreshes cached chat targets", () => {
	it.each(["edit", "create"] as const)(
		"refreshes the instance list after %s and navigates to the returned ID",
		async (mode) => {
			const resultInstance =
				mode === "edit" ? savedInstance : createdInstance;
			const queryClient = new QueryClient({
				defaultOptions: {
					queries: {
						retry: false,
						staleTime: Number.POSITIVE_INFINITY,
					},
				},
			});
			queryClient.setQueryData(listOptions().queryKey, {
				instances: [oldInstance],
			});
			const view = render(
				<QueryClientProvider client={queryClient}>
					<TooltipProvider>
						<CachedAgentList />
						<CreateAgentPage
							template={{
								id: "example-template",
								slug: "example-template",
								name: "Example Template",
								displayName: "Example Template",
								description: "Example template description",
								category: "GENERAL",
								heroEmojis: [],
								instructions: "Use project context.",
							}}
							organizationId="example-org"
							basePath="/app/example-org"
							mode={mode}
							instanceId={
								mode === "edit" ? oldInstance.id : undefined
							}
							initialValues={{
								name: resultInstance.name,
								description: "Example agent description",
								instructions: "Use project context.",
								selectedTools: [
									"project-context",
									"create-story",
								],
								existingToolConnections: {
									"project-context": {
										enabled: true,
										projectId: "example-project",
									},
								},
							}}
						/>
					</TooltipProvider>
				</QueryClientProvider>,
			);
			expect(
				view.getByRole("link", { name: "Start Chat Example Agent v1" }),
			).toHaveAttribute(
				"href",
				"/app/example-org/agents/fabric-ai?mode=agent&instanceId=example-old-agent",
			);
			await act(async () => {
				fireEvent.click(
					view.getByRole("button", {
						name: mode === "edit" ? "Save Changes" : "Create Agent",
					}),
				);
			});
			await waitFor(() =>
				expect(h.push).toHaveBeenCalledWith(
					`/app/example-org/agents/${resultInstance.id}`,
				),
			);
			const mutation = mode === "edit" ? h.update : h.create;
			expect(mutation).toHaveBeenCalledWith(
				expect.objectContaining({
					...(mode === "edit"
						? { id: oldInstance.id, createNewVersion: true }
						: {}),
					toolConnections: {
						"project-context": {
							enabled: true,
							projectId: "example-project",
						},
						"create-story": { enabled: true },
					},
				}),
				expect.anything(),
			);
			await waitFor(() =>
				expect(
					view.getByRole("link", {
						name: `Start Chat ${resultInstance.name} v${resultInstance.version}`,
					}),
				).toHaveAttribute(
					"href",
					`/app/example-org/agents/fabric-ai?mode=agent&instanceId=${resultInstance.id}`,
				),
			);
			if (mode === "edit") {
				expect(
					view.queryByRole("link", {
						name: "Start Chat Example Agent v1",
					}),
				).toBeNull();
			} else {
				expect(
					view.getByRole("link", {
						name: "Start Chat Example Agent v1",
					}),
				).toBeInTheDocument();
			}
			view.unmount();
			queryClient.clear();
		},
	);
});
