import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	push: vi.fn(),
	initialValues: vi.fn(),
	instance: {} as Record<string, unknown>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "example-org",
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/workflows/lib/plugins", () => ({
	getIntegration: () => undefined,
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		agentTemplates: {
			instances: {
				get: {
					queryOptions: () => ({
						queryKey: ["instance"],
						queryFn: () => ({ instance: h.instance }),
					}),
				},
				delete: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
			},
		},
		mcp: {
			configs: {
				list: {
					queryOptions: () => ({
						queryKey: ["mcp"],
						queryFn: () => ({ configs: [] }),
					}),
				},
			},
		},
		agentMemory: {
			files: {
				list: {
					queryOptions: () => ({
						queryKey: ["memory"],
						queryFn: () => ({ files: [] }),
					}),
				},
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { documentWorkspaces: { list: vi.fn() } },
}));
vi.mock("../AgentRunsPanel", () => ({
	AgentRunsPanel: () => (
		<section id="agent-runs">Background run history</section>
	),
}));
vi.mock("../AgentDefinitionDialog", () => ({
	AgentDefinitionExportDialog: () => (
		<button type="button">Export agent</button>
	),
	AgentDefinitionImportDialog: ({
		onImported,
	}: {
		onImported: (id: string) => void;
	}) => (
		<button type="button" onClick={() => onImported("example-new-release")}>
			Import agent
		</button>
	),
	AgentDefinitionRequirements: () => null,
}));
vi.mock("../CreateAgentPage", () => ({
	CreateAgentPage: (props: { initialValues: unknown }) => {
		h.initialValues(props.initialValues);
		return <div>Native agent builder</div>;
	},
}));

import { AgentImplementationNotice } from "../AgentImplementationNotice";
import { AgentInstanceDetail } from "../AgentInstanceDetail";
import { AgentInstanceDuplicate } from "../AgentInstanceDuplicate";
import { AgentInstanceEdit } from "../AgentInstanceEdit";

const props = {
	instanceId: "example-agent",
	organizationId: "example-org",
	basePath: "/app/example-org",
};
const wrapped = (children: React.ReactNode) => (
	<QueryClientProvider
		client={
			new QueryClient({ defaultOptions: { queries: { retry: false } } })
		}
	>
		{children}
	</QueryClientProvider>
);
beforeEach(() => {
	h.push.mockReset();
	h.initialValues.mockReset();
	h.instance = {
		id: "example-agent",
		name: "Report agent",
		organizationId: "example-org",
		status: "DRAFT",
		createdAt: "2026-01-01T00:00:00Z",
		template: {
			id: "example-template",
			slug: "example",
			name: "Example",
			displayName: "Example",
			description: "Example",
			category: "GENERAL",
			instructions: "Cite source documents.",
		},
		customInstructions: {
			role: "Create a delivery report.",
			portableImplementation: { kind: "harness_finite" },
		},
		toolConnections: {},
		workspaceIds: [],
		memoryFiles: [],
	};
});
describe("unqualified implementation UX", () => {
	it("links to real background history instead of presenting stale legacy run counters", async () => {
		h.instance.customInstructions = { role: "Create a delivery report." };
		h.instance.runCount = 0;
		const view = render(
			wrapped(
				<AgentInstanceDetail
					instanceId={props.instanceId}
					basePath={props.basePath}
				/>,
			),
		);
		expect(
			await view.findByRole("link", {
				name: "View background run history",
			}),
		).toHaveAttribute("href", "#agent-runs");
		expect(view.queryByText("Total runs")).not.toBeInTheDocument();
		expect(view.queryByText("Last run")).not.toBeInTheDocument();
	});
	it("offers export and new draft import with an explicit explanation", () => {
		const view = render(
			<AgentImplementationNotice
				{...props}
				customInstructions={h.instance.customInstructions}
			/>,
		);
		expect(view.getByRole("alert")).toHaveTextContent(
			"execution unavailable",
		);
		expect(view.getByRole("alert")).toHaveTextContent(
			"Code-owned instructions, skills and execution settings are read-only",
		);
		expect(
			view.getByRole("button", { name: "Export agent" }),
		).toBeEnabled();
		fireEvent.click(view.getByRole("button", { name: "Import agent" }));
		expect(h.push).toHaveBeenCalledWith(
			"/app/example-org/agents/example-new-release",
		);
	});
	it("does not show a blocked banner for an existing native agent", () => {
		const view = render(
			<AgentImplementationNotice
				{...props}
				customInstructions={{ role: "Native task" }}
			/>,
		);
		expect(view.queryByRole("alert")).not.toBeInTheDocument();
	});
	it.each(["edit", "duplicate"])(
		"keeps instructions inspectable instead of opening an editable native form on %s",
		async (mode) => {
			const view = render(
				wrapped(
					mode === "edit" ? (
						<AgentInstanceEdit {...props} />
					) : (
						<AgentInstanceDuplicate {...props} />
					),
				),
			);
			expect(
				await view.findByRole("region", {
					name: "Read-only implementation instructions",
				}),
			).toHaveTextContent("Cite source documents.");
			expect(
				view.getByText("Create a delivery report."),
			).toBeInTheDocument();
			expect(
				view.queryByText("Native agent builder"),
			).not.toBeInTheDocument();
			expect(
				view.queryByRole("button", { name: /Save|Create Agent/ }),
			).not.toBeInTheDocument();
		},
	);
	it("retains the normal editor for a native agent", async () => {
		h.instance.customInstructions = { role: "Native task" };
		const view = render(wrapped(<AgentInstanceEdit {...props} />));
		expect(
			await view.findByText("Native agent builder"),
		).toBeInTheDocument();
	});
	it.each(["edit", "duplicate"])(
		"preserves a legacy project binding on %s",
		async (mode) => {
			h.instance.customInstructions = { role: "Native task" };
			h.instance.toolConnections = {
				"project-context": { projectId: "example-project" },
			};
			const view = render(
				wrapped(
					mode === "edit" ? (
						<AgentInstanceEdit {...props} />
					) : (
						<AgentInstanceDuplicate {...props} />
					),
				),
			);
			await view.findByText("Native agent builder");
			expect(h.initialValues).toHaveBeenLastCalledWith(
				expect.objectContaining({ projectId: "example-project" }),
			);
		},
	);
	it("disables execution and code-owned memory editing on the detail page while allowing inspection", async () => {
		const view = render(
			wrapped(
				<AgentInstanceDetail
					instanceId={props.instanceId}
					basePath={props.basePath}
				/>,
			),
		);
		expect(
			await view.findByRole("button", { name: "Start Chat" }),
		).toBeDisabled();
		expect(
			view.getByRole("button", { name: "Memory is code-owned" }),
		).toBeDisabled();
		expect(
			view.getByRole("link", { name: "Inspect implementation" }),
		).toHaveAttribute("href", "/app/example-org/agents/example-agent/edit");
		expect(view.getByRole("alert")).toHaveTextContent(
			"qualified execution adapter",
		);
		expect(view.getByText("Create a delivery report.")).toBeInTheDocument();
	});
	it.each(["edit", "duplicate"])(
		"offers deliberate rebinding for inconsistent project metadata on %s",
		async (mode) => {
			h.instance.customInstructions = {
				role: "Native task",
				projectId: null,
			};
			h.instance.toolConnections = {
				"project-context": { projectId: "example-project" },
			};
			const view = render(
				wrapped(
					mode === "edit" ? (
						<AgentInstanceEdit {...props} />
					) : (
						<AgentInstanceDuplicate {...props} />
					),
				),
			);
			await view.findByText("Native agent builder");
			expect(view.getByRole("alert")).toHaveTextContent(
				"conflicting project settings",
			);
			expect(h.initialValues).toHaveBeenLastCalledWith(
				expect.objectContaining({ projectId: null }),
			);
		},
	);
});
