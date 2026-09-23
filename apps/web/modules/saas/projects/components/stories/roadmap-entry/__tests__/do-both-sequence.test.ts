import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecommendationStartError } from "../../recommendations/useRecommendationRun";
import {
	DO_BOTH_IDLE,
	type DoBothState,
	doBothReducer,
	useDoBothSequence,
} from "../do-both-sequence";

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

const pulling: DoBothState = { step: "pulling", workflowId: "wf_1" };

function finished(
	jobStatus: "COMPLETED" | "FAILED" | "RUNNING" | null,
	failedCount = 0,
) {
	return doBothReducer(pulling, {
		type: "PULL_FINISHED",
		workflowId: "wf_1",
		jobStatus,
		failedCount,
	});
}

describe("doBothReducer", () => {
	it("FR21: pulls first — begin selects, confirm starts the pull", () => {
		const selecting = doBothReducer(DO_BOTH_IDLE, { type: "BEGIN" });
		expect(selecting).toEqual({ step: "selecting" });
		expect(
			doBothReducer(selecting, {
				type: "PULL_STARTED",
				workflowId: "wf_1",
			}),
		).toEqual(pulling);
	});

	it("closing the pull dialog before confirming abandons the sequence", () => {
		expect(
			doBothReducer({ step: "selecting" }, { type: "DIALOG_CLOSED" }),
		).toEqual(DO_BOTH_IDLE);
	});

	it("FR22: continues to recommending after a confirmed, clean pull", () => {
		expect(finished("COMPLETED")).toEqual({
			step: "recommending",
			pull: "done",
			pullWorkflowId: "wf_1",
		});
	});

	it("FR45: a pull that found nothing new still continues", () => {
		// Zero synced is a COMPLETED row with zero failures, same as above.
		expect(finished("COMPLETED", 0).step).toBe("recommending");
	});

	it("FR23: stops on a FAILED pull", () => {
		expect(finished("FAILED")).toEqual({
			step: "pull-failed",
			message: null,
		});
	});

	it("stops on a pull that completed with failed items", () => {
		expect(finished("COMPLETED", 2).step).toBe("pull-failed");
	});

	it("never auto-starts on an unknown outcome", () => {
		expect(finished(null)).toEqual({
			step: "pull-unknown",
			workflowId: "wf_1",
		});
		expect(finished("RUNNING").step).toBe("pull-unknown");
	});

	it("ignores a pull it did not start", () => {
		expect(
			doBothReducer(pulling, {
				type: "PULL_FINISHED",
				workflowId: "wf_other",
				jobStatus: "COMPLETED",
				failedCount: 0,
			}),
		).toEqual(pulling);
		expect(
			doBothReducer(DO_BOTH_IDLE, {
				type: "PULL_FINISHED",
				workflowId: "wf_1",
				jobStatus: "COMPLETED",
				failedCount: 0,
			}),
		).toEqual(DO_BOTH_IDLE);
	});

	it("a pull that fails to start stops the sequence", () => {
		expect(
			doBothReducer(
				{ step: "selecting" },
				{ type: "PULL_START_FAILED", message: "boom" },
			),
		).toEqual({ step: "pull-failed", message: "boom" });
	});

	it("FR24: after a failure, retry pull reopens the selection", () => {
		expect(
			doBothReducer(
				{ step: "pull-failed", message: null },
				{ type: "RETRY_PULL" },
			),
		).toEqual({ step: "selecting" });
	});

	it("FR24: after a failure, recommend by hand without the failed pull", () => {
		expect(
			doBothReducer(
				{ step: "pull-failed", message: null },
				{ type: "RECOMMEND_INSTEAD" },
			),
		).toEqual({
			step: "recommending",
			pull: "failed",
			pullWorkflowId: null,
		});
	});

	it("after an unknown outcome, a manual recommend never reports the pull as done", () => {
		const recommending = doBothReducer(
			{ step: "pull-unknown", workflowId: "wf_1" },
			{ type: "RECOMMEND_INSTEAD" },
		);
		expect(recommending).toEqual({
			step: "recommending",
			pull: "unknown",
			pullWorkflowId: null,
		});
		expect(
			doBothReducer(recommending, { type: "RECOMMEND_STARTED" }),
		).toEqual({ step: "recommend-started", pull: "unknown" });
	});

	it("FR44/FR45: nothing new to pull continues to recommending", () => {
		expect(
			doBothReducer({ step: "selecting" }, { type: "NOTHING_NEW" }),
		).toEqual({
			step: "recommending",
			pull: "nothing-new",
			pullWorkflowId: null,
		});
		expect(doBothReducer(DO_BOTH_IDLE, { type: "NOTHING_NEW" })).toEqual(
			DO_BOTH_IDLE,
		);
	});

	it("RESTORE picks a running pull back up only from idle", () => {
		expect(
			doBothReducer(DO_BOTH_IDLE, {
				type: "RESTORE",
				workflowId: "wf_1",
			}),
		).toEqual(pulling);
		const settled: DoBothState = {
			step: "recommend-started",
			pull: "done",
		};
		expect(
			doBothReducer(settled, { type: "RESTORE", workflowId: "wf_1" }),
		).toEqual(settled);
	});

	it("does not restart while a pull is running", () => {
		expect(doBothReducer(pulling, { type: "BEGIN" })).toEqual(pulling);
		expect(doBothReducer(pulling, { type: "RESET" })).toEqual(pulling);
	});
});

function hookArgs(
	overrides: Partial<Parameters<typeof useDoBothSequence>[1]> = {},
): Parameters<typeof useDoBothSequence>[1] {
	return {
		projectId: "p1",
		activePmSyncWorkflowId: null,
		roadmapEmpty: true,
		...overrides,
	};
}

describe("useDoBothSequence", () => {
	afterEach(() => {
		window.sessionStorage.clear();
	});

	it("FR27: starts the recommendation after the pull, naming the pull", async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useDoBothSequence(
				{ start, isStarting: false, isRunning: false },
				hookArgs(),
			),
		);
		act(() => result.current.begin());
		act(() => result.current.pullStarted("wf_1"));
		act(() =>
			result.current.pullFinished({
				workflowId: "wf_1",
				jobStatus: "COMPLETED",
				failedCount: 0,
			}),
		);
		await waitFor(() =>
			expect(result.current.state.step).toBe("recommend-started"),
		);
		expect(start).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledWith({
			entryPoint: "DO_BOTH_AFTER_PULL",
			precedingPullWorkflowId: "wf_1",
		});
	});

	it("reports a starter failure as recommend-failed", async () => {
		const start = vi.fn().mockRejectedValue(new Error("no model"));
		const { result } = renderHook(() =>
			useDoBothSequence(
				{ start, isStarting: false, isRunning: false },
				hookArgs(),
			),
		);
		act(() => result.current.begin());
		act(() => result.current.pullStartFailed("x"));
		act(() => result.current.recommendInstead());
		await waitFor(() =>
			expect(result.current.state).toEqual({
				step: "recommend-failed",
				failure: { title: null, body: "no model" },
				pull: "failed",
			}),
		);
		expect(start).toHaveBeenCalledWith({ entryPoint: "EMPTY_ROADMAP" });
	});

	it("does nothing on an unknown outcome until asked", async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useDoBothSequence(
				{ start, isStarting: false, isRunning: false },
				hookArgs(),
			),
		);
		act(() => result.current.begin());
		act(() => result.current.pullStarted("wf_1"));
		act(() =>
			result.current.pullFinished({
				workflowId: "wf_1",
				jobStatus: null,
				failedCount: 0,
			}),
		);
		expect(result.current.state.step).toBe("pull-unknown");
		expect(start).not.toHaveBeenCalled();
	});

	it("7: a manual recommend on a Roadmap with items sends MATURE_ROADMAP", async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useDoBothSequence(
				{ start, isStarting: false, isRunning: false },
				hookArgs({ roadmapEmpty: false }),
			),
		);
		act(() => result.current.begin());
		act(() => result.current.pullStartFailed("x"));
		act(() => result.current.recommendInstead());
		await waitFor(() =>
			expect(result.current.state.step).toBe("recommend-started"),
		);
		expect(start).toHaveBeenCalledWith({ entryPoint: "MATURE_ROADMAP" });
	});

	it("8: an unconfirmed pull then Recommend instead is not sent as DO_BOTH_AFTER_PULL", async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useDoBothSequence(
				{ start, isStarting: false, isRunning: false },
				hookArgs(),
			),
		);
		act(() => result.current.begin());
		act(() => result.current.pullStarted("wf_1"));
		act(() =>
			result.current.pullFinished({
				workflowId: "wf_1",
				jobStatus: null,
				failedCount: 0,
			}),
		);
		act(() => result.current.recommendInstead());
		await waitFor(() =>
			expect(result.current.state).toEqual({
				step: "recommend-started",
				pull: "unknown",
			}),
		);
		expect(start).toHaveBeenCalledWith({ entryPoint: "EMPTY_ROADMAP" });
	});

	it("FR45: nothing new to pull starts the run as DO_BOTH_AFTER_PULL", async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useDoBothSequence(
				{ start, isStarting: false, isRunning: false },
				hookArgs(),
			),
		);
		act(() => result.current.begin());
		act(() => result.current.nothingNew());
		await waitFor(() =>
			expect(result.current.state).toEqual({
				step: "recommend-started",
				pull: "nothing-new",
			}),
		);
		expect(start).toHaveBeenCalledWith({
			entryPoint: "DO_BOTH_AFTER_PULL",
		});
	});

	it("keeps a gate refusal's title apart from its body (FR37)", async () => {
		const start = vi
			.fn()
			.mockRejectedValue(
				new RecommendationStartError("FR37 body", "Title"),
			);
		const { result } = renderHook(() =>
			useDoBothSequence(
				{ start, isStarting: false, isRunning: false },
				hookArgs(),
			),
		);
		act(() => result.current.begin());
		act(() => result.current.pullStartFailed("x"));
		act(() => result.current.recommendInstead());
		await waitFor(() =>
			expect(result.current.state).toMatchObject({
				step: "recommend-failed",
				failure: { title: "Title", body: "FR37 body" },
			}),
		);
	});

	it("i18n: no starter fails with the translated 'unavailable' copy", async () => {
		const { result } = renderHook(() =>
			useDoBothSequence(null, hookArgs()),
		);
		act(() => result.current.begin());
		act(() => result.current.nothingNew());
		await waitFor(() =>
			expect(result.current.state).toMatchObject({
				step: "recommend-failed",
				failure: { title: null, body: "unavailable" },
			}),
		);
	});

	it("S5: a running pull survives a remount and step 2 still runs", async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const starter = { start, isStarting: false, isRunning: false };
		const first = renderHook(() => useDoBothSequence(starter, hookArgs()));
		act(() => first.result.current.begin());
		act(() => first.result.current.pullStarted("wf_1"));
		first.unmount();

		const second = renderHook(
			({ active }: { active: string | null | undefined }) =>
				useDoBothSequence(
					starter,
					hookArgs({ activePmSyncWorkflowId: active }),
				),
			{
				initialProps: {
					active: undefined as string | null | undefined,
				},
			},
		);
		// Still loading: nothing restored, nothing forgotten.
		expect(second.result.current.state).toEqual(DO_BOTH_IDLE);
		second.rerender({ active: "wf_1" });
		expect(second.result.current.state).toEqual(pulling);

		act(() =>
			second.result.current.pullFinished({
				workflowId: "wf_1",
				jobStatus: "COMPLETED",
				failedCount: 0,
			}),
		);
		await waitFor(() =>
			expect(second.result.current.state.step).toBe("recommend-started"),
		);
		expect(start).toHaveBeenCalledTimes(1);
		// Moving on from `pulling` forgets the stored step.
		expect(
			window.sessionStorage.getItem("fabric:roadmap-do-both:p1"),
		).toBeNull();
	});

	it("S5: a project read with no running sync (possibly stale) keeps the stored pull", () => {
		window.sessionStorage.setItem(
			"fabric:roadmap-do-both:p1",
			JSON.stringify({ step: "pulling", workflowId: "wf_1" }),
		);
		const { result } = renderHook(() =>
			useDoBothSequence(null, hookArgs({ activePmSyncWorkflowId: null })),
		);
		expect(result.current.state).toEqual(DO_BOTH_IDLE);
		expect(
			window.sessionStorage.getItem("fabric:roadmap-do-both:p1"),
		).not.toBeNull();
	});

	it("S5: a stored pull that is no longer the running sync is dropped", () => {
		window.sessionStorage.setItem(
			"fabric:roadmap-do-both:p1",
			JSON.stringify({ step: "pulling", workflowId: "wf_old" }),
		);
		const { result } = renderHook(() =>
			useDoBothSequence(
				null,
				hookArgs({ activePmSyncWorkflowId: "wf_other" }),
			),
		);
		expect(result.current.state).toEqual(DO_BOTH_IDLE);
		expect(
			window.sessionStorage.getItem("fabric:roadmap-do-both:p1"),
		).toBeNull();
	});
});
