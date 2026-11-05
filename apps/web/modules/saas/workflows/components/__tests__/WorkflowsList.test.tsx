vi.mock("../WorkflowStarters", () => ({
	WorkflowStarters: () => <section aria-label="Workflow starters" />,
}));

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	setTransientCollapsed: vi.fn(),
	push: vi.fn(),
	workflows: [] as Array<{
		id: string;
		name: string;
		status: string;
		triggerType: string;
	}>,
	inputs: [] as Array<Record<string, unknown>>,
	hasMore: false,
	pending: false,
	error: false,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example",
		basePath: "/app/org-example",
	}),
}));
vi.mock("@saas/shared/contexts/SidebarCollapseContext", () => ({
	useSidebarCollapse: () => ({
		setTransientCollapsed: mocks.setTransientCollapsed,
	}),
}));
vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));
vi.mock("next-intl", () => {
	const labels: Record<string, string> = {
		statusLabel: "Workflow status",
		buildWithAi: "Build with AI",
		startFromScratch: "Start from scratch",
		allStatuses: "All statuses",
		filterActive: "Active",
		filterDraft: "Draft",
		filterPaused: "Paused",
		filterArchived: "Archived",
		filterScheduled: "Scheduled",
	};
	return { useTranslations: () => (key: string) => labels[key] ?? key };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		workflows: {
			create: { mutationOptions: () => ({}) },
			list: {
				queryOptions: ({
					input,
				}: {
					input: Record<string, unknown>;
				}) => {
					mocks.inputs.push(input);
					return {};
				},
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: mocks.create, isPending: mocks.pending }),
	useQuery: () => ({
		data: {
			workflows: mocks.workflows,
			hasMore: mocks.hasMore,
			nextOffset: 50,
		},
		isLoading: false,
		error: mocks.error,
		refetch: vi.fn(),
	}),
}));
vi.mock("../WorkflowCard", () => ({
	WorkflowCard: ({
		workflow,
		selected,
		onBeforeAction,
	}: {
		workflow: { name: string };
		selected: boolean;
		onBeforeAction: () => boolean;
	}) => (
		<button
			type="button"
			aria-current={selected ? "page" : undefined}
			onClick={onBeforeAction}
		>
			{workflow.name}
		</button>
	),
}));
vi.mock("../WorkflowEditor", () => ({
	WorkflowEditor: ({
		workflowId,
		onDirtyChange,
	}: {
		workflowId: string;
		onDirtyChange: (dirty: boolean) => void;
	}) => (
		<div>
			Editor for {workflowId}
			<button type="button" onClick={() => onDirtyChange(true)}>
				Edit graph
			</button>
		</div>
	),
}));

import { WorkflowsList } from "../WorkflowsList";

const workflow = (
	id: string,
	triggerType = "MANUAL",
	status = "PUBLISHED",
) => ({ id, name: `Workflow ${id}`, triggerType, status });
function selectStatus(label: string) {
	fireEvent.keyDown(
		screen.getByRole("combobox", { name: "Workflow status" }),
		{
			key: "Enter",
		},
	);
	fireEvent.click(screen.getByRole("option", { name: label, exact: true }));
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.pending = false;
	mocks.error = false;
	mocks.hasMore = false;
	mocks.inputs = [];
	mocks.workflows = [
		workflow("a", "SCHEDULE"),
		workflow("b"),
		workflow("c", "SCHEDULE", "PAUSED"),
	];
});
describe("unified workflow studio", () => {
	it("uses coordinated shell collapse and restores the user's preference on exit", () => {
		const view = render(<WorkflowsList />);
		expect(mocks.setTransientCollapsed).toHaveBeenCalledWith(true);
		view.unmount();
		expect(mocks.setTransientCollapsed).toHaveBeenLastCalledWith(null);
	});

	it("offers one persisted creation flow without prototype execution controls", () => {
		render(<WorkflowsList />);
		expect(
			screen.getByRole("region", { name: "Workflow studio" }),
		).toBeInTheDocument();
		expect(
			screen.getAllByRole("button", { name: "New workflow" }),
		).toHaveLength(1);
		expect(
			screen.queryByRole("button", {
				name: /^Run all$|^Schedule$|^Export$/,
			}),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Create Your First Workflow"),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
		expect(mocks.create).toHaveBeenCalledWith({
			name: "Untitled Workflow",
			triggerType: "MANUAL",
			organizationId: "org-example",
		});
	});
	it("searches on the server and pages beyond the first fifty workflows", () => {
		mocks.hasMore = true;
		render(<WorkflowsList />);
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(mocks.inputs.at(-1)?.offset).toBe(50);
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search workflows" }),
			{ target: { value: "Older workflow" } },
		);
		expect(mocks.inputs.at(-1)).toMatchObject({
			search: "Older workflow",
			offset: 0,
			limit: 50,
		});
	});
	it("disables repeated creation while the save is pending", () => {
		mocks.pending = true;
		render(<WorkflowsList />);
		expect(
			screen.getByRole("button", { name: "Creating…" }),
		).toBeDisabled();
	});
	it("opens the same real editor next to saved workflows", () => {
		render(<WorkflowsList workflowId="a" />);
		expect(screen.getByText("Editor for a")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Workflow a" }),
		).toHaveAttribute("aria-current", "page");
		expect(
			screen.queryByText("Build once. Run with confidence."),
		).not.toBeInTheDocument();
	});
	it("treats legacy ACTIVE and PUBLISHED as live and queries both live statuses while filtering", () => {
		mocks.workflows = [
			workflow("a", "SCHEDULE"),
			workflow("b", "MANUAL", "ACTIVE"),
			workflow("c", "MANUAL", "DRAFT"),
		];
		render(<WorkflowsList />);
		selectStatus("Active");
		expect(screen.getByText("Workflow a")).toBeInTheDocument();
		expect(screen.getByText("Workflow b")).toBeInTheDocument();
		expect(screen.queryByText("Workflow c")).not.toBeInTheDocument();
		expect(mocks.inputs.at(-1)?.statuses).toEqual(["ACTIVE", "PUBLISHED"]);
	});
	it("combines schedule, status and search filters", () => {
		render(<WorkflowsList />);
		fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
		selectStatus("Paused");
		expect(screen.getByText("Workflow c")).toBeInTheDocument();
		expect(screen.queryByText("Workflow a")).not.toBeInTheDocument();
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search workflows" }),
			{ target: { value: "missing" } },
		);
		expect(
			screen.getByText("No workflows found matching your filters"),
		).toBeInTheDocument();
	});
	it("has one creation control when the organization has no workflows", () => {
		mocks.workflows = [];
		render(<WorkflowsList />);
		expect(
			screen.getAllByRole("button", { name: "New workflow" }),
		).toHaveLength(1);
		expect(
			screen.getByText("Your saved workflows will appear here."),
		).toBeInTheDocument();
	});
	it("protects dirty edits before creating another workflow", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<WorkflowsList workflowId="a" />);
		fireEvent.click(screen.getByRole("button", { name: "Edit graph" }));
		fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
		expect(confirm).toHaveBeenCalledWith(
			"Discard unsaved workflow changes?",
		);
		expect(mocks.create).not.toHaveBeenCalled();
		confirm.mockRestore();
	});
	it("shows a retry action when the list cannot load", () => {
		mocks.error = true;
		render(<WorkflowsList />);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not load workflows",
		);
		expect(
			screen.getByRole("button", { name: "Try again" }),
		).toBeInTheDocument();
	});
	it("collapses and reopens navigation without unmounting the editor", () => {
		render(<WorkflowsList workflowId="a" />);
		fireEvent.click(
			screen.getByRole("button", { name: "Hide workflow navigator" }),
		);
		expect(screen.getByText("Editor for a")).toBeInTheDocument();
		expect(
			screen.queryByRole("navigation", { name: "Saved workflows" }),
		).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Show workflow navigator" }),
		);
		expect(
			screen.getByRole("navigation", { name: "Saved workflows" }),
		).toBeInTheDocument();
	});
});

it("offers clear AI and scratch entry points into the same studio", () => {
	render(<WorkflowsList />);
	expect(
		screen.getByRole("button", { name: "Build with AI" }),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Start from scratch" }));
	expect(mocks.create).toHaveBeenCalledWith(
		expect.objectContaining({
			triggerType: "MANUAL",
			organizationId: "org-example",
		}),
	);
});
