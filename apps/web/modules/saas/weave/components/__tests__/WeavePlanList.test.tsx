import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WeavePlanList } from "../WeavePlanList";

const mocks = vi.hoisted(() => ({
	retryGeneration: vi.fn(),
	deletePlan: vi.fn(),
	startExecution: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	useKanbanRuntimeDetected: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => mocks.toastSuccess(...args),
		error: (...args: unknown[]) => mocks.toastError(...args),
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: null }),
}));

vi.mock("@saas/projects/hooks/use-kanban-status", () => ({
	useKanbanRuntimeDetected: (enabled: boolean) =>
		mocks.useKanbanRuntimeDetected(enabled),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		weave: {
			plans: {
				approve: vi.fn(),
				revise: vi.fn(),
				updateCheckboxes: vi.fn(),
				retryGeneration: (...args: unknown[]) =>
					mocks.retryGeneration(...args),
				delete: (...args: unknown[]) => mocks.deletePlan(...args),
			},
			templates: {
				save: vi.fn(),
			},
			executions: {
				start: (...args: unknown[]) => mocks.startExecution(...args),
			},
		},
	},
}));

function renderPlanList(
	plans: Array<Record<string, unknown>>,
	options: {
		onPlanGenerationStarted?: (planId: string) => void;
		onSelectExecution?: (executionId: string) => void;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	return render(
		<QueryClientProvider client={client}>
			<WeavePlanList
				plans={plans as never}
				isLoading={false}
				preferredLocalProvider="KANBAN_LOCAL"
				repoUrl="https://github.com/acme/fabric"
				highlightPlanId={String(plans[0]?.id ?? "")}
				onPlanGenerationStarted={options.onPlanGenerationStarted}
				onSelectExecution={options.onSelectExecution ?? (() => {})}
			/>
		</QueryClientProvider>,
	);
}

function approvedPlan(overrides: Record<string, unknown> = {}) {
	return {
		id: "plan_1",
		name: "Approved plan",
		description: "Ship the feature safely",
		status: "APPROVED",
		checkboxes: [],
		createdAt: new Date("2026-03-27T12:00:00.000Z"),
		executions: [],
		userStory: {
			id: "story_1",
			title: "Agentic execution",
			identifier: "FAB-101",
		},
		storyTask: null,
		...overrides,
	};
}

function failedPlan(overrides: Record<string, unknown> = {}) {
	return {
		id: "plan_failed",
		name: "Failed plan",
		description: "Plan generation failed: planner unreachable.",
		status: "FAILED",
		checkboxes: [],
		createdAt: new Date("2026-03-27T12:00:00.000Z"),
		executions: [],
		userStory: null,
		storyTask: null,
		...overrides,
	};
}

describe("WeavePlanList", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.useKanbanRuntimeDetected.mockReturnValue("detected");
	});

	it("shows Background Agents and local development delegation for feature-linked approved plans", async () => {
		renderPlanList([approvedPlan()]);

		expect(
			await screen.findByRole("button", {
				name: /Background Agents/i,
			}),
		).toBeEnabled();
		expect(
			screen.getByRole("button", {
				name: /Local development/i,
			}),
		).toBeEnabled();
		expect(screen.getByText(/through Fabric Kanban/i)).toBeInTheDocument();
	});

	it("disables Background Agents for standalone approved plans and explains why", async () => {
		renderPlanList([
			approvedPlan({
				id: "plan_2",
				name: "Standalone plan",
				description: "Run repo work without a linked feature",
				userStory: null,
			}),
		]);

		const backgroundButton = await screen.findByRole("button", {
			name: /Background Agents/i,
		});
		expect(backgroundButton).toBeDisabled();
		// The "why is this disabled" copy moved from a native `title` on the
		// wrapper into a `<Tooltip>` (see fabric/standards/frontend/tooltips.md).
		// The wrapper survives because a disabled button swallows pointer events,
		// so the trigger has to sit outside it. Assert the trigger is still wired
		// rather than only asserting the `title` is gone — the latter would stay
		// green if the explanation were dropped altogether.
		const disabledHint = backgroundButton.closest(
			'[data-slot="tooltip-trigger"]',
		);
		expect(disabledHint).not.toBeNull();
		expect(backgroundButton.closest("div")).not.toHaveAttribute("title");
		expect(
			screen.getByText(/standalone plan is ready for local execution/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /Local development/i,
			}),
		).toBeEnabled();
	});

	it("renders the red FAILED badge, error description, and Retry generation button for failed plans", async () => {
		renderPlanList([failedPlan()]);

		const badgeLabel = await screen.findByText("Failed");
		expect(badgeLabel.closest("[class*='bg-red-500/10']")).not.toBeNull();
		expect(
			screen.getByText(/Plan generation failed: planner unreachable\./),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Retry generation/i }),
		).toBeEnabled();
	});

	it("calls retryGeneration and notifies the parent when Retry generation is clicked", async () => {
		mocks.retryGeneration.mockResolvedValue({
			success: true,
			planId: "plan_failed",
			status: "DRAFT",
		});
		const onPlanGenerationStarted = vi.fn();
		renderPlanList([failedPlan()], { onPlanGenerationStarted });

		fireEvent.click(
			await screen.findByRole("button", { name: /Retry generation/i }),
		);

		await waitFor(() =>
			expect(mocks.retryGeneration).toHaveBeenCalledWith({
				planId: "plan_failed",
				organizationId: null,
			}),
		);
		await waitFor(() =>
			expect(onPlanGenerationStarted).toHaveBeenCalledWith("plan_failed"),
		);
		expect(mocks.toastSuccess).toHaveBeenCalledWith(
			"Retrying plan generation…",
		);
	});

	it("does not render Retry generation for non-FAILED plans", async () => {
		renderPlanList([
			approvedPlan(),
			approvedPlan({
				id: "plan_pending",
				name: "Pending plan",
				status: "PENDING_APPROVAL",
			}),
		]);

		await screen.findByRole("button", { name: /Background Agents/i });
		expect(
			screen.queryByRole("button", { name: /Retry generation/i }),
		).not.toBeInTheDocument();
	});

	it("deletes a plan through the confirm dialog and refreshes the list", async () => {
		mocks.deletePlan.mockResolvedValue({ success: true, planId: "plan_1" });
		renderPlanList([approvedPlan()]);

		fireEvent.click(
			await screen.findByRole("button", { name: /Delete plan/i }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: /^Delete$/ }),
		);

		await waitFor(() =>
			expect(mocks.deletePlan).toHaveBeenCalledWith({
				planId: "plan_1",
				organizationId: null,
			}),
		);
	});

	it("does not offer delete while a plan is RUNNING", async () => {
		renderPlanList([
			approvedPlan({ id: "plan_running", status: "RUNNING" }),
		]);

		await screen.findByText("Running");
		expect(
			screen.queryByRole("button", { name: /Delete plan/i }),
		).not.toBeInTheDocument();
	});

	it("shows the local-development queue toast after a KANBAN_LOCAL start", async () => {
		mocks.startExecution.mockResolvedValue({ executionId: "exec_1" });
		const onSelectExecution = vi.fn();
		renderPlanList([approvedPlan()], { onSelectExecution });

		fireEvent.click(
			await screen.findByRole("button", { name: /Local development/i }),
		);

		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"Queued for Local development",
				{
					description:
						"Run `fabric-kanban` in your repository to pull queued items.",
				},
			),
		);
		expect(onSelectExecution).toHaveBeenCalledWith("exec_1");
	});

	it("keeps the Background Agents delegation toast unchanged", async () => {
		mocks.startExecution.mockResolvedValue({ executionId: "exec_2" });
		renderPlanList([approvedPlan()]);

		fireEvent.click(
			await screen.findByRole("button", { name: /Background Agents/i }),
		);

		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"Delegated to Background Agents!",
			),
		);
	});

	it("shows the runtime-not-detected hint without disabling the Local development button", async () => {
		mocks.useKanbanRuntimeDetected.mockReturnValue("not-detected");
		renderPlanList([approvedPlan()]);

		expect(
			await screen.findByText(
				/Local fabric-kanban runtime not detected — run `fabric-kanban` in your repository to pull queued work\./,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Local development/i }),
		).toBeEnabled();
	});

	it("hides the runtime hint when the local runtime is detected and keeps the prerequisite line", async () => {
		renderPlanList([approvedPlan()]);

		expect(
			await screen.findByText(
				/Run fabric-kanban locally to pull queued work\./,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/Local fabric-kanban runtime not detected/),
		).not.toBeInTheDocument();
		expect(mocks.useKanbanRuntimeDetected).toHaveBeenCalledWith(true);
	});
});
