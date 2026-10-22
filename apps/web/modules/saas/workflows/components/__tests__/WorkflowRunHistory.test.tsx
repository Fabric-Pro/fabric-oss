import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	stats: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			executions: { list: mocks.list, stats: mocks.stats },
		},
	},
}));

import { WorkflowRunHistory } from "../WorkflowRunHistory";

const completedRun = {
	id: "run-completed-0001",
	status: "COMPLETED",
	triggerType: "SCHEDULE",
	startedAt: new Date(),
	duration: 5100,
	error: null,
	_count: { logs: 3 },
};

const failedRun = {
	id: "run-failed-0002",
	status: "FAILED",
	triggerType: "MANUAL",
	startedAt: new Date(),
	duration: 1200,
	error: "Step exploded",
	_count: { logs: 1 },
};

/** A filter segment; a run row can carry the same status word. */
function filterButton(name: RegExp) {
	return within(screen.getByRole("group", { name: "Filter runs" })).getByRole(
		"button",
		{ name },
	);
}

function renderPanel(onSelectExecution = vi.fn()) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<WorkflowRunHistory
				workflowId="wf-1"
				organizationId="org-example"
				onSelectExecution={onSelectExecution}
			/>
		</QueryClientProvider>,
	);
	return onSelectExecution;
}

beforeEach(() => {
	mocks.list.mockReset();
	mocks.stats.mockReset();
	mocks.list.mockImplementation(async ({ status }: { status?: string }) => {
		const executions = [completedRun, failedRun].filter(
			(run) => !status || run.status === status,
		);
		return { executions, total: executions.length };
	});
	mocks.stats.mockResolvedValue({
		total: 7,
		completed: 4,
		failed: 2,
		running: 1,
		successRate: 57,
		avgDuration: 3000,
	});
});

describe("WorkflowRunHistory", () => {
	it("shows each filter's count from the run statistics", async () => {
		renderPanel();

		expect(
			await screen.findByTestId("run-filter-count-all"),
		).toHaveTextContent("7");
		expect(screen.getByTestId("run-filter-count-FAILED")).toHaveTextContent(
			"2",
		);
		expect(
			screen.getByTestId("run-filter-count-RUNNING"),
		).toHaveTextContent("1");
		expect(
			screen.getByTestId("run-filter-count-COMPLETED"),
		).toHaveTextContent("4");
		expect(mocks.stats).toHaveBeenCalledWith({
			id: "wf-1",
			organizationId: "org-example",
		});
	});

	it("asks for only failed runs when Failed is picked, and lists just those", async () => {
		renderPanel();
		await screen.findByText("run-comp");

		fireEvent.click(filterButton(/^Failed/));

		await waitFor(() =>
			expect(mocks.list).toHaveBeenLastCalledWith(
				expect.objectContaining({ status: "FAILED" }),
			),
		);
		await waitFor(() =>
			expect(screen.queryByText("run-comp")).not.toBeInTheDocument(),
		);
		expect(screen.getByText("run-fail")).toBeInTheDocument();
		expect(filterButton(/^Failed/)).toHaveAttribute("aria-pressed", "true");
	});

	it("says which runs are missing when a filter has none", async () => {
		mocks.list.mockResolvedValue({ executions: [], total: 0 });
		renderPanel();

		fireEvent.click(filterButton(/^Running/));

		expect(await screen.findByText("No running runs.")).toBeInTheDocument();
	});

	it("reports the run picked", async () => {
		const onSelectExecution = renderPanel();

		fireEvent.click(
			await screen.findByRole("button", { name: /run-fail/ }),
		);

		expect(onSelectExecution).toHaveBeenCalledWith("run-failed-0002");
	});
});
