import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const syncProgressMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				syncProgress: (...a: unknown[]) => syncProgressMock(...a),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryKey: (args: { input: unknown }) => [
					"projects.get",
					args.input,
				],
			},
			stories: {
				list: {
					queryKey: (args: { input: unknown }) => [
						"stories.list",
						args.input,
					],
				},
			},
		},
	},
}));

const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { usePmSyncProgressPoll } from "../usePmSyncProgressPoll";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const initial = {
	status: "initializing",
	syncedCount: 0,
	totalStories: 0,
	message: "Listing work items from PM...",
};

function renderPoll(onTerminal = vi.fn()) {
	const hook = renderHook(
		() =>
			usePmSyncProgressPoll({
				projectId: "proj_1",
				organizationId: null,
				pmToolName: "Jira",
				activePmSync: null,
				onReviewConflicts: vi.fn(),
				onTerminal,
			}),
		{ wrapper },
	);
	return { ...hook, onTerminal };
}

function completed(jobStatus: "RUNNING" | "COMPLETED" | null) {
	return {
		status: "completed",
		totalStories: 0,
		syncedCount: 0,
		failedCount: 0,
		conflictedCount: 0,
		message: "Sync completed",
		results: [],
		jobStatus,
	};
}

beforeEach(() => {
	client = new QueryClient();
});

afterEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
	client.clear();
});

describe("usePmSyncProgressPoll", () => {
	it("reports a confirmed empty pull once, as 'No new work items', and refreshes the gates", async () => {
		syncProgressMock.mockResolvedValue(completed("COMPLETED"));
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const { result, onTerminal } = renderPoll();

		act(() => result.current.track("wf_1", "pull", initial));

		await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
		expect(onTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf_1",
				jobStatus: "COMPLETED",
			}),
		);
		expect(toastMock.success).toHaveBeenCalledWith(
			"No new work items",
			expect.objectContaining({
				description: "Your Roadmap already has everything from Jira.",
			}),
		);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["capability-gates"],
		});
		expect(result.current.workflowId).toBeNull();
	});

	it("keeps polling while a completed run's row lags, then resolves on the row", async () => {
		syncProgressMock
			.mockResolvedValueOnce(completed("RUNNING"))
			.mockResolvedValueOnce(completed(null))
			.mockResolvedValue(completed("COMPLETED"));
		const { result, onTerminal } = renderPoll();

		act(() => result.current.track("wf_1", "pull", initial));

		await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1), {
			timeout: 5000,
		});
		expect(syncProgressMock.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(onTerminal.mock.calls[0]?.[0].jobStatus).toBe("COMPLETED");
	});

	it("reports a replaced sync as unresolved instead of dropping it", () => {
		syncProgressMock.mockReturnValue(new Promise(() => {}));
		const { result, onTerminal } = renderPoll();

		act(() => result.current.track("wf_1", "pull", initial));
		act(() => result.current.track("wf_2", "push", initial));

		expect(onTerminal).toHaveBeenCalledTimes(1);
		expect(onTerminal).toHaveBeenCalledWith({
			workflowId: "wf_1",
			direction: "pull",
			jobStatus: null,
			progress: null,
		});
		expect(result.current.workflowId).toBe("wf_2");
	});

	it("picks up a sync already running when the page loads, once", async () => {
		syncProgressMock.mockReturnValue(new Promise(() => {}));
		const activePmSync = {
			workflowId: "wf_live",
			direction: "pull" as const,
			startedAt: new Date(),
		};
		const { result } = renderHook(
			() =>
				usePmSyncProgressPoll({
					projectId: "proj_1",
					organizationId: null,
					pmToolName: "Jira",
					activePmSync,
					onReviewConflicts: vi.fn(),
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.workflowId).toBe("wf_live"));
		expect(result.current.direction).toBe("pull");
	});
});
