import {
	ApplicationFailure,
	CancelledFailure,
	TerminatedFailure,
	WorkflowFailedError,
} from "@temporalio/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	backlogAnalysisWorkflowId,
	backlogApplyWorkflowId,
} from "../workflow-id";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, (args: any) => Promise<any>>,
	route: "",
	client: vi.fn(),
	query: vi.fn(),
	result: vi.fn(),
	describe: vi.fn(),
	history: vi.fn(),
	handle: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: () => builder,
		route: ({ summary }: { summary: string }) => {
			h.route = summary;
			return builder;
		},
		input: () => builder,
		handler: (fn: any) => {
			h.handlers[h.route] = fn;
			return builder;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: vi.fn(),
		Permissions: { PROJECT_UPDATE: "PROJECT_UPDATE" },
	};
});
vi.mock("@repo/temporal", async () => ({
	...(await import(
		"../../../../../../temporal/src/workflows/backlog-constants"
	)),
	getTemporalClient: h.client,
	applyProgressQuery: "apply",
	analysisProgressQuery: "analysis",
	analysisResultQuery: "proposal",
}));
import "../apply-progress";
import "../analysis-progress";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	h.client.mockResolvedValue({ workflow: { getHandle: h.handle } });
	h.handle.mockReturnValue({
		query: h.query,
		result: h.result,
		describe: h.describe,
		fetchHistory: h.history,
	});
	h.query.mockRejectedValue(new Error("Query unavailable"));
	h.describe.mockResolvedValue({ status: { name: "RUNNING" } });
	h.history.mockResolvedValue({ events: [] });
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

for (const kind of ["apply", "analysis"] as const) {
	const call = () =>
		h.handlers[
			kind === "apply" ? "Get apply progress" : "Get analysis progress"
		]({
			input: {
				projectId: "example-project",
				workflowId:
					kind === "apply"
						? backlogApplyWorkflowId("example-project", 1)
						: backlogAnalysisWorkflowId(
								"example-project",
								"example-flow",
							),
			},
		});
	const progressOf = (value: any) =>
		kind === "apply" ? value : value.progress;
	describe(`${kind} terminal evidence`, () => {
		it.each(["RUNNING", "COMPLETED"])(
			"throws a connection error when describe says %s",
			async (status) => {
				const error = new Error("Temporal connection unavailable");
				h.result.mockRejectedValue(error);
				h.describe.mockResolvedValue({ status: { name: status } });
				await expect(call()).rejects.toBe(error);
			},
		);
		it("throws a connection error when describe also fails", async () => {
			const error = new Error("Temporal connection unavailable");
			h.result.mockRejectedValue(error);
			h.describe.mockRejectedValue(error);
			await expect(call()).rejects.toBe(error);
		});
		it("does not trust a WorkflowFailedError lookalike", async () => {
			const error = Object.assign(
				new Error("WorkflowFailed connection unavailable"),
				{ name: "WorkflowFailedError" },
			);
			h.result.mockRejectedValue(error);
			await expect(call()).rejects.toBe(error);
		});
		it("returns failed for an SDK WorkflowFailedError even if describe is unavailable", async () => {
			h.result.mockRejectedValue(
				new WorkflowFailedError(
					"Workflow execution failed",
					new Error("Example terminal failure"),
					"NON_RETRYABLE_FAILURE",
				),
			);
			h.describe.mockRejectedValue(new Error("Describe unavailable"));
			expect(progressOf(await call())).toMatchObject({
				status: "failed",
				message: "Example terminal failure",
			});
		});
		it.each(["signal", "sdk"])(
			"preserves %s cancellation from an SDK failure cause",
			async (source) => {
				const cause =
					source === "signal"
						? ApplicationFailure.nonRetryable(
								"Cancelled by user",
								kind === "apply"
									? "BACKLOG_APPLY_CANCELLED"
									: "BACKLOG_ANALYSIS_CANCELLED",
							)
						: new CancelledFailure("Cancelled by user");
				h.result.mockRejectedValue(
					new WorkflowFailedError(
						"Workflow execution failed",
						cause,
						"NON_RETRYABLE_FAILURE",
					),
				);
				h.describe.mockRejectedValue(new Error("Describe unavailable"));
				expect(progressOf(await call()).status).toBe("cancelled");
			},
		);
		it.each(["FAILED", "TERMINATED", "TIMED_OUT"])(
			"returns failed when describe confirms %s",
			async (status) => {
				h.result.mockRejectedValue(new Error("Result unavailable"));
				h.describe.mockResolvedValue({ status: { name: status } });
				expect(progressOf(await call()).status).toBe("failed");
			},
		);
		it("returns cancelled when describe confirms CANCELLED", async () => {
			h.result.mockRejectedValue(new Error("Result unavailable"));
			h.describe.mockResolvedValue({ status: { name: "CANCELLED" } });
			expect(progressOf(await call()).status).toBe("cancelled");
		});
		it("keeps observing a paused execution with live nonterminal progress", async () => {
			h.query.mockResolvedValue({
				status: kind === "apply" ? "applying" : "analyzing",
				message: "Waiting for a worker",
			});
			h.describe.mockResolvedValue({ status: { name: "PAUSED" } });
			expect(progressOf(await call()).status).toBe(
				kind === "apply" ? "applying" : "analyzing",
			);
		});

		it("preserves a live terminal cancelled query", async () => {
			h.query.mockResolvedValue({
				status: "cancelled",
				message: "Cancelled by user",
			});
			expect(progressOf(await call()).status).toBe("cancelled");
		});
		it.each(["FAILED", "TERMINATED", "TIMED_OUT"])(
			"reconciles stale live progress after %s",
			async (status) => {
				h.query.mockResolvedValue({
					status: kind === "apply" ? "applying" : "analyzing",
				});
				h.describe.mockResolvedValue({ status: { name: status } });
				h.result.mockRejectedValue(
					new WorkflowFailedError(
						"Workflow execution failed",
						new Error("Example terminal failure"),
						"NON_RETRYABLE_FAILURE",
					),
				);
				expect(progressOf(await call()).status).toBe("failed");
			},
		);
		it("reconciles stale live progress after a successful close", async () => {
			h.query.mockResolvedValue({
				status: kind === "apply" ? "syncing_pm" : "analyzing",
			});
			h.describe.mockResolvedValue({ status: { name: "COMPLETED" } });
			h.result.mockResolvedValue({
				success: true,
				appliedCount: 0,
				syncedToPMCount: 0,
			});
			expect(progressOf(await call()).status).toBe(
				kind === "apply" ? "completed" : "complete",
			);
		});
		it("keeps NOT_FOUND on the local result timeout", async () => {
			h.result.mockImplementation(() => new Promise(() => {}));
			const pending = expect(call()).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await vi.advanceTimersByTimeAsync(3000);
			await pending;
		});
		it("rejects foreign project IDs before Temporal access", async () => {
			const handler =
				h.handlers[
					kind === "apply"
						? "Get apply progress"
						: "Get analysis progress"
				];
			await expect(
				handler({
					input: {
						projectId: "example-other-project",
						workflowId:
							kind === "apply"
								? backlogApplyWorkflowId("example-project", 1)
								: backlogAnalysisWorkflowId(
										"example-project",
										"example-flow",
									),
					},
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(h.client).not.toHaveBeenCalled();
		});
		if (kind === "apply") {
			it.each([
				["cancelled_by_user", "cancelled", "Apply cancelled."],
				[
					"backlog_apply_watchdog_stale",
					"failed",
					"Apply stopped because it stopped making progress. Open Review proposals to retry it.",
				],
				["example_unknown_reason", "failed", "Apply was stopped."],
			])(
				"maps apply termination reason %s before the proposal row is stamped",
				async (reason, status, message) => {
					h.result.mockRejectedValue(new Error("Result unavailable"));
					h.describe.mockResolvedValue({
						status: { name: "TERMINATED" },
					});
					h.history.mockResolvedValue({
						events: [
							{
								workflowExecutionTerminatedEventAttributes: {
									reason,
								},
							},
						],
					});
					expect(progressOf(await call())).toMatchObject({
						status,
						message,
						errors: [message],
					});
				},
			);
			it("hides apply termination reasons when the history read fails", async () => {
				h.result.mockRejectedValue(
					new WorkflowFailedError(
						"example_unknown_reason",
						new TerminatedFailure("example_unknown_reason"),
						"NON_RETRYABLE_FAILURE",
					),
				);
				h.describe.mockResolvedValue({
					status: { name: "TERMINATED" },
				});
				h.history.mockRejectedValue(new Error("History unavailable"));
				expect(progressOf(await call())).toMatchObject({
					status: "failed",
					message: "Apply was stopped.",
				});
			});
			it("recognizes a known SDK termination cause when describe is unavailable", async () => {
				h.result.mockRejectedValue(
					new WorkflowFailedError(
						"cancelled_by_user",
						new TerminatedFailure("cancelled_by_user"),
						"NON_RETRYABLE_FAILURE",
					),
				);
				h.describe.mockRejectedValue(new Error("Describe unavailable"));
				expect(progressOf(await call())).toMatchObject({
					status: "cancelled",
					message: "Apply cancelled.",
				});
			});
		}

		if (kind === "analysis") {
			it("returns null for a successful empty live result query", async () => {
				h.query.mockImplementation(async (query) =>
					query === "analysis"
						? {
								status: "complete",
								message: "No selected transcript available",
							}
						: null,
				);
				expect(await call()).toMatchObject({
					progress: {
						status: "complete",
						message: "No selected transcript available",
					},
					proposal: null,
				});
			});
			it("does not turn a throwing result query into an empty success", async () => {
				const error = new Error("Temporal connection unavailable");
				h.query.mockImplementation(async (query) => {
					if (query === "analysis") {
						return { status: "complete" };
					}
					throw error;
				});
				h.result.mockRejectedValue(error);
				await expect(call()).rejects.toBe(error);
			});
			it("recovers a throwing result query from the completed result", async () => {
				h.query.mockImplementation(async (query) => {
					if (query === "analysis") {
						return { status: "complete" };
					}
					throw new Error("Query unavailable");
				});
				h.result.mockResolvedValue({
					success: true,
					proposal: {
						changes: [],
						summary: "Example empty proposal",
					},
				});
				expect(await call()).toMatchObject({
					progress: { status: "complete" },
					proposal: { summary: "Example empty proposal" },
				});
			});
			it("preserves skippedReason on the empty result fallback", async () => {
				h.result.mockResolvedValue({
					success: true,
					skippedReason: "No selected transcript available",
				});
				expect(await call()).toMatchObject({
					progress: {
						status: "complete",
						message: "No selected transcript available",
					},
					proposal: null,
				});
			});
			it("preserves termination history reasons", async () => {
				h.result.mockRejectedValue(new Error("Result unavailable"));
				h.describe.mockResolvedValue({
					status: { name: "TERMINATED" },
				});
				h.history.mockResolvedValue({
					events: [
						{
							workflowExecutionTerminatedEventAttributes: {
								reason: "Example size limit",
							},
						},
					],
				});
				expect(progressOf(await call())).toMatchObject({
					status: "failed",
					message: "Analysis terminated: Example size limit",
				});
			});
		}
	});
}
