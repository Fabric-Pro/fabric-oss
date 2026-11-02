import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
} from "@temporalio/common";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	activities: Object.fromEntries(
		[
			"updateCodingRunStatusActivity",
			"addCodingRunEventActivity",
			"buildImplementationPrompt",
			"createExecutionSession",
			"createRemoteExecutionSession",
			"cleanupRemoteWeaveResourcesActivity",
			"sendRemoteExecutionPrompt",
			"pollRemoteExecutionStatus",
			"syncRemoteCodingRunArtifacts",
			"cancelRemoteExecutionSession",
			"cleanupWeaveResourcesActivity",
			"deliverCodingRunFollowUp",
			"sendExecutionPrompt",
			"pollExecutionStatus",
			"syncCodingRunArtifacts",
			"cancelExecutionSession",
		].map((name) => [name, vi.fn()]),
	),
	handlers: {} as Record<string, (...args: any[]) => void>,
	now: 0,
	legacy: false,
	sleep: vi.fn(),
	workflowType: "codingRunWorkflow",
}));
vi.mock("@temporalio/workflow", async () => ({
	...(await import("@temporalio/common")),
	CancellationScope: { nonCancellable: (fn: () => unknown) => fn() },
	proxyActivities: () => f.activities,
	patched: () => !f.legacy,
	workflowInfo: () => ({
		workflowId: "example-workflow",
		workflowType: f.workflowType,
	}),
	defineSignal: (name: string) => name,
	defineQuery: (name: string) => name,
	setHandler: (name: string, fn: (...args: any[]) => void) => {
		f.handlers[name] = fn;
	},
	condition: async (_fn: unknown, timeout: string | number) => {
		f.now += typeof timeout === "number" ? timeout : 15_000;
		return false;
	},
	sleep: (...args: unknown[]) => f.sleep(...args),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { codingRunFollowUpWorkflow } from "../src/workflows/coding-run-follow-up";
import * as main from "../src/workflows/coding-run-workflow";

const input = {
	codingRunId: "example-run",
	projectId: "example-project",
	storyId: "example-story",
	userId: "example-user",
	organizationId: "example-org",
	provider: "BACKGROUND_AGENTS" as const,
	repositoryOwner: "example-org",
	repositoryName: "example-repo",
	storyTitle: "Example",
	fabricAgentsBridgeEnabled: true,
};
function failure(type: string, nonRetryable = true) {
	return new ActivityFailure(
		"Activity failed",
		"createExecutionSession",
		"example-activity",
		nonRetryable
			? RetryState.NON_RETRYABLE_FAILURE
			: RetryState.MAXIMUM_ATTEMPTS_REACHED,
		"example-worker",
		ApplicationFailure.create({
			message: "Example failure",
			type,
			nonRetryable,
		}),
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	f.now = 0;
	f.sleep.mockResolvedValue(undefined);
	f.legacy = false;
	f.workflowType = "codingRunWorkflow";
	f.handlers = {};
	vi.spyOn(Date, "now").mockImplementation(() => f.now);
	f.activities.updateCodingRunStatusGuardedActivity = vi.fn(
		async ({ workflowId, expectedStatuses, ...input }) =>
			f.activities.updateCodingRunStatusActivity(input),
	);
	f.activities.syncRemoteCodingRunArtifacts.mockImplementation((input) =>
		f.activities.syncCodingRunArtifacts(input),
	);
	f.activities.recordCodingRunRecoveryActivity = vi.fn(async (input) => {
		if (input.eventType === "cancellation_unknown") {
			await f.activities.updateCodingRunStatusActivity({
				codingRunId: input.codingRunId,
				status: "AWAITING_REVIEW",
			});
		}
		await f.activities.addCodingRunEventActivity({
			codingRunId: input.codingRunId,
			eventType: input.eventType,
			payload: input.payload,
		});
	});

	f.activities.buildImplementationPrompt.mockResolvedValue("Implement");
	f.activities.cleanupWeaveResourcesActivity.mockResolvedValue({
		destroyed: true,
	});
	f.activities.deliverCodingRunFollowUp.mockResolvedValue({
		messageId: "example-message",
	});
	f.activities.pollExecutionStatus.mockResolvedValue({
		providerStatus: "completed",
	});
});
it.each([false, true])(
	"closes a proven pre-POST failure terminal (cancel=%s) using the transported failure type",
	async (cancelled) => {
		f.activities.createExecutionSession.mockImplementation(async () => {
			if (cancelled) {
				f.handlers.cancelCodingRun();
			}
			throw failure("CODING_SESSION_NOT_CREATED");
		});
		expect(await main.codingRunWorkflow(input)).toMatchObject({
			status: cancelled ? "cancelled" : "failed",
		});
		expect(
			f.activities.updateCodingRunStatusActivity,
		).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: cancelled ? "CANCELLED" : "FAILED",
				data: { lastError: expect.stringContaining("not created") },
			}),
		);
		expect(
			f.activities.updateCodingRunStatusActivity.mock.calls.flat(),
		).not.toContainEqual(
			expect.objectContaining({ status: "AWAITING_REVIEW" }),
		);
	},
);
it("retains ambiguity for an old untyped activity or post-POST failure", async () => {
	f.activities.createExecutionSession.mockRejectedValue(failure("Error"));
	await main.codingRunWorkflow(input);
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "AWAITING_REVIEW" },
	);
});
it("uses a fenced activity for a remote-target workflow", async () => {
	f.workflowType = "remoteCodingRunWorkflow";
	f.activities.createRemoteExecutionSession.mockRejectedValue(
		failure("CODING_SESSION_NOT_CREATED"),
	);
	await (main as any).remoteCodingRunWorkflow({
		...input,
		providerMetadata: {
			executionRuntime: "fabric-agent-server",
			executionTarget: { connectionId: "example-connection" },
		},
	});
	expect(f.activities.createRemoteExecutionSession).toHaveBeenCalledWith(
		expect.objectContaining({
			providerMetadata: expect.objectContaining({
				executionTarget: { connectionId: "example-connection" },
			}),
		}),
	);
	expect(f.activities.createExecutionSession).not.toHaveBeenCalled();
});
it("continues observing after retryable poll exhaustion", async () => {
	f.activities.pollExecutionStatus.mockRejectedValueOnce(
		failure("NetworkError", false),
	);
	await codingRunFollowUpWorkflow({
		...input,
		sessionId: "example-session",
		promptId: "example-prompt",
		content: "Continue",
	});
	expect(f.activities.pollExecutionStatus).toHaveBeenCalledTimes(2);
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "COMPLETED" },
	);
});
it("bounds repeated poll failures by elapsed time", async () => {
	f.activities.pollExecutionStatus.mockImplementation(async () => {
		f.now += 60 * 60_000;
		throw failure("NetworkError", false);
	});
	await expect(
		codingRunFollowUpWorkflow({
			...input,
			sessionId: "example-session",
			promptId: "example-prompt",
			content: "Continue",
		}),
	).rejects.toThrow("timed out");
	expect(f.activities.pollExecutionStatus).toHaveBeenCalledTimes(2);
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "FAILED" },
	);
});
it("ends observation on a transported non-retryable session-gone error", async () => {
	f.activities.pollExecutionStatus.mockRejectedValue(
		failure("SESSION_NOT_FOUND"),
	);
	await expect(
		codingRunFollowUpWorkflow({
			...input,
			sessionId: "example-session",
			promptId: "example-prompt",
			content: "Continue",
		}),
	).rejects.toBeDefined();
	expect(f.activities.pollExecutionStatus).toHaveBeenCalledTimes(1);
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "FAILED" },
	);
});

it("fences all session operations and preserves the pinned target for the remote workflow", async () => {
	f.workflowType = "remoteCodingRunWorkflow";
	const providerMetadata = {
		executionRuntime: "fabric-agent-server",
		executionTarget: { connectionId: "example-connection" },
	};
	f.activities.createRemoteExecutionSession.mockResolvedValue({
		sessionId: "example-session",
		providerMetadata,
	});
	f.activities.pollRemoteExecutionStatus.mockResolvedValue({
		providerStatus: "completed",
		fabricStatus: "COMPLETED",
	});
	f.activities.syncRemoteCodingRunArtifacts.mockResolvedValue({
		pullRequestUrl: null,
		branchName: null,
	});
	f.activities.cleanupRemoteWeaveResourcesActivity.mockResolvedValue({
		destroyed: true,
	});
	await main.remoteCodingRunWorkflow({ ...input, providerMetadata });
	for (const name of [
		"sendRemoteExecutionPrompt",
		"pollRemoteExecutionStatus",
		"syncRemoteCodingRunArtifacts",
		"cancelRemoteExecutionSession",
		"cleanupRemoteWeaveResourcesActivity",
	]) {
		expect(f.activities[name]).toHaveBeenCalledWith(
			expect.objectContaining({ providerMetadata }),
		);
	}
	for (const name of [
		"sendExecutionPrompt",
		"pollExecutionStatus",
		"syncCodingRunArtifacts",
		"cancelExecutionSession",
		"cleanupWeaveResourcesActivity",
	]) {
		expect(f.activities[name]).not.toHaveBeenCalled();
	}
});

it("ignores the new failure classification on a legacy replay path", async () => {
	f.legacy = true;
	f.activities.createExecutionSession.mockRejectedValue(
		failure("CODING_SESSION_NOT_CREATED"),
	);
	await main.codingRunWorkflow(input);
	expect(f.activities.createExecutionSession).toHaveBeenCalledTimes(1);
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "FAILED" },
	);
});
it("tolerates an old activity's untyped session failure until it can observe completion", async () => {
	f.activities.pollExecutionStatus.mockRejectedValueOnce(
		failure("SessionValidationError", false),
	);
	await codingRunFollowUpWorkflow({
		...input,
		sessionId: "example-session",
		promptId: "example-prompt",
		content: "Continue",
	});
	expect(f.activities.pollExecutionStatus).toHaveBeenCalledTimes(2);
});
it("does not accept a successful poll that finishes after the observation deadline", async () => {
	f.activities.pollExecutionStatus.mockImplementation(async () => {
		f.now += 100 * 60_000;
		return { providerStatus: "completed" };
	});
	await expect(
		codingRunFollowUpWorkflow({
			...input,
			sessionId: "example-session",
			promptId: "example-prompt",
			content: "Continue",
		}),
	).rejects.toThrow("timed out");
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "FAILED" },
	);
});

it("does not interpret an untransported local error as definitive activity evidence", async () => {
	const error = new Error("Example local error", {
		cause: ApplicationFailure.nonRetryable(
			"Not created",
			"CODING_SESSION_NOT_CREATED",
		),
	});
	f.activities.createExecutionSession.mockRejectedValue(error);
	await main.codingRunWorkflow(input);
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "AWAITING_REVIEW" },
	);
});
it("does not treat a plain cause with a matching string as a Temporal application failure", async () => {
	f.activities.createExecutionSession.mockRejectedValue(
		new ActivityFailure(
			"Failed",
			"createExecutionSession",
			"example-activity",
			RetryState.NON_RETRYABLE_FAILURE,
			"example-worker",
			Object.assign(new Error("Not created"), {
				type: "CODING_SESSION_NOT_CREATED",
			}),
		),
	);
	await main.codingRunWorkflow(input);
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "AWAITING_REVIEW" },
	);
});
it("retains an existing session when another activity claims no session was created", async () => {
	f.activities.createExecutionSession.mockResolvedValue({
		sessionId: "example-session",
	});
	f.activities.sendExecutionPrompt.mockRejectedValue(
		failure("CODING_SESSION_NOT_CREATED"),
	);
	f.activities.cancelExecutionSession.mockRejectedValue(
		failure("RECOVERY_REQUIRED"),
	);
	f.activities.cleanupWeaveResourcesActivity.mockResolvedValue({
		destroyed: false,
	});
	await main.codingRunWorkflow(input);
	expect(
		f.activities.updateCodingRunStatusActivity.mock.calls.flat(),
	).not.toContainEqual(expect.objectContaining({ status: "FAILED" }));
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		{ codingRunId: input.codingRunId, status: "AWAITING_REVIEW" },
	);
});

it.each([failure("SESSION_NOT_FOUND", false), failure("OTHER_FAILURE", true)])(
	"continues after a poll error that does not prove the session is gone",
	async (error) => {
		f.activities.pollExecutionStatus.mockRejectedValueOnce(error);
		await codingRunFollowUpWorkflow({
			...input,
			sessionId: "example-session",
			promptId: "example-prompt",
			content: "Continue",
		});
		expect(f.activities.pollExecutionStatus).toHaveBeenCalledTimes(2);
	},
);

it("ends unregistered creation terminal because the activity body could not run", async () => {
	f.activities.createExecutionSession.mockRejectedValue(
		failure("NotFoundError", false),
	);
	await main.codingRunWorkflow(input);
	expect(f.activities.updateCodingRunStatusActivity).toHaveBeenLastCalledWith(
		expect.objectContaining({ status: "FAILED" }),
	);
});
it("retries only proven not-created failures in the workflow before succeeding", async () => {
	f.activities.createExecutionSession
		.mockRejectedValueOnce(failure("CODING_SESSION_NOT_CREATED", false))
		.mockResolvedValue({ sessionId: "example-session" });
	f.activities.syncCodingRunArtifacts.mockResolvedValue({
		pullRequestUrl: null,
		branchName: null,
	});
	await main.codingRunWorkflow(input);
	expect(f.activities.createExecutionSession).toHaveBeenCalledTimes(2);
});
it("keeps post-send uncertainty to one creation call", async () => {
	f.activities.createExecutionSession.mockRejectedValue(
		failure("NETWORK_ERROR", false),
	);
	await main.codingRunWorkflow(input);
	expect(f.activities.createExecutionSession).toHaveBeenCalledTimes(1);
});

it("bounds proven-unsent retries to three calls", async () => {
	f.activities.createExecutionSession
		.mockRejectedValueOnce(failure("CODING_SESSION_NOT_CREATED", false))
		.mockRejectedValueOnce(failure("CODING_SESSION_NOT_CREATED", false))
		.mockRejectedValueOnce(failure("CODING_SESSION_NOT_CREATED", false))
		.mockResolvedValue({ sessionId: "example-session" });
	await main.codingRunWorkflow(input);
	expect(f.activities.createExecutionSession).toHaveBeenCalledTimes(3);
});
it("distinguishes unregistered cancellation from a stop request whose outcome is unknown", async () => {
	f.activities.createExecutionSession.mockResolvedValue({
		sessionId: "example-session",
	});
	f.activities.sendExecutionPrompt.mockRejectedValue(
		failure("NotFoundError", false),
	);
	f.activities.cancelExecutionSession.mockRejectedValue(
		failure("NotFoundError", false),
	);
	await main.codingRunWorkflow(input);
	expect(f.activities.recordCodingRunRecoveryActivity).toHaveBeenCalledWith(
		expect.objectContaining({
			payload: expect.objectContaining({
				message: expect.stringContaining("no stop request was sent"),
			}),
		}),
	);
});
it("sends guarded status and continuation-recovery contracts for follow-ups", async () => {
	f.activities.deliverCodingRunFollowUp.mockRejectedValue(
		failure("INVALID_SESSION"),
	);
	await expect(
		codingRunFollowUpWorkflow({
			...input,
			sessionId: "example-session",
			promptId: "example-prompt",
			content: "Continue",
		}),
	).rejects.toBeDefined();
	expect(f.activities.recordCodingRunRecoveryActivity).toHaveBeenCalledWith(
		expect.objectContaining({
			workflowId: "example-workflow",
			eventType: "continuation_recovery_required",
		}),
	);
	expect(
		f.activities.updateCodingRunStatusGuardedActivity,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedStatuses: expect.not.arrayContaining([
				"FAILED",
				"COMPLETED",
				"CANCELLED",
			]),
		}),
	);
});

it("backs off only between safe creation retries and stops after a cancellation during backoff", async () => {
	f.activities.createExecutionSession.mockRejectedValue(
		failure("CODING_SESSION_NOT_CREATED", false),
	);
	await main.codingRunWorkflow(input);
	expect(f.sleep.mock.calls).toEqual([[2000], [4000]]);
	f.activities.createExecutionSession.mockClear();
	f.sleep.mockReset();
	f.sleep.mockImplementation(async () => {
		f.handlers.cancelCodingRun();
	});
	await main.codingRunWorkflow(input);
	expect(f.activities.createExecutionSession).toHaveBeenCalledTimes(1);
	expect(
		f.activities.updateCodingRunStatusGuardedActivity,
	).toHaveBeenLastCalledWith(
		expect.objectContaining({ status: "CANCELLED" }),
	);
});

it("does not sleep or retry when cancellation was already requested during creation", async () => {
	f.activities.createExecutionSession.mockImplementation(async () => {
		f.handlers.cancelCodingRun();
		throw failure("CODING_SESSION_NOT_CREATED", false);
	});
	await main.codingRunWorkflow(input);
	expect(f.sleep).not.toHaveBeenCalled();
	expect(f.activities.createExecutionSession).toHaveBeenCalledTimes(1);
});
