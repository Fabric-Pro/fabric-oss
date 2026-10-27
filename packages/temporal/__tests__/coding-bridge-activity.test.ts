import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	info: {
		workflowExecution: {
			workflowId: "example-workflow",
			runId: "example-execution",
		},
		activityId: "activity-7",
		attempt: 1,
	},
	send: vi.fn(),
	find: vi.fn(),
	record: vi.fn(),
	edit: vi.fn(),
	readonly: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		codingRun: { findFirst: f.find },
		codingRunEvent: { upsert: f.record },
	},
	canEditProject: f.edit,
	isProjectReadOnly: f.readonly,
	addCodingRunEvent: vi.fn(),
	createCodingRun: vi.fn(),
	updateCodingRunStatus: vi.fn(),
}));
vi.mock("@repo/utils/project-context", () => ({
	getAmbientProjectId: () => undefined,
}));
vi.mock("@temporalio/activity", async (original) => ({
	...(await original<object>()),
	Context: { current: () => ({ info: f.info }) },
}));
vi.mock("../src/lib/coding-execution/get-provider", () => ({
	getCodingExecutionProvider: () => ({ sendPrompt: f.send }),
}));
vi.mock("../src/lib/coding-execution/local-kanban-provider", () => ({
	getLocalKanbanSessionUrl: vi.fn(),
}));
vi.mock("../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn(),
}));
vi.mock("../src/activities/coding-run/spike", () => ({}));

import { sendExecutionPrompt } from "../src/activities/coding-run";

const input = {
	provider: "BACKGROUND_AGENTS" as const,
	sessionId: "example-session",
	content: "Implement",
	authorId: "example-user",
	projectId: "example-project",
};
beforeEach(() => {
	vi.clearAllMocks();
	f.info.attempt = 1;
	f.info.workflowExecution.workflowId = "example-workflow";
	f.find.mockResolvedValue({ id: "example-run", projectId: input.projectId });
	f.edit.mockResolvedValue(true);
	f.readonly.mockResolvedValue(false);
	f.send.mockResolvedValue({ messageId: "example-message" });
	f.record.mockResolvedValue({});
});
describe("Temporal prompt delivery activity", () => {
	it("keeps request identity across a receipt-save failure and persists the native identity", async () => {
		f.record.mockRejectedValueOnce(new Error("Database unavailable"));
		await expect(sendExecutionPrompt(input)).rejects.toThrow(
			"Database unavailable",
		);
		f.info.attempt = 2;
		await sendExecutionPrompt(input);
		expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]);
		expect(f.record.mock.calls[1][0]).toMatchObject({
			where: {
				id: "prompt-receipt:example-run:example-workflow:example-execution:activity-7",
			},
			create: {
				codingRunId: "example-run",
				providerEventId: "example-message",
				payloadJson: { messageId: "example-message" },
			},
		});
	});
	it("refuses delivery after creator access is revoked", async () => {
		f.edit.mockResolvedValue(false);
		await expect(sendExecutionPrompt(input)).rejects.toMatchObject({
			type: "INVALID_SESSION",
			nonRetryable: true,
		});
		expect(f.send).not.toHaveBeenCalled();
	});
	it("refuses an unbound session before sending", async () => {
		f.find.mockResolvedValue(null);
		await expect(sendExecutionPrompt(input)).rejects.toMatchObject({
			type: "INVALID_SESSION",
		});
		expect(f.send).not.toHaveBeenCalled();
	});
});

it("recovers the deterministic run binding when post-start workflowId bookkeeping was lost", async () => {
	f.info.workflowExecution.workflowId = "coding-run-example-run";
	f.find.mockImplementation(async ({ where }) =>
		where.OR?.some(
			(entry: any) =>
				entry.id === "example-run" && entry.workflowId === null,
		)
			? { id: "example-run", projectId: input.projectId }
			: null,
	);
	await sendExecutionPrompt(input);
	expect(f.send).toHaveBeenCalledOnce();
});
