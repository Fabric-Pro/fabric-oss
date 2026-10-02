/**
 * The follow-up run's two activities: wait for the project's open sync to
 * close, then start the run a member asked for. The starts are the syncs' own
 * (same workflow type, queue, id and `FAIL` policy as the API's), so a follow-up
 * and a "Sync now" collapse onto one run.
 */
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	getHandle: vi.fn(),
	describe: vi.fn(),
	getInstructionRepositorySync: vi.fn(),
	getContextRepositorySync: vi.fn(),
	heartbeat: vi.fn(),
}));

vi.mock("../src/client", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: m.start, getHandle: m.getHandle },
	})),
}));
vi.mock("@repo/database", () => ({
	getInstructionRepositorySync: (...a: unknown[]) =>
		m.getInstructionRepositorySync(...a),
	getContextRepositorySync: (...a: unknown[]) =>
		m.getContextRepositorySync(...a),
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: (...a: unknown[]) => m.heartbeat(...a),
}));

import {
	awaitRepositorySyncClosed,
	startQueuedRepositorySync,
} from "../src/activities/project-repository-sync-follow-up";

const input = {
	projectId: "proj_1",
	organizationId: "org_1",
	requesterUserId: "user_1",
};

function alreadyStarted(workflowId: string, type: string) {
	return new WorkflowExecutionAlreadyStartedError(
		"Workflow execution already started",
		workflowId,
		type,
	);
}

beforeEach(() => {
	vi.useRealTimers();
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.getHandle.mockReturnValue({ describe: m.describe });
	m.start.mockResolvedValue({ firstExecutionRunId: "run_1" });
});

describe("awaitRepositorySyncClosed", () => {
	it("answers closed at once for a sync execution that is no longer running", async () => {
		m.describe.mockResolvedValue({ status: { name: "COMPLETED" } });

		await expect(
			awaitRepositorySyncClosed({
				subject: "context",
				projectId: "proj_1",
			}),
		).resolves.toEqual({ closed: true });

		expect(m.getHandle).toHaveBeenCalledWith(
			"context-repository-sync-proj_1",
		);
	});

	it("watches the instructions sync under its own id", async () => {
		m.describe.mockResolvedValue({ status: { name: "FAILED" } });

		await awaitRepositorySyncClosed({
			subject: "instructions",
			projectId: "proj_1",
		});

		expect(m.getHandle).toHaveBeenCalledWith(
			"project-instruction-repository-sync-proj_1",
		);
	});

	it("answers closed when the project has no sync execution at all", async () => {
		m.describe.mockRejectedValue(
			Object.assign(new Error("not found"), {
				name: "WorkflowNotFoundError",
			}),
		);

		await expect(
			awaitRepositorySyncClosed({
				subject: "context",
				projectId: "proj_1",
			}),
		).resolves.toEqual({ closed: true });
	});

	it("never reads a failed describe as closed", async () => {
		m.describe.mockRejectedValue(new Error("temporal unreachable"));

		await expect(
			awaitRepositorySyncClosed({
				subject: "context",
				projectId: "proj_1",
			}),
		).rejects.toThrow("temporal unreachable");
	});

	it("keeps watching, heartbeating, while the run is open, then answers closed once it ends", async () => {
		vi.useFakeTimers();
		m.describe
			.mockResolvedValueOnce({ status: { name: "RUNNING" } })
			.mockResolvedValueOnce({ status: { name: "RUNNING" } })
			.mockResolvedValueOnce({ status: { name: "COMPLETED" } });

		const pending = awaitRepositorySyncClosed({
			subject: "context",
			projectId: "proj_1",
		});
		await vi.advanceTimersByTimeAsync(10_000);

		await expect(pending).resolves.toEqual({ closed: true });
		expect(m.describe).toHaveBeenCalledTimes(3);
		expect(m.heartbeat).toHaveBeenCalledTimes(2);
	});

	it("gives up one wait, with closed false, when the run stays open past it", async () => {
		vi.useFakeTimers();
		m.describe.mockResolvedValue({ status: { name: "RUNNING" } });

		const pending = awaitRepositorySyncClosed({
			subject: "context",
			projectId: "proj_1",
		});
		await vi.advanceTimersByTimeAsync(60_000);

		await expect(pending).resolves.toEqual({ closed: false });
	});
});

describe("startQueuedRepositorySync", () => {
	it("starts the Living Memory sync as the requester, with its own id, queue and FAIL policy", async () => {
		m.getContextRepositorySync.mockResolvedValue({
			repositoryIntegration: { status: "ACTIVE" },
		});

		await expect(
			startQueuedRepositorySync({ subject: "context", ...input }),
		).resolves.toEqual({ outcome: "started" });

		expect(m.getContextRepositorySync).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
		);
		expect(m.start).toHaveBeenCalledWith(
			"projectContextRepositorySyncWorkflow",
			{
				taskQueue: "project-documents",
				workflowId: "context-repository-sync-proj_1",
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						projectId: "proj_1",
						organizationId: "org_1",
						trigger: "MANUAL",
						requesterUserId: "user_1",
					},
				],
			},
		);
	});

	it("starts the Coding Instructions sync the same way", async () => {
		m.getInstructionRepositorySync.mockResolvedValue({
			repositoryIntegration: { status: "ACTIVE" },
		});

		await expect(
			startQueuedRepositorySync({ subject: "instructions", ...input }),
		).resolves.toEqual({ outcome: "started" });

		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionRepositorySyncWorkflow",
			{
				taskQueue: "project-instructions",
				workflowId: "project-instruction-repository-sync-proj_1",
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						projectId: "proj_1",
						organizationId: "org_1",
						trigger: "MANUAL",
						requesterUserId: "user_1",
					},
				],
			},
		);
	});

	it("is satisfied by a run another start already opened, which reads the configuration fresh", async () => {
		m.getContextRepositorySync.mockResolvedValue({
			repositoryIntegration: { status: "ACTIVE" },
		});
		m.start.mockRejectedValue(
			alreadyStarted(
				"context-repository-sync-proj_1",
				"projectContextRepositorySyncWorkflow",
			),
		);

		await expect(
			startQueuedRepositorySync({ subject: "context", ...input }),
		).resolves.toEqual({ outcome: "already_running" });
	});

	it("starts nothing for a sync that has since been removed", async () => {
		m.getInstructionRepositorySync.mockResolvedValue(null);

		await expect(
			startQueuedRepositorySync({ subject: "instructions", ...input }),
		).resolves.toEqual({ outcome: "not_configured" });
		expect(m.start).not.toHaveBeenCalled();
	});

	it("starts nothing when the repository connection is no longer usable", async () => {
		m.getContextRepositorySync.mockResolvedValue({
			repositoryIntegration: { status: "TOKEN_EXPIRED" },
		});

		await expect(
			startQueuedRepositorySync({ subject: "context", ...input }),
		).resolves.toEqual({ outcome: "integration_unavailable" });
		expect(m.start).not.toHaveBeenCalled();
	});

	it("lets any other start failure through, so the activity retries instead of claiming a run", async () => {
		m.getContextRepositorySync.mockResolvedValue({
			repositoryIntegration: { status: "ACTIVE" },
		});
		m.start.mockRejectedValue(new Error("temporal unreachable"));

		await expect(
			startQueuedRepositorySync({ subject: "context", ...input }),
		).rejects.toThrow("temporal unreachable");
	});
});
