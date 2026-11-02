import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	create: vi.fn(),
	resolveProvider: vi.fn(),
	find: vi.fn(),
	record: vi.fn(),
	update: vi.fn(),
	edit: vi.fn(),
	readonly: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		codingRun: { findFirst: f.find, updateMany: f.update },
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
	getCodingExecutionProvider: (provider: unknown, metadata: unknown) => {
		f.resolveProvider(provider, metadata);
		return { sendPrompt: f.send, createSession: f.create };
	},
}));
vi.mock("../src/lib/coding-execution/local-kanban-provider", () => ({
	getLocalKanbanSessionUrl: vi.fn(),
}));
vi.mock("../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn(),
}));
vi.mock("../src/activities/coding-run/spike", () => ({}));

import {
	createExecutionSession,
	deliverCodingRunFollowUp,
	sendExecutionPrompt,
	updateCodingRunStatusGuardedActivity,
} from "../src/activities/coding-run";

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

afterEach(() => {
	vi.unstubAllEnvs();
});

it.each([true, false])(
	"rejects inconsistent API/worker rollout settings (%s) before provider construction",
	async (apiEnabled) => {
		vi.stubEnv(
			"FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED",
			String(!apiEnabled),
		);
		await expect(
			createExecutionSession({
				provider: "BACKGROUND_AGENTS",
				repoOwner: "example-org",
				repoName: "example-repo",
				fabricAgentsBridgeEnabled: apiEnabled,
			}),
		).rejects.toMatchObject({
			type: apiEnabled
				? "CODING_SESSION_NOT_CREATED"
				: "VALIDATION_ERROR",
			nonRetryable: !apiEnabled,
		});
		expect(f.resolveProvider).not.toHaveBeenCalled();
		expect(f.create).not.toHaveBeenCalled();
	},
);

describe("continuation delivery authorization and receipts", () => {
	const continuation = {
		codingRunId: "example-run",
		projectId: "example-project",
		organizationId: "example-org",
		userId: "example-user",
		sessionId: "example-session",
		promptId: "example-prompt",
		content: "Continue",
	};
	it("binds delivery to the organization, existing session and continuation workflow", async () => {
		vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
		const providerMetadata = {
			executionRuntime: "fabric-agent-server",
			executionTarget: {
				url: "https://example.com",
				profileId: "example-profile",
			},
		};
		f.find.mockResolvedValueOnce({
			id: "example-run",
			projectId: continuation.projectId,
			providerMetadata,
		});
		expect(await deliverCodingRunFollowUp(continuation)).toEqual({
			messageId: "example-message",
		});
		expect(f.resolveProvider).toHaveBeenCalledWith(
			"BACKGROUND_AGENTS",
			providerMetadata,
		);
		expect(f.find).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: continuation.organizationId,
					providerSessionId: continuation.sessionId,
					workflowId: f.info.workflowExecution.workflowId,
				}),
			}),
		);
		expect(f.record).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "follow-up:example-run:example-prompt" },
				create: expect.objectContaining({
					providerEventId: "example-message",
				}),
			}),
		);
	});
	it("does not send after access is revoked while queued", async () => {
		vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
		f.edit.mockResolvedValue(false);
		await expect(
			deliverCodingRunFollowUp(continuation),
		).rejects.toMatchObject({ type: "INVALID_SESSION" });
		expect(f.send).not.toHaveBeenCalled();
	});
	it("reuses the same prompt identity after receipt persistence fails", async () => {
		vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
		f.record.mockRejectedValueOnce(new Error("Database unavailable"));
		await expect(deliverCodingRunFollowUp(continuation)).rejects.toThrow(
			"Database unavailable",
		);
		await deliverCodingRunFollowUp(continuation);
		expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]);
	});
});

it.each(["read-only", "revoked", "provider-construction"])(
	"classifies %s as definitely not created",
	async (scenario) => {
		vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
		if (scenario === "read-only") {
			f.readonly.mockResolvedValue(true);
		}
		if (scenario === "revoked") {
			f.edit.mockResolvedValue(false);
		}
		if (scenario === "provider-construction") {
			f.resolveProvider.mockImplementationOnce(() => {
				throw new Error("Invalid target");
			});
		}
		await expect(
			createExecutionSession({
				provider: "BACKGROUND_AGENTS",
				repoOwner: "example-org",
				repoName: "example-repo",
				projectId: "example-project",
				userId: "example-user",
				organizationId: "example-org",
				fabricAgentsBridgeEnabled: true,
			}),
		).rejects.toMatchObject({
			type: "CODING_SESSION_NOT_CREATED",
			nonRetryable: false,
		});
		expect(f.create).not.toHaveBeenCalled();
	},
);

it.each(["FAILED", "CANCELLED", "COMPLETED"])(
	"late guarded writes cannot revive %s even after another run owns the active slot",
	async (storedStatus) => {
		const expectedStatuses = [
			"QUEUED",
			"STARTING",
			"RUNNING",
			"AWAITING_REVIEW",
			"PR_OPENED",
		] as const;
		f.update.mockImplementation(async ({ where, data }) => {
			if (where.status && !where.status.in.includes(storedStatus)) {
				return { count: 0 };
			}
			if (data.status === "AWAITING_REVIEW") {
				throw new Error("P2002: another active run owns the slot");
			}
			return { count: 1 };
		});
		await expect(
			updateCodingRunStatusGuardedActivity({
				codingRunId: "example-run",
				workflowId: "example-workflow",
				expectedStatuses: [...expectedStatuses],
				status: "AWAITING_REVIEW",
			}),
		).resolves.toBeUndefined();
		expect(f.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: [
						{ workflowId: "example-workflow" },
						{ workflowId: null },
					],
					status: { in: [...expectedStatuses] },
				}),
			}),
		);
	},
);
it.each(["KANBAN_LOCAL", "BACKGROUND_AGENTS"] as const)(
	"keeps transient preflight errors unchanged for legacy provider %s",
	async (provider) => {
		vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "false");
		const transient = new Error("Temporary database outage");
		f.readonly.mockRejectedValueOnce(transient);
		await expect(
			createExecutionSession({
				provider,
				repoOwner: "example-org",
				repoName: "example-repo",
				fabricAgentsBridgeEnabled: false,
				projectId: "example-project",
			}),
		).rejects.toBe(transient);
	},
);

it("preserves a local provider's retryable rate-limit error", async () => {
	const { RateLimitError } = await import(
		"../src/lib/coding-execution/errors"
	);
	const error = new RateLimitError("KANBAN_LOCAL", "Rate limited", 1000);
	f.resolveProvider.mockImplementationOnce(() => {
		throw error;
	});
	await expect(
		createExecutionSession({
			provider: "KANBAN_LOCAL",
			repoOwner: "example-org",
			repoName: "example-repo",
		}),
	).rejects.toBe(error);
});
