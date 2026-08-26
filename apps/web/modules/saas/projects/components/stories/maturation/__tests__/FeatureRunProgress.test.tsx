/**
 * The in-flight strip on a feature's QA tab.
 *
 * The gap it closes: the tab could dispatch a run and then show nothing, because
 * a Fabric run only reaches the panel below once it has finished and been
 * ingested. Pressing Run and watching nothing happen is indistinguishable from
 * pressing a broken button.
 *
 * What is worth pinning is the *offer*: Stop while it runs, Dismiss once it is
 * over, and nothing at all before a run exists.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...a: unknown[]) => useQueryMock(...a),
	useMutation: (...a: unknown[]) => useMutationMock(...a),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			agenticRuns: {
				get: {
					queryOptions: (o: unknown) => o,
					key: () => ["agenticRunDetail"],
				},
				cancel: { mutationOptions: (o: unknown) => o },
			},
		},
	},
}));

const { FeatureRunProgress } = await import("../FeatureRunProgress");

function withRun(run: Record<string, unknown> | undefined) {
	useQueryMock.mockReturnValue({ data: run ? { run } : undefined });
}

beforeEach(() => {
	vi.clearAllMocks();
	useMutationMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

const BASE = {
	id: "run-1",
	passedCount: 0,
	failedCount: 0,
	blockedCount: 0,
	refusalReason: null,
};

describe("FeatureRunProgress", () => {
	it("renders nothing before a run has been started", () => {
		withRun(undefined);

		const { container } = render(
			<FeatureRunProgress
				projectId="p1"
				runId={null}
				onDismiss={() => {}}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("says it is starting while the run row has not arrived yet", () => {
		// The window between dispatch returning and the first poll answering.
		// Blank here reads as "nothing happened".
		withRun(undefined);

		render(
			<FeatureRunProgress
				projectId="p1"
				runId="run-1"
				onDismiss={() => {}}
			/>,
		);

		expect(screen.getByText(/starting the run/i)).toBeInTheDocument();
	});

	it("offers Stop while the run is in flight", () => {
		withRun({ ...BASE, status: "RUNNING", passedCount: 2, failedCount: 1 });

		render(
			<FeatureRunProgress
				projectId="p1"
				runId="run-1"
				onDismiss={() => {}}
			/>,
		);

		expect(
			screen.getByRole("button", { name: /stop/i }),
		).toBeInTheDocument();
		expect(screen.getByText("RUNNING")).toBeInTheDocument();
		expect(screen.getByText(/2 passed · 1 failed/)).toBeInTheDocument();
	});

	it("replaces Stop with Dismiss once the run is over", () => {
		withRun({ ...BASE, status: "PASSED", passedCount: 3 });

		render(
			<FeatureRunProgress
				projectId="p1"
				runId="run-1"
				onDismiss={() => {}}
			/>,
		);

		expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
		expect(
			screen.getByRole("button", { name: /dismiss/i }),
		).toBeInTheDocument();
	});

	it("shows why a run was refused rather than only that it was", () => {
		withRun({
			...BASE,
			status: "REFUSED",
			refusalReason: "Over the per-run limit.",
		});

		render(
			<FeatureRunProgress
				projectId="p1"
				runId="run-1"
				onDismiss={() => {}}
			/>,
		);

		expect(screen.getByText(/over the per-run limit/i)).toBeInTheDocument();
	});

	it("stops polling once the run reaches a terminal status", () => {
		withRun({ ...BASE, status: "PASSED" });

		render(
			<FeatureRunProgress
				projectId="p1"
				runId="run-1"
				onDismiss={() => {}}
			/>,
		);

		const options = useQueryMock.mock.calls[0][0] as {
			refetchInterval: (q: unknown) => number | false;
		};
		expect(
			options.refetchInterval({
				state: { data: { run: { status: "PASSED" } } },
			}),
		).toBe(false);
		expect(
			options.refetchInterval({
				state: { data: { run: { status: "RUNNING" } } },
			}),
		).toBeGreaterThan(0);
	});
});
