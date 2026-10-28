import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	find: vi.fn(),
	edit: vi.fn(),
	readonly: vi.fn(),
	send: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { weaveExecution: { findFirst: f.find, update: f.update } },
	canEditProject: f.edit,
	isProjectReadOnly: f.readonly,
}));
vi.mock("@temporalio/activity", async (original) => ({
	...(await original<object>()),
	Context: {
		current: () => ({
			info: {
				workflowExecution: {
					workflowId: "example-weave-workflow",
					runId: "example-run",
				},
				activityId: "example-step",
			},
		}),
	},
}));
vi.mock("../src/activities/weave/get-background-provider", () => ({
	getBackgroundAgentsProvider: () => ({
		sendPrompt: f.send,
		createSession: f.create,
	}),
}));

import { sendShuttlePromptActivity } from "../src/activities/weave/shuttle-execution";

const input = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	prompt: "Implement",
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", undefined);
	f.find.mockResolvedValue({
		id: "example-execution",
		projectId: "example-project",
	});
	f.edit.mockResolvedValue(true);
	f.readonly.mockResolvedValue(false);
	f.send.mockResolvedValue({ messageId: "example-message" });
	f.create.mockResolvedValue({ sessionId: "example-session" });
	f.update.mockResolvedValue({});
});
describe("Shuttle live runtime authorization", () => {
	it("scopes the session to the owning workflow, creator and organization before sending", async () => {
		await sendShuttlePromptActivity(input);
		expect(f.find).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workflowId: "example-weave-workflow",
					userId: input.userId,
					organizationId: input.organizationId,
					sandboxSessionId: input.sessionId,
				},
			}),
		);
		expect(f.send).toHaveBeenCalledWith(
			input.sessionId,
			input.prompt,
			input.userId,
			{ promptId: "example-weave-workflow:example-run:example-step" },
		);
	});
	it("blocks a creator whose access was revoked", async () => {
		f.edit.mockResolvedValue(false);
		await expect(sendShuttlePromptActivity(input)).rejects.toMatchObject({
			type: "INVALID_SESSION",
			nonRetryable: true,
		});
		expect(f.send).not.toHaveBeenCalled();
	});
	it("blocks an unbound session and a project that became read-only", async () => {
		f.find.mockResolvedValueOnce(null);
		await expect(sendShuttlePromptActivity(input)).rejects.toMatchObject({
			type: "INVALID_SESSION",
		});
		f.readonly.mockResolvedValue(true);
		await expect(sendShuttlePromptActivity(input)).rejects.toMatchObject({
			type: "WORKSPACE_ERROR",
		});
		expect(f.send).not.toHaveBeenCalled();
	});
});

it("keeps sandbox creation idempotent if the ownership binding save fails", async () => {
	const { createSandboxActivity } = await import(
		"../src/activities/weave/sandbox"
	);
	const input = {
		repoUrl: "https://github.com/example-org/example-repo",
		branch: "main",
		userId: "example-user",
		organizationId: "example-org",
	};
	f.update.mockRejectedValueOnce(new Error("Binding save failed"));
	await expect(createSandboxActivity(input)).rejects.toThrow(
		"Binding save failed",
	);
	await expect(createSandboxActivity(input)).resolves.toMatchObject({
		sessionId: "example-session",
	});
	expect(f.create.mock.calls[0][0]).toMatchObject({
		codingRunId: "weave:example-execution:sandbox",
		workflowId: "example-weave-workflow",
		organizationId: input.organizationId,
	});
	expect(f.create.mock.calls[1]).toEqual(f.create.mock.calls[0]);
});

afterEach(() => vi.unstubAllEnvs());
it.each([true, false])(
	"rejects mismatched Weave API/worker rollout settings (%s) before remote mutation",
	async (apiEnabled) => {
		vi.stubEnv(
			"FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED",
			String(!apiEnabled),
		);
		const { createSandboxActivity } = await import(
			"../src/activities/weave/sandbox"
		);
		await expect(
			createSandboxActivity({
				repoUrl: "https://github.com/example-org/example-repo",
				branch: "main",
				userId: "example-user",
				organizationId: "example-org",
				fabricAgentsBridgeEnabled: apiEnabled,
			}),
		).rejects.toMatchObject({
			type: "VALIDATION_ERROR",
			nonRetryable: true,
		});
		expect(f.create).not.toHaveBeenCalled();
		expect(f.update).not.toHaveBeenCalled();
	},
);
