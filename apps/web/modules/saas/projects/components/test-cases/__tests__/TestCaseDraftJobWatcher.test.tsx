/**
 * TestCaseDraftJobWatcher — the persistent progress toast's Cancel action
 * (the cancel procedure existed with no UI surface, so a
 * stuck run could only be waited out).
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const cancelMutateSpy = vi.fn();
const toastLoading = vi.fn();
const toastDismiss = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: {
		loading: (...a: unknown[]) => toastLoading(...a),
		dismiss: (...a: unknown[]) => toastDismiss(...a),
		success: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../TestCaseDraftResultsSheet", () => ({
	TestCaseDraftResultsSheet: () => null,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			testCases: {
				draftJobs: {
					list: {
						queryOptions: (opts: unknown) => opts,
						key: () => ["jobs"],
					},
					cancel: { mutationOptions: (opts: unknown) => opts },
				},
				list: { key: () => ["cases"] },
			},
		},
	},
}));

import { TestCaseDraftJobWatcher } from "../TestCaseDraftJobWatcher";

beforeEach(() => {
	vi.clearAllMocks();
	useMutationMock.mockReturnValue({
		mutate: cancelMutateSpy,
		isPending: false,
	});
});

describe("TestCaseDraftJobWatcher — cancel action", () => {
	it("puts a Cancel action on the progress toast, wired to the active run", () => {
		useQueryMock.mockReturnValue({
			data: {
				jobs: [
					{
						id: "job-9",
						status: "RUNNING",
						processedFeatures: 1,
						totalFeatures: 3,
						createdCount: 0,
						error: null,
					},
				],
			},
		});

		render(
			<TestCaseDraftJobWatcher projectId="p1" organizationId={null} />,
		);

		expect(toastLoading).toHaveBeenCalled();
		const options = toastLoading.mock.calls[0][1] as {
			action?: { label: string; onClick: () => void };
		};
		expect(options.action?.label).toBe("ai.cancelRun");

		options.action?.onClick();
		expect(cancelMutateSpy).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: null,
			jobId: "job-9",
		});
	});

	it("dismisses the progress toast when the watcher unmounts mid-run", () => {
		// Regression: the effect had no cleanup, and the QA tab is
		// rendered conditionally — switching project tabs during a draft run
		// unmounted the watcher and left an infinite-duration toast pinned to
		// the screen, never updating, with a dead Cancel action. Reload was the
		// only way out.
		useQueryMock.mockReturnValue({
			data: {
				jobs: [
					{
						id: "job-9",
						status: "RUNNING",
						processedFeatures: 1,
						totalFeatures: 3,
						createdCount: 0,
						error: null,
					},
				],
			},
		});

		const view = render(
			<TestCaseDraftJobWatcher projectId="p1" organizationId={null} />,
		);
		expect(toastLoading).toHaveBeenCalled();

		toastDismiss.mockClear();
		view.unmount();
		expect(toastDismiss).toHaveBeenCalledWith("test-case-draft-progress");
	});

	it("shows no toast (and no cancel) without an active run", () => {
		useQueryMock.mockReturnValue({ data: { jobs: [] } });

		render(
			<TestCaseDraftJobWatcher projectId="p1" organizationId={null} />,
		);

		expect(toastLoading).not.toHaveBeenCalled();
		expect(cancelMutateSpy).not.toHaveBeenCalled();
	});
});
