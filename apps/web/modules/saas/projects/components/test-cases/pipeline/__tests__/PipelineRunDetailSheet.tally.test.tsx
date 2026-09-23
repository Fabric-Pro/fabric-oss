/**
 * The run-detail sheet's headline tally must not read as a pass when the run
 * has no test data. A verified webhook delivery publishes the run before the
 * sweep fetches its per-test breakdown, so every count is zero for up to a
 * sweep interval — and a failing suite used to show a green "0/0 passed"
 * (Fizzy #2224).
 *
 * next-intl is globally key-mocked in vitest.setup.ts, so a translated string
 * surfaces as its key.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let queryState: {
	data?: unknown;
	isLoading: boolean;
	isError: boolean;
} = { data: undefined, isLoading: true, isError: false };

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => queryState,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				runDetail: { queryOptions: (o: unknown) => o },
			},
		},
	},
}));

import { PipelineRunDetailSheet } from "../PipelineRunDetailSheet";

function renderWithRun(counts: {
	totalCount: number;
	passedCount: number;
	failedCount: number;
}) {
	queryState = {
		data: {
			run: {
				id: "run-1",
				provider: "github-actions",
				externalRunId: "30141350916",
				pipelineName: "CI",
				skippedCount: 0,
				otherCount: 0,
				...counts,
			},
			results: [],
		},
		isLoading: false,
		isError: false,
	};
	return render(
		<PipelineRunDetailSheet
			projectId="p1"
			runId="run-1"
			open={true}
			onOpenChange={() => {}}
		/>,
	);
}

describe("PipelineRunDetailSheet — result tally", () => {
	it("renders a run with no test data neutrally, not as a pass", () => {
		renderWithRun({ totalCount: 0, passedCount: 0, failedCount: 0 });

		expect(screen.queryByText(/0\/0/)).toBeNull();
		const badge = screen.getByText("noTestResults");
		expect(badge.className).not.toContain("text-success");
		expect(badge.className).toContain("text-muted-foreground");
	});

	it("still renders a clean run as a pass", () => {
		renderWithRun({ totalCount: 4, passedCount: 4, failedCount: 0 });

		expect(screen.getByText(/4\/4/).className).toContain("text-success");
	});

	it("still renders a run with failures as an error", () => {
		renderWithRun({ totalCount: 4, passedCount: 3, failedCount: 1 });

		expect(screen.getByText(/3\/4/).className).toContain(
			"text-destructive",
		);
	});
});
