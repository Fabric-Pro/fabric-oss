import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecuteWithWeaveButton } from "../ExecuteWithWeaveButton";

const mocks = vi.hoisted(() => ({
	plansList: vi.fn(),
	plansGet: vi.fn(),
	plansCreate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
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

vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		weave: {
			plans: {
				list: (...args: unknown[]) => mocks.plansList(...args),
				get: (...args: unknown[]) => mocks.plansGet(...args),
				create: (...args: unknown[]) => mocks.plansCreate(...args),
			},
		},
	},
}));

// These tests exercise ExecuteWithWeaveButton's own polling effect only —
// stub the heavy children. The WeavePlanList stub surfaces the props the
// polling flow drives (isGenerating / highlightPlanId) and a trigger for
// onCreateFromFeature so a pending plan can be started.
vi.mock("../WeaveExecutionMonitor", () => ({
	WeaveExecutionMonitor: () => null,
}));
vi.mock("../CreatePlanForm", () => ({
	CreatePlanForm: () => null,
}));
vi.mock("../WeavePlanList", () => ({
	WeavePlanList: ({
		onCreateFromFeature,
		isGenerating,
		highlightPlanId,
	}: {
		onCreateFromFeature?: () => void;
		isGenerating?: boolean;
		highlightPlanId?: string;
	}) => (
		<div>
			<button type="button" onClick={() => onCreateFromFeature?.()}>
				create-from-feature
			</button>
			<div data-testid="is-generating">
				{String(isGenerating ?? false)}
			</div>
			<div data-testid="highlight-plan">{highlightPlanId ?? "none"}</div>
		</div>
	),
}));

function renderButton() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	return render(
		<QueryClientProvider client={client}>
			<ExecuteWithWeaveButton
				projectId="project_1"
				storyId="story_1"
				open
				onOpenChange={() => {}}
				hideTrigger
				storyContext={{
					title: "Agentic execution",
					description: "Ship the feature safely",
				}}
			/>
		</QueryClientProvider>,
	);
}

describe("ExecuteWithWeaveButton plan polling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.plansList.mockResolvedValue({ plans: [] });
		mocks.plansCreate.mockResolvedValue({ planId: "plan_1" });
	});

	it("shows the failure toast and clears polling when the plan flips to FAILED", async () => {
		mocks.plansGet.mockResolvedValue({
			id: "plan_1",
			status: "FAILED",
			description: "Plan generation failed: planner unreachable.",
		});

		renderButton();
		fireEvent.click(await screen.findByText("create-from-feature"));

		await waitFor(() =>
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Plan generation failed",
				{
					description: "Plan generation failed: planner unreachable.",
				},
			),
		);
		expect(mocks.toastSuccess).not.toHaveBeenCalled();
		// Polling state is cleared — the generating card stops rendering
		await waitFor(() =>
			expect(screen.getByTestId("is-generating")).toHaveTextContent(
				"false",
			),
		);
		expect(screen.getByTestId("highlight-plan")).toHaveTextContent("none");
	});

	it("keeps the success toast when the plan reaches PENDING_APPROVAL", async () => {
		mocks.plansGet.mockResolvedValue({
			id: "plan_1",
			status: "PENDING_APPROVAL",
			description: "Plan ready",
		});

		renderButton();
		fireEvent.click(await screen.findByText("create-from-feature"));

		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"Plan ready for review!",
			),
		);
		expect(mocks.toastError).not.toHaveBeenCalled();
	});
});
