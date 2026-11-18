/**
 * Unit tests for `syncNowStatusProcedure`, which tells the person who pressed
 * "Sync now" how the run ended.
 *
 * Handler-capture + mocked-builder pattern mirrors the sibling
 * `list-synced-transcripts.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, FakeWorkflowFailedError } = vi.hoisted(() => {
	class FakeWorkflowFailedError extends Error {}
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		describe: vi.fn(),
		result: vi.fn(),
		getHandle: vi.fn(),
		transcriptCount: vi.fn(),
		linkedMeetingFindMany: vi.fn(),
	};
	return { handlers, mocks, FakeWorkflowFailedError };
});

vi.mock("@temporalio/client", () => ({
	WorkflowFailedError: FakeWorkflowFailedError,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: mocks.getHandle },
	}),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectMeetingTranscript: {
			count: (...args: unknown[]) => mocks.transcriptCount(...args),
		},
		projectLinkedMeeting: {
			findMany: (...args: unknown[]) =>
				mocks.linkedMeetingFindMany(...args),
		},
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.status = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: () => (c: unknown) => c,
	};
});

const { describeSyncFailure } = await import("../sync-now-status");

const STARTED = 1_763_000_000_000;
const WORKFLOW_ID = `meeting-transcript-sync-oneshot-proj-1-${STARTED}`;

function status(workflowId = WORKFLOW_ID, projectId = "proj-1") {
	return handlers.status({
		input: { projectId, workflowId },
		context: { user: { id: "user-1" }, session: {} },
	});
}

function closedAs(name: string) {
	mocks.describe.mockResolvedValue({ status: { name } });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getHandle.mockReturnValue({
		describe: mocks.describe,
		result: mocks.result,
	});
	mocks.result.mockResolvedValue(undefined);
	mocks.transcriptCount.mockResolvedValue(0);
	mocks.linkedMeetingFindMany.mockResolvedValue([]);
});

describe("syncNowStatusProcedure", () => {
	it("refuses a workflow that is not a Sync now run of this project, before asking Temporal", async () => {
		for (const workflowId of [
			`meeting-transcript-sync-oneshot-proj-2-${STARTED}`,
			"meeting-transcript-sync-proj-1",
			`meeting-transcript-sync-oneshot-proj-1-${STARTED}-x`,
			"meeting-transcript-sync-oneshot-proj-1-",
		]) {
			await expect(status(workflowId)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		}
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});

	it("reports a run still in progress", async () => {
		closedAs("RUNNING");

		await expect(status()).resolves.toEqual({ state: "running" });
		expect(mocks.transcriptCount).not.toHaveBeenCalled();
	});

	it("counts transcripts stored since the run started", async () => {
		closedAs("COMPLETED");
		mocks.transcriptCount.mockResolvedValue(20);

		await expect(status()).resolves.toEqual({
			state: "completed",
			newTranscripts: 20,
			failedMeetings: 0,
			message: null,
		});
		expect(mocks.transcriptCount).toHaveBeenCalledWith({
			where: {
				projectId: "proj-1",
				syncedAt: { gte: new Date(STARTED) },
			},
		});
	});

	it("reports meetings the run recorded a problem on", async () => {
		closedAs("COMPLETED");
		mocks.linkedMeetingFindMany.mockResolvedValue([
			{ lastErrorMessage: "Microsoft is not connected" },
		]);

		await expect(status()).resolves.toMatchObject({
			state: "completed",
			failedMeetings: 1,
			message: "Microsoft is not connected",
		});
		expect(mocks.linkedMeetingFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "proj-1",
					deactivatedAt: null,
					lastErrorAt: { gte: new Date(STARTED) },
				},
			}),
		);
	});

	it("explains a failed run by its innermost cause", async () => {
		closedAs("FAILED");
		const activityError = new Error(
			'Microsoft Graph API error: 502 Bad Gateway - {"error":{"code":"UnknownError"}}',
		);
		const activityFailure = new Error("Activity task failed", {
			cause: activityError,
		});
		mocks.result.mockRejectedValue(
			new FakeWorkflowFailedError("Workflow execution failed", {
				cause: activityFailure,
			}),
		);

		await expect(status()).resolves.toEqual({
			state: "failed",
			newTranscripts: 0,
			message:
				"Microsoft 365 did not respond (error 502), so nothing was synced. Try again later.",
		});
	});

	it("treats an unknown workflow as not found", async () => {
		mocks.describe.mockRejectedValue(
			new Error("workflow execution not found"),
		);

		await expect(status()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("describeSyncFailure", () => {
	it("keeps a message that is already readable", () => {
		expect(
			describeSyncFailure(
				"Could not read any calendar for this project.",
			),
		).toBe("Could not read any calendar for this project.");
	});

	it("falls back when the run gave no reason", () => {
		expect(describeSyncFailure(undefined)).toBe("The sync failed.");
	});
});
