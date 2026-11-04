import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentInstanceChatHref } from "../../../agents/lib/fabric-agent-links";

const h = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	push: vi.fn(),
	back: vi.fn(),
	templateGet: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agentTemplates: {
			instances: { list: h.list, create: h.create, update: h.update },
			templates: { get: h.templateGet },
		},
		workflows: {
			integrations: { list: async () => ({ integrations: [] }) },
		},
		documentWorkspaces: { list: async () => ({ workspaces: [] }) },
		projects: {
			list: async () => ({
				projects: [{ id: "example-project", name: "Example project" }],
				total: 1,
			}),
		},
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
	useRouter: () => ({ push: h.push, back: h.back }),
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
vi.mock("../AgentDefinitionDialog", () => ({
	AgentDefinitionImportDialog: ({
		onImported,
	}: {
		onImported: (id: string) => void;
	}) => (
		<button
			type="button"
			onClick={() => {
				h.list.mockResolvedValue({
					instances: [oldInstance, createdInstance],
				});
				onImported(createdInstance.id);
			}}
		>
			Import example draft
		</button>
	),
}));
vi.mock("../DataSourcesSheet", () => ({ DataSourcesSheet: () => null }));
vi.mock("../ToolsSheet", () => ({ ToolsSheet: () => null }));
vi.mock("../TriggersSheet", () => ({ TriggersSheet: () => null }));
vi.mock("../WorkspacesSheet", () => ({ WorkspacesSheet: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { orpc } from "@shared/lib/orpc-query-utils";
import { TooltipProvider } from "@ui/components/tooltip";
import {
	type AgentBuilderInitialValues,
	CreateAgentPage,
} from "../CreateAgentPage";

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
	h.back.mockReset();
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
	it.each(["edit", "create", "import"] as const)(
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
							mode={mode === "import" ? "create" : mode}
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
						name:
							mode === "edit"
								? "Save Changes"
								: mode === "import"
									? "Import example draft"
									: "Create Agent",
					}),
				);
			});
			await waitFor(() =>
				expect(h.push).toHaveBeenCalledWith(
					`/app/example-org/agents/${resultInstance.id}`,
				),
			);
			const mutation = mode === "edit" ? h.update : h.create;

			if (mode !== "import") {
				expect(mutation).toHaveBeenCalledWith(
					expect.objectContaining({
						organizationId: "example-org",
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
			}
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

it("navigates to a created agent when trigger activation failed, without inviting another create", async () => {
	vi.mocked(toast.success).mockClear();
	vi.mocked(toast.error).mockClear();
	const warning =
		"Agent created, but its triggers were not activated. Open the agent to enable them by editing it.";
	h.create.mockResolvedValue({
		instance: createdInstance,
		triggerActivationError: warning,
	});
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
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
					mode="create"
					initialValues={{
						name: "Example Created Agent",
						description: "Example agent description",
						instructions: "Use project context.",
					}}
				/>
			</TooltipProvider>
		</QueryClientProvider>,
	);
	await act(async () => {
		fireEvent.click(view.getByRole("button", { name: "Create Agent" }));
	});
	await waitFor(() =>
		expect(h.push).toHaveBeenCalledWith(
			"/app/example-org/agents/example-created-agent",
		),
	);
	expect(h.create).toHaveBeenCalledTimes(1);
	expect(toast.error).toHaveBeenCalledWith(warning);
	expect(toast.success).not.toHaveBeenCalledWith(
		"Agent created successfully!",
	);
	view.unmount();
	queryClient.clear();
});

function renderBuilder(
	initialValues: AgentBuilderInitialValues = {},
	isCustomAgent = false,
) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<TooltipProvider>
				<CreateAgentPage
					template={{
						id: "example-template",
						slug: "example",
						name: "Example",
						displayName: "Example",
						description: "Example description",
						category: "GENERAL",
						heroEmojis: [],
						instructions: "Use project context.",
					}}
					organizationId="example-org"
					initialValues={{ name: "Example agent", ...initialValues }}
					isCustomAgent={isCustomAgent}
				/>
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

describe("simple creation and deliberate advanced configuration", () => {
	it("keeps project and expected output in the default flow and sends server-validated top-level fields", async () => {
		const view = renderBuilder({
			projectId: "example-project",
			expectedOutput: "A cited documentation proposal",
		});
		expect(
			view.getByRole("textbox", { name: "Expected output (optional)" }),
		).toHaveValue("A cited documentation proposal");
		expect(
			view.getByRole("combobox", { name: "Project (optional)" }),
		).toBeInTheDocument();
		expect(view.queryByText("Max Iterations:")).not.toBeInTheDocument();
		expect(view.queryByTitle("Generate with AI")).not.toBeInTheDocument();
		fireEvent.click(view.getByRole("button", { name: "Create Agent" }));
		await waitFor(() =>
			expect(h.create).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "example-project",
					expectedOutput: "A cited documentation proposal",
					organizationId: "example-org",
					executionMode: "single_turn",
				}),
				expect.anything(),
			),
		);
	});
	it("retains loop values when advanced configuration is closed and reopened", async () => {
		const view = renderBuilder();
		fireEvent.click(
			view.getByRole("button", { name: "Advanced configuration" }),
		);
		fireEvent.click(view.getByRole("button", { name: /Goal Oriented/ }));
		fireEvent.change(view.getByRole("textbox", { name: "Goal" }), {
			target: { value: "Prepare a reviewed proposal" },
		});
		fireEvent.change(view.getByRole("slider", { name: /Max Iterations/ }), {
			target: { value: "17" },
		});
		fireEvent.click(
			view.getByRole("button", { name: "Advanced configuration" }),
		);
		await waitFor(() =>
			expect(
				view.queryByRole("textbox", { name: "Goal" }),
			).not.toBeInTheDocument(),
		);
		fireEvent.click(
			view.getByRole("button", { name: "Advanced configuration" }),
		);
		expect(view.getByRole("textbox", { name: "Goal" })).toHaveValue(
			"Prepare a reviewed proposal",
		);
		expect(
			view.getByRole("slider", { name: /Max Iterations/ }),
		).toHaveValue("17");
		fireEvent.click(view.getByRole("button", { name: "Create Agent" }));
		await waitFor(() =>
			expect(h.create).toHaveBeenCalledWith(
				expect.objectContaining({
					goal: "Prepare a reviewed proposal",
					maxIterations: 17,
					executionMode: "goal_oriented",
				}),
				expect.anything(),
			),
		);
	});
	it("explains missing base-template setup and preserves the draft while retrying", async () => {
		h.templateGet
			.mockRejectedValueOnce(new Error("Template not found"))
			.mockResolvedValue({ template: { id: "example-custom-template" } });
		const view = renderBuilder(
			{
				name: "Example draft",
				description: "A useful purpose",
				instructions: "Use permitted sources",
			},
			true,
		);
		expect(await view.findByRole("alert")).toHaveTextContent(
			"Agent creation is temporarily unavailable",
		);
		expect(
			view.getByRole("button", { name: "Create Custom Agent" }),
		).toBeDisabled();
		fireEvent.click(
			view.getByRole("button", { name: "Retry loading template" }),
		);
		await waitFor(() =>
			expect(
				view.getByRole("button", { name: "Create Custom Agent" }),
			).toBeEnabled(),
		);
		expect(view.getByRole("textbox", { name: /^Name\s*\*$/ })).toHaveValue(
			"Example draft",
		);
	});
});

it("protects unsaved configuration when closing and preserves edits when the user stays", () => {
	const v = renderBuilder({
		name: "Example agent",
		description: "Example purpose",
		instructions: "Use permitted sources",
	});
	fireEvent.change(v.getByRole("textbox", { name: "Instructions" }), {
		target: { value: "A changed draft" },
	});
	fireEvent.click(v.getByRole("button", { name: "Close agent editor" }));
	expect(v.getByRole("alertdialog")).toHaveTextContent(
		"Discard your unsaved changes?",
	);
	expect(h.back).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Keep editing" }));
	expect(v.getByRole("textbox", { name: "Instructions" })).toHaveValue(
		"A changed draft",
	);
	fireEvent.click(v.getByRole("button", { name: "Cancel", exact: true }));
	fireEvent.click(v.getByRole("button", { name: "Discard changes" }));
	expect(h.back).toHaveBeenCalledOnce();
	expect(h.update).not.toHaveBeenCalled();
});
it("returns immediately when the configuration has not changed", () => {
	const v = renderBuilder({
		name: "Example agent",
		description: "Example purpose",
		instructions: "Use permitted sources",
	});
	fireEvent.click(v.getByRole("button", { name: "Close agent editor" }));
	expect(h.back).toHaveBeenCalledOnce();
	expect(v.queryByRole("alertdialog")).not.toBeInTheDocument();
});
